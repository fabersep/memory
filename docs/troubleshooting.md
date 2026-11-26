# Troubleshooting & Edge Cases

This page explains the warnings, guards, and edge cases you may encounter when using `@fabersep/memory`.

- [Machine-Specific Paths Detected](#machine-specific-paths)
- [Secrets Detected](#secrets-detected)
- [Index Files Skipped During Import](#index-files)
- [Claude Code `autoMemoryEnabled` Setting](#claude-auto-memory)
- [L0 Token Budget Exceeded](#l0-budget-exceeded)
- [Duplicate Entry IDs](#duplicate-ids)
- [Uncommitted Changes & `awaiting_commit`](#uncommitted-changes)
- [Dirty Serving Clone / `sync` Refused](#dirty-serving-clone)
- [Team Push Failed (`push_failed`)](#push-failed)
- [`npx @fabersep/memory` Fails Inside the Source Repo](#npx-inside-repo)

---

## Machine-Specific Paths Detected {#machine-specific-paths}

**Why it happened:**
`faber-memory` blocks absolute home directory paths like `/Users/alice/...`, `/home/alice/...`, or `C:\Users\alice\...` so your memory stays portable across machines (for example, between a Mac laptop and a Linux server) and never leaks usernames into Git.

**How to fix:**
1. **Automatic normalization during import (easiest):**
   Re-run `import` with `--normalize-paths`. This leaves your original files untouched and replaces `/Users/<name>/` and `/home/<name>/` with `~/` in the staged `pre-memory` copy:
   ```bash
   npx @fabersep/memory import --from markdown-dir ./path/to/notes --normalize-paths
   ```
2. **Manual edit:**
   Replace `/Users/<name>/...` with `~/...` (or a repo-relative path) in the file, then re-import that single file:
   ```bash
   npx @fabersep/memory import --from markdown-dir ./path/to/notes/file.md
   ```
3. **Many files to clean up with an AI agent:**
   Paste this prompt into your coding agent:
   > Scan my Markdown memory files for hardcoded home paths (`/Users/...`, `/home/...`, `C:\Users\...`) and replace them with portable `~/...` or repo-relative paths without changing the meaning of any rule.

---

## Secrets Detected {#secrets-detected}

**Why it happened:**
The hygiene scanner found a pattern that looks like a private key, JWT, bearer token, API key prefix (`sk-...`, `ghp_...`, `AKIA...`), or credential assignment (`password=...`, `api_key=...`). Memory files are committed to Git and read by agents, so secrets are never allowed.

**How to fix:**
- Remove the literal secret value and reference the environment variable or secret manager key name instead (for example: *"Uses `OPENAI_API_KEY` from the environment"*).
- Secrets are **never** auto-normalized; you must remove them manually before importing or approving.

---

## Index Files Skipped During Import {#index-files}

**Why it happened:**
During `import --from markdown-dir` or `claude-memory`, files named `MEMORY.md`, `CATALOG.md`, `README.md`, or `INDEX.md` are automatically skipped.

**Why that is intentional:**
`faber-memory` compiles its own deterministic L0 `MEMORY.md` index automatically from your active entries. Importing an old table-of-contents file would duplicate your index and waste L0 token budget.

---

## Claude Code `autoMemoryEnabled` Setting {#claude-auto-memory}

**Why `init --apply` does NOT change `~/.claude/settings.json` automatically:**
To stay non-invasive and trustworthy, `init --apply` only writes its clearly marked `<!-- faber-memory:start -->` block and MCP server entry. It never silently disables built-in features of your AI tool.

**Why you may want to disable Claude auto-memory manually:**
If Claude Code's built-in auto-memory stays enabled, Claude may keep writing notes directly to `~/.claude/projects/.../memory/` without going through `pre-memory` review — creating two parallel memory systems.

**How to disable (or re-enable) it:**
Add `"autoMemoryEnabled": false` to `~/.claude/settings.json` (or set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in your shell). Remove that line at any time to re-enable it.

---

## L0 Token Budget Exceeded {#l0-budget-exceeded}

**Why it happened:**
The compiled global L0 `MEMORY.md` has a hard cap of **1,500 estimated tokens** so it never bloats your prompt or breaks caching. Compilation fails loudly instead of silently truncating your rules.

**How to fix:**
- For reference notes that don't need to be in every prompt (only found via `memory_search`), add `l0: none` to their YAML frontmatter.
- Shorten long `summary` lines to one concise sentence.
- Archive outdated entries by setting `status: superseded`.

---

## Duplicate Entry IDs {#duplicate-ids}

**Why it happened:**
Entry IDs come from filenames (slugified). Having the same ID in both `team` and `personal` makes global L0 ambiguous, so compilation stops and names the collision.

**How to fix:**
- Rename one of the Markdown files so each entry has a distinct ID, commit the rename, and run `npx @fabersep/memory compile --check`.
- If a `project` entry collides with a `team` entry, global L0 still compiles, but `memory_search` marks the project entry as shadowed until renamed.

---

## Uncommitted Changes & `awaiting_commit` {#uncommitted-changes}

**Why it happened:**
`faber-memory` reads **only committed Git `HEAD`** as the source of truth. Uncommitted edits are ignored and flagged in `status` so half-finished drafts never affect agent behavior.

**How to fix:**
- Commit your changes in the memory repository (`git add ... && git commit`), then run `npx @fabersep/memory compile`.
- For `project` scope approvals (`awaiting_commit`), run the exact `git add <file> && git commit` command printed by `status`.

---

## Dirty Serving Clone / `sync` Refused {#dirty-serving-clone}

**Why it happened:**
The local clone of your `team` repository has uncommitted local changes. `faber-memory sync` uses `git pull --ff-only` and refuses to overwrite or reset dirty files.

**How to fix:**
Inspect the team clone path shown by `npx @fabersep/memory status`, discard or stash any unintended local edits (`git status` inside that clone), and run `npx @fabersep/memory sync` again.

---

## Team Push Failed (`push_failed`) {#push-failed}

**Why it happened:**
When approving a `team` proposal, pushing to the remote failed (network offline, missing auth, or remote diverged). The proposal is preserved in `pre-memory` with status `push_failed` so nothing is lost.

**How to fix:**
1. Verify your Git authentication (`gh auth status` or `ssh -T git@github.com`).
2. Run `npx @fabersep/memory sync` to pull any new remote commits.
3. Re-run `npx @fabersep/memory approve <proposal-id>`.

---

## `npx @fabersep/memory` Fails Inside the Source Repo {#npx-inside-repo}

**Why it happened:**
If your terminal's current working directory is the cloned `fabersep/memory` source repository itself, `npx` sees the local `package.json` named `@fabersep/memory` and looks for `node_modules/.bin/faber-memory` instead of fetching the published package from npm.

**How to fix:**
Run `npx @fabersep/memory ...` from another directory (such as `cd ~`), or run `npm run faber-memory -- <command>` / `npm link` when developing inside the source repo.
