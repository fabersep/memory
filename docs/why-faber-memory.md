# Why FaberSEP Memory? (FAQ & Comparisons)

When developers first see `@fabersep/memory`, the most common questions are *"Doesn't Claude Code / Antigravity / Cursor already have memory?"* and *"Why not just use a vector database or a single `CLAUDE.md` file?"*

Here are direct, honest answers to each question.

---

## 1. Doesn't Claude Code, Antigravity, or Cursor already have built-in memory?

Yes — and built-in auto-memory is great for quick, single-tool personal notes. It breaks down as soon as you care about **portability, reliability, or cost**:

- **Tool lock-in:** Claude Code's auto-memory only lives in `~/.claude/projects/.../memory/`. Cursor rules only live in `.cursor/`. Antigravity has its own config. Switch tools, open a second machine, or onboard a teammate, and your rules don't follow you. With `@fabersep/memory`, your rules live in plain Git Markdown and work identically across **Claude Code, Antigravity, Claude Desktop, Cursor, and Codex**.
- **Silent memory drift:** Built-in auto-memory lets agents write unverified, half-baked, or contradictory notes directly into active memory. One bad assumption silently poisons every future session. In `@fabersep/memory`, active memory is **read-only for agents**. Agents propose changes via `memory_propose`, and you approve, edit, or reject them in one batch.
- **No team workflow:** You cannot code-review, diff, or PR a teammate's auto-memory folder. With `@fabersep/memory`, `team` rules live in a private Git repository with direct push or automatic PR fallback on protected branches.

---

## 2. Why not just put everything in `CLAUDE.md` or `AGENTS.md`?

Putting everything in one static instruction file works up to ~100 lines. After that:

- Every session pays input tokens for rules that are irrelevant to the current task.
- Important rules get buried in the middle of a giant prompt and ignored.
- You still have no clean way to separate **team-wide**, **personal**, and **project-specific** rules without duplicating them across repos.

`@fabersep/memory` uses **3-layer progressive disclosure**:
- **L0 (`MEMORY.md`):** A deterministic, fixed-budget (<1,500 tokens) index always loaded at session start.
- **L1 (`memory_search`):** Pure-JS BM25 search returning compact summaries on demand.
- **L2 (`memory_get`):** Full Markdown body fetched only for the exact entry the agent needs.

---

## 3. How is this different from Mem0, Zep, or vector-DB memory MCPs?

| Dimension | Built-in Auto-Memory | Vector-DB / Graph Memory MCPs | `@fabersep/memory` |
| :--- | :--- | :--- | :--- |
| **Source of truth** | Tool-private local files | Database (Postgres, Qdrant, SQLite, cloud) | **Committed Git `HEAD` Markdown** |
| **Multi-agent portability** | Single tool only | Depends on server/SDK | **Claude Code, Antigravity, Desktop, Cursor, Codex** |
| **Agent write safety** | Direct silent writes | Automatic LLM extraction/writes | **Read-only active memory + `pre-memory` human review** |
| **Prompt cache impact** | Grows & shifts unpredictably | Dynamic RAG injection breaks prefix cache | **Deterministic L0 (<1,500 tok), byte-identical prefix; measure your hit rate with `stats --cache`** |
| **Infrastructure required** | None | Docker / DB / embedding API keys | **Zero runtime dependencies (Node >= 20 + Git)** |
| **Team sharing & audit** | None | Custom auth / DB hosting | **Standard private Git repo + PRs + hygiene CI** |

---

## 4. Why does prompt caching matter so much for agent memory?

Modern coding agents resend the entire conversation prefix on every turn. When the prefix stays byte-identical, LLM providers serve cached input tokens at a **75–90% discount** and much lower latency.

Many memory systems inject dynamic search results, timestamps (`Last updated: ...`), pending counts, or newly auto-written notes into the top of the prompt — **invalidating the entire prompt cache on every turn**.

`@fabersep/memory` is **prefix-cache-first by design**:
- Compiled L0 (`MEMORY.md`) contains **no dates, no pending counts, no machine paths**, and is sorted deterministically (`team` then `personal`, sorted by ID).
- Approvals are batched into a single Git commit and L0 recompile (ideally between sessions), keeping active sessions' prompt prefixes rock-solid.
- The MCP server exposes only **3 minimal tools** (~350 tokens total schema) and never emits dynamic tool-list notifications.

---

## 5. Why pure-JS BM25 instead of embeddings / semantic search?

For engineering memory (short, structured Markdown rules, decisions, lessons, and references with explicit `id`, `summary`, and `tags`):
- **Zero dependencies & zero cost:** No embedding API calls, no local ONNX/Python runtime, no native SQLite compilation failures across Node versions or OSes.
- **Instant & deterministic:** Reindexes directly from Git `HEAD` in memory in milliseconds — no stale on-disk index files to corrupt or sync.
- **Exact technical term matching:** BM25 excels at exact identifiers (`B-D63`, `compile --check`, `autoMemoryEnabled`, flag names, error codes) where generic embeddings often blur distinct terms together.

---

## 6. Isn't manual `pre-memory` review extra friction?

It is designed to have **near-zero friction** during work:
- While coding, agents never block waiting for you — `memory_propose` stages suggestions quietly into `pre-memory`.
- Whenever you have 30 seconds (for example, at the end of a session), run `npx @fabersep/memory review`. You can approve, edit, reject, skip, go back (`b`), or quit & save (`q`) — and all approvals land in **one Git commit**.
- Good memory is small, sharp, and trusted. Spending 30 seconds reviewing prevents hours of debugging why an agent silently followed a hallucinated rule it wrote last week.

---

## 7. Can I use it safely with a team without leaking secrets or personal preferences?

Yes:
- **Scope separation:** Your `personal` preferences stay in your local personal repo; only `team` entries go to the shared private team repo.
- **Built-in hygiene guard:** `memory_propose`, `import`, `approve`, and `compile --check` (for CI) automatically block secrets (API keys, private keys, JWTs, bearer tokens, credential assignments) and machine-specific paths (`/Users/...`, `/home/...`, `C:\Users\...`).

---

## 8. Does it work from mobile apps (like Claude Mobile)?

- **Today:** Runs as a local `stdio` MCP server (`npx @fabersep/memory serve`) alongside your local Git repos — so it works natively on your laptop/desktop/server (**Claude Code, Antigravity, Claude Desktop, Cursor, Codex**). If you connect from Claude Mobile to a **Remote Control** session running on your own machine or Linux server, that session automatically has full access to `@fabersep/memory`.
- **Roadmap:** A thin Remote MCP transport (Streamable HTTP + token auth) so mobile and web chat clients (such as Claude Mobile / `claude.ai` Custom Connectors) can connect directly to your self-hosted memory server.
