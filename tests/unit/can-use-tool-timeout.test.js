import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPendingPromise } from "../../server/claude.js";

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
		);

		// Resolve before timeout
		callbacksMap.get("tool-1").resolve("done");

		// Advance past the 5-minute timeout — should NOT reject
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		await expect(promise).resolves.toBe("done");
	});

	it("rejects with timeout message after 5 minutes", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
		);

		vi.advanceTimersByTime(5 * 60 * 1000);

		await expect(promise).rejects.toThrow("User did not respond in time");

		// Map entry cleaned up on timeout
		expect(callbacksMap.has("tool-1")).toBe(false);
	});

	it("rejects with cancel message on abort signal", async () => {
		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Question cancelled",
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
		);

		controller.abort();

		// Advance past the timeout — the timer should already be cleared
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		await expect(promise).rejects.toThrow("Cancelled");
	});

	it("clears the timeout timer when rejected via callback", async () => {
		vi.useFakeTimers();

		const promise = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
		);

		// Reject via callback (e.g. session ended)
		callbacksMap.get("tool-1").reject(new Error("Session ended"));

		// Advance past timeout — timer should be cleared
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		await expect(promise).rejects.toThrow("Session ended");
	});

	it("isolates independent promises by key", async () => {
		vi.useFakeTimers();

		const promise1 = createPendingPromise(
			callbacksMap,
			"tool-1",
			controller.signal,
			"Cancelled",
		);
		const promise2 = createPendingPromise(
			callbacksMap,
			"tool-2",
			controller.signal,
			"Cancelled",
		);

		// Resolve only tool-1
		callbacksMap.get("tool-1").resolve("first");

		// tool-2 still pending, then times out
		vi.advanceTimersByTime(5 * 60 * 1000);

		await expect(promise1).resolves.toBe("first");
		await expect(promise2).rejects.toThrow("User did not respond in time");

		expect(callbacksMap.size).toBe(0);
	});
});
