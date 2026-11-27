---
id: feature.metrics-and-stats.acceptance_criteria
type: acceptance_criteria
feature: metrics-and-stats
status: verified
last_updated: 2026-11-27
---

# FaberSEP Memory v0.2: Metrics, Stats & Doctor — Acceptance Criteria (BDD)

> **Approved by the owner on 2026-11-27** ("sorular hepsi onerilerin tamam. dokumanlari guncelle. Sonra gelistirmeye baslayacagiz.").
>
> **Purpose:** Defines the testable behavioral contract for `@fabersep/memory` v0.2 (`02-metrics-and-stats`) using atomic **GIVEN / WHEN / THEN** scenarios. Serves as the shared verification truth for developers, reviewers, and AI coding agents.
>
> **State directory convention:** Throughout these scenarios, the **state directory** refers to `$FABER_MEMORY_HOME/state` (defaulting to `~/.config/faber-memory/state` when `FABER_MEMORY_HOME` is unset).

---

## 1. Scenario Coverage & Traceability Matrix

| Scenario ID | Requirement | Group | Summary | Status |
| :--- | :--- | :--- | :--- | :--- |
| `AC-01` | `FR-01` | Happy Path | MCP and CLI operations append numeric and found-ID-only events with zero text, proposal IDs, or arbitrary not-found IDs | `Passed` |
| `AC-02` | `FR-01` | Happy Path | Metrics ledger is stored under the state directory respecting `FABER_MEMORY_HOME` | `Passed` |
| `AC-03` | `FR-01` | Edge Case | Metrics ledger prunes records older than 90 days and trims oversized ledgers to 8 MB under a non-blocking lock | `Passed` |
| `AC-04` | `FR-01` | Happy Path | `faber-memory reset` mentions and removes the local metrics ledger | `Passed` |
| `AC-05a` | `FR-01` | Error Handling | Unwritable metrics ledger never fails MCP tool calls or CLI commands | `Passed` |
| `AC-05b` | `FR-01` | Error Handling | Busy metrics lock skips pruning without failing MCP tool calls or CLI commands | `Passed` |
| `AC-06` | `FR-02` | Happy Path | `faber-memory stats` reports cwd-independent `team + personal` corpus vs. L0 token reduction and separate project tokens | `Passed` |
| `AC-07` | `FR-02` | Happy Path | `faber-memory stats` reports serialized MCP 3-tool schema token footprint | `Passed` |
| `AC-08` | `FR-02` | Happy Path | `faber-memory stats` counts non-initial `changed: true` L0 hash changes and warns on churn (>5 in 7 days) | `Passed` |
| `AC-09a` | `FR-02` | Happy Path | `faber-memory stats --json` outputs valid structured JSON | `Passed` |
| `AC-09b` | `FR-02` | Error Handling | `faber-memory stats --days 91` rejects out-of-range windows with exit code 1 | `Passed` |
| `AC-09c` | `FR-02` | Edge Case | `faber-memory stats` with no configuration exits 0 with a setup hint | `Passed` |
| `AC-10` | `FR-03` | Happy Path | `faber-memory stats` reports get-calls-per-search ratio (uncapped), zero-result rate, and pure BM25 median latency | `Passed` |
| `AC-11` | `FR-03` | Happy Path | `faber-memory stats` ranks top 10 hot entries by `scope:id` and separates cold, stale, and unverified L0 candidates | `Passed` |
| `AC-12` | `FR-03` | Happy Path | `faber-memory stats` reports the complete `pre-memory` governance funnel across MCP and `import` sources and all review outcomes | `Passed` |
| `AC-13a` | `FR-03` | Edge Case | `faber-memory stats` handles a missing metrics ledger gracefully | `Passed` |
| `AC-13b` | `FR-03` | Edge Case | `faber-memory stats` withholds Cold L0 entries when ledger coverage is shorter than `--days` | `Passed` |
| `AC-14` | `FR-04` | Happy Path | `faber-memory stats --cache` parses Claude Code JSONL with message-ID dedup, sidechain exclusion, and 5-min TTL filtering | `Passed` |
| `AC-15` | `FR-04` | Happy Path | `faber-memory stats --cache` parses Antigravity `transcript.jsonl` (`PLANNER_RESPONSE`) grouped by model with 5-min TTL filtering | `Passed` |
| `AC-16a` | `FR-04` | Happy Path | `faber-memory stats --cache` correlates eligible Claude Code session-start cache drops with L0 recompiles | `Passed` |
| `AC-16b` | `FR-04` | Edge Case | `faber-memory stats --cache` explains why L0 prefix-break correlation does not apply to Antigravity | `Passed` |
| `AC-17` | `FR-04` | Edge Case | `faber-memory stats --cache` skips malformed log lines without printing parse error text | `Passed` |
| `AC-18a` | `FR-04` | Edge Case | `faber-memory stats --cache` handles missing log directories cleanly | `Passed` |
| `AC-18b` | `FR-04` | Edge Case | `faber-memory stats --cache` reports `GAP-01` cleanly for unsupported engines (`cursor`, `codex`) | `Passed` |
| `AC-18c` | `FR-04` | Edge Case | `faber-memory stats --cache` reports unrecognized log format cleanly on Antigravity schema drift | `Passed` |
| `AC-19` | `FR-05` | Happy Path | `faber-memory stats --share` outputs an anonymized Markdown card with zero PII/IDs/paths/models and `package.json` version | `Passed` |
| `AC-20` | `FR-05` | Happy Path | `faber-memory stats --share --json` conforms strictly to the closed allowlist schema | `Passed` |
| `AC-21` | `FR-06` | Happy Path | `faber-memory doctor` reports all `PASS` and exits 0 on a healthy setup | `Passed` |
| `AC-22a` | `FR-06` | Edge Case | `faber-memory doctor` reports `WARN` with hints for dirty root, stale L0, stale proposal, and L0 churn and exits 0 | `Passed` |
| `AC-22b` | `FR-06` | Edge Case | `faber-memory doctor` reports `WARN` and exits 0 on a team-only setup with no personal root | `Passed` |
| `AC-23a` | `FR-06` | Error Handling | `faber-memory doctor` reports `FAIL` for missing L0 and hygiene violation, exits 1, and modifies nothing on disk | `Passed` |
| `AC-23b` | `FR-06` | Error Handling | `faber-memory doctor` catches corrupt `config.json`, reports `FAIL`, exits 1, and modifies nothing on disk | `Passed` |
| `AC-24a` | `FR-06` | Happy Path | `faber-memory doctor --json` outputs structured check results and exits 0 when only warnings exist | `Passed` |
| `AC-24b` | `FR-06` | Error Handling | `faber-memory doctor --strict` exits 1 when any `WARN` check is present | `Passed` |

---

## 2. BDD Authoring Rules

1. **Behavior Over Implementation:** Every scenario describes observable CLI, MCP, or filesystem outcomes — never internal class, function, or variable names.
2. **Atomic Scenarios:** Each scenario verifies one concrete behavioral contract.
3. **Observable Assertions:** Every `THEN` asserts concrete exit codes, output fields, or on-disk invariants.
4. **Test Naming Convention:** Automated tests for this feature must prefix scenario IDs as `02/AC-XX` (for example `02/AC-01`) so they never collide with `01-core-memory` scenario IDs.

---

## 3. Detailed BDD Scenarios

### Group A: Privacy-First Local Metrics Ledger (`FR-01`)

#### Scenario AC-01: Events are recorded with zero query text, content text, proposal IDs, or arbitrary not-found IDs
- **GIVEN:** A configured `@fabersep/memory` setup with committed entries.
- **WHEN:** An agent calls `memory_search` with query `"secret internal codename"`, calls `memory_get` with one existing entry ID and one nonexistent ID `"leaked-query-secret"`, calls `memory_propose` with a body containing `"confidential rationale"`, and the user compiles L0 and approves the proposal.
- **THEN:** `metrics.jsonl` in the state directory contains `search`, `get`, `propose`, `compile`, and `review_outcome` records with timestamps, counts, latencies, triggers, and found `scope:id` entries only, AND the file contains none of `"secret internal codename"`, `"leaked-query-secret"`, `"confidential rationale"`, or any `p-` proposal ID.

#### Scenario AC-02: Metrics ledger respects `FABER_MEMORY_HOME` and keeps Git repos clean
- **GIVEN:** `FABER_MEMORY_HOME` is set to an isolated temporary directory `/tmp/faber-test-home` and personal/team Git repositories are configured.
- **WHEN:** `faber-memory compile` and MCP tool calls execute.
- **THEN:** `metrics.jsonl` is created at `/tmp/faber-test-home/state/metrics.jsonl`, AND `git status --porcelain` in every memory repository remains empty.

#### Scenario AC-03: Automatic pruning of old records and oversized ledgers
- **GIVEN:** A `metrics.jsonl` file containing records older than 90 days and exceeding 10 MB in size alongside recent records, with no `metrics.pruned` marker file (or one whose modification time is older than 24 hours).
- **WHEN:** A new metrics event is appended.
- **THEN:** Records older than 90 days are pruned, file size is trimmed down to at most 8 MB while retaining the newest records via atomic replacement, `metrics.pruned` is updated, AND the ledger remains valid JSON Lines.

#### Scenario AC-04: `faber-memory reset` mentions and removes the metrics ledger
- **GIVEN:** A configured setup with an existing `metrics.jsonl` in the state directory.
- **WHEN:** The user runs `faber-memory reset --yes`.
- **THEN:** The command exits 0, its printed reset summary mentions `metrics.jsonl`, AND `metrics.jsonl` no longer exists on disk.

#### Scenario AC-05a: Unwritable metrics ledger does not break MCP or CLI operations
- **GIVEN:** `metrics.jsonl` in the state directory is made read-only (unwritable) on the filesystem.
- **WHEN:** An agent invokes `memory_search` or `memory_get` via MCP, or the user runs `faber-memory compile`.
- **THEN:** The MCP tool call and CLI command succeed normally with exit code 0 and valid results.

#### Scenario AC-05b: Busy metrics lock skips pruning without breaking MCP or CLI operations
- **GIVEN:** A `metrics.lock` directory already exists in the state directory while `metrics.jsonl` is eligible for pruning.
- **WHEN:** An agent invokes `memory_search` via MCP or the user runs `faber-memory compile`.
- **THEN:** Pruning is skipped without blocking, and the MCP tool call or CLI command succeeds normally with exit code 0.

---

### Group B: Context Efficiency, Schema Footprint & L0 Stability (`FR-02`)

#### Scenario AC-06: Cwd-independent `team + personal` corpus vs. L0 token efficiency and separate project tokens
- **GIVEN:** Active `personal` and `team` entries whose full-body (`l0: body`) rendering totals 4,000 estimated tokens, compiled into an L0 `MEMORY.md` of 600 estimated tokens under a 1,500-token budget, plus an active `project` scope in the current directory totaling 1,000 estimated tokens.
- **WHEN:** The user runs `faber-memory stats`.
- **THEN:** The command exits 0, reports `team + personal` corpus tokens (4,000), compiled L0 tokens (600), context reduction percentage (85%), budget utilization (`600 / 1500`), AND reports the 1,000 active `project` tokens on a separate line without altering the 85% L0 reduction figure.

#### Scenario AC-07: MCP tool schema footprint reporting
- **GIVEN:** A configured `@fabersep/memory` installation.
- **WHEN:** The user runs `faber-memory stats`.
- **THEN:** The output reports the estimated token footprint of the JSON-serialized 3 MCP tool definitions (`memory_search`, `memory_get`, `memory_propose`) alongside the 500-token target.

#### Scenario AC-08: L0 stability counts non-initial hash-change events and warns on frequent churn
- **GIVEN:** `metrics.jsonl` records 1 initial compile (`initial: true`, `changed: false`), 3 unchanged recompiles (`changed: false`), and 7 hash-change compiles (`changed: true`) within the last 7 days.
- **WHEN:** The user runs `faber-memory stats`.
- **THEN:** The output displays `7` L0 hash-change events in the last 7 days AND includes a visible cache-churn warning advising batching approvals to protect prompt-cache reuse.

#### Scenario AC-09a: Structured JSON output for `stats`
- **GIVEN:** A configured setup with recorded metrics.
- **WHEN:** The user runs `faber-memory stats --json`.
- **THEN:** The command exits 0 and stdout parses as valid JSON containing schema version, window days, ledger coverage, context efficiency, MCP footprint, L0 stability, retrieval quality, entry temperature, and pre-memory funnel fields.

#### Scenario AC-09b: Invalid `--days` argument is rejected
- **GIVEN:** A configured setup.
- **WHEN:** The user runs `faber-memory stats --days 91`.
- **THEN:** The command exits 1 and prints a validation error stating that `--days` must be an integer between `1` and `90`.

#### Scenario AC-09c: Unconfigured setup exits cleanly with setup hint
- **GIVEN:** `FABER_MEMORY_HOME` points to an empty directory with no `config.json`.
- **WHEN:** The user runs `faber-memory stats`.
- **THEN:** The command exits 0 and prints an informational hint directing the user to run `faber-memory setup`.

---

### Group C: Runtime Retrieval Quality, Entry Temperature & Pre-Memory Funnel (`FR-03`)

#### Scenario AC-10: Get-calls-per-search ratio, zero-result rate, and pure BM25 median latency
- **GIVEN:** `metrics.jsonl` contains 10 non-empty `search` events (2 with zero results; pure BM25 latencies `[1, 2, 3, 4, 4, 5, 6, 7, 8, 9]` ms, lower-middle p50 = 4 ms), 2 empty-query listing `search` events, and 12 `get` events (including direct L0 retrievals) within the last 30 days.
- **WHEN:** The user runs `faber-memory stats --days 30`.
- **THEN:** The output reports 10 non-empty searches, a `1.2` get-calls-per-search ratio (uncapped), 2 zero-result queries (20%), and a 4 ms median BM25 latency.

#### Scenario AC-11: Hot entries ranked by `scope:id` and separated cold, stale, and unverified L0 lists
- **GIVEN:** Ledger coverage is at least 30 days and four active L0 entries exist: `personal:entry-hot` (retrieved 8 times in 30 days, recent `last_verified`), `personal:entry-cold` (0 retrievals in 30 days, recent `last_verified`), `team:entry-stale` (`last_verified` older than 90 days, 0 retrievals), and `personal:entry-unverified` (no `last_verified` field, retrieved 2 times).
- **WHEN:** The user runs `faber-memory stats --days 30`.
- **THEN:** `personal:entry-hot` appears in Hot entries (capped at top 10), `personal:entry-cold` and `team:entry-stale` appear in Cold L0 entries, `team:entry-stale` appears in Stale L0 entries, AND `personal:entry-unverified` is listed separately as Unverified rather than Stale.

#### Scenario AC-12: Pre-memory governance funnel across MCP and `import` sources and all review outcomes
- **GIVEN:** `metrics.jsonl` records `propose` events from both `mcp` and `import` sources (`staged`, `duplicate_blocked`, `hygiene_blocked` split into `secret` and `machine-path`, `validation_error`) and `review_outcome` events covering `approved_committed`, `approved_pushed`, `approved_pr`, `push_failed`, `awaiting_commit`, and `rejected` (including via `reject --all`).
- **WHEN:** The user runs `faber-memory stats`.
- **THEN:** The pre-memory funnel section accurately reports all source and outcome counts, including the split between blocked secrets and blocked machine paths.

#### Scenario AC-13a: Graceful output when no metrics ledger exists yet
- **GIVEN:** A freshly set up memory root with compiled L0 and no `metrics.jsonl` file.
- **WHEN:** The user runs `faber-memory stats --days 30`.
- **THEN:** The command exits 0, displays live corpus/L0/MCP token metrics, and prints an informational note that runtime usage metrics will appear after MCP or CLI activity.

#### Scenario AC-13b: Cold L0 list is withheld when ledger coverage is shorter than requested window
- **GIVEN:** A `metrics.jsonl` ledger whose oldest record is 3 days old.
- **WHEN:** The user runs `faber-memory stats --days 30`.
- **THEN:** The command exits 0, reports 3 days of ledger coverage, and withholds the Cold L0 entries list with an informational notice.

---

### Group D: Opt-In Prompt-Cache Hit Measurement (`FR-04`)

#### Scenario AC-14: Claude Code session log numeric cache-hit parsing with dedup, sidechain exclusion, and TTL filtering
- **GIVEN:** A fixture directory `./fixtures/claude-logs` containing Claude Code `.jsonl` session logs with `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, and `usage.input_tokens`, including duplicate streaming records sharing a message ID, a sidechain record (`isSidechain: true`), a normal warm step within 5 minutes, and a step after a 12-minute idle gap.
- **WHEN:** The user runs `faber-memory stats --cache --engine claude-code --log-dir ./fixtures/claude-logs`.
- **THEN:** The command exits 0, deduplicates by message ID, excludes the sidechain record, excludes the 12-minute idle-gap step from the warm-step average, computes hit % as `cache_read / (input + cache_read + cache_creation)`, and outputs zero conversation text.

#### Scenario AC-15: Antigravity `transcript.jsonl` parsing grouped by model with 5-min TTL filtering
- **GIVEN:** A fixture directory `./fixtures/agy-logs` containing a conversation folder with both `transcript.jsonl` (having a first `PLANNER_RESPONSE` step with `model: "claude-opus-5-5-medium"`, `input_tokens: 15572`, `cache_read_tokens: 8581`, a warm step 1 minute later, and a third step after a 10-minute idle gap) and `transcript_full.jsonl` (identical copy).
- **WHEN:** The user runs `faber-memory stats --cache --engine antigravity --log-dir ./fixtures/agy-logs`.
- **THEN:** The command exits 0, counts the session only once (ignoring `transcript_full.jsonl`), groups results by `claude-opus-5-5-medium`, reports a first-step cache hit rate of `55.1%` (`8581 / 15572`), excludes the 10-minute idle-gap step from the warm-step average, and outputs zero conversation text.

#### Scenario AC-16a: L0 cache-break correlation on eligible Claude Code sessions
- **GIVEN:** `metrics.jsonl` records an L0 `changed: true` compile at timestamp `T` with estimated L0 size of 600 tokens; a Claude Code session ends at `T - 1 min` (first-turn `cache_read_input_tokens: 12000`) and a new Claude Code session starts at `T + 2 min` (within 5-min TTL, first-turn `cache_read_input_tokens: 11200`, a drop of 800 >= 600).
- **WHEN:** The user runs `faber-memory stats --cache --engine claude-code --log-dir ./fixtures/claude-corr`.
- **THEN:** The command exits 0 and reports `1` correlated cache break out of `1` eligible session.

#### Scenario AC-16b: Antigravity cache report explains L0 correlation exclusion
- **GIVEN:** Valid Antigravity transcript fixtures in `./fixtures/agy-logs`.
- **WHEN:** The user runs `faber-memory stats --cache --engine antigravity --log-dir ./fixtures/agy-logs`.
- **THEN:** The command exits 0, reports cache hit % grouped by model, and prints an informational note explaining that L0 prefix-break correlation applies only to `claude-code`.

#### Scenario AC-17: Resilient handling of malformed log lines without leaking parse error text
- **GIVEN:** A session log file in `./fixtures/malformed-logs` containing valid JSONL records mixed with a truncated/corrupt JSON line containing `"top-secret-prompt-fragment"`.
- **WHEN:** The user runs `faber-memory stats --cache --log-dir ./fixtures/malformed-logs`.
- **THEN:** The command exits 0, computes cache metrics from the valid lines, reports `1` skipped malformed line, AND stdout/stderr never contains `"top-secret-prompt-fragment"`.

#### Scenario AC-18a: Missing log directory exits cleanly
- **GIVEN:** A nonexistent path `./fixtures/does-not-exist`.
- **WHEN:** The user runs `faber-memory stats --cache --log-dir ./fixtures/does-not-exist`.
- **THEN:** The command exits 0 and prints a clear informational message stating no session logs were found.

#### Scenario AC-18b: Unsupported engines report `GAP-01` cleanly
- **GIVEN:** The user selects `--engine cursor` (or `--engine codex`).
- **WHEN:** The user runs `faber-memory stats --cache --engine cursor`.
- **THEN:** The command exits 0 and prints a clear informational message citing `GAP-01` (engine log format not yet supported in v0.2).

#### Scenario AC-18c: Antigravity schema drift exits cleanly
- **GIVEN:** A fixture directory `./fixtures/agy-drift` containing a `transcript.jsonl` with `PLANNER_RESPONSE` records that omit `input_tokens` and `cache_read_tokens`.
- **WHEN:** The user runs `faber-memory stats --cache --engine antigravity --log-dir ./fixtures/agy-drift`.
- **THEN:** The command exits 0 and prints `"unrecognized log format"`.

---

### Group E: Opt-In Anonymized Shareable Benchmark (`FR-05`)

#### Scenario AC-19: Anonymized Markdown benchmark card contains zero sensitive strings and dynamic package version
- **GIVEN:** A configured setup with entries named `secret-project-rule`, located under `/Users/alice/private-repo`, a team remote `git@github.com:acme/internal-mem.git`, and cache logs referencing a custom model `"acme-internal-llm-v2"`.
- **WHEN:** The user runs `faber-memory stats --share --cache --log-dir ./fixtures/agy-logs`.
- **THEN:** The command exits 0, prints a formatted Markdown benchmark card with aggregate numbers and the version from `package.json`, AND the output does NOT contain `secret-project-rule`, `/Users/alice`, `private-repo`, `acme`, `internal-mem`, or `acme-internal-llm-v2`.

#### Scenario AC-20: Anonymized JSON benchmark card matches closed allowlist schema
- **GIVEN:** A configured setup with recorded metrics and cache logs.
- **WHEN:** The user runs `faber-memory stats --share --cache --json --log-dir ./fixtures/agy-logs`.
- **THEN:** The command exits 0, stdout parses as valid JSON whose top-level and nested keys belong strictly to the closed allowlist schema (`schemaVersion`, `packageVersion`, `windowDays`, `corpus`, `mcpSchemaTokens`, `l0Stability`, `retrieval`, `funnel`, and `cache` keyed only by fixed engine names `claude-code` / `antigravity`), with zero file paths, model names, entry IDs, proposal IDs, repo names, or summaries.

---

### Group F: Read-Only Health Diagnostics (`FR-06`)

#### Scenario AC-21: Healthy setup passes all `doctor` checks
- **GIVEN:** Configured `personal` root with clean Git working tree, up-to-date compiled L0 within budget, valid hygiene, wired engine config under `FABER_USER_HOME`, zero stale proposals, and low L0 churn.
- **WHEN:** The user runs `faber-memory doctor`.
- **THEN:** The command exits 0 and prints `PASS` for all 6 diagnostic categories.

#### Scenario AC-22a: Non-fatal issues report `WARN` with actionable hints
- **GIVEN:** A configured setup with uncommitted edits in the personal root, stale compiled L0 (out of sync with committed `HEAD`), one stale proposal older than `staleDays`, and 6 `changed: true` L0 events in the last 7 days.
- **WHEN:** The user runs `faber-memory doctor`.
- **THEN:** The command exits 0, marks those checks as `WARN`, and prints a one-line remediation hint for each warning.

#### Scenario AC-22b: Team-only setup without personal root reports `WARN`
- **GIVEN:** A configured setup with a valid `team` root and no `personal` root configured.
- **WHEN:** The user runs `faber-memory doctor`.
- **THEN:** The command exits 0 and marks the Config & Git roots check as `WARN` with a remediation hint.

#### Scenario AC-23a: Missing L0 and hygiene violation report `FAIL` without modifying disk
- **GIVEN:** A configured setup whose compiled `MEMORY.md` is missing and whose personal root contains an entry with a secret hygiene violation.
- **WHEN:** The user runs `faber-memory doctor`.
- **THEN:** The command exits 1, marks the affected checks as `FAIL` with remediation hints, AND leaves all files, the Git index, and Git repositories completely untouched (still no `MEMORY.md` created).

#### Scenario AC-23b: Corrupt `config.json` reports `FAIL` without crashing or modifying disk
- **GIVEN:** A `config.json` containing invalid truncated JSON.
- **WHEN:** The user runs `faber-memory doctor`.
- **THEN:** The command exits 1, prints a `FAIL` check for Config & Git roots with a remediation hint (without an unhandled stack trace), and leaves `config.json` untouched.

#### Scenario AC-24a: `doctor --json` outputs structured results
- **GIVEN:** A setup with at least one `WARN` check and zero `FAIL` checks.
- **WHEN:** The user runs `faber-memory doctor --json`.
- **THEN:** The command exits 0 and stdout parses as valid JSON listing each check's name, status, and hint.

#### Scenario AC-24b: `doctor --strict` fails on warnings
- **GIVEN:** A setup with at least one `WARN` check and zero `FAIL` checks.
- **WHEN:** The user runs `faber-memory doctor --strict`.
- **THEN:** The command exits 1 because a `WARN` check is present.
