import { describe, it, expect } from "vitest";
import {
	buildToolSummary,
	jsonlEntryToHistoryMessages,
	jsonlEntryToLiveEvents,
	sanitizeToolInput,
} from "../../server/shared/session-jsonl.js";

describe("session JSONL projection", () => {
	const SESSION = "session-1";

	it("projects assistant text to watcher-text live event", () => {
		const events = jsonlEntryToLiveEvents(
			{
				sessionId: SESSION,
				type: "assistant",
				message: {
					role: "assistant",
					id: "msg-1",
					model: "claude-test",
					content: [{ type: "text", text: "hello" }],
				},
			},
			SESSION,
		);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "claude-message",
			sessionId: SESSION,
			data: { type: "watcher-text", content: "hello", messageId: "msg-1" },
		});
	});

	it("keeps assistant text and tool_use from the same entry in history", () => {
		const messages = jsonlEntryToHistoryMessages({
			sessionId: SESSION,
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "checking" },
					{
						type: "tool_use",
						name: "Bash",
						id: "tool-1",
						input: { command: "ls" },
					},
				],
			},
		});

		expect(messages.map((msg) => msg.role)).toEqual(["assistant", "tool"]);
		expect(messages[1].id).toBe("tool-1");
		expect(messages[1].summary.summary).toBe("$ ls");
	});

	it("projects user tool_result to live and history shapes", () => {
		const entry = {
			sessionId: SESSION,
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "ok",
						is_error: false,
					},
				],
			},
		};

		expect(jsonlEntryToLiveEvents(entry, SESSION)[0].data).toMatchObject({
			type: "tool_result",
			id: "tool-1",
			success: true,
			output: "ok",
		});
		expect(jsonlEntryToHistoryMessages(entry)[0]).toMatchObject({
			role: "tool_result",
			id: "tool-1",
			success: true,
			output: "ok",
		});
	});

	it("skips AskUserQuestion and ExitPlanMode tool_use blocks", () => {
		const events = jsonlEntryToLiveEvents(
			{
				sessionId: SESSION,
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", name: "AskUserQuestion", id: "q1", input: {} },
						{ type: "tool_use", name: "ExitPlanMode", id: "p1", input: {} },
					],
				},
			},
			SESSION,
		);

		expect(events).toEqual([]);
	});

	it("sanitizes bash commands in summaries and inputs", () => {
		const input = {
			command:
				"curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://example.com SECRET=shh",
		};

		expect(sanitizeToolInput("Bash", input).command).toContain("[REDACTED]");
		expect(buildToolSummary("Bash", input).fullCommand).not.toContain(
			"SECRET=shh",
		);
	});
});
