# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                 # node server/index.js (port 3010 by default)
npm run dev               # node --watch server/index.js (auto-reload)
npm run pm2               # delete+restart under PM2 using ecosystem.config.cjs
npm run pm2:logs          # tail PM2 logs
npm test                  # vitest run (all tests: unit, integration, e2e)
npx vitest run tests/unit/sse-task-updates.test.js   # single test file
npx vitest --watch tests/unit                         # watch a directory
```

E2E tests under `tests/e2e/` use Playwright (`chromium` from the `playwright` package) loading `public/index.html` via `file://`. They do **not** require the server running; they verify DOM/CSS only.

No lint/format/typecheck scripts are configured. The project is plain ES modules (`"type": "module"`).

## Architecture

Single-process Node server + vanilla-JS SPA. The non-obvious pieces:

### Dual transport: WebSocket in, SSE out
- **Client → Server** uses WebSocket (`/` upgrade). Messages: `chat`, `abort`, `question-response`, `plan-response`, `ping`. See `server/index.js` `wss.on('connection')`.
- **Server → Client** streaming uses SSE at `GET /api/events?token=...`. WS is **not** used for streaming output back to the browser.
- This split exists so a client can drop/reconnect SSE (mobile backgrounding, network blips) and resume a streaming session without losing the in-flight Claude turn.

### Event bus + replay buffer
- `server/bus.js`: in-memory pub/sub keyed by `username`. All server-to-client events go through `publish(username, event)`.
- `server/broadcast.js`: per-`sessionId` ring buffer (1000 msgs / 5MB cap) used to **replay** missed messages when an SSE client (re)connects mid-stream. `replayBufferToSSE` is called for any session currently `streaming` on initial SSE connect.
- `server/session-registry.js`: in-memory map of `sessionId → {username, projectPath, status, ...}`. Outlives a single `query()` call. `getSessionsForUser` powers the initial `state-snapshot` event sent on SSE connect.
- Important: anything that should reach the client must go through `publish()` (for live delivery) AND `broadcastToSession()` (for replay buffering). `sendMessage()` in `server/claude.js` does both when a `sessionId` is present.

### Claude SDK integration (`server/claude.js`)
- Uses `@anthropic-ai/claude-agent-sdk` `query()` — **not** the raw Anthropic API. The SDK manages its own context, tool execution, and session resumption via the `resume` option.
- `canUseTool` callback intercepts two tools and routes them to the UI for human input:
  - `AskUserQuestion` → emits `{type:'question'}`, blocks in a promise stored in `pendingQuestionCallbacks` until the client posts `question-response` over WS.
  - `ExitPlanMode` → emits `{type:'plan-confirmation'}`, blocks via `pendingPlanConfirmations` until `plan-response` arrives. Rejection returns `behavior:'deny'` with user feedback so Claude can revise.
  - All other tools auto-allow.
- Permission mode mapping: client sends `'default' | 'plan' | 'bypass'` → SDK `'default' | 'plan' | 'bypassPermissions'`.
- Session history on resume: when a known `sessionId` is provided with `isNewSession=false`, the server reads `~/.claude/projects/<encoded-path>/<sessionId>*.jsonl` and prepends a `<conversation-history>` block to the prompt. The path encoding is `'-' + projectPath.slice(1).replace(/\//g, '-')`.
- MCP servers are loaded from `~/.claude.json` (`mcpServers` + `claudeProjects[projectPath].mcpServers`) on each query.
- Image attachments are written to `<projectPath>/.claude-uploads/upload-<uuid>.<ext>` and Claude is instructed to use `Read` on the relative path. Files are deleted in the `finally` block.

### Task tracking (`server/tasks.js`)
Every tool use creates a "task" that the UI surfaces as a pill/progress item. Lifecycle is wired in `transformMessage()`:
- Tool-use block → `taskManager.trackTaskStart` + `broadcastTaskUpdate('task-started')`, mapped by `toolUseId → taskId` in `toolUseToTaskMap`.
- Matching `tool_result` → `task-completed` or `task-failed` and mapping cleanup.

### Auth & storage
- SQLite via `better-sqlite3` at `~/.cleon-ui/auth.db`. On first startup, if `~/.claude-lite/` exists and `~/.cleon-ui/` does not, the directory is renamed (one-shot migration in `server/auth.js`).
- **Single-user system**: `POST /api/auth/register` is only allowed when zero users exist (checked by `hasUser()`). There is no admin UI to add more.
- `JWT_SECRET` is required in production (throws on startup if missing) and must be ≥32 chars. Dev falls back to a known-bad default with a warning.
- WebSocket auth: token passed as `?token=...` query param, validated in `verifyClient`. SSE uses the same scheme on `/api/events`.

### Frontend (`public/`)
Single-page vanilla JS. Three files:
- `index.html` — markup
- `app.js` (~4500 lines) — all client logic, WS+SSE handling, rendering
- `style.css` — neon-aesthetic theme

No build step. CSP in `server/index.js` permits inline styles, `cdn.jsdelivr.net` for scripts/styles (monaco-editor), and `data:`/`blob:` images.

### Production
PM2 entry at `ecosystem.config.cjs` reads `~/.claude/settings.json` `env` block at start time and forwards `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and the per-tier `ANTHROPIC_DEFAULT_*_MODEL` vars into the process env. Changing those settings requires a PM2 restart (settings are read once per spawn). CORS allows configured `ALLOWED_ORIGINS` plus localhost and RFC1918 ranges unconditionally.

## Project-specific gotchas
- The project path-to-Claude-projects-dir encoding is convention from Claude Code itself (`/home/x/foo` → `-home-x-foo`). When touching `loadSessionHistory` or anything in `server/projects.js`, preserve this.
- `activeSessions`, `pendingQuestionCallbacks`, `pendingPlanConfirmations`, `toolStartTimes`, `sessionModels`, `toolUseToTaskMap` are all module-level `Map`s in `server/claude.js`. They are **per-process** — this server is not safe to run multi-instance / clustered without externalizing state.
- Originally named "Claude Lite"; some legacy paths (`~/.claude-lite/`) still referenced for migration. Don't rename without preserving the migration code in `server/auth.js`.
- Specs live in two places: human-written design docs in `specs/`, and OpenSpec change proposals in `openspec/changes/`. The `architect/brainstorm*/` directories contain pre-spec ideation.
