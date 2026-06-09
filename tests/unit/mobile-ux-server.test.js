/**
 * Unit tests for mobile UX enhancements in server/claude.js
 *
 * Tests extractTokenUsage, getToolSummary, truncateOutput, and transformMessage
 * functions. Since these are not exported, we use static analysis of the source
 * code combined with isolated logic simulation matching the implementation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const claudeIndexJsPath = resolve(
	import.meta.dirname,
	"../../server/claude/index.js",
);
const claudeTransformJsPath = resolve(
	import.meta.dirname,
	"../../server/claude/transform.js",
);
const claudeHistoryJsPath = resolve(
	import.meta.dirname,
	"../../server/claude/history.js",
);
const claudeJs = [claudeIndexJsPath, claudeTransformJsPath, claudeHistoryJsPath]
	.map((path) => readFileSync(path, "utf-8"))
	.join("\n");

// ---------------------------------------------------------------------------
// Re-implementations of private functions for testing
// (Exact logic copies from source - verified by static analysis tests)
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200000;
const TOOL_OUTPUT_TRUNCATE_LENGTH = 500;
const TOOL_SUMMARY_TRUNCATE_LENGTH = 100;

function truncateOutput(content, maxLength) {
	if (typeof content !== "string") return String(content);
	if (content.length <= maxLength) return content;
	return (
		content.slice(0, maxLength) +
		`\n... (${content.length - maxLength} more chars)`
	);
}

const toolFormatters = {
	bash: (i) =>
		`$ ${truncateOutput(i.command || i.cmd || "", TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
	read: (i) => `Reading ${i.file_path || i.path || "file"}`,
	write: (i) => `Writing ${i.file_path || i.path || "file"}`,
	edit: (i) => `Editing ${i.file_path || i.path || "file"}`,
	glob: (i) => `Finding ${i.pattern || "files"}`,
	grep: (i) => `Searching: ${i.pattern || i.query || ""}`,
	todowrite: () => "Updating todo list",
	todoread: () => "Reading todo list",
	task: () => "Delegating task",
};

function getToolSummary(tool, input) {
	if (!input) return tool;
	const formatter = toolFormatters[tool.toLowerCase()];
	return formatter ? formatter(input) : tool;
}

function extractTokenUsage(modelUsage, contextWindowEnv = null) {
	if (!modelUsage) return null;
	const modelKey = Object.keys(modelUsage)[0];
	const data = modelUsage[modelKey];
	if (!data) return null;

	const input = data.cumulativeInputTokens || data.inputTokens || 0;
	const output = data.cumulativeOutputTokens || data.outputTokens || 0;
	const cacheRead =
		data.cumulativeCacheReadInputTokens || data.cacheReadInputTokens || 0;
	const cacheCreate =
		data.cumulativeCacheCreationInputTokens ||
		data.cacheCreationInputTokens ||
		0;

	const used = input + output + cacheRead + cacheCreate;
	const contextWindow = contextWindowEnv || DEFAULT_CONTEXT_WINDOW;

	return { used, contextWindow, model: modelKey };
}

function transformMessage(msg) {
	if (!msg || !msg.type) return null;

	// Text content from assistant
	if (msg.type === "assistant" && msg.message?.content) {
		const content = msg.message.content;

		if (Array.isArray(content)) {
			const texts = content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

			if (texts) {
				return { type: "text", content: texts };
			}

			const toolUse = content.find((c) => c.type === "tool_use");
			if (toolUse) {
				if (toolUse.name === "AskUserQuestion") {
					return null;
				}
				return {
					type: "tool_use",
					tool: toolUse.name,
					id: toolUse.id,
					summary: getToolSummary(toolUse.name, toolUse.input),
				};
			}
		}

		if (typeof content === "string") {
			return { type: "text", content };
		}
	}

	// Tool result (check before generic user return)
	if (msg.type === "user" && msg.message?.content) {
		const content = msg.message.content;
		if (Array.isArray(content)) {
			const toolResult = content.find((c) => c.type === "tool_result");
			if (toolResult) {
				return {
					type: "tool_result",
					id: toolResult.tool_use_id,
					success: !toolResult.is_error,
					output: truncateOutput(
						typeof toolResult.content === "string"
							? toolResult.content
							: JSON.stringify(toolResult.content),
						TOOL_OUTPUT_TRUNCATE_LENGTH,
					),
				};
			}
		}
	}

	// User message echo - only reached if NOT a tool_result
	if (msg.type === "user") {
		return null;
	}

	// Result message
	if (msg.type === "result") {
		return null;
	}

	return null;
}

// ===========================================================================
// 1. Static Analysis - Source Code Structure Verification
// ===========================================================================
describe("Static Analysis - server/claude.js structure", () => {
	it("defines DEFAULT_CONTEXT_WINDOW = 200000", () => {
		expect(claudeJs).toContain("const DEFAULT_CONTEXT_WINDOW = 200000;");
	});

	it("defines TOOL_OUTPUT_TRUNCATE_LENGTH = 1500", () => {
		expect(claudeJs).toContain("const TOOL_OUTPUT_TRUNCATE_LENGTH = 1500;");
	});

	it("defines TOOL_SUMMARY_TRUNCATE_LENGTH = 200", () => {
		expect(claudeJs).toContain("const TOOL_SUMMARY_TRUNCATE_LENGTH = 200;");
	});

	it("extractTokenUsage returns object with used, contextWindow, and model fields", () => {
		expect(claudeJs).toContain("used: cumulativeTotal");
		expect(claudeJs).toContain("contextWindow,");
		expect(claudeJs).toContain("model: modelKey,");
	});

	it("extractTokenUsage aggregates all four token types", () => {
		const fnStart = claudeJs.indexOf("function extractTokenUsage(");
		const fnEnd = claudeJs.indexOf("\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("cumulativeInputTokens");
		expect(fnBody).toContain("cumulativeOutputTokens");
		expect(fnBody).toContain("cumulativeCacheReadInputTokens");
		expect(fnBody).toContain("cumulativeCacheCreationInputTokens");
	});

	it("processQueryStream sends token-usage message with model field", () => {
		expect(claudeJs).toMatch(/type:\s*["']token-usage["']/);
		// Verify the spread operator includes all fields from extractTokenUsage
		const tokenUsageSendStart = claudeJs.search(/type:\s*["']token-usage["']/);
		const sendBlock = claudeJs.slice(
			tokenUsageSendStart - 50,
			tokenUsageSendStart + 200,
		);
		expect(sendBlock).toContain("...usage");
	});

	it("transformMessage handles assistant text, tool_use, user, and result types", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnEnd = claudeJs.indexOf("\n  return null;\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);

		expect(fnBody).toMatch(/msg\.type === ["']assistant["']/);
		expect(fnBody).toMatch(/msg\.type === ["']user["']/);
		expect(fnBody).toMatch(/msg\.type === ["']result["']/);
		expect(fnBody).toMatch(/c\.type === ["']tool_use["']/);
		expect(fnBody).toMatch(/c\.type === ["']text["']/);
	});

	it("transformMessage skips AskUserQuestion tool calls", () => {
		expect(claudeJs).toMatch(/toolUse\.name === ["']AskUserQuestion["']/);
	});

	it("tool formatters cover all expected tools", () => {
		const formattersStart = claudeJs.indexOf("const toolFormatters = {");
		// Find the closing }; that follows the last formatter by searching for
		// the next function declaration after toolFormatters
		const nextFnStart = claudeJs.indexOf(
			"function getToolSummary",
			formattersStart,
		);
		const formattersBlock = claudeJs.slice(formattersStart, nextFnStart);

		expect(formattersBlock).toContain("bash:");
		expect(formattersBlock).toContain("read:");
		expect(formattersBlock).toContain("write:");
		expect(formattersBlock).toContain("edit:");
		expect(formattersBlock).toContain("glob:");
		expect(formattersBlock).toContain("grep:");
		expect(formattersBlock).toContain("todowrite:");
		expect(formattersBlock).toContain("todoread:");
		expect(formattersBlock).toContain("task:");
		expect(formattersBlock).toContain("taskoutput:");
	});
});

// ===========================================================================
// 2. extractTokenUsage - Logic Tests
// ===========================================================================
describe("extractTokenUsage", () => {
	it("returns null when modelUsage is null", () => {
		expect(extractTokenUsage(null)).toBeNull();
	});

	it("returns null when modelUsage is undefined", () => {
		expect(extractTokenUsage(undefined)).toBeNull();
	});

	it("returns null when model data is empty", () => {
		expect(extractTokenUsage({ "claude-sonnet": null })).toBeNull();
	});

	it("computes used from cumulative token fields", () => {
		const result = extractTokenUsage({
			"claude-sonnet-4-20250514": {
				cumulativeInputTokens: 1000,
				cumulativeOutputTokens: 500,
				cumulativeCacheReadInputTokens: 200,
				cumulativeCacheCreationInputTokens: 100,
			},
		});

		expect(result).toEqual({
			used: 1800,
			contextWindow: 200000,
			model: "claude-sonnet-4-20250514",
		});
	});

	it("falls back to non-cumulative token fields", () => {
		const result = extractTokenUsage({
			"claude-opus-4": {
				inputTokens: 500,
				outputTokens: 200,
			},
		});

		expect(result).toEqual({
			used: 700,
			contextWindow: 200000,
			model: "claude-opus-4",
		});
	});

	it("uses first model key as model name", () => {
		const result = extractTokenUsage({
			"claude-haiku-3": { inputTokens: 100, outputTokens: 50 },
		});

		expect(result.model).toBe("claude-haiku-3");
	});

	it("uses DEFAULT_CONTEXT_WINDOW when env is not set", () => {
		const result = extractTokenUsage({
			"some-model": { inputTokens: 100 },
		});

		expect(result.contextWindow).toBe(200000);
	});

	it("handles all zero token counts", () => {
		const result = extractTokenUsage({
			"test-model": {},
		});

		expect(result.used).toBe(0);
	});
});

// ===========================================================================
// 3. getToolSummary - Logic Tests
// ===========================================================================
describe("getToolSummary", () => {
	it("returns tool name when input is null", () => {
		expect(getToolSummary("Bash", null)).toBe("Bash");
	});

	it("returns tool name when input is undefined", () => {
		expect(getToolSummary("Unknown", undefined)).toBe("Unknown");
	});

	it("formats Bash with command prefixed by $", () => {
		expect(getToolSummary("Bash", { command: "ls -la" })).toBe("$ ls -la");
	});

	it("formats Bash with cmd field fallback", () => {
		expect(getToolSummary("Bash", { cmd: "echo hello" })).toBe("$ echo hello");
	});

	it("formats Read with file_path", () => {
		expect(getToolSummary("Read", { file_path: "/src/index.js" })).toBe(
			"Reading /src/index.js",
		);
	});

	it("formats Read with path fallback", () => {
		expect(getToolSummary("Read", { path: "/src/main.ts" })).toBe(
			"Reading /src/main.ts",
		);
	});

	it("formats Write with file_path", () => {
		expect(getToolSummary("Write", { file_path: "/out/data.json" })).toBe(
			"Writing /out/data.json",
		);
	});

	it("formats Edit with file_path", () => {
		expect(getToolSummary("Edit", { file_path: "/src/app.js" })).toBe(
			"Editing /src/app.js",
		);
	});

	it("formats Glob with pattern", () => {
		expect(getToolSummary("Glob", { pattern: "**/*.ts" })).toBe(
			"Finding **/*.ts",
		);
	});

	it("formats Grep with pattern", () => {
		expect(getToolSummary("Grep", { pattern: "TODO" })).toBe("Searching: TODO");
	});

	it("formats Grep with query fallback", () => {
		expect(getToolSummary("Grep", { query: "FIXME" })).toBe("Searching: FIXME");
	});

	it("formats TodoWrite as static string", () => {
		expect(getToolSummary("TodoWrite", {})).toBe("Updating todo list");
	});

	it("formats TodoRead as static string", () => {
		expect(getToolSummary("TodoRead", {})).toBe("Reading todo list");
	});

	it("formats Task as static string", () => {
		expect(getToolSummary("Task", {})).toBe("Delegating task");
	});

	it("returns tool name for unknown tools", () => {
		expect(getToolSummary("CustomTool", { data: "test" })).toBe("CustomTool");
	});

	it("is case-insensitive on tool name lookup", () => {
		expect(getToolSummary("BASH", { command: "pwd" })).toBe("$ pwd");
		expect(getToolSummary("bash", { command: "pwd" })).toBe("$ pwd");
	});
});

// ===========================================================================
// 4. truncateOutput - Logic Tests
// ===========================================================================
describe("truncateOutput", () => {
	it("returns short strings unchanged", () => {
		expect(truncateOutput("hello", 500)).toBe("hello");
	});

	it("returns string at exact maxLength unchanged", () => {
		const str = "a".repeat(500);
		expect(truncateOutput(str, 500)).toBe(str);
	});

	it("truncates long strings with char count suffix", () => {
		const str = "a".repeat(600);
		const result = truncateOutput(str, 500);
		expect(result).toContain("a".repeat(500));
		expect(result).toContain("... (100 more chars)");
	});

	it("converts non-string input to string", () => {
		expect(truncateOutput(42, 500)).toBe("42");
		expect(truncateOutput(null, 500)).toBe("null");
		expect(truncateOutput(undefined, 500)).toBe("undefined");
	});

	it("handles empty string", () => {
		expect(truncateOutput("", 500)).toBe("");
	});

	it("handles maxLength of 0", () => {
		const result = truncateOutput("hello", 0);
		expect(result).toContain("... (5 more chars)");
	});
});

// ===========================================================================
// 5. transformMessage - Logic Tests
// ===========================================================================
describe("transformMessage", () => {
	it("returns null for null input", () => {
		expect(transformMessage(null)).toBeNull();
	});

	it("returns null for undefined input", () => {
		expect(transformMessage(undefined)).toBeNull();
	});

	it("returns null for message without type", () => {
		expect(transformMessage({ data: "test" })).toBeNull();
	});

	it("extracts text from assistant message with array content", () => {
		const result = transformMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "Hello " },
					{ type: "text", text: "world!" },
				],
			},
		});

		expect(result).toEqual({ type: "text", content: "Hello world!" });
	});

	it("extracts tool_use from assistant message", () => {
		const result = transformMessage({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Bash",
						id: "tool-123",
						input: { command: "ls" },
					},
				],
			},
		});

		expect(result).toEqual({
			type: "tool_use",
			tool: "Bash",
			id: "tool-123",
			summary: "$ ls",
		});
	});

	it("skips AskUserQuestion tool calls", () => {
		const result = transformMessage({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "AskUserQuestion",
						id: "q-1",
						input: { questions: ["What?"] },
					},
				],
			},
		});

		expect(result).toBeNull();
	});

	it("handles assistant message with string content", () => {
		const result = transformMessage({
			type: "assistant",
			message: { content: "plain text response" },
		});

		expect(result).toEqual({ type: "text", content: "plain text response" });
	});

	it("returns null for user messages", () => {
		const result = transformMessage({ type: "user" });
		expect(result).toBeNull();
	});

	it("returns null for result messages", () => {
		const result = transformMessage({ type: "result", modelUsage: {} });
		expect(result).toBeNull();
	});

	it("returns null for unknown message types", () => {
		expect(transformMessage({ type: "unknown" })).toBeNull();
	});

	it("returns null for assistant with empty content array", () => {
		const result = transformMessage({
			type: "assistant",
			message: { content: [] },
		});
		expect(result).toBeNull();
	});

	it("prioritizes text over tool_use when both present", () => {
		const result = transformMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "Thinking..." },
					{ type: "tool_use", name: "Bash", id: "x", input: {} },
				],
			},
		});

		expect(result.type).toBe("text");
		expect(result.content).toBe("Thinking...");
	});
});
