import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  compileGlobalL0,
  createProposal,
  FaberMemoryMcpServer,
  getCompiledL0Path,
  gitInitSoloRepo,
  loadConfig,
  saveConfig,
} from '../src/index.js';
import {
  commitMarkdownFile,
  createBareRemoteWithMain,
  git,
  makeTempDir,
  runCli,
} from './helpers.js';

test('AC-01: Solo initialization creates folder with automatic Git repository at custom path', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const customPath = path.join(tmp, 'my-faber-mem');

  const res = runCli(['setup', customPath], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(customPath, '.git')));
  const cfg = loadConfig(homeDir);
  assert.equal(cfg.roots.personal?.path, customPath);
  assert.ok(cfg.roots.personal?.uuid);
  assert.equal(git(['-C', customPath, 'status', '--porcelain']), '');
});

test('AC-02: Relocating a configured memory root preserves history and UUID-keyed state', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const oldPath = path.join(tmp, 'mem-old');
  const newPath = path.join(tmp, 'mem-new');

  assert.equal(runCli(['setup', oldPath], { homeDir }).status, 0);
  commitMarkdownFile(
    oldPath,
    'keep-history.md',
    `---\nsummary: Preserve history across relocation\ntype: rule\n---\n\nRelocation must keep UUID state.\n`,
  );
  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    {
      scope: 'personal',
      action: 'create',
      summary: 'Pending before move',
      type: 'lesson',
      body: 'This proposal must survive relocation.',
    },
    homeDir,
  );

  fs.renameSync(oldPath, newPath);
  const upd = runCli(['config', 'set-path', 'personal', newPath], { homeDir });
  assert.equal(upd.status, 0, upd.stderr);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const search = JSON.parse(
    server.handleToolCall('memory_search', { query: 'relocation' }).content[0].text,
  );
  assert.ok(search.results.some((r: { id: string }) => r.id === 'keep-history'));

  const st = runCli(['status'], { homeDir });
  assert.equal(st.status, 0);
  assert.ok(st.stdout.includes(newPath));
  assert.ok(st.stdout.includes(prop.id));
});

test('AC-02b: Team onboarding clones shared private repo as read-only serving clone on default branch', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir } = createBareRemoteWithMain(tmp);
  const teamClone = path.join(tmp, 'team-clone');

  const res = runCli(['setup', '--team', bareDir, '--path', teamClone], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(teamClone, '.git')));
  assert.equal(git(['-C', teamClone, 'rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  const cfg = loadConfig(homeDir);
  assert.equal(cfg.roots.team?.path, teamClone);
  assert.ok(cfg.roots.team?.uuid);
});

test('AC-02c: Project root resolves via cwd Git repo and reports project_root_source', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const projDir = path.join(tmp, 'my-proj');
  gitInitSoloRepo(projDir);
  commitMarkdownFile(
    projDir,
    '.faber/memory/proj-conv.md',
    `---\nsummary: Project specific convention\ntype: rule\n---\n\nAlways tag releases.\n`,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: projDir });
  const res = JSON.parse(server.handleToolCall('memory_search', { query: '' }).content[0].text);
  assert.equal(res.metadata.project_root_source, 'cwd');
  assert.ok(res.results.some((r: { id: string; scope: string }) => r.id === 'proj-conv' && r.scope === 'project'));

  // Also check mcp-roots precedence
  const serverWithRoots = new FaberMemoryMcpServer({
    homeDir,
    cwd: tmp,
    mcpRoots: [`file://${projDir}`],
  });
  const resRoots = JSON.parse(
    serverWithRoots.handleToolCall('memory_search', { query: '' }).content[0].text,
  );
  assert.equal(resRoots.metadata.project_root_source, 'mcp-roots');
});

test('AC-03: Entry ID and scope are derived from filename and root, excluding superseded entries', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  assert.equal(runCli(['setup', personalDir], { homeDir }).status, 0);

  commitMarkdownFile(
    personalDir,
    'prefer-small-prs.md',
    `---\nsummary: Keep pull requests under 300 lines\ntype: preference\nstatus: active\n---\n\nSmaller PRs review faster.\n`,
  );
  commitMarkdownFile(
    personalDir,
    'old-lint-rule.md',
    `---\nsummary: Legacy lint rule\ntype: rule\nstatus: superseded\nsuperseded_by: prefer-small-prs\n---\n\nReplaced.\n`,
  );

  assert.equal(runCli(['compile'], { homeDir }).status, 0);
  const compiled = fs.readFileSync(getCompiledL0Path(homeDir), 'utf8');
  assert.ok(compiled.includes('prefer-small-prs'));
  assert.ok(!compiled.includes('old-lint-rule'));

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = JSON.parse(server.handleToolCall('memory_search', { query: '' }).content[0].text);
  assert.ok(
    res.results.some((r: { id: string; scope: string }) => r.id === 'prefer-small-prs' && r.scope === 'personal'),
  );
  assert.ok(!res.results.some((r: { id: string }) => r.id === 'old-lint-rule'));
});

test('AC-03b: l0: body emits full entry body and l0: none omits entry from L0 while keeping it searchable', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  assert.equal(runCli(['setup', personalDir], { homeDir }).status, 0);

  commitMarkdownFile(
    personalDir,
    'core-rule.md',
    `---\nsummary: Core invariant\ntype: rule\nl0: body\n---\n\nFULL_BODY_MARKER_12345\n`,
  );
  commitMarkdownFile(
    personalDir,
    'deep-note.md',
    `---\nsummary: Deep reference note\ntype: reference\nl0: none\n---\n\nSearchable only via MCP.\n`,
  );

  assert.equal(runCli(['compile'], { homeDir }).status, 0);
  const compiled = fs.readFileSync(getCompiledL0Path(homeDir), 'utf8');
  assert.ok(compiled.includes('FULL_BODY_MARKER_12345'));
  assert.ok(!compiled.includes('deep-note'));

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = JSON.parse(server.handleToolCall('memory_search', { query: 'deep-note' }).content[0].text);
  assert.ok(res.results.some((r: { id: string }) => r.id === 'deep-note'));
});

test('AC-04a: Global L0 compiles deterministically (team then personal, sorted by ID) across machines', () => {
  const tmp = makeTempDir();
  const { bareDir, seedDir } = createBareRemoteWithMain(tmp);
  commitMarkdownFile(
    seedDir,
    'z-rule.md',
    `---\nsummary: Z team rule\ntype: rule\n---\n\nZ body\n`,
  );
  commitMarkdownFile(
    seedDir,
    'a-rule.md',
    `---\nsummary: A team rule\ntype: rule\n---\n\nA body\n`,
  );
  git(['-C', seedDir, 'push', 'origin', 'main']);

  // Machine 1
  const home1 = path.join(tmp, 'm1-home');
  const p1 = path.join(tmp, 'm1-personal');
  const t1 = path.join(tmp, 'm1-team');
  runCli(['setup', p1], { homeDir: home1 });
  runCli(['setup', '--team', bareDir, '--path', t1], { homeDir: home1 });
  commitMarkdownFile(p1, 'b-rule.md', `---\nsummary: B personal rule\ntype: rule\n---\n\nB body\n`);
  assert.equal(runCli(['compile'], { homeDir: home1 }).status, 0);

  // Machine 2
  const home2 = path.join(tmp, 'm2-home');
  const p2 = path.join(tmp, 'm2-personal');
  const t2 = path.join(tmp, 'm2-team');
  runCli(['setup', p2], { homeDir: home2 });
  runCli(['setup', '--team', bareDir, '--path', t2], { homeDir: home2 });
  commitMarkdownFile(p2, 'b-rule.md', `---\nsummary: B personal rule\ntype: rule\n---\n\nB body\n`);
  assert.equal(runCli(['compile'], { homeDir: home2 }).status, 0);

  const l0_1 = fs.readFileSync(getCompiledL0Path(home1), 'utf8');
  const l0_2 = fs.readFileSync(getCompiledL0Path(home2), 'utf8');
  assert.equal(l0_1, l0_2);
  assert.ok(l0_1.indexOf('a-rule') < l0_1.indexOf('z-rule'));
  assert.ok(l0_1.indexOf('z-rule') < l0_1.indexOf('b-rule'));
});

test('AC-04b: Global L0 excludes project entries, dates, pending counts, and machine paths without dirtying repos', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  const projDir = path.join(tmp, 'proj');
  runCli(['setup', personalDir], { homeDir });
  gitInitSoloRepo(projDir);

  commitMarkdownFile(
    personalDir,
    'verified-rule.md',
    `---\nsummary: Verified personal rule\ntype: rule\nlast_verified: 2026-11-26\n---\n\nBody.\n`,
  );
  commitMarkdownFile(
    projDir,
    '.faber/memory/p-rule.md',
    `---\nsummary: Project only rule\ntype: rule\nl0: line\n---\n\nProject body.\n`,
  );
  const cfg = loadConfig(homeDir);
  createProposal(cfg, { scope: 'personal', action: 'create', summary: 'Pending 1', type: 'lesson', body: 'B1' }, homeDir);
  createProposal(cfg, { scope: 'personal', action: 'create', summary: 'Pending 2', type: 'lesson', body: 'B2' }, homeDir);

  assert.equal(runCli(['compile'], { homeDir, cwd: projDir }).status, 0);
  const compiled = fs.readFileSync(getCompiledL0Path(homeDir), 'utf8');
  assert.ok(!compiled.includes('p-rule'));
  assert.ok(!compiled.includes('2026-11-26'));
  assert.ok(!compiled.includes('Pending 1'));
  assert.ok(!compiled.includes('/Users/'));
  assert.ok(!compiled.includes('/home/'));
  assert.equal(git(['-C', personalDir, 'status', '--porcelain']), '');
  assert.equal(git(['-C', projDir, 'status', '--porcelain']), '');
});

test('AC-04c: Compilation and search read committed HEAD only and warn on uncommitted edits', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  commitMarkdownFile(
    personalDir,
    'prefer-small-prs.md',
    `---\nsummary: Committed summary version\ntype: preference\n---\n\nCommitted body.\n`,
  );
  // Modify on disk without committing
  fs.writeFileSync(
    path.join(personalDir, 'prefer-small-prs.md'),
    `---\nsummary: Uncommitted edited summary\ntype: preference\n---\n\nDirty body.\n`,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  const res = JSON.parse(
    server.handleToolCall('memory_search', { query: 'prefer-small-prs' }).content[0].text,
  );
  assert.equal(res.results[0].summary, 'Committed summary version');
  assert.ok(res.metadata.warnings.some((w: string) => w.toLowerCase().includes('uncommitted')));
});

test('AC-04d: Concurrent approve and MCP startup compile produce a complete, uncorrupted MEMORY.md', async () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });
  commitMarkdownFile(
    personalDir,
    'base-rule.md',
    `---\nsummary: Base rule\ntype: rule\n---\n\nBase body.\n`,
  );
  const cfg = loadConfig(homeDir);
  const prop = createProposal(
    cfg,
    { scope: 'personal', action: 'create', summary: 'Concurrent rule', type: 'rule', body: 'Concurrent body.' },
    homeDir,
  );

  const server = new FaberMemoryMcpServer({ homeDir, cwd: tmp });
  await Promise.all([
    Promise.resolve().then(() => server.startNonBlockingSync()),
    Promise.resolve().then(() => runCli(['approve', prop.id], { homeDir })),
    Promise.resolve().then(() => compileGlobalL0(cfg, { homeDir })),
  ]);
  await server.waitForStartupSyncForTest();

  const content = fs.readFileSync(getCompiledL0Path(homeDir), 'utf8');
  assert.ok(content.includes('# Memory (L0)'));
  assert.ok(content.includes('base-rule'));
  assert.ok(content.includes('concurrent-rule'));
});

test('AC-05a: Duplicate entry ID across team and personal fails global L0 compilation', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir, seedDir } = createBareRemoteWithMain(tmp);
  commitMarkdownFile(
    seedDir,
    'deploy-check.md',
    `---\nsummary: Team deploy check\ntype: rule\n---\n\nTeam version.\n`,
  );
  git(['-C', seedDir, 'push', 'origin', 'main']);

  const personalDir = path.join(tmp, 'personal');
  const teamDir = path.join(tmp, 'team');
  runCli(['setup', personalDir], { homeDir });
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });
  // Compile once while valid
  assert.equal(runCli(['compile'], { homeDir }).status, 0);
  const prevL0 = fs.readFileSync(getCompiledL0Path(homeDir), 'utf8');

  // Introduce collision
  commitMarkdownFile(
    personalDir,
    'deploy-check.md',
    `---\nsummary: Personal deploy check\ntype: rule\n---\n\nPersonal version.\n`,
  );
  const res = runCli(['compile'], { homeDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('deploy-check'));
  assert.ok(res.stderr.includes('team'));
  assert.ok(res.stderr.includes('personal'));
  assert.equal(fs.readFileSync(getCompiledL0Path(homeDir), 'utf8'), prevL0);
});

test('AC-05b1: Project ID colliding with team leaves global L0 compilation succeeding (exit 0)', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir, seedDir } = createBareRemoteWithMain(tmp);
  commitMarkdownFile(seedDir, 'deploy-check.md', `---\nsummary: Team deploy check\ntype: rule\n---\n\nTeam.\n`);
  git(['-C', seedDir, 'push', 'origin', 'main']);

  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });

  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  commitMarkdownFile(projDir, '.faber/memory/deploy-check.md', `---\nsummary: Proj deploy check\ntype: rule\n---\n\nProj.\n`);

  const res = runCli(['compile'], { homeDir, cwd: projDir });
  assert.equal(res.status, 0, res.stderr);
});

test('AC-05b2: Project ID colliding with team fails project compile --check naming the collision', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir, seedDir } = createBareRemoteWithMain(tmp);
  commitMarkdownFile(seedDir, 'deploy-check.md', `---\nsummary: Team deploy check\ntype: rule\n---\n\nTeam.\n`);
  git(['-C', seedDir, 'push', 'origin', 'main']);

  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });

  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  commitMarkdownFile(projDir, '.faber/memory/deploy-check.md', `---\nsummary: Proj deploy check\ntype: rule\n---\n\nProj.\n`);

  const res = runCli(['compile', '--check'], { homeDir, cwd: projDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('deploy-check'));
  assert.ok(res.stderr.includes('project'));
  assert.ok(res.stderr.includes('team'));
});

test('AC-05b3: Project ID colliding with team is marked shadowed with warning in memory_search', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const { bareDir, seedDir } = createBareRemoteWithMain(tmp);
  commitMarkdownFile(seedDir, 'deploy-check.md', `---\nsummary: Team deploy check\ntype: rule\n---\n\nTeam.\n`);
  git(['-C', seedDir, 'push', 'origin', 'main']);

  const teamDir = path.join(tmp, 'team');
  runCli(['setup', '--team', bareDir, '--path', teamDir], { homeDir });

  const projDir = path.join(tmp, 'proj');
  gitInitSoloRepo(projDir);
  commitMarkdownFile(projDir, '.faber/memory/deploy-check.md', `---\nsummary: Proj deploy check\ntype: rule\n---\n\nProj.\n`);

  const server = new FaberMemoryMcpServer({ homeDir, cwd: projDir });
  const res = JSON.parse(
    server.handleToolCall('memory_search', { query: 'deploy-check' }).content[0].text,
  );
  const projHit = res.results.find((r: { scope: string; id: string }) => r.scope === 'project' && r.id === 'deploy-check');
  assert.ok(projHit);
  assert.equal(projHit.shadowed, true);
  assert.ok(res.metadata.warnings.some((w: string) => w.includes('shadowed')));
});

test('AC-06: Compilation fails without truncation when L0 exceeds estimated token budget', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const personalDir = path.join(tmp, 'personal');
  runCli(['setup', personalDir], { homeDir });

  // Lower budget or add huge body entry
  const hugeBody = 'word '.repeat(2000);
  commitMarkdownFile(
    personalDir,
    'huge-entry.md',
    `---\nsummary: Huge rule\ntype: rule\nl0: body\n---\n\n${hugeBody}\n`,
  );

  const res = runCli(['compile'], { homeDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('huge-entry'));
  assert.ok(!fs.existsSync(getCompiledL0Path(homeDir)));
});

test('AC-07: compile --check validates schema, duplicates, budget, and hygiene for CI without writing files', () => {
  const tmp = makeTempDir();
  const homeDir = path.join(tmp, 'home');
  const teamRepo = path.join(tmp, 'ci-repo');
  gitInitSoloRepo(teamRepo);
  commitMarkdownFile(
    teamRepo,
    'broken-entry.md',
    `---\ntype: rule\n---\n\nMissing summary field.\n`,
  );

  const res = runCli(['compile', '--check', '--repo', teamRepo], { homeDir, cwd: teamRepo });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('broken-entry.md'));
  assert.ok(res.stderr.includes('summary'));
  assert.equal(git(['-C', teamRepo, 'status', '--porcelain']), '');
  assert.ok(!fs.existsSync(getCompiledL0Path(homeDir)));
});
