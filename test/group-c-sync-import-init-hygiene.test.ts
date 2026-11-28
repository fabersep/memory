import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  BLOCK_END,
  BLOCK_START,
  createProposal,
  FaberMemoryMcpServer,
  getCompiledL0Path,
  gitInitSoloRepo,
  listAllProposals,
  loadConfig,
  PROJECT_HINT_LINE,
} from '../src/index.js';
import {
  commitMarkdownFile,
  createBareRemoteWithMain,
  git,
  makeTempDir,
  runCli,
} from './helpers.js';

test('AC-16a: MCP startup pull timeout serves local state and attaches one-line warning to next tool call', async () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });

  // Point remote to a script-backed hanging upload-pack via git config
  const slowUploadPack = path.join(tmp, 'slow-upload-pack.sh');
  fs.writeFileSync(slowUploadPack, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  git(['-C', teamDir, 'config', 'remote.origin.uploadpack', slowUploadPack]);

  const server = new FaberMemoryMcpServer({
    homeDir,
    cwd: tmp,
    startupPullTimeoutMs: 150,
  });
  server.startNonBlockingSync();
  await server.waitForStartupSyncForTest();

  const res = JSON.parse(server.handleToolCall('memory_search', { query: '' }).content[0].text);
  assert.ok(res.results.some((r: { id: string }) => r.id === 'team-rule'));
  assert.ok(res.metadata.warnings.some((w: string) => w.toLowerCase().includes('timed out')));
});

test('AC-16b1: MCP startup refuses pull --ff-only on dirty serving clone without resetting and warns on next tool call', async () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });

  const dirtyFile = path.join(teamDir, 'team-rule.md');
  fs.appendFileSync(dirtyFile, '\nMANUAL_LOCAL_EDIT\n');

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  server.startNonBlockingSync();
  await server.waitForStartupSyncForTest();

  assert.ok(fs.readFileSync(dirtyFile, 'utf8').includes('MANUAL_LOCAL_EDIT'));
  const res = JSON.parse(server.handleToolCall('memory_search', { query: '' }).content[0].text);
  assert.ok(res.metadata.warnings.some((w: string) => w.toLowerCase().includes('uncommitted')));
});

test('AC-16b2: CLI sync refuses pull --ff-only on dirty serving clone without resetting and exits non-zero', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });

  const dirtyFile = path.join(teamDir, 'team-rule.md');
  fs.appendFileSync(dirtyFile, '\nMANUAL_LOCAL_EDIT\n');

  const res = runCli(['sync'], { homeDir });
  assert.notEqual(res.status, 0);
  assert.ok(fs.readFileSync(dirtyFile, 'utf8').includes('MANUAL_LOCAL_EDIT'));
  assert.ok(res.stderr.toLowerCase().includes('uncommitted'));
});

test('AC-16c: Successful sync atomically replaces state-dir L0 without emitting MCP notifications or tool-list changes', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir, seedDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });
  assert.equal(runCli(['compile'], { homeDir }).status, 0);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const initResp = server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }) as {
    result: { capabilities: { tools: { listChanged: boolean } } };
  };
  assert.equal(initResp.result.capabilities.tools.listChanged, false);
  const toolsBefore = JSON.stringify(server.listTools());

  // Push new commit to remote
  commitMarkdownFile(
    seedDir,
    'synced-rule.md',
    `---\nsummary: Newly synced team rule\ntype: rule\n---\n\nSynced.\n`,
  );
  git(['-C', seedDir, 'push', 'origin', 'main']);

  const res = runCli(['sync'], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.readFileSync(getCompiledL0Path(homeDir), 'utf8').includes('synced-rule'));
  assert.equal(JSON.stringify(server.listTools()), toolsBefore);
});

test('AC-17: Deterministic import converts markdown-dir into pre-memory without altering source files', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  const legacyDir = path.join(tmp, 'legacy-notes');
  fs.mkdirSync(legacyDir, { recursive: true });
  const noteFile = path.join(legacyDir, 'always-review.md');
  const originalContent = `---\nname: Always review diffs\ndescription: Review every diff before merging\nmetadata:\n  scope: owner-wide\n---\n\nCheck tests and diffs carefully.\n`;
  fs.writeFileSync(noteFile, originalContent, 'utf8');

  const res = runCli(['import', '--from', 'markdown-dir', legacyDir], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  const props = listAllProposals(homeDir);
  assert.equal(props.length, 1);
  assert.equal(props[0].summary, 'Review every diff before merging');
  assert.equal(fs.readFileSync(noteFile, 'utf8'), originalContent);
});

test('AC-18a: Importing claude-memory reports duplicates and prints auto-memory disable guidance', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(
    personalDir,
    'existing-rule.md',
    `---\nsummary: Always run unit tests before creating a pull request\ntype: rule\n---\n\nRun unit tests before creating a pull request.\n`,
  );

  const claudeDir = path.join(tmp, 'claude-mem');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'dup.md'),
    `---\ndescription: Always run unit tests before creating a pull request\n---\n\nRun unit tests before creating a pull request.\n`,
  );
  fs.writeFileSync(
    path.join(claudeDir, 'unique.md'),
    `---\ndescription: Prefer concise commit messages\n---\n\nKeep commit subjects under 72 characters.\n`,
  );

  const res = runCli(['import', '--from', 'claude-memory', claudeDir], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('Duplicates skipped (1)'));
  assert.ok(res.stdout.includes('autoMemoryEnabled'));
  assert.equal(listAllProposals(homeDir).length, 1);
});

test('AC-18b: Importing agents-md creates whole-file proposal by default and splits with --split-headings', () => {
  const tmp = makeTempDir();
  const homeDir1 = path.join(tmp, 'home1');
  const homeDir2 = path.join(tmp, 'home2');
  runCli(['setup', path.join(tmp, 'p1')], { homeDir: homeDir1 });
  runCli(['setup', path.join(tmp, 'p2')], { homeDir: homeDir2 });

  const agentsFile = path.join(tmp, 'AGENTS.md');
  const content = `# Architecture\n\nKeep modules decoupled.\n\n## Testing\n\nRun node --test.\n\n## Deployment\n\nDeploy via CI.\n`;
  fs.writeFileSync(agentsFile, content, 'utf8');

  const whole = runCli(['import', '--from', 'agents-md', agentsFile], { homeDir: homeDir1 });
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(listAllProposals(homeDir1).length, 1);

  const split = runCli(['import', '--from', 'agents-md', agentsFile, '--split-headings'], {
    homeDir: homeDir2,
  });
  assert.equal(split.status, 0, split.stderr);
  assert.equal(listAllProposals(homeDir2).length, 3);
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), content);
});

test('AC-19a: init --preview shows the diff without modifying any file', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const claudeMd = path.join(userHome, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# Existing rules\n', 'utf8');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });

  const res = runCli(['init', '--preview', '--engine', 'claude-code'], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('Preview only'));
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# Existing rules\n');
  assert.ok(!fs.existsSync(path.join(userHome, '.claude.json')));
});

test('AC-19b1: init --apply compiles MEMORY.md before writing user-level pointer and creates .bak backup', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const claudeMd = path.join(userHome, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# Existing rules\n', 'utf8');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });

  assert.ok(!fs.existsSync(getCompiledL0Path(homeDir)));
  const res = runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(getCompiledL0Path(homeDir)));
  assert.ok(fs.existsSync(`${claudeMd}.bak`));
  assert.equal(fs.readFileSync(`${claudeMd}.bak`, 'utf8'), '# Existing rules\n');
  assert.ok(fs.readFileSync(claudeMd, 'utf8').includes(getCompiledL0Path(homeDir)));
});

test('AC-19b2: Running init --apply twice is idempotent and keeps exactly one managed block', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const claudeMd = path.join(userHome, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# Existing\n', 'utf8');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });

  assert.equal(runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome }).status, 0);
  const afterFirst = fs.readFileSync(claudeMd, 'utf8');
  assert.equal(runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome }).status, 0);
  const afterSecond = fs.readFileSync(claudeMd, 'utf8');
  assert.equal(afterFirst, afterSecond);
  assert.equal(afterSecond.split(BLOCK_START).length - 1, 1);
  assert.equal(afterSecond.split(BLOCK_END).length - 1, 1);
});

test('AC-19b3: init --apply writes only to user-level files and never modifies committed project files', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  commitMarkdownFile(projDir, 'AGENTS.md', '# Project Agents\n');
  commitMarkdownFile(projDir, 'CLAUDE.md', '# Project Claude\n');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });

  const res = runCli(['init', '--apply', '--engine', 'claude-code'], {
    homeDir,
    userHome,
    cwd: projDir,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(['-C', projDir, 'status', '--porcelain']), '');
});

test('AC-19c: init --undo removes managed blocks and MCP entries while preserving user edits outside blocks and .bak', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  const claudeMd = path.join(userHome, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# Original\n', 'utf8');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });

  assert.equal(runCli(['init', '--apply', '--engine', 'claude-code'], { homeDir, userHome }).status, 0);
  fs.appendFileSync(claudeMd, '\n# My custom rule added later\n');

  const undo = runCli(['init', '--undo', '--engine', 'claude-code'], { homeDir, userHome });
  assert.equal(undo.status, 0, undo.stderr);
  const finalContent = fs.readFileSync(claudeMd, 'utf8');
  assert.ok(!finalContent.includes(BLOCK_START));
  assert.ok(finalContent.includes('# My custom rule added later'));
  assert.ok(undo.stdout.includes(`${claudeMd}.bak`));

  const mcpCfg = JSON.parse(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8'));
  assert.equal(mcpCfg.mcpServers['faber-memory'], undefined);
});

test('AC-19d: GAP engine receives MCP-only wiring and optional project hint stays pathless', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'user');
  runCli(['setup', path.join(tmp, 'personal')], { homeDir, userHome });

  const res = runCli(['init', '--apply', '--engine', 'cursor', '--project-hint'], {
    homeDir,
    userHome,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('GAP'));
  assert.ok(res.stdout.includes(PROJECT_HINT_LINE));
  assert.ok(fs.existsSync(path.join(userHome, '.cursor', 'mcp.json')));
});

test('AC-20a: Hygiene scan blocks secrets and machine paths on memory_propose with redacted diagnostics', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const rawToken = 'Bearer super_secret_token_value_9999999';
  const resSecret = server.handleToolCall('memory_propose', {
    action: 'create',
    scope: 'personal',
    summary: 'Auth note',
    type: 'reference',
    body: `Use header: ${rawToken}`,
  });
  assert.equal(resSecret.isError, true);
  assert.ok(resSecret.content[0].text.includes('secret'));
  assert.ok(!resSecret.content[0].text.includes('super_secret_token_value_9999999'));

  const resPath = server.handleToolCall('memory_propose', {
    action: 'create',
    scope: 'personal',
    summary: 'Path note',
    type: 'reference',
    body: 'See /Users/alice/private-repo for details.',
  });
  assert.equal(resPath.isError, true);
  assert.ok(resPath.content[0].text.includes('machine-path'));
  assert.equal(listAllProposals(homeDir).length, 0);
});

test('AC-20b1: Hygiene scan blocks secrets and machine paths on approve with redacted diagnostics', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  const headBefore = git(['-C', personalDir, 'rev-parse', 'HEAD']);

  const cfg = loadConfig(homeDir);
  const rawKey = 'sk-proj-secretkeyvalue1234567890abcdef';
  const prop = createProposal(
    cfg,
    {
      scope: 'personal',
      action: 'create',
      summary: 'Leaked key',
      type: 'reference',
      body: `API key is ${rawKey} and path is /home/bob/work`,
    },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('secret'));
  assert.ok(!res.stderr.includes(rawKey));
  assert.equal(git(['-C', personalDir, 'rev-parse', 'HEAD']), headBefore);
});

test('AC-20b2: Hygiene scan blocks secrets and machine paths on compile --check with redacted diagnostics', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const repoDir = path.join(tmp, 'ci-hygiene');
  gitInitSoloRepo(repoDir);
  const rawKey = 'ghp_1234567890abcdefghijklmnopqrstuvwx';
  commitMarkdownFile(
    repoDir,
    'leaked.md',
    `---\nsummary: Leaked token entry\ntype: reference\n---\n\nToken: ${rawKey}\nPath: /home/bob/work\n`,
  );

  const res = runCli(['compile', '--check', '--repo', repoDir], { homeDir, cwd: repoDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('secret'));
  assert.ok(res.stderr.includes('machine-path'));
  assert.ok(!res.stderr.includes(rawKey));
  assert.equal(git(['-C', repoDir, 'status', '--porcelain']), '');
});
