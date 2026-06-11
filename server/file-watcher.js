import { promises as fs } from "fs";
import path from "path";
import { watch } from "fs";
import logger from "./logger.js";
import { publish } from "./bus.js";
import { register, setStatus } from "./session-registry.js";
import { jsonlEntryToLiveEvents } from "./shared/session-jsonl.js";
import { CLAUDE_PROJECTS } from "./shared/project-paths.js";

// Module-level state
const watchers = new Map();

// Constants
const IDLE_TIMEOUT_MS = 30_000;
const GRACE_TIMEOUT_MS = 60_000;
const STAT_POLL_MS = 2_000;

function watcherKey(projectName, sessionId, username) {
	return JSON.stringify([username, projectName, sessionId]);
}

function findWatcher(projectName, sessionId, username = null) {
	if (username)
		return watchers.get(watcherKey(projectName, sessionId, username));
	for (const [, state] of watchers) {
		if (state.projectName === projectName && state.sessionId === sessionId) {
			return state;
		}
	}
	return null;
}

function isSafeIdentifier(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		value !== "." &&
		value !== ".." &&
		!/[/\\]/.test(value) &&
		path.basename(value) === value
	);
}

function resolveWatchPath(projectName, sessionId) {
	if (!isSafeIdentifier(projectName) || !isSafeIdentifier(sessionId)) {
		throw new Error("Invalid watcher identifiers");
	}
	if (sessionId.startsWith("agent-")) {
		throw new Error("Agent session journals are not watchable");
	}

	const root = path.resolve(CLAUDE_PROJECTS);
	const filePath = path.resolve(root, projectName, `${sessionId}.jsonl`);
	const relativePath = path.relative(root, filePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error("Watcher path escapes Claude projects directory");
	}
	return filePath;
}

function addLease(state, username, leaseId) {
	const id = leaseId || username;
	const existing = state.leases.get(id);
	if (existing?.graceTimer) clearTimeout(existing.graceTimer);
	state.leases.set(id, { username, graceTimer: null });
}

/**
 * Start or reuse a JSONL file watcher for a CLI session.
 * Deduplicates by (projectName, sessionId).
 */
export async function startWatching(
	projectName,
	sessionId,
	username,
	leaseId = username,
) {
	if (!projectName || !sessionId || !username) {
		logger.warn("[FileWatcher] Ignoring watch request with missing fields", {
			hasProjectName: Boolean(projectName),
			hasSessionId: Boolean(sessionId),
			hasUsername: Boolean(username),
		});
		return { ok: false, error: "Missing watcher identifiers" };
	}

	let filePath;
	try {
		filePath = resolveWatchPath(projectName, sessionId);
	} catch (err) {
		logger.warn("[FileWatcher] Ignoring watch request with invalid path", {
			projectName,
			sessionId,
			error: err.message,
		});
		return { ok: false, error: err.message };
	}

	const key = watcherKey(projectName, sessionId, username);
	const existing = watchers.get(key);
	if (existing) {
		addLease(existing, username, leaseId);
		return { ok: true, reused: true };
	}

	const state = {
		projectName,
		sessionId,
		username,
		filePath,
		lastKnownSize: 0,
		lastActivity: Date.now(),
		hasSeenEntries: false,
		watcher: null,
		watcherError: null,
		statTimer: null,
		idleTimer: null,
		aborted: false,
		partialLine: null, // Buffer for partial JSONL lines
		inFlight: null, // Serialization guard for handleFileChange
		leases: new Map(),
	};
	addLease(state, username, leaseId);
	watchers.set(key, state);

	// Read initial file state to establish tail position
	try {
		const stats = await fs.stat(filePath);
		state.lastKnownSize = stats.size;
	} catch (err) {
		// File may not exist yet — watcher will catch it when it appears
		logger.warn("[FileWatcher] Initial stat failed, will retry via fs.watch", {
			filePath,
			error: err.message,
		});
	}

	// Set up fs.watch for real-time change notification
	try {
		state.watcher = watch(filePath, (eventType) => {
			if (eventType === "change" || eventType === "rename") {
				handleFileChange(state);
			}
		});
		state.watcher.unref();
	} catch (err) {
		logger.warn("[FileWatcher] fs.watch failed, falling back to stat polling", {
			filePath,
			error: err.message,
		});
		state.watcherError = err;
	}

	// Start stat polling fallback
	scheduleStatPoll(state);

	// Start idle timer
	resetIdleTimer(state);

	logger.info("[FileWatcher] Started watching", {
		projectName,
		sessionId: sessionId.slice(0, 8),
		filePath,
	});

	return { ok: true, reused: false };
}

/**
 * Stop watching a CLI session. Called on client unwatch-session or grace expiry.
 */
export function stopWatching(
	projectName,
	sessionId,
	username = null,
	leaseId = username,
) {
	if (!username) {
		for (const [key, state] of watchers) {
			if (state.projectName === projectName && state.sessionId === sessionId) {
				cleanupWatcher(state);
				watchers.delete(key);
			}
		}
		return;
	}

	const key = watcherKey(projectName, sessionId, username);
	const state = watchers.get(key);
	if (!state) return;

	state.leases.delete(leaseId || username);
	if (state.leases.size > 0) return;

	cleanupWatcher(state);
	watchers.delete(key);

	logger.info("[FileWatcher] Stopped watching", {
		projectName,
		sessionId: sessionId.slice(0, 8),
	});
}

/**
 * Handle a file change detected by fs.watch or stat polling.
 * Reads new lines since last known position, parses, and publishes events.
 */
async function handleFileChange(state) {
	if (state.aborted) return;
	// Serialize: no concurrent handleFileChange calls
	if (state.inFlight) return state.inFlight;

	const promise = (async () => {
		try {
			const stats = await fs.stat(state.filePath);

			// Handle file truncation/rotation: reset position and re-read
			if (stats.size < state.lastKnownSize) {
				logger.debug("[FileWatcher] File shrunk, resetting position", {
					filePath: state.filePath,
					oldSize: state.lastKnownSize,
					newSize: stats.size,
				});
				state.lastKnownSize = 0;
			}

			if (stats.size === state.lastKnownSize) return; // No new data

			const fileHandle = await fs.open(state.filePath, "r");
			try {
				const buffer = Buffer.alloc(stats.size - state.lastKnownSize);
				const { bytesRead } = await fileHandle.read(
					buffer,
					0,
					buffer.length,
					state.lastKnownSize,
				);
				const content = buffer.toString("utf8", 0, bytesRead);
				// Buffer trailing partial line — handle fragmented JSONL writes
				const combined = (state.partialLine || "") + content;
				const lines = combined.split("\n");
				// Last element after split is "" (content ends with \n) or trailing fragment
				const trailing = lines.pop() || "";
				state.partialLine = ""; // Reset; will be set back if truly partial

				for (const line of lines) {
					if (line.length > 0) processEntry(line, state);
				}

				// Try to process trailing fragment; if it parses as JSON, process it.
				// If not, buffer it as partial for the next read.
				if (trailing.length > 0) {
					try {
						JSON.parse(trailing);
						// Valid JSON — process it
						processEntry(trailing, state);
					} catch {
						// Partial line — buffer for next read
						state.partialLine = trailing;
					}
				}
			} finally {
				await fileHandle.close();
			}

			state.lastKnownSize = stats.size;
			state.lastActivity = Date.now();
			resetIdleTimer(state);
		} catch (err) {
			// File may be deleted/rotated during read
			logger.debug("[FileWatcher] Read error (transient)", {
				filePath: state.filePath,
				error: err.message,
			});
		} finally {
			state.inFlight = null;
		}
	})();

	state.inFlight = promise;
	return promise;
}

/**
 * Parse a single JSONL line and publish the corresponding SSE event.
 */
function processEntry(line, state) {
	let entry;
	try {
		entry = JSON.parse(line);
	} catch {
		return; // Skip malformed
	}

	const events = jsonlEntryToLiveEvents(entry, state.sessionId);
	if (events.length === 0) return;

	// Register session on first valid entry
	if (!state.hasSeenEntries) {
		state.hasSeenEntries = true;
		register(state.sessionId, {
			username: state.username,
			projectPath: null, // Not known from JSONL alone
			projectName: state.projectName,
			displayName: state.projectName,
			status: "streaming",
		});
		publish(state.username, {
			type: "session-status",
			sessionId: state.sessionId,
			status: "streaming",
		});
	} else {
		// Re-mark as streaming on subsequent entries (recovery from idle)
		setStatus(state.sessionId, "streaming");
		publish(state.username, {
			type: "session-status",
			sessionId: state.sessionId,
			status: "streaming",
		});
	}

	for (const event of events) {
		publish(state.username, event);
	}
}

/**
 * Schedule the stat-based polling fallback.
 */
function scheduleStatPoll(state) {
	if (state.aborted) return;
	state.statTimer = setTimeout(async () => {
		if (state.aborted) return;
		// Only poll if fs.watch had errors or we haven't seen changes recently
		if (state.watcherError) {
			await handleFileChange(state);
		} else {
			// Even with a working watcher, do occasional consistency check
			try {
				const stats = await fs.stat(state.filePath);
				if (stats.size !== state.lastKnownSize) {
					await handleFileChange(state);
				} else {
					// Size unchanged — check if idle timer needs updating from a missed event
					// (No action — idle timer handles the timeout)
				}
			} catch {
				// File gone — may have been rotated or deleted
				if (state.hasSeenEntries) {
					setStatus(state.sessionId, "idle");
					publish(state.username, {
						type: "session-status",
						sessionId: state.sessionId,
						status: "idle",
					});
				}
				cleanupWatcher(state);
				watchers.delete(
					watcherKey(state.projectName, state.sessionId, state.username),
				);
				return;
			}
		}
		scheduleStatPoll(state);
	}, STAT_POLL_MS);
	state.statTimer.unref();
}

/**
 * Reset the idle detection timer. Called on every new entry.
 */
function resetIdleTimer(state) {
	if (state.idleTimer) {
		clearTimeout(state.idleTimer);
	}
	state.idleTimer = setTimeout(() => {
		if (state.aborted) return;
		setStatus(state.sessionId, "idle");
		publish(state.username, {
			type: "session-status",
			sessionId: state.sessionId,
			status: "idle",
		});
	}, IDLE_TIMEOUT_MS);
	state.idleTimer.unref();
}

/**
 * Start the grace timer after WS loss.
 */
export function startGraceTimer(
	projectName,
	sessionId,
	username = null,
	leaseId = username,
) {
	const state = findWatcher(projectName, sessionId, username);
	if (!state) return;

	const key = watcherKey(state.projectName, state.sessionId, state.username);
	const id = leaseId || username || state.leases.keys().next().value;
	const lease = state.leases.get(id);
	if (!lease) return;

	if (lease.graceTimer) clearTimeout(lease.graceTimer);
	lease.graceTimer = setTimeout(() => {
		if (state.aborted) return;
		state.leases.delete(id);
		if (state.leases.size > 0) return;
		cleanupWatcher(state);
		watchers.delete(key);
		logger.info("[FileWatcher] Grace period expired, cleaned up", {
			projectName,
			sessionId: sessionId.slice(0, 8),
		});
	}, GRACE_TIMEOUT_MS);
	lease.graceTimer.unref();
}

/**
 * Check if a session is being watched.
 */
export function isWatching(projectName, sessionId, username = null) {
	return Boolean(findWatcher(projectName, sessionId, username));
}

/**
 * Get all watched session keys for a specific user.
 * Used by the WS close handler to start grace timers.
 */
export function getWatchersForUser(username, leaseId = null) {
	const result = [];
	for (const [, state] of watchers) {
		if (state.username !== username) continue;
		if (leaseId && !state.leases.has(leaseId)) continue;
		result.push({
			projectName: state.projectName,
			sessionId: state.sessionId,
		});
	}
	return result;
}

/**
 * Clean up watcher resources without removing from the Map.
 * (stopWatching calls this AND deletes the Map entry.)
 */
function cleanupWatcher(state) {
	if (state.aborted) return;
	state.aborted = true;

	if (state.watcher) {
		try {
			state.watcher.close();
		} catch {
			/* ignore */
		}
		state.watcher = null;
	}

	if (state.statTimer) {
		clearTimeout(state.statTimer);
		state.statTimer = null;
	}

	if (state.idleTimer) {
		clearTimeout(state.idleTimer);
		state.idleTimer = null;
	}

	for (const lease of state.leases.values()) {
		if (lease.graceTimer) clearTimeout(lease.graceTimer);
	}
	state.leases.clear();

	// Ensure session marked idle
	if (state.hasSeenEntries) {
		setStatus(state.sessionId, "idle");
		publish(state.username, {
			type: "session-status",
			sessionId: state.sessionId,
			status: "idle",
		});
	}
}
