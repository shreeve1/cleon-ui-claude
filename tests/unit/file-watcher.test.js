import { describe, it, expect, vi, afterEach } from "vitest";

// Use vi.hoisted for variables referenced by vi.mock factories (hoisted to top)
const {
	mockFileHandle,
	mockStat,
	mockOpen,
	mockPublish,
	mockRegister,
	mockSetStatus,
} = vi.hoisted(() => {
	const mockFileHandle = {
		_data: "",
		read: vi.fn((buffer, _offset, _length, position) => {
			const data = mockFileHandle._data.slice(position);
			const bytesWritten = buffer.write(
				data,
				0,
				Math.min(data.length, buffer.length),
				"utf8",
			);
			return { bytesRead: bytesWritten, buffer };
		}),
		close: vi.fn(),
	};

	const mockStat = vi.fn();
	const mockOpen = vi.fn();
	const mockPublish = vi.fn();
	const mockRegister = vi.fn();
	const mockSetStatus = vi.fn();

	return {
		mockFileHandle,
		mockStat,
		mockOpen,
		mockPublish,
		mockRegister,
		mockSetStatus,
	};
});

vi.mock("fs", async () => {
	const actual = await vi.importActual("fs");
	return {
		...actual,
		watch: () => ({ close: vi.fn(), unref: vi.fn() }),
		promises: {
			...actual.promises,
			stat: mockStat,
			open: mockOpen,
			readdir: vi.fn(),
			readFile: vi.fn(),
		},
	};
});

vi.mock("../../server/bus.js", () => ({ publish: mockPublish }));

vi.mock("../../server/session-registry.js", () => ({
	register: mockRegister,
	setStatus: mockSetStatus,
}));

vi.mock("../../server/logger.js", () => ({
	default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
	startWatching,
	stopWatching,
	isWatching,
	getWatchersForUser,
	startGraceTimer,
} from "../../server/file-watcher.js";

afterEach(async () => {
	vi.useRealTimers();
	vi.clearAllMocks();
	mockFileHandle._data = "";
	// Tear down all active watchers
	for (const user of ["testuser", "other"]) {
		for (const w of getWatchersForUser(user)) {
			stopWatching(w.projectName, w.sessionId);
		}
	}
});

describe("file-watcher", () => {
	const PROJECT = "-home-user-project";
	const SESSION = "abc123";
	const USER = "testuser";

	async function startClean() {
		mockStat.mockResolvedValue({ size: 0, isFile: () => true });
		await startWatching(PROJECT, SESSION, USER);
	}

	function setFileContent(content, append = false) {
		if (append) {
			mockFileHandle._data += content;
		} else {
			mockFileHandle._data = content;
		}
		const buf = Buffer.from(mockFileHandle._data, "utf8");
		mockStat.mockResolvedValue({ size: buf.length, isFile: () => true });
		mockOpen.mockResolvedValue(mockFileHandle);
	}

	function makeAssistantEntry(text, toolUses = []) {
		const content = [];
		if (text) content.push({ type: "text", text });
		for (const tu of toolUses) content.push({ type: "tool_use", ...tu });
		return JSON.stringify({
			sessionId: SESSION,
			type: "assistant",
			message: { role: "assistant", content },
			timestamp: new Date().toISOString(),
			messageId: `msg-${Date.now()}`,
		});
	}

	function makeToolResultEntry(toolUseId, output, isError = false) {
		return JSON.stringify({
			sessionId: SESSION,
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						content: output,
						is_error: isError,
					},
				],
			},
			timestamp: new Date().toISOString(),
		});
	}

	function countPublishEvents(predicate) {
		return mockPublish.mock.calls.filter(([, ev]) => predicate(ev)).length;
	}

	it("starts watching and resolves watch path", async () => {
		await startClean();

		expect(isWatching(PROJECT, SESSION)).toBe(true);
	});

	it("deduplicates by (projectName, sessionId, username)", async () => {
		await startClean();

		await startWatching(PROJECT, SESSION, USER);

		// No second watcher created — initial stat called only once
		expect(mockStat).toHaveBeenCalledTimes(1);
	});

	it("deduplicates concurrent starts before the first stat resolves", async () => {
		let resolveStat;
		mockStat.mockReturnValue(
			new Promise((resolve) => {
				resolveStat = () => resolve({ size: 0, isFile: () => true });
			}),
		);

		const first = startWatching(PROJECT, SESSION, USER, "lease-a");
		const second = startWatching(PROJECT, SESSION, USER, "lease-b");
		resolveStat();
		await Promise.all([first, second]);

		expect(mockStat).toHaveBeenCalledTimes(1);
		expect(isWatching(PROJECT, SESSION, USER)).toBe(true);
	});

	it("rejects path traversal watcher identifiers", async () => {
		mockStat.mockResolvedValue({ size: 0, isFile: () => true });

		await startWatching("../secret", SESSION, USER);
		await startWatching(PROJECT, "../secret", USER);
		await startWatching(PROJECT, "agent-background", USER);

		expect(mockStat).not.toHaveBeenCalled();
		expect(isWatching("../secret", SESSION, USER)).toBe(false);
		expect(isWatching(PROJECT, "../secret", USER)).toBe(false);
		expect(isWatching(PROJECT, "agent-background", USER)).toBe(false);
	});

	it("stops watching and cleans up", async () => {
		await startClean();

		stopWatching(PROJECT, SESSION);

		expect(isWatching(PROJECT, SESSION)).toBe(false);
	});

	it("unwatch only releases the caller lease", async () => {
		mockStat.mockResolvedValue({ size: 0, isFile: () => true });
		await startWatching(PROJECT, SESSION, USER, "lease-a");
		await startWatching(PROJECT, SESSION, USER, "lease-b");

		stopWatching(PROJECT, SESSION, USER, "lease-a");

		expect(isWatching(PROJECT, SESSION, USER)).toBe(true);

		stopWatching(PROJECT, SESSION, USER, "lease-b");

		expect(isWatching(PROJECT, SESSION, USER)).toBe(false);
	});

	it("authenticated unwatch cannot stop another user's watcher", async () => {
		mockStat.mockResolvedValue({ size: 0, isFile: () => true });
		await startWatching(PROJECT, SESSION, USER, "lease-a");

		stopWatching(PROJECT, SESSION, "other", "lease-a");

		expect(isWatching(PROJECT, SESSION, USER)).toBe(true);
	});

	it("polls changed files and reads appended content", async () => {
		vi.useFakeTimers();
		await startClean();
		mockStat.mockClear();
		mockOpen.mockClear();

		setFileContent(makeAssistantEntry("Hello world"));

		await vi.advanceTimersByTimeAsync(2100);

		expect(mockStat.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(mockOpen.mock.calls.length).toBe(1);
		expect(mockPublish.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(mockRegister.mock.calls.length).toBe(1);
		expect(mockFileHandle.read.mock.calls.length).toBeGreaterThanOrEqual(1);

		vi.useRealTimers();
	});

	it("registers session and publishes watcher-text on first assistant text", async () => {
		vi.useFakeTimers();
		await startClean();

		setFileContent(makeAssistantEntry("Hello world"));

		// Advance past stat polling interval (STAT_POLL_MS = 2000)
		// advanceTimersByTimeAsync properly flushes microtasks between timer callbacks
		await vi.advanceTimersByTimeAsync(2100);

		expect(mockRegister).toHaveBeenCalledWith(
			SESSION,
			expect.objectContaining({ username: USER, status: "streaming" }),
		);

		// Should have published a claude-message with watcher-text
		expect(mockPublish).toHaveBeenCalledWith(
			USER,
			expect.objectContaining({
				type: "claude-message",
				sessionId: SESSION,
				data: expect.objectContaining({
					type: "watcher-text",
					content: expect.stringContaining("Hello world"),
				}),
			}),
		);

		vi.useRealTimers();
	});

	it("publishes nested Claude JSONL message metadata", async () => {
		vi.useFakeTimers();
		await startClean();

		setFileContent(
			JSON.stringify({
				sessionId: SESSION,
				type: "assistant",
				uuid: "entry-uuid-1",
				message: {
					role: "assistant",
					id: "msg-nested-1",
					model: "claude-sonnet-test",
					content: [{ type: "text", text: "Nested metadata" }],
				},
				timestamp: new Date().toISOString(),
			}),
		);

		await vi.advanceTimersByTimeAsync(2100);

		expect(mockPublish).toHaveBeenCalledWith(
			USER,
			expect.objectContaining({
				type: "claude-message",
				sessionId: SESSION,
				data: expect.objectContaining({
					type: "watcher-text",
					messageId: "msg-nested-1",
					model: "claude-sonnet-test",
				}),
			}),
		);

		vi.useRealTimers();
	});

	it("publishes tool_use events from assistant entries", async () => {
		vi.useFakeTimers();
		await startClean();

		setFileContent(
			makeAssistantEntry("Let me check", [
				{ name: "Bash", id: "tool-bash-1", input: { command: "ls -la" } },
				{ name: "Grep", id: "tool-grep-1", input: { pattern: "test" } },
			]),
		);

		await vi.advanceTimersByTimeAsync(2100);

		const toolEvents = countPublishEvents(
			(ev) => ev.type === "claude-message" && ev.data?.type === "tool_use",
		);
		expect(toolEvents).toBe(2);

		vi.useRealTimers();
	});

	it("sanitizes watcher tool input before publishing", async () => {
		vi.useFakeTimers();
		await startClean();

		setFileContent(
			makeAssistantEntry("", [
				{
					name: "Bash",
					id: "tool-bash-1",
					input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://example.com SECRET=shh" },
				},
			]),
		);

		await vi.advanceTimersByTimeAsync(2100);

		const published = mockPublish.mock.calls.find(
			([, ev]) =>
				ev.type === "claude-message" && ev.data?.type === "tool_use",
		);
		expect(published).toBeDefined();
		expect(published[1].data.input.command).toContain("[REDACTED]");
		expect(published[1].data.input.command).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(published[1].data.summary.fullCommand).not.toContain("SECRET=shh");

		vi.useRealTimers();
	});

	it("publishes tool_result events from user entries with tool_result blocks", async () => {
		vi.useFakeTimers();
		await startClean();

		setFileContent(
			makeToolResultEntry("tool-bash-1", "total 42\n-rw-r--r-- ..."),
		);

		await vi.advanceTimersByTimeAsync(2100);

		const toolResultEvents = countPublishEvents(
			(ev) => ev.type === "claude-message" && ev.data?.type === "tool_result",
		);
		expect(toolResultEvents).toBe(1);

		// Verify the result content passes through
		const published = mockPublish.mock.calls.find(
			([, ev]) =>
				ev.type === "claude-message" && ev.data?.type === "tool_result",
		);
		expect(published).toBeDefined();
		if (published) {
			expect(published[1].data.output).toContain("total 42");
		}

		vi.useRealTimers();
	});

	it("skips user echo entries (no tool_result)", async () => {
		vi.useFakeTimers();
		await startClean();

		const entry = JSON.stringify({
			sessionId: SESSION,
			type: "user",
			message: { role: "user", content: "What is the weather?" },
			timestamp: new Date().toISOString(),
		});
		setFileContent(entry);

		await vi.advanceTimersByTimeAsync(2100);

		const publishedMessages = countPublishEvents(
			(ev) => ev.type === "claude-message",
		);
		expect(publishedMessages).toBe(0);

		vi.useRealTimers();
	});

	it("skips result records", async () => {
		vi.useFakeTimers();
		await startClean();

		const entry = JSON.stringify({
			sessionId: SESSION,
			type: "result",
			modelUsage: {
				"claude-sonnet-4-20250514": { inputTokens: 100, outputTokens: 50 },
			},
			timestamp: new Date().toISOString(),
		});
		setFileContent(entry);

		await vi.advanceTimersByTimeAsync(2100);

		const publishedMessages = countPublishEvents(
			(ev) => ev.type === "claude-message",
		);
		expect(publishedMessages).toBe(0);

		vi.useRealTimers();
	});

	it("idle timeout fires after 30s of no activity", async () => {
		vi.useFakeTimers();
		await startClean();

		// Send first entry to register session
		setFileContent(makeAssistantEntry("First message"));
		await vi.advanceTimersByTimeAsync(2100);

		expect(mockRegister).toHaveBeenCalled();

		// Clear publish calls to focus on idle
		mockPublish.mockClear();
		mockSetStatus.mockClear();

		// Advance past idle threshold without any new writes
		await vi.advanceTimersByTimeAsync(31_000);

		expect(mockSetStatus).toHaveBeenCalledWith(SESSION, "idle");
		expect(mockPublish).toHaveBeenCalledWith(
			USER,
			expect.objectContaining({
				type: "session-status",
				sessionId: SESSION,
				status: "idle",
			}),
		);

		vi.useRealTimers();
	});

	it("session re-marked streaming when new entry arrives after idle", async () => {
		vi.useFakeTimers();
		await startClean();

		// First entry
		setFileContent(makeAssistantEntry("First"));
		await vi.advanceTimersByTimeAsync(2100);
		expect(mockRegister).toHaveBeenCalled();

		// Advance past idle
		mockSetStatus.mockClear();
		await vi.advanceTimersByTimeAsync(31_000);
		expect(mockSetStatus).toHaveBeenCalledWith(SESSION, "idle");

		// Clear so we can detect the streaming re-mark
		mockSetStatus.mockClear();
		mockPublish.mockClear();

		// New entry arrives — append to existing content
		setFileContent(makeAssistantEntry("Second message"), true);
		await vi.advanceTimersByTimeAsync(2100);

		// Should publish claude-message for the new entry
		const msgEvents = countPublishEvents(
			(ev) => ev.type === "claude-message" && ev.data?.type === "watcher-text",
		);
		expect(msgEvents).toBeGreaterThanOrEqual(1);
		// Should re-mark as streaming
		expect(mockSetStatus).toHaveBeenCalledWith(SESSION, "streaming");

		vi.useRealTimers();
	});

	it("getWatchersForUser returns active watchers", async () => {
		await startClean();

		const watchers = getWatchersForUser(USER);
		expect(watchers.length).toBe(1);
		expect(watchers[0]).toEqual({ projectName: PROJECT, sessionId: SESSION });
	});

	it("grace timer starts and cleans up watcher after 60s", async () => {
		vi.useFakeTimers();
		await startClean();

		startGraceTimer(PROJECT, SESSION);
		expect(isWatching(PROJECT, SESSION)).toBe(true);

		vi.advanceTimersByTime(61_000);

		expect(isWatching(PROJECT, SESSION)).toBe(false);

		vi.useRealTimers();
	});

	it("grace timer for one lease preserves another live lease", async () => {
		vi.useFakeTimers();
		mockStat.mockResolvedValue({ size: 0, isFile: () => true });
		await startWatching(PROJECT, SESSION, USER, "lease-a");
		await startWatching(PROJECT, SESSION, USER, "lease-b");

		startGraceTimer(PROJECT, SESSION, USER, "lease-a");
		vi.advanceTimersByTime(61_000);

		expect(isWatching(PROJECT, SESSION, USER)).toBe(true);

		stopWatching(PROJECT, SESSION, USER, "lease-b");
		expect(isWatching(PROJECT, SESSION, USER)).toBe(false);

		vi.useRealTimers();
	});

	it("grace timer cancels on re-watch", async () => {
		vi.useFakeTimers();
		await startClean();

		startGraceTimer(PROJECT, SESSION);

		await startWatching(PROJECT, SESSION, USER);

		vi.advanceTimersByTime(61_000);

		expect(isWatching(PROJECT, SESSION)).toBe(true);

		vi.useRealTimers();
	});

	it("handles file deletion during stat poll", async () => {
		vi.useFakeTimers();
		await startClean();
		mockPublish.mockClear();

		// File gone — stat throws ENOENT
		mockStat.mockRejectedValue({ code: "ENOENT" });

		await vi.advanceTimersByTimeAsync(2100);

		expect(isWatching(PROJECT, SESSION)).toBe(false);
		vi.useRealTimers();
	});

	it("respects publish-only — no eventDelivery import in source", async () => {
		const { readFileSync } = await import("fs");
		const sourceText = readFileSync(
			new URL("../../server/file-watcher.js", import.meta.url),
			"utf8",
		);
		// The import is: import { publish } from "./bus.js";
		const hasBusImport = sourceText.includes('from "./bus.js"');
		const hasEventDeliveryImport = sourceText.includes("event-delivery");
		expect(hasBusImport).toBe(true);
		expect(hasEventDeliveryImport).toBe(false);
	});
});
