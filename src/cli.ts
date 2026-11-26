#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { compileGlobalL0 } from './compiler.js';
import {
  generateUuid,
  getCompiledL0Path,
  getDefaultPersonalPath,
  getHomeDir,
  loadConfig,
  saveConfig,
} from './config.js';
import {
  getDefaultBranch,
  getHeadSha,
  gitCloneTeamRepo,
  gitInitSoloRepo,
  isGitRepo,
} from './git.js';
import { ImportSourceType, runImport } from './importer.js';
import { EngineName, formatUnifiedDiff, planOrApplyInit } from './init.js';
import { FaberMemoryMcpServer } from './mcp.js';
import {
  approveProposalsBatch,
  findProposalById,
  reconcileAwaitingCommitProposals,
  rejectProposal,
  saveProposal,
} from './proposals.js';
import { loadAllScopes, resolveProjectRoot } from './store.js';
import { syncAllRoots } from './sync.js';
import { Scope, TeamSubmitMode } from './types.js';

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));
  const homeDir = getHomeDir();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }

  if (cmd === 'serve') {
    const server = new FaberMemoryMcpServer({ homeDir, cwd: process.cwd() });
    server.serveStdio();
    return 0;
  }

  if (cmd === 'setup') {
    const config = loadConfig(homeDir);
    if (flags.team) {
      const url = String(flags.team);
      const dest =
        typeof flags.path === 'string'
          ? path.resolve(flags.path)
          : path.join(homeDir, 'clones', 'team');
      const submitMode =
        flags['submit-mode'] === 'pr' ? 'pr' : ('auto' as TeamSubmitMode);
      const defaultBranch = isGitRepo(dest)
        ? getDefaultBranch(dest)
        : gitCloneTeamRepo(url, dest);
      config.roots.team = {
        uuid: config.roots.team?.uuid || generateUuid(),
        path: dest,
        scope: 'team',
        remote: url,
        defaultBranch,
        submitMode,
      };
      saveConfig(config, homeDir);
      console.log(`Configured team root at ${dest} (branch: ${defaultBranch}, uuid: ${config.roots.team.uuid})`);
      return 0;
    }

    const personalPath =
      typeof flags.path === 'string'
        ? path.resolve(flags.path)
        : positional[0]
          ? path.resolve(positional[0])
          : getDefaultPersonalPath();
    gitInitSoloRepo(personalPath, 'main');
    config.roots.personal = {
      uuid: config.roots.personal?.uuid || generateUuid(),
      path: personalPath,
      scope: 'personal',
      defaultBranch: 'main',
    };
    saveConfig(config, homeDir);
    console.log(`Initialized personal memory root at ${personalPath} (uuid: ${config.roots.personal.uuid})`);
    return 0;
  }

  if (cmd === 'config') {
    const sub = positional[0];
    const config = loadConfig(homeDir);
    if (sub === 'set-path') {
      const scope = positional[1] as 'personal' | 'team';
      const newPath = positional[2];
      if (!scope || !newPath || !['personal', 'team'].includes(scope)) {
        console.error('Usage: faber-memory config set-path <personal|team> <new-path>');
        return 1;
      }
      const root = config.roots[scope];
      if (!root) {
        console.error(`Root "${scope}" is not configured yet.`);
        return 1;
      }
      root.path = path.resolve(newPath);
      saveConfig(config, homeDir);
      console.log(`Updated ${scope} root path to ${root.path} (uuid preserved: ${root.uuid})`);
      return 0;
    }
    if (sub === 'set-submit-mode') {
      const mode = positional[1] as TeamSubmitMode;
      if (!['auto', 'pr'].includes(mode) || !config.roots.team) {
        console.error('Usage: faber-memory config set-submit-mode <auto|pr>');
        return 1;
      }
      config.roots.team.submitMode = mode;
      saveConfig(config, homeDir);
      console.log(`Updated team submit mode to ${mode}`);
      return 0;
    }
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  if (cmd === 'compile') {
    const config = loadConfig(homeDir);
    const checkOnly = Boolean(flags.check);
    const standaloneRepoDir = typeof flags.repo === 'string' ? path.resolve(flags.repo) : undefined;
    const res = compileGlobalL0(config, {
      homeDir,
      checkOnly,
      includeProjectCheck: checkOnly,
      cwd: process.cwd(),
      standaloneRepoDir,
    });
    for (const w of res.warnings) console.warn(`Warning: ${w}`);
    if (!res.ok) {
      for (const e of res.errors) console.error(`Error: ${e}`);
      return 1;
    }
    if (checkOnly) {
      console.log(`OK: compile --check passed (${res.estimatedTokens}/${res.budget} estimated tokens).`);
    } else {
      console.log(`Compiled L0 to ${res.outputPath} (${res.estimatedTokens}/${res.budget} estimated tokens).`);
    }
    return 0;
  }

  if (cmd === 'sync') {
    const config = loadConfig(homeDir);
    const timeoutMs = typeof flags.timeout === 'string' ? Number(flags.timeout) : 5000;
    const res = await syncAllRoots(config, { homeDir, timeoutMs, recompile: true });
    for (const w of res.warnings) console.warn(`Warning: ${w}`);
    if (!res.ok) {
      for (const e of res.errors) console.error(`Error: ${e}`);
      return 1;
    }
    console.log(
      res.advanced
        ? 'Synced remote updates and recompiled L0.'
        : 'Already up to date; L0 compiled.',
    );
    return 0;
  }

  if (cmd === 'approve') {
    const config = loadConfig(homeDir);
    const ids = positional;
    if (ids.length === 0) {
      console.error('Usage: faber-memory approve <proposal-id> [...]');
      return 1;
    }
    const proposals = [];
    for (const id of ids) {
      const p = findProposalById(id, homeDir);
      if (!p) {
        console.error(`Error: Proposal "${id}" not found.`);
        return 1;
      }
      proposals.push(p);
    }
    const modeOverride =
      flags.mode === 'pr' || flags.mode === 'auto' ? (flags.mode as TeamSubmitMode) : undefined;
    const outcome = await approveProposalsBatch(config, proposals, {
      homeDir,
      teamSubmitModeOverride: modeOverride,
    });
    for (const m of outcome.messages) console.log(m);
    if (!outcome.ok) {
      for (const e of outcome.errors) console.error(`Error: ${e}`);
      return 1;
    }
    return 0;
  }

  if (cmd === 'reject') {
    const id = positional[0];
    if (!id) {
      console.error('Usage: faber-memory reject <proposal-id>');
      return 1;
    }
    try {
      const removed = rejectProposal(id, homeDir);
      console.log(`Rejected and removed proposal ${removed.id}.`);
      return 0;
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (cmd === 'review') {
    const config = loadConfig(homeDir);
    const proposals = reconcileAwaitingCommitProposals(homeDir).filter(
      (p) => p.status !== 'awaiting_commit',
    );
    if (proposals.length === 0) {
      console.log('No pending proposals to review.');
      return 0;
    }

    const toApprove = [];
    if (flags['approve-all']) {
      toApprove.push(...proposals);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const lineIter = rl[Symbol.asyncIterator]();
      const ask = async (q: string): Promise<string> => {
        process.stdout.write(q);
        const next = await lineIter.next();
        return next.done ? '' : String(next.value);
      };

      try {
        for (const p of proposals) {
          console.log(`\n=== Proposal ${p.id} [${p.scope} / ${p.action}] ===`);
          console.log(`Entry ID: ${p.entryId}${p.targetId ? ` (target: ${p.targetId})` : ''}`);
          console.log(`Type: ${p.type} | Summary: ${p.summary}`);
          if (p.forceNew && p.reason) {
            console.log(`force_new reason: ${p.reason}`);
          }
          console.log(`Body:\n${p.body}\n`);
          const answer = (await ask('Action? [a]pprove / [e]dit / [r]eject / [s]kip: '))
            .trim()
            .toLowerCase();

          if (answer === 'a' || answer === 'approve') {
            toApprove.push(p);
          } else if (answer === 'e' || answer === 'edit') {
            const newBody = (await ask('New body (single line or leave empty to keep): ')).trim();
            if (newBody) {
              p.body = newBody;
              saveProposal(p, homeDir);
            }
            const confirm = (await ask('Approve edited proposal? [y/N]: ')).trim().toLowerCase();
            if (confirm === 'y' || confirm === 'yes') {
              toApprove.push(p);
            }
          } else if (answer === 'r' || answer === 'reject') {
            rejectProposal(p.id, homeDir);
            console.log(`Rejected ${p.id}.`);
          } else {
            console.log(`Skipped ${p.id}.`);
          }
        }
      } finally {
        rl.close();
      }
    }

    if (toApprove.length > 0) {
      const outcome = await approveProposalsBatch(config, toApprove, { homeDir });
      for (const m of outcome.messages) console.log(m);
      if (!outcome.ok) {
        for (const e of outcome.errors) console.error(`Error: ${e}`);
        return 1;
      }
    }
    return 0;
  }

  if (cmd === 'status') {
    const config = loadConfig(homeDir);
    const projectRes = resolveProjectRoot(undefined, process.cwd());
    const loaded = loadAllScopes(config, projectRes);
    const proposals = reconcileAwaitingCommitProposals(homeDir);

    console.log('FaberSEP Memory Status');
    console.log(`  Compiled L0: ${getCompiledL0Path(homeDir)} (${fs.existsSync(getCompiledL0Path(homeDir)) ? 'present' : 'missing'})`);
    if (config.roots.team) {
      console.log(
        `  Team root: ${config.roots.team.path} (HEAD: ${getHeadSha(config.roots.team.path)?.slice(0, 8) || 'none'}, mode: ${config.roots.team.submitMode || 'auto'})`,
      );
    }
    if (config.roots.personal) {
      console.log(
        `  Personal root: ${config.roots.personal.path} (HEAD: ${getHeadSha(config.roots.personal.path)?.slice(0, 8) || 'none'})`,
      );
    }
    console.log(
      `  Project root: ${projectRes.projectRoot || 'none'} (source: ${projectRes.source})`,
    );

    if (loaded.uncommittedWarnings.length > 0) {
      console.log('Warnings:');
      for (const w of loaded.uncommittedWarnings) console.log(`  - ${w}`);
    }

    const nowMs = Date.now();
    const staleMs = config.staleDays * 24 * 60 * 60 * 1000;
    console.log(`Pending proposals: ${proposals.length}`);
    for (const p of proposals) {
      const ageDays = Math.floor((nowMs - Date.parse(p.createdAt)) / (24 * 60 * 60 * 1000));
      const isStale = nowMs - Date.parse(p.createdAt) > staleMs;
      const flagsList: string[] = [p.status];
      if (isStale) flagsList.push(`STALE (${ageDays}d > ${config.staleDays}d)`);
      console.log(`  - ${p.id} [${p.scope}/${p.action}] (${flagsList.join(', ')}): ${p.summary}`);
      if (p.status === 'awaiting_commit' && p.targetFilePath) {
        console.log(`    file: ${p.targetFilePath} — run "git add ${p.targetFilePath} && git commit" to activate`);
      }
      if (p.status === 'push_failed' && p.error) {
        console.log(`    push error: ${p.error}`);
      }
    }
    return 0;
  }

  if (cmd === 'import') {
    const config = loadConfig(homeDir);
    const from = flags.from as ImportSourceType | undefined;
    const sourcePath = positional[0];
    if (!from || !sourcePath) {
      console.error(
        'Usage: faber-memory import --from <markdown-dir|claude-memory|agents-md|cursor-rules> <path> [--split-headings] [--approve]',
      );
      return 1;
    }
    try {
      const res = await runImport(config, {
        from,
        sourcePath: path.resolve(sourcePath),
        scope: typeof flags.scope === 'string' ? (flags.scope as Scope) : 'personal',
        splitHeadings: Boolean(flags['split-headings']),
        approve: Boolean(flags.approve),
        homeDir,
        cwd: process.cwd(),
      });
      console.log(`Staged ${res.staged.length} proposal(s) in pre-memory.`);
      if (res.approvedIds.length > 0) {
        console.log(`Approved ${res.approvedIds.length} proposal(s) in solo mode.`);
      }
      if (res.duplicates.length > 0) {
        console.log(`Duplicates skipped (${res.duplicates.length}):`);
        for (const d of res.duplicates) {
          console.log(`  - ${d.source} matches "${d.matchedId}" (${d.summary})`);
        }
      }
      if (res.skippedHygiene.length > 0) {
        console.log(`Hygiene skipped (${res.skippedHygiene.length}):`);
        for (const s of res.skippedHygiene) {
          console.log(`  - ${s.source}: ${s.reason}`);
        }
      }
      for (const n of res.notes) console.log(n);
      return 0;
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (cmd === 'init') {
    const config = loadConfig(homeDir);
    const apply = Boolean(flags.apply);
    const undo = Boolean(flags.undo);
    const projectHint = Boolean(flags['project-hint']);
    const engines =
      typeof flags.engine === 'string'
        ? (flags.engine.split(',').map((e) => e.trim()) as EngineName[])
        : undefined;

    try {
      const res = planOrApplyInit(config, {
        apply,
        undo,
        engines,
        projectHint,
        homeDir,
      });

      for (const n of res.notes) console.log(n);
      for (const p of res.plans) {
        console.log(formatUnifiedDiff(p));
      }
      if (undo && res.backups.length > 0) {
        console.log(`Backup files preserved (not auto-restored): ${res.backups.join(', ')}`);
      }
      if (res.projectHint) {
        console.log(`Project hint: ${res.projectHint}`);
      }
      if (!apply && !undo) {
        console.log('\nDry-run only. Re-run with --apply to write changes.');
      }
      return 0;
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 1;
}

function printHelp(): void {
  console.log(`@fabersep/memory (faber-memory)

Commands:
  setup [path] [--team <git-url> --path <dir> --submit-mode auto|pr]
  config [set-path <personal|team> <new-path> | set-submit-mode <auto|pr>]
  init [--apply | --undo] [--engine claude-code,antigravity,cursor,codex] [--project-hint]
  compile [--check] [--repo <dir>]
  sync [--timeout <ms>]
  status
  review [--approve-all]
  approve <proposal-id> [...] [--mode auto|pr]
  reject <proposal-id>
  import --from <markdown-dir|claude-memory|agents-md|cursor-rules> <path> [--split-headings] [--approve]
  serve
`);
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
