/**
 * Unit tests for SSE Task Updates fix
 *
 * Tests that broadcastTaskUpdate() properly publishes to SSE event bus,
 * buffers to session, and maintains WebSocket fallback with correct message structure.
 *
 * Testing Promise: Task status updates (started, completed, failed) are delivered
 * via SSE to the web UI during sub-agent delegation, and the message structure
 * matches the frontend handlers' expectations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { readFileSync } from 'fs';


// ---------------------------------------------------------------------------
// Mock dependencies for isolated testing
// ---------------------------------------------------------------------------

// Track calls to publish and eventDelivery.recordSessionEvent
const publishCalls = [];
const recordSessionEventCalls = [];
const wsSendCalls = [];

// Mock publish from bus.js
vi.mock('../../server/bus.js', () => ({
  publish: vi.fn((username, event) => {
    publishCalls.push({ username, event });
  })
}));

// Mock eventDelivery.recordSessionEvent from event-delivery.js
vi.mock('../../server/event-delivery.js', () => ({
  EventDelivery: class {},
  eventDelivery: {
    recordSessionEvent: vi.fn((sessionId, message) => {
      recordSessionEventCalls.push({ sessionId, message });
    }),
    startSession: vi.fn(),
    replayToSSE: vi.fn(),
    replayToWebSocket: vi.fn(),
    hasReplay: vi.fn(),
    clearSession: vi.fn(),
    deliver: vi.fn()
  }
}));

// Import after mocking
import { broadcastTaskUpdate, trackTaskStart, trackTaskComplete, trackTaskFailed } from '../../server/tasks.js';
const { publish } = await import('../../server/bus.js');
const { eventDelivery } = await import('../../server/event-delivery.js');
const recordSessionEvent = eventDelivery.recordSessionEvent;

// Mock WebSocket
const createMockWebSocket = (readyState = 1) => ({
  readyState,
  send: vi.fn((data) => {
    wsSendCalls.push(JSON.parse(data));
  })
});

// Reset call trackers before each test
beforeEach(() => {
  publishCalls.length = 0;
  recordSessionEventCalls.length = 0;
  wsSendCalls.length = 0;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Static Analysis - Source Code Structure Verification
// ===========================================================================
describe('Static Analysis - server/tasks.js structure', () => {
  const tasksJsPath = resolve(import.meta.dirname, '../../server/tasks.js');
  const tasksJs = readFileSync(tasksJsPath, 'utf-8');

  it('imports publish from ./bus.js', () => {
    expect(tasksJs).toContain("import { publish } from './bus.js'");
  });

  it('imports eventDelivery from ./event-delivery.js', () => {
    expect(tasksJs).toContain("import { eventDelivery } from './event-delivery.js'");
  });

  it('broadcastTaskUpdate accepts username and sessionId parameters', () => {
    expect(tasksJs).toContain('export function broadcastTaskUpdate(ws, type, task, username = null, sessionId = null)');
  });

  it('message structure uses "data" not "task" property', () => {
    expect(tasksJs).toContain('data: task,');
    // Should NOT contain the old structure (task as a top-level property)
    // Looking for patterns like "const message = { type, task" which would be wrong
    expect(tasksJs).not.toMatch(/const message = \{\s*type,\s*task/);
  });

  it('calls publish(username, message) for SSE delivery', () => {
    expect(tasksJs).toContain('publish(username, message)');
  });

  it('calls eventDelivery.recordSessionEvent(sessionId, message) for buffering', () => {
    expect(tasksJs).toContain('eventDelivery.recordSessionEvent(sessionId, message)');
  });

  it('message structure includes sessionId field', () => {
    expect(tasksJs).toContain('sessionId');
    const messageSection = tasksJs.slice(tasksJs.indexOf('const message = {'), tasksJs.indexOf('const message = {') + 200);
    expect(messageSection).toContain('sessionId');
  });

  it('WebSocket fallback includes readyState check (1 = OPEN)', () => {
    expect(tasksJs).toContain('ws && ws.readyState === 1');
  });
});

// ===========================================================================
// 2. broadcastTaskUpdate - SSE Publishing Tests
// ===========================================================================
describe('broadcastTaskUpdate - SSE Publishing', () => {
  const mockTask = {
    taskId: 'task-1',
    title: 'Running tests',
    status: 'in_progress',
    startTime: '2024-01-01T00:00:00.000Z'
  };

  it('publishes to SSE event bus when username is provided', () => {
    const ws = createMockWebSocket();
    const username = 'testuser';
    const sessionId = 'session-123';

    broadcastTaskUpdate(ws, 'task-started', mockTask, username, sessionId);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      username,
      expect.objectContaining({
        type: 'task-started',
        data: mockTask,
        sessionId: 'session-123'
      })
    );
  });

  it('does NOT publish to SSE when username is null', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, null, 'session-123');

    expect(publish).not.toHaveBeenCalled();
  });

  it('does NOT publish to SSE when username is undefined', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, undefined, 'session-123');

    expect(publish).not.toHaveBeenCalled();
  });

  it('does NOT publish to SSE when username is empty string', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, '', 'session-123');

    expect(publish).not.toHaveBeenCalled();
  });

  it('sends correct message structure via SSE', () => {
    const ws = createMockWebSocket();
    const username = 'testuser';
    const sessionId = 'session-123';

    broadcastTaskUpdate(ws, 'task-started', mockTask, username, sessionId);

    const publishArg = publish.mock.calls[0][1];
    expect(publishArg).toHaveProperty('type', 'task-started');
    expect(publishArg).toHaveProperty('data');
    expect(publishArg).not.toHaveProperty('task'); // Old structure should NOT exist
    expect(publishArg.data).toEqual(mockTask);
    expect(publishArg).toHaveProperty('sessionId', 'session-123');
  });

  it('handles publish errors gracefully', () => {
    const ws = createMockWebSocket();
    publish.mockImplementation(() => {
      throw new Error('SSE connection failed');
    });

    expect(() => {
      broadcastTaskUpdate(ws, 'task-started', mockTask, 'testuser', 'session-123');
    }).not.toThrow();

    // Should still continue to other paths (buffering, WebSocket)
    expect(recordSessionEvent).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalled();
  });

  it('publishes task-started events', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');

    expect(publish).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ type: 'task-started' })
    );
  });

  it('publishes task-completed events', () => {
    const ws = createMockWebSocket();
    const completedTask = { ...mockTask, status: 'completed' };
    broadcastTaskUpdate(ws, 'task-completed', completedTask, 'user', 'session');

    expect(publish).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ type: 'task-completed' })
    );
  });

  it('publishes task-failed events', () => {
    const ws = createMockWebSocket();
    const failedTask = { ...mockTask, status: 'failed', error: 'Something went wrong' };
    broadcastTaskUpdate(ws, 'task-failed', failedTask, 'user', 'session');

    expect(publish).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ type: 'task-failed' })
    );
  });
});

// ===========================================================================
// 3. broadcastTaskUpdate - Session Buffering Tests
// ===========================================================================
describe('broadcastTaskUpdate - Session Buffering', () => {
  const mockTask = {
    taskId: 'task-2',
    title: 'Buffering test',
    status: 'in_progress'
  };

  it('buffers to session when sessionId is provided', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session-456');

    expect(recordSessionEvent).toHaveBeenCalledTimes(1);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      'session-456',
      expect.objectContaining({
        type: 'task-started',
        data: mockTask,
        sessionId: 'session-456'
      })
    );
  });

  it('does NOT buffer when sessionId is null', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', null);

    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it('does NOT buffer when sessionId is undefined', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', undefined);

    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it('does NOT buffer when sessionId is empty string', () => {
    const ws = createMockWebSocket();
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', '');

    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it('buffers with correct message structure', () => {
    const ws = createMockWebSocket();
    const sessionId = 'session-789';
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', sessionId);

    const bufferArg = recordSessionEvent.mock.calls[0][1];
    expect(bufferArg).toHaveProperty('type', 'task-started');
    expect(bufferArg).toHaveProperty('data');
    expect(bufferArg).not.toHaveProperty('task'); // Old structure should NOT exist
    expect(bufferArg.data).toEqual(mockTask);
    expect(bufferArg).toHaveProperty('sessionId', sessionId);
  });

  it('handles recordSessionEvent errors gracefully', () => {
    const ws = createMockWebSocket();
    recordSessionEvent.mockImplementation(() => {
      throw new Error('Buffer overflow');
    });

    expect(() => {
      broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');
    }).not.toThrow();

    // Should still continue to SSE and WebSocket
    expect(publish).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. broadcastTaskUpdate - WebSocket Fallback Tests
// ===========================================================================
describe('broadcastTaskUpdate - WebSocket Fallback', () => {
  const mockTask = {
    taskId: 'task-3',
    title: 'WebSocket test',
    status: 'in_progress'
  };

  it('sends via WebSocket when ws is OPEN (readyState = 1)', () => {
    const ws = createMockWebSocket(1); // WebSocket.OPEN
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentData).toEqual({
      type: 'task-started',
      data: mockTask,
      sessionId: 'session'
    });
  });

  it('does NOT send via WebSocket when ws is null', () => {
    broadcastTaskUpdate(null, 'task-started', mockTask, 'user', 'session');

    expect(wsSendCalls.length).toBe(0);
  });

  it('does NOT send via WebSocket when ws is undefined', () => {
    broadcastTaskUpdate(undefined, 'task-started', mockTask, 'user', 'session');

    expect(wsSendCalls.length).toBe(0);
  });

  it('does NOT send via WebSocket when readyState is 0 (CONNECTING)', () => {
    const ws = createMockWebSocket(0); // WebSocket.CONNECTING
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does NOT send via WebSocket when readyState is 2 (CLOSING)', () => {
    const ws = createMockWebSocket(2); // WebSocket.CLOSING
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does NOT send via WebSocket when readyState is 3 (CLOSED)', () => {
    const ws = createMockWebSocket(3); // WebSocket.CLOSED
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('WebSocket message structure uses "data" not "task"', () => {
    const ws = createMockWebSocket(1);
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');

    const sentData = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentData).toHaveProperty('type', 'task-started');
    expect(sentData).toHaveProperty('data');
    expect(sentData).not.toHaveProperty('task'); // Old structure should NOT exist
    expect(sentData.data).toEqual(mockTask);
  });

  it('handles WebSocket send errors gracefully', () => {
    const ws = createMockWebSocket(1);
    ws.send.mockImplementation(() => {
      throw new Error('WebSocket disconnected');
    });

    expect(() => {
      broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', 'session');
    }).not.toThrow();

    // SSE and buffering should still have been called
    expect(publish).toHaveBeenCalled();
    expect(recordSessionEvent).toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. broadcastTaskUpdate - Combined Delivery Tests
// ===========================================================================
describe('broadcastTaskUpdate - Combined Delivery Paths', () => {
  const mockTask = {
    taskId: 'task-4',
    title: 'Combined test',
    status: 'completed',
    endTime: '2024-01-01T00:01:00.000Z'
  };

  it('delivers via SSE, buffer, and WebSocket when all params provided', () => {
    const ws = createMockWebSocket(1);
    broadcastTaskUpdate(ws, 'task-completed', mockTask, 'user', 'session');

    // All three paths should be used
    expect(publish).toHaveBeenCalledTimes(1);
    expect(recordSessionEvent).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('delivers via SSE and WebSocket when username provided but no sessionId', () => {
    const ws = createMockWebSocket(1);
    broadcastTaskUpdate(ws, 'task-started', mockTask, 'user', null);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(recordSessionEvent).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('delivers via buffer and WebSocket when sessionId provided but no username', () => {
    const ws = createMockWebSocket(1);
    broadcastTaskUpdate(ws, 'task-started', mockTask, null, 'session');

    expect(publish).not.toHaveBeenCalled();
    expect(recordSessionEvent).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('delivers only via WebSocket when only ws provided', () => {
    const ws = createMockWebSocket(1);
    broadcastTaskUpdate(ws, 'task-started', mockTask, null, null);

    expect(publish).not.toHaveBeenCalled();
    expect(recordSessionEvent).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('all paths receive consistent message structure', () => {
    const ws = createMockWebSocket(1);
    const username = 'user';
    const sessionId = 'session';

    broadcastTaskUpdate(ws, 'task-completed', mockTask, username, sessionId);

    const sseMessage = publish.mock.calls[0][1];
    const bufferMessage = recordSessionEvent.mock.calls[0][1];
    const wsMessage = JSON.parse(ws.send.mock.calls[0][0]);

    // All should have same structure
    [sseMessage, bufferMessage, wsMessage].forEach(msg => {
      expect(msg).toHaveProperty('type', 'task-completed');
      expect(msg).toHaveProperty('data');
      expect(msg).not.toHaveProperty('task');
      expect(msg.data).toEqual(mockTask);
      expect(msg.sessionId).toBe(sessionId);
    });
  });
});

// ===========================================================================
// 6. broadcastTaskUpdate - Message Structure Validation
// ===========================================================================
describe('broadcastTaskUpdate - Message Structure (Frontend Compatibility)', () => {
  it('message structure matches frontend handleServerEvent expectations', () => {
    // Frontend expects: msg.type, msg.data.taskId, msg.data.title, etc.
    const ws = createMockWebSocket();
    const task = {
      taskId: 'task-123',
      title: 'Test task',
      status: 'in_progress',
      progress: 50
    };

    broadcastTaskUpdate(ws, 'task-started', task, 'user', 'session');

    const sseMessage = publish.mock.calls[0][1];

    // Type is at top level
    expect(sseMessage.type).toBe('task-started');

    // Task properties are nested under 'data'
    expect(sseMessage.data).toBeDefined();
    expect(sseMessage.data.taskId).toBe('task-123');
    expect(sseMessage.data.title).toBe('Test task');
    expect(sseMessage.data.status).toBe('in_progress');
    expect(sseMessage.data.progress).toBe(50);

    // Old structure (task property at top level) should NOT exist
    expect(sseMessage.task).toBeUndefined();
  });

  it('sessionId is included for routing purposes', () => {
    const ws = createMockWebSocket();
    const task = { taskId: 'task-x', title: 'X', status: 'completed' };

    broadcastTaskUpdate(ws, 'task-completed', task, 'user', 'my-session-id');

    const sseMessage = publish.mock.calls[0][1];
    expect(sseMessage.sessionId).toBe('my-session-id');
  });

  it('preserves all task properties in data field', () => {
    const ws = createMockWebSocket();
    const complexTask = {
      taskId: 'task-999',
      title: 'Complex task',
      status: 'failed',
      progress: 75,
      startTime: '2024-01-01T00:00:00.000Z',
      endTime: '2024-01-01T00:05:00.000Z',
      error: 'Test error',
      output: 'Test output',
      metadata: { tool: 'bash', toolUseId: 'tu-123' }
    };

    broadcastTaskUpdate(ws, 'task-failed', complexTask, 'user', 'session');

    const sseMessage = publish.mock.calls[0][1];
    expect(sseMessage.data).toEqual(complexTask);
  });
});

// ===========================================================================
// 7. Task Manager Integration Tests
// ===========================================================================
describe('Task Manager - Integration with broadcastTaskUpdate', () => {
  it('trackTaskStart creates task with required fields', () => {
    const sessionId = 'test-session';
    const task = trackTaskStart(sessionId, {
      title: 'Running integration test',
      progress: 0
    });

    expect(task).toHaveProperty('taskId');
    expect(task).toHaveProperty('status', 'in_progress');
    expect(task).toHaveProperty('startTime');
    expect(task).toHaveProperty('title', 'Running integration test');
    expect(task).toHaveProperty('progress', 0);
  });

  it('trackTaskComplete updates task correctly', () => {
    const sessionId = 'test-session';
    const startedTask = trackTaskStart(sessionId, { title: 'Test', progress: 0 });

    const completedTask = trackTaskComplete(sessionId, startedTask.taskId, {
      output: 'Test completed successfully',
      duration: 5000
    });

    expect(completedTask).toHaveProperty('status', 'completed');
    expect(completedTask).toHaveProperty('endTime');
    expect(completedTask).toHaveProperty('output', 'Test completed successfully');
    expect(completedTask).toHaveProperty('duration', 5000);
  });

  it('trackTaskFailed updates task correctly', () => {
    const sessionId = 'test-session';
    const startedTask = trackTaskStart(sessionId, { title: 'Test', progress: 0 });

    const failedTask = trackTaskFailed(sessionId, startedTask.taskId, 'Test error message');

    expect(failedTask).toHaveProperty('status', 'failed');
    expect(failedTask).toHaveProperty('endTime');
    expect(failedTask).toHaveProperty('error', 'Test error message');
  });

  it('broadcastTaskUpdate works with actual task manager tasks', () => {
    const ws = createMockWebSocket();
    const sessionId = 'integration-session';
    const username = 'testuser';

    const startedTask = trackTaskStart(sessionId, {
      title: 'Full integration test',
      progress: 0
    });

    broadcastTaskUpdate(ws, 'task-started', startedTask, username, sessionId);

    expect(publish).toHaveBeenCalledWith(
      username,
      expect.objectContaining({
        type: 'task-started',
        data: expect.objectContaining({
          taskId: startedTask.taskId,
          title: 'Full integration test',
          status: 'in_progress'
        })
      })
    );
  });
});
