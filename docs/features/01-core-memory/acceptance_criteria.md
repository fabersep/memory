---
id: feature.faber-memory.acceptance_criteria
type: acceptance_criteria
feature: faber-memory
status: verified
last_updated: 2026-11-26
---

# FaberSEP Memory (`@fabersep/memory`) — Acceptance Criteria (BDD)

> **Purpose:** Defines the testable behavioral contract for `@fabersep/memory` v0.1 using atomic **GIVEN / WHEN / THEN** scenarios. Serves as the shared verification truth for developers, reviewers, and AI coding agents.

---

## 1. Scenario Coverage & Traceability Matrix

| Scenario ID | Requirement | Group | Summary | Status |
| :--- | :--- | :--- | :--- | :--- |
| `AC-01` | `FR-01` | Happy Path | Solo initialization creates folder with automatic Git repository at custom path | `Passed` |
| `AC-02` | `FR-01` | Happy Path | Relocating a configured memory root preserves history and UUID-keyed state | `Passed` |
| `AC-02b` | `FR-01` | Happy Path | Team onboarding clones shared private repo as read-only serving clone on default branch | `Passed` |
| `AC-02c` | `FR-01` | Edge Case | Project root resolves via MCP client roots, else cwd Git repo, else none, and reports source | `Passed` |
| `AC-03` | `FR-02` | Happy Path | Entry ID and scope are derived from filename and root, excluding superseded entries | `Passed` |
| `AC-03b` | `FR-02` | Happy Path | `l0: body` emits full entry body and `l0: none` omits entry from L0 while keeping it searchable | `Passed` |
| `AC-04a` | `FR-03` | Happy Path | Global L0 compiles deterministically (team then personal, sorted by ID) across machines | `Passed` |
| `AC-04b` | `FR-03` | Edge Case | Global L0 excludes project entries, dates, pending counts, and machine paths without dirtying repos | `Passed` |
| `AC-04c` | `FR-03` | Edge Case | Compilation and search read committed `HEAD` only and warn on uncommitted edits | `Passed` |
| `AC-04d` | `FR-03` | Edge Case | Concurrent `approve` and MCP startup compile produce a complete, uncorrupted `MEMORY.md` | `Passed` |
| `AC-05a` | `FR-03` | Error Handling | Duplicate entry ID across `team` and `personal` fails global L0 compilation | `Passed` |
| `AC-05b1` | `FR-03` | Edge Case | Project ID colliding with `team` leaves global L0 compilation succeeding (exit 0) | `Passed` |
| `AC-05b2` | `FR-03` | Error Handling | Project ID colliding with `team` fails project `compile --check` naming the collision | `Passed` |
| `AC-05b3` | `FR-03` | Edge Case | Project ID colliding with `team` is marked shadowed with warning in `memory_search` | `Passed` |
| `AC-06` | `FR-03` | Error Handling | Compilation fails without truncation when L0 exceeds estimated token budget | `Passed` |
| `AC-07` | `FR-03` | Happy Path | `compile --check` validates schema, duplicates, budget, and hygiene for CI without writing files | `Passed` |
| `AC-08` | `FR-04` | Happy Path | MCP server exposes exactly 3 tools and serves progressive disclosure (`search` -> `get`) | `Passed` |
| `AC-08b` | `FR-04` | Edge Case | `memory_search` with `include_pending: true` surfaces pending proposals alongside active entries | `Passed` |
| `AC-08c1` | `FR-04` | Error Handling | `memory_propose` for `update` rejects missing `target_id` | `Passed` |
| `AC-08c2` | `FR-04` | Error Handling | `memory_propose` for `supersede` rejects unknown `target_id` | `Passed` |
| `AC-09` | `FR-04` | Happy Path | Search reflects newly committed entries on `HEAD` change with no on-disk index file created | `Passed` |
| `AC-10` | `FR-04` | Edge Case | `memory_propose` rejects near-duplicate on `create` and lists matching entry IDs and summaries | `Passed` |
| `AC-11` | `FR-04` | Edge Case | `memory_propose` allows `force_new: true` with mandatory `reason` to bypass false positive | `Passed` |
| `AC-12a` | `FR-05` | Happy Path | Agent proposal writes only to external local state `pre-memory` with collision-free ID | `Passed` |
| `AC-12b` | `FR-05` | Happy Path | Solo `approve` commits to personal Git repo, removes proposal, and recompiles L0 | `Passed` |
| `AC-12c1` | `FR-05` | Happy Path | `reject` discards pending proposal with no Git commit | `Passed` |
| `AC-12c2` | `FR-05` | Happy Path | `review` edit updates proposal content before approval commit | `Passed` |
| `AC-12d` | `FR-05` | Happy Path | Project-scope `approve` writes uncommitted file into `.faber/memory/` and prints `git add` guidance | `Passed` |
| `AC-12e1` | `FR-05` | Edge Case | Uncommitted approved project entry is excluded from active `memory_search` | `Passed` |
| `AC-12e2` | `FR-05` | Edge Case | `status` lists uncommitted approved project entry as `awaiting_commit` with file name and commit guidance | `Passed` |
| `AC-12e3` | `FR-05` | Happy Path | Committing an `awaiting_commit` project file activates it in search and clears the proposal from `pre-memory` | `Passed` |
| `AC-12f` | `FR-05` | Happy Path | Batching multiple approvals in one `review` session creates one commit, one L0 recompile, and prints cache guidance | `Passed` |
| `AC-13a` | `FR-05` | Happy Path | Team `approve` in `pr` mode pushes `memory/proposal-p-dev-7f3a` via throwaway worktree and prints compare URL | `Passed` |
| `AC-13b` | `FR-05` | Happy Path | Team `approve` deletes throwaway worktree and leaves serving clone clean on `main` | `Passed` |
| `AC-13c` | `FR-05` | Happy Path | Team `approve` in `auto` mode pushes directly to `main` when unprotected and syncs local L0 | `Passed` |
| `AC-13d` | `FR-05` | Edge Case | Team `approve` in `auto` mode falls back to PR branch + compare URL when branch protection rejects direct push | `Passed` |
| `AC-14a` | `FR-05` | Error Handling | Team `approve` push failure marks proposal `push_failed` and exits non-zero | `Passed` |
| `AC-14b` | `FR-05` | Error Handling | Team `approve` push failure cleans up throwaway worktree and leaves serving clone untouched | `Passed` |
| `AC-15` | `FR-05` | Edge Case | `status` CLI reports pending count and flags stale proposals without altering compiled L0 | `Passed` |
| `AC-16a` | `FR-06` | Edge Case | MCP startup pull timeout (5s) serves local state and attaches one-line warning to next tool call | `Passed` |
| `AC-16b1` | `FR-06` | Error Handling | MCP startup refuses `pull --ff-only` on dirty serving clone without resetting and warns on next tool call | `Passed` |
| `AC-16b2` | `FR-06` | Error Handling | CLI `sync` refuses `pull --ff-only` on dirty serving clone without resetting and exits non-zero | `Passed` |
| `AC-16c` | `FR-06` | Happy Path | Successful `sync` atomically replaces state-dir L0 without emitting MCP notifications or tool-list changes | `Passed` |
| `AC-17` | `FR-07` | Happy Path | Deterministic `import` converts `markdown-dir` into `pre-memory` without altering source files | `Passed` |
| `AC-18a` | `FR-07` | Edge Case | Importing `claude-memory` reports duplicates and prints auto-memory disable guidance | `Passed` |
| `AC-18b` | `FR-07` | Happy Path | Importing `agents-md` or `cursor-rules` creates whole-file proposal by default and splits with `--split-headings` | `Passed` |
| `AC-19a` | `FR-08` | Happy Path | `init` applies by default; `init --preview` (alias `--dry-run`) prints the diff without modifying any file | `Passed` |
| `AC-19b1` | `FR-08` | Happy Path | `init --apply` compiles `MEMORY.md` before writing user-level pointer and creates `.bak` backup | `Passed` |
| `AC-19b2` | `FR-08` | Happy Path | Running `init --apply` twice is idempotent and keeps exactly one managed block | `Passed` |
| `AC-19b3` | `FR-08` | Happy Path | `init --apply` writes only to user-level files and never modifies committed project files | `Passed` |
| `AC-19c` | `FR-08` | Edge Case | `init --undo` removes managed blocks and MCP entries while preserving user edits outside blocks and `.bak` | `Passed` |
| `AC-19d` | `FR-08` | Edge Case | Unverified engine marked `GAP` receives MCP-only wiring; optional project hint contains no path | `Passed` |
| `AC-19e` | `FR-08` | Happy Path | `init` creates the personal memory folder when none is configured; `init <folder>` picks the folder | `Passed` |
| `AC-20a` | `FR-09` | Error Handling | `memory_propose` rejects secrets and machine-specific paths with redacted diagnostics | `Passed` |
| `AC-20b1` | `FR-09` | Error Handling | `approve` rejects staged proposals containing secrets or machine paths with redacted diagnostics | `Passed` |
| `AC-20b2` | `FR-09` | Error Handling | `compile --check` fails CI on secrets or machine paths with redacted diagnostics | `Passed` |

---

## 2. BDD Authoring Rules

1. **Behavior Over Implementation:** Describe observable user, CLI, MCP, or file-system outcomes — never internal class names or library names.
2. **Atomic Scenarios:** Each scenario verifies **one** concrete observable outcome triggered by **one** `WHEN` action.
3. **Observable Assertions:** Every `THEN` specifies concrete exit codes, file states, or structured responses.

---

## 3. Detailed BDD Scenarios

### Group A: Storage, Schema & Deterministic Compilation

#### Scenario AC-01: Solo initialization at a custom path
- **GIVEN:** A custom folder path `/tmp/my-faber-mem` that does not yet exist and has no Git repository.
- **WHEN:** The user runs solo initialization targeting `/tmp/my-faber-mem`.
- **THEN:** The folder is created, initialized as a Git repository with a clean default branch, assigned a persistent root UUID in user config, and exits with status 0.

#### Scenario AC-02: Relocating a configured memory root
- **GIVEN:** An initialized personal memory folder with committed entries and one pending proposal in its UUID-keyed local state directory.
- **WHEN:** The user moves the folder to a new path and updates the root path in CLI config.
- **THEN:** All committed entries remain searchable, `faber-memory status` reports the new path, and the pending proposal remains intact in `pre-memory`.

#### Scenario AC-02b: Team mode onboarding
- **GIVEN:** A reachable private Git repository URL `git@example.com:acme/team-memory.git`.
- **WHEN:** The user runs team onboarding pointing to that URL.
- **THEN:** A dedicated serving clone is created on its default branch, assigned a root UUID in config, and registered as the `team` root with exit status 0.

#### Scenario AC-02c: Deterministic project root resolution
- **GIVEN:** A running MCP server with no MCP client `roots` supplied, started with `cwd` inside a Git repository containing `.faber/memory/`.
- **WHEN:** An agent calls `memory_search`.
- **THEN:** The response includes project entries from that repository and reports `project_root_source: cwd` in response metadata.

#### Scenario AC-03: Derived entry identity and status filtering
- **GIVEN:** A personal root containing committed files `prefer-small-prs.md` (`status: active`) and `old-lint-rule.md` (`status: superseded`, `superseded_by: prefer-small-prs`), with neither file declaring `id` or `scope` in frontmatter.
- **WHEN:** Compilation runs and an agent calls `memory_search` with default parameters.
- **THEN:** `prefer-small-prs` is indexed under scope `personal` and included in L0 and search, while `old-lint-rule` remains in Git history but is excluded from L0 and default search.

#### Scenario AC-03b: L0 inclusion modes (`body` and `none`)
- **GIVEN:** A personal root with committed entries `core-rule.md` (`l0: body`) and `deep-note.md` (`l0: none`).
- **WHEN:** Compilation runs and an agent searches for `deep-note`.
- **THEN:** Compiled `MEMORY.md` includes the full body of `core-rule` and omits `deep-note`, while `memory_search` still returns `deep-note`.

#### Scenario AC-04a: Deterministic byte-identical global L0 compilation
- **GIVEN:** Committed `team` entries (`z-rule`, `a-rule`) and `personal` entry (`b-rule`) at identical Git commits on two machines.
- **WHEN:** Compilation runs on both machines.
- **THEN:** Both machines produce byte-identical `MEMORY.md` files in their local state directories ordered `a-rule`, `z-rule`, then `b-rule`.

#### Scenario AC-04b: Global L0 excludes non-cache-safe data and keeps repos clean
- **GIVEN:** Active `project` entry `p-rule`, entries with `last_verified: 2026-11-26`, and two pending proposals in `pre-memory`.
- **WHEN:** Compilation runs.
- **THEN:** Compiled `MEMORY.md` contains none of `p-rule`, `2026-11-26`, pending counts, or machine paths, and `git status` in every memory repository remains clean.

#### Scenario AC-04c: Committed `HEAD` tree is sole source; uncommitted edits warn
- **GIVEN:** A personal memory root where a human modified `prefer-small-prs.md` on disk without committing it.
- **WHEN:** An agent calls `memory_search` for `prefer-small-prs`.
- **THEN:** Search serves the committed `HEAD` version of `prefer-small-prs.md` and includes an uncommitted-edits warning in the response.

#### Scenario AC-04d: Atomic compilation under concurrent `approve` and server startup
- **GIVEN:** A pending personal proposal and an MCP server starting concurrently while `faber-memory approve p-dev-7f3a` runs.
- **WHEN:** Both processes trigger L0 compilation at the same time.
- **THEN:** The per-state-directory lock and atomic temp-file rename produce a complete, valid `MEMORY.md` with no partial or corrupted content.

#### Scenario AC-05a: Duplicate entry ID across `team` and `personal` fails global L0
- **GIVEN:** Active committed files named `deploy-check.md` in both the `team` root and the `personal` root.
- **WHEN:** Global L0 compilation runs.
- **THEN:** The command exits non-zero, preserves the previous valid `MEMORY.md`, and names both scopes and `deploy-check` in the error output.

#### Scenario AC-05b1: Project ID colliding with `team` leaves global L0 unaffected
- **GIVEN:** Active committed files named `deploy-check.md` in both the `team` root and a project's `.faber/memory/` folder.
- **WHEN:** Global L0 compilation runs.
- **THEN:** Global L0 compiles cleanly and exits with status 0.

#### Scenario AC-05b2: Project ID colliding with `team` fails project `compile --check`
- **GIVEN:** Active committed files named `deploy-check.md` in both the `team` root and a project's `.faber/memory/` folder.
- **WHEN:** `faber-memory compile --check` runs inside that project repository.
- **THEN:** The command exits non-zero and names both scopes and the colliding ID `deploy-check`.

#### Scenario AC-05b3: Project ID colliding with `team` is shadowed in `memory_search`
- **GIVEN:** Active committed files named `deploy-check.md` in both the `team` root and a project's `.faber/memory/` folder.
- **WHEN:** An agent calls `memory_search` for `deploy-check`.
- **THEN:** The response marks the project entry as shadowed and includes a collision warning.

#### Scenario AC-06: L0 token budget overflow fails without truncation
- **GIVEN:** Active `team` and `personal` L0 entries whose estimated token count (`ceil(utf8_bytes / 4)`) exceeds 1,500.
- **WHEN:** Compilation runs.
- **THEN:** The command exits non-zero, lists the largest entries with estimated token counts, and does not write a truncated `MEMORY.md`.

#### Scenario AC-07: CI validation via `compile --check`
- **GIVEN:** A team memory repository containing one entry missing the required `summary` frontmatter field.
- **WHEN:** CI runs `faber-memory compile --check`.
- **THEN:** The command exits non-zero, identifies the filename and missing `summary` field, and writes no files into the repository.

### Group B: MCP Server, Progressive Disclosure & `pre-memory` Workflow

#### Scenario AC-08: Minimal 3-tool MCP surface and progressive disclosure
- **GIVEN:** A running MCP server with committed entries across `team`, `personal`, and `project` scopes.
- **WHEN:** A client lists tools, calls `memory_search` with an empty query, and calls `memory_get` for one returned ID.
- **THEN:** Exactly 3 tools (`memory_search`, `memory_get`, `memory_propose`) are exposed; `memory_search` returns only L0/L1 summaries (no full bodies, no pending items); and `memory_get` returns the full L2 content and metadata.

#### Scenario AC-08b: Optional pending visibility in `memory_search`
- **GIVEN:** One active entry and one pending proposal `p-dev-7f3a` in `pre-memory`.
- **WHEN:** An agent calls `memory_search` with `include_pending: true`.
- **THEN:** The search results include `p-dev-7f3a` clearly marked as pending alongside matching active entries.

#### Scenario AC-08c1: `update` rejects missing `target_id`
- **GIVEN:** A running MCP server with active entries.
- **WHEN:** An agent calls `memory_propose` with `action: update` and omits `target_id`.
- **THEN:** The call is rejected with a validation error requiring `target_id` and nothing is written to `pre-memory`.

#### Scenario AC-08c2: `supersede` rejects unknown `target_id`
- **GIVEN:** A running MCP server with no active entry named `nonexistent-rule`.
- **WHEN:** An agent calls `memory_propose` with `action: supersede` and `target_id: nonexistent-rule`.
- **THEN:** The call is rejected with a not-found error and nothing is written to `pre-memory`.

#### Scenario AC-09: Search refreshes automatically on `HEAD` change without index files
- **GIVEN:** A running MCP server serving commit `C1` of a memory root.
- **WHEN:** Commit `C2` adding `new-convention` lands on `HEAD` and an agent calls `memory_search` for `new-convention`.
- **THEN:** The search returns `new-convention` and no search index file is created in the memory root or local state directory.

#### Scenario AC-10: Near-duplicate proposal rejection on `create`
- **GIVEN:** An active entry `deploy-steps` summarizing deployment checks.
- **WHEN:** An agent calls `memory_propose` with `action: create` and highly similar summary/body without `force_new: true`.
- **THEN:** The proposal is rejected, nothing is written to `pre-memory`, and the response lists `deploy-steps` with its one-line summary.

#### Scenario AC-11: Escaping near-match false positive with `force_new`
- **GIVEN:** An active entry `deploy-steps` that triggers a near-match with a distinct rule `deploy-rollback-window`.
- **WHEN:** An agent calls `memory_propose` with `action: create`, `force_new: true`, and `reason: "Separate policy for rollback timing"`.
- **THEN:** The proposal is written to `pre-memory` and `faber-memory review` displays the recorded reason prominently.

#### Scenario AC-12a: Agent proposal stays outside serving clone with collision-free ID
- **GIVEN:** Active personal and team memory roots.
- **WHEN:** An agent calls `memory_propose` with a valid new entry.
- **THEN:** A proposal file with a user-tagged random ID (such as `p-dev-7f3a`) is created in the local state `pre-memory` directory, and every active memory Git repository remains untouched.

#### Scenario AC-12b: Solo approval commits locally and recompiles L0
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting the `personal` root.
- **WHEN:** The user runs `faber-memory approve p-dev-7f3a`.
- **THEN:** The entry is committed to the personal Git repository, `p-dev-7f3a` is removed from `pre-memory`, and generated `MEMORY.md` in the local state directory is recompiled.

#### Scenario AC-12c1: Rejecting a pending proposal
- **GIVEN:** Pending proposal `p-dev-1111` in `pre-memory`.
- **WHEN:** The user runs `faber-memory reject p-dev-1111`.
- **THEN:** `p-dev-1111` is removed from `pre-memory` and no Git commit is created.

#### Scenario AC-12c2: Editing a proposal during `review` before approval
- **GIVEN:** Pending proposal `p-dev-2222` targeting the `personal` root.
- **WHEN:** The user edits the proposal body inside `faber-memory review` and approves it.
- **THEN:** The committed entry in the personal Git repository contains the user's edited content.

#### Scenario AC-12d: Project-scope approval writes uncommitted file with commit guidance
- **GIVEN:** Pending proposal `p-dev-3333` targeting the `project` scope.
- **WHEN:** The user runs `faber-memory approve p-dev-3333`.
- **THEN:** The entry is written to `.faber/memory/` as an uncommitted file, no Git commit is made in the project repo, and the CLI prints `git add` / commit guidance.

#### Scenario AC-12e1: Uncommitted approved project entry is excluded from active search
- **GIVEN:** Project proposal `p-dev-3333` approved via `AC-12d` whose file in `.faber/memory/` has not yet been committed to `HEAD`.
- **WHEN:** An agent calls `memory_search` with default parameters.
- **THEN:** The uncommitted project entry is not returned in active search results.

#### Scenario AC-12e2: `status` reports uncommitted approved project entry as `awaiting_commit`
- **GIVEN:** Project proposal `p-dev-3333` approved via `AC-12d` whose file in `.faber/memory/` has not yet been committed to `HEAD`.
- **WHEN:** The user runs `faber-memory status`.
- **THEN:** `status` lists `p-dev-3333` as `awaiting_commit`, names the uncommitted file, and displays commit guidance.

#### Scenario AC-12e3: Committing an `awaiting_commit` project file activates it and clears `pre-memory`
- **GIVEN:** Project proposal `p-dev-3333` marked `awaiting_commit` in `pre-memory` whose file in `.faber/memory/` has been committed to `HEAD`.
- **WHEN:** An agent calls `memory_search`.
- **THEN:** `memory_search` returns the newly committed project entry and `p-dev-3333` is cleared from `pre-memory`.

#### Scenario AC-12f: Batch approval in `review` creates a single commit and L0 recompile
- **GIVEN:** Three pending proposals targeting the `personal` root in `pre-memory`.
- **WHEN:** The user approves all three in a single `faber-memory review` run.
- **THEN:** Exactly one Git commit is created, L0 is recompiled once, all three proposals are cleared from `pre-memory`, and the CLI prints the one-line next-session cache guidance.

#### Scenario AC-13a: Team approval in `pr` mode pushes proposal branch and prints compare URL
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting a `team` root configured with `submit_mode: pr` and a reachable remote.
- **WHEN:** The user runs `faber-memory approve p-dev-7f3a`.
- **THEN:** Branch `memory/proposal-p-dev-7f3a` is committed from `origin/main` and pushed to the remote, a compare/PR URL is printed, and `p-dev-7f3a` is removed from `pre-memory`.

#### Scenario AC-13b: Team approval cleans up worktree and keeps serving clone clean
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting a `team` root whose serving clone is clean on `main`.
- **WHEN:** `faber-memory approve p-dev-7f3a` completes.
- **THEN:** The temporary worktree is deleted and the serving clone remains clean on `main`.

#### Scenario AC-13c: Team approval in `auto` mode pushes directly to unprotected `main`
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting a `team` root configured with `submit_mode: auto` whose remote `main` branch has no branch protection.
- **WHEN:** The user runs `faber-memory approve p-dev-7f3a`.
- **THEN:** The commit is pushed directly to `origin/main` via throwaway worktree, `p-dev-7f3a` is removed from `pre-memory`, and local sync updates `MEMORY.md`.

#### Scenario AC-13d: Team approval in `auto` mode falls back to PR branch when `main` is protected
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting a `team` root configured with `submit_mode: auto` whose remote rejects direct push to `main` due to branch protection.
- **WHEN:** The user runs `faber-memory approve p-dev-7f3a`.
- **THEN:** The CLI automatically pushes branch `memory/proposal-p-dev-7f3a`, prints a compare/PR URL, removes `p-dev-7f3a` from `pre-memory`, and leaves the serving clone clean on `main`.

#### Scenario AC-14a: Team approval push failure marks proposal `push_failed`
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting a `team` root when the remote is unreachable.
- **WHEN:** The user runs `faber-memory approve p-dev-7f3a`.
- **THEN:** The command exits non-zero with the push error and keeps `p-dev-7f3a` in `pre-memory` marked `push_failed`.

#### Scenario AC-14b: Team approval push failure leaves serving clone untouched
- **GIVEN:** Pending proposal `p-dev-7f3a` targeting a `team` root when the remote rejects the push.
- **WHEN:** `faber-memory approve p-dev-7f3a` fails.
- **THEN:** The temporary worktree is removed and the serving clone remains clean on `main`.

#### Scenario AC-15: Stale proposal visibility without cache busting
- **GIVEN:** Two pending proposals in `pre-memory`, one created 20 days ago (above the 14-day threshold).
- **WHEN:** The user runs `faber-memory status`.
- **THEN:** The output reports 2 pending proposals and flags the 20-day-old item as stale, while generated `MEMORY.md` remains byte-identical.

### Group C: Sync, Import, Multi-Engine `init` & Hygiene

#### Scenario AC-16a: Non-blocking MCP startup pull timeout serves local state
- **GIVEN:** A remote-backed team serving clone whose remote hangs past the 5-second timeout.
- **WHEN:** The MCP server starts and handles its first `memory_search` call.
- **THEN:** Startup completes without blocking, serves the local committed state, and attaches a single-line pull timeout warning to the tool response.

#### Scenario AC-16b1: MCP startup refuses pull on dirty serving clone
- **GIVEN:** A team serving clone containing an uncommitted manual file edit.
- **WHEN:** The MCP server starts and handles its first `memory_search` call.
- **THEN:** `git pull --ff-only` is refused, the manual edit is preserved untouched, and a dirty-clone warning is attached to the tool response.

#### Scenario AC-16b2: CLI `sync` refuses pull on dirty serving clone
- **GIVEN:** A team serving clone containing an uncommitted manual file edit.
- **WHEN:** The user runs `faber-memory sync`.
- **THEN:** The command exits non-zero without resetting or merging, preserves the manual edit, and prints a dirty-clone diagnostic.

#### Scenario AC-16c: Successful `sync` updates state-dir L0 without mutating connected MCP clients
- **GIVEN:** A remote-backed team root with a new commit on `origin/main` while an MCP client is connected to the server.
- **WHEN:** `faber-memory sync` runs and succeeds.
- **THEN:** The serving clone fast-forwards to `origin/main`, `MEMORY.md` in the local state directory is atomically replaced, no MCP notification is emitted to the connected client, and the registered tool list remains identical.

#### Scenario AC-17: Deterministic `markdown-dir` import without modifying sources
- **GIVEN:** A folder `/tmp/legacy-notes` containing Markdown files with `name` and `description` frontmatter and no LLM API keys configured.
- **WHEN:** The user runs `faber-memory import --from markdown-dir /tmp/legacy-notes`.
- **THEN:** Each file is converted into a `pre-memory` proposal with `summary` and `type`, and every file under `/tmp/legacy-notes` remains unmodified.

#### Scenario AC-18a: Importing `claude-memory` reports duplicates and disable guidance
- **GIVEN:** A Claude auto-memory folder containing one new note and one note duplicating an active entry.
- **WHEN:** The user runs `faber-memory import --from claude-memory /tmp/claude-mem`.
- **THEN:** The duplicate is reported, non-duplicate notes are staged in `pre-memory`, source files are untouched, and the CLI prints the exact setting to disable Claude auto-memory.

#### Scenario AC-18b: Importing `agents-md` whole-file and with `--split-headings`
- **GIVEN:** An `AGENTS.md` file with three top-level sections.
- **WHEN:** The user runs `faber-memory import --from agents-md ./AGENTS.md` and then reruns with `--split-headings`.
- **THEN:** The default run stages one whole-file proposal, while `--split-headings` stages three separate proposals (one per top-level heading), leaving `./AGENTS.md` untouched.

#### Scenario AC-19a: `init` applies by default; `--preview` shows the diff only
- **GIVEN:** A machine with an existing `~/.claude/CLAUDE.md`.
- **WHEN:** The user runs `faber-memory init --preview` (or `--dry-run`).
- **THEN:** The CLI prints the exact proposed diff and exits 0 without modifying `~/.claude/CLAUDE.md` or any MCP config file.
- **AND WHEN:** The user runs `faber-memory init` with no mode flag.
- **THEN:** It applies the wiring exactly as `init --apply` does (AC-19b1–AC-19b3); `--apply` remains an accepted alias, and passing both `--apply` and `--preview` exits 1.

#### Scenario AC-19b1: `init` (or `init --apply`) compiles L0 first and saves `.bak` backup
- **GIVEN:** A machine with no compiled `MEMORY.md` yet and an existing `~/.claude/CLAUDE.md`.
- **WHEN:** The user runs `faber-memory init --apply`.
- **THEN:** `MEMORY.md` is compiled before `~/.claude/CLAUDE.md` is edited, a `.bak` backup is created, and the managed pointer block targets the existing compiled file.

#### Scenario AC-19b2: `init --apply` is idempotent across repeated runs
- **GIVEN:** A user-level instruction file already wired by `faber-memory init --apply`.
- **WHEN:** The user runs `faber-memory init --apply` a second time.
- **THEN:** Exactly one `<!-- faber-memory:start/end -->` block exists in the file and the file content is unchanged.

#### Scenario AC-19b3: `init --apply` never modifies committed project files
- **GIVEN:** A Git project repository with committed `AGENTS.md` and `CLAUDE.md` files.
- **WHEN:** The user runs `faber-memory init --apply` from inside that repository.
- **THEN:** `git status` in the project repository remains completely clean and only user-level files are modified.

#### Scenario AC-19c: `init --undo` preserves user edits outside managed blocks
- **GIVEN:** A user-level instruction file wired by `init --apply` where the user subsequently added a custom rule outside the managed block.
- **WHEN:** The user runs `faber-memory init --undo`.
- **THEN:** The managed block and added MCP entry are removed, the user's custom rule remains intact, and the `.bak` file path is printed without overwriting the file.

#### Scenario AC-19d: `GAP` engine receives MCP-only wiring and project hint stays pathless
- **GIVEN:** An engine marked `GAP` for user-level import in the delivery matrix and a project repository requesting a memory hint.
- **WHEN:** `faber-memory init --apply` configures that engine and generates the optional project hint.
- **THEN:** The engine is configured for MCP-only delivery (with no repo-path workaround), and the optional project hint is the single pathless line `Project memory: run npx @fabersep/memory init`.

#### Scenario AC-19e: `init` creates the personal memory folder, so `setup` is optional
- **GIVEN:** A machine with no personal and no team root in `config.json`.
- **WHEN:** The user runs `faber-memory init`.
- **THEN:** It creates and registers a solo Git repo at `~/.faber/memory` exactly as `setup` does, then wires the engines; a second `init` creates nothing new.
- **AND WHEN:** The user runs `faber-memory init <folder>` instead.
- **THEN:** The personal repo is created in `<folder>` (an existing folder is reused and its files are left untouched; uncommitted Markdown files there are reported with an `import` hint). `init --preview <folder>` only says what it would create.
- **AND:** If a personal root already exists at another path, `init <folder>` exits 1 and points to `config set-path`; if only a team root is configured, plain `init` creates no personal folder.

#### Scenario AC-20a: Hygiene scan blocks secrets and machine paths on `memory_propose`
- **GIVEN:** A proposal body containing a bearer token or `/Users/alice/private-repo`.
- **WHEN:** An agent calls `memory_propose`.
- **THEN:** The call is rejected with the pattern category and line number, the raw secret value is redacted in the response, and nothing is written to `pre-memory`.

#### Scenario AC-20b1: Hygiene scan blocks secrets and machine paths on `approve`
- **GIVEN:** A staged proposal `p-dev-7f3a` manually edited to contain an API key pattern or `/home/bob/work`.
- **WHEN:** The user runs `faber-memory approve p-dev-7f3a`.
- **THEN:** The command exits non-zero, reports the pattern category and line number with the raw secret redacted, and performs no commit.

#### Scenario AC-20b2: Hygiene scan blocks secrets and machine paths on `compile --check`
- **GIVEN:** A repository entry containing an API key pattern or `/home/bob/work`.
- **WHEN:** CI runs `faber-memory compile --check`.
- **THEN:** The command exits non-zero, reports the pattern category and line number with the raw secret redacted, and writes no files.
