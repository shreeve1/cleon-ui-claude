# AGENTS.md

This file supplements `CLAUDE.md` for agents that prefer `AGENTS.md`.

## Project Guidance

- Read `CLAUDE.md` for commands, architecture, project-specific gotchas, and test notes.
- Preserve existing project guidance unless James explicitly approves removal.
- Prefer small, cited updates to project memory over broad rewrites.

## LLM Wiki

This project uses `wiki/` as an LLM-maintained knowledge base for Cleon UI engineering.

### Directories

- `wiki/raw/`: immutable source material; read but do not rewrite.
- `wiki/raw/sessions/`: curated session captures created by `/wiki-update` when conversation evidence needs citation.
- `wiki/raw/assets/`: source attachments clipped with raw material.
- `wiki/candidates/`: generated pages awaiting James review or promotion.
- `wiki/sources/`: promoted source summaries.
- `wiki/entities/`: promoted entity pages.
- `wiki/concepts/`: promoted concept pages.
- `wiki/analyses/`: promoted query outputs and syntheses.
- `wiki/assets/`: generated or wiki-native images and attachments.

### Required Files

- Read `wiki/index.md` first when answering wiki-backed questions.
- Use `wiki/ROUTING.md` after `wiki/index.md` to narrow broad searches.
- Append every ingest, query, lint, promotion, and discard to `wiki/log.md`.
- Track important factual claims in `wiki/CLAIMS.md`.

### Wiki-First Project Search

For any project-specific question, investigation, design task, bug hunt, or code search that requires looking up project context, check the wiki first.

1. Read `wiki/index.md` before searching broadly.
2. Use `wiki/ROUTING.md` to identify relevant promoted pages, candidates, and claim entries.
3. Read relevant wiki pages and `wiki/CLAIMS.md` entries before using general repository search.
4. If the wiki does not contain enough information, search the codebase, docs, or external sources as needed.
5. When non-wiki search reveals durable project knowledge, propose ingesting the source into `wiki/raw/`, creating or updating a page in `wiki/candidates/`, or promoting an existing candidate after James approves.
6. If external or codebase search was needed to answer a wiki-backed question, mention the wiki gap and proposed ingest or promotion path in the final answer.

### Session Update Workflow

Use `/wiki-update` during or after meaningful sessions to capture durable decisions, verified facts, root causes, follow-ups, and reusable context. Create curated raw session captures under `wiki/raw/sessions/` when conversation evidence is needed. Do not archive full transcripts, secrets, private material, or raw pasted user content without explicit approval. New or risky session-derived knowledge goes through `wiki/candidates/` and must update `wiki/index.md`, `wiki/ROUTING.md`, `wiki/CLAIMS.md`, and `wiki/log.md`.

### Ingest Workflow

1. Read the new source from `wiki/raw/`.
2. Summarize the source with citations to the raw path.
3. Discuss key takeaways or emphasis with James when the source is substantial, ambiguous, or likely to touch multiple pages.
4. Extract entities, concepts, contradictions, and atomic claims.
5. Create new pages in `wiki/candidates/` unless the edit is low-risk maintenance.
6. Update `wiki/index.md` candidate queue, `wiki/ROUTING.md`, and `wiki/CLAIMS.md` with cited candidate entries.
7. Append an entry to `wiki/log.md`.

### Query Workflow

1. Read `wiki/index.md` to identify relevant promoted pages and candidates.
2. Use `wiki/ROUTING.md` to narrow branches when the index is too broad.
3. Read only the relevant promoted pages and claim entries.
4. Answer with citations to wiki pages or raw sources.
5. If the answer produces durable synthesis, offer to save it as `wiki/candidates/<slug>.md`.

### Promotion Workflow

1. Review the candidate page for citations, confidence, and duplicates.
2. Confirm James approved promotion.
3. Move it to `sources/`, `entities/`, `concepts/`, or `analyses/`.
4. Set `status: promoted` and update timestamps.
5. Update `index.md`, `ROUTING.md`, `CLAIMS.md`, and `log.md`.

### Discard Workflow

When a candidate is rejected, remove its candidate index row, candidate-only routes, and candidate claim references before deleting the candidate file. Append a discard entry to `wiki/log.md`.

### Lint Workflow

Check broken wikilinks, orphan pages, duplicate concepts, uncited claims, stale claims, contradictions, missing concept pages, data gaps, stale candidate references, and missing index/routing entries. Report findings before making broad changes.
