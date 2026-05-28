/**
 * Task Manager for tracking Claude tool executions
 * Manages in-memory task state per session with event delivery
 */

import { publish } from "./bus.js";
import { eventDelivery } from "./event-delivery.js";

// Track tasks per session: sessionId -> Map(taskId -> task)
const sessionTasks = new Map();
let taskIdCounter = 1;

/**
 * Generate a unique task ID
 */
function generateTaskId() {
	return `task-${taskIdCounter++}`;
}

/**
 * Start tracking a new task
 * @param {string} sessionId - Session identifier
 * @param {object} taskData - Task data { title, progress, metadata }
 * @returns {object} Task object with taskId
 */
export function trackTaskStart(sessionId, taskData) {
	if (!sessionTasks.has(sessionId)) {
		sessionTasks.set(sessionId, new Map());
	}

	const taskId = generateTaskId();
	const task = {
		taskId,
		status: "in_progress",
		startTime: new Date().toISOString(),
		...taskData,
	};

	sessionTasks.get(sessionId).set(taskId, task);
	return task;
}

/**
 * Complete a task
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - Task identifier
 * @param {object} resultData - Result data { output, duration }
 * @returns {object|null} Updated task or null if not found
 */
export function trackTaskComplete(sessionId, taskId, resultData) {
	const tasks = sessionTasks.get(sessionId);
	if (!tasks) return null;

	const task = tasks.get(taskId);
	if (!task) return null;

	task.status = "completed";
	task.endTime = new Date().toISOString();
	Object.assign(task, resultData);

	return task;
}

/**
 * Fail a task
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - Task identifier
 * @param {string} error - Error message
 * @returns {object|null} Updated task or null if not found
 */
export function trackTaskFailed(sessionId, taskId, error) {
	const tasks = sessionTasks.get(sessionId);
	if (!tasks) return null;

	const task = tasks.get(taskId);
	if (!task) return null;

	task.status = "failed";
	task.endTime = new Date().toISOString();
	task.error = error;

	return task;
}

/**
 * Get a specific task
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - Task identifier
 * @returns {object|null} Task or null if not found
 */
export function getTask(sessionId, taskId) {
	const tasks = sessionTasks.get(sessionId);
	if (!tasks) return null;
	return tasks.get(taskId) || null;
}

/**
 * Clear all tasks for a session
 * @param {string} sessionId - Session identifier
 */
export function clearSession(sessionId) {
	sessionTasks.delete(sessionId);
}

/**
 * Broadcast task update to WebSocket client and SSE subscribers
 * @param {WebSocket} ws - WebSocket connection (can be null)
 * @param {string} type - Update type ('task-started', 'task-completed', 'task-failed')
 * @param {object} task - Task data
 * @param {string} [username] - Username for SSE publishing
 * @param {string} [sessionId] - Session ID for message buffering
 */
export function broadcastTaskUpdate(
	ws,
	type,
	task,
	username = null,
	sessionId = null,
) {
	const message = {
		type,
		data: task, // Frontend expects 'data' wrapper
		sessionId,
	};

	// Send via SSE event bus (primary path)
	if (username) {
		try {
			publish(username, message);
		} catch (err) {
			console.error(
				`[Tasks] Error publishing task update to SSE:`,
				err.message,
			);
		}
	}

	// Buffer for session replay (late-joining clients)
	if (sessionId) {
		try {
			eventDelivery.recordSessionEvent(sessionId, message);
		} catch (err) {
			console.error(`[Tasks] Error buffering task update:`, err.message);
		}
	}

	// Fallback: WebSocket (for legacy clients)
	if (ws && ws.readyState === 1) {
		// WebSocket.OPEN
		try {
			ws.send(JSON.stringify(message));
		} catch (err) {
			console.error(
				`[Tasks] Error sending task update via WebSocket:`,
				err.message,
			);
		}
	}
}

/**
 * Get all tasks for a session (for debugging/testing)
 * @param {string} sessionId - Session identifier
 * @returns {Array} Array of tasks
 */
export function getSessionTasks(sessionId) {
	const tasks = sessionTasks.get(sessionId);
	if (!tasks) return [];
	return Array.from(tasks.values());
}

// Export task manager object for convenience
export const taskManager = {
	trackTaskStart,
	trackTaskComplete,
	trackTaskFailed,
	getTask,
	clearSession,
	getSessionTasks,
};
