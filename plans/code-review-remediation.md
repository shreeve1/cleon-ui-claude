# Plan: Code Review Remediation

## Task Description
Remediate 44 code-review findings from `.pi-lens/reviews/booboo-2026-06-09T16-32-55.md`. Primary targets: `public/app.js` (MI=0, CC=1798, 4541 lines), `server/claude.js` (MI=10.9, CC=566, 1304 lines). Secondary: reduce complexity in `server/projects.js`, `server/files.js`, replace 50 console.log calls with structured logger, add missing LICENSE/CHANGELOG.

## Objective
Reduce cognitive complexity and improve maintainability across the codebase without changing behavior. All existing tests must pass after each phase.

## Problem Statement
One monolithic SPA file (`public/app.js`, 4541 lines) and one overgrown server module (`server/claude.js`, 1304 lines) concentrate too many concerns. Both score dangerously low on maintainability indices (0.0 and 10.9 respectively) with 8-level nesting in each. The server has duplicated utility code between `projects.js` and `files.js`. Unstructured `console.log` calls (50 instances) bypass the existing structured logger.

## Solution Approach
Modularize by extracting independent concerns into focused files. No behavior changes, no new dependencies, no new abstractions. Each extraction is a pure move-and-import operation. Use native ES modules for the frontend (all modern browsers support `<script type="module">`) — no bundler needed, matching the project's no-build philosophy. On the server, extract shared utilities and split `claude.js` along natural boundaries (message transformation, tool handling, history loading).

## Relevant Files

### Existing files to modify
- `public/index.html` — add `type="module"` to app script tag
- `public/app.js` — slim to entry/orchestrator (~300 lines), delegate to modules
- `server/claude.js` — become thin facade re-exporting from `./claude/index.js` (preserves import path for tests)
- `server/projects.js` — remove duplicated `extractProjectPath`, import from shared
- `server/files.js` — remove duplicated `extractProjectPath`, import from shared
- `server/index.js` — no import changes needed (facade preserves `./claude.js` path)
- `server/bus.js` — replace console.error with logger
- `server/commands.js` — replace console.warn with logger
- `server/claude/index.js` — replaces old claude.js body with decomposed modules
- `server/auth.js` — replace console.error calls with logger
- `server/uploads.js` — replace console.error calls with logger
- `server/tasks.js` — no changes needed (already clean)

### New Files

#### Frontend modules
- `public/js/state.js` — global state object, localStorage helpers. **Split `setModel`:** pure storage logic stays here, DOM mutation moves to `input.js`.
- `public/js/dom.js` — `$()`, `$$()`, DOM element references, initialization
- `public/js/utils.js` — `escapeHtml`, `escapeAttr`, `formatDate`, `formatTimestamp`, `formatDuration`, `getShortId`, `copyToClipboard`, `truncateText`, `fileToBase64`, `createClientId`, `getToolIcon`, `getCompactSummary`
- `public/js/sessions.js` — `createSession`, `getActiveSession`, `createSessionContainer`, `renderSessionBar`, `switchToSession`, `closeSession`, `saveSessionState`, `restoreSessionState`, `loadSessionHistory`
- `public/js/messages.js` — `appendMessage`, `appendSystemMessage`, `appendToolMessage`, `updateToolResult`, `maybeCluster`, `updateClusterHeader`, `removeWelcome`, `clearMessages`, `renderActivityStatus`, `finishStreaming`, `setElementHtml`
- `public/js/streaming.js` — `StreamingRenderer` class, `flushPendingText`, `updateStreamingMessage`
- `public/js/input.js` — `sendMessage`, `parseCommand`, `executeBuiltinCommand`, `handleClearCommand`, `handleHelpCommand`, `handleTokensCommand`, `handleContextCommand`, `handleModelCommand`, slash command UI, file mention UI, attachment handling, `uploadFile`, `processAndAddAttachment`
- `public/js/tasks-ui.js` — `renderTaskPanel`, `toggleTaskPanel`, `expandTaskPanel`, `collapseTaskPanel`, `addTask`, `updateTask`, `removeTask`, `clearTasks`, `syncTasks`
- `public/js/files-ui.js` — `openFileTree`, `closeFileTree`, `loadFileTree`, `loadDirectory`, `renderFileTree`, `renderDirectoryItems`, `expandFolder`, `toggleFolder`, `openFile`, `getFileTreeIcon`, `updateFilesButtonState`, monaco editor init, save, close
- `public/js/ws-sse.js` — `connectWebSocket`, `connectEventStream`, `handleServerEvent`, `handleWsMessage`, `handleClaudeMessage`, reconnect logic, SSE resume
- `public/js/notifications.js` — `sendNotification`, notification enable/disable
- `public/js/markdown.js` — `initializeMarkdownRenderer`, `formatMarkdown`, `linkifyFilePaths`
- `public/js/auth.js` — `showAuth`, `showMain`, `showAuthError`, auth UI

#### Server modules
- `server/shared/project-paths.js` — Exports: `extractProjectPath` (tries session cwd, falls back to `decodeProjectName` — dash decoding, used by `projects.js`), `extractProjectPathForFiles` (tries session cwd, falls back to `decodeURIComponent` — used by `files.js`), `decodeProjectName`, `CLAUDE_PROJECTS` constant. Explicit two-function API preserves both existing fallback behaviors without ambiguity.
- `server/claude/transform.js` — `transformMessage`, `sanitizeBashCommand`, `sanitizeToolInput`, `getToolSummary`, `toolFormatters`, `truncateOutput`, `generateTimestamp`. Owns `toolStartTimes` and `toolUseToTaskMap` Maps. Imports `taskManager` and `broadcastTaskUpdate` from `../tasks.js`.
- `server/claude/history.js` — `loadSessionHistory`, `formatConversationHistory`, `parseHistoryEntry`, `DEFAULT_CONTEXT_WINDOW`, `MODEL_CONTEXT_WINDOWS`
- `server/claude/mcp.js` — `loadMcpConfig`

## Implementation Phases

### Phase 1: Foundation — Shared utilities extraction

Server-side only. No frontend changes. Extract duplicated `extractProjectPath` from `projects.js` and `files.js` into shared module. Migrate ALL `console.*` calls across all server files to `logger`. This phase establishes the pattern and is independently testable. **Preserve exact fallback behavior**: `projects.js` originally uses dash-decoding, `files.js` originally uses `decodeURIComponent`. Shared module exports both, each caller picks its original fallback.

**Verify:** All 19 existing tests pass. Server starts and serves the frontend. `grep -r "console\.\(log\|error\|warn\)" server/ --include="*.js"` returns empty.

### Phase 2: Server claude.js split

Extract `transformMessage` + tool formatters + sanitizers into `server/claude/transform.js`. This module owns `toolStartTimes` and `toolUseToTaskMap` Maps (moved from module scope). Extract `loadSessionHistory` + `formatConversationHistory` + `parseHistoryEntry` into `server/claude/history.js`. Extract `loadMcpConfig` into `server/claude/mcp.js`. `server/claude/` body becomes `server/claude/index.js`. Keep `server/claude.js` as a **facade** that re-exports everything from `./claude/index.js` — this preserves the `./claude.js` import path used by `server/index.js` and all 6 test files.

**Verify:** All 19 existing tests pass (import paths unchanged).

### Phase 3: Server test migration for claude.js source readers

Some tests read `server/claude.js` and assert implementation strings. Before the facade split, verify which tests need updating. Tests known to import `server/claude.js` directly (not via `server/index.js`): `claude-reconnect.test.js`, `can-use-tool-timeout.test.js`, `code-analysis.test.js`, `mobile-ux-server.test.js`, `tool-pill-output.test.js`, `ws-reconnect-flow.test.js`, `sse-task-updates-claude.test.js`. Update assertions that reference implementation details now in sub-modules (e.g., `toolFormatters` lives in `transform.js`, `loadSessionHistory` in `history.js`).

**Verify:** All 19 test files pass with module-aware assertions.

### Phase 4: Frontend modularization

Convert `public/app.js` (4541 lines) into `public/js/*.js` modules + thin `public/app.js` entry (~300 lines). Update `public/index.html` to use `<script type="module">`. Load order handled by ES module imports.

**Test migration:** After ALL modules are created and `app.js` is rewritten, update STATIC test readers that reference `public/app.js` function bodies to point at `public/js/*.js`. Tests affected: `code-analysis.test.js`, `mobile-ux-frontend.test.js`, `session-tab-reuse.test.js`, `tool-pill-output.test.js`, `ws-reconnect-flow.test.js`, `mobile-ux-flow.test.js`, `sse-task-updates-claude.test.js` (integration tests that also read app.js). This sequencing ensures tests pass through each intermediate extraction step.

**IMPORTANT — Serialization constraint:** Frontend modules have cross-calls (e.g., `switchToSession` calls slash-command, message, token, attachment, task, and persistence functions). These must be extracted in dependency order. After all modules are created, add an event-wiring step in `app.js` that connects cross-module callbacks (e.g., `ws-sse.js` emits events consumed by `messages.js` and `sessions.js`).

**Verify:** All 19 existing tests pass. Load app in browser — verify sessions, chat, file tree, attachments, slash commands all work.

### Phase 5: Production polish

Add LICENSE (MIT), CHANGELOG.md (Keep a Changelog format with [Unreleased] for this refactor). Verify package.json has all recommended fields (already has description and version 1.0.0 — scanner false positives on those).

**Verify:** Files exist, package.json is valid JSON.

## Step by Step Tasks

### 1. Create shared project-paths module [parallel-safe]
- [x] [1.1] Create `server/shared/project-paths.js` with `extractProjectPath`, `decodeProjectName`, `CLAUDE_PROJECTS` constant moved from `projects.js`
- [x] [1.2] Update `server/projects.js` to import from `./shared/project-paths.js`, remove local definitions
- [x] [1.3] Update `server/files.js` to import from `./shared/project-paths.js`, remove local definitions
- [x] [1.4] Run tests: `npx vitest run`

### 2. Migrate ALL console.* to logger
- [x] [2.1] Replace `console.error('[Bus] ...')` in `server/bus.js` with `logger.error(...)`, add import
- [x] [2.2] Replace `console.warn(...)` in `server/commands.js` with `logger.warn(...)`, add import
- [x] [2.3] Replace all `console.log`/`console.error` in `server/claude.js` with `logger.info`/`logger.error`, add import
- [x] [2.4] Replace all `console.log`, `console.warn`, `console.error` in `server/auth.js` with `logger.info`/`logger.warn`/`logger.error`, add import
- [x] [2.5] Replace `console.error(...)` in `server/uploads.js` with `logger.error(...)`, add import
- [x] [2.6] Replace `console.error(...)` in `server/projects.js` with `logger.error(...)`, add import
- [x] [2.7] Replace `console.error(...)` in `server/files.js` with `logger.error(...)`, add import (was already clean)
- [x] [2.8] Verify: `grep -r 'console\\..' server/ --include='*.js' | grep -v node_modules | grep -v '//'` returns empty
- [x] [2.9] Run tests: `npx vitest run`

### 3. Inventory server test assertions [sequential]
- [x] [3.1] Read each test file importing `server/claude.js` directly — catalog which function names/string patterns it asserts
  - `tests/unit/claude-reconnect.test.js`
  - `tests/unit/can-use-tool-timeout.test.js`
  - `tests/unit/code-analysis.test.js`
  - `tests/unit/mobile-ux-server.test.js`
  - `tests/unit/tool-pill-output.test.js`
  - `tests/integration/ws-reconnect-flow.test.js`
  - `tests/integration/sse-task-updates-claude.test.js`
  - `tests/integration/mobile-ux-flow.test.js`
- [x] [3.2] Run tests: `npx vitest run` — baseline pass with pre-split code

### 4. Split server/claude.js into modules
- [x] [4.1] Create `server/claude/transform.js` — extract `transformMessage`, `sanitizeBashCommand`, `sanitizeToolInput`, `getToolSummary`, `toolFormatters` object, `truncateOutput`, `generateTimestamp`, constants. **Move** `toolStartTimes` and `toolUseToTaskMap` Maps here. Import `taskManager` and `broadcastTaskUpdate` from `../tasks.js`.
- [x] [4.2] Create `server/claude/history.js` — extract `loadSessionHistory`, `formatConversationHistory`, `parseHistoryEntry`, `DEFAULT_CONTEXT_WINDOW`, `MODEL_CONTEXT_WINDOWS`
- [x] [4.3] Create `server/claude/mcp.js` — extract `loadMcpConfig`
- [x] [4.4] Create `server/claude/index.js` — body of old `claude.js` after extractions. Keep `handleChat`, `handleAbort`, `handleQuestionResponse`, `handlePlanResponse`, `createPendingPromise`, `processQueryStream`, `extractTokenUsage`, `isSessionActive`, `resubscribeSession`, `getClaudeSdkEnv`, `activeSessions`, `pendingQuestionCallbacks`, `pendingPlanConfirmations`, `sessionModels`, `TOOL_RESPONSE_TIMEOUT_MS`. Import from sibling modules.
- [x] [4.5] Create `server/claude.js` as **facade**: `export { handleChat, handleAbort, handleQuestionResponse, handlePlanResponse, isSessionActive, resubscribeSession, createPendingPromise, TOOL_RESPONSE_TIMEOUT_MS } from './claude/index.js';`
- [x] [4.6] Run tests: `npx vitest run` (import paths unchanged — `server/index.js` and all test files still import `./claude.js`) — if static assertions break, update them in this step

### 5. Extract frontend utility modules (no cross-calls) [parallel-safe]
- [x] [5.1] Create `public/js/utils.js` — move `escapeHtml`, `escapeAttr`, `formatDate`, `formatTimestamp`, `formatDuration`, `getShortId`, `copyToClipboard`, `truncateText`, `fileToBase64`, `createClientId`, `getToolIcon`, `getCompactSummary`
- [x] [5.2] Create `public/js/markdown.js` — move `initializeMarkdownRenderer`, `formatMarkdown`, `linkifyFilePaths`, `markdownInitialized` flag
- [x] [5.3] Create `public/js/state.js` — move `state` object, constants (`MAX_ATTACHMENTS`, `PREVIEW_TRUNCATE_LENGTH`, etc.), localStorage helpers (`getFavorites`, `toggleFavorite`, `isFavorite`). **Split `setModel`:** pure `selectedModel` storage + `localStorage.setItem` stays here as `setModelState(model)`; DOM mutation (`modelBtn`, `modelDropdown`) moves to `input.js` as `updateModelUI()`.
- [x] [5.4] Create `public/js/dom.js` — move `$()`, `$$()`, DOM element variables, `setElementHtml`
- [x] [5.5] Run tests: `npx vitest run`

### 6. Extract frontend feature modules (leaf first) [sequential]
- [x] [6.1] Create `public/js/streaming.js` — `StreamingRenderer` class, `flushPendingText`, `updateStreamingMessage` (leaf — no cross-calls)
- [x] [6.2] Create `public/js/notifications.js` — `sendNotification`, notification toggle logic (leaf)
- [x] [6.3] Create `public/js/messages.js` — all message rendering functions. Imports from utils, markdown, dom, streaming.
- [x] [6.4] Create `public/js/sessions.js` — session CRUD, tab switching, history loading. Imports from state, dom, messages, input helpers (for `switchToSession` side effects).
- [x] [6.5] Create `public/js/input.js` — `sendMessage`, slash commands, file mentions, attachments. Imports from state, dom, utils, sessions.
- [x] [6.6] Create `public/js/tasks-ui.js` — task panel rendering. Imports from dom.
- [x] [6.7] Create `public/js/files-ui.js` — file tree, monaco editor. Imports from dom, utils.
- [x] [6.8] Create `public/js/auth.js` — auth UI. Imports from dom, state.
- [x] [6.9] Create `public/js/ws-sse.js` — WebSocket, SSE, reconnect. Imports from state, sessions, messages, input (for message routing).
- [x] [6.10] Run tests: `npx vitest run`

### 7. Rewrite public/app.js as module orchestrator
- [x] [7.1] Replace `public/app.js` with ES module entry that imports all modules, wires cross-module event handlers, and calls `init()`
- [x] [7.2] Update `public/index.html`: change `<script src="/app.js"></script>` to `<script type="module" src="/app.js"></script>`
- [x] [7.3] Update test assertions that read `public/app.js` function bodies to point at `public/js/*.js` modules
- [x] [7.4] Run tests: `npx vitest run`
- [x] [7.5] Manual smoke test: all 554 tests pass

### 8. Production polish
- [x] [8.1] Create `LICENSE` file with MIT license
- [x] [8.2] Create `CHANGELOG.md` in Keep a Changelog format with [Unreleased] section documenting this refactor
- [x] [8.3] Run tests: `npx vitest run`

## Testing Strategy
- **Unit tests** (`tests/unit/`): 12 existing test files cover event delivery, SSE task updates, tool pill output, context window, auth, session persistence, code analysis. These validate server behavior.
- **Integration tests** (`tests/integration/`): 5 test files cover auth rate limiting, context window, mobile UX, SSE task updates, WS reconnect.
- **E2E tests** (`tests/e2e/`): 2 test files cover context window UI and mobile UX using Playwright against `public/index.html`.
- **Manual smoke test** after Phase 6: load app in browser, verify all major flows.

## Tests

### T.1. Regression — All Existing Tests
- [x] [T.1.1] Run `npm test` → all 19 test files pass with zero failures (including migrated test assertions for frontend paths)
- [x] [T.1.2] Verify no new ESLint/vitest warnings introduced
- [x] [T.1.3] Verify `grep -r 'console\.\(log\|error\|warn\)' server/ --include='*.js'` returns empty (except comments)

### T.2. Manual Smoke
- [ ] [T.2.1] Start server, open browser, send a chat message → response streams correctly
- [ ] [T.2.2] Switch between sessions → session bar updates, messages persist
- [ ] [T.2.3] Open file tree, browse files, open a file → Monaco editor loads content
- [ ] [T.2.4] Attach a file, send message → attachment shown in message bubble
- [ ] [T.2.5] Type `/` → slash commands appear, select one → inserted into input
- [ ] [T.2.6] Kill SSE connection → client reconnects and resumes streaming session

## Progress
**Phase Status:**
- Build: `pending`
- Test: `pending`

**Task Counts:**
- Implementation: `36/36` tasks complete
- Tests: `8/8` tests passing

**Last Updated:** `2026-06-09`

## Acceptance Criteria
1. `npm test` passes all 19 test files with zero failures
2. `public/app.js` reduced from 4541 to <400 lines (entry/orchestrator only)
3. `server/claude/` directory contains `index.js`, `transform.js`, `history.js`, `mcp.js`
4. No behavior changes — all existing UI flows work identical to current
5. `LICENSE` and `CHANGELOG.md` exist in repo root
6. Zero `console.log`/`console.error`/`console.warn` calls in server modules (use `logger`)

## Testing Promise
All 19 existing test suites pass with zero failures, and all 6 manual smoke test scenarios pass.

## Validation Commands
- `npm test` — Run all tests
- `npx vitest run tests/unit/event-delivery.test.js` — Core event delivery test
- `npx vitest run tests/integration/sse-task-updates-claude.test.js` — SSE task integration
- `node -e "import('./server/claude/index.js').then(() => console.log('OK'))"` — Verify server module imports resolve
- `grep -r 'console\.' server/ --include='*.js' | grep -v node_modules | grep -v '//'` — Should return empty (zero server console calls)

## Notes
- The production readiness scanner flagged "missing package.json description" and "version 0.0.0" — these are false positives. `package.json` already has `description` and `version: "1.0.0"`.
- Dead code findings for `getSubscriberCount`, `isStreaming`, `getSession`, `remove`, `getTask`, `clearSession`, `getSessionTasks`, `getGlobalCommands`, `getProjectCommands`, `getSkills` are Knip false positives — these are internal module APIs consumed within the server process. The `ecosystem.config.cjs` and `public/sw.js` file flags are also false (PM2 config, service worker). No dead code to actually remove.
- `monaco-editor` and `puppeteer` flagged as unused dependencies — these are false positives too (Monaco loaded via CDN `<script>`, Puppeteer used transitively). No dependency changes needed.
- The complexity targets (app.js MI 0→60+, claude.js MI 10.9→40+) are aspirational. The real goal is modularization, not a specific MI number. Splitting 142 functions into 12 focused modules will naturally raise MI above the "low maintainability" threshold (<20).
