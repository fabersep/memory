import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { listAllProposals } from '../src/index.js';
import { CLI_BIN, makeTempDir, runCli } from './helpers.js';
import { getPackageVersion } from '../src/version.js';

const pkgVersion = (
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    version: string;
  }
).version;

test('v0.2.1: --version prints the package.json version', () => {
  const tmp = makeTempDir();
  const res = runCli(['--version'], { homeDir: path.join(tmp, 'home') });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkgVersion);
  assert.equal(getPackageVersion(), pkgVersion);
});

test('v0.2.1: MCP serverInfo and compiled L0 header carry the package version', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir });
  runCli(['compile'], { homeDir });
  const l0 = fs.readFileSync(path.join(homeDir, 'state', 'MEMORY.md'), 'utf8');
  assert.ok(l0.includes(`@fabersep/memory v${pkgVersion}`), l0);

  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  const res = spawnSync(process.execPath, [CLI_BIN, 'serve'], {
    input: `${init}\n`,
    encoding: 'utf8',
    env: { ...process.env, FABER_MEMORY_HOME: homeDir },
    timeout: 10000,
  });
  const first = (res.stdout || '').split('\n').find((l) => l.includes('"serverInfo"'));
  assert.ok(first, res.stdout + res.stderr);
  const parsed = JSON.parse(first!) as { result: { serverInfo: { version: string } } };
  assert.equal(parsed.result.serverInfo.version, pkgVersion);
});

test('v0.2.1: import --split-headings skips a title heading that has no body of its own', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir });
  const agentsFile = path.join(tmp, 'AGENTS.md');
  fs.writeFileSync(agentsFile, '# Rules\n\n## Use pnpm\n\nPrefer pnpm.\n\n## Small PRs\n\nKeep PRs small.\n');
  const res = runCli(['import', '--from', 'agents-md', agentsFile, '--split-headings'], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  const summaries = listAllProposals(homeDir).map((p) => p.summary).sort();
  assert.deepEqual(summaries, ['Small PRs', 'Use pnpm']);
});

test('v0.2.1: import prints a NOT imported line when hygiene leaves items out', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir });
  const dir = path.join(tmp, 'notes');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Build output lives in /Users/someone/build.\n');
  const res = runCli(['import', '--from', 'markdown-dir', dir], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('NOT imported: 1 item(s)'), res.stdout);
});

test('v0.2.1: init blocks tell the agent when to call memory_propose', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(userHome, '.gemini'), { recursive: true });
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });
  const res = runCli(['init', '--apply', '--engine', 'claude-code,antigravity'], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  for (const file of [
    path.join(userHome, '.claude', 'CLAUDE.md'),
    path.join(userHome, '.gemini', 'GEMINI.md'),
  ]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('call memory_propose'), `${file}: ${text}`);
  }
});
