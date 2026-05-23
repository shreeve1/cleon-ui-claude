# Wiki Log

Append entries with this format:

## [YYYY-MM-DD] type | Title

- Actor: agent or human
- Inputs: paths or prompt summary
- Outputs: changed pages
- Notes: key decisions or unresolved questions

## [2026-05-22] setup | Initialize Cleon UI LLM Wiki

- Actor: agent
- Inputs: user setup request; `README.md`; `CLAUDE.md`; `CONTEXT.md`
- Outputs: `wiki/README.md`; `wiki/index.md`; `wiki/log.md`; `wiki/ROUTING.md`; `wiki/CLAIMS.md`; `CLAUDE.md`; `AGENTS.md`
- Notes: Fresh setup. Domain: Cleon UI engineering. Expected sources: docs/specs and codebase notes. Generated wiki files should be committed. Candidate promotion requires James approval. Citations use file path plus heading. Raw text sources should be committed by default; no `.gitignore` changes made.

## [2026-05-23] ingest | Ingest README

- Actor: agent
- Inputs: `wiki/raw/README.md` copied from `README.md`
- Outputs: `wiki/raw/README.md`; `wiki/candidates/source-readme.md`; `wiki/index.md`; `wiki/ROUTING.md`; `wiki/CLAIMS.md`; `wiki/log.md`
- Notes: Created candidate source summary and C-0001 through C-0009. Candidate is discoverable but not promoted; James approval required before promotion.
