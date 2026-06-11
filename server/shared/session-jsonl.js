const TOOL_OUTPUT_TRUNCATE_LENGTH = 1500;
const SKIPPED_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode"]);

function getEntryMetadata(entry) {
	return {
		timestamp: entry.timestamp || new Date().toISOString(),
		messageId:
			entry.messageId || entry.id || entry.message?.id || entry.uuid || null,
		model: entry.model || entry.message?.model || null,
	};
}

function stringifyContent(value) {
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? "");
}

function truncateOutput(rawOutput) {
	return rawOutput.length > TOOL_OUTPUT_TRUNCATE_LENGTH
		? rawOutput.slice(0, TOOL_OUTPUT_TRUNCATE_LENGTH) + "\n... [truncated]"
		: rawOutput;
}

export function isSkippedToolName(name) {
	return SKIPPED_TOOL_NAMES.has(name);
}

export function sanitizeBashCommand(cmd) {
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
	return sanitized.length > 200 ? sanitized.slice(0, 200) : sanitized;
}

export function sanitizeToolInput(tool, input) {
	if (!input) return {};

	switch (String(tool || "").toLowerCase()) {
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
		case "edit":
			return {
				file_path: input.file_path || input.path,
				old_string: String(input.old_string || "").slice(0, 30),
				new_string: String(input.new_string || "").slice(0, 30),
			};
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

export function buildToolSummary(tool, input) {
	if (!input) return { summary: tool };
	switch (tool) {
		case "Bash": {
			const command = sanitizeBashCommand(input.command || input.cmd || "");
			return {
				summary: `$ ${String(command).slice(0, 80)}`,
				fullCommand: command,
				redacted: true,
			};
		}
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

export function jsonlEntryToLiveEvents(entry, sessionId) {
	if (entry.sessionId !== sessionId) return [];
	if (entry.type === "result") return [];

	const { timestamp, messageId, model } = getEntryMetadata(entry);

	if (entry.type === "assistant" || entry.message?.role === "assistant") {
		const content = entry.message?.content;
		if (!Array.isArray(content)) {
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

		for (const block of content) {
			if (block.type !== "tool_use" || isSkippedToolName(block.name)) continue;
			events.push({
				type: "claude-message",
				sessionId,
				data: {
					type: "tool_use",
					tool: block.name,
					id: block.id || block.tool_use_id || null,
					summary: buildToolSummary(block.name, block.input),
					timestamp,
					messageId,
					model,
					input: sanitizeToolInput(block.name, block.input),
					startTime: null,
				},
			});
		}

		return events;
	}

	if (entry.type === "user" || entry.message?.role === "user") {
		const content = entry.message?.content;
		if (!Array.isArray(content)) return [];

		return content
			.filter((block) => block.type === "tool_result")
			.map((block) => {
				const rawOutput = stringifyContent(block.content);
				return {
					type: "claude-message",
					sessionId,
					data: {
						type: "tool_result",
						id: block.tool_use_id || null,
						success: !block.is_error,
						output: truncateOutput(rawOutput),
						timestamp,
						messageId,
						duration: null,
						startTime: null,
					},
				};
			});
	}

	return [];
}

export function jsonlEntryToHistoryMessages(entry) {
	if (entry.type === "result") return [];

	const { timestamp, messageId, model } = getEntryMetadata(entry);

	if (entry.type === "user" || entry.message?.role === "user") {
		const content = entry.message?.content;
		const messages = [];

		if (Array.isArray(content)) {
			const text = content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text && !text.startsWith("<") && !text.startsWith("{")) {
				messages.push({ role: "user", content: text, timestamp, messageId });
			}

			for (const block of content) {
				if (block.type !== "tool_result") continue;
				messages.push({
					role: "tool_result",
					id: block.tool_use_id || null,
					success: !block.is_error,
					output: truncateOutput(stringifyContent(block.content)),
					timestamp,
					messageId,
					duration: null,
					startTime: null,
				});
			}
			return messages;
		}

		if (
			typeof content === "string" &&
			content.length > 0 &&
			!content.startsWith("<") &&
			!content.startsWith("{")
		) {
			return [{ role: "user", content, timestamp, messageId }];
		}
		return [];
	}

	if (entry.type === "assistant" || entry.message?.role === "assistant") {
		const content = entry.message?.content;
		if (!Array.isArray(content)) {
			return typeof content === "string" && content.length > 0
				? [{ role: "assistant", content, timestamp, messageId, model }]
				: [];
		}

		const messages = [];
		const textParts = content
			.filter((block) => block.type === "text")
			.map((block) => block.text);
		if (textParts.length > 0) {
			messages.push({
				role: "assistant",
				content: textParts.join("\n"),
				timestamp,
				messageId,
				model,
			});
		}

		for (const block of content) {
			if (block.type !== "tool_use" || isSkippedToolName(block.name)) continue;
			messages.push({
				role: "tool",
				tool: block.name,
				id: block.id || block.tool_use_id || null,
				input: sanitizeToolInput(block.name, block.input),
				timestamp,
				messageId,
				model,
				summary: buildToolSummary(block.name, block.input),
			});
		}

		return messages;
	}

	return [];
}
