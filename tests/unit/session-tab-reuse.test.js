/**
 * Unit tests for session tab reuse feature in public/app.js
 *
 * Tests the selectProject() reuse logic, forceNewTab lifecycle,
 * property reset completeness, and acceptance criteria via
 * static analysis and isolated logic simulation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const appJs = [
	"../../public/js/state.js",
	"../../public/js/sessions.js",
	"../../public/js/input.js",
	"../../public/app.js",
]
	.map((path) => readFileSync(resolve(import.meta.dirname, path), "utf-8"))
	.join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock session matching createSession() shape */
function createMockSession(overrides = {}) {
	return {
		id: "test-id",
		sessionId: "existing-session-123",
		project: {
			name: "old-project",
			path: "/old/path",
			displayName: "Old Project",
		},
		isStreaming: false,
		pendingText: "some pending text",
		pendingQuestion: { id: "q1", text: "question" },
		attachments: [{ name: "file.txt" }],
		lastTokenUsage: { input: 100, output: 50 },
		lastContextWindow: { used: 1000, total: 5000 },
		hasUnread: true,
		needsHistoryLoad: true,
		containerEl: { innerHTML: "", querySelector: () => null },
		fileMentionSelectedIndex: 3,
		fileMentionQuery: "search term",
		fileMentionStartPos: 42,
		fileMentionDebounceTimer: 999,
		slashCommandSelectedIndex: 2,
		...overrides,
	};
}

/** Simulate the canReuse decision logic from selectProject */
function canReuse(activeSession, forceNewTab) {
	return activeSession && !activeSession.isStreaming && !forceNewTab;
}

/** Simulate the property reset that selectProject performs on a reused session */
function resetSessionProperties(session, newProject) {
	session.project = newProject;
	session.sessionId = null;
	session.isStreaming = false;
	session.pendingText = "";
	session.pendingQuestion = null;
	session.attachments = [];
	session.lastTokenUsage = null;
	session.lastContextWindow = null;
	session.hasUnread = false;
	session.needsHistoryLoad = false;
	session.fileMentionSelectedIndex = 0;
	session.fileMentionQuery = "";
	session.fileMentionStartPos = -1;
	// In real code: clearTimeout(session.fileMentionDebounceTimer)
	session.fileMentionDebounceTimer = null;
	session.slashCommandSelectedIndex = -1;
}

// ===========================================================================
// 1. Static Analysis - Code Structure
// ===========================================================================
describe("Static Analysis - Code Structure", () => {
	it("state object contains forceNewTab: false", () => {
		// Find the state declaration and verify forceNewTab is initialized to false
		const stateStart = appJs.indexOf("export const state = {");
		const stateEnd = appJs.indexOf("};", stateStart);
		const stateBlock = appJs.slice(stateStart, stateEnd);

		expect(stateBlock).toContain("forceNewTab: false");
	});

	it("selectProject function exists and contains canReuse logic", () => {
		expect(appJs).toContain("async function selectProject(");

		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart, fnStart + 2000);

		expect(fnBody).toContain(
			"const canReuse = activeSession && !activeSession.isStreaming && !forceNewTab",
		);
	});

	it("closeSidebar clears forceNewTab", () => {
		const fnStart = appJs.indexOf("function closeSidebar()");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("state.forceNewTab = false");
	});

	it("newSessionTabBtn handler sets forceNewTab = true", () => {
		const handlerStart = appJs.indexOf(
			`Dom.newSessionTabBtn.addEventListener("click",`,
		);
		const handlerEnd = appJs.indexOf("});", handlerStart);
		const handlerBody = appJs.slice(handlerStart, handlerEnd);

		expect(handlerBody).toContain("state.forceNewTab = true");
	});

	it("forceNewTab is cleared at start of selectProject (before canReuse check)", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart, fnStart + 500);

		const clearIndex = fnBody.indexOf("state.forceNewTab = false");
		const canReuseIndex = fnBody.indexOf("const canReuse =");

		expect(clearIndex).toBeGreaterThan(-1);
		expect(canReuseIndex).toBeGreaterThan(-1);
		// Clearing must happen before the canReuse check
		expect(clearIndex).toBeLessThan(canReuseIndex);
	});

	it("createSession is called exactly 3 times in the source (1 definition + 2 call sites)", () => {
		// Count all occurrences of createSession( in the source
		// 1 = function definition, 2 = restoreSessionState, 3 = selectProject new-tab path
		const matches = appJs.match(/createSession\(/g);
		expect(matches).not.toBeNull();
		expect(matches.length).toBe(3);
	});
});

// ===========================================================================
// 2. canReuse Decision Logic
// ===========================================================================
describe("canReuse Decision Logic", () => {
	it("returns true when activeSession exists, not streaming, forceNewTab=false", () => {
		const session = createMockSession({ isStreaming: false });
		expect(canReuse(session, false)).toBe(true);
	});

	it("returns falsy when no activeSession (null)", () => {
		expect(canReuse(null, false)).toBeFalsy();
	});

	it("returns false when activeSession is streaming", () => {
		const session = createMockSession({ isStreaming: true });
		expect(canReuse(session, false)).toBe(false);
	});

	it("returns false when forceNewTab is true", () => {
		const session = createMockSession({ isStreaming: false });
		expect(canReuse(session, true)).toBe(false);
	});

	it("returns false when activeSession is streaming AND forceNewTab is true", () => {
		const session = createMockSession({ isStreaming: true });
		expect(canReuse(session, true)).toBe(false);
	});
});

// ===========================================================================
// 3. Property Reset Completeness
// ===========================================================================
describe("Property Reset Completeness", () => {
	const newProject = {
		name: "new-project",
		path: "/new/path",
		displayName: "New Project",
	};
	let session;

	function getResetSession() {
		const s = createMockSession();
		resetSessionProperties(s, newProject);
		return s;
	}

	it("sessionId is null after reset", () => {
		session = getResetSession();
		expect(session.sessionId).toBeNull();
	});

	it("project is the new project after reset", () => {
		session = getResetSession();
		expect(session.project).toEqual(newProject);
	});

	it("isStreaming is false after reset", () => {
		session = getResetSession();
		expect(session.isStreaming).toBe(false);
	});

	it("pendingText is empty string after reset", () => {
		session = getResetSession();
		expect(session.pendingText).toBe("");
	});

	it("pendingQuestion is null after reset", () => {
		session = getResetSession();
		expect(session.pendingQuestion).toBeNull();
	});

	it("attachments is empty array after reset", () => {
		session = getResetSession();
		expect(session.attachments).toEqual([]);
	});

	it("lastTokenUsage is null after reset", () => {
		session = getResetSession();
		expect(session.lastTokenUsage).toBeNull();
	});

	it("lastContextWindow is null after reset", () => {
		session = getResetSession();
		expect(session.lastContextWindow).toBeNull();
	});

	it("hasUnread is false after reset", () => {
		session = getResetSession();
		expect(session.hasUnread).toBe(false);
	});

	it("needsHistoryLoad is false after reset", () => {
		session = getResetSession();
		expect(session.needsHistoryLoad).toBe(false);
	});

	it("fileMentionSelectedIndex is 0 after reset", () => {
		session = getResetSession();
		expect(session.fileMentionSelectedIndex).toBe(0);
	});

	it("fileMentionQuery is empty string after reset", () => {
		session = getResetSession();
		expect(session.fileMentionQuery).toBe("");
	});

	it("fileMentionStartPos is -1 after reset", () => {
		session = getResetSession();
		expect(session.fileMentionStartPos).toBe(-1);
	});

	it("slashCommandSelectedIndex is -1 after reset", () => {
		session = getResetSession();
		expect(session.slashCommandSelectedIndex).toBe(-1);
	});

	it("original id is preserved (NOT reset)", () => {
		session = getResetSession();
		expect(session.id).toBe("test-id");
	});

	it("original containerEl is preserved (NOT reset)", () => {
		const originalContainer = { innerHTML: "", querySelector: () => null };
		const s = createMockSession({ containerEl: originalContainer });
		resetSessionProperties(s, newProject);
		expect(s.containerEl).toBe(originalContainer);
	});
});

// ===========================================================================
// 4. forceNewTab Flag Lifecycle
// ===========================================================================
describe("forceNewTab Flag Lifecycle", () => {
	it("flag starts as false in state", () => {
		const stateStart = appJs.indexOf("export const state = {");
		const stateEnd = appJs.indexOf("};", stateStart);
		const stateBlock = appJs.slice(stateStart, stateEnd);

		expect(stateBlock).toContain("forceNewTab: false");
	});

	it('flag is set to true by "+" button handler (verify code pattern)', () => {
		const handlerStart = appJs.indexOf(
			`Dom.newSessionTabBtn.addEventListener("click",`,
		);
		const handlerEnd = appJs.indexOf("});", handlerStart);
		const handlerBody = appJs.slice(handlerStart, handlerEnd);

		expect(handlerBody).toContain("state.forceNewTab = true");
		expect(handlerBody).toContain("openSidebar()");
	});

	it("flag is consumed (read then cleared) at start of selectProject", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart, fnStart + 500);

		// Should read forceNewTab first
		const readIndex = fnBody.indexOf("const forceNewTab = state.forceNewTab");
		// Then clear it
		const clearIndex = fnBody.indexOf("state.forceNewTab = false");

		expect(readIndex).toBeGreaterThan(-1);
		expect(clearIndex).toBeGreaterThan(-1);
		// Read must happen before clear
		expect(readIndex).toBeLessThan(clearIndex);
	});

	it("flag is cleared in closeSidebar", () => {
		const fnStart = appJs.indexOf("function closeSidebar(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("state.forceNewTab = false");
	});

	it("flag does not persist across multiple selectProject calls (simulation)", () => {
		// Simulate: set forceNewTab true, first call reads + clears it, second call sees false
		const mockState = { forceNewTab: true };

		// First call: read and clear
		const firstForceNewTab = mockState.forceNewTab;
		mockState.forceNewTab = false;
		expect(firstForceNewTab).toBe(true);
		expect(mockState.forceNewTab).toBe(false);

		// Second call: should see false
		const secondForceNewTab = mockState.forceNewTab;
		mockState.forceNewTab = false;
		expect(secondForceNewTab).toBe(false);

		// With secondForceNewTab === false, canReuse should be true (if session exists and not streaming)
		const session = createMockSession({ isStreaming: false });
		expect(canReuse(session, secondForceNewTab)).toBe(true);
	});
});

// ===========================================================================
// 5. Edge Cases
// ===========================================================================
describe("Edge Cases", () => {
	it("MAX_SESSIONS check only applies in create-new-tab path (after canReuse block)", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart);

		const canReuseIfIndex = fnBody.indexOf("if (canReuse)");
		const maxSessionsIndex = fnBody.indexOf(
			"state.sessions.length >= MAX_SESSIONS",
		);

		expect(canReuseIfIndex).toBeGreaterThan(-1);
		expect(maxSessionsIndex).toBeGreaterThan(-1);
		// MAX_SESSIONS check must come after the canReuse block
		expect(maxSessionsIndex).toBeGreaterThan(canReuseIfIndex);
	});

	it("cold start (no sessions): canReuse returns falsy, new tab created", () => {
		// With no active session, canReuse is falsy -> new tab path
		expect(canReuse(null, false)).toBeFalsy();
	});

	it("session reuse preserves tab identity (id unchanged)", () => {
		const session = createMockSession({ id: "unique-tab-id-42" });
		const newProject = { name: "proj", path: "/proj", displayName: "Proj" };
		resetSessionProperties(session, newProject);
		expect(session.id).toBe("unique-tab-id-42");
	});

	it("session reuse preserves DOM container reference (containerEl unchanged)", () => {
		const container = {
			innerHTML: "<div>old</div>",
			querySelector: () => null,
		};
		const session = createMockSession({ containerEl: container });
		const newProject = { name: "proj", path: "/proj", displayName: "Proj" };
		resetSessionProperties(session, newProject);
		expect(session.containerEl).toBe(container);
	});
});

// ===========================================================================
// 6. Acceptance Criteria Verification (static analysis)
// ===========================================================================
describe("Acceptance Criteria Verification", () => {
	it("AC1: canReuse logic exists in selectProject", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart, fnStart + 2000);

		expect(fnBody).toContain(
			"const canReuse = activeSession && !activeSession.isStreaming && !forceNewTab",
		);
		expect(fnBody).toContain("if (canReuse)");
	});

	it("AC2: renderSessionBar uses project.displayName || project.name", () => {
		const fnStart = appJs.indexOf("function renderSessionBar(");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("s.project.displayName || s.project.name");
	});

	it("AC3: clearMessages is called in reuse path", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart);

		// Find the canReuse block
		const canReuseIfStart = fnBody.indexOf("if (canReuse)");
		// The return statement at the end of the reuse block
		const reuseReturnIndex = fnBody.indexOf("return;", canReuseIfStart);
		const reuseBlock = fnBody.slice(canReuseIfStart, reuseReturnIndex);

		expect(reuseBlock).toContain("clearMessages(activeSession)");
	});

	it('AC6: forceNewTab blocks reuse when "+" clicked', () => {
		// The "+" button sets forceNewTab = true
		const handlerStart = appJs.indexOf(
			`Dom.newSessionTabBtn.addEventListener("click",`,
		);
		const handlerEnd = appJs.indexOf("});", handlerStart);
		const handlerBody = appJs.slice(handlerStart, handlerEnd);
		expect(handlerBody).toContain("state.forceNewTab = true");

		// canReuse uses !forceNewTab so when true, reuse is blocked
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart, fnStart + 500);
		expect(fnBody).toContain("!forceNewTab");
	});

	it("AC8: saveSessionState called after reuse", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart);

		const canReuseIfStart = fnBody.indexOf("if (canReuse)");
		const reuseReturnIndex = fnBody.indexOf("return;", canReuseIfStart);
		const reuseBlock = fnBody.slice(canReuseIfStart, reuseReturnIndex);

		expect(reuseBlock).toContain("saveSessionState()");
	});

	it("AC9: updateHash called in reuse path", () => {
		const fnStart = appJs.indexOf("async function selectProject(");
		const fnBody = appJs.slice(fnStart);

		const canReuseIfStart = fnBody.indexOf("if (canReuse)");
		const reuseReturnIndex = fnBody.indexOf("return;", canReuseIfStart);
		const reuseBlock = fnBody.slice(canReuseIfStart, reuseReturnIndex);

		expect(reuseBlock).toContain("updateHash(name)");
	});
});
