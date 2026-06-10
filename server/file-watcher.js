import { promises as fs } from "fs";
import path from "path";
import { watch } from "fs";
import logger from "./logger.js";
import { publish } from "./bus.js";
import { register, setStatus } from "./session-registry.js";
import { CLAUDE_PROJECTS } from "./shared/project-paths.js";

// Module-level state
const watchers = new Map();

// Constants
const IDLE_TIMEOUT_MS = 30_000;
const GRACE_TIMEOUT_MS = 60_000;
const STAT_POLL_MS = 2_000;
const TOOL_OUTPUT_TRUNCATE_LENGTH = 1500;

function watcherKey(projectName, sessionId) {
	return `${projectName}:${sessionId}`;
}

/**
 * Start or reuse a JSONL file watcher for a CLI session.
 * Deduplicates by (projectName, sessionId).
 */
export async function startWatching(projectName, sessionId, username) {
	if (!projectName || !sessionId || !username) {
		logger.warn("[FileWatcher] Ignoring watch request with missing fields", {
			hasProjectName: Boolean(projectName),
			hasSessionId: Boolean(sessionId),
			hasUsername: Boolean(username),
		});
		return;
	}

	const key = watcherKey(projectName, sessionId);
	const existing = watchers.get(key);
	if (existing) {
		// Cancel grace timer — client reconnected before expiry
		clearTimeout(existing.graceTimer);
		existing.graceTimer = null;
		return;
	}

	const filePath = path.join(
		CLAUDE_PROJECTS,
		projectName,
		`${sessionId}.jsonl`,
	);

	// Read initial file state to establish tail position
	let lastKnownSize = 0;
	try {
		const stats = await fs.stat(filePath);
		lastKnownSize = stats.size;
	} catch (err) {
		// File may not exist yet — watcher will catch it when it appears
		logger.warn("[FileWatcher] Initial stat failed, will retry via fs.watch", {
			filePath,
			error: err.message,
		});
	}

	const state = {
		projectName,
		sessionId,
		username,
		filePath,
		lastKnownSize,
		lastActivity: Date.now(),
		hasSeenEntries: false,
		watcher: null,
		watcherError: null,
		statTimer: null,
		idleTimer: null,
		graceTimer: null,
		aborted: false,
		partialLine: null, // Buffer for partial JSONL lines
		inFlight: null, // Serialization guard for handleFileChange
	};

	watchers.set(key, state);

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
}

/**
 * Stop watching a CLI session. Called on client unwatch-session or grace expiry.
 */
export function stopWatching(projectName, sessionId) {
	const key = watcherKey(projectName, sessionId);
	const state = watchers.get(key);
	if (!state) return;

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

	// Filter: only entries for this session
	if (entry.sessionId !== state.sessionId) return;

	// Skip user echos (same as live transform behavior).
	// Allow tool_result entries through — they are user-role blocks.
	if (entry.type === "user" || entry.message?.role === "user") {
		const content = entry.message?.content;
		const hasToolResult =
			Array.isArray(content) && content.some((c) => c.type === "tool_result");
		if (!hasToolResult) return; // Pure user echo — skip
		// Has tool_result — fall through to parseEntryToEvents
	}

	// Skip result records (handled as separate token-usage event)
	if (entry.type === "result") return;

	// Skip tool-only assistant entries with AskUserQuestion/ExitPlanMode
	if (entry.type === "assistant" && entry.message?.content) {
		const content = entry.message.content;
		if (Array.isArray(content)) {
			const hasOnlySkippedTools = content.every(
				(c) =>
					c.type === "tool_use" &&
					(c.name === "AskUserQuestion" || c.name === "ExitPlanMode"),
			);
			if (hasOnlySkippedTools) return;
		}
	}

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

	// Parse and map entry to event payload
	const events = parseEntryToEvents(entry, state.sessionId);
	for (const event of events) {
		publish(state.username, event);
	}
}

/**
 * Map a JSONL entry to one or more SSE event payloads.
 * Returns array of { type, sessionId, data } objects.
 */
function parseEntryToEvents(entry, sessionId) {
	const timestamp = entry.timestamp || new Date().toISOString();
	const messageId =
		entry.messageId || entry.id || entry.message?.id || entry.uuid || null;
	const model = entry.model || entry.message?.model || null;

	// Assistant entry: text and/or tool_use blocks
	if (entry.type === "assistant" || entry.message?.role === "assistant") {
		const content = entry.message?.content;
		if (!Array.isArray(content)) {
			// String content — single text block
			if (typeof content === "string" && content.length > 0) {
				return [
					{
						type: "claude-message",
						sessionId,
						data: {
							type: "watcher-text",
							content,
							timestamp,
							messageId,
							model,
						},
					},
				];
			}
			return [];
		}

		const events = [];

		// Extract text blocks
		const texts = content.filter((c) => c.type === "text").map((c) => c.text);
		if (texts.length > 0) {
			events.push({
				type: "claude-message",
				sessionId,
				data: {
					type: "watcher-text",
					content: texts.join("\n"),
					timestamp,
					messageId,
					model,
				},
			});
		}

		// Extract tool_use blocks
		for (const block of content) {
			if (block.type === "tool_use") {
				if (block.name === "AskUserQuestion" || block.name === "ExitPlanMode") {
					continue; // Not replayable from watcher
				}

				// Build summary (mirrors transform.js getToolSummary pattern)
				const summary = buildToolSummary(block.name, block.input);

				events.push({
					type: "claude-message",
					sessionId,
					data: {
						type: "tool_use",
						tool: block.name,
						id: block.id || block.tool_use_id || null,
						summary,
						timestamp,
						messageId,
						model,
						input: block.input || {},
						startTime: null, // No timing from JSONL
					},
				});
			}
		}

		return events;
	}

	// User entry with tool_result blocks
	if (entry.type === "user" || entry.message?.role === "user") {
		const content = entry.message?.content;
		if (Array.isArray(content)) {
			const events = [];
			for (const block of content) {
				if (block.type === "tool_result") {
					const rawOutput =
						typeof block.content === "string"
							? block.content
							: JSON.stringify(block.content);
					const truncated =
						rawOutput.length > TOOL_OUTPUT_TRUNCATE_LENGTH
							? rawOutput.slice(0, TOOL_OUTPUT_TRUNCATE_LENGTH) +
								"\n... [truncated]"
							: rawOutput;
					events.push({
						type: "claude-message",
						sessionId,
						data: {
							type: "tool_result",
							id: block.tool_use_id || null,
							success: !block.is_error,
							output: truncated,
							timestamp,
							messageId,
							duration: null, // No timing from JSONL
							startTime: null,
						},
					});
				}
			}
			return events;
		}
	}

	return [];
}

/**
 * Build tool summary object (mirrors transform.js getToolSummary).
 */
function buildToolSummary(tool, input) {
	if (!input) return { summary: tool };
	switch (tool) {
		case "Bash":
			return {
				summary: `$ ${String(input.command || "").slice(0, 80)}`,
				fullCommand: input.command || "",
				redacted: true, // Consumer should not emit raw input
			};
		case "Read": {
			const filePath = input.file_path || input.path || "";
			return { summary: `Read ${filePath}`, filePath };
		}
		case "Write": {
			const filePath = input.file_path || input.path || "";
			return { summary: `Write ${filePath}`, filePath };
		}
		case "Edit": {
			const filePath = input.file_path || input.path || "";
			return { summary: `Edit ${filePath}`, filePath };
		}
		case "Glob": {
			const pattern = input.pattern || "";
			return { summary: `Find ${pattern}`, pattern };
		}
		case "Grep": {
			const pattern = input.pattern || input.query || "";
			return {
				summary: `Search ${String(pattern).slice(0, 80)}`,
				pattern,
				fullQuery: input.query || pattern || "",
			};
		}
		default:
			return { summary: tool };
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
				watchers.delete(watcherKey(state.projectName, state.sessionId));
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
export function startGraceTimer(projectName, sessionId) {
	const key = watcherKey(projectName, sessionId);
	const state = watchers.get(key);
	if (!state) return;

	if (state.graceTimer) clearTimeout(state.graceTimer);
	state.graceTimer = setTimeout(() => {
		if (state.aborted) return;
		cleanupWatcher(state);
		watchers.delete(key);
		logger.info("[FileWatcher] Grace period expired, cleaned up", {
			projectName,
			sessionId: sessionId.slice(0, 8),
		});
	}, GRACE_TIMEOUT_MS);
	state.graceTimer.unref();
}

/**
 * Check if a session is being watched.
 */
export function isWatching(projectName, sessionId) {
	return watchers.has(watcherKey(projectName, sessionId));
}

/**
 * Get all watched session keys for a specific user.
 * Used by the WS close handler to start grace timers.
 */
export function getWatchersForUser(username) {
	const result = [];
	for (const [, state] of watchers) {
		if (state.username === username) {
			result.push({
				projectName: state.projectName,
				sessionId: state.sessionId,
			});
		}
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

	if (state.graceTimer) {
		clearTimeout(state.graceTimer);
		state.graceTimer = null;
	}

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
