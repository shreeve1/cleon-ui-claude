/**
 * Task Manager for tracking Claude tool executions
 * Manages in-memory task state per session with event delivery
 */

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
 * Broadcast task update via unified event delivery (live SSE + replay buffer)
 * @param {string} type - Update type ('task-started', 'task-completed', 'task-failed')
 * @param {object} task - Task data
 * @param {string} [username] - Username for SSE publishing
 * @param {string} [sessionId] - Session ID for replay buffering
 */
export function broadcastTaskUpdate(
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

	eventDelivery.deliver(username, message);
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
