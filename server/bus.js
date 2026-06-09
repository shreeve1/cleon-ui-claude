/**
 * In-memory pub/sub event bus for SSE event distribution
 * Manages per-user event channels with automatic cleanup
 */

import logger from "./logger.js";

// Map of username -> Set<callback>
const subscribers = new Map();

/**
 * Subscribe to events for a specific user
 * @param {string} username - The username to subscribe to
 * @param {Function} callback - Function called with each event: (event) => void
 * @returns {Function} Unsubscribe function
 */
export function subscribe(username, callback) {
	if (!subscribers.has(username)) {
		subscribers.set(username, new Set());
	}
	subscribers.get(username).add(callback);

	// Return unsubscribe function
	return () => {
		const subs = subscribers.get(username);
		if (subs) {
			subs.delete(callback);
			if (subs.size === 0) {
				subscribers.delete(username);
			}
		}
	};
}

/**
 * Publish an event to all subscribers for a user
 * @param {string} username - The username to publish to
 * @param {Object} event - The event object
 * @param {string} event.type - Event type (e.g., 'claude-message', 'session-created')
 * @param {string} [event.sessionId] - Optional session ID
 * @param {any} [event.data] - Event payload
 * @param {string} [event.timestamp] - ISO timestamp (auto-set if not provided)
 */
export function publish(username, event) {
	const subs = subscribers.get(username);
	if (!subs) return;

	const payload = {
		...event,
		timestamp: event.timestamp || new Date().toISOString(),
	};

	for (const cb of subs) {
		try {
			cb(payload);
		} catch (err) {
			logger.error("[Bus] Subscriber error:", err);
		}
	}
}

/**
 * Get subscriber count for a user (for debugging)
 * @param {string} username - The username
 * @returns {number} Number of active subscribers
 */
export function getSubscriberCount(username) {
	return subscribers.get(username)?.size || 0;
}
