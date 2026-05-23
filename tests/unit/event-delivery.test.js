import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventDelivery } from '../../server/event-delivery.js';
import {
  broadcastToSession,
  clearSessionBuffer,
  hasReplayBuffer,
  replayBufferToSSE,
  startSessionBuffer
} from '../../server/broadcast.js';

function createSseResponse() {
  const chunks = [];
  return {
    chunks,
    write: vi.fn((chunk) => chunks.push(chunk))
  };
}

function parseSseEvents(res) {
  return res.chunks
    .map((chunk) => chunk.match(/^data: (.*)\n\n$/)?.[1])
    .filter(Boolean)
    .map((payload) => JSON.parse(payload));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EventDelivery', () => {
  it('delivers live events and records raw browser event objects for replay', () => {
    const liveAdapter = vi.fn();
    const delivery = new EventDelivery({ liveAdapter });
    const event = {
      type: 'claude-message',
      sessionId: 'session-1',
      data: { type: 'text', content: 'hello' }
    };

    delivery.startSession('session-1');
    delivery.deliver('user-1', event);

    expect(liveAdapter).toHaveBeenCalledWith('user-1', event);

    const res = createSseResponse();
    delivery.replayToSSE('session-1', res);

    expect(parseSseEvents(res)).toEqual([
      { type: 'replay-start', sessionId: 'session-1' },
      event,
      { type: 'replay-end', sessionId: 'session-1' }
    ]);
  });

  it('drops oldest transcript events and emits replay-truncated marker', () => {
    const delivery = new EventDelivery({ maxEvents: 2 });
    delivery.startSession('session-2');

    delivery.recordSessionEvent('session-2', { type: 'claude-message', sessionId: 'session-2', data: { content: 'one' } });
    delivery.recordSessionEvent('session-2', { type: 'claude-message', sessionId: 'session-2', data: { content: 'two' } });
    delivery.recordSessionEvent('session-2', { type: 'claude-message', sessionId: 'session-2', data: { content: 'three' } });

    const res = createSseResponse();
    delivery.replayToSSE('session-2', res);

    expect(parseSseEvents(res)).toEqual([
      { type: 'replay-start', sessionId: 'session-2' },
      { type: 'replay-truncated', sessionId: 'session-2' },
      { type: 'claude-message', sessionId: 'session-2', data: { content: 'two' } },
      { type: 'claude-message', sessionId: 'session-2', data: { content: 'three' } },
      { type: 'replay-end', sessionId: 'session-2' }
    ]);
  });

  it('replays only latest Activity State, not activity history', () => {
    const delivery = new EventDelivery();
    delivery.startSession('session-3');

    delivery.recordSessionEvent('session-3', { type: 'agent-activity', sessionId: 'session-3', state: 'thinking', label: 'Thinking...' });
    delivery.recordSessionEvent('session-3', { type: 'agent-activity', sessionId: 'session-3', state: 'tool_executing', label: 'Running Bash', toolName: 'Bash' });
    delivery.recordSessionEvent('session-3', { type: 'claude-message', sessionId: 'session-3', data: { type: 'text', content: 'working' } });

    const res = createSseResponse();
    delivery.replayToSSE('session-3', res);

    expect(parseSseEvents(res)).toEqual([
      { type: 'replay-start', sessionId: 'session-3' },
      { type: 'claude-message', sessionId: 'session-3', data: { type: 'text', content: 'working' } },
      { type: 'agent-activity', sessionId: 'session-3', state: 'tool_executing', label: 'Running Bash', toolName: 'Bash' },
      { type: 'replay-end', sessionId: 'session-3' }
    ]);
  });

  it('replays Task Events and appends Task State Snapshot', () => {
    const delivery = new EventDelivery();
    delivery.startSession('session-4');

    const started = { taskId: 'task-1', title: 'Run tests', status: 'in_progress', progress: 0 };
    const completed = { ...started, status: 'completed', progress: 100 };

    delivery.recordSessionEvent('session-4', { type: 'task-started', sessionId: 'session-4', data: started });
    delivery.recordSessionEvent('session-4', { type: 'task-completed', sessionId: 'session-4', data: completed });

    const res = createSseResponse();
    delivery.replayToSSE('session-4', res);

    expect(parseSseEvents(res)).toEqual([
      { type: 'replay-start', sessionId: 'session-4' },
      { type: 'task-started', sessionId: 'session-4', data: started },
      { type: 'task-completed', sessionId: 'session-4', data: completed },
      { type: 'tasks-sync', sessionId: 'session-4', data: { tasks: [completed] } },
      { type: 'replay-end', sessionId: 'session-4' }
    ]);
  });

  it('preserves transcript event objects when callers mutate task objects later', () => {
    const delivery = new EventDelivery();
    const task = { taskId: 'task-2', title: 'Mutable task', status: 'in_progress' };

    delivery.startSession('session-6');
    delivery.recordSessionEvent('session-6', { type: 'task-started', sessionId: 'session-6', data: task });
    task.status = 'completed';
    delivery.recordSessionEvent('session-6', { type: 'task-completed', sessionId: 'session-6', data: task });

    const res = createSseResponse();
    delivery.replayToSSE('session-6', res);

    expect(parseSseEvents(res)).toEqual([
      { type: 'replay-start', sessionId: 'session-6' },
      { type: 'task-started', sessionId: 'session-6', data: { taskId: 'task-2', title: 'Mutable task', status: 'in_progress' } },
      { type: 'task-completed', sessionId: 'session-6', data: { taskId: 'task-2', title: 'Mutable task', status: 'completed' } },
      { type: 'tasks-sync', sessionId: 'session-6', data: { tasks: [{ taskId: 'task-2', title: 'Mutable task', status: 'completed' }] } },
      { type: 'replay-end', sessionId: 'session-6' }
    ]);
  });

  it('clears replay after Replay Grace Period', () => {
    vi.useFakeTimers();
    const delivery = new EventDelivery({ replayGraceMs: 100 });
    delivery.startSession('session-5');

    delivery.recordSessionEvent('session-5', { type: 'claude-done', sessionId: 'session-5' });

    expect(delivery.hasReplay('session-5')).toBe(true);

    vi.advanceTimersByTime(100);

    expect(delivery.hasReplay('session-5')).toBe(false);
  });
});

describe('broadcast legacy Adapter', () => {
  it('delegates existing replay Interface to Event Delivery', () => {
    const sessionId = 'legacy-session-1';
    startSessionBuffer(sessionId);
    broadcastToSession(sessionId, { type: 'claude-message', sessionId, data: { type: 'text', content: 'legacy' } });

    expect(hasReplayBuffer(sessionId)).toBe(true);

    const res = createSseResponse();
    replayBufferToSSE(sessionId, res);

    expect(parseSseEvents(res)).toEqual([
      { type: 'replay-start', sessionId },
      { type: 'claude-message', sessionId, data: { type: 'text', content: 'legacy' } },
      { type: 'replay-end', sessionId }
    ]);

    clearSessionBuffer(sessionId);
    expect(hasReplayBuffer(sessionId)).toBe(false);
  });
});
