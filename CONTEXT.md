# Cleon UI Context

Cleon UI is a mobile-first web interface for Claude Code sessions. This context names the domain concepts used when discussing event delivery, replay, and session state.

## Language

**Cleon UI**:
The browser-based interface that lets a local owner use Claude Code sessions remotely.
_Avoid_: Claude Lite, generic chat app

**Claude Code Session**:
A single Claude Code conversation identified by a Claude SDK session id and associated with one project.
_Avoid_: chat thread, conversation tab

**Project**:
A filesystem workspace whose Claude Code journals live under `~/.claude/projects/`.
_Avoid_: repo, folder

**Event Delivery**:
The movement of server-side session events to the browser, including live delivery, replay, and state snapshots.
_Avoid_: streaming glue, message plumbing

**SSE Replay**:
The recovery path that sends missed Claude Code Session events back to a reconnecting browser.
_Avoid_: reconnect dump, backlog

**Activity State**:
The latest visible status of Claude work in a Claude Code Session, such as thinking or running a tool.
_Avoid_: activity history, progress log

**Task Event**:
An ordered fact that a Claude tool task started, completed, or failed.
_Avoid_: task state

**Task State Snapshot**:
The latest known state of all visible Claude tool tasks in a Claude Code Session.
_Avoid_: task event

**WebSocket Input**:
Browser-to-server commands for chat, abort, question response, plan response, and ping.
_Avoid_: bidirectional stream

## Relationships

- A **Project** has zero or more **Claude Code Sessions**.
- A **Claude Code Session** produces **Task Events** and one **Activity State**.
- **Event Delivery** sends live events and supports **SSE Replay**.
- **SSE Replay** replays **Task Events** in order and includes a **Task State Snapshot**.
- **SSE Replay** includes only latest **Activity State**, not activity history.
- **WebSocket Input** changes a **Claude Code Session** but does not deliver streamed output.

## Example Dialogue

> **Dev:** "When browser reconnects during a **Claude Code Session**, should **SSE Replay** include every **Activity State** change?"
> **Domain expert:** "No. Replay latest **Activity State** only, but replay **Task Events** in order and include a **Task State Snapshot**."

## Flagged Ambiguities

- "activity" can mean current status or history. Resolved: **Activity State** means latest status only.
- "task update" can mean an ordered fact or current aggregate state. Resolved: **Task Event** is history; **Task State Snapshot** is current aggregate state.
