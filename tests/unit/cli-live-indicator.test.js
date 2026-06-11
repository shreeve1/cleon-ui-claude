import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const messagesJs = readFileSync(resolve("public/js/messages.js"), "utf8");
const wsSseJs = readFileSync(resolve("public/js/ws-sse.js"), "utf8");

function getFunctionBody(source, name) {
	const start = source.indexOf(`function ${name}(`);
	expect(start).toBeGreaterThan(-1);
	const next = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, next > -1 ? next : undefined);
}

describe("CLI live indicator", () => {
	it("renderActivityStatus falls back to isStreaming when activityState is absent", () => {
		const body = getFunctionBody(messagesJs, "renderActivityStatus");

		expect(body).toContain("session.isStreaming");
		expect(body).toContain("CLI session live");
		expect(body).toContain("activity-indicator thinking");
	});

	it("rich activityState remains the primary render path", () => {
		const body = getFunctionBody(messagesJs, "renderActivityStatus");
		const fallbackIndex = body.indexOf("session.isStreaming");
		const richIndex = body.indexOf(
			"const { state, label, description, elapsed }",
		);

		expect(fallbackIndex).toBeGreaterThan(-1);
		expect(richIndex).toBeGreaterThan(fallbackIndex);
	});

	it("state-snapshot handler renders activity status after updating controls", () => {
		const start = wsSseJs.indexOf('event.type === "state-snapshot"');
		const end = wsSseJs.indexOf('event.type === "session-status"', start);
		const block = wsSseJs.slice(start, end);

		expect(block).toContain("activeSession.isStreaming");
		expect(block).toContain("localSession.activityState = null");
		expect(block).toContain("renderActivityStatus(activeSession)");
	});

	it("session-status handler renders activity status after status changes", () => {
		const start = wsSseJs.indexOf('event.type === "session-status"');
		const end = wsSseJs.indexOf("handleWsMessage(event)", start);
		const block = wsSseJs.slice(start, end);

		expect(block).toContain(
			'session.isStreaming = event.status === "streaming"',
		);
		expect(block).toContain("session.activityState = null");
		expect(block).toContain("renderActivityStatus(session)");
	});
});
