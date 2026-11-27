import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  getMetricsLockPath,
  getMetricsPath,
  getMetricsPrunedPath,
  maybePruneMetrics,
  readMetrics,
} from '../src/metrics.js';
import { FaberMemoryMcpServer } from '../src/mcp.js';
import { MCP_TOOLS } from '../src/mcp.js';
import { estimateTokens } from '../src/compiler.js';
import { commitMarkdownFile, git, makeTempDir, runCli } from './helpers.js';

function setupPersonalRoot(baseDir: string, homeDir: string, userHome: string): string {
  const personalDir = path.join(baseDir, 'personal-mem');
  const res = runCli(['setup', personalDir], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  return personalDir;
}

test('02/AC-01: MCP and CLI operations append numeric and found-ID-only events with zero text, proposal IDs, or arbitrary not-found IDs', () => {
  const tmp = makeTempDir('v02-ac01-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'alpha-rule.md',
    `---\nsummary: Always validate API inputs\ntype: rule\nl0: line\n---\n\nValidate every request payload at the boundary.\n`,
  );

  const comp = runCli(['compile'], { homeDir, userHome });
  assert.equal(comp.status, 0, comp.stderr);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const searchRes = server.handleToolCall('memory_search', { query: 'secret internal codename' });
  assert.ok(!searchRes.isError);

  const getRes = server.handleToolCall('memory_get', {
    ids: ['alpha-rule', 'leaked-query-secret'],
  });
  assert.ok(!getRes.isError);

  const propRes = server.handleToolCall('memory_propose', {
    action: 'create',
    scope: 'personal',
    entry_id: 'beta-lesson',
    summary: 'Cache keys must be deterministic',
    type: 'lesson',
    body: 'This body contains confidential rationale about caching.',
  });
  assert.ok(!propRes.isError);
  const propJson = JSON.parse(propRes.content[0].text) as { proposal_id: string };
  assert.ok(propJson.proposal_id.startsWith('p-'));

  const app = runCli(['approve', propJson.proposal_id], { homeDir, userHome });
  assert.equal(app.status, 0, app.stderr);

  const metricsPath = getMetricsPath(homeDir);
  assert.ok(fs.existsSync(metricsPath));
  const raw = fs.readFileSync(metricsPath, 'utf8');

  // Strict privacy invariant
  assert.ok(!raw.includes('secret internal codename'), 'must not store query text');
  assert.ok(!raw.includes('leaked-query-secret'), 'must not store not-found ID strings');
  assert.ok(!raw.includes('confidential rationale'), 'must not store memory body');
  assert.ok(!raw.includes(propJson.proposal_id), 'must not store proposal IDs');
  assert.ok(!/"p-[a-z0-9]+-[0-9a-f]+"/.test(raw), 'must not store any p- proposal ID');

  const { events } = readMetrics(homeDir);
  const types = new Set(events.map((e) => e.type));
  assert.ok(types.has('compile'));
  assert.ok(types.has('search'));
  assert.ok(types.has('get'));
  assert.ok(types.has('propose'));
  assert.ok(types.has('review_outcome'));

  const getEvent = events.find((e) => e.type === 'get');
  assert.ok(getEvent && getEvent.type === 'get');
  assert.deepEqual(getEvent.found_ids, ['personal:alpha-rule']);
  assert.equal(getEvent.found_count, 1);
  assert.equal(getEvent.not_found_count, 1);
});

test('02/AC-02: Metrics ledger is stored under state directory respecting FABER_MEMORY_HOME and keeps Git repos clean', () => {
  const tmp = makeTempDir('v02-ac02-');
  const homeDir = path.join(tmp, 'faber-test-home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'clean-rule.md',
    `---\nsummary: Keep repos clean\ntype: rule\nl0: line\n---\n\nNever write state into Git repos.\n`,
  );

  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);
  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  server.handleToolCall('memory_search', { query: 'clean' });

  const expectedPath = path.join(homeDir, 'state', 'metrics.jsonl');
  assert.ok(fs.existsSync(expectedPath));
  assert.equal(git(['-C', personalDir, 'status', '--porcelain']), '');
});

test('02/AC-03: Automatic pruning removes records >90d and trims oversized ledger to <=8 MB under non-blocking lock', () => {
  const tmp = makeTempDir('v02-ac03-');
  const homeDir = path.join(tmp, 'home');
  const stateDir = path.join(homeDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const nowMs = Date.now();
  const oldTs = new Date(nowMs - 100 * 24 * 60 * 60 * 1000).toISOString();
  const recentTs = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();

  const lines: string[] = [];
  // Add old records (>90d)
  for (let i = 0; i < 5; i++) {
    lines.push(
      JSON.stringify({
        type: 'search',
        ts: oldTs,
        result_count: 1,
        zero_result: false,
        empty_query: false,
        latency_ms: 1,
      }),
    );
  }
  // Add recent records with found_ids so file exceeds 10 MB (~10.5 MB)
  const padIds = Array.from({ length: 40 }, (_, idx) => `personal:entry-name-padding-${idx}`);
  const recentLine = JSON.stringify({
    type: 'get',
    ts: recentTs,
    found_ids: padIds,
    found_count: 40,
    not_found_count: 0,
    latency_ms: 2,
  });
  const lineLen = Buffer.byteLength(recentLine + '\n', 'utf8');
  const countNeeded = Math.ceil((10.5 * 1024 * 1024) / lineLen);
  for (let i = 0; i < countNeeded; i++) {
    lines.push(recentLine);
  }

  const metricsPath = getMetricsPath(homeDir);
  fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');
  assert.ok(fs.statSync(metricsPath).size > 10 * 1024 * 1024);

  const pruned = maybePruneMetrics(homeDir, { nowMs });
  assert.equal(pruned, true);
  assert.ok(fs.existsSync(getMetricsPrunedPath(homeDir)));
  assert.ok(fs.statSync(metricsPath).size <= 8 * 1024 * 1024);

  const parsed = readMetrics(homeDir);
  assert.equal(parsed.skippedLines, 0);
  assert.ok(parsed.events.length > 0);
  // No records older than 90 days remain
  for (const ev of parsed.events) {
    assert.ok(Date.parse(ev.ts) >= nowMs - 90 * 24 * 60 * 60 * 1000);
  }
});

test('02/AC-04: faber-memory reset mentions and removes the local metrics ledger', () => {
  const tmp = makeTempDir('v02-ac04-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'reset-rule.md',
    `---\nsummary: Reset test rule\ntype: rule\n---\n\nBody text.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);
  assert.ok(fs.existsSync(getMetricsPath(homeDir)));

  const resetRes = runCli(['reset', '--yes'], { homeDir, userHome });
  assert.equal(resetRes.status, 0, resetRes.stderr);
  assert.ok(resetRes.stdout.includes('metrics.jsonl'), 'reset output must mention metrics.jsonl');
  assert.ok(!fs.existsSync(getMetricsPath(homeDir)), 'metrics.jsonl must be removed');
});

test('02/AC-05a: Unwritable metrics ledger never fails MCP tool calls or CLI commands', () => {
  const tmp = makeTempDir('v02-ac05a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'ro-rule.md',
    `---\nsummary: Read-only metrics test\ntype: rule\n---\n\nWorks even when metrics.jsonl is read-only.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const metricsPath = getMetricsPath(homeDir);
  fs.chmodSync(metricsPath, 0o444);

  try {
    const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
    const searchRes = server.handleToolCall('memory_search', { query: 'metrics' });
    assert.ok(!searchRes.isError);
    const getRes = server.handleToolCall('memory_get', { ids: ['ro-rule'] });
    assert.ok(!getRes.isError);

    const compRes = runCli(['compile'], { homeDir, userHome });
    assert.equal(compRes.status, 0, compRes.stderr);
  } finally {
    fs.chmodSync(metricsPath, 0o644);
  }
});

test('02/AC-05b: Busy metrics lock skips pruning without failing MCP tool calls or CLI commands', () => {
  const tmp = makeTempDir('v02-ac05b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'lock-rule.md',
    `---\nsummary: Lock test rule\ntype: rule\n---\n\nWorks when metrics.lock is held.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  // Create busy metrics.lock directory and remove metrics.pruned so pruning is eligible
  const lockDir = getMetricsLockPath(homeDir);
  fs.mkdirSync(lockDir, { recursive: true });
  const prunedPath = getMetricsPrunedPath(homeDir);
  if (fs.existsSync(prunedPath)) fs.unlinkSync(prunedPath);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const searchRes = server.handleToolCall('memory_search', { query: 'lock' });
  assert.ok(!searchRes.isError);

  const compRes = runCli(['compile'], { homeDir, userHome });
  assert.equal(compRes.status, 0, compRes.stderr);

  // Lock still exists (pruning was skipped) and pruned marker was not created
  assert.ok(fs.existsSync(lockDir));
  assert.ok(!fs.existsSync(prunedPath));
});

test('02/AC-06: faber-memory stats reports cwd-independent team+personal corpus vs L0 reduction and separate project tokens', () => {
  const tmp = makeTempDir('v02-ac06-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  const longBody = 'Detailed engineering guidance for production reliability. '.repeat(80);
  commitMarkdownFile(
    personalDir,
    'big-rule.md',
    `---\nsummary: Short L0 summary\ntype: rule\nl0: line\n---\n\n${longBody}\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  // Create a project git repo with .faber/memory/
  const projDir = path.join(tmp, 'my-project');
  fs.mkdirSync(projDir, { recursive: true });
  git(['init', '-b', 'main', projDir]);
  commitMarkdownFile(
    projDir,
    '.faber/memory/proj-rule.md',
    `---\nsummary: Project specific rule\ntype: rule\nl0: none\n---\n\n${'Project-only details here. '.repeat(40)}\n`,
  );

  const statsJsonOutside = JSON.parse(
    runCli(['stats', '--json'], { homeDir, userHome, cwd: tmp }).stdout,
  );
  const statsResInside = runCli(['stats', '--json'], { homeDir, userHome, cwd: projDir });
  assert.equal(statsResInside.status, 0, statsResInside.stderr);
  const statsJsonInside = JSON.parse(statsResInside.stdout);

  // Cwd-independent team+personal ratio
  assert.equal(statsJsonInside.corpus.corpusTokens, statsJsonOutside.corpus.corpusTokens);
  assert.equal(statsJsonInside.corpus.l0Tokens, statsJsonOutside.corpus.l0Tokens);
  assert.equal(statsJsonInside.corpus.reductionPct, statsJsonOutside.corpus.reductionPct);
  assert.ok(statsJsonInside.corpus.reductionPct > 50);
  assert.ok(statsJsonInside.corpus.projectTokens > 0);

  const textRes = runCli(['stats'], { homeDir, userHome, cwd: projDir });
  assert.equal(textRes.status, 0);
  assert.ok(textRes.stdout.includes('Active project scope'));
  assert.ok(textRes.stdout.includes(`${statsJsonInside.corpus.reductionPct}% reduction`));
});

test('02/AC-07: faber-memory stats reports serialized MCP 3-tool schema token footprint', () => {
  const tmp = makeTempDir('v02-ac07-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const expectedTokens = estimateTokens(JSON.stringify(MCP_TOOLS));
  const res = runCli(['stats'], { homeDir, userHome });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes(`~${expectedTokens} tokens`));
  assert.ok(res.stdout.includes('500'));
});

test('02/AC-08: faber-memory stats counts non-initial changed:true L0 hash changes and warns on churn (>5 in 7 days)', () => {
  const tmp = makeTempDir('v02-ac08-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const now = Date.now();
  const events = [
    {
      type: 'compile',
      ts: new Date(now - 3600_000).toISOString(),
      trigger: 'cli',
      initial: true,
      changed: false,
      l0_sha256: 'a',
      l0_tokens: 100,
      corpus_tokens: 500,
      active_entries: 1,
    },
    ...Array.from({ length: 3 }, (_, i) => ({
      type: 'compile',
      ts: new Date(now - (3000 - i * 100) * 1000).toISOString(),
      trigger: 'cli',
      initial: false,
      changed: false,
      l0_sha256: 'a',
      l0_tokens: 100,
      corpus_tokens: 500,
      active_entries: 1,
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      type: 'compile',
      ts: new Date(now - (2000 - i * 100) * 1000).toISOString(),
      trigger: 'approve',
      initial: false,
      changed: true,
      l0_sha256: `hash-${i}`,
      l0_tokens: 100 + i,
      corpus_tokens: 500,
      active_entries: 1,
    })),
  ];
  fs.writeFileSync(
    getMetricsPath(homeDir),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const res = runCli(['stats'], { homeDir, userHome });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('Last 7 days: 7'));
  assert.ok(/churn/i.test(res.stdout));
  assert.ok(/batch/i.test(res.stdout));
});

test('02/AC-09a: faber-memory stats --json outputs valid structured JSON', () => {
  const tmp = makeTempDir('v02-ac09a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const res = runCli(['stats', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.windowDays, 30);
  assert.ok('ledger' in parsed);
  assert.ok('corpus' in parsed);
  assert.ok('mcpSchema' in parsed);
  assert.ok('l0Stability' in parsed);
  assert.ok('retrieval' in parsed);
  assert.ok('entryTemperature' in parsed);
  assert.ok('funnel' in parsed);
});

test('02/AC-09b: faber-memory stats --days 91 rejects out-of-range windows with exit code 1', () => {
  const tmp = makeTempDir('v02-ac09b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);

  for (const bad of ['0', '-5', '91', 'abc']) {
    const res = runCli(['stats', '--days', bad], { homeDir, userHome });
    assert.equal(res.status, 1, `expected exit 1 for --days ${bad}`);
    assert.ok(res.stderr.includes('1') && res.stderr.includes('90'));
  }
});

test('02/AC-09c: faber-memory stats with no configuration exits 0 with a setup hint', () => {
  const tmp = makeTempDir('v02-ac09c-');
  const homeDir = path.join(tmp, 'empty-home');
  const userHome = path.join(tmp, 'user');

  const res = runCli(['stats'], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('faber-memory setup'));
});

test('02/AC-10: faber-memory stats reports uncapped get-calls-per-search ratio, zero-result rate, and pure BM25 median latency', () => {
  const tmp = makeTempDir('v02-ac10-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const now = Date.now();
  const latencies = [1, 2, 3, 4, 4, 5, 6, 7, 8, 9];
  const events: unknown[] = [
    ...latencies.map((lat, i) => ({
      type: 'search',
      ts: new Date(now - (1000 - i) * 1000).toISOString(),
      result_count: i < 2 ? 0 : 2,
      zero_result: i < 2,
      empty_query: false,
      latency_ms: lat,
    })),
    // 2 empty-query listings (excluded from denominator and zero-result)
    {
      type: 'search',
      ts: new Date(now - 500_000).toISOString(),
      result_count: 0,
      zero_result: true,
      empty_query: true,
      latency_ms: 99,
    },
    {
      type: 'search',
      ts: new Date(now - 499_000).toISOString(),
      result_count: 5,
      zero_result: false,
      empty_query: true,
      latency_ms: 99,
    },
    // 12 get events
    ...Array.from({ length: 12 }, (_, i) => ({
      type: 'get',
      ts: new Date(now - (400 - i) * 1000).toISOString(),
      found_ids: ['personal:alpha'],
      found_count: 1,
      not_found_count: 0,
      latency_ms: 1,
    })),
  ];

  fs.writeFileSync(
    getMetricsPath(homeDir),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--days', '30', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.retrieval.nonEmptySearches, 10);
  assert.equal(parsed.retrieval.getCalls, 12);
  assert.equal(parsed.retrieval.getCallsPerSearch, 1.2);
  assert.equal(parsed.retrieval.zeroResultCount, 2);
  assert.equal(parsed.retrieval.zeroResultPct, 20);
  assert.equal(parsed.retrieval.medianBm25LatencyMs, 4);
});

test('02/AC-11: faber-memory stats ranks top 10 hot entries by scope:id and separates cold, stale, and unverified L0 candidates', () => {
  const tmp = makeTempDir('v02-ac11-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const staleDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  commitMarkdownFile(
    personalDir,
    'entry-hot.md',
    `---\nsummary: Hot entry\ntype: rule\nl0: line\nlast_verified: ${recentDate}\n---\n\nHot body.\n`,
  );
  commitMarkdownFile(
    personalDir,
    'entry-cold.md',
    `---\nsummary: Cold entry\ntype: rule\nl0: line\nlast_verified: ${recentDate}\n---\n\nCold body.\n`,
  );
  commitMarkdownFile(
    personalDir,
    'entry-stale.md',
    `---\nsummary: Stale entry\ntype: rule\nl0: line\nlast_verified: ${staleDate}\n---\n\nStale body.\n`,
  );
  commitMarkdownFile(
    personalDir,
    'entry-unverified.md',
    `---\nsummary: Unverified entry\ntype: rule\nl0: line\n---\n\nUnverified body.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const now = Date.now();
  const coverageStart = new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString();
  const recentTs = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const events: unknown[] = [
    {
      type: 'compile',
      ts: coverageStart,
      trigger: 'cli',
      initial: true,
      changed: false,
      l0_sha256: 'abc',
      l0_tokens: 100,
      corpus_tokens: 200,
      active_entries: 4,
    },
    ...Array.from({ length: 8 }, () => ({
      type: 'get',
      ts: recentTs,
      found_ids: ['personal:entry-hot'],
      found_count: 1,
      not_found_count: 0,
      latency_ms: 1,
    })),
    ...Array.from({ length: 2 }, () => ({
      type: 'get',
      ts: recentTs,
      found_ids: ['personal:entry-unverified'],
      found_count: 1,
      not_found_count: 0,
      latency_ms: 1,
    })),
  ];
  fs.writeFileSync(
    getMetricsPath(homeDir),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--days', '30', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.entryTemperature.coldWithheld, false);
  assert.equal(parsed.entryTemperature.hotEntries[0].id, 'personal:entry-hot');
  assert.equal(parsed.entryTemperature.hotEntries[0].hits, 8);
  assert.ok(parsed.entryTemperature.coldL0Entries.includes('personal:entry-cold'));
  assert.ok(parsed.entryTemperature.coldL0Entries.includes('personal:entry-stale'));
  assert.ok(
    parsed.entryTemperature.staleL0Entries.some(
      (s: { id: string }) => s.id === 'personal:entry-stale',
    ),
  );
  assert.ok(parsed.entryTemperature.unverifiedL0Entries.includes('personal:entry-unverified'));
  assert.ok(
    !parsed.entryTemperature.staleL0Entries.some(
      (s: { id: string }) => s.id === 'personal:entry-unverified',
    ),
  );
});

test('02/AC-12: faber-memory stats reports complete pre-memory governance funnel across MCP and import sources and all review outcomes', () => {
  const tmp = makeTempDir('v02-ac12-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const ts = new Date().toISOString();
  const events = [
    { type: 'propose', ts, source: 'mcp', scope: 'personal', action: 'create', outcome: 'staged' },
    { type: 'propose', ts, source: 'mcp', scope: 'personal', action: 'create', outcome: 'duplicate_blocked' },
    { type: 'propose', ts, source: 'mcp', scope: 'personal', action: 'create', outcome: 'hygiene_blocked', hygiene_category: 'secret' },
    { type: 'propose', ts, source: 'mcp', scope: 'personal', action: 'create', outcome: 'hygiene_blocked', hygiene_category: 'machine-path' },
    { type: 'propose', ts, source: 'mcp', scope: 'personal', action: 'update', outcome: 'validation_error' },
    { type: 'propose', ts, source: 'import', scope: 'personal', action: 'create', outcome: 'staged' },
    { type: 'propose', ts, source: 'import', scope: 'personal', action: 'create', outcome: 'duplicate_blocked' },
    { type: 'propose', ts, source: 'import', scope: 'personal', action: 'create', outcome: 'hygiene_blocked', hygiene_category: 'secret' },
    { type: 'propose', ts, source: 'import', scope: 'personal', action: 'create', outcome: 'hygiene_blocked', hygiene_category: 'machine-path' },
    { type: 'review_outcome', ts, scope: 'personal', outcome: 'approved_committed' },
    { type: 'review_outcome', ts, scope: 'team', outcome: 'approved_pushed' },
    { type: 'review_outcome', ts, scope: 'team', outcome: 'approved_pr' },
    { type: 'review_outcome', ts, scope: 'team', outcome: 'push_failed' },
    { type: 'review_outcome', ts, scope: 'project', outcome: 'awaiting_commit' },
    { type: 'review_outcome', ts, scope: 'personal', outcome: 'rejected' },
  ];
  fs.writeFileSync(
    getMetricsPath(homeDir),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.funnel.bySource.mcp, {
    staged: 1,
    duplicateBlocked: 1,
    hygieneBlockedSecret: 1,
    hygieneBlockedMachinePath: 1,
    validationError: 1,
  });
  assert.deepEqual(parsed.funnel.bySource.import, {
    staged: 1,
    duplicateBlocked: 1,
    hygieneBlockedSecret: 1,
    hygieneBlockedMachinePath: 1,
    validationError: 0,
  });
  assert.deepEqual(parsed.funnel.reviewOutcomes, {
    approvedCommitted: 1,
    approvedPushed: 1,
    approvedPr: 1,
    pushFailed: 1,
    awaitingCommit: 1,
    rejected: 1,
  });
});

test('02/AC-13a: faber-memory stats handles missing metrics ledger gracefully', () => {
  const tmp = makeTempDir('v02-ac13a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);
  fs.unlinkSync(getMetricsPath(homeDir));

  const res = runCli(['stats', '--days', '30'], { homeDir, userHome });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('Context & Token Efficiency'));
  assert.ok(res.stdout.includes('MCP 3-tool schema footprint'));
  assert.ok(/No runtime usage metrics recorded yet/i.test(res.stdout));
});

test('02/AC-13b: faber-memory stats withholds Cold L0 entries when ledger coverage is shorter than --days', () => {
  const tmp = makeTempDir('v02-ac13b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);
  commitMarkdownFile(
    personalDir,
    'fresh-rule.md',
    `---\nsummary: Fresh entry\ntype: rule\nl0: line\n---\n\nFresh body.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    getMetricsPath(homeDir),
    JSON.stringify({
      type: 'search',
      ts: threeDaysAgo,
      result_count: 1,
      zero_result: false,
      empty_query: false,
      latency_ms: 1,
    }) + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--days', '30'], { homeDir, userHome });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('coverage: 3d'));
  assert.ok(/Cold L0 entries: withheld/i.test(res.stdout));
});
