# FaberSEP Memory (`@fabersep/memory`)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**Prefix-cache-first, Git-backed Markdown memory for AI coding agents.**

Zero databases. Zero native addons. Zero runtime dependencies. Just plain Markdown files in Git, a deterministic compiled index that keeps your prompt cache warm, a human-approved `pre-memory` inbox so agents never pollute your rules, and a 3-tool MCP server (`memory_search`, `memory_get`, `memory_propose`).

---

## Table of Contents

- [Why FaberSEP Memory?](#why-fabersep-memory)
- [How It Works](#how-it-works-the-2-minute-mental-model)
- [Prerequisites](#prerequisites)
- [Solo / Personal Setup (5 Steps)](#step-by-step-quickstart-solo--personal-setup)
- [Team Mode Setup (Shared Private Repo)](#team-mode-setup-shared-private-git-repo)
- [Everyday Workflow](#everyday-workflow)
- [Updating to a Newer Version](#updating-to-a-newer-version)
- [Cleaning Up or Resetting](#cleaning-up-or-resetting)
- [CLI Command Reference](#cli-command-reference)
- [MCP Tools](#mcp-tools)
- [FAQ & Comparisons](docs/why-faber-memory.md)
- [Troubleshooting & Edge Cases](docs/troubleshooting.md)

---

## Why FaberSEP Memory?

*"Doesn't Claude Code, Antigravity, or Cursor already have built-in memory?"*

Built-in auto-memory is tied to a single tool and lets agents silently overwrite your rules. Vector-DB memory servers add Docker/DB overhead and break prompt caching with dynamic injections. **`@fabersep/memory` solves all four at once:**

| | Built-in Auto-Memory | Vector-DB Memory MCPs | `@fabersep/memory` |
| :--- | :--- | :--- | :--- |
| **Portability** | Locked to one tool | Needs hosted DB/SDK | **One Git repo across Claude, Antigravity, Cursor, Codex** |
| **Safety** | Agents write silently (drift) | Auto-extracted noise | **Read-only active memory + human `pre-memory` review** |
| **Prompt Cache** | Grows unpredictably | Dynamic RAG breaks prefix | **Deterministic L0 (<1,500 tok), cache-warm (~80%+)** |
| **Setup & Team** | Local only, no PRs | Docker / DB / API keys | **Zero dependencies, pure Git `HEAD` + team PRs** |

> Want the full breakdown (why BM25 over embeddings, why prompt caching matters, mobile/remote access)? Read **[Why FaberSEP Memory? (FAQ & Comparisons)](docs/why-faber-memory.md)**.

---

## How It Works (The 2-Minute Mental Model)

```mermaid
flowchart LR
    subgraph Git["Git HEAD (Source of Truth)"]
        T["Team Repo<br/>(shared private repo)"]
        P["Personal Repo<br/>(~/.faber/memory)"]
        PR["Project Repo<br/>(.faber/memory/)"]
    end

    T & P -->|"Deterministic compile<br/>(< 1,500 tokens)"| L0["L0: MEMORY.md<br/>(always loaded, cache-warm)"]
    T & P & PR -->|"In-memory BM25<br/>(auto-reindexes on HEAD)"| L1["L1: memory_search<br/>(compact summaries)"]
    L1 -->|"Fetch exact ID"| L2["L2: memory_get<br/>(full Markdown body)"]

    L0 --> Agent["AI Coding Agent"]
    L2 --> Agent
```

If you are new to agent memory systems, here is everything you need to know:

1. **Git is the single source of truth.** Every active memory entry is a small Markdown file committed to Git (`HEAD`). Uncommitted files are never silently trusted.
2. **Three progressive layers (L0 -> L1 -> L2) keep context small and prompt-cache friendly:**
   - **L0 (`MEMORY.md`):** A short, deterministic table of contents compiled from your active `team` and `personal` entries (hard cap: 1,500 tokens). No timestamps, no pending counts, no machine paths — so your LLM prompt cache stays warm turn after turn.
   - **L1 (`memory_search`):** When an agent needs details, it searches your memory with a built-in pure-JS BM25 search tool and gets compact summaries back.
   - **L2 (`memory_get`):** The agent fetches the full Markdown body only for the exact entry it needs.
3. **Agents propose; humans approve (`pre-memory`).** Active memory is read-only for agents. When an agent learns a new rule or lesson, it calls `memory_propose`, which stages a proposal in `pre-memory`. You review and approve it in one batch — keeping your memory accurate and noise-free.
4. **Three scopes:**
   - **`personal`** — Your own rules, lessons, and preferences (solo local Git repo, e.g. `~/.faber/memory`).
   - **`team`** — Shared engineering rules in a private team Git repo.
   - **`project`** — Optional repo-specific memory in `<repo>/.faber/memory/`.

---

## Prerequisites

- **Node.js 20 or newer** (`node -v` to check)
- **Git** (`git --version` to check)

You do **not** need to install anything globally to try it — `npx @fabersep/memory` runs the CLI directly.
*(If you prefer shorter commands, install globally once with `npm install -g @fabersep/memory` and use `faber-memory` instead of `npx @fabersep/memory`.)*

---

## Step-by-Step Quickstart (Solo / Personal Setup)

Follow these 5 steps in order. Each step is safe and reversible.

### Step 1: Create your personal memory folder

Run:

```bash
npx @fabersep/memory setup ~/.faber/memory
```

**What this does:**
- Creates `~/.faber/memory` (you can pick any folder path you like) and initializes a local Git repository on branch `main`.
- Saves your configuration in `~/.faber/memory-state/config.json`.

### Step 2: Connect your AI coding agent

First, run a **dry-run** to preview the exact **Before / After** changes without modifying anything:

```bash
npx @fabersep/memory init
```

When the preview looks good, apply it:

```bash
npx @fabersep/memory init --apply
```

**What this does:**
- Compiles your L0 index first to `~/.faber/memory-state/MEMORY.md`.
- Creates a `.bak` backup of every file it touches.
- Adds a clearly marked `<!-- faber-memory:start --> ... <!-- faber-memory:end -->` block and registers the `faber-memory` MCP server (`npx -y @fabersep/memory serve`).
- **Trust & safety:** `init --apply` never disables your AI tool's built-in settings behind your back (for example, it does not edit `~/.claude/settings.json`). If you use Claude Code and want to avoid running two parallel memory systems, see [how to optionally disable Claude auto-memory](docs/troubleshooting.md#claude-auto-memory).

> **Tip:** Target specific engines with `--engine`:
> ```bash
> npx @fabersep/memory init --engine claude-code,antigravity --apply
> ```
> Revert the wiring cleanly at any time (keeps your memory repos & proposals intact):
> ```bash
> npx @fabersep/memory init --undo
> ```

#### Supported Engines & What `init --apply` Wires

| Engine | Instruction File | MCP Config | Notes |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `~/.claude/CLAUDE.md` (`@path` include) | `~/.claude.json` | Native `@path` L0 include + MCP tools |
| **Antigravity** | `~/.gemini/GEMINI.md` (read-at-start rule) | `~/.gemini/config/mcp_config.json` | Reads L0 at start + MCP tools |
| **Claude Desktop** | — | `claude_desktop_config.json` | MCP tools (`--engine claude-desktop`) |
| **Cursor** | — (GAP) | `~/.cursor/mcp.json` | MCP-only |
| **Codex** | — (GAP) | — | MCP-only (manual config) |

### Step 3: Import your existing memory files (optional, zero LLM)

Already have Markdown notes, Claude auto-memory files, an `AGENTS.md`, or Cursor rules? You can import them deterministically without spending any LLM tokens.

Pick the command that matches your source:

```bash
# 1. Any folder of Markdown (.md) files
npx @fabersep/memory import --from markdown-dir ./path/to/your/memory

# 2. Existing Claude Code auto-memory folder
npx @fabersep/memory import --from claude-memory ~/.claude/projects/<your-project>/memory

# 3. A single AGENTS.md or CLAUDE.md (split each # / ## heading into its own entry)
npx @fabersep/memory import --from agents-md ./AGENTS.md --split-headings

# 4. Existing Cursor rules
npx @fabersep/memory import --from cursor-rules ./.cursor/rules
```

**What this does:**
- Scans your files, infers frontmatter (`id`, `type`, `summary`), skips old index files (`MEMORY.md`, `CATALOG.md`, `README.md`, `INDEX.md`), checks for near-duplicates and hygiene issues (secrets or machine-specific paths), and stages valid items into **`pre-memory`**.
- Nothing becomes active until you approve it in Step 4.
- **Have `/Users/<name>/...` or `/home/<name>/...` paths in your old notes?** Add `--normalize-paths` to automatically convert them to portable `~/` paths in the staged copy (your source files stay untouched). See [Machine-Specific Paths](docs/troubleshooting.md#machine-specific-paths).

### Step 4: Review and approve staged proposals

Review everything waiting in `pre-memory`:

```bash
npx @fabersep/memory review
```

You will see a numbered progress bar (`[ 1 / 17 ]  Approved: 0 | Rejected: 0 | Skipped: 0`) and each proposal in a clean card. Actions:
- `a` — **approve** (queued for a single batch commit)
- `e` — **edit** the body before approving
- `r` — **reject** and remove the proposal
- `s` — **skip** for now
- `v` — **view full** body (when a long entry is truncated)
- `b` — **back** to the previous proposal to change your mind
- `q` — **quit & save** everything you approved/rejected so far in one commit (pressing `Ctrl+C` also saves your progress safely)

*(Shortcuts: `npx @fabersep/memory review --approve-all`, `npx @fabersep/memory approve <id1> <id2>`, or `npx @fabersep/memory reject <id>`.)*

### Step 5: Verify everything is healthy

Check your current setup and pending queue:

```bash
npx @fabersep/memory status
```

Run the strict validation check (schema, duplicates, 1,500-token L0 budget, and hygiene rules):

```bash
npx @fabersep/memory compile --check
```

If both succeed, restart (or start a new session in) your AI coding agent — it now has access to your compiled L0 memory and the 3 `faber-memory` MCP tools.

---

## Team Mode Setup (Shared Private Git Repo)

Use Team Mode to share rules across a team — or across your own multiple machines via a private Git repo.

If you are **starting from scratch in Team Mode**, run these 4 steps:

```bash
# 1. Clone and register your private team memory repo
#    Accepts HTTPS, github.com/org/repo, org/repo, or SSH (git@github.com:org/repo.git)
npx @fabersep/memory setup --team https://github.com/your-org/team-memory.git

#    Optional: clone into a custom directory (default: ~/.faber/memory-state/clones/team)
#    npx @fabersep/memory setup --team https://github.com/your-org/team-memory.git --path ~/team-memory

# 2. Connect your AI coding agent (skip if you already ran init --apply in Solo setup)
npx @fabersep/memory init --apply

# 3. (Optional) Import existing Markdown notes into the team scope
npx @fabersep/memory import --from markdown-dir ./path/to/your/memory --scope team

# 4. Review & approve (pushes to the team repo and compiles L0)
npx @fabersep/memory review
```

To pull teammates' updates later:

```bash
npx @fabersep/memory sync
```

**How team approvals push:**
- **`--submit-mode auto` (default):** Pushes directly to the team repo's default branch via a clean temporary worktree. If branch protection rejects the push, it automatically falls back to creating a branch and opening a PR.
- **`--submit-mode pr`:** Always submits via a Pull Request (`npx @fabersep/memory config set-submit-mode pr`).

*(See also: [Step 2: Connect your AI coding agent](#step-2-connect-your-ai-coding-agent) · [Step 3: Import](#step-3-import-your-existing-memory-files-optional-zero-llm) · [Step 4: Review](#step-4-review-and-approve-staged-proposals))*

---

## Everyday Workflow

```mermaid
flowchart LR
    A["AI Agent works<br/>in your repo"] -->|"Calls memory_propose"| B["pre-memory Inbox<br/>(safe staging)"]
    B -->|"Human runs<br/>faber-memory review"| C{"Approve / Edit<br/>/ Reject"}
    C -->|"Reject"| D["Discarded<br/>(no Git commit)"]
    C -->|"Approve (batched)"| E["Single Git Commit<br/>(or Team PR)"]
    E -->|"Auto-recompile"| F["Updated L0 MEMORY.md<br/>(ready for next session)"]
```

Once set up, daily use is simple:

1. **During a session:** Your agent loads the compact L0 index, searches deeper with `memory_search` + `memory_get`, and proposes new lessons via `memory_propose`.
2. **Whenever you have a minute:** Run `npx @fabersep/memory status` to see pending proposals, then `npx @fabersep/memory review` to approve or reject them in one batch.
3. **In team mode:** Run `npx @fabersep/memory sync` whenever you want to pull teammates' updates.

### Writing a Memory File by Hand

Memory files are standard Markdown with a small YAML frontmatter block:

```markdown
---
id: no-broad-process-kill
type: rule
scope: personal
summary: Never run pkill or killall by broad pattern; stop only your own PID or task.
tags: [safety, shell]
---

Never kill processes by broad name patterns like `pkill node` or `killall python`.
Always stop only the specific PID or background task you started.
```

Valid `type` values: `rule`, `decision`, `lesson`, `preference`, `reference`.
After editing or adding a file manually in your memory repo, commit it with Git and run `npx @fabersep/memory compile`.

---

## Updating to a Newer Version

How you update depends on how you run `@fabersep/memory`:

- **Using `npx` (no global install):**
  Pass `@latest` to make sure `npx` fetches the newest release instead of a cached copy:
  ```bash
  npx @fabersep/memory@latest --help
  ```
- **Installed globally via npm:**
  ```bash
  npm install -g @fabersep/memory@latest
  ```
- **Cloned from GitHub source:**
  ```bash
  cd /path/to/memory
  git pull
  npm install
  npm run build
  ```

After updating, your existing memory repos and config continue working as-is. If a new version updates engine wiring, re-running `npx @fabersep/memory@latest init --apply` is safe and idempotent.

---

## Cleaning Up or Resetting

- **Remove only agent wiring** (keeps all memory repos and pending proposals):
  ```bash
  npx @fabersep/memory init --undo
  ```
- **Clear all pending `pre-memory` proposals** (with confirmation):
  ```bash
  npx @fabersep/memory reject --all
  ```
- **Disconnect a configured root** (removes it from `config.json` without deleting files on disk):
  ```bash
  npx @fabersep/memory config unset personal
  # or: npx @fabersep/memory config unset team
  ```
- **Full reset** (undoes agent wiring and deletes `~/.faber/memory-state/` after confirmation; add `--include-personal-repo` to also remove your local personal Git repo):
  ```bash
  npx @fabersep/memory reset
  ```

---

## Installing Globally or Running from Source

**Global npm install** (gives you the `faber-memory` command directly):

```bash
npm install -g @fabersep/memory
faber-memory --help
```

**From GitHub source** (for contributing or local development):

```bash
git clone https://github.com/fabersep/memory.git
cd memory
npm install
npm test
npm link
```

---

## CLI Command Reference

| Command | Description |
| :--- | :--- |
| `setup [path]` | Initialize a local solo (personal) memory Git repo. |
| `setup --team <url\|org/repo> [--path <dir>] [--submit-mode auto\|pr]` | Clone and configure a shared team memory repo. |
| `config` | Print current `~/.faber/memory-state/config.json`. |
| `config set-path <personal\|team> <new-path>` | Move a configured memory root while keeping its UUID. |
| `config set-submit-mode <auto\|pr>` | Change team approval mode (`auto` push with PR fallback, or always `pr`). |
| `config unset <personal\|team>` | Disconnect a root from config without deleting files on disk. |
| `init [--apply \| --undo] [--engine ...] [--project-hint]` | Preview (Before/After), apply (with `.bak` backups), or undo user-level agent wiring. |
| `compile [--check] [--repo <dir>]` | Compile L0 `MEMORY.md`, or validate schema/budget/hygiene in CI (`--check`). |
| `sync [--timeout <ms>]` | Fast-forward pull remote updates and recompile L0. |
| `status` | Show compiled L0 status, configured roots, warnings, and pending/stale proposals. |
| `review [--approve-all]` | Interactively approve, edit, reject, skip, go back, or quit & save `pre-memory` proposals. |
| `approve <id...> [--mode auto\|pr]` | Approve one or more proposals by ID in a single batch commit. |
| `reject <id>` / `reject --all [--yes]` | Reject and delete one or all pending proposals. |
| `reset [--include-personal-repo] [--yes]` | Undo agent wiring and wipe local state (optionally including personal repo). |
| `import --from <type> <path> [--scope ...] [--split-headings] [--normalize-paths] [--approve]` | Deterministically import existing memory into `pre-memory`. |
| `serve` | Run the 3-tool stdio MCP server (used by your AI agent's MCP config). |

---

## MCP Tools

The MCP server exposes exactly **3 lean tools** (~350 tokens total tool schema):

| Tool | Purpose |
| :--- | :--- |
| `memory_search` | Pure-JS BM25 full-text search across active `team`, `personal`, and `project` scopes (returns compact L1 summaries). Automatically reindexes on Git `HEAD` change. |
| `memory_get` | Fetch the full L2 Markdown body of a specific entry by ID. |
| `memory_propose` | Stage a new entry or update into `pre-memory` for human review (never writes directly to active memory). |

---

## Documentation & Specs

This repository follows the [FaberSEP Spec](https://github.com/fabersep/spec) standard:

- [Why FaberSEP Memory? (FAQ & Comparisons)](docs/why-faber-memory.md)
- [Troubleshooting & Edge Cases](docs/troubleshooting.md)
- [Master PRD](docs/master-prd.md)
- [Architecture](docs/architecture.md)
- [Core Memory PRD](docs/features/01-core-memory/prd.md)
- [BDD Acceptance Criteria (55 scenarios)](docs/features/01-core-memory/acceptance_criteria.md)

---

## License

[Apache-2.0](LICENSE)
