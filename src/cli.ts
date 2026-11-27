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
import { formatDoctorReport, runDoctor } from './doctor.js';
import {
  getDefaultBranch,
  getHeadSha,
  gitCloneTeamRepo,
  gitInitSoloRepo,
  isGitRepo,
} from './git.js';
import { ImportSourceType, runImport } from './importer.js';
import { EngineName, formatPlanBeforeAfter, planOrApplyInit } from './init.js';
import { FaberMemoryMcpServer } from './mcp.js';
import {
  approveProposalsBatch,
  findProposalById,
  reconcileAwaitingCommitProposals,
  rejectProposal,
  saveProposal,
} from './proposals.js';
import {
  buildShareableBenchmark,
  computeStats,
  formatShareableMarkdown,
  formatStatsReport,
  validateDaysArg,
} from './stats.js';
import { loadAllScopes, resolveProjectRoot } from './store.js';
import { syncAllRoots } from './sync.js';
import { getPackageVersion } from './version.js';
import { Proposal, Scope, TeamSubmitMode } from './types.js';
import {
  c,
  hr,
  inferErrorAnchor,
  normalizeTeamUrl,
  troubleshootingLink,
} from './ui.js';

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

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (ans) => resolve(ans.trim()));
    });
  } finally {
    rl.close();
  }
}

function printErrorWithHelp(errMsg: string): void {
  console.error(c.red(`Error: ${errMsg}`));
  const anchor = inferErrorAnchor(errMsg);
  if (anchor) {
    console.error(c.dim(`  Details: ${troubleshootingLink(anchor)}`));
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));
  const homeDir = getHomeDir();

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(getPackageVersion());
    return 0;
  }

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
      const rawUrl = String(flags.team);
      const { url, normalized } = normalizeTeamUrl(rawUrl);
      if (normalized) {
        console.log(c.dim(`Normalized team URL: ${rawUrl} -> ${url}`));
      }
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
      console.log(
        c.green(
          `Configured team root at ${dest} (branch: ${defaultBranch}, uuid: ${config.roots.team.uuid})`,
        ),
      );
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
    console.log(
      c.green(
        `Initialized personal memory root at ${personalPath} (uuid: ${config.roots.personal.uuid})`,
      ),
    );
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
      console.log(c.green(`Updated ${scope} root path to ${root.path} (uuid preserved: ${root.uuid})`));
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
      console.log(c.green(`Updated team submit mode to ${mode}`));
      return 0;
    }
    if (sub === 'unset') {
      const scope = positional[1] as 'personal' | 'team';
      if (!scope || !['personal', 'team'].includes(scope)) {
        console.error('Usage: faber-memory config unset <personal|team>');
        return 1;
      }
      const existing = config.roots[scope];
      if (!existing) {
        console.log(`Root "${scope}" is not configured.`);
        return 0;
      }
      delete config.roots[scope];
      saveConfig(config, homeDir);
      console.log(
        c.green(
          `Disconnected ${scope} root from config (files on disk at ${existing.path} were kept intact).`,
        ),
      );
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
    for (const w of res.warnings) console.warn(c.yellow(`Warning: ${w}`));
    if (!res.ok) {
      for (const e of res.errors) printErrorWithHelp(e);
      return 1;
    }
    if (checkOnly) {
      console.log(
        c.green(
          `OK: compile --check passed (${res.estimatedTokens}/${res.budget} estimated tokens).`,
        ),
      );
    } else {
      console.log(
        c.green(
          `Compiled L0 to ${res.outputPath} (${res.estimatedTokens}/${res.budget} estimated tokens).`,
        ),
      );
    }
    return 0;
  }

  if (cmd === 'sync') {
    const config = loadConfig(homeDir);
    const timeoutMs = typeof flags.timeout === 'string' ? Number(flags.timeout) : 5000;
    const res = await syncAllRoots(config, { homeDir, timeoutMs, recompile: true });
    for (const w of res.warnings) console.warn(c.yellow(`Warning: ${w}`));
    if (!res.ok) {
      for (const e of res.errors) printErrorWithHelp(e);
      return 1;
    }
    console.log(
      c.green(
        res.advanced
          ? 'Synced remote updates and recompiled L0.'
          : 'Already up to date; L0 compiled.',
      ),
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
        console.error(c.red(`Error: Proposal "${id}" not found.`));
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
      for (const e of outcome.errors) printErrorWithHelp(e);
      return 1;
    }
    return 0;
  }

  if (cmd === 'reject') {
    if (flags.all) {
      const proposals = reconcileAwaitingCommitProposals(homeDir);
      if (proposals.length === 0) {
        console.log('No pending proposals to reject.');
        return 0;
      }
      if (!flags.yes) {
        const ans = (
          await promptLine(
            c.yellow(`Reject and delete all ${proposals.length} pending proposal(s)? [y/N]: `),
          )
        ).toLowerCase();
        if (ans !== 'y' && ans !== 'yes') {
          console.log('Cancelled. No proposals were removed.');
          return 0;
        }
      }
      for (const p of proposals) {
        rejectProposal(p.id, homeDir);
      }
      console.log(c.green(`Rejected and removed ${proposals.length} pending proposal(s).`));
      return 0;
    }

    const id = positional[0];
    if (!id) {
      console.error('Usage: faber-memory reject <proposal-id> | faber-memory reject --all [--yes]');
      return 1;
    }
    try {
      const removed = rejectProposal(id, homeDir);
      console.log(c.green(`Rejected and removed proposal ${removed.id}.`));
      return 0;
    } catch (err: unknown) {
      printErrorWithHelp(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (cmd === 'reset') {
    const config = loadConfig(homeDir);
    const includePersonal = Boolean(flags['include-personal-repo']);
    const personalPath = config.roots.personal?.path;

    console.log(c.bold(c.yellow('FaberSEP Memory Reset')));
    console.log('This will:');
    console.log('  1. Undo agent wiring (remove faber-memory blocks & MCP entries).');
    console.log(
      `  2. Delete local state directory: ${homeDir} (config, compiled L0, pre-memory, metrics.jsonl, team clone).`,
    );
    if (includePersonal && personalPath) {
      console.log(c.red(`  3. Delete personal memory Git repository: ${personalPath}`));
    } else if (personalPath) {
      console.log(
        c.dim(
          `  (Personal Git repo at ${personalPath} will be kept. Pass --include-personal-repo to delete it too.)`,
        ),
      );
    }

    if (!flags.yes) {
      const ans = (
        await promptLine(c.yellow('Continue with reset? [y/N]: '))
      ).toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('Reset cancelled.');
        return 0;
      }
    }

    try {
      planOrApplyInit(config, { undo: true, homeDir });
    } catch {
      // Best-effort undo even if config is partial
    }

    if (fs.existsSync(homeDir)) {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
    if (includePersonal && personalPath && fs.existsSync(personalPath)) {
      fs.rmSync(personalPath, { recursive: true, force: true });
    }

    console.log(c.green('Reset complete.'));
    return 0;
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

    type Decision = 'approve' | 'reject' | 'skip';
    const decisions = new Map<string, Decision>();

    if (flags['approve-all']) {
      for (const p of proposals) decisions.set(p.id, 'approve');
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let interrupted = false;
      rl.on('SIGINT', () => {
        interrupted = true;
        console.log(c.yellow('\nInterrupted — saving decisions made so far...'));
        rl.close();
      });

      const lineIter = rl[Symbol.asyncIterator]();
      const ask = async (q: string): Promise<string | null> => {
        process.stdout.write(q);
        const next = await lineIter.next();
        if (next.done) return null;
        return String(next.value);
      };

      const MAX_PREVIEW_LINES = 12;

      try {
        let idx = 0;
        let showFull = false;

        while (idx < proposals.length && !interrupted) {
          const p = proposals[idx];
          const approvedCount = [...decisions.values()].filter((d) => d === 'approve').length;
          const rejectedCount = [...decisions.values()].filter((d) => d === 'reject').length;
          const skippedCount = [...decisions.values()].filter((d) => d === 'skip').length;
          const prevDecision = decisions.get(p.id);

          console.log(`\n${c.dim(hr('═', 68))}`);
          console.log(
            `${c.bold(c.cyan(`[ ${idx + 1} / ${proposals.length} ]`))}  ` +
              `${c.green(`Approved: ${approvedCount}`)} | ` +
              `${c.red(`Rejected: ${rejectedCount}`)} | ` +
              `${c.yellow(`Skipped: ${skippedCount}`)}` +
              (prevDecision ? c.dim(`  (current: ${prevDecision})`) : ''),
          );
          console.log(c.dim(hr('─', 68)));
          console.log(
            `${c.bold('ID:')} ${c.cyan(p.entryId)}  ` +
              `${c.bold('Scope:')} ${c.magenta(p.scope)}  ` +
              `${c.bold('Type:')} ${p.type}  ` +
              `${c.bold('Action:')} ${p.action}` +
              (p.targetId ? ` (target: ${p.targetId})` : ''),
          );
          console.log(`${c.bold('Summary:')} ${p.summary}`);
          if (p.forceNew && p.reason) {
            console.log(`${c.yellow('force_new reason:')} ${p.reason}`);
          }
          console.log(c.dim(hr('─', 68)));

          const bodyLines = p.body.split('\n');
          if (!showFull && bodyLines.length > MAX_PREVIEW_LINES) {
            console.log(bodyLines.slice(0, MAX_PREVIEW_LINES).join('\n'));
            console.log(
              c.dim(
                `... (+${bodyLines.length - MAX_PREVIEW_LINES} more lines — press [v] to view full body)`,
              ),
            );
          } else {
            console.log(p.body);
          }
          console.log(c.dim(hr('─', 68)));

          const navHints = [
            c.green('[a]pprove'),
            c.cyan('[e]dit'),
            c.red('[r]eject'),
            c.yellow('[s]kip'),
            ...(!showFull && bodyLines.length > MAX_PREVIEW_LINES ? ['[v]iew full'] : []),
            ...(idx > 0 ? ['[b]ack'] : []),
            c.dim('[q]uit & save'),
          ].join('  ');

          const rawAns = await ask(`${navHints}\n> `);
          if (rawAns === null) break;
          const answer = rawAns.trim().toLowerCase();

          if (answer === 'v' || answer === 'view') {
            showFull = true;
            continue;
          }

          if (answer === 'b' || answer === 'back') {
            if (idx > 0) {
              idx--;
              showFull = false;
            } else {
              console.log(c.dim('Already at the first proposal.'));
            }
            continue;
          }

          if (answer === 'q' || answer === 'quit') {
            break;
          }

          showFull = false;

          if (answer === 'a' || answer === 'approve') {
            decisions.set(p.id, 'approve');
            idx++;
          } else if (answer === 'e' || answer === 'edit') {
            const newBodyRaw = await ask('New body (single line or leave empty to keep): ');
            if (newBodyRaw === null) break;
            const newBody = newBodyRaw.trim();
            if (newBody) {
              p.body = newBody;
              saveProposal(p, homeDir);
            }
            const confirmRaw = await ask('Approve edited proposal? [y/N]: ');
            if (confirmRaw === null) break;
            const confirm = confirmRaw.trim().toLowerCase();
            if (confirm === 'y' || confirm === 'yes') {
              decisions.set(p.id, 'approve');
            } else {
              decisions.set(p.id, 'skip');
            }
            idx++;
          } else if (answer === 'r' || answer === 'reject') {
            decisions.set(p.id, 'reject');
            idx++;
          } else {
            decisions.set(p.id, 'skip');
            idx++;
          }
        }
      } finally {
        rl.close();
      }
    }

    const toApprove: Proposal[] = [];
    const toReject: Proposal[] = [];
    for (const p of proposals) {
      const d = decisions.get(p.id);
      if (d === 'approve') toApprove.push(p);
      else if (d === 'reject') toReject.push(p);
    }

    for (const p of toReject) {
      rejectProposal(p.id, homeDir);
    }

    let exitCode = 0;
    if (toApprove.length > 0) {
      const outcome = await approveProposalsBatch(config, toApprove, { homeDir });
      for (const m of outcome.messages) console.log(m);
      if (!outcome.ok) {
        for (const e of outcome.errors) printErrorWithHelp(e);
        exitCode = 1;
      }
    }

    const remainingCount = proposals.length - toApprove.length - toReject.length;
    console.log(
      `\n${c.bold('Review summary:')} ` +
        `${c.green(`${toApprove.length} approved`)} | ` +
        `${c.red(`${toReject.length} rejected`)} | ` +
        `${c.yellow(`${remainingCount} remaining in pre-memory`)}`,
    );
    return exitCode;
  }

  if (cmd === 'status') {
    const config = loadConfig(homeDir);
    const projectRes = resolveProjectRoot(undefined, process.cwd());
    const loaded = loadAllScopes(config, projectRes);
    const proposals = reconcileAwaitingCommitProposals(homeDir);

    console.log(c.bold('FaberSEP Memory Status'));
    const l0Path = getCompiledL0Path(homeDir);
    const l0Present = fs.existsSync(l0Path);
    console.log(
      `  Compiled L0: ${l0Path} (${l0Present ? c.green('present') : c.yellow('missing')})`,
    );
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
      console.log(c.yellow('Warnings:'));
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
        console.log(c.red(`    push error: ${p.error}`));
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
        'Usage: faber-memory import --from <markdown-dir|claude-memory|agents-md|cursor-rules> <path> [--scope personal|team|project] [--split-headings] [--normalize-paths] [--approve]',
      );
      return 1;
    }
    try {
      const res = await runImport(config, {
        from,
        sourcePath: path.resolve(sourcePath),
        scope: typeof flags.scope === 'string' ? (flags.scope as Scope) : 'personal',
        splitHeadings: Boolean(flags['split-headings']),
        normalizePaths: Boolean(flags['normalize-paths']),
        approve: Boolean(flags.approve),
        homeDir,
        cwd: process.cwd(),
      });
      console.log(c.green(`Staged ${res.staged.length} proposal(s) in pre-memory.`));
      if (res.approvedIds.length > 0) {
        console.log(c.green(`Approved ${res.approvedIds.length} proposal(s) in solo mode.`));
      }
      if (res.normalizedPaths.length > 0) {
        console.log(
          c.cyan(`Normalized machine paths to ~/ in ${res.normalizedPaths.length} file(s):`),
        );
        for (const n of res.normalizedPaths) {
          console.log(`  - ${n.source} (${n.replacements} replacement(s))`);
        }
      }
      if (res.skippedIndex.length > 0) {
        console.log(
          c.dim(
            `Index files skipped (${res.skippedIndex.length}) — faber-memory compiles its own L0 MEMORY.md index:`,
          ),
        );
        for (const f of res.skippedIndex) {
          console.log(c.dim(`  - ${f}`));
        }
        console.log(c.dim(`  Details: ${troubleshootingLink('index-files')}`));
      }
      if (res.duplicates.length > 0) {
        console.log(c.yellow(`Duplicates skipped (${res.duplicates.length}):`));
        for (const d of res.duplicates) {
          console.log(`  - ${d.source} matches "${d.matchedId}" (${d.summary})`);
        }
      }
      if (res.skippedHygiene.length > 0) {
        console.log(c.yellow(`Hygiene skipped (${res.skippedHygiene.length}):`));
        for (const s of res.skippedHygiene) {
          console.log(`  - ${s.source}: ${s.reason}`);
          if (s.snippet) {
            console.log(c.dim(`    snippet: ${s.snippet}`));
          }
          if (s.anchor === 'machine-specific-paths') {
            console.log(
              c.cyan(
                '    hint: Replace /Users/<name>/ or /home/<name>/ with ~/, or re-run with --normalize-paths.',
              ),
            );
          } else {
            console.log(
              c.cyan('    hint: Remove the secret/token and reference an env var name instead.'),
            );
          }
          console.log(c.dim(`    details: ${troubleshootingLink(s.anchor)}`));
        }
      }
      if (res.skippedHygiene.length > 0) {
        console.log(
          c.yellow(
            `NOT imported: ${res.skippedHygiene.length} item(s) were left out because of the hygiene check above. Fix them (or add --normalize-paths for paths) and run import again; already staged items are not duplicated.`,
          ),
        );
      }
      for (const n of res.notes) console.log(n);
      return 0;
    } catch (err: unknown) {
      printErrorWithHelp(err instanceof Error ? err.message : String(err));
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

      for (const n of res.notes) console.log(c.yellow(n));
      for (const p of res.plans) {
        console.log(formatPlanBeforeAfter(p));
      }
      if (undo) {
        console.log(
          c.cyan(
            '\nRemoved agent wiring only. Your memory repos and pending pre-memory proposals were kept intact. (Use "faber-memory reset" to wipe local state.)',
          ),
        );
        if (res.backups.length > 0) {
          console.log(c.dim(`Backup files preserved (not auto-restored): ${res.backups.join(', ')}`));
        }
      }
      if (res.projectHint) {
        console.log(`Project hint: ${res.projectHint}`);
      }
      if (!apply && !undo) {
        console.log(c.yellow('\nDry-run only. Re-run with --apply to write changes.'));
      }
      return 0;
    } catch (err: unknown) {
      printErrorWithHelp(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (cmd === 'stats') {
    const daysCheck = validateDaysArg(flags.days);
    if (!daysCheck.ok) {
      printErrorWithHelp(daysCheck.error);
      return 1;
    }

    const report = computeStats({
      days: daysCheck.days,
      includeCache: Boolean(flags.cache),
      engine: typeof flags.engine === 'string' ? flags.engine : undefined,
      logDir: typeof flags['log-dir'] === 'string' ? path.resolve(flags['log-dir']) : undefined,
      homeDir,
      cwd: process.cwd(),
    });

    if (flags.share) {
      const card = buildShareableBenchmark(report);
      if (flags.json) {
        console.log(JSON.stringify(card, null, 2));
      } else {
        console.log(formatShareableMarkdown(card));
      }
      return 0;
    }

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    console.log(formatStatsReport(report));
    return 0;
  }

  if (cmd === 'doctor') {
    const report = runDoctor({
      strict: Boolean(flags.strict),
      homeDir,
      cwd: process.cwd(),
    });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    return report.exitCode;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 1;
}

function printHelp(): void {
  console.log(`@fabersep/memory (faber-memory)

Commands:
  setup [path] [--team <git-url|org/repo> --path <dir> --submit-mode auto|pr]
  config [set-path <personal|team> <new-path> | set-submit-mode <auto|pr> | unset <personal|team>]
  init [--apply | --undo] [--engine claude-code,antigravity,claude-desktop,cursor,codex] [--project-hint]
  compile [--check] [--repo <dir>]
  sync [--timeout <ms>]
  status
  stats [--days 1..90] [--json] [--cache] [--engine claude-code|antigravity|all] [--log-dir <path>] [--share]
  doctor [--json] [--strict]
  review [--approve-all]
  approve <proposal-id> [...] [--mode auto|pr]
  reject <proposal-id> | reject --all [--yes]
  reset [--include-personal-repo] [--yes]
  import --from <markdown-dir|claude-memory|agents-md|cursor-rules> <path> [--scope personal|team|project] [--split-headings] [--normalize-paths] [--approve]
  serve
  --version

Docs: https://github.com/fabersep/memory#readme
`);
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    printErrorWithHelp(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
