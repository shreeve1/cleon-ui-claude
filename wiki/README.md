# Cleon UI LLM Wiki

This directory is an LLM-maintained knowledge base for Cleon UI engineering.

## Rules

- `raw/` is immutable source material.
- `candidates/` contains unpromoted generated pages.
- Promoted pages must be indexed in `index.md`; candidates must appear only in the candidate review queue.
- Important factual claims must be tracked in `CLAIMS.md`.
- All ingests, queries, lints, promotions, discards, and setup changes must be logged in `log.md`.

## Workflows

- Ingest: add source to `raw/`, summarize, discuss key takeaways when needed, extract claims, create candidates, update candidate index/routing/claims, and log.
- Session update: use `/wiki-update` to capture durable decisions, verified facts, and follow-ups from a session into raw session notes, candidates, claims, routing, index, and log.
- Query: read `index.md`, optionally use `ROUTING.md` to narrow scope, then read relevant promoted pages; cite sources.
- Lint: check broken links, orphan pages, stale claims, duplicates, missing concept pages, data gaps, and contradictions.
- Promote: after James approval, move candidate to final location, update index/routing/claims/log.
- Discard: remove stale candidate index rows, candidate routes, and candidate claim references, then log the discard.

## Source Policy

- Commit text raw sources by default.
- Ask before adding large, binary, private, generated, or externally stored raw sources.
- Do not install local search tooling, MCP servers, Obsidian plugins, or other wiki infrastructure without explicit approval.
