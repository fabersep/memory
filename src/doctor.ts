import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { estimateTokens, renderGlobalL0 } from './compiler.js';
import { getCompiledL0Path, getConfigPath, getHomeDir, loadConfig } from './config.js';
import { getHeadSha, getUncommittedFiles, isGitRepo, readHeadFile } from './git.js';
import { scanHygiene } from './hygiene.js';
import { BLOCK_END, BLOCK_START, getEngineSpecs, getUserHome } from './init.js';
import { CompileMetricEvent, readMetrics } from './metrics.js';
import { listAllProposals } from './proposals.js';
import { L0_CHURN_WARN_THRESHOLD } from './stats.js';
import { loadScopeFromHead, PROJECT_MEMORY_REL_DIR, resolveProjectRoot } from './store.js';
import { MemoryEntry, UserConfig } from './types.js';
import { c, hr } from './ui.js';

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: DoctorStatus;
  details: string[];
  hint?: string;
}

export interface DoctorReport {
  schemaVersion: number;
  strict: boolean;
  overall: DoctorStatus;
  exitCode: number;
  checks: DoctorCheckResult[];
}

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function extractManagedBlock(content: string): string | null {
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(BLOCK_END, startIdx + BLOCK_START.length);
  if (endIdx === -1) return null;
  return content.slice(startIdx + BLOCK_START.length, endIdx);
}

function hasFaberMemoryMcpEntry(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(
      raw &&
        typeof raw === 'object' &&
        raw.mcpServers &&
        typeof raw.mcpServers === 'object' &&
        'faber-memory' in raw.mcpServers,
    );
  } catch {
    return false;
  }
}

export function runDoctor(options: {
  strict?: boolean;
  homeDir?: string;
  userHome?: string;
  cwd?: string;
  nowMs?: number;
} = {}): DoctorReport {
  const homeDir = options.homeDir || getHomeDir();
  const userHome = options.userHome || getUserHome();
  const cwd = options.cwd || process.cwd();
  const nowMs = options.nowMs ?? Date.now();
  const strict = Boolean(options.strict);

  const checks: DoctorCheckResult[] = [];

  // 1. Config & Git roots health
  let config: UserConfig | null = null;
  const cfgPath = getConfigPath(homeDir);
  const configDetails: string[] = [];
  let configStatus: DoctorStatus = 'PASS';
  let configHint: string | undefined;

  if (!fs.existsSync(cfgPath)) {
    configStatus = 'FAIL';
    configDetails.push(`Config file not found at ${cfgPath}.`);
    configHint = 'Run "faber-memory setup" to initialize your memory configuration.';
  } else {
    try {
      config = loadConfig(homeDir);
    } catch {
      configStatus = 'FAIL';
      configDetails.push(`Config file at ${cfgPath} is corrupt or unparseable JSON.`);
      configHint = 'Fix or recreate config.json (or run "faber-memory setup" after backing it up).';
    }
  }

  const projRes = resolveProjectRoot(undefined, cwd);

  if (config) {
    const hasPersonal = Boolean(config.roots.personal);
    const hasTeam = Boolean(config.roots.team);

    if (!hasPersonal && !hasTeam) {
      configStatus = 'FAIL';
      configDetails.push('Neither personal nor team memory root is configured.');
      configHint = 'Run "faber-memory setup" to configure a personal or team memory root.';
    } else {
      const configuredRoots = [config.roots.personal, config.roots.team].filter(Boolean);
      for (const root of configuredRoots) {
        if (!root) continue;
        if (!fs.existsSync(root.path)) {
          configStatus = 'FAIL';
          configDetails.push(`${root.scope} root path does not exist: ${root.path}`);
          configHint = `Restore the ${root.scope} repo or update its path with "faber-memory config set-path ${root.scope} <path>".`;
          continue;
        }
        if (!isGitRepo(root.path)) {
          configStatus = 'FAIL';
          configDetails.push(`${root.scope} root is not a valid Git repository: ${root.path}`);
          configHint = `Re-initialize the ${root.scope} root with "faber-memory setup".`;
          continue;
        }
        const sha = getHeadSha(root.path);
        if (!sha) {
          configStatus = 'FAIL';
          configDetails.push(`${root.scope} root has no valid HEAD commit: ${root.path}`);
          configHint = `Create an initial commit in ${root.path}.`;
          continue;
        }
        configDetails.push(`${root.scope} root OK (HEAD ${sha.slice(0, 8)}).`);
        const uncommitted = getUncommittedFiles(root.path);
        if (uncommitted.length > 0) {
          if (configStatus !== 'FAIL') configStatus = 'WARN';
          configDetails.push(
            `${root.scope} root has ${uncommitted.length} uncommitted file(s): ${uncommitted.slice(0, 5).join(', ')}`,
          );
          if (!configHint) {
            configHint = `Commit or discard uncommitted edits in the ${root.scope} memory root.`;
          }
        }
      }

      if (!hasPersonal && hasTeam) {
        if (configStatus !== 'FAIL') configStatus = 'WARN';
        configDetails.push('Team root is configured, but no personal memory root is configured.');
        if (!configHint) {
          configHint = 'Run "faber-memory setup" if you also want a personal memory root.';
        }
      }

      if (projRes.source !== 'none' && projRes.projectRoot) {
        const projUncommitted = getUncommittedFiles(projRes.projectRoot, PROJECT_MEMORY_REL_DIR);
        if (projUncommitted.length > 0) {
          if (configStatus !== 'FAIL') configStatus = 'WARN';
          configDetails.push(
            `project memory has ${projUncommitted.length} uncommitted file(s): ${projUncommitted.slice(0, 5).join(', ')}`,
          );
          if (!configHint) {
            configHint = 'Commit pending project memory files in .faber/memory/ to activate them.';
          }
        }
      }
    }
  }

  checks.push({
    id: 'config-and-roots',
    name: 'Config & Git roots',
    status: configStatus,
    details: configDetails,
    ...(configHint ? { hint: configHint } : {}),
  });

  // Load scopes once (read-only from HEAD; never standalone cwd fallback)
  const teamScope =
    config?.roots.team && isGitRepo(config.roots.team.path)
      ? loadScopeFromHead(config.roots.team.path, 'team')
      : undefined;
  const personalScope =
    config?.roots.personal && isGitRepo(config.roots.personal.path)
      ? loadScopeFromHead(config.roots.personal.path, 'personal')
      : undefined;
  const projectScope =
    projRes.source !== 'none' && projRes.projectRoot && isGitRepo(projRes.projectRoot)
      ? loadScopeFromHead(projRes.projectRoot, 'project', PROJECT_MEMORY_REL_DIR)
      : undefined;

  // 2. Compiled L0 health
  const l0Path = getCompiledL0Path(homeDir);
  const l0Details: string[] = [];
  let l0Status: DoctorStatus = 'PASS';
  let l0Hint: string | undefined;

  if (!config) {
    l0Status = 'FAIL';
    l0Details.push('Skipped because config.json could not be loaded.');
    l0Hint = 'Fix config.json first, then run "faber-memory compile".';
  } else if (!fs.existsSync(l0Path)) {
    l0Status = 'FAIL';
    l0Details.push(`Compiled L0 MEMORY.md is missing at ${l0Path}.`);
    l0Hint = 'Run "faber-memory compile" to generate compiled L0 MEMORY.md.';
  } else {
    const onDiskText = fs.readFileSync(l0Path, 'utf8');
    const onDiskTokens = estimateTokens(onDiskText);
    const expectedText = renderGlobalL0(teamScope?.entries || [], personalScope?.entries || []);
    const expectedTokens = estimateTokens(expectedText);

    if (onDiskTokens > config.tokenBudget || expectedTokens > config.tokenBudget) {
      l0Status = 'FAIL';
      l0Details.push(
        `Compiled L0 exceeds token budget (${Math.max(onDiskTokens, expectedTokens)} > ${config.tokenBudget} estimated tokens).`,
      );
      l0Hint = 'Move lower-priority entries to l0: none or shorten summaries, then run "faber-memory compile".';
    } else if (sha256(onDiskText) !== sha256(expectedText)) {
      l0Status = 'WARN';
      l0Details.push(
        `Compiled L0 MEMORY.md is stale (differs from current committed HEAD team + personal entries).`,
      );
      l0Hint = 'Run "faber-memory compile" to refresh compiled L0 MEMORY.md.';
    } else {
      l0Details.push(
        `Compiled L0 is up to date (${onDiskTokens}/${config.tokenBudget} estimated tokens).`,
      );
    }
  }

  checks.push({
    id: 'compiled-l0',
    name: 'Compiled L0',
    status: l0Status,
    details: l0Details,
    ...(l0Hint ? { hint: l0Hint } : {}),
  });

  // 3. Schema, ID & hygiene integrity (does NOT repeat Check 2's over-budget check)
  const integrityDetails: string[] = [];
  let integrityStatus: DoctorStatus = 'PASS';
  let integrityHint: string | undefined;

  if (!config) {
    integrityStatus = 'FAIL';
    integrityDetails.push('Skipped because config.json could not be loaded.');
    integrityHint = 'Fix config.json first.';
  } else {
    const scopesToCheck = [teamScope, personalScope, projectScope].filter(Boolean);
    const activeIdsByScope = new Map<string, Set<string>>();

    for (const sc of scopesToCheck) {
      if (!sc) continue;
      for (const err of sc.errors) {
        integrityStatus = 'FAIL';
        integrityDetails.push(`[${err.scope}] ${err.filePath}: ${err.message}`);
      }

      const seenInScope = new Set<string>();
      for (const entry of sc.entries) {
        const hygiene = scanHygiene(`${entry.summary}\n${entry.body}`);
        if (hygiene.length > 0) {
          integrityStatus = 'FAIL';
          integrityDetails.push(
            `[${entry.scope}] ${entry.filePath}: ${hygiene.map((h) => h.category).join(', ')} hygiene violation (${hygiene.length} finding(s)).`,
          );
        }
        if (entry.status === 'active') {
          if (seenInScope.has(entry.id)) {
            integrityStatus = 'FAIL';
            integrityDetails.push(`Duplicate active ID "${entry.id}" within ${sc.scope} scope.`);
          }
          seenInScope.add(entry.id);
        }
      }
      activeIdsByScope.set(sc.scope, seenInScope);
    }

    // Cross-scope duplicate active IDs
    const scopePairs: [string, string][] = [
      ['team', 'personal'],
      ['project', 'team'],
      ['project', 'personal'],
    ];
    for (const [a, b] of scopePairs) {
      const setA = activeIdsByScope.get(a);
      const setB = activeIdsByScope.get(b);
      if (!setA || !setB) continue;
      for (const id of setA) {
        if (setB.has(id)) {
          integrityStatus = 'FAIL';
          integrityDetails.push(`Duplicate active ID "${id}" across scopes "${a}" and "${b}".`);
        }
      }
    }

    if (integrityStatus === 'FAIL') {
      integrityHint =
        'Fix the reported frontmatter, duplicate ID, or hygiene violations, commit, and re-run "faber-memory compile --check".';
    } else {
      const totalChecked = scopesToCheck.reduce(
        (sum, sc) => sum + ((sc?.entries as MemoryEntry[] | undefined)?.length || 0),
        0,
      );
      integrityDetails.push(`Checked ${totalChecked} committed entry/entries: schema, IDs, and hygiene OK.`);
    }
  }

  checks.push({
    id: 'hygiene-and-schema',
    name: 'Schema, ID & hygiene',
    status: integrityStatus,
    details: integrityDetails,
    ...(integrityHint ? { hint: integrityHint } : {}),
  });

  // 4. Engine wiring check (read-only, respects FABER_USER_HOME, never executes npx)
  const wiringDetails: string[] = [];
  let wiringStatus: DoctorStatus = 'PASS';
  let wiringHint: string | undefined;

  const specs = getEngineSpecs();
  const wiredEngines: string[] = [];
  const mismatchedEngines: string[] = [];

  for (const engineName of ['claude-code', 'claude-desktop', 'antigravity', 'cursor'] as const) {
    const spec = specs[engineName];
    const mcpWired = spec.mcpConfigFile ? hasFaberMemoryMcpEntry(spec.mcpConfigFile(userHome)) : false;

    let instrWired = false;
    let instrMismatch = false;
    if (spec.instructionFile && (engineName === 'claude-code' || engineName === 'antigravity')) {
      const instrPath = spec.instructionFile(userHome);
      if (fs.existsSync(instrPath)) {
        try {
          const content = fs.readFileSync(instrPath, 'utf8');
          const block = extractManagedBlock(content);
          if (block !== null) {
            instrWired = true;
            if (engineName === 'claude-code') {
              const expectedLine = `@${l0Path}`;
              if (!block.includes(expectedLine)) {
                instrMismatch = true;
              }
            } else if (engineName === 'antigravity') {
              if (!block.includes(l0Path)) {
                instrMismatch = true;
              }
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    if (instrMismatch) {
      mismatchedEngines.push(engineName);
      wiringDetails.push(`${engineName}: managed L0 block path does not match ${l0Path}.`);
    }
    if (mcpWired || instrWired) {
      const parts: string[] = [];
      if (instrWired) parts.push('L0');
      if (mcpWired) parts.push('MCP');
      wiredEngines.push(`${engineName} (${parts.join('+')})`);
    }
  }

  if (mismatchedEngines.length > 0) {
    wiringStatus = 'WARN';
    wiringHint = 'Run "faber-memory init" to update engine pointers to the current compiled MEMORY.md path.';
  } else if (wiredEngines.length === 0) {
    wiringStatus = 'WARN';
    wiringDetails.push('No AI coding engine appears wired for faber-memory.');
    wiringHint = 'Run "faber-memory init" to wire Claude Code, Antigravity, Claude Desktop, or Cursor.';
  } else {
    wiringDetails.push(`Wired engines: ${wiredEngines.join(', ')}.`);
  }

  checks.push({
    id: 'engine-wiring',
    name: 'Engine wiring',
    status: wiringStatus,
    details: wiringDetails,
    ...(wiringHint ? { hint: wiringHint } : {}),
  });

  // 5. Pre-memory queue health (strictly read-only: uses listAllProposals, never deletes files)
  const queueDetails: string[] = [];
  let queueStatus: DoctorStatus = 'PASS';
  let queueHint: string | undefined;

  const rawProposals = listAllProposals(homeDir);
  const activeProposals = rawProposals.filter((p) => {
    if (p.status === 'awaiting_commit' && p.projectRootPath && p.targetFilePath) {
      const committed = readHeadFile(p.projectRootPath, p.targetFilePath);
      if (committed !== null) return false;
    }
    return true;
  });

  const staleDays = config?.staleDays ?? 14;
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  let staleCount = 0;
  let pushFailedCount = 0;
  let awaitingCommitCount = 0;

  for (const p of activeProposals) {
    const createdMs = Date.parse(p.createdAt);
    if (Number.isFinite(createdMs) && nowMs - createdMs > staleMs) {
      staleCount++;
    }
    if (p.status === 'push_failed') pushFailedCount++;
    if (p.status === 'awaiting_commit') awaitingCommitCount++;
  }

  if (staleCount > 0) {
    queueStatus = 'WARN';
    queueDetails.push(`${staleCount} stale proposal(s) older than ${staleDays} days.`);
  }
  if (pushFailedCount > 0) {
    queueStatus = 'WARN';
    queueDetails.push(`${pushFailedCount} team proposal(s) in push_failed state.`);
  }
  if (awaitingCommitCount > 0) {
    queueStatus = 'WARN';
    queueDetails.push(`${awaitingCommitCount} project proposal(s) awaiting git commit.`);
  }

  if (queueStatus === 'WARN') {
    queueHint = 'Run "faber-memory status" and "faber-memory review" to resolve queued proposals.';
  } else {
    queueDetails.push(`Pre-memory queue healthy (${activeProposals.length} pending proposal(s)).`);
  }

  checks.push({
    id: 'pre-memory-queue',
    name: 'Pre-memory queue',
    status: queueStatus,
    details: queueDetails,
    ...(queueHint ? { hint: queueHint } : {}),
  });

  // 6. Cache stability check
  const stabilityDetails: string[] = [];
  let stabilityStatus: DoctorStatus = 'PASS';
  let stabilityHint: string | undefined;

  const metrics = readMetrics(homeDir);
  if (!metrics.exists) {
    stabilityDetails.push('No metrics.jsonl ledger yet; skipping L0 churn check.');
  } else {
    const sevenDayCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    const recentChanges = metrics.events.filter(
      (e): e is CompileMetricEvent =>
        e.type === 'compile' && e.changed && Date.parse(e.ts) >= sevenDayCutoffMs,
    ).length;
    if (recentChanges > L0_CHURN_WARN_THRESHOLD) {
      stabilityStatus = 'WARN';
      stabilityDetails.push(
        `Frequent L0 hash changes detected: ${recentChanges} changes in the last 7 days (threshold: ${L0_CHURN_WARN_THRESHOLD}).`,
      );
      stabilityHint = 'Batch memory approvals at session end to preserve LLM prompt-cache reuse.';
    } else {
      stabilityDetails.push(`L0 stability OK (${recentChanges} hash change(s) in the last 7 days).`);
    }
  }

  checks.push({
    id: 'cache-stability',
    name: 'Cache stability',
    status: stabilityStatus,
    details: stabilityDetails,
    ...(stabilityHint ? { hint: stabilityHint } : {}),
  });

  const hasFail = checks.some((ch) => ch.status === 'FAIL');
  const hasWarn = checks.some((ch) => ch.status === 'WARN');
  const overall: DoctorStatus = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
  const exitCode = hasFail || (strict && hasWarn) ? 1 : 0;

  return {
    schemaVersion: 1,
    strict,
    overall,
    exitCode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(c.bold('FaberSEP Memory Doctor (read-only)'));
  lines.push(c.dim(hr('─', 64)));

  for (const ch of report.checks) {
    const badge =
      ch.status === 'PASS'
        ? c.green('[PASS]')
        : ch.status === 'WARN'
          ? c.yellow('[WARN]')
          : c.red('[FAIL]');
    lines.push(`${badge} ${c.bold(ch.name)}`);
    for (const d of ch.details) {
      lines.push(`  ${d}`);
    }
    if (ch.hint) {
      lines.push(c.cyan(`  Hint: ${ch.hint}`));
    }
  }

  lines.push(c.dim(hr('─', 64)));
  const passCount = report.checks.filter((ch) => ch.status === 'PASS').length;
  const warnCount = report.checks.filter((ch) => ch.status === 'WARN').length;
  const failCount = report.checks.filter((ch) => ch.status === 'FAIL').length;
  lines.push(
    `Summary: ${c.green(`${passCount} PASS`)} | ${c.yellow(`${warnCount} WARN`)} | ${c.red(`${failCount} FAIL`)}${report.strict ? ' (strict mode)' : ''}`,
  );
  return lines.join('\n');
}
