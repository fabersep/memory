import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCacheLogs, CacheAnalysisResult, CacheEngineOption } from './cache-logs.js';
import { estimateCorpusTokens, estimateTokens, renderGlobalL0 } from './compiler.js';
import { getCompiledL0Path, getConfigPath, getHomeDir, loadConfig } from './config.js';
import { MCP_TOOLS } from './mcp.js';
import {
  CompileMetricEvent,
  GetMetricEvent,
  ProposeMetricEvent,
  readMetrics,
  ReviewOutcomeMetricEvent,
  SearchMetricEvent,
} from './metrics.js';
import { loadScopeFromHead, PROJECT_MEMORY_REL_DIR, resolveProjectRoot } from './store.js';
import { c, hr } from './ui.js';

export const STATS_SCHEMA_VERSION = 1;
export const MCP_SCHEMA_TOKEN_TARGET = 500;
export const STALE_VERIFIED_DAYS = 90;
export const L0_CHURN_WARN_THRESHOLD = 5;

export function getPackageVersion(): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.trim()) {
      return raw.version.trim();
    }
  } catch {
    // Fallback below
  }
  return '0.2.0';
}

export function validateDaysArg(raw: unknown): { ok: true; days: number } | { ok: false; error: string } {
  if (raw === undefined || raw === false) {
    return { ok: true, days: 30 };
  }
  if (raw === true || typeof raw !== 'string') {
    return { ok: false, error: '--days must be an integer between 1 and 90.' };
  }
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: `--days must be an integer between 1 and 90 (got "${raw}").` };
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
    return { ok: false, error: `--days must be an integer between 1 and 90 (got ${parsed}).` };
  }
  return { ok: true, days: parsed };
}

export interface StatsReport {
  schemaVersion: number;
  packageVersion: string;
  configured: boolean;
  windowDays: number;
  ledger: {
    exists: boolean;
    coverageDays: number;
    totalEvents: number;
    windowEvents: number;
    skippedLines: number;
  };
  corpus: {
    activeEntries: number;
    l0Entries: number;
    corpusTokens: number;
    l0Tokens: number;
    tokenBudget: number;
    reductionPct: number;
    budgetUtilizationPct: number;
    projectActiveEntries?: number;
    projectTokens?: number;
  };
  mcpSchema: {
    tokens: number;
    target: number;
    toolCount: number;
  };
  l0Stability: {
    changesLast7Days: number;
    changesInWindow: number;
    churnWarning: boolean;
  };
  retrieval: {
    nonEmptySearches: number;
    emptySearches: number;
    getCalls: number;
    getCallsPerSearch: number;
    zeroResultCount: number;
    zeroResultPct: number;
    medianBm25LatencyMs: number | null;
  };
  entryTemperature: {
    hotEntries: { id: string; hits: number }[];
    coldWithheld: boolean;
    coldWithheldReason?: string;
    coldL0Entries: string[];
    staleL0Entries: { id: string; lastVerified: string; ageDays: number }[];
    unverifiedL0Entries: string[];
  };
  funnel: {
    bySource: {
      mcp: {
        staged: number;
        duplicateBlocked: number;
        hygieneBlockedSecret: number;
        hygieneBlockedMachinePath: number;
        validationError: number;
      };
      import: {
        staged: number;
        duplicateBlocked: number;
        hygieneBlockedSecret: number;
        hygieneBlockedMachinePath: number;
        validationError: number;
      };
    };
    reviewOutcomes: {
      approvedCommitted: number;
      approvedPushed: number;
      approvedPr: number;
      pushFailed: number;
      awaitingCommit: number;
      rejected: number;
    };
  };
  cache?: CacheAnalysisResult;
}

export interface ShareableBenchmarkJson {
  schemaVersion: number;
  packageVersion: string;
  windowDays: number;
  corpus: {
    activeEntries: number;
    l0Entries: number;
    corpusTokens: number;
    l0Tokens: number;
    tokenBudget: number;
    reductionPct: number;
    budgetUtilizationPct: number;
  };
  mcpSchemaTokens: number;
  l0Stability: {
    changesLast7Days: number;
    changesInWindow: number;
  };
  retrieval: {
    nonEmptySearches: number;
    getCalls: number;
    getCallsPerSearch: number;
    zeroResultCount: number;
    zeroResultPct: number;
    medianBm25LatencyMs: number | null;
  };
  funnel: {
    proposedMcp: number;
    proposedImport: number;
    staged: number;
    duplicateBlocked: number;
    hygieneBlockedSecret: number;
    hygieneBlockedMachinePath: number;
    validationError: number;
    approvedCommitted: number;
    approvedPushed: number;
    approvedPr: number;
    pushFailed: number;
    awaitingCommit: number;
    rejected: number;
  };
  cache?: Partial<
    Record<
      'claude-code' | 'antigravity',
      {
        sessions: number;
        steps: number;
        firstStepHitPct: number;
        warmStepHitPct: number;
        eligibleSessions?: number;
        correlatedBreaks?: number;
      }
    >
  >;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeStats(options: {
  days?: number;
  includeCache?: boolean;
  engine?: CacheEngineOption;
  logDir?: string;
  homeDir?: string;
  userHome?: string;
  cwd?: string;
  nowMs?: number;
} = {}): StatsReport {
  const homeDir = options.homeDir || getHomeDir();
  const cwd = options.cwd || process.cwd();
  const days = options.days ?? 30;
  const nowMs = options.nowMs ?? Date.now();
  const packageVersion = getPackageVersion();
  const mcpSchemaTokens = estimateTokens(JSON.stringify(MCP_TOOLS));

  const emptySource = () => ({
    staged: 0,
    duplicateBlocked: 0,
    hygieneBlockedSecret: 0,
    hygieneBlockedMachinePath: 0,
    validationError: 0,
  });

  if (!fs.existsSync(getConfigPath(homeDir))) {
    return {
      schemaVersion: STATS_SCHEMA_VERSION,
      packageVersion,
      configured: false,
      windowDays: days,
      ledger: { exists: false, coverageDays: 0, totalEvents: 0, windowEvents: 0, skippedLines: 0 },
      corpus: {
        activeEntries: 0,
        l0Entries: 0,
        corpusTokens: 0,
        l0Tokens: 0,
        tokenBudget: 1500,
        reductionPct: 0,
        budgetUtilizationPct: 0,
      },
      mcpSchema: {
        tokens: mcpSchemaTokens,
        target: MCP_SCHEMA_TOKEN_TARGET,
        toolCount: MCP_TOOLS.length,
      },
      l0Stability: { changesLast7Days: 0, changesInWindow: 0, churnWarning: false },
      retrieval: {
        nonEmptySearches: 0,
        emptySearches: 0,
        getCalls: 0,
        getCallsPerSearch: 0,
        zeroResultCount: 0,
        zeroResultPct: 0,
        medianBm25LatencyMs: null,
      },
      entryTemperature: {
        hotEntries: [],
        coldWithheld: true,
        coldWithheldReason: 'No configuration found.',
        coldL0Entries: [],
        staleL0Entries: [],
        unverifiedL0Entries: [],
      },
      funnel: {
        bySource: { mcp: emptySource(), import: emptySource() },
        reviewOutcomes: {
          approvedCommitted: 0,
          approvedPushed: 0,
          approvedPr: 0,
          pushFailed: 0,
          awaitingCommit: 0,
          rejected: 0,
        },
      },
    };
  }

  const config = loadConfig(homeDir);
  const teamScope = config.roots.team
    ? loadScopeFromHead(config.roots.team.path, 'team')
    : undefined;
  const personalScope = config.roots.personal
    ? loadScopeFromHead(config.roots.personal.path, 'personal')
    : undefined;

  const activeGlobalEntries = [
    ...(teamScope?.entries || []),
    ...(personalScope?.entries || []),
  ].filter((e) => e.status === 'active');

  const activeL0Entries = activeGlobalEntries.filter(
    (e) => e.l0 === 'line' || e.l0 === 'body',
  );

  const corpusTokens = estimateCorpusTokens(activeGlobalEntries);
  const compiledL0Path = getCompiledL0Path(homeDir);
  const l0Text = fs.existsSync(compiledL0Path)
    ? fs.readFileSync(compiledL0Path, 'utf8')
    : renderGlobalL0(teamScope?.entries || [], personalScope?.entries || []);
  const l0Tokens = estimateTokens(l0Text);
  const reductionPct = corpusTokens > 0 ? round1((1 - l0Tokens / corpusTokens) * 100) : 0;
  const budgetUtilizationPct =
    config.tokenBudget > 0 ? round1((l0Tokens / config.tokenBudget) * 100) : 0;

  // Separate informational project scope tokens (excluded from L0 reduction ratio)
  let projectActiveEntries: number | undefined;
  let projectTokens: number | undefined;
  const projRes = resolveProjectRoot(undefined, cwd);
  if (projRes.source !== 'none' && projRes.projectRoot) {
    const projScope = loadScopeFromHead(projRes.projectRoot, 'project', PROJECT_MEMORY_REL_DIR);
    const projActive = projScope.entries.filter((e) => e.status === 'active');
    if (projActive.length > 0) {
      projectActiveEntries = projActive.length;
      projectTokens = estimateCorpusTokens(projActive);
    }
  }

  // Read metrics ledger
  const metrics = readMetrics(homeDir);
  const windowCutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  const sevenDayCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000;

  let oldestTsMs = Infinity;
  for (const ev of metrics.events) {
    const t = Date.parse(ev.ts);
    if (Number.isFinite(t) && t < oldestTsMs) oldestTsMs = t;
  }
  const coverageDays =
    Number.isFinite(oldestTsMs) && nowMs >= oldestTsMs
      ? Math.floor((nowMs - oldestTsMs) / (24 * 60 * 60 * 1000))
      : 0;

  const windowEvents = metrics.events.filter((ev) => Date.parse(ev.ts) >= windowCutoffMs);

  const compileEventsAll = metrics.events.filter(
    (e): e is CompileMetricEvent => e.type === 'compile',
  );
  const changesLast7Days = compileEventsAll.filter(
    (e) => e.changed && Date.parse(e.ts) >= sevenDayCutoffMs,
  ).length;
  const changesInWindow = compileEventsAll.filter(
    (e) => e.changed && Date.parse(e.ts) >= windowCutoffMs,
  ).length;
  const churnWarning = changesLast7Days > L0_CHURN_WARN_THRESHOLD;

  // Retrieval quality
  const searchEvents = windowEvents.filter((e): e is SearchMetricEvent => e.type === 'search');
  const getEvents = windowEvents.filter((e): e is GetMetricEvent => e.type === 'get');

  const nonEmptySearches = searchEvents.filter((e) => !e.empty_query);
  const emptySearches = searchEvents.filter((e) => e.empty_query).length;
  const nonEmptySearchCount = nonEmptySearches.length;
  const getCallCount = getEvents.length;
  const getCallsPerSearch =
    nonEmptySearchCount > 0 ? round2(getCallCount / nonEmptySearchCount) : 0;
  const zeroResultCount = nonEmptySearches.filter((e) => e.zero_result).length;
  const zeroResultPct =
    nonEmptySearchCount > 0 ? round1((zeroResultCount / nonEmptySearchCount) * 100) : 0;

  let medianBm25LatencyMs: number | null = null;
  if (nonEmptySearches.length > 0) {
    const sorted = nonEmptySearches.map((e) => e.latency_ms).sort((a, b) => a - b);
    // Lower-middle element for even counts (FR-03, AC-10)
    medianBm25LatencyMs = sorted[Math.floor((sorted.length - 1) / 2)];
  }

  // Entry temperature
  const hitCounts = new Map<string, number>();
  for (const ge of getEvents) {
    for (const foundId of ge.found_ids || []) {
      hitCounts.set(foundId, (hitCounts.get(foundId) || 0) + 1);
    }
  }

  const hotEntries = [...hitCounts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 10)
    .map(([id, hits]) => ({ id, hits }));

  const minRequiredCoverage = Math.max(days, 7);
  const coldWithheld =
    !metrics.exists || metrics.events.length === 0 || coverageDays < minRequiredCoverage;
  const coldWithheldReason = coldWithheld
    ? !metrics.exists || metrics.events.length === 0
      ? 'No runtime metrics recorded yet.'
      : `Ledger covers ${coverageDays}d (< ${minRequiredCoverage}d required for reliable cold-entry detection).`
    : undefined;

  const coldL0Entries: string[] = coldWithheld
    ? []
    : activeL0Entries
        .map((e) => `${e.scope}:${e.id}`)
        .filter((key) => !hitCounts.has(key))
        .sort();

  const staleL0Entries: { id: string; lastVerified: string; ageDays: number }[] = [];
  const unverifiedL0Entries: string[] = [];

  for (const e of activeL0Entries) {
    const key = `${e.scope}:${e.id}`;
    if (!e.last_verified) {
      unverifiedL0Entries.push(key);
      continue;
    }
    const verifiedMs = Date.parse(e.last_verified);
    if (!Number.isFinite(verifiedMs)) {
      unverifiedL0Entries.push(key);
      continue;
    }
    const ageDays = Math.floor((nowMs - verifiedMs) / (24 * 60 * 60 * 1000));
    if (ageDays > STALE_VERIFIED_DAYS) {
      staleL0Entries.push({ id: key, lastVerified: e.last_verified, ageDays });
    }
  }
  staleL0Entries.sort((a, b) => b.ageDays - a.ageDays || (a.id < b.id ? -1 : 1));
  unverifiedL0Entries.sort();

  // Pre-memory funnel
  const funnel = {
    bySource: {
      mcp: emptySource(),
      import: emptySource(),
    },
    reviewOutcomes: {
      approvedCommitted: 0,
      approvedPushed: 0,
      approvedPr: 0,
      pushFailed: 0,
      awaitingCommit: 0,
      rejected: 0,
    },
  };

  for (const ev of windowEvents) {
    if (ev.type === 'propose') {
      const p = ev as ProposeMetricEvent;
      const bucket = p.source === 'import' ? funnel.bySource.import : funnel.bySource.mcp;
      if (p.outcome === 'staged') bucket.staged++;
      else if (p.outcome === 'duplicate_blocked') bucket.duplicateBlocked++;
      else if (p.outcome === 'validation_error') bucket.validationError++;
      else if (p.outcome === 'hygiene_blocked') {
        if (p.hygiene_category === 'secret') bucket.hygieneBlockedSecret++;
        else bucket.hygieneBlockedMachinePath++;
      }
    } else if (ev.type === 'review_outcome') {
      const r = ev as ReviewOutcomeMetricEvent;
      if (r.outcome === 'approved_committed') funnel.reviewOutcomes.approvedCommitted++;
      else if (r.outcome === 'approved_pushed') funnel.reviewOutcomes.approvedPushed++;
      else if (r.outcome === 'approved_pr') funnel.reviewOutcomes.approvedPr++;
      else if (r.outcome === 'push_failed') funnel.reviewOutcomes.pushFailed++;
      else if (r.outcome === 'awaiting_commit') funnel.reviewOutcomes.awaitingCommit++;
      else if (r.outcome === 'rejected') funnel.reviewOutcomes.rejected++;
    }
  }

  let cache: CacheAnalysisResult | undefined;
  if (options.includeCache) {
    const changedCompiles = compileEventsAll.filter(
      (e) => e.changed && Date.parse(e.ts) >= windowCutoffMs,
    );
    cache = analyzeCacheLogs({
      engine: options.engine,
      logDir: options.logDir,
      days,
      nowMs,
      userHome: options.userHome,
      changedCompiles,
    });
  }

  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    packageVersion,
    configured: true,
    windowDays: days,
    ledger: {
      exists: metrics.exists,
      coverageDays,
      totalEvents: metrics.events.length,
      windowEvents: windowEvents.length,
      skippedLines: metrics.skippedLines,
    },
    corpus: {
      activeEntries: activeGlobalEntries.length,
      l0Entries: activeL0Entries.length,
      corpusTokens,
      l0Tokens,
      tokenBudget: config.tokenBudget,
      reductionPct,
      budgetUtilizationPct,
      ...(projectActiveEntries !== undefined ? { projectActiveEntries, projectTokens } : {}),
    },
    mcpSchema: {
      tokens: mcpSchemaTokens,
      target: MCP_SCHEMA_TOKEN_TARGET,
      toolCount: MCP_TOOLS.length,
    },
    l0Stability: {
      changesLast7Days,
      changesInWindow,
      churnWarning,
    },
    retrieval: {
      nonEmptySearches: nonEmptySearchCount,
      emptySearches,
      getCalls: getCallCount,
      getCallsPerSearch,
      zeroResultCount,
      zeroResultPct,
      medianBm25LatencyMs,
    },
    entryTemperature: {
      hotEntries,
      coldWithheld,
      ...(coldWithheldReason ? { coldWithheldReason } : {}),
      coldL0Entries,
      staleL0Entries,
      unverifiedL0Entries,
    },
    funnel,
    ...(cache ? { cache } : {}),
  };
}

/**
 * Closed allowlist serializer for `faber-memory stats --share`.
 * Never includes paths, repo names, entry IDs, proposal IDs, model names, or summaries.
 */
export function buildShareableBenchmark(report: StatsReport): ShareableBenchmarkJson {
  const mcpSrc = report.funnel.bySource.mcp;
  const impSrc = report.funnel.bySource.import;
  const proposedMcp =
    mcpSrc.staged +
    mcpSrc.duplicateBlocked +
    mcpSrc.hygieneBlockedSecret +
    mcpSrc.hygieneBlockedMachinePath +
    mcpSrc.validationError;
  const proposedImport =
    impSrc.staged +
    impSrc.duplicateBlocked +
    impSrc.hygieneBlockedSecret +
    impSrc.hygieneBlockedMachinePath +
    impSrc.validationError;

  const out: ShareableBenchmarkJson = {
    schemaVersion: report.schemaVersion,
    packageVersion: report.packageVersion,
    windowDays: report.windowDays,
    corpus: {
      activeEntries: report.corpus.activeEntries,
      l0Entries: report.corpus.l0Entries,
      corpusTokens: report.corpus.corpusTokens,
      l0Tokens: report.corpus.l0Tokens,
      tokenBudget: report.corpus.tokenBudget,
      reductionPct: report.corpus.reductionPct,
      budgetUtilizationPct: report.corpus.budgetUtilizationPct,
    },
    mcpSchemaTokens: report.mcpSchema.tokens,
    l0Stability: {
      changesLast7Days: report.l0Stability.changesLast7Days,
      changesInWindow: report.l0Stability.changesInWindow,
    },
    retrieval: {
      nonEmptySearches: report.retrieval.nonEmptySearches,
      getCalls: report.retrieval.getCalls,
      getCallsPerSearch: report.retrieval.getCallsPerSearch,
      zeroResultCount: report.retrieval.zeroResultCount,
      zeroResultPct: report.retrieval.zeroResultPct,
      medianBm25LatencyMs: report.retrieval.medianBm25LatencyMs,
    },
    funnel: {
      proposedMcp,
      proposedImport,
      staged: mcpSrc.staged + impSrc.staged,
      duplicateBlocked: mcpSrc.duplicateBlocked + impSrc.duplicateBlocked,
      hygieneBlockedSecret: mcpSrc.hygieneBlockedSecret + impSrc.hygieneBlockedSecret,
      hygieneBlockedMachinePath:
        mcpSrc.hygieneBlockedMachinePath + impSrc.hygieneBlockedMachinePath,
      validationError: mcpSrc.validationError + impSrc.validationError,
      approvedCommitted: report.funnel.reviewOutcomes.approvedCommitted,
      approvedPushed: report.funnel.reviewOutcomes.approvedPushed,
      approvedPr: report.funnel.reviewOutcomes.approvedPr,
      pushFailed: report.funnel.reviewOutcomes.pushFailed,
      awaitingCommit: report.funnel.reviewOutcomes.awaitingCommit,
      rejected: report.funnel.reviewOutcomes.rejected,
    },
  };

  if (report.cache && report.cache.engines.length > 0) {
    const cacheObj: NonNullable<ShareableBenchmarkJson['cache']> = {};
    for (const eng of report.cache.engines) {
      if (eng.engine !== 'claude-code' && eng.engine !== 'antigravity') continue;
      if (!eng.foundDir || eng.unrecognizedFormat) continue;
      const entry: {
        sessions: number;
        steps: number;
        firstStepHitPct: number;
        warmStepHitPct: number;
        eligibleSessions?: number;
        correlatedBreaks?: number;
      } = {
        sessions: eng.sessions,
        steps: eng.steps,
        firstStepHitPct: eng.firstStepHitPct,
        warmStepHitPct: eng.warmStepHitPct,
      };
      if (eng.engine === 'claude-code' && eng.correlation?.applicable) {
        entry.eligibleSessions = eng.correlation.eligibleSessions;
        entry.correlatedBreaks = eng.correlation.correlatedBreaks;
      }
      cacheObj[eng.engine] = entry;
    }
    if (Object.keys(cacheObj).length > 0) {
      out.cache = cacheObj;
    }
  }

  return out;
}

export function formatShareableMarkdown(card: ShareableBenchmarkJson): string {
  const lines: string[] = [];
  lines.push(`## @fabersep/memory v${card.packageVersion} — Local Benchmark`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| :--- | :--- |');
  lines.push(
    `| Active global entries (L0 included) | ${card.corpus.activeEntries} (${card.corpus.l0Entries} in L0) |`,
  );
  lines.push(
    `| Context efficiency (team + personal) | ${card.corpus.l0Tokens} / ${card.corpus.corpusTokens} tokens (${card.corpus.reductionPct}% reduction) |`,
  );
  lines.push(
    `| L0 budget utilization | ${card.corpus.l0Tokens} / ${card.corpus.tokenBudget} tokens (${card.corpus.budgetUtilizationPct}%) |`,
  );
  lines.push(`| MCP 3-tool schema footprint | ~${card.mcpSchemaTokens} tokens |`);
  lines.push(
    `| L0 hash changes (7d / ${card.windowDays}d) | ${card.l0Stability.changesLast7Days} / ${card.l0Stability.changesInWindow} |`,
  );
  lines.push(
    `| Retrieval (searches / get-per-search / zero-result) | ${card.retrieval.nonEmptySearches} / ${card.retrieval.getCallsPerSearch} / ${card.retrieval.zeroResultPct}% |`,
  );
  lines.push(
    `| Median BM25 search latency | ${card.retrieval.medianBm25LatencyMs !== null ? `${card.retrieval.medianBm25LatencyMs} ms` : 'n/a'} |`,
  );
  lines.push(
    `| Pre-memory funnel (staged / dupes / hygiene) | ${card.funnel.staged} / ${card.funnel.duplicateBlocked} / ${card.funnel.hygieneBlockedSecret + card.funnel.hygieneBlockedMachinePath} |`,
  );

  if (card.cache) {
    for (const engineKey of ['claude-code', 'antigravity'] as const) {
      const eng = card.cache[engineKey];
      if (!eng) continue;
      const corrSuffix =
        engineKey === 'claude-code' && eng.eligibleSessions !== undefined
          ? `, ${eng.correlatedBreaks ?? 0}/${eng.eligibleSessions} L0-correlated breaks`
          : '';
      lines.push(
        `| Prompt cache (${engineKey}) | ${eng.sessions} sessions, ${eng.steps} steps, first-step ${eng.firstStepHitPct}%, warm-step ${eng.warmStepHitPct}%${corrSuffix} |`,
      );
    }
  }

  lines.push('');
  lines.push(
    `_Window: last ${card.windowDays} days. Generated 100% locally with zero telemetry and zero identifiers or paths._`,
  );
  return lines.join('\n');
}

export function formatStatsReport(report: StatsReport): string {
  if (!report.configured) {
    return [
      c.bold('FaberSEP Memory Stats'),
      c.yellow('No configuration found yet. Run `faber-memory setup` to initialize your memory root.'),
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(c.bold(`FaberSEP Memory Stats (window: ${report.windowDays}d, coverage: ${report.ledger.coverageDays}d)`));
  lines.push(c.dim(hr('─', 64)));

  // Context & token efficiency
  lines.push(c.bold('Context & Token Efficiency (team + personal):'));
  lines.push(`  Active global entries: ${report.corpus.activeEntries} (${report.corpus.l0Entries} in L0)`);
  lines.push(`  Full-body corpus tokens: ~${report.corpus.corpusTokens}`);
  lines.push(
    `  Compiled L0 tokens: ~${report.corpus.l0Tokens} (${report.corpus.reductionPct}% reduction)`,
  );
  lines.push(
    `  L0 budget utilization: ${report.corpus.l0Tokens} / ${report.corpus.tokenBudget} (${report.corpus.budgetUtilizationPct}%)`,
  );
  if (report.corpus.projectTokens !== undefined) {
    lines.push(
      `  Active project scope (informational, excluded from L0): ${report.corpus.projectActiveEntries} entries (~${report.corpus.projectTokens} tokens)`,
    );
  }
  lines.push(
    `  MCP 3-tool schema footprint: ~${report.mcpSchema.tokens} tokens (target <= ${report.mcpSchema.target})`,
  );

  // L0 stability
  lines.push('');
  lines.push(c.bold('L0 Stability (non-initial hash changes):'));
  lines.push(
    `  Last 7 days: ${report.l0Stability.changesLast7Days} | Last ${report.windowDays} days: ${report.l0Stability.changesInWindow}`,
  );
  if (report.l0Stability.churnWarning) {
    lines.push(
      c.yellow(
        `  Warning: High L0 cache churn (${report.l0Stability.changesLast7Days} hash changes in 7d > ${L0_CHURN_WARN_THRESHOLD}). Batch approvals at session end to protect prompt-cache reuse.`,
      ),
    );
  }

  // Runtime metrics
  lines.push('');
  lines.push(c.bold('Runtime Retrieval & Governance:'));
  if (!report.ledger.exists || report.ledger.windowEvents === 0) {
    lines.push(
      c.dim('  No runtime usage metrics recorded yet. Metrics will appear after MCP or CLI usage.'),
    );
  } else {
    lines.push(
      `  Non-empty searches: ${report.retrieval.nonEmptySearches} (empty-query listings: ${report.retrieval.emptySearches})`,
    );
    lines.push(
      `  Get calls per search: ${report.retrieval.getCallsPerSearch} (${report.retrieval.getCalls} get calls)`,
    );
    lines.push(
      `  Zero-result searches: ${report.retrieval.zeroResultCount} (${report.retrieval.zeroResultPct}%)`,
    );
    lines.push(
      `  Median BM25 latency: ${report.retrieval.medianBm25LatencyMs !== null ? `${report.retrieval.medianBm25LatencyMs} ms` : 'n/a'}`,
    );
  }

  // Entry temperature
  lines.push('');
  lines.push(c.bold('Entry Temperature:'));
  if (report.entryTemperature.hotEntries.length > 0) {
    lines.push('  Hot entries (top 10 by memory_get hits):');
    for (const h of report.entryTemperature.hotEntries) {
      lines.push(`    - ${h.id}: ${h.hits}`);
    }
  } else {
    lines.push('  Hot entries: none recorded in window.');
  }

  if (report.entryTemperature.coldWithheld) {
    lines.push(
      c.dim(`  Cold L0 entries: withheld (${report.entryTemperature.coldWithheldReason})`),
    );
  } else if (report.entryTemperature.coldL0Entries.length > 0) {
    lines.push(
      `  Cold L0 entries (0 hits in ${report.windowDays}d): ${report.entryTemperature.coldL0Entries.join(', ')}`,
    );
  } else {
    lines.push('  Cold L0 entries: none.');
  }

  if (report.entryTemperature.staleL0Entries.length > 0) {
    lines.push(
      `  Stale L0 entries (last_verified > ${STALE_VERIFIED_DAYS}d): ${report.entryTemperature.staleL0Entries
        .map((s) => `${s.id} (${s.ageDays}d)`)
        .join(', ')}`,
    );
  } else {
    lines.push('  Stale L0 entries: none.');
  }

  if (report.entryTemperature.unverifiedL0Entries.length > 0) {
    lines.push(
      `  Unverified L0 entries (missing last_verified): ${report.entryTemperature.unverifiedL0Entries.join(', ')}`,
    );
  }

  // Pre-memory governance funnel
  lines.push('');
  lines.push(c.bold('Pre-Memory Funnel:'));
  const m = report.funnel.bySource.mcp;
  const imp = report.funnel.bySource.import;
  lines.push(
    `  MCP proposals: staged=${m.staged}, duplicate_blocked=${m.duplicateBlocked}, hygiene_blocked(secret=${m.hygieneBlockedSecret}, machine-path=${m.hygieneBlockedMachinePath}), validation_error=${m.validationError}`,
  );
  lines.push(
    `  Import proposals: staged=${imp.staged}, duplicate_blocked=${imp.duplicateBlocked}, hygiene_blocked(secret=${imp.hygieneBlockedSecret}, machine-path=${imp.hygieneBlockedMachinePath}), validation_error=${imp.validationError}`,
  );
  const ro = report.funnel.reviewOutcomes;
  lines.push(
    `  Review outcomes: approved_committed=${ro.approvedCommitted}, approved_pushed=${ro.approvedPushed}, approved_pr=${ro.approvedPr}, push_failed=${ro.pushFailed}, awaiting_commit=${ro.awaitingCommit}, rejected=${ro.rejected}`,
  );

  // Cache report
  if (report.cache) {
    lines.push('');
    lines.push(c.bold('Prompt-Cache Hit Rate (read-only local logs):'));
    if (report.cache.unsupportedMessage) {
      lines.push(c.yellow(`  ${report.cache.unsupportedMessage}`));
    } else {
      for (const eng of report.cache.engines) {
        lines.push(`  [${eng.engine}]`);
        if (!eng.foundDir) {
          lines.push(c.dim('    No session logs found (log directory missing).'));
          continue;
        }
        if (eng.unrecognizedFormat) {
          lines.push(c.yellow('    unrecognized log format (no recognized token counter fields).'));
          continue;
        }
        if (eng.sessions === 0) {
          lines.push(c.dim('    No matching sessions found in the selected window.'));
        } else {
          lines.push(
            `    Sessions: ${eng.sessions} | Steps: ${eng.steps} (first steps: ${eng.firstSteps}, warm steps <=5m TTL: ${eng.warmSteps}, idle-gap excluded: ${eng.idleGapExcludedSteps})`,
          );
          lines.push(
            `    First-step cache hit: ${eng.firstStepHitPct}% | Warm-step cache hit: ${eng.warmStepHitPct}%`,
          );
          if (eng.byModel.length > 0) {
            lines.push('    By model:');
            for (const bm of eng.byModel) {
              lines.push(
                `      - ${bm.model}: ${bm.sessions} session(s), ${bm.steps} step(s), first-step ${bm.firstStepHitPct}%, warm-step ${bm.warmStepHitPct}%`,
              );
            }
          }
        }
        if (eng.correlation) {
          if (eng.correlation.applicable) {
            lines.push(
              `    L0 cache-break correlation: ${eng.correlation.correlatedBreaks} correlated break(s) out of ${eng.correlation.eligibleSessions} eligible session(s)`,
            );
          } else if (eng.correlation.note) {
            lines.push(c.dim(`    Note: ${eng.correlation.note}`));
          }
        }
        if (eng.skippedLines > 0) {
          lines.push(c.dim(`    Skipped malformed lines: ${eng.skippedLines}`));
        }
      }
    }
  }

  return lines.join('\n');
}
