---
id: project.faber-memory.architecture
type: architecture
status: verified
last_updated: 2026-11-26
---

# FaberSEP Memory (`@fabersep/memory`) — Architecture

## 1. Design Principles

- **Zero runtime dependencies & zero native addons:** Pure TypeScript/Node (>=20) using Node built-ins (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:readline`).
- **Committed `HEAD` tree as sole source of truth:** Both L0 compilation and BM25 indexing read from Git `HEAD` (`git ls-tree` / `git show`), never from uncommitted working-tree files.
- **UUID-keyed local state:** Config lives at `~/.config/faber-memory/config.json` (overridable via `FABER_MEMORY_HOME`). Generated `MEMORY.md`, per-root `pre-memory/` proposals, and lockfiles live under `<stateDir>/` keyed by root UUID, keeping all Git repositories clean and allowing root relocation without losing state.
- **Prefix-cache-first:** Compiled L0 contains only deterministic `team` + `personal` entries (no dates, no pending counts, no absolute paths). Updates are written atomically (`tmp` + `rename` under lock) and take effect on the next session only; MCP never emits list-change notifications mid-session.

## 2. Module Layout

```text
src/
  types.ts        # Shared data types (Config, RootConfig, MemoryEntry, Proposal, etc.)
  config.ts       # User config load/save, state directory layout, UUID management, lockfile
  git.ts          # Safe Git helpers (init, clone, HEAD reading, ls-tree, worktree, pull --ff-only)
  frontmatter.ts  # Deterministic YAML frontmatter parser & serializer
  hygiene.ts      # Secret pattern & machine-specific path scanner with redaction
  store.ts        # Reading entries from HEAD, uncommitted-edit detection, project root resolution
  compiler.ts     # Deterministic L0 compiler, token estimator, duplicate-ID & budget guards, atomic write
  bm25.ts         # Pure-JS in-memory BM25 search index & near-duplicate similarity check
  proposals.ts    # pre-memory CRUD, collision-free IDs, awaiting_commit / push_failed lifecycle, batch approve
  sync.ts         # Non-blocking pull --ff-only with 5s timeout, dirty-clone refusal, recompile
  importer.ts     # Deterministic zero-LLM import (markdown-dir, claude-memory, agents-md, cursor-rules)
  init.ts         # Multi-engine delivery matrix, dry-run diff, managed blocks, .bak backup, --undo
  mcp.ts          # Stdio JSON-RPC 2.0 MCP server exposing exactly 3 tools (memory_search, memory_get, memory_propose)
  metrics.ts      # Privacy-first local append-only metrics.jsonl ledger, 90d/10MB pruning, non-blocking lock
  cache-logs.ts   # Opt-in read-only numeric prompt-cache log parser (Claude Code, Antigravity) & L0 correlation
  stats.ts        # Context efficiency, retrieval quality, entry temperature, funnel, and allowlist --share card
  doctor.ts       # Read-only 6-category health diagnostics (PASS/WARN/FAIL) with zero disk or Git index mutations
  cli.ts          # CLI entrypoint (init, compile, sync, review, approve, reject, status, stats, doctor, import, serve, config, reset)
  index.ts        # Public library exports
```

## 3. Data Flow

1. **Read / Search path:** MCP server checks `HEAD` SHA of each configured root on each tool call -> rebuilds in-memory BM25 index if any SHA changed -> returns L0/L1 summaries (`memory_search`) or L2 full content (`memory_get`).
2. **Write / Approval path:** Agent calls `memory_propose` -> hygiene scan + near-duplicate check -> writes proposal JSON/Markdown to `<stateDir>/pre-memory/<rootUuid>/<id>.json` -> human runs `faber-memory review` or `approve` -> hygiene re-scan -> applies per scope (solo commit / team throwaway worktree push or PR branch / project uncommitted `.faber/memory/` file) -> atomic L0 recompile.
