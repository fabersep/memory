# Changelog

All notable changes to `@fabersep/memory`. Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.1 (unreleased)

### Fixed
- Docs pointed to `~/.faber/memory-state/` for config and state; the real location is `~/.config/faber-memory/`.
- The MCP server reported version `0.1.0` and the compiled L0 header said `v0.1.0`; both now use the package version.
- `import --split-headings` no longer creates an empty entry for a title heading that has only sub-headings under it.

### Added
- `--version` (also `-v`, `version`).
- The `init` instruction block for Claude Code and Antigravity now tells the agent when to call `memory_propose`; the `memory_propose` tool description says the same for MCP-only engines. Re-run `init` to pick it up.
- `import` ends with a `NOT imported: N item(s)` line when the hygiene check leaves items out.
- `docs/guide.md` (technical guide and full command reference), `CHANGELOG.md`, `CONTRIBUTING.md` and a CI test workflow.

### Changed
- **`setup` is optional for solo use:** `init` creates `~/.faber/memory` when no memory is configured, and `init <folder>` puts it in a folder you choose. `setup` still works, and team mode still starts with `setup --team`.
- Flags that take no value (`--preview`, `--apply`, `--json`, …) no longer swallow the next argument, so `init --preview ~/notes` works.
- **`init` now applies by default** (with `.bak` backups and `--undo`). Use `init --preview` (alias `--dry-run`) to see the diff only. `--apply` still works as an alias.
- The README is now a plain-language, story-first introduction; technical detail moved to `docs/guide.md`.

## 0.2.0 (2026-11-27)

- Local metrics ledger, `stats` (context size, retrieval, proposal funnel), `stats --cache` (prompt-cache hit rate from local engine logs), `stats --share` (anonymized benchmark card) and the read-only `doctor` checklist. Spec: `docs/features/02-metrics-and-stats`.

## 0.1.1 (2026-11-26)

- CLI UX: review progress line, back and view keys, quit-and-save, `reject --all`, `config unset`, `reset`, team URL shorthands, `--normalize-paths`, troubleshooting guide.

## 0.1.0 (2026-11-26)

- Core: Git-backed Markdown memory with `personal`, `team` and `project` scopes, deterministic L0 compiler, 3-tool BM25 MCP server, `pre-memory` review, hygiene scan, multi-engine `init` and zero-LLM `import`. Spec: `docs/features/01-core-memory`.
