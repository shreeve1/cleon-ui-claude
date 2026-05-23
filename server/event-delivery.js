import { publish } from './bus.js';

const DEFAULT_MAX_EVENTS = 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_REPLAY_GRACE_MS = 5 * 60 * 1000;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

function createSessionState() {
  return {
    transcript: [],
    transcriptBytes: 0,
    truncated: false,
    latestActivity: null,
    tasks: new Map(),
    cleanupTimer: null
  };
}

function defaultLiveAdapter(username, event) {
  publish(username, event);
}

export class EventDelivery {
  constructor({
    liveAdapter = defaultLiveAdapter,
    maxEvents = DEFAULT_MAX_EVENTS,
    maxBytes = DEFAULT_MAX_BYTES,
    replayGraceMs = DEFAULT_REPLAY_GRACE_MS
  } = {}) {
    this.liveAdapter = liveAdapter;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.replayGraceMs = replayGraceMs;
    this.sessions = new Map();
  }

  startSession(sessionId) {
    if (!sessionId) return;

    const existing = this.sessions.get(sessionId);
    if (existing?.cleanupTimer) {
      clearTimeout(existing.cleanupTimer);
    }

    this.sessions.set(sessionId, createSessionState());
  }

  publishLive(username, event) {
    if (!username) return;
    this.liveAdapter(username, event);
  }

  recordSessionEvent(sessionId, event) {
    if (!sessionId || !event) return;

    const state = this.sessions.get(sessionId);
    if (!state) return;

    const replayEvent = cloneEvent(event);

    if (replayEvent.type === 'agent-activity') {
      state.latestActivity = replayEvent;
      return;
    }

    if (this.isTaskEvent(replayEvent)) {
      this.recordTaskState(state, replayEvent);
    }

    this.appendTranscriptEvent(state, replayEvent);

    if (replayEvent.type === 'claude-done') {
      this.scheduleGraceCleanup(sessionId, state);
    }
  }

  deliver(username, event) {
    if (event?.sessionId) {
      this.recordSessionEvent(event.sessionId, event);
    }
    this.publishLive(username, event);
  }

  replayToSSE(sessionId, res) {
    const state = this.sessions.get(sessionId);
    if (!this.hasReplay(sessionId)) return false;

    res.write(`data: ${JSON.stringify({ type: 'replay-start', sessionId })}\n\n`);
    this.writeReplayEvents(sessionId, state, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ type: 'replay-end', sessionId })}\n\n`);
    return true;
  }

  replayToWebSocket(sessionId, ws) {
    if (!ws || ws.readyState !== 1) return false;

    const state = this.sessions.get(sessionId);
    if (!this.hasReplay(sessionId)) return false;

    ws.send(JSON.stringify({ type: 'replay-start', sessionId }));
    this.writeReplayEvents(sessionId, state, (event) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(event));
      }
    });
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'replay-end', sessionId }));
    }
    return true;
  }

  hasReplay(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    return state.transcript.length > 0 ||
      state.truncated ||
      !!state.latestActivity ||
      state.tasks.size > 0;
  }

  clearSession(sessionId) {
    const state = this.sessions.get(sessionId);
    if (state?.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
    }
    this.sessions.delete(sessionId);
  }

  appendTranscriptEvent(state, event) {
    const bytes = byteLength(event);
    state.transcript.push({ event, bytes });
    state.transcriptBytes += bytes;

    while (
      state.transcript.length > this.maxEvents ||
      state.transcriptBytes > this.maxBytes
    ) {
      const removed = state.transcript.shift();
      if (!removed) break;
      state.transcriptBytes -= removed.bytes;
      state.truncated = true;
    }
  }

  writeReplayEvents(sessionId, state, write) {
    if (state.truncated) {
      write({ type: 'replay-truncated', sessionId });
    }

    for (const entry of state.transcript) {
      write(entry.event);
    }

    if (state.latestActivity) {
      write(state.latestActivity);
    }

    if (state.tasks.size > 0) {
      write({
        type: 'tasks-sync',
        sessionId,
        data: { tasks: [...state.tasks.values()] }
      });
    }
  }

  scheduleGraceCleanup(sessionId, state) {
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
    }

    if (this.replayGraceMs <= 0) {
      this.clearSession(sessionId);
      return;
    }

    state.cleanupTimer = setTimeout(() => {
      this.clearSession(sessionId);
    }, this.replayGraceMs);
    state.cleanupTimer.unref?.();
  }

  isTaskEvent(event) {
    return event.type === 'task-started' ||
      event.type === 'task-progress' ||
      event.type === 'task-completed' ||
      event.type === 'task-failed' ||
      event.type === 'task-update';
  }

  recordTaskState(state, event) {
    const task = event.data;
    if (!task?.taskId) return;
    state.tasks.set(task.taskId, task);
  }
}

export const eventDelivery = new EventDelivery();
