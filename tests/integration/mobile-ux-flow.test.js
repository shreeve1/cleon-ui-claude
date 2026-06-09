/**
 * Integration tests for mobile UX enhancements message flow
 *
 * Tests the end-to-end protocol for:
 * - Token usage / context bar update flow
 * - Tool pill rendering and update flow
 * - Auto-scroll FAB integration with message reception
 * - Notification firing on claude-done and error
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const frontendJs = [
	"public/app.js",
	"public/js/ws-sse.js",
	"public/js/input.js",
	"public/js/messages.js",
	"public/js/sessions.js",
	"public/js/streaming.js",
	"public/js/notifications.js",
]
	.map((path) => readFileSync(resolve(path), "utf8"))
	.join("\n");
const appJs = `${frontendJs.replaceAll('"', "'")}\n${frontendJs}`;
const claudeIndexJs = readFileSync(resolve("server/claude/index.js"), "utf8");
const claudeTransformJs = readFileSync(
	resolve("server/claude/transform.js"),
	"utf8",
);
const claudeJs = `${claudeIndexJs}\n${claudeTransformJs}`;

// ===========================================================================
// 1. Token Usage / Context Bar Message Flow
// ===========================================================================
describe("Token usage message flow (server -> client)", () => {
	it("server extractTokenUsage returns model field", () => {
		const fnStart = claudeJs.indexOf("function extractTokenUsage(");
		const fnEnd = claudeJs.indexOf("\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("model: modelKey");
	});

	it("server sends token-usage message with spread of extractTokenUsage result", () => {
		// In processQueryStream, after extractTokenUsage returns, it sends:
		// { type: 'token-usage', sessionId, ...usage }
		const sendStart = claudeJs.search(/type:\s*["']token-usage["']/);
		const sendBlock = claudeJs.slice(sendStart - 100, sendStart + 200);
		expect(sendBlock).toContain("...usage");
		expect(sendBlock).toContain("sessionId");
	});

	it("client token-usage handler stores model on session", () => {
		const caseStart = appJs.indexOf("case 'token-usage':");
		const caseEnd = appJs.indexOf("break;", caseStart);
		const caseBody = appJs.slice(caseStart, caseEnd);
		expect(caseBody).toContain("msg.model");
		expect(caseBody).toContain("session.model");
	});

	it("client token-usage handler passes usage object to updateTokenUsage", () => {
		const caseStart = appJs.indexOf("case 'token-usage':");
		const caseEnd = appJs.indexOf("break;", caseStart);
		const caseBody = appJs.slice(caseStart, caseEnd);
		expect(caseBody).toContain("updateTokenUsage(msg, session)");
	});

	it("updateTokenUsage computes percentage and sets context bar fill width", () => {
		const fnStart = appJs.indexOf("function updateTokenUsage(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("Math.round((totalTokens / windowSize) * 100)");
		expect(fnBody).toContain("contextUsageFill.style.width = `${pct}%`");
	});

	it("updateTokenUsage formats text as usedK/totalK", () => {
		const fnStart = appJs.indexOf("function updateTokenUsage(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("Math.round(totalTokens / 1000)");
		expect(fnBody).toContain("Math.round(windowSize / 1000)");
	});

	it("updateTokenUsage shows model name when session.model is set", () => {
		const fnStart = appJs.indexOf("function updateTokenUsage(");
		const fnEnd = appJs.indexOf("\nfunction", fnStart + 1);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("session.model");
		expect(fnBody).toContain("contextModel.textContent = session.model");
	});
});

// ===========================================================================
// 2. Tool Pill Rendering Flow
// ===========================================================================
describe("Tool pill rendering flow", () => {
	it("handleClaudeMessage dispatches tool_use to appendToolMessage", () => {
		const fnStart = appJs.indexOf("function handleClaudeMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("appendToolMessage");
		expect(fnBody).toContain("data.type === 'tool_use'");
	});

	it("handleClaudeMessage dispatches tool_result to updateToolResult", () => {
		const fnStart = appJs.indexOf("function handleClaudeMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("updateToolResult");
		expect(fnBody).toContain("data.type === 'tool_result'");
	});

	it("appendToolMessage creates DOM with running status by default", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		// Status is passed as parameter, running shows an ellipsis glyph
		expect(fnBody).toContain("status === 'running' ? '⋯'");
	});

	it("appendToolMessage creates tool pill with icon from getToolIcon", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("getToolIcon(tool)");
	});

	it("updateToolResult transitions status from running to success/error", () => {
		const fnStart = appJs.indexOf("function updateToolResult(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("target.classList.remove('running')");
		expect(fnBody).toContain(
			"target.classList.add(success ? 'success' : 'error')",
		);
	});

	it("updateToolResult populates tool-pill-output with content", () => {
		const fnStart = appJs.indexOf("function updateToolResult(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("querySelector('.tool-pill-output')");
		expect(fnBody).toContain("outputEl.textContent = output");
	});

	it("server transformMessage generates tool_use with summary", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnEnd = claudeJs.indexOf("\n  return null;\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);
		expect(fnBody).toMatch(/type:\s*["']tool_use["']/);
		expect(fnBody).toContain(
			"summary: getToolSummary(toolUse.name, toolUse.input)",
		);
	});

	it("server transformMessage generates tool_result with truncated output", () => {
		const fnStart = claudeJs.indexOf("function transformMessage(");
		const fnEnd = claudeJs.indexOf("\n  return null;\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);
		expect(fnBody).toMatch(/type:\s*["']tool_result["']/);
		expect(fnBody).toContain("truncateOutput");
	});
});

// ===========================================================================
// 3. Auto-Scroll FAB Integration with Message Flow
// ===========================================================================
describe("Auto-scroll FAB integration with message reception", () => {
	it("scrollToBottom checks isAtBottom before scrolling", () => {
		const fnStart = appJs.indexOf("function scrollToBottom(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("session.isAtBottom !== false");
	});

	it("scrollToBottom increments unreadCount and updates FAB when not at bottom", () => {
		const fnStart = appJs.indexOf("function scrollToBottom(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("session.unreadCount++");
		expect(fnBody).toContain("updateScrollFAB(session)");
	});

	it("appendToolMessage calls scrollToBottom", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("scrollToBottom(session)");
	});

	it("updateStreamingMessage calls scrollToBottom for new text", () => {
		// Text messages go through updateStreamingMessage which calls scrollToBottom
		const fnStart = appJs.indexOf("function updateStreamingMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("scrollToBottom(session)");
	});

	it("scroll container listener sets isAtBottom based on scroll position", () => {
		const fnStart = appJs.indexOf("function createSessionContainer(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("scrollHeight");
		expect(fnBody).toContain("scrollTop");
		expect(fnBody).toContain("clientHeight");
		expect(fnBody).toContain("session.isAtBottom = atBottom");
	});

	it("scroll container uses threshold of 100px for bottom detection", () => {
		const fnStart = appJs.indexOf("function createSessionContainer(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("const threshold = 100");
	});
});

// ===========================================================================
// 4. Notification Integration with Message Types
// ===========================================================================
describe("Notification integration with message types", () => {
	it('claude-done handler calls sendNotification with "Claude finished"', () => {
		const caseStart = appJs.indexOf("case 'claude-done':");
		const caseEnd = appJs.indexOf("break;", caseStart);
		const caseBody = appJs.slice(caseStart, caseEnd);
		expect(caseBody).toContain("sendNotification(");
		expect(caseBody).toContain("'Claude finished'");
	});

	it('error handler calls sendNotification with "Error"', () => {
		const caseStart = appJs.indexOf("case 'error':");
		const caseEnd = appJs.indexOf("break;", caseStart);
		const caseBody = appJs.slice(caseStart, caseEnd);
		expect(caseBody).toContain("sendNotification('Error'");
	});

	it("sendNotification creates Notification with correct options", () => {
		const fnStart = appJs.indexOf("function sendNotification(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("new Notification(title");
		expect(fnBody).toContain("tag: 'cleon-ui'");
		expect(fnBody).toContain("notif.onclick");
		expect(fnBody).toContain("window.focus()");
	});

	it("no notification fires when tab is active (document.hidden is false)", () => {
		const fnStart = appJs.indexOf("function sendNotification(");
		const earlyReturn = appJs.slice(fnStart, fnStart + 200);
		expect(earlyReturn).toContain("!document.hidden");
		expect(earlyReturn).toContain("return");
	});
});

// ===========================================================================
// 5. Session State Persistence for Context Bar
// ===========================================================================
describe("Session state persistence for context bar", () => {
	it("saveSessionState includes model in persisted data", () => {
		const fnStart = appJs.indexOf("function saveSessionState(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("model: s.model");
		expect(fnBody).toContain("lastTokenUsage: s.lastTokenUsage");
		expect(fnBody).toContain("lastContextWindow: s.lastContextWindow");
	});

	it("saves to localStorage with correct key", () => {
		const fnStart = appJs.indexOf("function saveSessionState(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("localStorage.setItem('cleon-sessions'");
	});

	it("switchToSession calls updateTokenUsage to restore context bar", () => {
		const fnStart = appJs.indexOf("function switchToSession(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain(
			"updateTokenUsage(newSession.lastTokenUsage, newSession.lastContextWindow, newSession)",
		);
	});
});

// ===========================================================================
// 6. WebSocket Protocol Audit - No Mismatches
// ===========================================================================
describe("WebSocket protocol audit", () => {
	it("server sends token-usage type that client handles", () => {
		expect(claudeJs).toMatch(/type:\s*["']token-usage["']/);
		expect(appJs).toContain("case 'token-usage':");
	});

	it("server sends claude-message type that client handles", () => {
		expect(claudeJs).toMatch(/type:\s*["']claude-message["']/);
		expect(appJs).toContain("case 'claude-message':");
	});

	it("server sends claude-done type that client handles", () => {
		expect(claudeJs).toMatch(/type:\s*["']claude-done["']/);
		expect(appJs).toContain("case 'claude-done':");
	});

	it("server sends error type that client handles", () => {
		expect(claudeJs).toMatch(/type:\s*["']error["']/);
		expect(appJs).toContain("case 'error':");
	});

	it("server sends session-created type that client handles", () => {
		expect(claudeJs).toMatch(/type:\s*["']session-created["']/);
		expect(appJs).toContain("case 'session-created':");
	});

	it("token-usage message includes used, contextWindow, model fields", () => {
		// Server side: extractTokenUsage returns { used, contextWindow, model }
		// And it's spread into the message
		const fnStart = claudeJs.indexOf("function extractTokenUsage(");
		const fnEnd = claudeJs.indexOf("\n}", fnStart);
		const fnBody = claudeJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("used");
		expect(fnBody).toContain("contextWindow");
		expect(fnBody).toContain("model");

		// Client side uses all three
		const caseStart = appJs.indexOf("case 'token-usage':");
		const caseEnd = appJs.indexOf("break;", caseStart);
		const caseBody = appJs.slice(caseStart, caseEnd);
		expect(caseBody).toContain("msg.model");
		expect(caseBody).toContain("updateTokenUsage(msg, session)");
	});

	it("tool_use and tool_result message types are handled by client", () => {
		// Server sends tool_use and tool_result as data.type inside claude-message
		expect(claudeJs).toMatch(/type:\s*["']tool_use["']/);
		expect(claudeJs).toMatch(/type:\s*["']tool_result["']/);

		// Client handles them in handleClaudeMessage
		const fnStart = appJs.indexOf("function handleClaudeMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("data.type === 'tool_use'");
		expect(fnBody).toContain("data.type === 'tool_result'");
	});
});
