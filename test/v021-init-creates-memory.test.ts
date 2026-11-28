import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { CLI_BIN, git, makeTempDir } from './helpers.js';

// Runs the CLI with HOME pointed at a temp dir, so the default ~/.faber/memory stays inside it.
function run(args: string[], tmp: string) {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      FABER_MEMORY_HOME: path.join(home, '.config', 'faber-memory'),
      FABER_USER_HOME: home,
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
    },
  });
  return { status: res.status ?? 1, out: (res.stdout || '') + (res.stderr || ''), home };
}

function readConfig(home: string) {
  return JSON.parse(fs.readFileSync(path.join(home, '.config', 'faber-memory', 'config.json'), 'utf8')) as {
    roots: { personal?: { path: string }; team?: unknown };
  };
}

test('init without setup creates ~/.faber/memory and connects engines', () => {
  const tmp = makeTempDir();
  const r = run(['init'], tmp);
  assert.equal(r.status, 0, r.out);
  const personal = path.join(r.home, '.faber', 'memory');
  assert.ok(fs.existsSync(path.join(personal, '.git')), r.out);
  assert.equal(readConfig(r.home).roots.personal?.path, personal);
  assert.match(r.out, /Created your personal memory folder/);
  assert.ok(fs.readFileSync(path.join(r.home, '.claude', 'CLAUDE.md'), 'utf8').includes('faber-memory:start'));

  const again = run(['init'], tmp);
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.out, /Created your personal memory folder/);
});

test('init <folder> uses that folder and hints about uncommitted notes in it', () => {
  const tmp = makeTempDir();
  const folder = path.join(tmp, 'my-notes');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'sub', 'rule.md'), 'Use pnpm.\n');
  const r = run(['init', '--preview', folder], tmp);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Would create your personal memory folder/);
  assert.ok(!fs.existsSync(path.join(folder, '.git')));

  const a = run(['init', folder], tmp);
  assert.equal(a.status, 0, a.out);
  assert.equal(readConfig(a.home).roots.personal?.path, folder);
  assert.match(a.out, /Found 1 Markdown file\(s\)/);
  assert.equal(fs.readFileSync(path.join(folder, 'sub', 'rule.md'), 'utf8'), 'Use pnpm.\n');
});

test('init <other folder> refuses when personal memory is already elsewhere', () => {
  const tmp = makeTempDir();
  assert.equal(run(['init'], tmp).status, 0);
  const r = run(['init', path.join(tmp, 'elsewhere')], tmp);
  assert.equal(r.status, 1);
  assert.match(r.out, /config set-path personal/);
  assert.ok(!fs.existsSync(path.join(tmp, 'elsewhere')));
});

test('init does not create a personal folder when only a team root is configured', () => {
  const tmp = makeTempDir();
  const teamDir = path.join(tmp, 'team');
  fs.mkdirSync(teamDir);
  git(['init', '-b', 'main', teamDir]);
  git(['-C', teamDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
  const cfgDir = path.join(tmp, 'home', '.config', 'faber-memory');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({
      version: 1,
      roots: { team: { uuid: 'team-uuid', path: teamDir, scope: 'team', defaultBranch: 'main', submitMode: 'pr' } },
    }),
  );
  const r = run(['init'], tmp);
  assert.equal(r.status, 0, r.out);
  assert.equal(readConfig(r.home).roots.personal, undefined);
  assert.ok(!fs.existsSync(path.join(tmp, 'home', '.faber', 'memory')));
});
