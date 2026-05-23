---
title: README Source Summary
type: source-summary
status: candidate
created: 2026-05-23
updated: 2026-05-23
sources:
  - wiki/raw/README.md
confidence: high
tags: [readme, overview, operations]
---

# README Source Summary

## Source

- Raw source: `wiki/raw/README.md`
- Original project file: `README.md`
- Ingested: 2026-05-23

## Summary

`README.md` is the public baseline for Cleon UI. It defines Cleon UI as a mobile-first web UI for Claude Code sessions, implemented as a small Node/Express server plus vanilla-JS SPA with WebSocket input, SSE output streaming, session replay, file browsing, uploads, model selection, and single-user auth. Citation: `wiki/raw/README.md#cleon-ui`.

It also documents setup, runtime, PM2 operation, environment variables, data locations, API routes, transport model, testing commands, and troubleshooting checks. Citations: `wiki/raw/README.md#install`, `wiki/raw/README.md#run`, `wiki/raw/README.md#pm2`, `wiki/raw/README.md#configuration`, `wiki/raw/README.md#data`, `wiki/raw/README.md#api`, `wiki/raw/README.md#tests`, `wiki/raw/README.md#troubleshooting`.

## Key Facts

- Cleon UI is for remote desktop/mobile access to Claude Code sessions and includes single-user JWT auth, project/session discovery, new/resumed Claude SDK sessions, WebSocket input, SSE output replay, file editing, attachments, slash commands, model picker, and PM2 config. Citation: `wiki/raw/README.md#features`.
- Production requires `JWT_SECRET` with at least 32 characters; the app also needs Node.js 18+, npm, and Claude Code / Anthropic credentials available to the Claude Agent SDK. Citation: `wiki/raw/README.md#requirements`.
- Development starts with `npm run dev`; production without PM2 starts with `npm start`; default access is `localhost:3010` and LAN IP on port `3010` because `HOST` defaults to `0.0.0.0`. Citation: `wiki/raw/README.md#run`.
- The PM2 config starts one forked process named `cleon-ui` on `0.0.0.0:3010` and reads supported Anthropic env values from `~/.claude/settings.json` at process start. Citation: `wiki/raw/README.md#pm2`.
- The auth database lives at `~/.cleon-ui/auth.db`; Claude journals live at `~/.claude/projects/`; legacy `~/.claude-lite/` migrates to `~/.cleon-ui/` on first startup when needed. Citation: `wiki/raw/README.md#data`.
- Browser-to-server transport is WebSocket upgrade at `/`; server-to-browser transport is SSE at `/api/events?token=...`; replay uses buffered session events for reconnecting SSE clients. Citation: `wiki/raw/README.md#architecture`.
- Claude integration uses `@anthropic-ai/claude-agent-sdk` `query()` and intercepts `AskUserQuestion` plus `ExitPlanMode` to route those prompts back to the browser. Citation: `wiki/raw/README.md#architecture`.
- E2E tests under `tests/e2e/` use Playwright and load `public/index.html` by `file://`; they do not require the server. Citation: `wiki/raw/README.md#tests`.

## Entities And Concepts

- Entities: Cleon UI, Claude Code, Claude Agent SDK, PM2, Claude journals, auth database.
- Concepts: WebSocket Input, SSE output streaming, session replay, single-user auth, Project/session discovery, model tiers, file browser/editor, attachment handling.

## Use This For

- Answering onboarding questions about what Cleon UI does.
- Locating basic run/test/PM2 commands before reading deeper code or `CLAUDE.md`.
- Grounding API and transport terminology before ingesting architecture-specific sources.

## Claims

- C-0001 through C-0008 in `wiki/CLAIMS.md` come from this source summary.
