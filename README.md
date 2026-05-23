# Cleon UI

Mobile-first web UI for Claude Code sessions. Cleon UI runs as a small Node/Express server and serves a vanilla-JS single-page app with WebSocket input, SSE output streaming, session replay, file browsing, uploads, model selection, and single-user auth.

## Features

- Remote Claude Code access from desktop or mobile browser
- Single-user registration and JWT login
- Project/session discovery from `~/.claude/projects/`
- New and resumed Claude SDK sessions
- WebSocket client input for chat, abort, questions, and plan approval
- SSE server output with replay buffer for reconnects
- File browser/editor for project files
- Image, text, markdown, and PDF attachment support
- Slash commands from global and project command files
- Model picker for Haiku, Sonnet, and Opus tiers
- PM2 production config

## Requirements

- Node.js 18+
- npm
- Claude Code / Anthropic credentials available to the Claude Agent SDK
- `JWT_SECRET` with at least 32 characters for production

## Install

```bash
git clone git@github.com:shreeve1/cleon-ui-claude.git
cd cleon-ui-claude
npm ci
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
JWT_SECRET=change-this-to-a-random-secure-string-at-least-32-chars
```

### Authentication with Anthropic

Cleon UI uses the Claude Agent SDK, which supports two authentication methods (in priority order):

1. **OAuth (default, recommended)**: SDK reads tokens from `~/.anthropic/auth.json` (same as system Claude Code)
2. **API Key**: Set `ANTHROPIC_AUTH_TOKEN` environment variable or add to `~/.claude/settings.json` `env` section

**When running via PM2**, the config intentionally excludes `ANTHROPIC_AUTH_TOKEN` from settings injection, ensuring OAuth is used by default. If you need API key auth, set it directly in your shell environment or `.env` file before starting PM2.

## Run

Development:

```bash
npm run dev
```

Production without PM2:

```bash
npm start
```

Default bind:

```text
http://localhost:3010
http://<LAN-IP>:3010
```

`HOST` defaults to `0.0.0.0`, so LAN clients can connect when host/network firewall rules allow port `3010`.

## PM2

Start or restart with the repository PM2 config:

```bash
npm run pm2
```

Useful commands:

```bash
pm2 status cleon-ui
pm2 logs cleon-ui
pm2 restart cleon-ui
pm2 save
```

Enable startup after reboot:

```bash
pm2 startup systemd -u "$USER" --hp "$HOME"
pm2 save
```

`ecosystem.config.cjs` starts one forked process named `cleon-ui` on `0.0.0.0:3010`. It reads `~/.claude/settings.json` at process start and forwards supported Anthropic environment values (base URL, model overrides) into PM2, **excluding** `ANTHROPIC_AUTH_TOKEN`. This allows the Claude SDK to use OAuth from `~/.anthropic/auth.json`, matching the system Claude Code authentication. Restart PM2 after changing settings.

## Configuration

Environment variables:

| Name | Default | Notes |
| --- | --- | --- |
| `PORT` | `3010` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | unset | `production` requires `JWT_SECRET` |
| `JWT_SECRET` | none | Required in production, minimum 32 chars |
| `ALLOWED_ORIGINS` | none | Comma-separated extra origins |
| `CONTEXT_WINDOW` | model default / `200000` fallback | Token usage fallback |
| `LOG_LEVEL` | `info` | Winston log level |

Localhost, same-host origins, and RFC1918 LAN IP origins are allowed automatically. Add public domains to `ALLOWED_ORIGINS`.

## Data

- Auth database: `~/.cleon-ui/auth.db`
- Claude journals: `~/.claude/projects/`
- Legacy migration: `~/.claude-lite/` is renamed to `~/.cleon-ui/` on first startup when needed
- Temporary uploads: `<project>/.claude-uploads/`, removed after each request finishes

This is a single-user app. Registration is only allowed before the first account exists.

## Architecture

```text
public/
  index.html       SPA markup
  app.js           UI, WebSocket, SSE, rendering, editor
  style.css        neon theme
  sw.js            unregisters legacy service workers
server/
  index.js         Express, middleware, routes, WS, SSE
  auth.js          single-user auth and JWT validation
  claude.js        Claude Agent SDK integration
  projects.js      Claude project/session discovery
  files.js         file tree, read, write APIs
  uploads.js       attachment validation and processing
  bus.js           per-user event pub/sub
  broadcast.js     per-session replay buffer
  session-registry.js
  tasks.js         tool task lifecycle tracking
```

Transport model:

- Browser to server: WebSocket upgrade at `/`
- Server to browser: SSE at `/api/events?token=...`
- Replay: `server/broadcast.js` buffers recent session events for reconnecting SSE clients

Claude integration uses `@anthropic-ai/claude-agent-sdk` `query()`. The server passes through model and permission mode choices, intercepts `AskUserQuestion` and `ExitPlanMode`, and routes those prompts back to the browser.

## API

Public:

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/register`
- `POST /api/auth/login`

Authenticated:

- `GET /api/projects/search?q=...`
- `GET /api/projects/:name/path`
- `GET /api/projects/:name/sessions`
- `GET /api/projects/:name/sessions/:sessionId/messages`
- `GET /api/projects/:name/files/search?q=...`
- `GET /api/files/:project/tree`
- `GET /api/files/:project/ls?path=...`
- `GET /api/files/:project/*`
- `PUT /api/files/:project/*`
- `GET /api/commands?projectPath=...`
- `POST /api/upload`
- `GET /api/events?token=...`

WebSocket messages:

- `chat`
- `abort`
- `question-response`
- `plan-response`
- `ping`

## Tests

```bash
npm test
npx vitest run tests/unit/sse-task-updates.test.js
```

E2E tests under `tests/e2e/` use Playwright and load `public/index.html` with `file://`; they do not require the server.

## Troubleshooting

If login fails after restart, clear browser local storage and confirm `JWT_SECRET` did not change.

If the UI reports HTML where JSON was expected, confirm you are opening the app with port `3010` and refresh once to clear any old service worker cache.

If LAN clients cannot connect, check that the server is listening on `0.0.0.0:3010` and that host/network firewall rules allow the port.

```bash
curl http://127.0.0.1:3010/api/health
curl http://<LAN-IP>:3010/api/health
```

## License

MIT
