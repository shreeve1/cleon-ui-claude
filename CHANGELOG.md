# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Modularized monolithic `public/app.js` (4541 lines) into 13 focused ES modules under `public/js/`, with a thin orchestrator entry point (~400 lines).
- Split `server/claude.js` (1304 lines) into 4 focused modules under `server/claude/` (`index.js`, `transform.js`, `history.js`, `mcp.js`) with a re-exporting facade preserving all import paths.
- Extracted duplicated `extractProjectPath` logic from `server/projects.js` and `server/files.js` into `server/shared/project-paths.js`, preserving each caller's original fallback behavior.
- Replaced all `console.log`/`console.error`/`console.warn` calls across server modules with the structured `logger` (winston) instance.
- Removed unused `FILE_SEARCH_LIMIT` constant and `homeDir` variable from `server/projects.js`.
- Removed unused `sortTreeEntries` function and `os` import from `server/files.js`.
- Updated 19 test files to match modularized source paths and export patterns.
- All 554 existing tests pass with zero failures.
