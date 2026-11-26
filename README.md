# FaberSEP Memory (`@fabersep/memory`)

> Layer 0 of the FaberSEP engineering context stack (`@fabersep/memory` -> `@fabersep/spec` -> `@fabersep/atlas`).

Prefix-cache-first, Git-backed Markdown memory for AI coding agents — with deterministic L0 compilation, read-only active memory + `pre-memory` human approval, a 3-tool pure-JS BM25 MCP server, and deterministic zero-LLM import.

## Why

- **Committed Markdown in Git (`HEAD`) is the sole source of truth** — zero databases, zero native addons, zero runtime dependencies.
- **Prefix-cache-first L0 compilation** — compiles active `team` + `personal` entries into a deterministic, uncommitted `MEMORY.md` in your local state directory (no dates, no pending counts, no machine paths, hard 1,500-token budget).
- **Read-only active memory for agents** — agents propose changes via `memory_propose` into UUID-keyed `pre-memory`; humans `review`, `approve` (batched into one commit/push/recompile), or `reject`.
- **3 lean MCP tools** — `memory_search`, `memory_get`, `memory_propose` with pure-JS in-memory BM25 search and automatic `HEAD`-change reindexing.

## Quickstart

```bash
# 1. Initialize a personal memory folder (auto-git)
npx @fabersep/memory setup ~/.faber/memory

# 2. Preview multi-engine wiring (dry-run by default), then apply
npx @fabersep/memory init
npx @fabersep/memory init --apply

# 3. Import existing Markdown or Claude auto-memory (zero LLM)
npx @fabersep/memory import --from markdown-dir ./notes
npx @fabersep/memory review
```

## CLI Commands

- `faber-memory setup [path]` / `setup --team <git-url>` — Initialize solo or team root.
- `faber-memory init [--apply | --undo] [--engine ...] [--project-hint]` — Non-destructive user-level wiring with `.bak` backup.
- `faber-memory compile [--check]` — Deterministically compile L0 or run CI validation (schema, duplicates, budget, hygiene).
- `faber-memory sync` — Pull remote updates (`--ff-only`) and recompile L0.
- `faber-memory status` — Show roots, project root source, uncommitted warnings, pending & stale proposals.
- `faber-memory review` / `approve <id>` / `reject <id>` — Human approval workflow (solo commit, team throwaway worktree direct push or PR fallback, project uncommitted file).
- `faber-memory import --from <markdown-dir|claude-memory|agents-md|cursor-rules> <path>` — Deterministic migration into `pre-memory`.
- `faber-memory serve` — Run the 3-tool stdio MCP server.

## License

Apache-2.0
