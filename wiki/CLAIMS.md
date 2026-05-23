# Claims Registry

Track important factual claims that need explicit provenance.

| ID | Claim | Source | Page | Confidence | Status | Notes |
|----|-------|--------|------|------------|--------|-------|
| C-0001 | Cleon UI is a mobile-first web UI for Claude Code sessions implemented as a small Node/Express server with a vanilla-JS SPA. | `wiki/raw/README.md#cleon-ui` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0002 | Cleon UI features include single-user JWT auth, project/session discovery, new and resumed Claude SDK sessions, WebSocket input, SSE output replay, file editing, attachments, slash commands, model picker, and PM2 config. | `wiki/raw/README.md#features` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0003 | Runtime requirements include Node.js 18+, npm, Claude Code or Anthropic credentials available to the Claude Agent SDK, and a production `JWT_SECRET` of at least 32 characters. | `wiki/raw/README.md#requirements` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0004 | Development starts with `npm run dev`; production without PM2 starts with `npm start`; default access is port `3010` on localhost or LAN because `HOST` defaults to `0.0.0.0`. | `wiki/raw/README.md#run` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0005 | The PM2 config starts one forked process named `cleon-ui` on `0.0.0.0:3010` and reads supported Anthropic environment values from `~/.claude/settings.json` at process start. | `wiki/raw/README.md#pm2` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0006 | The auth database lives at `~/.cleon-ui/auth.db`, Claude journals live at `~/.claude/projects/`, and legacy `~/.claude-lite/` migrates to `~/.cleon-ui/` on first startup when needed. | `wiki/raw/README.md#data` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0007 | Browser-to-server transport uses WebSocket upgrade at `/`; server-to-browser transport uses SSE at `/api/events?token=...`; replay buffers recent session events for reconnecting SSE clients. | `wiki/raw/README.md#architecture` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0008 | Claude integration uses `@anthropic-ai/claude-agent-sdk` `query()` and intercepts `AskUserQuestion` and `ExitPlanMode` to route those prompts back to the browser. | `wiki/raw/README.md#architecture` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |
| C-0009 | E2E tests under `tests/e2e/` use Playwright and load `public/index.html` by `file://`; they do not require the server. | `wiki/raw/README.md#tests` | `wiki/candidates/source-readme.md` | high | candidate | README ingest. |

Claim IDs use the next available zero-padded integer in `C-0001` format. Before adding claims, scan existing `C-####` IDs in this file, find the maximum, and increment by one for each new claim.

## Status Values

- `active`: current claim.
- `candidate`: claim tied to an unpromoted candidate page.
- `contradicted`: claim conflicts with another cited claim.
- `superseded`: claim has been replaced; notes must point to newer claim ID.
