import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  formatPlanBeforeAfter,
  gitInitSoloRepo,
  loadConfig,
  normalizeMachinePaths,
  normalizeTeamUrl,
  runImport,
  saveConfig,
} from '../src/index.js';

const CLI_PATH = path.resolve(import.meta.dirname, '../src/cli.js');

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `faber-mem-ux-${prefix}-`));
}

function runCli(args: string[], env: Record<string, string>, input?: string) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, NO_COLOR: '1', ...env },
    input,
    encoding: 'utf8',
  });
}

test('v0.1.1: normalizeTeamUrl handles shorthand, host/path, https, ssh, and local paths', () => {
  assert.deepEqual(normalizeTeamUrl('github.com/org/repo'), {
    url: 'https://github.com/org/repo.git',
    normalized: true,
  });
  assert.deepEqual(normalizeTeamUrl('github.com/org/repo.git'), {
    url: 'https://github.com/org/repo.git',
    normalized: true,
  });
  assert.deepEqual(normalizeTeamUrl('org/repo'), {
    url: 'https://github.com/org/repo.git',
    normalized: true,
  });
  assert.deepEqual(normalizeTeamUrl('https://github.com/org/repo.git'), {
    url: 'https://github.com/org/repo.git',
    normalized: false,
  });
  assert.deepEqual(normalizeTeamUrl('git@github.com:org/repo.git'), {
    url: 'git@github.com:org/repo.git',
    normalized: false,
  });
  assert.deepEqual(normalizeTeamUrl('/tmp/local-bare.git'), {
    url: '/tmp/local-bare.git',
    normalized: false,
  });
});

test('v0.1.1: normalizeMachinePaths and import --normalize-paths + skippedIndex reporting', async () => {
  const norm = normalizeMachinePaths('See /Users/alice/Projects/app and /home/bob/data.');
  assert.equal(norm.replacements, 2);
  assert.equal(norm.content, 'See ~/Projects/app and ~/data.');

  const tmp = mkTmp('import');
  const homeDir = path.join(tmp, 'state');
  const personalDir = path.join(tmp, 'personal');
  const srcDir = path.join(tmp, 'notes');
  fs.mkdirSync(srcDir, { recursive: true });
  gitInitSoloRepo(personalDir, 'main');

  const config = loadConfig(homeDir);
  config.roots.personal = {
    uuid: 'u-personal',
    path: personalDir,
    scope: 'personal',
    defaultBranch: 'main',
  };
  saveConfig(config, homeDir);

  fs.writeFileSync(path.join(srcDir, 'MEMORY.md'), '# Old Index\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'note.md'), '# Paths\n\nCode at /Users/alice/Projects/foo.\n', 'utf8');

  // Without --normalize-paths: skipped by hygiene with snippet & anchor, index reported
  const r1 = await runImport(config, { from: 'markdown-dir', sourcePath: srcDir, homeDir });
  assert.equal(r1.staged.length, 0);
  assert.equal(r1.skippedIndex.length, 1);
  assert.equal(r1.skippedHygiene.length, 1);
  assert.equal(r1.skippedHygiene[0].anchor, 'machine-specific-paths');
  assert.ok(r1.skippedHygiene[0].snippet?.includes('[MACHINE_PATH]'));

  // With --normalize-paths: staged cleanly with ~/
  const r2 = await runImport(config, {
    from: 'markdown-dir',
    sourcePath: srcDir,
    normalizePaths: true,
    homeDir,
  });
  assert.equal(r2.staged.length, 1);
  assert.equal(r2.normalizedPaths.length, 1);
  assert.ok(r2.staged[0].body.includes('~/Projects/foo'));
  assert.equal(r2.skippedIndex.length, 1);
});

test('v0.1.1: review supports [b]ack navigation and [q]uit & save without losing approvals', () => {
  const tmp = mkTmp('review');
  const homeDir = path.join(tmp, 'state');
  const personalDir = path.join(tmp, 'personal');
  const srcDir = path.join(tmp, 'notes');
  fs.mkdirSync(srcDir, { recursive: true });

  const env = { FABER_MEMORY_HOME: homeDir, FABER_USER_HOME: tmp };
  assert.equal(runCli(['setup', personalDir], env).status, 0);

  fs.writeFileSync(path.join(srcDir, 'first.md'), '# First Rule\n\nAlpha rule body.\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'second.md'), '# Second Rule\n\nBeta rule body.\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'third.md'), '# Third Rule\n\nGamma rule body.\n', 'utf8');
  assert.equal(runCli(['import', '--from', 'markdown-dir', srcDir], env).status, 0);

  // Skip first -> go back -> approve first -> quit & save (leaving 2 remaining)
  const rev = runCli(['review'], env, 's\nb\na\nq\n');
  assert.equal(rev.status, 0, rev.stderr);
  assert.match(rev.stdout, /1 approved/);
  assert.match(rev.stdout, /2 remaining in pre-memory/);

  // Status should show exactly 2 remaining proposals
  const st = runCli(['status'], env);
  assert.equal(st.status, 0);
  assert.match(st.stdout, /Pending proposals: 2/);
});

test('v0.1.1: reject --all, config unset, reset, and Before/After init formatting', () => {
  const tmp = mkTmp('cleanup');
  const homeDir = path.join(tmp, 'state');
  const personalDir = path.join(tmp, 'personal');
  const srcDir = path.join(tmp, 'notes');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });

  const env = { FABER_MEMORY_HOME: homeDir, FABER_USER_HOME: tmp };
  assert.equal(runCli(['setup', personalDir], env).status, 0);

  // init dry-run prints Before/After
  const dry = runCli(['init', '--preview'], env);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /Before:/);
  assert.match(dry.stdout, /After:/);

  const formatted = formatPlanBeforeAfter(
    {
      filePath: '/tmp/CLAUDE.md',
      kind: 'instruction',
      engine: 'claude-code',
      before: 'old line\n',
      after: 'old line\nnew line\n',
      changed: true,
    },
    false,
  );
  assert.match(formatted, /Before:/);
  assert.match(formatted, /After:/);
  assert.match(formatted, /\+ new line/);

  // Stage 2 proposals and clear with reject --all --yes
  fs.writeFileSync(path.join(srcDir, 'one.md'), '# One\n\nBody one.\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'two.md'), '# Two\n\nBody two.\n', 'utf8');
  assert.equal(runCli(['import', '--from', 'markdown-dir', srcDir], env).status, 0);
  const rejAll = runCli(['reject', '--all', '--yes'], env);
  assert.equal(rejAll.status, 0);
  assert.match(rejAll.stdout, /Rejected and removed 2 pending proposal/);

  // config unset personal keeps disk directory
  const unset = runCli(['config', 'unset', 'personal'], env);
  assert.equal(unset.status, 0);
  assert.equal(fs.existsSync(personalDir), true);
  assert.equal(loadConfig(homeDir).roots.personal, undefined);

  // reset --yes removes state dir
  const reset = runCli(['reset', '--yes'], env);
  assert.equal(reset.status, 0);
  assert.equal(fs.existsSync(homeDir), false);
});
