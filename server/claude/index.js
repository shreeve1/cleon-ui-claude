import { query } from "@anthropic-ai/claude-agent-sdk";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import logger from "../logger.js";
import { taskManager } from "../tasks.js";
import { eventDelivery } from "../event-delivery.js";
import { publish } from "../bus.js";
import { createActivityTracker } from "../activity.js";
import { register, setStatus } from "../session-registry.js";
import { transformMessage, toolUseToTaskMap } from "./transform.js";
import {
	loadSessionHistory,
	formatConversationHistory,
	DEFAULT_CONTEXT_WINDOW,
	MODEL_CONTEXT_WINDOWS,
} from "./history.js";
import { loadMcpConfig } from "./mcp.js";

function getClaudeSdkEnv() {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	return env;
}

// Timeout for waiting on user responses to AskUserQuestion / ExitPlanMode.
// Disabled by default: a pending question is buffered and replayed on
// reconnect, so the user can step away and answer whenever they return. The
// abort signal still handles explicit cancellation. Set TOOL_RESPONSE_TIMEOUT_MS
// env (milliseconds) to enable a janitor that reaps sessions abandoned forever.
export const TOOL_RESPONSE_TIMEOUT_MS =
	Number(process.env.TOOL_RESPONSE_TIMEOUT_MS) || 0; // 0 = no timeout

/**
 * Creates a promise that races between a callback from the Map and a timeout.
 * Used for canUseTool blocking on AskUserQuestion and ExitPlanMode.
 */
export function createPendingPromise(
	callbacksMap,
	key,
	signal,
	cancelMessage,
	timeoutMs = TOOL_RESPONSE_TIMEOUT_MS,
) {
	return new Promise((resolve, reject) => {
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						callbacksMap.delete(key);
						reject(new Error("User did not respond in time"));
					}, timeoutMs)
				: null;

		callbacksMap.set(key, {
			resolve: (val) => {
				clearTimeout(timer);
				callbacksMap.delete(key);
				resolve(val);
			},
			reject: (err) => {
				clearTimeout(timer);
				callbacksMap.delete(key);
				reject(err);
			},
		});

		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			callbacksMap.delete(key);
			reject(new Error(cancelMessage));
		});
	});
}

// Track active sessions for abort capability
export const activeSessions = new Map();

// Track pending question responses - map of toolUseId -> { resolve, reject }
// Used by canUseTool callback to wait for user responses to AskUserQuestion
export const pendingQuestionCallbacks = new Map();

// Track pending plan confirmations - map of toolUseId -> { resolve, reject }
// Used by canUseTool callback to wait for user confirmation of ExitPlanMode
export const pendingPlanConfirmations = new Map();

// Track current model per session - map of sessionId -> model
export const sessionModels = new Map();

/**
 * Process messages from a query stream
 * Used both for initial query and after question responses
 * Captures model information and adds it to messages
 */
async function processQueryStream(
	queryInstance,
	_ws,
	sessionInfo,
	onSessionId,
) {
	if (sessionInfo.activityTracker) {
		sessionInfo.activityTracker.startThinking();
	}

	for await (const message of queryInstance) {
		// Capture session ID from first message
		if (message.session_id && onSessionId) {
			onSessionId(message.session_id);
		}

		// Extract model from token usage for subsequent messages
		if (message.type === "result" && message.modelUsage) {
			const usage = extractTokenUsage(message.modelUsage);
			if (usage && usage.model) {
				sessionModels.set(message.session_id, usage.model);
				logger.info(
					`[Claude] Session ${message.session_id?.slice(0, 8)} used model: ${usage.model}`,
				);
			}
			if (usage) {
				eventDelivery.deliver(sessionInfo.username, {
					type: "token-usage",
					sessionId: message.session_id,
					...usage,
				});
			}
		}

		// Transform and forward message (pass current model, sessionId, and username for task tracking)
		const currentModel = message.session_id
			? sessionModels.get(message.session_id)
			: null;
		const transformed = transformMessage(
			message,
			currentModel,
			message.session_id,
			sessionInfo.username,
		);
		if (transformed) {
			eventDelivery.deliver(sessionInfo.username, {
				type: "claude-message",
				sessionId: message.session_id,
				data: transformed,
			});
		}

		// Track activity based on message type
		if (sessionInfo.activityTracker && transformed) {
			if (transformed.type === "tool_use") {
				const summaryText =
					typeof transformed.summary === "object"
						? transformed.summary.summary
						: transformed.summary || transformed.tool;
				sessionInfo.activityTracker.startTool(transformed.tool, summaryText);
			} else if (transformed.type === "tool_result") {
				sessionInfo.activityTracker.completeTool();
			}
		}
	}
}

/**
 * Handle incoming chat message from WebSocket
 */
export async function handleChat(msg, ws, username) {
	const { content, projectPath, sessionId, isNewSession, mode, attachments } =
		msg;
	const projectDisplayName = projectPath ? projectPath.split("/").pop() : "";

	const permissionModeMap = {
		default: "default",
		plan: "plan",
		bypass: "bypassPermissions",
	};
	const permissionMode = permissionModeMap[mode] || "default";

	// Build prompt with attachments
	let prompt = content || "";
	const tempImagePaths = [];

	if (sessionId && !isNewSession) {
		try {
			logger.info(`[Claude] Loading history for session ${sessionId}`);
			const history = await loadSessionHistory(projectPath, sessionId, 50);

			if (history.length > 0) {
				const historyBlock = formatConversationHistory(history);
				prompt =
					historyBlock + "CONTINUING CONVERSATION - User asks: " + prompt;
				logger.info(
					`[Claude] Prepended ${history.length} history messages to prompt`,
				);
			}
		} catch (err) {
			logger.error("[Claude] Failed to load history:", err);
		}
	}

	if (attachments && attachments.length > 0) {
		const textAttachments = [];

		for (const att of attachments) {
			if (att.type === "image") {
				// Save image to temp file in project directory so Claude can read it
				try {
					const base64Data = att.data.replace(/^data:image\/\w+;base64,/, "");
					const ext = att.mediaType?.split("/")[1] || "png";
					// Save in project directory for better access
					const tempDir = path.join(projectPath, ".claude-uploads");
					await fs.mkdir(tempDir, { recursive: true });
					const tempPath = path.join(tempDir, `upload-${randomUUID()}.${ext}`);
					await fs.writeFile(tempPath, Buffer.from(base64Data, "base64"));
					tempImagePaths.push(tempPath);

					// Add instruction to read the image - use relative path from project
					const relativePath = path.relative(projectPath, tempPath);
					textAttachments.push(
						`\n\n[User attached an image: ${att.name}. Please use the Read tool to view the image at: ${relativePath}]`,
					);
				} catch (err) {
					logger.error("[Claude] Failed to save temp image:", err);
					textAttachments.push(
						`\n\n[User tried to attach an image: ${att.name}, but it failed to process]`,
					);
				}
			} else {
				// Add text-based attachments to context
				textAttachments.push(`\n\n--- ${att.name} ---\n${att.data}`);
			}
		}

		if (textAttachments.length > 0) {
			prompt += textAttachments.join("");
		}
	}

	// Create session info object (mutable WS reference for reconnection support)
	const sessionInfo = {
		queryInstance: null,
		ws,
		username,
		activityTracker: null,
	};

	const options = {
		cwd: projectPath,
		model: msg.model || undefined,
		permissionMode,
		systemPrompt: { type: "preset", preset: "claude_code" },
		settingSources: ["project", "user", "local"],
		env: { ...getClaudeSdkEnv(), DEBUG_CLAUDE_AGENT_SDK: "1" },
		stderr: (data) => {
			logger.info(`[Claude:stderr] ${data.trimEnd()}`);
		},
		// Custom permission callback to intercept AskUserQuestion
		canUseTool: async (toolName, input, { toolUseID, signal }) => {
			// Intercept AskUserQuestion to wait for user input
			if (toolName === "AskUserQuestion") {
				logger.info(
					`[Claude] AskUserQuestion intercepted - toolUseId: ${toolUseID}`,
				);

				eventDelivery.deliver(username, {
					type: "claude-message",
					sessionId: currentSessionId,
					data: {
						type: "question",
						id: toolUseID,
						questions: input.questions || [],
					},
				});

				// Wait for user response (with timeout)
				try {
					const answers = await createPendingPromise(
						pendingQuestionCallbacks,
						toolUseID,
						signal,
						"Question cancelled",
					);

					logger.info(`[Claude] Question answered - toolUseId: ${toolUseID}`);

					const questions = input.questions || [];
					const answersByQuestion = {};
					for (const [qIndex, labels] of Object.entries(answers || {})) {
						const q = questions[Number(qIndex)];
						if (!q || !Array.isArray(labels) || labels.length === 0) continue;
						const isMultiple = q.multiSelect || q.multiple || false;
						answersByQuestion[q.question] = isMultiple ? labels : labels[0];
					}

					return {
						behavior: "allow",
						updatedInput: {
							questions,
							answers: answersByQuestion,
						},
					};
				} catch (err) {
					logger.info(`[Claude] Question cancelled or error: ${err.message}`);
					return {
						behavior: "deny",
						message: "User cancelled the question",
					};
				}
			}

			// Intercept ExitPlanMode to wait for user confirmation
			if (toolName === "ExitPlanMode") {
				logger.info(
					`[Claude] ExitPlanMode intercepted - toolUseId: ${toolUseID}`,
				);

				eventDelivery.deliver(username, {
					type: "claude-message",
					sessionId: currentSessionId,
					data: {
						type: "plan-confirmation",
						id: toolUseID,
					},
				});

				// Wait for user approval/rejection (with timeout)
				try {
					const response = await createPendingPromise(
						pendingPlanConfirmations,
						toolUseID,
						signal,
						"Plan confirmation cancelled",
					);

					logger.info(
						`[Claude] Plan confirmation response - toolUseId: ${toolUseID}, approved: ${response.approved}`,
					);

					if (response.approved) {
						return {
							behavior: "allow",
							updatedInput: input,
						};
					} else {
						return {
							behavior: "deny",
							message: response.feedback
								? `User rejected the plan. Feedback: ${response.feedback}`
								: "User rejected the plan. Please revise.",
						};
					}
				} catch (err) {
					logger.info(
						`[Claude] Plan confirmation cancelled or error: ${err.message}`,
					);
					return {
						behavior: "deny",
						message: "Plan confirmation cancelled",
					};
				}
			}

			// Allow all other tools
			return {
				behavior: "allow",
				updatedInput: input,
			};
		},
	};

	// Resume existing session (unless explicitly new)
	if (sessionId && !isNewSession) {
		options.resume = sessionId;
	}

	// Load MCP servers from ~/.claude.json
	const mcpServers = await loadMcpConfig(projectPath);
	if (mcpServers) {
		options.mcpServers = mcpServers;
	}

	let currentSessionId = sessionId;
	let queryInstance = null;

	try {
		logger.info(
			`[Claude] Starting query - project: ${projectPath}, session: ${sessionId || "NEW"}, resuming: ${!!(sessionId && !isNewSession)}`,
		);
		if (tempImagePaths.length > 0) {
			logger.info(
				`[Claude] Saved ${tempImagePaths.length} image(s) to temp files:`,
			);
			tempImagePaths.forEach((p) => logger.info(`  - ${p}`));
		}
		logger.info(`[Claude] Prompt length: ${prompt.length} chars`);

		queryInstance = query({
			prompt,
			options,
		});

		const isResuming = sessionId && !isNewSession;
		if (isResuming) {
			await queryInstance.setPermissionMode(permissionMode);
		}

		// Assign queryInstance to sessionInfo
		sessionInfo.queryInstance = queryInstance;

		// Track for abort
		if (currentSessionId) {
			activeSessions.set(currentSessionId, sessionInfo);
			eventDelivery.startSession(currentSessionId);
			register(currentSessionId, {
				username,
				projectPath,
				projectName: projectDisplayName,
				displayName: projectDisplayName,
				status: "streaming",
			});
			publish(username, {
				type: "session-status",
				sessionId: currentSessionId,
				status: "streaming",
			});
			sessionInfo.activityTracker = createActivityTracker(
				(event) => eventDelivery.deliver(username, event),
				currentSessionId,
			);
		}

		// Process streaming messages
		await processQueryStream(queryInstance, ws, sessionInfo, (sid) => {
			if (!currentSessionId) {
				currentSessionId = sid;
				eventDelivery.startSession(currentSessionId);
				activeSessions.set(currentSessionId, sessionInfo);
				register(currentSessionId, {
					username,
					projectPath,
					projectName: projectDisplayName,
					displayName: projectDisplayName,
					status: "streaming",
				});
				eventDelivery.deliver(username, {
					type: "session-created",
					sessionId: currentSessionId,
				});
				publish(username, {
					type: "session-status",
					sessionId: currentSessionId,
					status: "streaming",
				});
				sessionInfo.activityTracker = createActivityTracker(
					(event) => eventDelivery.deliver(username, event),
					currentSessionId,
				);
			}
		});

		// Stream complete
		logger.info(`[Claude] Query complete - session: ${currentSessionId}`);
		eventDelivery.deliver(username, {
			type: "claude-done",
			sessionId: currentSessionId,
		});
	} catch (err) {
		logger.error("[Claude] Query error:", err);

		// Detect rate limit errors from Anthropic API
		const errMsg = err.message || "";
		const isRateLimit =
			errMsg.includes("429") ||
			errMsg.includes("rate limit") ||
			errMsg.includes("Rate limit") ||
			errMsg.includes("1302");

		const userMessage = isRateLimit
			? "Rate limit reached. The API is temporarily throttled — please wait a moment and try again."
			: errMsg || "Query failed";

		eventDelivery.deliver(username, {
			type: "error",
			sessionId: currentSessionId || msg.sessionId || null,
			message: userMessage,
		});
	} finally {
		if (sessionInfo.activityTracker) {
			sessionInfo.activityTracker.finish();
			sessionInfo.activityTracker = null;
		}

		if (currentSessionId) {
			activeSessions.delete(currentSessionId);
			setStatus(currentSessionId, "idle");
			publish(username, {
				type: "session-status",
				sessionId: currentSessionId,
				status: "idle",
			});
			taskManager.clearSession(currentSessionId);
			// Clean up tool use to task mappings for this session
			for (const [toolUseId, taskId] of toolUseToTaskMap) {
				const sessionTask = taskManager.getTask(currentSessionId, taskId);
				if (sessionTask) {
					toolUseToTaskMap.delete(toolUseId);
				}
			}

			// Clean up any pending plan confirmations for this session
			for (const [toolUseId, _callback] of pendingPlanConfirmations) {
				pendingPlanConfirmations
					.get(toolUseId)
					?.reject(new Error("Session ended"));
				pendingPlanConfirmations.delete(toolUseId);
			}
		}

		// Clean up temp image files
		for (const tempPath of tempImagePaths) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

/**
 * Abort an active session
 */
export async function handleAbort(sessionId) {
	const sessionInfo = activeSessions.get(sessionId);

	if (!sessionInfo) {
		logger.info(`[Claude] Abort: session ${sessionId} not found`);
		return false;
	}

	try {
		logger.info(`[Claude] Aborting session: ${sessionId}`);

		if (typeof sessionInfo.queryInstance.interrupt === "function") {
			await sessionInfo.queryInstance.interrupt();
		}

		if (sessionInfo.activityTracker) {
			sessionInfo.activityTracker.finish();
			sessionInfo.activityTracker = null;
		}

		activeSessions.delete(sessionId);
		taskManager.clearSession(sessionId);
		// Clean up tool use to task mappings for this session
		for (const [toolUseId, taskId] of toolUseToTaskMap) {
			const sessionTask = taskManager.getTask(sessionId, taskId);
			if (sessionTask) {
				toolUseToTaskMap.delete(toolUseId);
			}
		}
		return true;
	} catch (err) {
		logger.error(`[Claude] Abort error for ${sessionId}:`, err);
		activeSessions.delete(sessionId);
		return false;
	}
}

/**
 * Check if session is active
 */
export function isSessionActive(sessionId) {
	return activeSessions.has(sessionId);
}

/**
 * Resubscribe to an active session with a new WebSocket
 * Returns true if session found and updated, false otherwise
 */
export function resubscribeSession(sessionId, newWs) {
	const sessionInfo = activeSessions.get(sessionId);
	if (!sessionInfo) return false;
	sessionInfo.ws = newWs;

	return true;
}

/**
 * Handle question response from frontend
 * Resolves the pending promise from the canUseTool callback
 */
export async function handleQuestionResponse(_sessionId, toolUseId, answers) {
	logger.info(`[Claude] Received question response for tool ${toolUseId}`);
	logger.info(`[Claude] Answer payload: ${JSON.stringify(answers, null, 2)}`);

	// Find and resolve the pending callback
	const callback = pendingQuestionCallbacks.get(toolUseId);
	if (!callback) {
		logger.info(
			`[Claude] No pending callback found for toolUseId: ${toolUseId}`,
		);
		return false;
	}

	// Remove from pending and resolve
	pendingQuestionCallbacks.delete(toolUseId);
	callback.resolve(answers);

	return true;
}

/**
 * Handle plan confirmation response from frontend
 * Resolves the pending promise from the canUseTool callback
 */
export async function handlePlanResponse(
	_sessionId,
	toolUseId,
	approved,
	feedback,
) {
	logger.info(
		`[Claude] Received plan response for tool ${toolUseId}, approved: ${approved}`,
	);

	const callback = pendingPlanConfirmations.get(toolUseId);
	if (!callback) {
		logger.info(
			`[Claude] No pending plan callback found for toolUseId: ${toolUseId}`,
		);
		return false;
	}

	pendingPlanConfirmations.delete(toolUseId);
	callback.resolve({ approved, feedback });

	return true;
}

/**
 * Extract token usage from SDK modelUsage
 * Returns enhanced metrics with model-specific context windows and separate cache metrics
 */
function extractTokenUsage(modelUsage) {
	if (!modelUsage) return null;

	const modelKey = Object.keys(modelUsage)[0];
	const data = modelUsage[modelKey];

	if (!data) return null;

	// Get raw token counts from SDK
	const input = data.cumulativeInputTokens || data.inputTokens || 0;
	const output = data.cumulativeOutputTokens || data.outputTokens || 0;
	const cacheRead =
		data.cumulativeCacheReadInputTokens || data.cacheReadInputTokens || 0;
	const cacheCreate =
		data.cumulativeCacheCreationInputTokens ||
		data.cacheCreationInputTokens ||
		0;

	// Calculate cumulative total (all tokens in conversation history)
	const cumulativeTotal = input + output + cacheRead + cacheCreate;

	// Get model-specific context window
	const contextWindow =
		MODEL_CONTEXT_WINDOWS[modelKey] ||
		parseInt(process.env.CONTEXT_WINDOW) ||
		DEFAULT_CONTEXT_WINDOW;

	// Estimate current context (this is approximate since SDK manages context internally)
	// The SDK may truncate/summarize, so we use the minimum of cumulative and context window
	// In reality, the SDK manages this and we don't have direct visibility
	const estimatedContextUsed = Math.min(cumulativeTotal, contextWindow);

	// Calculate what percentage of context is actually being used on each turn
	// This uses the input tokens from the most recent turn (approximation)
	const currentTurnTokens = data.inputTokens || data.cumulativeInputTokens || 0;
	const contextUtilization = Math.min(
		(currentTurnTokens / contextWindow) * 100,
		100,
	);

	return {
		// Cumulative metrics
		cumulativeTotal,
		cumulativeInput: input,
		cumulativeOutput: output,

		// Cache metrics (separate from context)
		cacheRead,
		cacheCreate,

		// Context window info
		contextWindow,
		model: modelKey,

		// Estimated utilization
		estimatedContextUsed,
		contextUtilization,

		// Backward compatibility - keep 'used' for existing code
		used: cumulativeTotal,
	};
}

// Log active sessions periodically for monitoring
setInterval(
	() => {
		if (activeSessions.size > 0) {
			logger.info(`[Claude] Active sessions: ${activeSessions.size}`);
		}
	},
	30 * 60 * 1000,
);
