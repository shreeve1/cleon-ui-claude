/**
 * Unit tests for mobile UX enhancements in public/app.js
 *
 * Tests formatMarkdown, getToolIcon, truncateToolSummary, updateTokenUsage
 * color logic, auto-scroll FAB, code-copy buttons, long-press copy menu,
 * push notifications, context bar, and collapsible tool pills.
 *
 * Uses static analysis of source code + isolated logic simulation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const frontendJs = [
	"../../public/app.js",
	"../../public/js/state.js",
	"../../public/js/sessions.js",
	"../../public/js/messages.js",
	"../../public/js/markdown.js",
	"../../public/js/streaming.js",
	"../../public/js/notifications.js",
	"../../public/js/input.js",
	"../../public/js/ws-sse.js",
]
	.map((path) => readFileSync(resolve(import.meta.dirname, path), "utf-8"))
	.join("\n");
const appJs = `${frontendJs}\n${frontendJs.replaceAll('"', "'")}`;

const cssPath = resolve(import.meta.dirname, "../../public/style.css");
const css = readFileSync(cssPath, "utf-8");

const htmlPath = resolve(import.meta.dirname, "../../public/index.html");
const html = readFileSync(htmlPath, "utf-8");

// ---------------------------------------------------------------------------
// Re-implementations of functions for logic testing
// ---------------------------------------------------------------------------

function escapeHtml(str) {
	if (typeof str !== "string") return String(str);
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function formatMarkdown(text) {
	if (!text) return "";

	let html = escapeHtml(text);

	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
		const displayLang = lang || "code";
		return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${displayLang}</span><button class="code-copy-btn" aria-label="Copy code">Copy</button></div><pre><code class="${lang}">${code}</code></pre></div>`;
	});

	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	html = html.replace(/\n/g, "<br>");

	return html;
}

function getToolIcon(tool) {
	const icons = {
		Bash: "$",
		Read: "R",
		Write: "W",
		Edit: "E",
		Glob: "G",
		Grep: "?",
		Task: "T",
	};
	return icons[tool] || "*";
}

function truncateToolSummary(summary, maxLen) {
	if (!summary) return "";
	if (summary.length <= maxLen) return summary;
	return summary.slice(0, maxLen) + "...";
}

/**
 * Simulates the updateTokenUsage color threshold logic.
 * Returns the color class and fill color that would be applied.
 */
function getTokenUsageColors(pct) {
	let textColor, fillColor;
	if (pct > 95) {
		textColor = "var(--error)";
		fillColor = "var(--neon-red)";
	} else if (pct > 80) {
		textColor = "var(--warning)";
		fillColor = "var(--neon-orange)";
	} else {
		textColor = ""; // default
		fillColor = "var(--neon-cyan)";
	}
	return { textColor, fillColor };
}

/**
 * Simulates the updateScrollFAB logic for showing/hiding.
 */
function shouldShowFAB(session, isActiveSession) {
	if (!session || !isActiveSession) return { visible: false };
	if (session.isAtBottom || session.unreadCount === 0) {
		return { visible: false };
	}
	return {
		visible: true,
		showBadge: session.unreadCount > 0,
		badgeText: String(session.unreadCount),
	};
}

// ===========================================================================
// 1. Static Analysis - HTML structure
// ===========================================================================
describe("Static Analysis - HTML structure", () => {
	it("contains the scroll-to-bottom FAB button", () => {
		expect(html).toContain('id="scroll-to-bottom-btn"');
	});

	it("contains the unread badge", () => {
		expect(html).toContain('id="unread-badge"');
	});

	it("contains the context bar with model, fill, and text elements", () => {
		expect(html).toContain('id="context-bar"');
		expect(html).toContain('id="context-model"');
		expect(html).toContain('id="context-usage-fill"');
		expect(html).toContain('id="context-usage-text"');
	});

	it("contains the message context menu with copy-text and copy-code actions", () => {
		expect(html).toContain('id="message-context-menu"');
		expect(html).toContain('data-action="copy-text"');
		expect(html).toContain('data-action="copy-code"');
	});

	it("context bar starts hidden", () => {
		expect(html).toContain('id="context-bar" class="hidden"');
	});
});

// ===========================================================================
// 2. Static Analysis - app.js structure for all 6 features
// ===========================================================================
describe("Static Analysis - Smart Auto-Scroll FAB", () => {
	it("createSession initializes isAtBottom: true", () => {
		const fnStart = appJs.indexOf("function createSession(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("isAtBottom: true");
	});

	it("createSession initializes unreadCount: 0", () => {
		const fnStart = appJs.indexOf("function createSession(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("unreadCount: 0");
	});

	it("scroll event listener on container updates isAtBottom", () => {
		expect(appJs).toContain("session.isAtBottom = atBottom");
	});

	it("scroll event resets unreadCount when at bottom", () => {
		const scrollHandler = appJs.indexOf("session.isAtBottom = atBottom");
		const block = appJs.slice(scrollHandler, scrollHandler + 200);
		expect(block).toContain("session.unreadCount = 0");
	});

	it("updateScrollFAB function exists and checks isAtBottom", () => {
		expect(appJs).toContain("function updateScrollFAB(");
		const fnStart = appJs.indexOf("function updateScrollFAB(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("session.isAtBottom");
		expect(fnBody).toContain("session.unreadCount");
	});

	it("scrollToBottom increments unreadCount when not at bottom", () => {
		const fnStart = appJs.indexOf("function scrollToBottom(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("session.unreadCount++");
	});

	it("scroll-to-bottom button click resets state and scrolls", () => {
		expect(appJs).toContain("scrollToBottomBtn.addEventListener('click'");
		const handlerStart = appJs.indexOf(
			"scrollToBottomBtn.addEventListener('click'",
		);
		const handlerBlock = appJs.slice(handlerStart, handlerStart + 300);
		expect(handlerBlock).toContain("session.unreadCount = 0");
		expect(handlerBlock).toContain("session.isAtBottom = true");
		expect(handlerBlock).toContain("behavior: 'smooth'");
	});

	it("switchToSession calls updateScrollFAB for the new session", () => {
		const fnStart = appJs.indexOf("function switchToSession(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("updateScrollFAB(newSession)");
	});
});

describe("Static Analysis - Code Block Copy Buttons", () => {
	it("formatMarkdown wraps fenced code blocks in .code-block-wrapper", () => {
		expect(appJs).toContain('class="code-block-wrapper"');
	});

	it("formatMarkdown adds .code-copy-btn button", () => {
		expect(appJs).toContain('class="code-copy-btn"');
	});

	it("formatMarkdown includes language label in .code-lang span", () => {
		expect(appJs).toContain('class="code-lang"');
	});

	it('click delegation for .code-copy-btn copies code and shows "Copied!" feedback', () => {
		const handlerStart = appJs.indexOf(
			"const copyBtn = e.target.closest('.code-copy-btn')",
		);
		const handlerBlock = appJs.slice(handlerStart, handlerStart + 400);
		expect(handlerBlock).toContain("navigator.clipboard.writeText");
		expect(handlerBlock).toContain("'Copied!'");
		expect(handlerBlock).toContain("'Copy'");
		expect(handlerBlock).toContain("setTimeout");
	});
});

describe("Static Analysis - Long-Press Copy Menu", () => {
	it("touchstart listener on session containers with 500ms timer", () => {
		expect(appJs).toContain(
			`Dom.sessionContainersEl.addEventListener("touchstart",`,
		);
		const handlerStart = appJs.indexOf(
			`Dom.sessionContainersEl.addEventListener("touchstart",`,
		);
		const handlerBlock = appJs.slice(handlerStart, handlerStart + 300);
		expect(handlerBlock).toContain("setTimeout");
		expect(handlerBlock).toContain("500");
	});

	it("touchend clears long press timer", () => {
		expect(appJs).toContain(
			`Dom.sessionContainersEl.addEventListener("touchend",`,
		);
		const handlerStart = appJs.indexOf(
			`Dom.sessionContainersEl.addEventListener("touchend",`,
		);
		const handlerBlock = appJs.slice(handlerStart, handlerStart + 150);
		expect(handlerBlock).toContain("clearTimeout(longPressTimer)");
	});

	it("touchmove cancels long press", () => {
		expect(appJs).toContain(
			`Dom.sessionContainersEl.addEventListener("touchmove",`,
		);
		const handlerStart = appJs.indexOf(
			`Dom.sessionContainersEl.addEventListener("touchmove",`,
		);
		const handlerBlock = appJs.slice(handlerStart, handlerStart + 150);
		expect(handlerBlock).toContain("clearTimeout(longPressTimer)");
	});

	it("contextmenu listener on session containers for desktop right-click", () => {
		expect(appJs).toContain(
			`Dom.sessionContainersEl.addEventListener("contextmenu",`,
		);
		const handlerStart = appJs.indexOf(
			`Dom.sessionContainersEl.addEventListener("contextmenu",`,
		);
		const handlerBlock = appJs.slice(handlerStart, handlerStart + 200);
		expect(handlerBlock).toContain("e.preventDefault()");
		expect(handlerBlock).toContain("showContextMenu");
	});

	it('showContextMenu conditionally shows "Copy Code" based on pre code presence', () => {
		const fnStart = appJs.indexOf("function showContextMenu(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain('querySelector("pre code")');
		expect(fnBody).toContain('data-action="copy-code"');
	});

	it("click outside dismisses context menu", () => {
		expect(appJs).toContain("document.addEventListener('click'");
		const clickDismiss = appJs.indexOf("document.addEventListener('click'");
		const block = appJs.slice(clickDismiss, clickDismiss + 300);
		expect(block).toContain("hideContextMenu()");
	});

	it("touchstart outside context menu dismisses it", () => {
		// There's a document-level touchstart that checks contains
		expect(appJs).toContain("contextMenuEl?.contains(e.target)");
	});

	it("context menu click handler copies text or code", () => {
		expect(appJs).toContain("action === 'copy-text'");
		expect(appJs).toContain("action === 'copy-code'");
		expect(appJs).toContain("navigator.clipboard.writeText");
	});
});

describe("Static Analysis - Push Notifications", () => {
	it("requests notification permission during main startup", () => {
		const fnStart = appJs.indexOf("function updateNotificationPermission(");
		const block = appJs.slice(fnStart, fnStart + 500);
		expect(block).toContain("Notification.requestPermission");
	});

	it("checks for default permission before requesting", () => {
		expect(appJs).toContain("Notification.permission === 'default'");
	});

	it("sets notificationsEnabled based on permission result", () => {
		expect(appJs).toContain("state.notificationsEnabled = perm === 'granted'");
	});

	it("sendNotification checks notificationsEnabled and document.hidden", () => {
		const fnStart = appJs.indexOf("function sendNotification(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("state.notificationsEnabled");
		expect(fnBody).toContain("document.hidden");
	});

	it("sendNotification returns early when tab is active (not hidden)", () => {
		const fnStart = appJs.indexOf("function sendNotification(");
		const fnBody = appJs.slice(fnStart, fnStart + 100);
		expect(fnBody).toContain("!state.notificationsEnabled || !document.hidden");
	});

	it("fires notification on claude-done", () => {
		expect(appJs).toContain("Claude finished");
	});

	it("fires notification on error", () => {
		expect(appJs).toContain("sendNotification('Error'");
	});
});

describe("Static Analysis - Persistent Context Bar", () => {
	it("updateTokenUsage updates context bar elements", () => {
		const fnStart = appJs.indexOf("function updateTokenUsage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("contextBar.classList");
		expect(fnBody).toContain("contextModel.textContent");
		expect(fnBody).toContain("contextUsageFill.style.width");
		expect(fnBody).toContain("contextUsageText.textContent");
	});

	it("context bar hidden when no data", () => {
		expect(appJs).toContain("contextBar.classList.add('hidden')");
	});

	it("token-usage handler sets session.model", () => {
		expect(appJs).toContain(
			"if (msg.model && session) session.model = msg.model",
		);
	});

	it("saveSessionState persists model to localStorage", () => {
		const fnStart = appJs.indexOf("function saveSessionState(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("model: s.model");
	});

	it("color thresholds at 80% and 95% in updateTokenUsage", () => {
		const fnStart = appJs.indexOf("function updateTokenUsage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("pct > 95");
		expect(fnBody).toContain("pct > 80");
	});
});

describe("Static Analysis - Collapsible Tool Pills", () => {
	it("appendToolMessage creates .message.tool-pill with header, icon, name, summary, status, toggle", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("message tool-pill");
		expect(fnBody).toContain("tool-pill-header");
		expect(fnBody).toContain("tool-pill-icon");
		expect(fnBody).toContain("tool-pill-name");
		expect(fnBody).toContain("tool-pill-summary");
		expect(fnBody).toContain("tool-pill-status");
		expect(fnBody).toContain("tool-pill-chevron");
	});

	it("tool pill output element exists and empty output is hidden by CSS", () => {
		const fnStart = appJs.indexOf("function appendToolMessage(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("tool-pill-output");
		expect(css).toContain(".tool-pill-output:empty");
	});

	it("tool pill click delegation toggles output visibility", () => {
		const delegationStart = appJs.indexOf(
			"const header = e.target.closest('.tool-pill-header')",
		);
		const block = appJs.slice(delegationStart, delegationStart + 500);
		expect(block).toContain("output.classList.add('hidden')");
		expect(block).toContain("output.classList.remove('hidden')");
	});

	it("updateToolResult updates status colors", () => {
		const fnStart = appJs.indexOf("function updateToolResult(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);
		expect(fnBody).toContain("target.classList.remove('running')");
		expect(fnBody).toContain("success ? 'success' : 'error'");
	});
});

// ===========================================================================
// 3. Static Analysis - CSS styling verification
// ===========================================================================
describe("Static Analysis - CSS styling", () => {
	it("tool-pill-status.running uses --neon-cyan color", () => {
		const statusRunning = css.indexOf(".tool-pill-status.running");
		const block = css.slice(statusRunning, statusRunning + 100);
		expect(block).toContain("--neon-cyan");
	});

	it("tool-pill-status.success uses --neon-green color", () => {
		const statusSuccess = css.indexOf(".tool-pill-status.success");
		const block = css.slice(statusSuccess, statusSuccess + 100);
		expect(block).toContain("--neon-green");
	});

	it("tool-pill-status.error uses --neon-red color", () => {
		const statusError = css.indexOf(".tool-pill-status.error");
		const block = css.slice(statusError, statusError + 100);
		expect(block).toContain("--neon-red");
	});

	it("defines code-block-wrapper styles", () => {
		expect(css).toContain(".code-block-wrapper");
	});

	it("defines code-copy-btn styles", () => {
		expect(css).toContain(".code-copy-btn");
	});

	it("defines context-bar styles", () => {
		expect(css).toContain("#context-bar");
	});

	it("defines context-usage-fill styles", () => {
		expect(css).toContain("#context-usage-fill");
	});

	it("defines scroll-to-bottom-btn styles", () => {
		expect(css).toContain("#scroll-to-bottom-btn");
	});

	it("defines unread-badge styles", () => {
		expect(css).toContain("#unread-badge");
	});

	it("defines message-context-menu styles", () => {
		expect(css).toContain("#message-context-menu");
	});

	it("defines tool-pill styles", () => {
		expect(css).toContain(".tool-pill");
		expect(css).toContain(".tool-pill-header");
		expect(css).toContain(".tool-pill-output");
	});
});

// ===========================================================================
// 4. formatMarkdown - Logic Tests
// ===========================================================================
describe("formatMarkdown", () => {
	it("returns empty string for falsy input", () => {
		expect(formatMarkdown("")).toBe("");
		expect(formatMarkdown(null)).toBe("");
		expect(formatMarkdown(undefined)).toBe("");
	});

	it("wraps fenced code blocks in .code-block-wrapper", () => {
		const input = 'Hello\n```js\nconsole.log("hi")\n```\nWorld';
		const result = formatMarkdown(input);
		expect(result).toContain('class="code-block-wrapper"');
	});

	it("adds copy button to code blocks", () => {
		const input = '```python\nprint("hello")\n```';
		const result = formatMarkdown(input);
		expect(result).toContain('class="code-copy-btn"');
		expect(result).toContain("Copy</button>");
	});

	it("shows language label for code blocks", () => {
		const input = "```javascript\nconst x = 1;\n```";
		const result = formatMarkdown(input);
		expect(result).toContain('class="code-lang"');
		expect(result).toContain("javascript");
	});

	it('defaults language label to "code" when no language specified', () => {
		const input = "```\nsome code\n```";
		const result = formatMarkdown(input);
		expect(result).toContain(">code<");
	});

	it("preserves code content inside <code> tags", () => {
		const input = "```js\nconst x = 42;\n```";
		const result = formatMarkdown(input);
		expect(result).toContain("const x = 42;");
	});

	it("handles multiple code blocks", () => {
		const input = "```js\ncode1\n```\ntext\n```py\ncode2\n```";
		const result = formatMarkdown(input);
		const wrapperCount = (result.match(/code-block-wrapper/g) || []).length;
		expect(wrapperCount).toBe(2);
	});

	it("formats inline code with <code> tags", () => {
		const result = formatMarkdown("Use `npm install` command");
		expect(result).toContain("<code>npm install</code>");
	});

	it("formats bold text", () => {
		const result = formatMarkdown("This is **bold** text");
		expect(result).toContain("<strong>bold</strong>");
	});

	it("formats italic text", () => {
		const result = formatMarkdown("This is *italic* text");
		expect(result).toContain("<em>italic</em>");
	});

	it("converts newlines to <br> tags", () => {
		const result = formatMarkdown("line1\nline2");
		expect(result).toContain("<br>");
	});

	it("escapes HTML entities in text", () => {
		const result = formatMarkdown('<script>alert("xss")</script>');
		expect(result).not.toContain("<script>");
		expect(result).toContain("&lt;script&gt;");
	});
});

// ===========================================================================
// 5. getToolIcon - Logic Tests
// ===========================================================================
describe("getToolIcon", () => {
	it("returns $ for Bash", () => {
		expect(getToolIcon("Bash")).toBe("$");
	});

	it("returns R for Read", () => {
		expect(getToolIcon("Read")).toBe("R");
	});

	it("returns W for Write", () => {
		expect(getToolIcon("Write")).toBe("W");
	});

	it("returns E for Edit", () => {
		expect(getToolIcon("Edit")).toBe("E");
	});

	it("returns G for Glob", () => {
		expect(getToolIcon("Glob")).toBe("G");
	});

	it("returns ? for Grep", () => {
		expect(getToolIcon("Grep")).toBe("?");
	});

	it("returns T for Task", () => {
		expect(getToolIcon("Task")).toBe("T");
	});

	it("returns * for unknown tools", () => {
		expect(getToolIcon("CustomTool")).toBe("*");
		expect(getToolIcon("NotATool")).toBe("*");
	});
});

// ===========================================================================
// 6. truncateToolSummary - Logic Tests
// ===========================================================================
describe("truncateToolSummary", () => {
	it("returns empty string for falsy input", () => {
		expect(truncateToolSummary("", 50)).toBe("");
		expect(truncateToolSummary(null, 50)).toBe("");
		expect(truncateToolSummary(undefined, 50)).toBe("");
	});

	it("returns short summary unchanged", () => {
		expect(truncateToolSummary("short text", 50)).toBe("short text");
	});

	it("returns exact-length summary unchanged", () => {
		const str = "a".repeat(50);
		expect(truncateToolSummary(str, 50)).toBe(str);
	});

	it("truncates long summary with ellipsis", () => {
		const str = "a".repeat(60);
		expect(truncateToolSummary(str, 50)).toBe("a".repeat(50) + "...");
	});
});

// ===========================================================================
// 7. updateTokenUsage color threshold logic
// ===========================================================================
describe("updateTokenUsage color thresholds", () => {
	it("uses cyan/default for usage < 80%", () => {
		const colors = getTokenUsageColors(50);
		expect(colors.textColor).toBe("");
		expect(colors.fillColor).toBe("var(--neon-cyan)");
	});

	it("uses cyan/default for usage exactly 80%", () => {
		const colors = getTokenUsageColors(80);
		expect(colors.textColor).toBe("");
		expect(colors.fillColor).toBe("var(--neon-cyan)");
	});

	it("uses orange/warning for usage 81%", () => {
		const colors = getTokenUsageColors(81);
		expect(colors.textColor).toBe("var(--warning)");
		expect(colors.fillColor).toBe("var(--neon-orange)");
	});

	it("uses orange/warning for usage 95%", () => {
		const colors = getTokenUsageColors(95);
		expect(colors.textColor).toBe("var(--warning)");
		expect(colors.fillColor).toBe("var(--neon-orange)");
	});

	it("uses red/error for usage 96%", () => {
		const colors = getTokenUsageColors(96);
		expect(colors.textColor).toBe("var(--error)");
		expect(colors.fillColor).toBe("var(--neon-red)");
	});

	it("uses red/error for usage 100%", () => {
		const colors = getTokenUsageColors(100);
		expect(colors.textColor).toBe("var(--error)");
		expect(colors.fillColor).toBe("var(--neon-red)");
	});

	it("uses cyan/default for 0%", () => {
		const colors = getTokenUsageColors(0);
		expect(colors.textColor).toBe("");
		expect(colors.fillColor).toBe("var(--neon-cyan)");
	});
});

// ===========================================================================
// 8. Auto-scroll FAB visibility logic
// ===========================================================================
describe("Auto-scroll FAB visibility logic", () => {
	it("FAB hidden when session is at bottom", () => {
		const result = shouldShowFAB({ isAtBottom: true, unreadCount: 5 }, true);
		expect(result.visible).toBe(false);
	});

	it("FAB hidden when unreadCount is 0", () => {
		const result = shouldShowFAB({ isAtBottom: false, unreadCount: 0 }, true);
		expect(result.visible).toBe(false);
	});

	it("FAB visible when scrolled up with unread messages", () => {
		const result = shouldShowFAB({ isAtBottom: false, unreadCount: 3 }, true);
		expect(result.visible).toBe(true);
		expect(result.showBadge).toBe(true);
		expect(result.badgeText).toBe("3");
	});

	it("FAB hidden when session is null", () => {
		const result = shouldShowFAB(null, true);
		expect(result.visible).toBe(false);
	});

	it("FAB hidden when not the active session", () => {
		const result = shouldShowFAB({ isAtBottom: false, unreadCount: 5 }, false);
		expect(result.visible).toBe(false);
	});
});

// ===========================================================================
// 9. No stale references check
// ===========================================================================
describe("No stale .message.tool references (without -pill suffix)", () => {
	it("app.js has no stale .message.tool[^-] references", () => {
		// The regex from the validation: \.message\.tool[^-]
		// This should NOT match anything in current code
		const matches = appJs.match(/\.message\.tool[^-_]/g);
		// Filter out legitimate uses like .message.tool-pill
		const staleMatches = matches?.filter((m) => !m.includes("tool-pill")) || [];
		expect(staleMatches).toEqual([]);
	});

	it("style.css has no stale .message.tool[^-] references", () => {
		const matches = css.match(/\.message\.tool[^-_]/g);
		const staleMatches = matches?.filter((m) => !m.includes("tool-pill")) || [];
		expect(staleMatches).toEqual([]);
	});
});
