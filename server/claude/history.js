import { promises as fs } from "fs";
import path from "path";
import os from "os";
import logger from "../logger.js";

// Constants
export const DEFAULT_CONTEXT_WINDOW = 200000;

// Model-specific context window sizes
export const MODEL_CONTEXT_WINDOWS = {
	"claude-3-opus-20240229": 200000,
	"claude-3-sonnet-20240229": 200000,
	"claude-3-haiku-20240307": 200000,
	"claude-3-5-sonnet-20241022": 200000,
	"claude-3-5-sonnet-20240620": 200000,
	"claude-3-5-haiku-20241022": 200000,
	// Newer models - update as SDK adds them
	default: 200000,
};

export function formatConversationHistory(messages, maxChars = 100000) {
	if (!messages || messages.length === 0) return "";

	const lines = [];
	let totalChars = 0;

	const recentMessages = messages.slice(-50);

	for (const msg of recentMessages) {
		let line = "";
		const timestamp = msg.timestamp
			? `[${new Date(msg.timestamp).toLocaleTimeString()}] `
			: "";

		if (msg.role === "user") {
			line = `${timestamp}USER: ${msg.content || ""}`;
		} else if (msg.role === "assistant") {
			const content = msg.content || "";
			const truncated =
				content.length > 2000
					? content.slice(0, 2000) + "...[truncated]"
					: content;
			line = `${timestamp}ASSISTANT: ${truncated}`;
		} else if (msg.role === "tool") {
			line = `${timestamp}TOOL (${msg.tool}): ${msg.summary || "executed"}`;
		}

		if (line) {
			totalChars += line.length;
			if (totalChars > maxChars) break;
			lines.push(line);
		}
	}

	if (lines.length === 0) return "";

	return `<conversation-history>
Previous conversation context (${lines.length} messages):

${lines.join("\n\n")}

</conversation-history>

`;
}

export async function loadSessionHistory(projectPath, sessionId, limit = 50) {
	const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

	const projectName = "-" + projectPath.slice(1).replace(/\//g, "-");
	const projectDir = path.join(CLAUDE_PROJECTS, projectName);

	try {
		const files = await fs.readdir(projectDir);
		const jsonlFiles = files.filter(
			(f) =>
				f.endsWith(".jsonl") &&
				!f.startsWith("agent-") &&
				f.startsWith(sessionId),
		);

		if (jsonlFiles.length === 0) {
			logger.info(`[Claude] No session file found for ${sessionId}`);
			return [];
		}

		const messages = [];
		const sessionFile = path.join(projectDir, jsonlFiles[0]);
		const content = await fs.readFile(sessionFile, "utf8");
		const lines = content.split("\n").filter(Boolean);

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.sessionId !== sessionId) continue;

				const msg = parseHistoryEntry(entry);
				if (msg) messages.push(msg);
			} catch {}
		}

		messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
		return messages.slice(-limit);
	} catch (err) {
		logger.error(`[Claude] Failed to load session history: ${err.message}`);
		return [];
	}
}

export function parseHistoryEntry(entry) {
	const timestamp = entry.timestamp || new Date().toISOString();

	if (entry.type === "user" || entry.message?.role === "user") {
		let text = entry.message?.content;
		if (Array.isArray(text)) {
			text = text
				.filter((t) => t.type === "text")
				.map((t) => t.text)
				.join("\n");
		}
		if (
			typeof text === "string" &&
			text.length > 0 &&
			!text.startsWith("<command-") &&
			!text.startsWith("{")
		) {
			return { role: "user", content: text, timestamp };
		}
	}

	if (entry.type === "assistant" || entry.message?.role === "assistant") {
		const content = entry.message?.content;
		if (Array.isArray(content)) {
			const textParts = content
				.filter((c) => c.type === "text")
				.map((c) => c.text);
			if (textParts.length > 0) {
				return { role: "assistant", content: textParts.join("\n"), timestamp };
			}
		}
		if (typeof content === "string" && content.length > 0) {
			return { role: "assistant", content, timestamp };
		}
	}

	return null;
}
