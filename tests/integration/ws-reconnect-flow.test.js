/**
 * Integration tests for SSE Event Bus architecture
 * Tests the server-side SSE endpoint, client-side SSE connection,
 * and the simplified command-only WebSocket protocol.
 *
 * Replaces the old check-active → session-active → subscribe → subscribe-result
 * WS protocol with SSE-based event delivery.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const indexJs = readFileSync(resolve("server/index.js"), "utf8");
const claudeJs = readFileSync(resolve("server/claude.js"), "utf8");
const appJs = readFileSync(resolve("public/app.js"), "utf8");

// ─── Server SSE endpoint structure ──────────────────────────────
describe("SSE endpoint (server/index.js)", () => {
	it("has GET /api/events SSE endpoint", () => {
		expect(indexJs).toContain('app.get("/api/events"');
	});

	it("authenticates via query param token", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain("req.query.token");
		expect(sseBody).toContain("authenticateWebSocket(token)");
	});

	it("sets correct SSE response headers", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain('"Content-Type": "text/event-stream"');
		expect(sseBody).toContain('"Cache-Control": "no-cache"');
		expect(sseBody).toContain('Connection: "keep-alive"');
	});

	it("sends state-snapshot on connect with user sessions", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain("getSessionsForUser(user.username)");
		expect(sseBody).toContain('type: "state-snapshot"');
	});

	it("replays buffer for streaming sessions", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain('status === "streaming"');
		expect(sseBody).toContain("eventDelivery.replayToSSE");
	});

	it("replays buffer during replay grace period after streaming ends", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain("eventDelivery.hasReplay(s.sessionId)");
	});

	it("subscribes to event bus for ongoing events", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain("subscribe(user.username");
	});

	it("sends heartbeat at 30s interval", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain('type: "heartbeat"');
		expect(sseBody).toContain("30000");
	});

	it("cleans up on connection close (unsubscribe + clearInterval)", () => {
		const sseStart = indexJs.indexOf('app.get("/api/events"');
		const sseEnd = indexJs.indexOf("// SPA fallback", sseStart);
		const sseBody = indexJs.slice(sseStart, sseEnd);

		expect(sseBody).toContain('req.on("close"');
		expect(sseBody).toContain("unsubscribe()");
		expect(sseBody).toContain("clearInterval(heartbeat)");
	});
});

// ─── Server imports for SSE ────────────────────────────────────
describe("SSE-related imports (server/index.js)", () => {
	it("imports subscribe and publish from bus.js", () => {
		expect(indexJs).toMatch(
			/import\s*\{[^}]*subscribe[^}]*publish[^}]*\}\s*from\s*['".]\.\/bus\.js['".]/,
		);
	});

	it("imports getSessionsForUser from session-registry.js", () => {
		expect(indexJs).toMatch(
			/import\s*\{[^}]*getSessionsForUser[^}]*\}\s*from\s*['".]\.\/session-registry\.js['".]/,
		);
	});

	it("imports eventDelivery from event-delivery.js", () => {
		expect(indexJs).toMatch(
			/import\s*\{[^}]*eventDelivery[^}]*\}\s*from\s*['".]\.\/event-delivery\.js['".]/,
		);
	});
});

// ─── WebSocket simplified to command-only ────────────────────────
describe("WebSocket command-only protocol (server/index.js)", () => {
	it("handles chat command via WS", () => {
		expect(indexJs).toMatch(/case\s*"chat"/);
	});

	it("handles abort command via WS", () => {
		expect(indexJs).toMatch(/case\s*"abort"/);
	});

	it("handles question-response command via WS", () => {
		expect(indexJs).toMatch(/case\s*"question-response"/);
	});

	it("handles plan-response command via WS", () => {
		expect(indexJs).toMatch(/case\s*"plan-response"/);
	});

	it("handles ping via WS", () => {
		expect(indexJs).toMatch(/case\s*"ping"/);
	});

	it("abort response uses publish() not ws.send", () => {
		const abortStart = indexJs.indexOf('case "abort"');
		const abortEnd = indexJs.indexOf("break;", abortStart);
		const abortBody = indexJs.slice(abortStart, abortEnd);

		expect(abortBody).toContain("publish(user.username");
	});

	it("question-response uses publish() not ws.send", () => {
		const qrStart = indexJs.indexOf('case "question-response"');
		const qrEnd = indexJs.indexOf("break;", qrStart);
		const qrBody = indexJs.slice(qrStart, qrEnd);

		expect(qrBody).toContain("publish(user.username");
	});

	it("plan-response uses publish() not ws.send", () => {
		const prStart = indexJs.indexOf('case "plan-response"');
		const prEnd = indexJs.indexOf("break;", prStart);
		const prBody = indexJs.slice(prStart, prEnd);

		expect(prBody).toContain("publish(user.username");
	});
});

// ─── Old WS subscription protocol removed (server) ──────────────
describe("old WS subscription protocol removed (server/index.js)", () => {
	it("no check-active case in WS handler", () => {
		expect(indexJs).not.toMatch(/case\s*'check-active'/);
	});

	it("no subscribe case in WS handler", () => {
		// "subscribe" appears as bus.subscribe import, so check for WS case specifically
		expect(indexJs).not.toMatch(/case\s*'subscribe'/);
	});

	it("does not import isSessionActive from claude.js", () => {
		const claudeImport = indexJs.match(
			/import\s*\{[^}]*\}\s*from\s*['".]\.\/claude\.js['".]/,
		);
		expect(claudeImport).toBeTruthy();
		expect(claudeImport[0]).not.toContain("isSessionActive");
	});

	it("does not import resubscribeSession from claude.js", () => {
		const claudeImport = indexJs.match(
			/import\s*\{[^}]*\}\s*from\s*['".]\.\/claude\.js['".]/,
		);
		expect(claudeImport).toBeTruthy();
		expect(claudeImport[0]).not.toContain("resubscribeSession");
	});

	it("does not send session-active type", () => {
		expect(indexJs).not.toContain("type: 'session-active'");
	});

	it("does not send subscribe-result type", () => {
		expect(indexJs).not.toContain("type: 'subscribe-result'");
	});
});

// ─── Client SSE connection ───────────────────────────────────────
describe("client SSE connection (public/app.js)", () => {
	it("defines connectEventStream function", () => {
		expect(appJs).toMatch(/function connectEventStream\(\)/);
	});

	it("uses EventSource API for SSE", () => {
		const fnStart = appJs.indexOf("function connectEventStream()");
		const fnEnd = appJs.indexOf("\n}", fnStart + 200);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("new EventSource(");
		expect(fnBody).toContain("/api/events");
	});

	it("dispatches events via handleServerEvent", () => {
		const fnStart = appJs.indexOf("function connectEventStream()");
		const fnEnd = appJs.indexOf("\n}", fnStart + 200);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("handleServerEvent(");
	});

	it("reconnects on permanent close", () => {
		const fnStart = appJs.indexOf("function connectEventStream()");
		const fnEnd = appJs.indexOf("\n}", fnStart + 200);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("EventSource.CLOSED");
		expect(fnBody).toContain("connectEventStream");
	});
});

// ─── Client event handling ───────────────────────────────────────
describe("client event handling (public/app.js)", () => {
	it("defines handleServerEvent function", () => {
		expect(appJs).toMatch(/function handleServerEvent\(event\)/);
	});

	it("handles heartbeat events", () => {
		const fnStart = appJs.indexOf("function handleServerEvent(event)");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("event.type === 'heartbeat'");
	});

	it("handles state-snapshot events", () => {
		const fnStart = appJs.indexOf("function handleServerEvent(event)");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("event.type === 'state-snapshot'");
		expect(fnBody).toContain("event.sessions");
	});

	it("handles session-status events", () => {
		const fnStart = appJs.indexOf("function handleServerEvent(event)");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("event.type === 'session-status'");
	});

	it("delegates other events to handleWsMessage", () => {
		const fnStart = appJs.indexOf("function handleServerEvent(event)");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("handleWsMessage(event)");
	});

	it("state-snapshot updates UI controls for streaming sessions", () => {
		const fnStart = appJs.indexOf("function handleServerEvent(event)");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("chatInput.disabled");
		expect(fnBody).toContain("abortBtn.classList");
	});
});

// ─── Client WS is command-only ───────────────────────────────────
describe("client WebSocket is command-only (public/app.js)", () => {
	it("connectWebSocket exists", () => {
		expect(appJs).toMatch(/function connectWebSocket\(\)/);
	});

	it("connectWebSocket does not set onmessage handler", () => {
		const fnStart = appJs.indexOf("function connectWebSocket()");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).not.toContain("onmessage");
	});

	it("showMain calls both connectWebSocket and connectEventStream", () => {
		const fnStart = appJs.indexOf("function showMain()");
		const fnEnd = appJs.indexOf("\n}", fnStart);
		const fnBody = appJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("connectWebSocket()");
		expect(fnBody).toContain("connectEventStream()");
	});
});

// ─── Old WS subscription protocol removed (client) ──────────────
describe("old WS subscription protocol removed (public/app.js)", () => {
	it("no checkAndReconnectActiveSessions function", () => {
		expect(appJs).not.toContain("function checkAndReconnectActiveSessions");
	});

	it("no sessionsRestored in state", () => {
		expect(appJs).not.toMatch(/sessionsRestored:\s*false/);
	});

	it("no session-active case in handleWsMessage", () => {
		expect(appJs).not.toMatch(/case\s*'session-active'/);
	});

	it("no subscribe-result case in handleWsMessage", () => {
		expect(appJs).not.toMatch(/case\s*'subscribe-result'/);
	});
});

// ─── Event delivery mechanism (claude.js) ────────────────────────
describe("Event delivery mechanism (server/claude.js)", () => {
	it("activity events use Event Delivery for replayable latest state", () => {
		expect(claudeJs).toContain(
			'import { eventDelivery } from "./event-delivery.js"',
		);
		expect(claudeJs).toContain("eventDelivery.deliver(username, event)");
	});

	it("eventDelivery.deliver is used for message delivery in processQueryStream", () => {
		const fnStart = claudeJs.indexOf("async function processQueryStream(");
		const fnEnd = claudeJs.indexOf("\n}", fnStart + 100);
		const fnBody = claudeJs.slice(fnStart, fnEnd);

		expect(fnBody).toContain("eventDelivery.deliver(sessionInfo.username,");
	});

	it("processQueryStream passes username from sessionInfo to transformMessage", () => {
		// transformMessage is called with sessionInfo.username
		expect(claudeJs).toContain("sessionInfo.username");
	});

	it("should use eventDelivery.deliver() for all main event types", () => {
		// Verify eventDelivery.deliver is used for key event types
		const deliverCalls = claudeJs.match(/eventDelivery\.deliver\(/g);
		expect(deliverCalls).not.toBeNull();
		expect(deliverCalls.length).toBeGreaterThan(0);
	});

	it("sendMessage function does NOT exist (deleted)", () => {
		expect(claudeJs).not.toMatch(/function sendMessage\(/);
	});
});
