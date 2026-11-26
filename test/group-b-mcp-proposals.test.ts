import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  createProposal,
  FaberMemoryMcpServer,
  getCompiledL0Path,
  getStateDir,
  gitInitSoloRepo,
  listAllProposals,
  loadConfig,
  saveProposal,
} from '../src/index.js';
import {
  commitMarkdownFile,
  createBareRemoteWithMain,
  git,
  makeTempDir,
  runCli,
} from './helpers.js';

test('AC-08: MCP server exposes exactly 3 tools and serves progressive disclosure (search -> get)', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(
    personalDir,
    'use-strict-ts.md',
    `---\nsummary: Always enable strict TypeScript\ntype: rule\n---\n\nDetailed L2 body with link https://example.com/ts-strict.\n`,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const tools = server.listTools();
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['memory_search', 'memory_get', 'memory_propose'],
  );

  const searchRes = JSON.parse(
    server.handleToolCall('memory_search', { query: '' }).content[0].text,
  );
  assert.equal(searchRes.results.length, 1);
  assert.equal(searchRes.results[0].id, 'use-strict-ts');
  assert.equal(searchRes.results[0].body, undefined);

  const getRes = JSON.parse(
    server.handleToolCall('memory_get', { ids: ['use-strict-ts'] }).content[0].text,
  );
  assert.equal(getRes.entries.length, 1);
  assert.ok(getRes.entries[0].body.includes('Detailed L2 body'));
  assert.ok(getRes.entries[0].links.includes('https://example.com/ts-strict'));
});

test('AC-08b: memory_search with include_pending: true surfaces pending proposals alongside active entries', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(personalDir, 'active-one.md', `---\nsummary: Active entry\ntype: rule\n---\n\nActive.\n`);

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'personal', action: 'create', summary: 'Pending entry', type: 'lesson', body: 'Pending body.' },
    homeDir,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const withoutPending = JSON.parse(
    server.handleToolCall('memory_search', { query: '' }).content[0].text,
  );
  assert.ok(!withoutPending.results.some((r: { id: string }) => r.id === prop.id));

  const withPending = JSON.parse(
    server.handleToolCall('memory_search', { query: '', include_pending: true }).content[0].text,
  );
  const hit = withPending.results.find((r: { id: string }) => r.id === prop.id);
  assert.ok(hit);
  assert.equal(hit.pending, true);
});

test('AC-08c1: memory_propose for update rejects missing target_id', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = server.handleToolCall('memory_propose', {
    action: 'update',
    scope: 'personal',
    summary: 'Updated rule',
    type: 'rule',
    body: 'New body.',
  });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('target_id'));
  assert.equal(listAllProposals(homeDir).length, 0);
});

test('AC-08c2: memory_propose for supersede rejects unknown target_id', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = server.handleToolCall('memory_propose', {
    action: 'supersede',
    scope: 'personal',
    target_id: 'nonexistent-rule',
    summary: 'Replacement rule',
    type: 'rule',
    body: 'Replaces nothing.',
  });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('not found'));
  assert.equal(listAllProposals(homeDir).length, 0);
});

test('AC-09: Search reflects newly committed entries on HEAD change with no on-disk index file created', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const before = JSON.parse(
    server.handleToolCall('memory_search', { query: 'new-convention' }).content[0].text,
  );
  assert.equal(before.results.length, 0);

  commitMarkdownFile(
    personalDir,
    'new-convention.md',
    `---\nsummary: New naming convention\ntype: rule\n---\n\nUse kebab-case.\n`,
  );

  const after = JSON.parse(
    server.handleToolCall('memory_search', { query: 'new-convention' }).content[0].text,
  );
  assert.ok(after.results.some((r: { id: string }) => r.id === 'new-convention'));
  assert.equal(git(['-C', personalDir, 'status', '--porcelain']), '');
  const stateFiles = fs.existsSync(getStateDir(homeDir)) ? fs.readdirSync(getStateDir(homeDir)) : [];
  assert.ok(!stateFiles.some((f) => f.includes('index') || f.endsWith('.db') || f.endsWith('.sqlite')));
});

test('AC-10: memory_propose rejects near-duplicate on create and lists matching entry IDs and summaries', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(
    personalDir,
    'deploy-steps.md',
    `---\nsummary: Run staging smoke tests and verify rollback before production deployment\ntype: rule\n---\n\nAlways run staging smoke tests and check database migrations before production deployment.\n`,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = server.handleToolCall('memory_propose', {
    action: 'create',
    scope: 'personal',
    summary: 'Run staging smoke tests before production deployment',
    type: 'rule',
    body: 'Always run staging smoke tests and check database migrations before production deployment.',
  });
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.ok(body.matches.some((m: { id: string }) => m.id === 'deploy-steps'));
  assert.equal(listAllProposals(homeDir).length, 0);
});

test('AC-11: memory_propose allows force_new: true with mandatory reason to bypass false positive', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(
    personalDir,
    'deploy-steps.md',
    `---\nsummary: Run staging smoke tests before production deployment\ntype: rule\n---\n\nAlways run staging smoke tests before production deployment.\n`,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = server.handleToolCall('memory_propose', {
    action: 'create',
    scope: 'personal',
    entry_id: 'deploy-rollback-window',
    summary: 'Run staging smoke tests before production deployment rollback window',
    type: 'rule',
    body: 'Always run staging smoke tests before production deployment and keep a 30m rollback window.',
    force_new: true,
    reason: 'Separate policy for rollback timing',
  });
  assert.ok(!res.isError, res.content[0].text);

  const rev = runCli(['review'], { homeDir, input: 's\n' });
  assert.equal(rev.status, 0);
  assert.ok(rev.stdout.includes('Separate policy for rollback timing'));
});

test('AC-12a: Agent proposal writes only to external local state pre-memory with collision-free ID', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = server.handleToolCall('memory_propose', {
    action: 'create',
    scope: 'personal',
    summary: 'Brand new lesson',
    type: 'lesson',
    body: 'Keep state outside the git clone.',
  });
  assert.ok(!res.isError);
  const data = JSON.parse(res.content[0].text);
  assert.match(data.proposal_id, /^p-[a-z0-9]+-[0-9a-f]{4}$/);
  assert.equal(git(['-C', personalDir, 'status', '--porcelain']), '');
});

test('AC-12b: Solo approve commits to personal Git repo, removes proposal, and recompiles L0', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'personal', action: 'create', entryId: 'solo-approved', summary: 'Solo approved rule', type: 'rule', body: 'Committed.' },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(listAllProposals(homeDir).length, 0);
  assert.ok(fs.existsSync(path.join(personalDir, 'solo-approved.md')));
  assert.equal(git(['-C', personalDir, 'status', '--porcelain']), '');
  assert.ok(fs.readFileSync(getCompiledL0Path(homeDir), 'utf8').includes('solo-approved'));
});

test('AC-12c1: reject discards pending proposal with no Git commit', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  const headBefore = git(['-C', personalDir, 'rev-parse', 'HEAD']);
  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'personal', action: 'create', summary: 'Reject me', type: 'lesson', body: 'Nope.' },
    homeDir,
  );

  const res = runCli(['reject', prop.id], { homeDir });
  assert.equal(res.status, 0);
  assert.equal(listAllProposals(homeDir).length, 0);
  assert.equal(git(['-C', personalDir, 'rev-parse', 'HEAD']), headBefore);
});

test('AC-12c2: review edit updates proposal content before approval commit', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  const cfg = loadConfig(homeDir);
  createProposal(
    cfg,
    { scope: 'personal', action: 'create', entryId: 'edited-rule', summary: 'Editable rule', type: 'rule', body: 'Original body.' },
    homeDir,
  );

  const res = runCli(['review'], { homeDir, input: 'e\nEdited body by human.\ny\n' });
  assert.equal(res.status, 0, res.stderr);
  const committed = fs.readFileSync(path.join(personalDir, 'edited-rule.md'), 'utf8');
  assert.ok(committed.includes('Edited body by human.'));
});

test('AC-12d: Project-scope approve writes uncommitted file into .faber/memory/ and prints git add guidance', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  fs.mkdirSync(path.join(projDir, '.faber', 'memory'), { recursive: true });
  const headBefore = git(['-C', projDir, 'rev-parse', 'HEAD']);

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    {
      scope: 'project',
      action: 'create',
      entryId: 'proj-rule',
      summary: 'Project rule',
      type: 'rule',
      body: 'Project body.',
      projectRootPath: projDir,
    },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir, cwd: projDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(projDir, '.faber', 'memory', 'proj-rule.md')));
  assert.equal(git(['-C', projDir, 'rev-parse', 'HEAD']), headBefore);
  assert.ok(res.stdout.includes('git add'));
});

test('AC-12e1: Uncommitted approved project entry is excluded from active memory_search', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  fs.mkdirSync(path.join(projDir, '.faber', 'memory'), { recursive: true });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'project', action: 'create', entryId: 'uncommitted-proj', summary: 'Not committed yet', type: 'rule', body: 'Wait.', projectRootPath: projDir },
    homeDir,
  );
  assert.equal(runCli(['approve', prop.id], { homeDir, cwd: projDir }).status, 0);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: projDir });
  const search = JSON.parse(
    server.handleToolCall('memory_search', { query: 'uncommitted-proj' }).content[0].text,
  );
  assert.equal(search.results.length, 0);
});

test('AC-12e2: status lists uncommitted approved project entry as awaiting_commit with file name and commit guidance', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  fs.mkdirSync(path.join(projDir, '.faber', 'memory'), { recursive: true });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'project', action: 'create', entryId: 'await-proj', summary: 'Awaiting commit', type: 'rule', body: 'Wait.', projectRootPath: projDir },
    homeDir,
  );
  assert.equal(runCli(['approve', prop.id], { homeDir, cwd: projDir }).status, 0);

  const st = runCli(['status'], { homeDir, cwd: projDir });
  assert.equal(st.status, 0);
  assert.ok(st.stdout.includes('awaiting_commit'));
  assert.ok(st.stdout.includes('await-proj.md'));
  assert.ok(st.stdout.includes('git add'));
});

test('AC-12e3: Committing an awaiting_commit project file activates it in search and clears pre-memory', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  fs.mkdirSync(path.join(projDir, '.faber', 'memory'), { recursive: true });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'project', action: 'create', entryId: 'activated-proj', summary: 'Activated after commit', type: 'rule', body: 'Now active.', projectRootPath: projDir },
    homeDir,
  );
  assert.equal(runCli(['approve', prop.id], { homeDir, cwd: projDir }).status, 0);

  git(['-C', projDir, 'add', '.faber/memory/activated-proj.md']);
  git(['-C', projDir, 'commit', '-m', 'commit project memory']);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: projDir });
  const search = JSON.parse(
    server.handleToolCall('memory_search', { query: 'activated-proj' }).content[0].text,
  );
  assert.ok(search.results.some((r: { id: string }) => r.id === 'activated-proj'));
  assert.equal(listAllProposals(homeDir).length, 0);
});

test('AC-12f: Batching multiple approvals in one review session creates one commit, one L0 recompile, and prints cache guidance', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  const countBefore = Number(git(['-C', personalDir, 'rev-list', '--count', 'HEAD']));

  const cfg = loadConfig(homeDir);
  createProposal(cfg, { scope: 'personal', action: 'create', entryId: 'batch-1', summary: 'Batch 1', type: 'rule', body: 'B1' }, homeDir);
  createProposal(cfg, { scope: 'personal', action: 'create', entryId: 'batch-2', summary: 'Batch 2', type: 'rule', body: 'B2' }, homeDir);
  createProposal(cfg, { scope: 'personal', action: 'create', entryId: 'batch-3', summary: 'Batch 3', type: 'rule', body: 'B3' }, homeDir);

  const res = runCli(['review'], { homeDir, input: 'a\na\na\n' });
  assert.equal(res.status, 0, res.stderr);
  const countAfter = Number(git(['-C', personalDir, 'rev-list', '--count', 'HEAD']));
  assert.equal(countAfter, countBefore + 1);
  assert.equal(listAllProposals(homeDir).length, 0);
  assert.ok(res.stdout.includes('new sessions'));
  assert.ok(res.stdout.includes('prompt-cache'));
});

test('AC-13a: Team approve in pr mode pushes memory/proposal-<id> via throwaway worktree and prints compare URL', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir, '--submit-mode', 'pr'], { homeDir });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'team', action: 'create', entryId: 'pr-rule', summary: 'Team PR rule', type: 'rule', body: 'Via PR.' },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`memory/proposal-${prop.id}`));
  assert.ok(res.stdout.includes('Create PR:'));
  const remoteHeads = git(['--git-dir', bareDir, 'branch']);
  assert.ok(remoteHeads.includes(`memory/proposal-${prop.id}`));
  assert.equal(listAllProposals(homeDir).length, 0);
});

test('AC-13b: Team approve deletes throwaway worktree and leaves serving clone clean on main', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir, '--submit-mode', 'pr'], { homeDir });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'team', action: 'create', entryId: 'clean-wt', summary: 'Clean worktree test', type: 'rule', body: 'Clean.' },
    homeDir,
  );

  assert.equal(runCli(['approve', prop.id], { homeDir }).status, 0);
  const worktrees = git(['-C', teamDir, 'worktree', 'list', '--porcelain']);
  assert.equal(worktrees.split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  assert.equal(git(['-C', teamDir, 'rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(git(['-C', teamDir, 'status', '--porcelain']), '');
});

test('AC-13c: Team approve in auto mode pushes directly to main when unprotected and syncs local L0', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp, false);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir, '--submit-mode', 'auto'], { homeDir });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'team', action: 'create', entryId: 'direct-push-rule', summary: 'Direct push rule', type: 'rule', body: 'Direct.' },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(listAllProposals(homeDir).length, 0);
  assert.ok(fs.readFileSync(getCompiledL0Path(homeDir), 'utf8').includes('direct-push-rule'));
});

test('AC-13d: Team approve in auto mode falls back to PR branch + compare URL when branch protection rejects direct push', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp, true);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir, '--submit-mode', 'auto'], { homeDir });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'team', action: 'create', entryId: 'protected-fallback', summary: 'Protected branch fallback', type: 'rule', body: 'Fallback.' },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`memory/proposal-${prop.id}`));
  assert.ok(res.stdout.includes('Create PR:'));
  assert.equal(listAllProposals(homeDir).length, 0);
  assert.equal(git(['-C', teamDir, 'rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(git(['-C', teamDir, 'status', '--porcelain']), '');
});

test('AC-14a: Team approve push failure marks proposal push_failed and exits non-zero', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir, '--submit-mode', 'pr'], { homeDir });

  // Break remote so push fails
  fs.rmSync(bareDir, { recursive: true, force: true });

  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'team', action: 'create', entryId: 'fail-push', summary: 'Fail push', type: 'rule', body: 'Offline.' },
    homeDir,
  );

  const res = runCli(['approve', prop.id], { homeDir });
  assert.notEqual(res.status, 0);
  const remaining = listAllProposals(homeDir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].status, 'push_failed');
});

test('AC-14b: Team approve push failure cleans up throwaway worktree and leaves serving clone untouched', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir, '--submit-mode', 'pr'], { homeDir });

  fs.rmSync(bareDir, { recursive: true, force: true });
  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'team', action: 'create', entryId: 'fail-clean', summary: 'Fail clean', type: 'rule', body: 'Offline.' },
    homeDir,
  );

  runCli(['approve', prop.id], { homeDir });
  const worktrees = git(['-C', teamDir, 'worktree', 'list', '--porcelain']);
  assert.equal(worktrees.split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  assert.equal(git(['-C', teamDir, 'rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(git(['-C', teamDir, 'status', '--porcelain']), '');
});

test('AC-15: status CLI reports pending count and flags stale proposals without altering compiled L0', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(personalDir, 'r1.md', `---\nsummary: Rule 1\ntype: rule\n---\n\nBody.\n`);
  assert.equal(runCli(['compile'], { homeDir }).status, 0);
  const l0Before = fs.readFileSync(getCompiledL0Path(homeDir), 'utf8');

  const cfg = loadConfig(homeDir);
  const fresh = createProposal(cfg, { scope: 'personal', action: 'create', summary: 'Fresh', type: 'lesson', body: 'New.' }, homeDir);
  const stale = createProposal(cfg, { scope: 'personal', action: 'create', summary: 'Stale', type: 'lesson', body: 'Old.' }, homeDir);
  stale.createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  saveProposal(stale, homeDir);

  const st = runCli(['status'], { homeDir });
  assert.equal(st.status, 0);
  assert.ok(st.stdout.includes('Pending proposals: 2'));
  assert.ok(st.stdout.includes('STALE'));
  assert.ok(st.stdout.includes(stale.id));
  assert.ok(st.stdout.includes(fresh.id));
  assert.equal(fs.readFileSync(getCompiledL0Path(homeDir), 'utf8'), l0Before);
});
