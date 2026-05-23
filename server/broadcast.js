/**
 * Legacy Adapter for SSE replay buffering.
 * Event Delivery owns replay state; existing callers keep this Interface during migration.
 */

import { eventDelivery } from './event-delivery.js';

export function broadcastToSession(sessionId, message) {
  eventDelivery.recordSessionEvent(sessionId, message);
}

export function startSessionBuffer(sessionId) {
  eventDelivery.startSession(sessionId);
  console.log(`[Broadcast] Started message buffer for session ${sessionId}`);
}

export function replayBufferToClient(sessionId, ws) {
  const replayed = eventDelivery.replayToWebSocket(sessionId, ws);
  if (replayed) {
    console.log(`[Broadcast] Replayed buffered messages to client for session ${sessionId}`);
  }
}

export function replayBufferToSSE(sessionId, res) {
  const replayed = eventDelivery.replayToSSE(sessionId, res);
  if (replayed) {
    console.log(`[Broadcast] Replayed buffered messages via SSE for session ${sessionId}`);
  }
}

export function hasReplayBuffer(sessionId) {
  return eventDelivery.hasReplay(sessionId);
}

export function clearSessionBuffer(sessionId) {
  if (eventDelivery.hasReplay(sessionId)) {
    console.log(`[Broadcast] Cleared buffer for session ${sessionId}`);
  }
  eventDelivery.clearSession(sessionId);
}
