import { state } from "./state.js";
import {
	abortBtn,
	chatInput,
	sendBtn,
	modeBtn,
	modelBtn,
	attachBtn,
} from "./dom.js";
import {
	getActiveSession,
	getSessionBySessionId,
	renderSessionBar,
	saveSessionState,
} from "./sessions.js";
import {
	appendSystemMessage,
	finishStreaming,
	renderActivityStatus,
	scrollToBottom,
	appendToolMessage,
	updateToolResult,
	removeWelcome,
} from "./messages.js";
import { sendNotification } from "./notifications.js";
import { addTask, updateTask, removeTask, syncTasks } from "./tasks-ui.js";
import { StreamingRenderer, flushPendingText } from "./streaming.js";
import {
	escapeHtml,
	escapeAttr,
	formatTimestamp,
	getShortId,
} from "./utils.js";
import { setElementHtml } from "./dom.js";
import { formatMarkdown } from "./markdown.js";

function connectWebSocket() {
	if (state.ws?.readyState === WebSocket.OPEN) return;

	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	state.ws = new WebSocket(
		`${protocol}//${location.host}?token=${state.token}`,
	);

	state.ws.onopen = () => {
		console.log("[WS] Connected (command channel)");
		state.wsReconnectAttempts = 0;

		// Re-establish file watch on WS reconnect
		const activeSession = getActiveSession();
		if (activeSession?.sessionId && state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({
					type: "watch-session",
					projectName: activeSession.project.name,
					sessionId: activeSession.sessionId,
				}),
			);
		}
	};

	state.ws.onclose = () => {
		console.log("[WS] Disconnected");
		state.wsReconnectAttempts++;
		const delay = Math.min(1000 * 2 ** state.wsReconnectAttempts, 30000);
		setTimeout(connectWebSocket, delay);
	};

	state.ws.onerror = (err) => {
		console.error("[WS] Error:", err);
	};
}

function connectEventStream() {
	if (state.eventSource) {
		state.eventSource.close();
		state.eventSource = null;
	}

	const es = new EventSource(`/api/events?token=${state.token}`);
	state.eventSource = es;

	es.onopen = () => {
		console.log("[SSE] Connected");
		state.sseConnected = true;
	};

	es.onmessage = (e) => {
		try {
			const event = JSON.parse(e.data);
			handleServerEvent(event);
		} catch (err) {
			console.warn("[SSE] Parse error:", err);
		}
	};

	es.onerror = () => {
		state.sseConnected = false;
		if (es.readyState === EventSource.CLOSED) {
			console.log("[SSE] Connection closed, reconnecting in 2s");
			setTimeout(connectEventStream, 2000);
		}
	};
}

function handleServerEvent(event) {
	if (event.type === "heartbeat") return;

	if (event.type === "state-snapshot") {
		if (event.sessions) {
			for (const serverSession of event.sessions) {
				const localSession = getSessionBySessionId(serverSession.sessionId);
				if (localSession) {
					localSession.isStreaming = serverSession.status === "streaming";
				}
			}
		}
		const activeSession = getActiveSession();
		if (activeSession) {
			if (activeSession.isStreaming) {
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
		}
		return;
	}

	if (event.type === "session-status") {
		const session = getSessionBySessionId(event.sessionId);
		if (session) {
			session.isStreaming = event.status === "streaming";
			if (state.sessions.indexOf(session) === state.activeSessionIndex) {
				if (session.isStreaming) {
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
			}
		}
		return;
	}

	handleWsMessage(event);
}

function handleWsMessage(msg) {
	let session;

	if (msg.type === "session-created") {
		session = state.sessions.find((s) => s.sessionId === null && s.isStreaming);
		if (session) {
			session.sessionId = msg.sessionId;
			saveSessionState();
		}
	} else if (msg.sessionId) {
		session = getSessionBySessionId(msg.sessionId);
	} else {
		session = getActiveSession();
	}

	if (!session && msg.type !== "pong") {
		console.warn("[WS] Message for unknown session:", msg.sessionId);
		return;
	}

	const isInactive =
		session && state.sessions.indexOf(session) !== state.activeSessionIndex;

	switch (msg.type) {
		case "session-created":
			break;
		case "claude-message":
			handleClaudeMessage(msg.data, session);
			if (isInactive) {
				session.hasUnread = true;
				renderSessionBar();
			}
			break;
		case "claude-done":
			finishStreaming(session);
			sendNotification(
				"Claude finished",
				session.project.displayName || session.project.name,
			);
			if (isInactive) {
				session.hasUnread = true;
				renderSessionBar();
			}
			break;
		case "token-usage":
			if (msg.model && session) session.model = msg.model;
			updateTokenUsage(msg, session);
			break;
		case "abort-result":
			if (msg.success) finishStreaming(session);
			break;
		case "question-response-result":
			break;
		case "plan-response-result":
			break;
		case "error":
			appendSystemMessage(`Error: ${msg.message}`, session);
			sendNotification("Error", msg.message);
			finishStreaming(session);
			if (isInactive) {
				session.hasUnread = true;
				renderSessionBar();
			}
			break;
		// Task panel WebSocket handlers
		case "task-started":
			if (session && msg.data) {
				addTask(session, {
					taskId: msg.data.taskId,
					title: msg.data.title,
					status: "running",
					progress: msg.data.progress,
					parentId: msg.data.parentId,
					startTime: msg.data.startTime || Date.now(),
				});
			}
			break;
		case "task-progress":
			if (session && msg.data) {
				updateTask(session, msg.data.taskId, {
					status: "running",
					progress: msg.data.progress,
				});
			}
			break;
		case "task-completed":
			if (session && msg.data) {
				updateTask(session, msg.data.taskId, {
					status: "completed",
					progress: 100,
				});
				// Auto-remove completed tasks after a delay
				setTimeout(() => {
					removeTask(session, msg.data.taskId);
				}, 3000);
			}
			break;
		case "task-failed":
			if (session && msg.data) {
				updateTask(session, msg.data.taskId, {
					status: "failed",
					error: msg.data.error,
				});
			}
			break;
		case "task-update":
			if (session && msg.data) {
				addTask(session, {
					taskId: msg.data.taskId,
					title: msg.data.title,
					status: msg.data.status || "pending",
					progress: msg.data.progress,
					parentId: msg.data.parentId,
					startTime: msg.data.startTime || Date.now(),
				});
			}
			break;
		case "tasks-sync":
			if (session && msg.data) {
				syncTasks(session, msg.data.tasks || []);
			}
			break;
		case "agent-activity":
			if (session) {
				session.activityState =
					msg.state === "idle"
						? null
						: {
								state: msg.state,
								label: msg.label,
								description: msg.description || null,
								elapsed: msg.elapsed || null,
								toolName: msg.toolName || null,
							};
				if (session === getActiveSession()) {
					renderActivityStatus(session);
				}
			}
			break;
		case "replay-start":
			if (session) {
				session.isReplaying = true;
				// Flush any existing streaming state before replay
				flushPendingText(session);
			}
			break;
		case "replay-end":
			if (session) {
				session.isReplaying = false;
				flushPendingText(session);
				scrollToBottom(session);
			}
			break;
		case "pong":
			break;
		default:
			console.debug("[WS] Unknown message type:", msg.type);
	}
}

function handleClaudeMessage(data, session) {
	if (!data) return;
	session = session || getActiveSession();
	if (!session) return;

	// --- watcher-text: complete assistant message from JSONL watcher ---
	if (data.type === "watcher-text") {
		// Flush any residual streaming state
		flushPendingText(session);

		// Render as standalone .message.assistant
		const div = document.createElement("div");
		div.className = "message assistant";

		// Build metadata header
		let headerHtml = "";
		if (data.timestamp || data.messageId || data.model) {
			headerHtml = '<div class="message-header">';
			if (data.timestamp) {
				headerHtml += `<span class="message-timestamp" title="${escapeAttr(data.timestamp)}">${escapeHtml(formatTimestamp(data.timestamp))}</span>`;
			}
			if (data.messageId) {
				headerHtml += `<span class="message-id" title="${escapeAttr(data.messageId)}">· ${escapeHtml(getShortId(data.messageId))}</span>`;
			}
			if (data.model) {
				headerHtml += `<span class="model-badge">${escapeHtml(data.model)}</span>`;
			}
			headerHtml += "</div>";
		}

		// Remove welcome message if present (matches appendMessage() pattern)
		removeWelcome(session);

		setElementHtml(div, headerHtml + formatMarkdown(data.content));

		// Store metadata on element
		if (data.timestamp) div.dataset.timestamp = data.timestamp;
		if (data.messageId) div.dataset.messageId = data.messageId;
		if (data.model) div.dataset.model = data.model;

		session.containerEl.appendChild(div);
		scrollToBottom(session);

		// Do NOT touch session.isStreaming, session.pendingText, or session.streamingRenderer
		return;
	}

	if (data.type === "text") {
		session.isStreaming = true;
		session.pendingText = (session.pendingText || "") + data.content;

		// Store metadata for the current streaming message
		if (!session.currentMessageMetadata) {
			session.currentMessageMetadata = {
				timestamp: data.timestamp || null,
				messageId: data.messageId || null,
				model: data.model || null,
			};
		}

		// During replay, render instantly without animation
		if (session.isReplaying) {
			let el = session.containerEl.querySelector(".message.streaming");
			if (!el) {
				el = document.createElement("div");
				el.className = "message assistant streaming";
				if (session.currentMessageMetadata) {
					el.dataset.timestamp = session.currentMessageMetadata.timestamp || "";
					el.dataset.messageId = session.currentMessageMetadata.messageId || "";
					el.dataset.model = session.currentMessageMetadata.model || "";
				}
				session.containerEl.appendChild(el);
			}
			// Set text content directly without animation
			el.textContent = session.pendingText;
			return;
		}

		// Create renderer on first chunk (normal streaming)
		if (!session.streamingRenderer) {
			let el = session.containerEl.querySelector(".message.streaming");
			if (!el) {
				el = document.createElement("div");
				el.className = "message assistant streaming";
				// Attach metadata to the element
				if (session.currentMessageMetadata) {
					el.dataset.timestamp = session.currentMessageMetadata.timestamp || "";
					el.dataset.messageId = session.currentMessageMetadata.messageId || "";
					el.dataset.model = session.currentMessageMetadata.model || "";
				}
				session.containerEl.appendChild(el);
			}
			session.streamingRenderer = new StreamingRenderer(el);
		}

		// Append network chunk to renderer
		session.streamingRenderer.appendNetworkChunk(data.content);
		scrollToBottom(session);
		return;
	}

	if (data.type === "question") {
		flushPendingText(session);
		session.pendingQuestion = {
			id: data.id,
			questions: data.questions,
			selectedAnswers: {},
		};
		renderQuestion(data, session);
		return;
	}

	if (data.type === "plan-confirmation") {
		// Ignore duplicate plan confirmations
		if (session.pendingPlanConfirmation) return;
		flushPendingText(session);
		session.pendingPlanConfirmation = {
			id: data.id,
		};
		renderPlanConfirmation(data, session);
		return;
	}

	if (data.type === "tool_use") {
		flushPendingText(session);
		// Pass enhanced metadata to appendToolMessage
		const toolMetadata = {
			timestamp: data.timestamp || null,
			messageId: data.messageId || null,
			model: data.model || null,
			startTime: data.startTime || null,
			summary: data.summary || null,
		};
		// During replay, render tools as completed since the result follows immediately
		const status = session.isReplaying ? "success" : "running";
		appendToolMessage(
			data.tool,
			data.summary,
			data.id,
			status,
			session,
			toolMetadata,
			data.input,
		);
		return;
	}

	if (data.type === "tool_result") {
		// Pass timing metadata to updateToolResult
		const resultMetadata = {
			timestamp: data.timestamp || null,
			messageId: data.messageId || null,
			duration: data.duration || null,
			startTime: data.startTime || null,
		};
		updateToolResult(
			data.id,
			data.success,
			data.output,
			session,
			resultMetadata,
		);
		return;
	}
}

export {
	connectWebSocket,
	connectEventStream,
	handleServerEvent,
	handleWsMessage,
	handleClaudeMessage,
};
