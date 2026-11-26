---
id: project.faber-memory.master-prd
type: master-prd
status: approved
last_updated: 2026-11-26
---

# FaberSEP Memory (`@fabersep/memory`) — Master PRD

## 1. Product Vision

`@fabersep/memory` is Layer 0 of the FaberSEP engineering context stack (`@fabersep/memory` -> `@fabersep/spec` -> `@fabersep/atlas`). It gives solo developers and engineering teams a single, engine-agnostic, Git-backed Markdown memory layer that maximizes LLM prompt-cache reuse while keeping active memory strictly read-only for AI agents.

## 2. Personas

- **Solo Developer:** Uses multiple AI coding engines (Claude Code/Desktop, Antigravity, Cursor, Codex) across projects and wants one portable, Git-versioned personal memory without database overhead.
- **Engineering Team Member:** Shares team-wide architectural decisions and rules via a private Git repository, using PR review and CI checks (`compile --check`) as the governance gate.
- **AI Coding Agent:** Reads a stable L0 prefix at session start, retrieves deeper L1/L2 memory on demand via 3 minimal MCP tools, and proposes new or updated memories to `pre-memory` without mutating active state.

## 3. Core Capabilities (v0.1)

1. **Multi-scope Git-backed storage:** `personal` (auto-git solo folder), `team` (read-only serving clone of a shared private repo), and `project` (`.faber/memory/` in a project repo).
2. **Deterministic L0 compiler:** Compiles active `team` + `personal` entries from committed `HEAD` trees into an uncommitted local-state `MEMORY.md` with strict ordering, no dates/paths/counts, and a hard estimated-token budget (`ceil(utf8_bytes / 4)` <= 1500).
3. **3-tool pure-JS BM25 MCP server:** `memory_search`, `memory_get`, `memory_propose` over stdio with zero native addons and automatic `HEAD`-change reindexing.
4. **Human-gated `pre-memory` workflow:** Proposals live in a UUID-keyed local state directory; humans `review` (with batching), `approve` (personal commit / team throwaway worktree direct push or PR fallback / project uncommitted file), or `reject`.
5. **Deterministic hygiene scan:** Blocks secrets and machine-specific absolute paths on `propose`, `approve`, and `compile --check` with redacted diagnostics.
6. **Multi-engine `init` & zero-LLM `import`:** Non-destructive user-level wiring with dry-run diff, `.bak` backup, and `--undo`; deterministic import from `markdown-dir`, `claude-memory`, `agents-md`, and `cursor-rules`.

## 4. Non-Goals (v0.1)

- No external databases, vector stores, graph DBs, or native addons (SQLite/FTS5 deferred).
- No engine-specific lifecycle auto-capture daemons or background sync timers.
- No hosted UI or custom RBAC (Git host PR + branch protection is the review gate).
- No LLM API key requirement for any CLI operation.

## 5. Feature Index

- [01-core-memory](features/01-core-memory/prd.md) — Core v0.1 specification (`FR-01`–`FR-09`, 55 BDD scenarios).
