/**
 * Static code analysis tests for SSE Event Bus architecture
 * Verifies code structure without requiring runtime imports of heavy dependencies
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const claudeJs = readFileSync(resolve("server/claude/index.js"), "utf8");
const indexJs = readFileSync(resolve("server/index.js"), "utf8");
const frontendJs = ["public/app.js", "public/js/ws-sse.js"]
	.map((path) => readFileSync(resolve(path), "utf8"))
	.join("\n");
const appJs = `${frontendJs.replaceAll('"', "'")}\n${frontendJs}`;

// ─── server/claude.js code analysis ──────────────────────────────
describe("server/claude.js - code structure", () => {
	describe("eventDelivery.deliver usage", () => {
		it("should use eventDelivery.deliver() for all message delivery", () => {
			const expectedTypes = [
				"claude-message",
				"token-usage",
				"claude-done",
				"error",
				"session-created",
			];

			for (const type of expectedTypes) {
				const pattern = new RegExp(
					`eventDelivery\\.deliver\\([^)]*,\\s*\\{[^}]*type:\\s*"${type}"`,
				);
				expect(claudeJs).toMatch(pattern);
			}
		});

		it("should have eventDelivery.deliver calls for claude-message in processQueryStream", () => {
			// Find the processQueryStream function
			const fnStart = claudeJs.indexOf("async function processQueryStream(");
			const fnEnd = claudeJs.indexOf("\n}", fnStart + 100);
			const fnBody = claudeJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("eventDelivery.deliver");
		});
	});

	describe("sessionInfo declaration order", () => {
		it("should declare sessionInfo BEFORE the options object", () => {
			const sessionInfoIndex = claudeJs.indexOf("const sessionInfo = {");
			const optionsIndex = claudeJs.indexOf("const options = {");

			expect(sessionInfoIndex).toBeGreaterThan(-1);
			expect(optionsIndex).toBeGreaterThan(-1);
			expect(sessionInfoIndex).toBeLessThan(optionsIndex);
		});

		it("sessionInfo should be initialized with queryInstance: null, ws, and username", () => {
			expect(claudeJs).toMatch(
				/const sessionInfo = \{\s*queryInstance:\s*null,\s*ws,\s*username/,
			);
		});
	});

	describe("resubscribeSession export", () => {
		it("should export resubscribeSession function", () => {
			expect(claudeJs).toMatch(/export function resubscribeSession\(/);
		});

		it("resubscribeSession should get sessionInfo from activeSessions and replace ws", () => {
			expect(claudeJs).toMatch(/activeSessions\.get\(sessionId\)/);
			expect(claudeJs).toMatch(/sessionInfo\.ws = newWs/);
		});
	});

	describe("processQueryStream signature", () => {
		it("should still accept _ws as a parameter (unused)", () => {
			expect(claudeJs).toMatch(
				/async function processQueryStream\(\s*queryInstance,\s*_ws,\s*sessionInfo,\s*onSessionId,\s*\)/,
			);
		});
	});

	describe("canUseTool uses eventDelivery.deliver", () => {
		it("should use eventDelivery.deliver() inside canUseTool callback", () => {
			const canUseToolStart = claudeJs.indexOf("canUseTool:");
			const canUseToolEnd = claudeJs.indexOf(
				"// Allow all other tools",
				canUseToolStart,
			);
			const canUseToolSection = claudeJs.slice(canUseToolStart, canUseToolEnd);

			expect(canUseToolSection).toContain("eventDelivery.deliver(username,");
		});
	});

	describe("bus and registry integration", () => {
		it("should import publish from bus.js (for ephemeral session-status events)", () => {
			expect(claudeJs).toMatch(
				/import\s*\{[^}]*publish[^}]*\}\s*from\s*['".]\.\.\/bus\.js['".]/,
			);
		});

		it("should import register and setStatus from session-registry.js", () => {
			expect(claudeJs).toMatch(
				/import\s*\{[^}]*register[^}]*setStatus[^}]*\}\s*from\s*['".]\.\.\/session-registry\.js['".]/,
			);
		});

		it("handleChat should accept username parameter", () => {
			expect(claudeJs).toMatch(
				/export async function handleChat\(msg,\s*ws,\s*username\)/,
			);
		});

		it("should use publish() for ephemeral session-status events", () => {
			// session-status events are ephemeral and use publish
			expect(claudeJs).toMatch(
				/publish\(username,\s*\{\s*type:\s*"session-status"/,
			);
		});

		it("should use eventDelivery.deliver() for replayable events", () => {
			// All main events (claude-message, token-usage, claude-done, error, session-created) use eventDelivery
			expect(claudeJs).toMatch(/eventDelivery\.deliver\(username,/);
		});
	});
});

// ─── server/index.js code analysis ───────────────────────────────
describe("server/index.js - code structure", () => {
	describe("imports", () => {
		it("should import handleChat, handleAbort, handleQuestionResponse, handlePlanResponse from claude.js", () => {
			expect(indexJs).toMatch(
				/import\s*\{[^}]*handleChat[^}]*handleAbort[^}]*handleQuestionResponse[^}]*handlePlanResponse[^}]*\}\s*from\s*['".]\.\/claude\.js['".]/,
			);
		});

		it("should NOT import isSessionActive or resubscribeSession from claude.js", () => {
			const claudeImport = indexJs.match(
				/import\s*\{[^}]*\}\s*from\s*['".]\.\/claude\.js['".]/,
			);
			expect(claudeImport).toBeTruthy();
			expect(claudeImport[0]).not.toContain("isSessionActive");
			expect(claudeImport[0]).not.toContain("resubscribeSession");
		});

		it("should import subscribe and publish from bus.js", () => {
			expect(indexJs).toMatch(
				/import\s*\{[^}]*subscribe[^}]*publish[^}]*\}\s*from\s*['".]\.\/bus\.js['".]/,
			);
		});

		it("should import getSessionsForUser from session-registry.js", () => {
			expect(indexJs).toMatch(
				/import\s*\{[^}]*getSessionsForUser[^}]*\}\s*from\s*['".]\.\/session-registry\.js['".]/,
			);
		});

		it("should import eventDelivery from event-delivery.js", () => {
			expect(indexJs).toMatch(
				/import\s*\{[^}]*eventDelivery[^}]*\}\s*from\s*['".]\.\/event-delivery\.js['".]/,
			);
		});
	});

	describe("SSE endpoint", () => {
		it("should have GET /api/events endpoint", () => {
			expect(indexJs).toContain('app.get("/api/events"');
		});

		it("should send state-snapshot on SSE connect", () => {
			const sseStart = indexJs.indexOf('app.get("/api/events"');
			const sseEnd = indexJs.indexOf("\n});", sseStart);
			const sseBody = indexJs.slice(sseStart, sseEnd);

			expect(sseBody).toContain('type: "state-snapshot"');
			expect(sseBody).toContain("getSessionsForUser");
		});

		it("should subscribe to bus for event delivery", () => {
			const sseStart = indexJs.indexOf('app.get("/api/events"');
			const sseEnd = indexJs.indexOf("\n});", sseStart);
			const sseBody = indexJs.slice(sseStart, sseEnd);

			expect(sseBody).toContain("subscribe(user.username");
		});
	});

	describe("WS handler uses publish for responses", () => {
		it("should NOT have check-active or subscribe cases", () => {
			expect(indexJs).not.toMatch(/case\s*'check-active'/);
			expect(indexJs).not.toMatch(/case\s*'subscribe'/);
		});

		it("abort uses publish(user.username, ...)", () => {
			const abortStart = indexJs.indexOf('case "abort"');
			const abortEnd = indexJs.indexOf("break;", abortStart);
			const abortBody = indexJs.slice(abortStart, abortEnd);

			expect(abortBody).toContain("publish(user.username");
		});

		it("question-response uses publish(user.username, ...)", () => {
			const qrStart = indexJs.indexOf('case "question-response"');
			const qrEnd = indexJs.indexOf("break;", qrStart);
			const qrBody = indexJs.slice(qrStart, qrEnd);

			expect(qrBody).toContain("publish(user.username");
		});

		it("plan-response uses publish(user.username, ...)", () => {
			const prStart = indexJs.indexOf('case "plan-response"');
			const prEnd = indexJs.indexOf("break;", prStart);
			const prBody = indexJs.slice(prStart, prEnd);

			expect(prBody).toContain("publish(user.username");
		});
	});
});

// ─── public/app.js code analysis ─────────────────────────────────
describe("public/app.js - code structure", () => {
	describe("SSE client connection", () => {
		it("should define connectEventStream function", () => {
			expect(appJs).toMatch(/function connectEventStream\(\)/);
		});

		it("should define handleServerEvent function", () => {
			expect(appJs).toMatch(/function handleServerEvent\(event\)/);
		});

		it("connectEventStream should use EventSource API", () => {
			const fnStart = appJs.indexOf("function connectEventStream()");
			const fnEnd = appJs.indexOf("\n}", fnStart + 200);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("new EventSource(");
			expect(fnBody).toContain("/api/events");
		});
	});

	describe("handleServerEvent handles SSE event types", () => {
		it("should handle heartbeat events", () => {
			const fnStart = appJs.indexOf("function handleServerEvent(event)");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("event.type === 'heartbeat'");
		});

		it("should handle state-snapshot events", () => {
			const fnStart = appJs.indexOf("function handleServerEvent(event)");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("event.type === 'state-snapshot'");
		});

		it("should handle session-status events", () => {
			const fnStart = appJs.indexOf("function handleServerEvent(event)");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("event.type === 'session-status'");
		});

		it("should delegate non-SSE events to handleWsMessage", () => {
			const fnStart = appJs.indexOf("function handleServerEvent(event)");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("handleWsMessage(event)");
		});
	});

	describe("old WS subscription patterns removed", () => {
		it("should NOT have sessionsRestored in state", () => {
			expect(appJs).not.toMatch(/sessionsRestored:\s*false/);
		});

		it("should NOT define checkAndReconnectActiveSessions", () => {
			expect(appJs).not.toContain("function checkAndReconnectActiveSessions");
		});

		it("should NOT have session-active case in handleWsMessage", () => {
			expect(appJs).not.toMatch(/case\s*'session-active'/);
		});

		it("should NOT have subscribe-result case in handleWsMessage", () => {
			expect(appJs).not.toMatch(/case\s*'subscribe-result'/);
		});
	});

	describe("showMain connects both WS and SSE", () => {
		it("showMain should call connectWebSocket", () => {
			const fnStart = appJs.indexOf("function showMain()");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("connectWebSocket()");
		});

		it("showMain should call connectEventStream", () => {
			const fnStart = appJs.indexOf("function showMain()");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).toContain("connectEventStream()");
		});
	});

	describe("WS is command-only", () => {
		it("connectWebSocket should not set onmessage handler", () => {
			const fnStart = appJs.indexOf("function connectWebSocket()");
			const fnEnd = appJs.indexOf("\n}", fnStart);
			const fnBody = appJs.slice(fnStart, fnEnd);

			expect(fnBody).not.toContain("onmessage");
		});
	});
});
