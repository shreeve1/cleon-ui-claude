/**
 * Unit tests for SSE Task Updates fix
 *
 * Tests that broadcastTaskUpdate() properly delivers to SSE event bus
 * via the unified eventDelivery.deliver() path.
 *
 * Testing Promise: Task status updates (started, completed, failed) are delivered
 * via SSE to the web UI during sub-agent delegation, and the message structure
 * matches the frontend handlers' expectations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';


// ---------------------------------------------------------------------------
// Mock dependencies for isolated testing
// ---------------------------------------------------------------------------

// Track calls to eventDelivery.deliver
const deliverCalls = [];

// Mock eventDelivery.deliver from event-delivery.js
vi.mock('../../server/event-delivery.js', () => ({
  EventDelivery: class {},
  eventDelivery: {
    deliver: vi.fn((username, message) => {
      deliverCalls.push({ username, message });
    }),
    startSession: vi.fn(),
    replayToSSE: vi.fn(),
    replayToWebSocket: vi.fn(),
    hasReplay: vi.fn(),
    clearSession: vi.fn()
  }
}));

// Import after mocking
import { broadcastTaskUpdate, trackTaskStart, trackTaskComplete, trackTaskFailed } from '../../server/tasks.js';
const { eventDelivery } = await import('../../server/event-delivery.js');
const deliver = eventDelivery.deliver;

// Reset call trackers before each test
beforeEach(() => {
  deliverCalls.length = 0;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Static Analysis - Source Code Structure Verification
// ===========================================================================
describe('Static Analysis - server/tasks.js structure', () => {
  const tasksJsPath = resolve(import.meta.dirname, '../../server/tasks.js');
  const tasksJs = readFileSync(tasksJsPath, 'utf-8');

  it('does NOT import publish from ./bus.js (uses eventDelivery.deliver instead)', () => {
    expect(tasksJs).not.toMatch(/import\s*\{[^}]*publish[^}]*\}\s*from\s*['"]\.\/bus\.js['"]/);
  });

  it('imports eventDelivery from ./event-delivery.js', () => {
    expect(tasksJs).toMatch(/import\s*\{[^}]*eventDelivery[^}]*\}\s*from\s*['"]\.\/event-delivery\.js['"]/);
  });

  it('broadcastTaskUpdate signature is (type, task, username, sessionId) - no ws param', () => {
    // Function signature spans multiple lines with formatting
    expect(tasksJs).toMatch(/export function broadcastTaskUpdate\(\s*type,\s*task,\s*username\s*=\s*null,\s*sessionId\s*=\s*null\s*,?\s*\)/);
  });

  it('message structure uses "data" not "task" property', () => {
    expect(tasksJs).toContain('data: task,');
    // Should NOT contain the old structure (task as a top-level property)
    expect(tasksJs).not.toMatch(/const message = \{\s*type,\s*task/);
  });

  it('calls eventDelivery.deliver(username, message) for unified delivery', () => {
    expect(tasksJs).toContain('eventDelivery.deliver(username, message)');
  });

  it('message structure includes sessionId field', () => {
    expect(tasksJs).toContain('sessionId');
    const messageSection = tasksJs.slice(tasksJs.indexOf('const message = {'), tasksJs.indexOf('const message = {') + 200);
    expect(messageSection).toContain('sessionId');
  });

  it('does NOT have WebSocket fallback (ws && ws.readyState === 1 removed)', () => {
    expect(tasksJs).not.toContain('ws && ws.readyState === 1');
    expect(tasksJs).not.toContain('ws.send');
  });
});

// ===========================================================================
// 2. broadcastTaskUpdate - Unified Delivery Tests
// ===========================================================================
describe('broadcastTaskUpdate - Unified Delivery (eventDelivery.deliver)', () => {
  const mockTask = {
    taskId: 'task-1',
    title: 'Running tests',
    status: 'in_progress',
    startTime: '2024-01-01T00:00:00.000Z'
  };

  it('delivers to event bus when username is provided', () => {
    const username = 'testuser';
    const sessionId = 'session-123';

    broadcastTaskUpdate('task-started', mockTask, username, sessionId);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      username,
      expect.objectContaining({
        type: 'task-started',
        data: mockTask,
        sessionId: 'session-123'
      })
    );
  });

  it('calls deliver even when username is null (deliver handles null internally)', () => {
    // The new implementation calls deliver() regardless - deliver() handles null internally
    broadcastTaskUpdate('task-started', mockTask, null, 'session-123');

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: 'task-started',
        data: mockTask,
        sessionId: 'session-123'
      })
    );
  });

  it('calls deliver when username is undefined (deliver handles null internally)', () => {
    broadcastTaskUpdate('task-started', mockTask, undefined, 'session-123');

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('calls deliver when username is empty string (deliver handles empty internally)', () => {
    broadcastTaskUpdate('task-started', mockTask, '', 'session-123');

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('sends correct message structure', () => {
    const username = 'testuser';
    const sessionId = 'session-123';

    broadcastTaskUpdate('task-started', mockTask, username, sessionId);

    const deliverArg = deliver.mock.calls[0][1];
    expect(deliverArg).toHaveProperty('type', 'task-started');
    expect(deliverArg).toHaveProperty('data');
    expect(deliverArg).not.toHaveProperty('task'); // Old structure should NOT exist
    expect(deliverArg.data).toEqual(mockTask);
    expect(deliverArg).toHaveProperty('sessionId', 'session-123');
  });

  it('delivers task-started events', () => {
    broadcastTaskUpdate('task-started', mockTask, 'user', 'session');

    expect(deliver).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ type: 'task-started' })
    );
  });

  it('delivers task-completed events', () => {
    const completedTask = { ...mockTask, status: 'completed' };
    broadcastTaskUpdate('task-completed', completedTask, 'user', 'session');

    expect(deliver).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ type: 'task-completed' })
    );
  });

  it('delivers task-failed events', () => {
    const failedTask = { ...mockTask, status: 'failed', error: 'Something went wrong' };
    broadcastTaskUpdate('task-failed', failedTask, 'user', 'session');

    expect(deliver).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ type: 'task-failed' })
    );
  });
});

// ===========================================================================
// 3. broadcastTaskUpdate - SessionId Handling Tests
// ===========================================================================
describe('broadcastTaskUpdate - sessionId handling', () => {
  const mockTask = {
    taskId: 'task-2',
    title: 'SessionId test',
    status: 'in_progress'
  };

  it('includes sessionId in message when provided', () => {
    broadcastTaskUpdate('task-started', mockTask, 'user', 'my-session');

    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverArg = deliver.mock.calls[0][1];
    expect(deliverArg.sessionId).toBe('my-session');
  });

  it('includes null sessionId in message when username provided but no sessionId', () => {
    broadcastTaskUpdate('task-started', mockTask, 'user', null);

    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverArg = deliver.mock.calls[0][1];
    expect(deliverArg.sessionId).toBeNull();
  });

  it('includes null sessionId when undefined', () => {
    broadcastTaskUpdate('task-started', mockTask, 'user', undefined);

    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverArg = deliver.mock.calls[0][1];
    expect(deliverArg.sessionId).toBeNull();
  });
});

// ===========================================================================
// 4. broadcastTaskUpdate - Message Structure Validation
// ===========================================================================
describe('broadcastTaskUpdate - Message Structure (Frontend Compatibility)', () => {
  it('message structure matches frontend handleServerEvent expectations', () => {
    // Frontend expects: msg.type, msg.data.taskId, msg.data.title, etc.
    const task = {
      taskId: 'task-123',
      title: 'Test task',
      status: 'in_progress',
      progress: 50
    };

    broadcastTaskUpdate('task-started', task, 'user', 'session');

    const message = deliver.mock.calls[0][1];

    // Type is at top level
    expect(message.type).toBe('task-started');

    // Task properties are nested under 'data'
    expect(message.data).toBeDefined();
    expect(message.data.taskId).toBe('task-123');
    expect(message.data.title).toBe('Test task');
    expect(message.data.status).toBe('in_progress');
    expect(message.data.progress).toBe(50);

    // Old structure (task property at top level) should NOT exist
    expect(message.task).toBeUndefined();
  });

  it('sessionId is included for routing purposes', () => {
    const task = { taskId: 'task-x', title: 'X', status: 'completed' };

    broadcastTaskUpdate('task-completed', task, 'user', 'my-session-id');

    const message = deliver.mock.calls[0][1];
    expect(message.sessionId).toBe('my-session-id');
  });

  it('preserves all task properties in data field', () => {
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

    broadcastTaskUpdate('task-failed', complexTask, 'user', 'session');

    const message = deliver.mock.calls[0][1];
    expect(message.data).toEqual(complexTask);
  });
});

// ===========================================================================
// 5. Task Manager Integration Tests
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
    const sessionId = 'integration-session';
    const username = 'testuser';

    const startedTask = trackTaskStart(sessionId, {
      title: 'Full integration test',
      progress: 0
    });

    broadcastTaskUpdate('task-started', startedTask, username, sessionId);

    expect(deliver).toHaveBeenCalledWith(
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
