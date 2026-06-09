/**
 * Unit tests for the fix-empty-tool-pill-output implementation.
 *
 * Validates that:
 * 1. The tool_result processing branch in transformMessage() is reachable
 *    (not shadowed by the generic user early-return).
 * 2. Tool results are properly extracted and formatted.
 * 3. The taskoutput formatter exists and produces correct summaries.
 * 4. The CSS :empty rule hides empty .tool-pill-output divs.
 * 5. The frontend correctly populates and toggles tool output.
 *
 * Pattern follows tests/unit/mobile-ux-server.test.js: reads source files
 * as strings for static analysis, and re-implements private functions for
 * behavioral testing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Load source files as strings for static analysis
// ---------------------------------------------------------------------------
const claudeJsPath = resolve(
	import.meta.dirname,
	"../../server/claude/transform.js",
);
const claudeJs = readFileSync(claudeJsPath, "utf-8");

const styleCssPath = resolve(import.meta.dirname, "../../public/style.css");
const styleCss = readFileSync(styleCssPath, "utf-8");

const frontendJs = [
	"../../public/app.js",
	"../../public/js/messages.js",
	"../../public/js/ws-sse.js",
]
	.map((path) => readFileSync(resolve(import.meta.dirname, path), "utf-8"))
	.join("\n");
const appJs = `${frontendJs}\n${frontendJs.replaceAll('"', "'")}`;

// ---------------------------------------------------------------------------
// Re-implementations of private functions for behavioral testing
// (Mirror the fixed control flow from server/claude.js)
// ---------------------------------------------------------------------------

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
	bash: (i) => {
		const fullCommand = i.command || i.cmd || "";
		return {
			summary: `$ ${truncateOutput(fullCommand, TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
			fullCommand,
		};
	},
	read: (i) => {
		const filePath = i.file_path || i.path || null;
		return { summary: `Reading ${filePath || "file"}`, filePath };
	},
	write: (i) => {
		const filePath = i.file_path || i.path || null;
		return { summary: `Writing ${filePath || "file"}`, filePath };
	},
	edit: (i) => {
		const filePath = i.file_path || i.path || null;
		return { summary: `Editing ${filePath || "file"}`, filePath };
	},
	glob: (i) => {
		const pattern = i.pattern || null;
		return { summary: `Finding ${pattern || "files"}`, pattern };
	},
	grep: (i) => {
		const pattern = i.pattern || i.query || null;
		const fullQuery = i.query || pattern || "";
		return {
			summary: `Searching: ${truncateOutput(pattern || "", TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
			pattern,
			fullQuery,
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
			todos,
			todoCount,
			completedCount,
		};
	},
	todoread: () => ({ summary: "Reading todo list" }),
	task: (i) => {
		const description = i.prompt || i.task || i.description || "";
		return {
			summary: description
				? `Task: ${truncateOutput(description, TOOL_SUMMARY_TRUNCATE_LENGTH)}`
				: "Delegating task",
			taskDescription: description,
		};
	},
	taskoutput: (i) => {
		const taskId = i.task_id || "";
		return {
			summary: taskId ? `Checking task ${taskId}` : "Checking task output",
			taskId,
		};
	},
};

function getToolSummary(tool, input) {
	if (!input) return { summary: tool };
	const formatter = toolFormatters[tool.toLowerCase()];
	if (formatter) return formatter(input);
	return { summary: tool };
}

/**
 * Simplified transformMessage for behavioral testing.
 * Mirrors the fixed control flow: tool_result check BEFORE generic user return.
 */
function transformMessage(msg) {
	if (!msg || !msg.type) return null;

	const timestamp = new Date().toISOString();
	const messageId = "test-uuid";

	// Text content from assistant
	if (msg.type === "assistant" && msg.message?.content) {
		const content = msg.message.content;

		if (Array.isArray(content)) {
			const texts = content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (texts) {
				return { type: "text", content: texts, timestamp, messageId };
			}

			const toolUse = content.find((c) => c.type === "tool_use");
			if (toolUse) {
				if (toolUse.name === "AskUserQuestion") return null;
				if (toolUse.name === "ExitPlanMode") return null;

				const startTime = new Date();
				return {
					type: "tool_use",
					tool: toolUse.name,
					id: toolUse.id,
					summary: getToolSummary(toolUse.name, toolUse.input),
					timestamp,
					messageId,
					startTime: startTime.toISOString(),
				};
			}
		}

		if (typeof content === "string") {
			return { type: "text", content, timestamp, messageId };
		}
	}

	// Tool result (check BEFORE generic user return) - THIS IS THE FIX
	if (msg.type === "user" && msg.message?.content) {
		const content = msg.message.content;
		if (Array.isArray(content)) {
			const toolResult = content.find((c) => c.type === "tool_result");
			if (toolResult) {
				const toolUseId = toolResult.tool_use_id;
				return {
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
					duration: null,
					startTime: null,
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
// 1. Static Analysis - Control Flow Fix Verification
// ===========================================================================
describe("Static Analysis - tool_result control flow fix", () => {
	it("tool_result check appears BEFORE the generic user return in transformMessage()", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		expect(fnStart).toBeGreaterThan(-1);

		const fnBody = claudeJs.slice(fnStart);

		// Find the tool_result check line
		const toolResultCheckMatch = /c\.type === ["']tool_result["']/.exec(fnBody);
		const toolResultCheckIdx = toolResultCheckMatch?.index ?? -1;
		expect(toolResultCheckIdx).toBeGreaterThan(-1);

		// Find the generic user return (the comment is the reliable anchor)
		const genericUserCommentIdx = fnBody.indexOf("// User message echo");
		expect(genericUserCommentIdx).toBeGreaterThan(-1);

		// The tool_result check MUST appear before the generic user return
		expect(toolResultCheckIdx).toBeLessThan(genericUserCommentIdx);
	});

	it('does NOT have a generic msg.type === "user" return-null before the tool_result check', () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnBody = claudeJs.slice(fnStart);

		// Find the tool_result check
		const toolResultMatch = /c\.type === ["']tool_result["']/.exec(fnBody);
		const toolResultIdx = toolResultMatch?.index ?? -1;

		// Get everything before the tool_result check
		const beforeToolResult = fnBody.slice(0, toolResultIdx);

		// There should NOT be a standalone `if (msg.type === 'user') { return null; }` before tool_result
		// We look for the pattern of a generic user check that returns null
		// The comment "// Tool result (check before generic user return)" should precede the tool_result block
		const genericUserReturnPattern =
			/if\s*\(\s*msg\.type\s*===\s*['"]user['"]\s*\)\s*\{\s*return\s+null/;
		const hasGenericUserReturnBefore =
			genericUserReturnPattern.test(beforeToolResult);
		expect(hasGenericUserReturnBefore).toBe(false);
	});

	it("the tool_result branch is inside a user type check with content guard", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnBody = claudeJs.slice(fnStart);

		// The tool_result branch should be wrapped in msg.type === 'user' && msg.message?.content
		const toolResultMatch = /c\.type === ["']tool_result["']/.exec(fnBody);
		const toolResultIdx = toolResultMatch?.index ?? -1;
		const contextBefore = fnBody.slice(
			Math.max(0, toolResultIdx - 300),
			toolResultIdx,
		);

		expect(contextBefore).toMatch(/msg\.type\s*===\s*['"]user['"]/);
		expect(contextBefore).toMatch(/msg\.message\?\.content/);
	});
});

// ===========================================================================
// 2. transformMessage with tool_result - Behavioral Tests
// ===========================================================================
describe("transformMessage - tool_result handling", () => {
	it("returns a result object (not null) for user message containing tool_result", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-abc-123",
						content: "Command output here",
					},
				],
			},
		});

		expect(result).not.toBeNull();
		expect(result.type).toBe("tool_result");
	});

	it("returns null for a plain user message (no tool_result)", () => {
		const result = transformMessage({ type: "user" });
		expect(result).toBeNull();
	});

	it("returns null for a user message with content but no tool_result items", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [{ type: "text", text: "Hello" }],
			},
		});
		expect(result).toBeNull();
	});

	it("returns object with all 8 expected fields", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-xyz",
						content: "output data",
					},
				],
			},
		});

		expect(result).toHaveProperty("type");
		expect(result).toHaveProperty("id");
		expect(result).toHaveProperty("success");
		expect(result).toHaveProperty("output");
		expect(result).toHaveProperty("timestamp");
		expect(result).toHaveProperty("messageId");
		expect(result).toHaveProperty("duration");
		expect(result).toHaveProperty("startTime");
	});

	it("sets success=true when tool_result has no is_error flag", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "success output",
					},
				],
			},
		});

		expect(result.success).toBe(true);
	});

	it("sets success=false when tool_result has is_error=true", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-2",
						content: "Error: something failed",
						is_error: true,
					},
				],
			},
		});

		expect(result.success).toBe(false);
	});

	it("extracts tool_use_id as the result id", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "specific-tool-id-456",
						content: "output",
					},
				],
			},
		});

		expect(result.id).toBe("specific-tool-id-456");
	});

	it("truncates long output to TOOL_OUTPUT_TRUNCATE_LENGTH (500 chars)", () => {
		const longOutput = "x".repeat(800);
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-long",
						content: longOutput,
					},
				],
			},
		});

		// Should be truncated: 500 chars + truncation suffix
		expect(result.output.length).toBeLessThan(longOutput.length);
		expect(result.output).toContain("... (300 more chars)");
		expect(result.output.startsWith("x".repeat(500))).toBe(true);
	});

	it("does not truncate short output", () => {
		const shortOutput = "short result";
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-short",
						content: shortOutput,
					},
				],
			},
		});

		expect(result.output).toBe(shortOutput);
	});

	it("handles non-string tool_result content by JSON stringifying it", () => {
		const result = transformMessage({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-json",
						content: { key: "value", nested: [1, 2, 3] },
					},
				],
			},
		});

		expect(result.output).toContain("key");
		expect(result.output).toContain("value");
	});
});

// ===========================================================================
// 3. Static Analysis - tool_result return object fields in source
// ===========================================================================
describe("Static Analysis - tool_result return object in source", () => {
	it("tool_result return object has all 8 expected fields in source", () => {
		// Find the tool_result return block in the actual source
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnBody = claudeJs.slice(fnStart);

		// Find where the tool_result result object is constructed
		const resultBlockMatch = /type:\s*["']tool_result["']/.exec(fnBody);
		const resultBlockStart = resultBlockMatch?.index ?? -1;
		expect(resultBlockStart).toBeGreaterThan(-1);

		// Get a generous slice around the result object construction
		const resultBlock = fnBody.slice(resultBlockStart, resultBlockStart + 500);

		expect(resultBlock).toMatch(/type:\s*["']tool_result["']/);
		expect(resultBlock).toContain("id: toolUseId");
		expect(resultBlock).toContain("success: !toolResult.is_error");
		expect(resultBlock).toContain("output: truncateOutput");
		expect(resultBlock).toContain("timestamp");
		expect(resultBlock).toContain("messageId");
		expect(resultBlock).toContain("duration");
		expect(resultBlock).toContain("startTime");
	});
});

// ===========================================================================
// 4. taskoutput formatter - Behavioral Tests
// ===========================================================================
describe("taskoutput formatter", () => {
	it("toolFormatters.taskoutput exists in source", () => {
		const formattersStart = claudeJs.indexOf("const toolFormatters = {");
		const nextFn = claudeJs.indexOf("function getToolSummary", formattersStart);
		const formattersBlock = claudeJs.slice(formattersStart, nextFn);

		expect(formattersBlock).toContain("taskoutput:");
	});

	it("taskoutput formatter with task_id returns summary containing the task ID", () => {
		const result = toolFormatters.taskoutput({ task_id: "abc123" });
		expect(result.summary).toContain("abc123");
		expect(result.summary).toContain("Checking task");
		expect(result.taskId).toBe("abc123");
	});

	it("taskoutput formatter without task_id returns a generic summary", () => {
		const result = toolFormatters.taskoutput({});
		expect(result.summary).toBe("Checking task output");
		expect(result.taskId).toBe("");
	});

	it("taskoutput formatter with empty task_id returns generic summary", () => {
		const result = toolFormatters.taskoutput({ task_id: "" });
		expect(result.summary).toBe("Checking task output");
	});

	it('getToolSummary("TaskOutput", ...) correctly lowercases to find taskoutput formatter', () => {
		const result = getToolSummary("TaskOutput", { task_id: "task-99" });
		expect(result.summary).toContain("task-99");
		expect(result.summary).toContain("Checking task");
	});

	it("getToolSummary is case-insensitive for taskoutput lookup", () => {
		const r1 = getToolSummary("TASKOUTPUT", { task_id: "A" });
		const r2 = getToolSummary("taskoutput", { task_id: "A" });
		const r3 = getToolSummary("TaskOutput", { task_id: "A" });

		expect(r1.summary).toBe(r2.summary);
		expect(r2.summary).toBe(r3.summary);
	});

	it("getToolSummary lowercasing is verified in source code", () => {
		const fnStart = claudeJs.indexOf("function getToolSummary(");
		const fnEnd = claudeJs.indexOf("\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("tool.toLowerCase()");
	});
});

// ===========================================================================
// 5. CSS :empty rule - Static Analysis
// ===========================================================================
describe("CSS - tool-pill-output:empty rule", () => {
	it(".tool-pill-output:empty rule exists with display: none", () => {
		expect(styleCss).toContain(".tool-pill-output:empty");
		// Find the rule and check its content
		const ruleIdx = styleCss.indexOf(".tool-pill-output:empty");
		const ruleBlock = styleCss.slice(
			ruleIdx,
			styleCss.indexOf("}", ruleIdx) + 1,
		);
		expect(ruleBlock).toContain("display: none");
	});

	it(":empty rule appears AFTER the base .tool-pill-output rules", () => {
		const baseRuleIdx = styleCss.indexOf(".tool-pill-output {");
		expect(baseRuleIdx).toBeGreaterThan(-1);

		const emptyRuleIdx = styleCss.indexOf(".tool-pill-output:empty");
		expect(emptyRuleIdx).toBeGreaterThan(-1);

		expect(emptyRuleIdx).toBeGreaterThan(baseRuleIdx);
	});

	it("base .tool-pill-output rule has padding and margin styles", () => {
		const baseRuleIdx = styleCss.indexOf(".tool-pill-output {");
		const ruleEnd = styleCss.indexOf("}", baseRuleIdx);
		const baseRule = styleCss.slice(baseRuleIdx, ruleEnd + 1);

		expect(baseRule).toContain("margin:");
		expect(baseRule).toContain("padding:");
	});
});

// ===========================================================================
// 6. Frontend - updateToolResult populates output (Static Analysis)
// ===========================================================================
describe("Frontend - updateToolResult behavior", () => {
	it("updateToolResult function exists in app.js", () => {
		expect(appJs).toContain("function updateToolResult(");
	});

	it("updateToolResult sets outputEl.textContent when output is non-empty", () => {
		const fnStart = appJs.indexOf("function updateToolResult(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 2000);

		// Verify it checks for output content
		expect(fnBody).toContain("output && output.trim()");
		// Verify it finds the output element
		expect(fnBody).toContain(".tool-pill-output");
		// Verify it sets textContent
		expect(fnBody).toContain("outputEl.textContent = output");
	});

	it("updateToolResult updates duration display when resultMetadata has duration", () => {
		const fnStart = appJs.indexOf("function updateToolResult(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 2000);

		expect(fnBody).toContain("resultMetadata.duration");
		expect(fnBody).toContain(".tool-pill-duration");
		expect(fnBody).toContain("formatDuration");
	});

	it("updateToolResult updates status class (success/error)", () => {
		const fnStart = appJs.indexOf("function updateToolResult(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 2000);

		expect(fnBody).toContain("classList.add(success ? 'success' : 'error')");
	});
});

// ===========================================================================
// 7. Frontend - Toggle compatibility (Static Analysis)
// ===========================================================================
describe("Frontend - toggle compatibility with :empty CSS", () => {
	it("toggle logic reads hidden state from .tool-pill-output", () => {
		// Find the toggle click handler
		const toggleIdx = appJs.indexOf("Tool pill expand/collapse delegation");
		expect(toggleIdx).toBeGreaterThan(-1);

		const toggleBlock = appJs.slice(toggleIdx, toggleIdx + 600);
		expect(toggleBlock).toContain('output.classList.contains("hidden")');
	});

	it("toggle logic references .tool-pill-output and .tool-pill-header elements", () => {
		const toggleIdx = appJs.indexOf("Tool pill expand/collapse delegation");
		const toggleBlock = appJs.slice(toggleIdx, toggleIdx + 600);

		expect(toggleBlock).toContain(".tool-pill-output");
		expect(toggleBlock).toContain(".tool-pill-header");
	});

	it("toggle uses explicit add/remove with hidden class", () => {
		const toggleIdx = appJs.indexOf("Tool pill expand/collapse delegation");
		const toggleBlock = appJs.slice(toggleIdx, toggleIdx + 1000);

		expect(toggleBlock).toContain('output.classList.add("hidden")');
		expect(toggleBlock).toContain('output.classList.remove("hidden")');
	});
});

// ===========================================================================
// 8. Frontend - tool_result message dispatch (Static Analysis)
// ===========================================================================
describe("Frontend - tool_result message dispatch", () => {
	it("app.js dispatches tool_result messages to updateToolResult", () => {
		expect(appJs).toContain("data.type === 'tool_result'");
	});

	it("tool_result handler passes timing metadata", () => {
		const handlerIdx = appJs.indexOf("data.type === 'tool_result'");
		const handlerBlock = appJs.slice(handlerIdx, handlerIdx + 400);

		expect(handlerBlock).toContain("data.duration");
		expect(handlerBlock).toContain("data.timestamp");
	});

	it("tool_use handler creates tool pill with running status", () => {
		const handlerIdx = appJs.indexOf("data.type === 'tool_use'");
		const handlerBlock = appJs.slice(handlerIdx, handlerIdx + 600);

		expect(handlerBlock).toContain("'running'");
		expect(handlerBlock).toContain("appendToolMessage");
	});
});

// ===========================================================================
// 9. No dead code verification - comprehensive check
// ===========================================================================
describe("No dead code - transformMessage control flow", () => {
	it("there are exactly two user type checks in transformMessage: guarded and generic", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnEnd = claudeJs.indexOf("\n  return null;\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);

		// Count all occurrences of `msg.type === 'user'` (with or without extra conditions)
		const allUserChecks = fnBody.match(/msg\.type\s*===\s*['"]user['"]/g);

		// Should have exactly 2 user type checks:
		// 1. Guarded: if (msg.type === 'user' && msg.message?.content) — for tool_result
		// 2. Generic: if (msg.type === 'user') { return null; } — echo suppression
		expect(allUserChecks).not.toBeNull();
		expect(allUserChecks.length).toBe(2);

		// Verify the guarded check (with && content) exists
		expect(fnBody).toMatch(
			/msg\.type === ["']user["'] && msg\.message\?\.content/,
		);

		// Verify the generic check exists as a standalone condition
		const genericPattern =
			/if\s*\(\s*msg\.type\s*===\s*['"]user['"]\s*\)\s*\{/g;
		const genericMatches = fnBody.match(genericPattern);
		expect(genericMatches).not.toBeNull();
		expect(genericMatches.length).toBe(1);
	});

	it("the tool_result branch comment confirms fixed ordering", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnBody = claudeJs.slice(fnStart);

		// The fix introduces/preserves a comment about checking before generic user return
		const toolResultComment = fnBody.indexOf(
			"Tool result (check before generic user return)",
		);
		const genericUserComment = fnBody.indexOf("User message echo");

		// Both comments should exist
		expect(toolResultComment).toBeGreaterThan(-1);
		expect(genericUserComment).toBeGreaterThan(-1);

		// The tool_result comment should come first
		expect(toolResultComment).toBeLessThan(genericUserComment);
	});

	it('generic user return has the comment "only reached if NOT a tool_result"', () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnBody = claudeJs.slice(fnStart);

		expect(fnBody).toContain("only reached if NOT a tool_result");
	});
});

// ===========================================================================
// 10. Existing tool formatters remain correct (no regressions)
// ===========================================================================
describe("Existing tool formatters - no regressions", () => {
	it("bash formatter returns object with summary and fullCommand", () => {
		const result = toolFormatters.bash({ command: "npm test" });
		expect(result.summary).toBe("$ npm test");
		expect(result.fullCommand).toBe("npm test");
	});

	it("read formatter returns object with summary and filePath", () => {
		const result = toolFormatters.read({ file_path: "/src/index.js" });
		expect(result.summary).toBe("Reading /src/index.js");
		expect(result.filePath).toBe("/src/index.js");
	});

	it("write formatter returns object with summary and filePath", () => {
		const result = toolFormatters.write({ file_path: "/out/data.json" });
		expect(result.summary).toBe("Writing /out/data.json");
	});

	it("edit formatter returns object with summary and filePath", () => {
		const result = toolFormatters.edit({ file_path: "/src/app.js" });
		expect(result.summary).toBe("Editing /src/app.js");
	});

	it("glob formatter returns object with summary and pattern", () => {
		const result = toolFormatters.glob({ pattern: "**/*.ts" });
		expect(result.summary).toBe("Finding **/*.ts");
		expect(result.pattern).toBe("**/*.ts");
	});

	it("grep formatter returns object with summary, pattern, and fullQuery", () => {
		const result = toolFormatters.grep({ pattern: "TODO", query: "TODO" });
		expect(result.summary).toContain("Searching:");
		expect(result.summary).toContain("TODO");
	});

	it("todowrite formatter with todos returns count summary", () => {
		const result = toolFormatters.todowrite({
			todos: [
				{ content: "Task 1", status: "completed" },
				{ content: "Task 2", status: "pending" },
				{ content: "Task 3", status: "done" },
			],
		});
		expect(result.summary).toBe("Updating todo list (2/3 completed)");
		expect(result.todoCount).toBe(3);
		expect(result.completedCount).toBe(2);
	});

	it("todowrite formatter with empty todos returns generic summary", () => {
		const result = toolFormatters.todowrite({ todos: [] });
		expect(result.summary).toBe("Updating todo list");
	});

	it("todoread formatter returns static summary", () => {
		const result = toolFormatters.todoread();
		expect(result.summary).toBe("Reading todo list");
	});

	it("task formatter with description returns task summary", () => {
		const result = toolFormatters.task({ prompt: "Write a test file" });
		expect(result.summary).toContain("Task:");
		expect(result.summary).toContain("Write a test file");
	});

	it("task formatter without description returns generic summary", () => {
		const result = toolFormatters.task({});
		expect(result.summary).toBe("Delegating task");
	});
});

// ===========================================================================
// 11. Source code formatters match re-implementation
// ===========================================================================
describe("Source code formatters exist in server/claude.js", () => {
	it("all formatter keys exist in source toolFormatters", () => {
		const formattersStart = claudeJs.indexOf("const toolFormatters = {");
		const nextFn = claudeJs.indexOf("function getToolSummary", formattersStart);
		const formattersBlock = claudeJs.slice(formattersStart, nextFn);

		const expectedKeys = [
			"bash",
			"read",
			"write",
			"edit",
			"glob",
			"grep",
			"todowrite",
			"todoread",
			"task",
			"taskoutput",
		];
		for (const key of expectedKeys) {
			expect(formattersBlock).toContain(`${key}:`);
		}
	});

	it("getToolSummary returns object format (not string) for known tools", () => {
		// Check the source code returns objects with summary field
		const fnStart = claudeJs.indexOf("function getToolSummary(");
		const fnEnd = claudeJs.indexOf("\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);

		// Default return is an object with summary field
		expect(fnBody).toContain("{ summary: tool }");
	});
});

// ===========================================================================
// 12. appendToolMessage creates output div (Static Analysis)
// ===========================================================================
describe("Frontend - appendToolMessage creates output div", () => {
	it("appendToolMessage creates a .tool-pill-output element", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 3000);

		expect(fnBody).toContain("tool-pill-output");
	});

	it("appendToolMessage creates tool-pill-header with status, duration, and toggle elements", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 3000);

		expect(fnBody).toContain("tool-pill-header");
		expect(fnBody).toContain("tool-pill-status");
		expect(fnBody).toContain("tool-pill-duration");
		expect(fnBody).toContain("tool-pill-chevron");
	});
});
