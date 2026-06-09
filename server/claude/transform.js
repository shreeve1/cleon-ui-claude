import { randomUUID } from "crypto";
import { taskManager, broadcastTaskUpdate } from "../tasks.js";

// Constants
export const TOOL_OUTPUT_TRUNCATE_LENGTH = 1500;
export const TOOL_SUMMARY_TRUNCATE_LENGTH = 200;

// Track tool execution start times - map of toolUseId -> startTime (Date)
export const toolStartTimes = new Map();

// Track tool use to task mapping - map of toolUseId -> taskId
// Used to complete tasks when tool results arrive
export const toolUseToTaskMap = new Map();

// Generate timestamp in ISO 8601 format
function generateTimestamp() {
	return new Date().toISOString();
}

/**
 * Transform SDK message for frontend display
 * Simplifies tool outputs to show minimal relevant info
 * Adds timestamp and message ID to all message types for tracking
 * Tracks tool execution timing for performance monitoring
 * Includes model information when available
 * Creates/completes tasks for tool execution
 */
export function transformMessage(
	msg,
	model = null,
	sessionId = null,
	username = null,
) {
	if (!msg || !msg.type) return null;

	// Common metadata for all messages
	const timestamp = generateTimestamp();
	const messageId = randomUUID();

	// Text content from assistant
	if (msg.type === "assistant" && msg.message?.content) {
		const content = msg.message.content;

		// Extract text blocks
		if (Array.isArray(content)) {
			const texts = content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

			if (texts) {
				const result = {
					type: "text",
					content: texts,
					timestamp,
					messageId,
				};
				// Add model if available
				if (model) {
					result.model = model;
				}
				return result;
			}

			// Check for tool use blocks
			const toolUse = content.find((c) => c.type === "tool_use");
			if (toolUse) {
				// Skip AskUserQuestion - it's handled by canUseTool callback
				if (toolUse.name === "AskUserQuestion") {
					return null;
				}

				// Skip ExitPlanMode - it's handled by canUseTool callback
				if (toolUse.name === "ExitPlanMode") {
					return null;
				}

				// Record start time for this tool
				const startTime = new Date();
				toolStartTimes.set(toolUse.id, startTime);

				// Clean up old entries (keep last 100 to prevent memory leaks)
				if (toolStartTimes.size > 100) {
					const firstKey = toolStartTimes.keys().next().value;
					toolStartTimes.delete(firstKey);
				}

				// Create a task for this tool execution
				if (sessionId) {
					const summary = getToolSummary(toolUse.name, toolUse.input);
					const taskTitle =
						typeof summary === "object" ? summary.summary : summary;
					const task = taskManager.trackTaskStart(sessionId, {
						title: taskTitle,
						progress: 0,
						metadata: {
							tool: toolUse.name,
							toolUseId: toolUse.id,
							input: toolUse.input,
						},
					});

					// Map toolUseId to taskId for completion
					toolUseToTaskMap.set(toolUse.id, task.taskId);

					// Broadcast task started
					broadcastTaskUpdate("task-started", task, username, sessionId);

					// Clean up old mappings (keep last 100)
					if (toolUseToTaskMap.size > 100) {
						const firstKey = toolUseToTaskMap.keys().next().value;
						toolUseToTaskMap.delete(firstKey);
					}
				}

				const result = {
					type: "tool_use",
					tool: toolUse.name,
					id: toolUse.id,
					summary: getToolSummary(toolUse.name, toolUse.input),
					timestamp,
					messageId,
					startTime: startTime.toISOString(),
					input: sanitizeToolInput(toolUse.name, toolUse.input),
				};
				// Add model if available
				if (model) {
					result.model = model;
				}
				// Ensure summary is an object with backward-compatible string summary
				if (typeof result.summary === "object" && result.summary.summary) {
					// Already has object format - good!
					// The frontend can access result.summary.summary (string) and result.summary.fullCommand, etc.
				} else if (typeof result.summary === "string") {
					// For backward compatibility with old format
					result.summary = { summary: result.summary };
				}
				return result;
			}
		}

		if (typeof content === "string") {
			const result = {
				type: "text",
				content,
				timestamp,
				messageId,
			};
			// Add model if available
			if (model) {
				result.model = model;
			}
			return result;
		}
	}

	// Tool result (check before generic user return)
	if (msg.type === "user" && msg.message?.content) {
		const content = msg.message.content;
		if (Array.isArray(content)) {
			const toolResult = content.find((c) => c.type === "tool_result");
			if (toolResult) {
				const toolUseId = toolResult.tool_use_id;
				const startTime = toolStartTimes.get(toolUseId);
				const endTime = new Date();

				// Calculate duration if we have start time
				let duration = null;
				let startTimeIso = null;
				if (startTime) {
					duration = endTime.getTime() - startTime.getTime();
					startTimeIso = startTime.toISOString();
					// Clean up after use
					toolStartTimes.delete(toolUseId);
				}

				// Complete or fail the task
				if (sessionId) {
					const taskId = toolUseToTaskMap.get(toolUseId);
					if (taskId) {
						let task;
						if (toolResult.is_error) {
							task = taskManager.trackTaskFailed(
								sessionId,
								taskId,
								toolResult.content,
							);
							if (task) {
								broadcastTaskUpdate("task-failed", task, username, sessionId);
							}
						} else {
							task = taskManager.trackTaskComplete(sessionId, taskId, {
								output:
									typeof toolResult.content === "string"
										? toolResult.content
										: JSON.stringify(toolResult.content),
							});
							if (task) {
								broadcastTaskUpdate(
									"task-completed",
									task,
									username,
									sessionId,
								);
							}
						}
						// Clean up mapping
						toolUseToTaskMap.delete(toolUseId);
					}
				}

				const result = {
					type: "tool_result",
					id: toolUseId,
					success: !toolResult.is_error,
					output: truncateOutput(
						typeof toolResult.content === "string"
							? toolResult.content
							: JSON.stringify(toolResult.content),
						TOOL_OUTPUT_TRUNCATE_LENGTH,
					),
					timestamp,
					messageId,
					duration,
					startTime: startTimeIso,
				};
				// Note: tool_result doesn't get model field as it's from the user side
				return result;
			}
		}
	}

	// User message echo - only reached if NOT a tool_result
	if (msg.type === "user") {
		return null; // Don't echo back, frontend already shows it
	}

	// Result message (end of turn)
	if (msg.type === "result") {
		return null; // Handled separately for token usage
	}

	return null;
}

/**
 * Sanitize bash command - redact secrets and truncate
 */
function sanitizeBashCommand(cmd) {
	if (!cmd || typeof cmd !== "string") return "";
	const sanitized = cmd
		.replace(/(-H\s+["']?Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
		.replace(/(Bearer\s+)[A-Za-z0-9_\-.]{20,}/g, "$1[REDACTED]")
		.replace(/(-u\s+)[^\s:]+:[^\s@]+(@)/g, "$1[REDACTED]$2")
		.replace(/(https?:\/\/)[^:@\s]+:[^:@\s]+(@)/g, "$1[REDACTED]$2")
		.replace(
			/((?:API_KEY|SECRET|TOKEN|PASSWORD|PASS)\s*=\s*)[^\s;]+/gi,
			"$1[REDACTED]",
		);
	return truncateOutput(sanitized, 200);
}

/**
 * Sanitize tool input for client consumption
 */
function sanitizeToolInput(tool, input) {
	if (!input) return {};

	const normalizedTool = tool.toLowerCase();
	switch (normalizedTool) {
		case "bash":
			return { command: sanitizeBashCommand(input.command || input.cmd || "") };
		case "read":
			return {
				file_path: input.file_path || input.path,
				offset: input.offset,
				limit: input.limit,
			};
		case "write":
			return { file_path: input.file_path || input.path };
		case "edit": {
			const oldStr = String(input.old_string || "").slice(0, 30);
			const newStr = String(input.new_string || "").slice(0, 30);
			return {
				file_path: input.file_path || input.path,
				old_string: oldStr,
				new_string: newStr,
			};
		}
		case "glob":
			return { pattern: input.pattern, path: input.path };
		case "grep":
			return {
				pattern: input.pattern,
				path: input.path,
				glob: input.glob,
				type: input.type,
			};
		case "task":
			return {
				description: input.description || input.prompt,
				subagent_type: input.subagent_type,
			};
		default:
			return {};
	}
}

// Tool summary formatters (data-driven approach)
// Returns object with summary string and full command details
const toolFormatters = {
	bash: (i) => {
		const fullCommand = i.command || i.cmd || "";
		return {
			summary: `$ ${truncateOutput(fullCommand, TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
			fullCommand: fullCommand,
		};
	},
	read: (i) => {
		const filePath = i.file_path || i.path || null;
		return {
			summary: `Reading ${filePath || "file"}`,
			filePath: filePath,
		};
	},
	write: (i) => {
		const filePath = i.file_path || i.path || null;
		return {
			summary: `Writing ${filePath || "file"}`,
			filePath: filePath,
		};
	},
	edit: (i) => {
		const filePath = i.file_path || i.path || null;
		return {
			summary: `Editing ${filePath || "file"}`,
			filePath: filePath,
		};
	},
	glob: (i) => {
		const pattern = i.pattern || null;
		return {
			summary: `Finding ${pattern || "files"}`,
			pattern: pattern,
		};
	},
	grep: (i) => {
		const pattern = i.pattern || i.query || null;
		const fullQuery = i.query || pattern || "";
		return {
			summary: `Searching: ${truncateOutput(pattern || "", TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
			pattern: pattern,
			fullQuery: fullQuery,
		};
	},
	todowrite: (i) => {
		const todos = i.todos || [];
		const todoCount = todos.length;
		const completedCount = todos.filter(
			(t) => t.status === "completed" || t.status === "done",
		).length;
		return {
			summary:
				todoCount === 0
					? "Updating todo list"
					: `Updating todo list (${completedCount}/${todoCount} completed)`,
			todos: todos,
			todoCount: todoCount,
			completedCount: completedCount,
		};
	},
	todoread: () => ({ summary: "Reading todo list" }),
	task: (i) => {
		const description = i?.prompt || i?.task || i?.description || "";
		return {
			summary: description
				? `Task: ${truncateOutput(description, TOOL_SUMMARY_TRUNCATE_LENGTH)}`
				: "Delegating task",
			taskDescription: description,
		};
	},
	taskoutput: (i) => {
		const taskId = i?.task_id || "";
		return {
			summary: taskId ? `Checking task ${taskId}` : "Checking task output",
			taskId,
		};
	},
};

/**
 * Get tool summary with full command details
 * Returns object with backward-compatible 'summary' string and additional fields
 * @param {string} tool - Tool name
 * @param {object} input - Tool input parameters
 * @returns {object} Object with summary string and optional fullCommand, filePath, pattern fields
 */
export function getToolSummary(tool, input) {
	if (!input) {
		return { summary: tool };
	}
	const formatter = toolFormatters[tool.toLowerCase()];
	if (formatter) {
		return formatter(input);
	}
	// Default: return tool name as summary
	return { summary: tool };
}

/**
 * Truncate long output for display
 */
export function truncateOutput(content, maxLength) {
	if (typeof content !== "string") return String(content);
	if (content.length <= maxLength) return content;
	return (
		content.slice(0, maxLength) +
		`\n... (${content.length - maxLength} more chars)`
	);
}
