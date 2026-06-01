import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	createPendingPromise,
	TOOL_RESPONSE_TIMEOUT_MS,
} from "../../server/claude.js";

// Explicit timeout for tests that exercise the timer-firing path. The module
// default (TOOL_RESPONSE_TIMEOUT_MS) is 0 / disabled unless the env var is set.
const TEST_TIMEOUT = 5 * 60 * 1000;

describe("createPendingPromise", () => {
	let callbacksMap;
	let controller;

	beforeEach(() => {
		callbacksMap = new Map();
		controller = new AbortController();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves when the callback is invoked before timeout", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);

		// Simulate user responding
		const entry = callbacksMap.get("tool-1");
		entry.resolve({ answer: "yes" });

		const result = await promise;
		expect(result).toEqual({ answer: "yes" });

		// Map entry cleaned up
		expect(callbacksMap.has("tool-1")).toBe(false);
	});

	it("clears the timeout timer when resolved", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);

		// Resolve before timeout
		callbacksMap.get("tool-1").resolve("done");

		// Advance past the timeout — should NOT reject
		vi.advanceTimersByTime(TEST_TIMEOUT + 1);

		await expect(promise).resolves.toBe("done");
	});

	it("rejects with timeout message after the timeout", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);

		vi.advanceTimersByTime(TEST_TIMEOUT);

		await expect(promise).rejects.toThrow("User did not respond in time");

		// Map entry cleaned up on timeout
		expect(callbacksMap.has("tool-1")).toBe(false);
	});

	it("never times out when timeout is disabled (0)", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			0,
		);

		// Advance way past any plausible timeout — must stay pending
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);

		// Still answerable: resolving works after a long wait
		callbacksMap.get("tool-1").resolve("late answer");
		await expect(promise).resolves.toBe("late answer");
	});

	it("defaults to the module timeout setting (disabled)", () => {
		expect(TOOL_RESPONSE_TIMEOUT_MS).toBe(0);
	});

	it("rejects with cancel message on abort signal", async () => {
		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Question cancelled",
			TEST_TIMEOUT,
		);

		controller.abort();

		await expect(promise).rejects.toThrow("Question cancelled");

		// Map entry cleaned up on abort
		expect(callbacksMap.has("tool-1")).toBe(false);
	});

	it("clears the timeout timer when aborted", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);

		controller.abort();

		// Advance past the timeout — the timer should already be cleared
		vi.advanceTimersByTime(TEST_TIMEOUT + 1);

		await expect(promise).rejects.toThrow("Cancelled");
	});

	it("clears the timeout timer when rejected via callback", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);

		// Reject via callback (e.g. session ended)
		callbacksMap.get("tool-1").reject(new Error("Session ended"));

		// Advance past timeout — timer should be cleared
		vi.advanceTimersByTime(TEST_TIMEOUT + 1);

		await expect(promise).rejects.toThrow("Session ended");
	});

	it("isolates independent promises by key", async () => {
		vi.useFakeTimers();

		const promise1 = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);
		const promise2 = createPendingPromise(
			callbacksMap,
			"tool-2",
			controller.signal,
			"Cancelled",
			TEST_TIMEOUT,
		);

		// Resolve only tool-1
		callbacksMap.get("tool-1").resolve("first");

		// tool-2 still pending, then times out
		vi.advanceTimersByTime(TEST_TIMEOUT);

		await expect(promise1).resolves.toBe("first");
		await expect(promise2).rejects.toThrow("User did not respond in time");

		expect(callbacksMap.size).toBe(0);
	});
});
