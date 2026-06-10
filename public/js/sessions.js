import { state } from "./state.js";
import {
	createClientId,
	escapeHtml,
	escapeAttr,
	formatTimestamp,
	getShortId,
} from "./utils.js";
import { formatMarkdown } from "./markdown.js";
import {
	setElementHtml,
	sessionBarEl,
	sessionTabsEl,
	abortBtn,
	chatInput,
	sendBtn,
	modeBtn,
	modelBtn,
	attachBtn,
	projectNameEl,
} from "./dom.js";
import {
	renderActivityStatus,
	clearMessages,
	updateScrollFAB,
	appendMessage,
	appendToolMessage,
} from "./messages.js";

async function readJsonResponse(res, url) {
	const text = await res.text();

	try {
		return text ? JSON.parse(text) : {};
	} catch (err) {
		const contentType =
			res.headers.get("content-type") || "unknown content type";
		const snippet = text.slice(0, 80).replace(/\s+/g, " ").trim();
		throw new Error(
			`Expected JSON from ${url}, got ${res.status} ${contentType}: ${snippet}`,
		);
	}
}

async function api(url, body = null) {
	const opts = { headers: {} };

	if (state.token) {
		opts.headers["Authorization"] = `Bearer ${state.token}`;
	}

	if (body) {
		opts.method = "POST";
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}

	const res = await fetch(url, opts);
	const data = await readJsonResponse(res, url);

	if (!res.ok) {
		throw new Error(data.error || "Request failed");
	}

	return data;
}

function getToolSummaryFromInput(tool, input) {
	if (!input) return tool;
	switch (tool) {
		case "Bash":
			return `$ ${(input.command || "").slice(0, 80)}`;
		case "Read":
			return `Read ${input.file_path || input.path || ""}`;
		case "Write":
			return `Write ${input.file_path || input.path || ""}`;
		case "Edit":
			return `Edit ${input.file_path || input.path || ""}`;
		case "Glob":
			return `Find ${input.pattern || ""}`;
		case "Grep":
			return `Search ${input.pattern || ""}`;
		default:
			return tool;
	}
}

function createSession(project, sessionId = null) {
	return {
		id: createClientId(), // Internal tab ID
		sessionId: sessionId, // Claude SDK session ID (null = new)
		project: project, // { name, path, displayName }
		isStreaming: false,
		isReplaying: false,
		pendingText: "",
		pendingQuestion: null,
		pendingPlanConfirmation: null,
		attachments: [],
		lastTokenUsage: null,
		lastContextWindow: null,
		model: null,
		hasUnread: false,
		needsHistoryLoad: false,
		containerEl: null, // DOM reference
		streamingRenderer: null, // StreamingRenderer instance
		// File mention state (per-session)
		fileMentionSelectedIndex: 0,
		fileMentionQuery: "",
		fileMentionStartPos: -1,
		fileMentionDebounceTimer: null,
		slashCommandSelectedIndex: -1,
		unreadCount: 0,
		isAtBottom: true,
		// Task panel state (per-session)
		tasks: [], // Active tasks array
		taskPanelExpanded: false, // Task panel expand/collapse state
		activityState: null, // Current AI activity state
		isLoadingHistory: false,
		watcherBuffer: [],
	};
}

function getActiveSession() {
	if (
		state.activeSessionIndex < 0 ||
		state.activeSessionIndex >= state.sessions.length
	)
		return null;
	return state.sessions[state.activeSessionIndex];
}

function getSessionByInternalId(id) {
	return state.sessions.find((s) => s.id === id) || null;
}

function getSessionBySessionId(sessionId) {
	return state.sessions.find((s) => s.sessionId === sessionId) || null;
}

function createSessionContainer(session) {
	const container = document.createElement("div");
	container.className = "session-container";
	container.dataset.sessionId = session.id;
	document.getElementById("session-containers").appendChild(container);
	session.containerEl = container;
	container.addEventListener("scroll", () => {
		const session = state.sessions.find((s) => s.containerEl === container);
		if (!session) return;
		const threshold = 100;
		const atBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight <
			threshold;
		session.isAtBottom = atBottom;
		if (atBottom) {
			session.unreadCount = 0;
			updateScrollFAB(session);
		}
	});
	return container;
}

function renderSessionBar() {
	if (state.sessions.length === 0) {
		sessionBarEl.classList.remove("visible");
		return;
	}
	sessionBarEl.classList.add("visible");
	setElementHtml(
		sessionTabsEl,
		state.sessions
			.map(
				(s, i) => `
    <button class="session-tab${i === state.activeSessionIndex ? " active" : ""}${s.hasUnread ? " unread" : ""}" data-index="${i}">
      <span class="session-tab-number">[${i + 1}]</span>
      <span class="session-tab-name">${escapeHtml(s.project.displayName || s.project.name)}</span>
      <span class="close-tab" title="Close session">&times;</span>
    </button>
  `,
			)
			.join(""),
	);
}

function switchToSession(index) {
	if (index < 0 || index >= state.sessions.length) return;
	if (index === state.activeSessionIndex) return;

	const currentSession = getActiveSession();
	if (currentSession) {
		// Unwatch current session before switching
		if (currentSession.sessionId && state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({
					type: "unwatch-session",
					projectName: currentSession.project.name,
					sessionId: currentSession.sessionId,
				}),
			);
		}
		currentSession.containerEl.classList.remove("active");
		hideSlashCommands();
		hideFileMentions();
		clearTimeout(currentSession.fileMentionDebounceTimer);
	}

	state.activeSessionIndex = index;
	const newSession = getActiveSession();

	newSession.containerEl.classList.add("active");
	newSession.hasUnread = false;
	renderActivityStatus(newSession);

	// Lazy-load message history for restored sessions
	if (newSession.needsHistoryLoad) {
		if (newSession.sessionId && state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({
					type: "watch-session",
					projectName: newSession.project.name,
					sessionId: newSession.sessionId,
				}),
			);
		}
		loadSessionHistory(newSession);
	} else if (!newSession.sessionId) {
		// New session without history - ensure it has welcome message
		if (!newSession.containerEl.querySelector(".welcome-message")) {
			clearMessages(newSession);
		}
		// No watch for new sessions without a sessionId
	} else {
		// Session already loaded — send watch immediately after unwatch
		if (newSession.sessionId && state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({
					type: "watch-session",
					projectName: newSession.project.name,
					sessionId: newSession.sessionId,
				}),
			);
		}
	}

	if (newSession.isStreaming) {
		abortBtn.classList.remove("hidden");
		chatInput.disabled = true;
		sendBtn.disabled = true;
		modeBtn.disabled = true;
		modelBtn.disabled = true;
		attachBtn.disabled = true;
	} else {
		abortBtn.classList.add("hidden");
		chatInput.disabled = false;
		sendBtn.disabled = false;
		modeBtn.disabled = false;
		modelBtn.disabled = false;
		attachBtn.disabled = false;
	}

	projectNameEl.textContent =
		newSession.project.displayName || newSession.project.name;
	updateTokenUsage(newSession.lastTokenUsage, newSession.lastContextWindow, newSession);
	renderAttachmentPreview();
	updateHash(newSession.project.name, newSession.sessionId);
	renderSessionBar();
	updateScrollFAB(newSession);
	renderTaskPanel(); // Render task panel for the new session
	saveSessionState();
	if (!newSession.isStreaming) chatInput.focus();
}

function closeSession(index) {
	if (index < 0 || index >= state.sessions.length) return;
	const session = state.sessions[index];

	// Unwatch session before closing
	if (session.sessionId && state.ws?.readyState === WebSocket.OPEN) {
		state.ws.send(
			JSON.stringify({
				type: "unwatch-session",
				projectName: session.project.name,
				sessionId: session.sessionId,
			}),
		);
	}

	// Abort if streaming
	if (session.isStreaming && session.sessionId) {
		state.ws.send(
			JSON.stringify({ type: "abort", sessionId: session.sessionId }),
		);
	}

	// Clean up timers
	clearTimeout(session.fileMentionDebounceTimer);

	// Clear tasks for this session
	clearTasks(session);

	// Remove DOM container
	if (session.containerEl) session.containerEl.remove();

	// Remove from array
	state.sessions.splice(index, 1);

	// Adjust active index
	if (state.sessions.length === 0) {
		state.activeSessionIndex = -1;
		renderSessionBar();
		openSidebar();
		return;
	}

	if (index === state.activeSessionIndex) {
		// Switch to nearest session
		const newIndex = Math.min(index, state.sessions.length - 1);
		state.activeSessionIndex = -1; // Reset so switchToSession doesn't early-return
		switchToSession(newIndex);
	} else if (index < state.activeSessionIndex) {
		state.activeSessionIndex--;
		renderSessionBar();
	} else {
		renderSessionBar();
	}

	saveSessionState();
}

// ==================== Task Panel Functions ====================

function saveSessionState() {
	const sessionData = state.sessions.map((s) => ({
		sessionId: s.sessionId,
		project: s.project,
		lastTokenUsage: s.lastTokenUsage,
		lastContextWindow: s.lastContextWindow,
		model: s.model,
		cacheMetrics: s.cacheMetrics || null,
	}));
	localStorage.setItem("cleon-sessions", JSON.stringify(sessionData));
	localStorage.setItem(
		"cleon-active-session",
		String(state.activeSessionIndex),
	);
}

async function restoreSessionState() {
	try {
		const saved = JSON.parse(localStorage.getItem("cleon-sessions"));
		const activeIndex =
			parseInt(localStorage.getItem("cleon-active-session")) || 0;
		if (!saved || saved.length === 0) return false;

		for (const data of saved) {
			const session = createSession(data.project, data.sessionId);
			session.lastTokenUsage = data.lastTokenUsage;
			session.lastContextWindow = data.lastContextWindow;
			session.model = data.model || null;
			session.cacheMetrics = data.cacheMetrics || null;
			state.sessions.push(session);
			createSessionContainer(session);
			// Mark sessions with history for lazy loading
			if (session.sessionId) {
				session.needsHistoryLoad = true;
				setElementHtml(
					session.containerEl,
					'<div class="loading">Loading history</div>',
				);
			} else {
				clearMessages(session);
			}
		}

		if (state.sessions.length > 0) {
			state.activeSessionIndex = -1;
			const targetIndex = Math.min(activeIndex, state.sessions.length - 1);
			switchToSession(targetIndex);
			enableChat();

			// Load message history for the active session
			const activeSession = getActiveSession();
			if (activeSession && activeSession.needsHistoryLoad) {
				await loadSessionHistory(activeSession);
			}

			// Update hash to match restored session (use replaceState to avoid history entry)
			if (activeSession) {
				const hash = activeSession.project.name
					? `/project/${encodeURIComponent(activeSession.project.name)}${activeSession.sessionId ? `/session/${encodeURIComponent(activeSession.sessionId)}` : ""}`
					: "";
				if (hash) window.history.replaceState(null, "", "#" + hash);
			}
		}

		return state.sessions.length > 0;
	} catch (e) {
		console.error("Failed to restore session state:", e);
		return false;
	}
}

// Favorites storage utilities

async function loadSessionHistory(session) {
	if (!session.sessionId) {
		clearMessages(session);
		return;
	}
	if (session.isLoadingHistory) return;

	session.isLoadingHistory = true;
	session.watcherBuffer = session.watcherBuffer || [];

	if (session.containerEl) {
		setElementHtml(
			session.containerEl,
			'<div class="loading">Loading history</div>',
		);
	}

	try {
		const projectName = session.project.name;
		const { messages } = await api(
			`/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(session.sessionId)}/messages?limit=50`,
		);

		if (session.containerEl) session.containerEl.replaceChildren();

		if (messages.length === 0) {
			if (session.containerEl) {
				setElementHtml(
					session.containerEl,
					`
          <div class="welcome-message">
            <h2>Session Resumed</h2>
            <p>Continue your conversation with Claude.</p>
          </div>
        `,
				);
			}
		} else {
			for (const msg of messages) {
				if (msg.role === "user") {
					appendMessage("user", msg.content, session);
				} else if (msg.role === "assistant") {
					// Create element directly with metadata to preserve message header
					const div = document.createElement("div");
					div.className = "message assistant";

					// Build message header with metadata from API
					let headerHtml = "";
					if (msg.timestamp || msg.messageId || msg.model) {
						headerHtml = '<div class="message-header">';
						if (msg.timestamp) {
							headerHtml += `<span class="message-timestamp" title="${escapeAttr(msg.timestamp)}">${escapeHtml(formatTimestamp(msg.timestamp))}</span>`;
						}
						if (msg.messageId) {
							headerHtml += `<span class="message-id" title="${escapeAttr(msg.messageId)}">· ${escapeHtml(getShortId(msg.messageId))}</span>`;
						}
						if (msg.model) {
							headerHtml += `<span class="model-badge">${escapeHtml(msg.model)}</span>`;
						}
						headerHtml += "</div>";
					}

					setElementHtml(div, headerHtml + formatMarkdown(msg.content));

					// Store metadata on element for reference
					if (msg.timestamp) div.dataset.timestamp = msg.timestamp;
					if (msg.messageId) div.dataset.messageId = msg.messageId;
					if (msg.model) div.dataset.model = msg.model;

					session.containerEl.appendChild(div);
				} else if (msg.role === "tool") {
					// Build metadata object for historical tool messages
					const toolMetadata = {
						timestamp: msg.timestamp || null,
						messageId: msg.messageId || null,
						model: msg.model || null,
					};

					// Use enhanced summary from API if available, otherwise fall back to legacy
					const summary =
						msg.summary || getToolSummaryFromInput(msg.tool, msg.input);
					appendToolMessage(
						msg.tool,
						summary,
						null,
						"success",
						session,
						toolMetadata,
						msg.input,
					);
				}
			}
			// Scroll to bottom to show most recent messages
			if (session.containerEl) {
				session.containerEl.scrollTop = session.containerEl.scrollHeight;
				session.isAtBottom = true;
			}
		}
	} catch (err) {
		console.warn(
			"[Session] History load failed for",
			session.sessionId,
			"- session resume still functional:",
			err.message,
		);
		// NOTE: Do NOT clear session.sessionId here - the Claude SDK resume
		// works independently of UI history display
		if (session.containerEl) {
			setElementHtml(
				session.containerEl,
				`
        <div class="welcome-message">
          <h2>Session Resumed</h2>
          <p>Could not load history. Continue your conversation.</p>
        </div>
      `,
			);
		}
	}

	session.needsHistoryLoad = false;
	session.isLoadingHistory = false;
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cleon:history-loaded", {
				detail: { sessionId: session.sessionId },
			}),
		);
	}
}

export {
	createSession,
	getActiveSession,
	getSessionByInternalId,
	getSessionBySessionId,
	createSessionContainer,
	renderSessionBar,
	switchToSession,
	closeSession,
	saveSessionState,
	restoreSessionState,
	loadSessionHistory,
};
