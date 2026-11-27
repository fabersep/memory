import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { getCompiledL0Path, getConfigPath, loadConfig } from '../src/config.js';
import { getMetricsPath } from '../src/metrics.js';
import { createProposal, saveProposal } from '../src/proposals.js';
import { getPackageVersion } from '../src/stats.js';
import { commitMarkdownFile, createBareRemoteWithMain, makeTempDir, runCli } from './helpers.js';

function setupPersonalRoot(baseDir: string, homeDir: string, userHome: string): string {
  const personalDir = path.join(baseDir, 'personal-mem');
  const res = runCli(['setup', personalDir], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  return personalDir;
}

test('02/AC-14: stats --cache parses Claude Code JSONL with message-ID dedup, sidechain exclusion, and 5-min TTL filtering', () => {
  const tmp = makeTempDir('v02-ac14-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const logDir = path.join(tmp, 'claude-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const baseMs = Date.now() - 3600_000;
  const iso = (offsetSec: number) => new Date(baseMs + offsetSec * 1000).toISOString();

  const lines = [
    // Step 1 (duplicate message IDs -> deduped to last record: 8000 / (1000+8000+1000) = 80%)
    {
      timestamp: iso(0),
      message: {
        id: 'msg-1',
        model: 'claude-sonnet',
        usage: { input_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 },
      },
    },
    {
      timestamp: iso(1),
      message: {
        id: 'msg-1',
        model: 'claude-sonnet',
        usage: { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000 },
      },
    },
    // Sidechain record -> excluded
    {
      timestamp: iso(30),
      isSidechain: true,
      message: {
        id: 'msg-side',
        model: 'claude-sonnet',
        usage: { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    // Step 2 (warm, +60s <= 5m): 9000 / (500+9000+500) = 90%
    {
      timestamp: iso(60),
      message: {
        id: 'msg-2',
        model: 'claude-sonnet',
        usage: { input_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 },
      },
    },
    // Step 3 (12-minute idle gap -> excluded from warm average): 0%
    {
      timestamp: iso(60 + 12 * 60),
      message: {
        id: 'msg-3',
        model: 'claude-sonnet',
        usage: { input_tokens: 10000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];
  fs.writeFileSync(
    path.join(logDir, 'session-1.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );

  const res = runCli(
    ['stats', '--cache', '--engine', 'claude-code', '--log-dir', logDir, '--json'],
    { homeDir, userHome },
  );
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  const eng = parsed.cache.engines[0];
  assert.equal(eng.engine, 'claude-code');
  assert.equal(eng.sessions, 1);
  assert.equal(eng.steps, 3);
  assert.equal(eng.firstSteps, 1);
  assert.equal(eng.warmSteps, 1);
  assert.equal(eng.idleGapExcludedSteps, 1);
  assert.equal(eng.firstStepHitPct, 80);
  assert.equal(eng.warmStepHitPct, 90);
});

test('02/AC-15: stats --cache parses Antigravity transcript.jsonl grouped by model with 5-min TTL filtering', () => {
  const tmp = makeTempDir('v02-ac15-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const convDir = path.join(tmp, 'agy-logs', 'conv-1', '.system_generated', 'logs');
  fs.mkdirSync(convDir, { recursive: true });
  const baseMs = Date.now() - 3600_000;
  const iso = (offsetSec: number) => new Date(baseMs + offsetSec * 1000).toISOString();

  const records = [
    {
      type: 'PLANNER_RESPONSE',
      created_at: iso(0),
      model: 'claude-opus-5-5-medium',
      input_tokens: 15572,
      cache_read_tokens: 8581,
    },
    {
      type: 'PLANNER_RESPONSE',
      created_at: iso(60),
      model: 'claude-opus-5-5-medium',
      input_tokens: 20000,
      cache_read_tokens: 18000,
    },
    {
      type: 'PLANNER_RESPONSE',
      created_at: iso(60 + 10 * 60),
      model: 'claude-opus-5-5-medium',
      input_tokens: 20000,
      cache_read_tokens: 0,
    },
  ];
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), content, 'utf8');
  // Duplicate full transcript must be ignored
  fs.writeFileSync(path.join(convDir, 'transcript_full.jsonl'), content, 'utf8');

  const res = runCli(
    ['stats', '--cache', '--engine', 'antigravity', '--log-dir', path.join(tmp, 'agy-logs'), '--json'],
    { homeDir, userHome },
  );
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  const eng = parsed.cache.engines[0];
  assert.equal(eng.engine, 'antigravity');
  assert.equal(eng.sessions, 1);
  assert.equal(eng.firstStepHitPct, 55.1);
  assert.equal(eng.warmStepHitPct, 90);
  assert.equal(eng.idleGapExcludedSteps, 1);
  assert.equal(eng.byModel.length, 1);
  assert.equal(eng.byModel[0].model, 'claude-opus-5-5-medium');
  assert.equal(eng.byModel[0].firstStepHitPct, 55.1);
});

test('02/AC-16a: stats --cache correlates eligible Claude Code session-start cache drops with L0 recompiles', () => {
  const tmp = makeTempDir('v02-ac16a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const T = Date.now() - 10 * 60 * 1000;
  fs.writeFileSync(
    getMetricsPath(homeDir),
    JSON.stringify({
      type: 'compile',
      ts: new Date(T).toISOString(),
      trigger: 'approve',
      initial: false,
      changed: true,
      l0_sha256: 'new-hash',
      l0_tokens: 600,
      corpus_tokens: 3000,
      active_entries: 5,
    }) + '\n',
    'utf8',
  );

  const logDir = path.join(tmp, 'claude-corr');
  fs.mkdirSync(logDir, { recursive: true });
  // Session 1 ends at T - 1 min, first-turn cache_read = 12000
  fs.writeFileSync(
    path.join(logDir, 's1.jsonl'),
    JSON.stringify({
      timestamp: new Date(T - 60_000).toISOString(),
      message: {
        id: 's1-m1',
        model: 'claude-sonnet',
        usage: { input_tokens: 1000, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0 },
      },
    }) + '\n',
    'utf8',
  );
  // Session 2 starts at T + 2 min (within 5m TTL), first-turn cache_read = 11200 (drop 800 >= 600)
  fs.writeFileSync(
    path.join(logDir, 's2.jsonl'),
    JSON.stringify({
      timestamp: new Date(T + 120_000).toISOString(),
      message: {
        id: 's2-m1',
        model: 'claude-sonnet',
        usage: { input_tokens: 1000, cache_read_input_tokens: 11200, cache_creation_input_tokens: 800 },
      },
    }) + '\n',
    'utf8',
  );

  const res = runCli(
    ['stats', '--cache', '--engine', 'claude-code', '--log-dir', logDir, '--json'],
    { homeDir, userHome },
  );
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  const corr = parsed.cache.engines[0].correlation;
  assert.equal(corr.eligibleSessions, 1);
  assert.equal(corr.correlatedBreaks, 1);
});

test('02/AC-16b: stats --cache explains why L0 prefix-break correlation does not apply to Antigravity', () => {
  const tmp = makeTempDir('v02-ac16b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const logDir = path.join(tmp, 'agy-logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'transcript.jsonl'),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date().toISOString(),
      model: 'gemini-4-neon',
      input_tokens: 10000,
      cache_read_tokens: 8000,
    }) + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--cache', '--engine', 'antigravity', '--log-dir', logDir], {
    homeDir,
    userHome,
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('claude-code'));
  assert.ok(/tool call/i.test(res.stdout));
});

test('02/AC-17: stats --cache skips malformed log lines without printing parse error text', () => {
  const tmp = makeTempDir('v02-ac17-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const logDir = path.join(tmp, 'malformed-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const validLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    message: {
      id: 'ok-1',
      model: 'claude-sonnet',
      usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    },
  });
  const corruptLine = '{"broken": "top-secret-prompt-fragment"';
  fs.writeFileSync(path.join(logDir, 's.jsonl'), `${validLine}\n${corruptLine}\n`, 'utf8');

  const res = runCli(
    ['stats', '--cache', '--engine', 'claude-code', '--log-dir', logDir],
    { homeDir, userHome },
  );
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('Skipped malformed lines: 1'));
  assert.ok(!res.stdout.includes('top-secret-prompt-fragment'));
  assert.ok(!res.stderr.includes('top-secret-prompt-fragment'));
});

test('02/AC-18a: stats --cache handles missing log directories cleanly', () => {
  const tmp = makeTempDir('v02-ac18a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const res = runCli(
    ['stats', '--cache', '--log-dir', path.join(tmp, 'does-not-exist')],
    { homeDir, userHome },
  );
  assert.equal(res.status, 0);
  assert.ok(/No session logs found/i.test(res.stdout));
});

test('02/AC-18b: stats --cache reports GAP-01 cleanly for unsupported engines (cursor, codex)', () => {
  const tmp = makeTempDir('v02-ac18b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  for (const engine of ['cursor', 'codex']) {
    const res = runCli(['stats', '--cache', '--engine', engine], { homeDir, userHome });
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes('GAP-01'));
  }
});

test('02/AC-18c: stats --cache reports unrecognized log format cleanly on Antigravity schema drift', () => {
  const tmp = makeTempDir('v02-ac18c-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const logDir = path.join(tmp, 'agy-drift');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'transcript.jsonl'),
    JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: new Date().toISOString(), model: 'x' }) + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--cache', '--engine', 'antigravity', '--log-dir', logDir], {
    homeDir,
    userHome,
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('unrecognized log format'));
});

test('02/AC-19: stats --share outputs anonymized Markdown card with zero PII/IDs/paths/models and dynamic package version', () => {
  const tmp = makeTempDir('v02-ac19-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = path.join(tmp, 'private-repo');
  assert.equal(runCli(['setup', personalDir], { homeDir, userHome }).status, 0);

  commitMarkdownFile(
    personalDir,
    'secret-project-rule.md',
    `---\nsummary: Internal acme secret rule\ntype: rule\nl0: line\n---\n\nInternal acme body.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const logDir = path.join(tmp, 'agy-logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'transcript.jsonl'),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date().toISOString(),
      model: 'acme-internal-llm-v2',
      input_tokens: 10000,
      cache_read_tokens: 8000,
    }) + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--share', '--cache', '--log-dir', logDir], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`v${getPackageVersion()}`));
  assert.ok(!res.stdout.includes('secret-project-rule'));
  assert.ok(!res.stdout.includes('private-repo'));
  assert.ok(!res.stdout.includes('acme-internal-llm-v2'));
  assert.ok(!res.stdout.includes(tmp));
});

test('02/AC-20: stats --share --json conforms strictly to closed allowlist schema', () => {
  const tmp = makeTempDir('v02-ac20-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);
  commitMarkdownFile(
    personalDir,
    'sensitive-id-xyz.md',
    `---\nsummary: Sensitive summary\ntype: rule\nl0: line\n---\n\nSensitive body.\n`,
  );
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);

  const logDir = path.join(tmp, 'agy-logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'transcript.jsonl'),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date().toISOString(),
      model: 'custom-secret-model',
      input_tokens: 10000,
      cache_read_tokens: 7500,
    }) + '\n',
    'utf8',
  );

  const res = runCli(['stats', '--share', '--cache', '--json', '--log-dir', logDir], {
    homeDir,
    userHome,
  });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  const allowedTop = new Set([
    'schemaVersion',
    'packageVersion',
    'windowDays',
    'corpus',
    'mcpSchemaTokens',
    'l0Stability',
    'retrieval',
    'funnel',
    'cache',
  ]);
  for (const k of Object.keys(parsed)) {
    assert.ok(allowedTop.has(k), `unexpected top-level key in --share --json: ${k}`);
  }
  const cacheObj = parsed.cache as Record<string, unknown>;
  assert.ok(cacheObj);
  for (const k of Object.keys(cacheObj)) {
    assert.ok(k === 'claude-code' || k === 'antigravity', `unexpected cache key: ${k}`);
  }
  assert.ok(!res.stdout.includes('sensitive-id-xyz'));
  assert.ok(!res.stdout.includes('custom-secret-model'));
  assert.ok(!res.stdout.includes(tmp));
});

test('02/AC-21: faber-memory doctor reports all PASS and exits 0 on a healthy setup', () => {
  const tmp = makeTempDir('v02-ac21-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'healthy-rule.md',
    `---\nsummary: Healthy rule\ntype: rule\nl0: line\n---\n\nAll good.\n`,
  );
  assert.equal(runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome }).status, 0);

  const res = runCli(['doctor', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0, res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.overall, 'PASS');
  assert.equal(parsed.checks.length, 6);
  for (const ch of parsed.checks) {
    assert.equal(ch.status, 'PASS', `expected PASS for ${ch.id}, got ${ch.status}: ${ch.details.join('; ')}`);
  }
});

test('02/AC-22a: faber-memory doctor reports WARN with hints for dirty root, stale L0, stale proposal, and L0 churn and exits 0', () => {
  const tmp = makeTempDir('v02-ac22a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'rule-one.md',
    `---\nsummary: Rule one\ntype: rule\nl0: line\n---\n\nBody one.\n`,
  );
  assert.equal(runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome }).status, 0);

  // 1. Commit a second entry without recompiling -> stale L0
  commitMarkdownFile(
    personalDir,
    'rule-two.md',
    `---\nsummary: Rule two\ntype: rule\nl0: line\n---\n\nBody two.\n`,
  );

  // 2. Dirty working tree in personal root
  fs.writeFileSync(path.join(personalDir, 'uncommitted.md'), 'draft\n', 'utf8');

  // 3. Stale proposal older than staleDays
  const config = loadConfig(homeDir);
  const prop = createProposal(
    config,
    { scope: 'personal', action: 'create', summary: 'Old prop', type: 'rule', body: 'Old body' },
    homeDir,
  );
  prop.createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  saveProposal(prop, homeDir);

  // 4. L0 churn (>5 changed: true events in 7 days)
  const now = Date.now();
  const churnEvents = Array.from({ length: 6 }, (_, i) => ({
    type: 'compile',
    ts: new Date(now - (6 - i) * 3600_000).toISOString(),
    trigger: 'approve',
    initial: false,
    changed: true,
    l0_sha256: `h-${i}`,
    l0_tokens: 100,
    corpus_tokens: 300,
    active_entries: 2,
  }));
  fs.writeFileSync(
    getMetricsPath(homeDir),
    churnEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const res = runCli(['doctor', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  const byId = new Map<string, { status: string; hint?: string }>(
    parsed.checks.map((ch: { id: string; status: string; hint?: string }) => [ch.id, ch]),
  );
  for (const id of ['config-and-roots', 'compiled-l0', 'pre-memory-queue', 'cache-stability']) {
    const ch = byId.get(id);
    assert.ok(ch);
    assert.equal(ch.status, 'WARN', `expected WARN for ${id}`);
    assert.ok(ch.hint && ch.hint.length > 0, `expected hint for ${id}`);
  }
});

test('02/AC-22b: faber-memory doctor reports WARN and exits 0 on team-only setup with no personal root', () => {
  const tmp = makeTempDir('v02-ac22b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const { bareDir } = createBareRemoteWithMain(tmp, false);

  const setupRes = runCli(['setup', '--team', bareDir, '--path', path.join(tmp, 'team-clone')], {
    homeDir,
    userHome,
  });
  assert.equal(setupRes.status, 0, setupRes.stderr);
  assert.equal(runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome }).status, 0);

  const res = runCli(['doctor', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  const rootCheck = parsed.checks.find((ch: { id: string }) => ch.id === 'config-and-roots');
  assert.equal(rootCheck.status, 'WARN');
  assert.ok(rootCheck.hint);
});

test('02/AC-23a: faber-memory doctor reports FAIL for missing L0 and hygiene violation, exits 1, and modifies nothing on disk', () => {
  const tmp = makeTempDir('v02-ac23a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const personalDir = setupPersonalRoot(tmp, homeDir, userHome);

  commitMarkdownFile(
    personalDir,
    'leaked.md',
    `---\nsummary: Has secret\ntype: rule\nl0: line\n---\n\nBearer supersecrettoken1234567890\n`,
  );

  const l0Path = getCompiledL0Path(homeDir);
  assert.ok(!fs.existsSync(l0Path));
  const indexStatBefore = fs.statSync(path.join(personalDir, '.git', 'index')).mtimeMs;

  const res = runCli(['doctor', '--json'], { homeDir, userHome });
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  const l0Check = parsed.checks.find((ch: { id: string }) => ch.id === 'compiled-l0');
  const hygieneCheck = parsed.checks.find((ch: { id: string }) => ch.id === 'hygiene-and-schema');
  assert.equal(l0Check.status, 'FAIL');
  assert.equal(hygieneCheck.status, 'FAIL');

  // Strictly read-only
  assert.ok(!fs.existsSync(l0Path), 'doctor must not create MEMORY.md');
  assert.equal(
    fs.statSync(path.join(personalDir, '.git', 'index')).mtimeMs,
    indexStatBefore,
    'doctor must not rewrite Git index',
  );
});

test('02/AC-23b: faber-memory doctor catches corrupt config.json, reports FAIL, exits 1, and modifies nothing on disk', () => {
  const tmp = makeTempDir('v02-ac23b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  fs.mkdirSync(homeDir, { recursive: true });
  const cfgPath = getConfigPath(homeDir);
  const corrupt = '{"version": 1, "roots": {';
  fs.writeFileSync(cfgPath, corrupt, 'utf8');

  const res = runCli(['doctor'], { homeDir, userHome });
  assert.equal(res.status, 1);
  assert.ok(res.stdout.includes('[FAIL]'));
  assert.ok(!res.stderr.includes('SyntaxError'));
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), corrupt);
});

test('02/AC-24a: faber-memory doctor --json outputs structured check results and exits 0 when only warnings exist', () => {
  const tmp = makeTempDir('v02-ac24a-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);
  // No engine wired -> WARN only, zero FAIL

  const res = runCli(['doctor', '--json'], { homeDir, userHome });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.overall, 'WARN');
  for (const ch of parsed.checks) {
    assert.ok(typeof ch.name === 'string');
    assert.ok(['PASS', 'WARN', 'FAIL'].includes(ch.status));
  }
});

test('02/AC-24b: faber-memory doctor --strict exits 1 when any WARN check is present', () => {
  const tmp = makeTempDir('v02-ac24b-');
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  setupPersonalRoot(tmp, homeDir, userHome);
  assert.equal(runCli(['compile'], { homeDir, userHome }).status, 0);
  // No engine wired -> WARN

  const res = runCli(['doctor', '--strict'], { homeDir, userHome });
  assert.equal(res.status, 1);
});
