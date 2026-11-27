import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUserHome } from './init.js';
import { CompileMetricEvent } from './metrics.js';

export type CacheEngineOption = 'claude-code' | 'antigravity' | 'all' | 'cursor' | 'codex' | string;

export const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute default prompt-cache TTL

export interface ModelCacheSummary {
  model: string;
  sessions: number;
  steps: number;
  firstSteps: number;
  warmSteps: number;
  idleGapExcludedSteps: number;
  firstStepHitPct: number;
  warmStepHitPct: number;
}

export interface EngineCacheReport {
  engine: 'claude-code' | 'antigravity';
  foundDir: boolean;
  unrecognizedFormat?: boolean;
  sessions: number;
  steps: number;
  firstSteps: number;
  warmSteps: number;
  idleGapExcludedSteps: number;
  firstStepHitPct: number;
  warmStepHitPct: number;
  skippedLines: number;
  byModel: ModelCacheSummary[];
  correlation?: {
    applicable: boolean;
    note?: string;
    eligibleSessions: number;
    correlatedBreaks: number;
  };
}

export interface CacheAnalysisResult {
  unsupportedEngine?: string;
  unsupportedMessage?: string;
  engines: EngineCacheReport[];
  skippedLines: number;
}

interface ParsedStep {
  tsMs: number;
  model: string;
  cacheRead: number;
  denom: number;
  rawInputTokens: number;
}

interface ParsedSession {
  startTsMs: number;
  endTsMs: number;
  firstTurnCacheRead: number;
  steps: ParsedStep[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function computePct(cacheRead: number, denom: number, clamp100 = false): number {
  if (denom <= 0) return 0;
  const pct = (cacheRead / denom) * 100;
  return round1(clamp100 ? Math.min(100, pct) : pct);
}

function walkFiles(
  rootDir: string,
  predicate: (fileName: string, fullPath: string) => boolean,
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && predicate(entry.name, full)) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

function aggregateSessions(
  engine: 'claude-code' | 'antigravity',
  sessions: ParsedSession[],
  skippedLines: number,
  foundDir: boolean,
  clamp100: boolean,
  unrecognizedFormat = false,
): EngineCacheReport {
  let totalSteps = 0;
  let totalFirstSteps = 0;
  let totalWarmSteps = 0;
  let totalIdleExcluded = 0;
  let firstCacheRead = 0;
  let firstDenom = 0;
  let warmCacheRead = 0;
  let warmDenom = 0;

  const modelStats = new Map<
    string,
    {
      sessionSet: Set<number>;
      steps: number;
      firstSteps: number;
      warmSteps: number;
      idleExcluded: number;
      firstCacheRead: number;
      firstDenom: number;
      warmCacheRead: number;
      warmDenom: number;
    }
  >();

  const getModelBucket = (model: string) => {
    let bucket = modelStats.get(model);
    if (!bucket) {
      bucket = {
        sessionSet: new Set<number>(),
        steps: 0,
        firstSteps: 0,
        warmSteps: 0,
        idleExcluded: 0,
        firstCacheRead: 0,
        firstDenom: 0,
        warmCacheRead: 0,
        warmDenom: 0,
      };
      modelStats.set(model, bucket);
    }
    return bucket;
  };

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const sess = sessions[sIdx];
    for (let i = 0; i < sess.steps.length; i++) {
      const step = sess.steps[i];
      const bucket = getModelBucket(step.model);
      bucket.sessionSet.add(sIdx);
      bucket.steps++;
      totalSteps++;

      if (i === 0) {
        totalFirstSteps++;
        firstCacheRead += step.cacheRead;
        firstDenom += step.denom;
        bucket.firstSteps++;
        bucket.firstCacheRead += step.cacheRead;
        bucket.firstDenom += step.denom;
      } else {
        const prev = sess.steps[i - 1];
        const gapMs = step.tsMs - prev.tsMs;
        if (gapMs <= CACHE_TTL_MS) {
          totalWarmSteps++;
          warmCacheRead += step.cacheRead;
          warmDenom += step.denom;
          bucket.warmSteps++;
          bucket.warmCacheRead += step.cacheRead;
          bucket.warmDenom += step.denom;
        } else {
          totalIdleExcluded++;
          bucket.idleExcluded++;
        }
      }
    }
  }

  const byModel: ModelCacheSummary[] = [...modelStats.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([model, b]) => ({
      model,
      sessions: b.sessionSet.size,
      steps: b.steps,
      firstSteps: b.firstSteps,
      warmSteps: b.warmSteps,
      idleGapExcludedSteps: b.idleExcluded,
      firstStepHitPct: computePct(b.firstCacheRead, b.firstDenom, clamp100),
      warmStepHitPct: computePct(b.warmCacheRead, b.warmDenom, clamp100),
    }));

  return {
    engine,
    foundDir,
    ...(unrecognizedFormat ? { unrecognizedFormat: true } : {}),
    sessions: sessions.length,
    steps: totalSteps,
    firstSteps: totalFirstSteps,
    warmSteps: totalWarmSteps,
    idleGapExcludedSteps: totalIdleExcluded,
    firstStepHitPct: computePct(firstCacheRead, firstDenom, clamp100),
    warmStepHitPct: computePct(warmCacheRead, warmDenom, clamp100),
    skippedLines,
    byModel,
  };
}

function parseClaudeCodeLogs(
  dirs: string[],
  cutoffMs: number,
  changedCompiles: CompileMetricEvent[],
): EngineCacheReport {
  const existingDirs = dirs.filter((d) => fs.existsSync(d));
  if (existingDirs.length === 0) {
    return {
      ...aggregateSessions('claude-code', [], 0, false, false),
      correlation: {
        applicable: true,
        eligibleSessions: 0,
        correlatedBreaks: 0,
      },
    };
  }

  const files: string[] = [];
  for (const dir of existingDirs) {
    files.push(
      ...walkFiles(
        dir,
        (name) =>
          name.endsWith('.jsonl') &&
          name !== 'transcript.jsonl' &&
          name !== 'transcript_full.jsonl',
      ),
    );
  }

  let skippedLines = 0;
  const sessions: ParsedSession[] = [];

  for (const filePath of files) {
    let raw: string;
    let fallbackMs: number;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      fallbackMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }

    // Deduplicate by message ID within each session file (keep last occurrence, preserve order)
    const order: string[] = [];
    const byMsgId = new Map<string, ParsedStep>();
    let anonCounter = 0;

    for (const rawLine of raw.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        skippedLines++;
        continue;
      }

      if (!rec || typeof rec !== 'object') {
        skippedLines++;
        continue;
      }

      // Exclude sidechain records
      if (rec.isSidechain === true) continue;

      const msg =
        rec.message && typeof rec.message === 'object'
          ? (rec.message as Record<string, unknown>)
          : undefined;
      const usage =
        msg?.usage && typeof msg.usage === 'object'
          ? (msg.usage as Record<string, unknown>)
          : rec.usage && typeof rec.usage === 'object'
            ? (rec.usage as Record<string, unknown>)
            : undefined;
      if (!usage) continue;

      const hasInput = typeof usage.input_tokens === 'number';
      const hasCacheRead = typeof usage.cache_read_input_tokens === 'number';
      const hasCacheCreate = typeof usage.cache_creation_input_tokens === 'number';
      if (!hasInput && !hasCacheRead && !hasCacheCreate) continue;

      const tsStr =
        typeof rec.timestamp === 'string'
          ? rec.timestamp
          : typeof rec.created_at === 'string'
            ? rec.created_at
            : undefined;
      const tsMs = tsStr && Number.isFinite(Date.parse(tsStr)) ? Date.parse(tsStr) : fallbackMs;
      if (tsMs < cutoffMs) continue;

      const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const cacheRead =
        typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
      const cacheCreate =
        typeof usage.cache_creation_input_tokens === 'number'
          ? usage.cache_creation_input_tokens
          : 0;
      const denom = input + cacheRead + cacheCreate;

      const model =
        typeof msg?.model === 'string' && msg.model.trim()
          ? msg.model.trim()
          : typeof rec.model === 'string' && rec.model.trim()
            ? rec.model.trim()
            : 'unknown';

      const rawMsgId =
        typeof msg?.id === 'string' && msg.id
          ? msg.id
          : typeof rec.message_id === 'string' && rec.message_id
            ? rec.message_id
            : undefined;
      const key = rawMsgId ? `id:${rawMsgId}` : `anon:${anonCounter++}`;

      if (!byMsgId.has(key)) {
        order.push(key);
      }
      byMsgId.set(key, {
        tsMs,
        model,
        cacheRead,
        denom,
        rawInputTokens: input,
      });
    }

    const steps = order
      .map((k) => byMsgId.get(k)!)
      .sort((a, b) => a.tsMs - b.tsMs);

    if (steps.length > 0) {
      sessions.push({
        startTsMs: steps[0].tsMs,
        endTsMs: steps[steps.length - 1].tsMs,
        firstTurnCacheRead: steps[0].cacheRead,
        steps,
      });
    }
  }

  sessions.sort((a, b) => a.startTsMs - b.startTsMs);

  // L0 cache-break correlation (FR-04, AC-16a)
  let eligibleSessions = 0;
  let correlatedBreaks = 0;

  if (changedCompiles.length > 0 && sessions.length > 1) {
    const sortedCompiles = [...changedCompiles]
      .map((c) => ({ tsMs: Date.parse(c.ts), l0Tokens: c.l0_tokens }))
      .filter((c) => Number.isFinite(c.tsMs))
      .sort((a, b) => a.tsMs - b.tsMs);

    for (let i = 1; i < sessions.length; i++) {
      const curr = sessions[i];
      // Find the latest changed compile T <= curr.startTsMs that falls between a prior session's end and curr.startTsMs
      let matchedCompile: { tsMs: number; l0Tokens: number } | null = null;
      let matchedPrior: ParsedSession | null = null;

      for (let pIdx = i - 1; pIdx >= 0; pIdx--) {
        const prior = sessions[pIdx];
        if (curr.startTsMs - prior.endTsMs > CACHE_TTL_MS) {
          continue;
        }
        // Look for a compile event with prior.endTsMs <= T <= curr.startTsMs
        for (let cIdx = sortedCompiles.length - 1; cIdx >= 0; cIdx--) {
          const comp = sortedCompiles[cIdx];
          if (comp.tsMs >= prior.endTsMs && comp.tsMs <= curr.startTsMs) {
            matchedCompile = comp;
            matchedPrior = prior;
            break;
          }
        }
        if (matchedCompile) break;
      }

      if (matchedCompile && matchedPrior) {
        eligibleSessions++;
        const drop = matchedPrior.firstTurnCacheRead - curr.firstTurnCacheRead;
        if (drop >= matchedCompile.l0Tokens) {
          correlatedBreaks++;
        }
      }
    }
  }

  const report = aggregateSessions('claude-code', sessions, skippedLines, true, false);
  report.correlation = {
    applicable: true,
    eligibleSessions,
    correlatedBreaks,
  };
  return report;
}

function parseAntigravityLogs(dirs: string[], cutoffMs: number): EngineCacheReport {
  const existingDirs = dirs.filter((d) => fs.existsSync(d));
  if (existingDirs.length === 0) {
    return {
      ...aggregateSessions('antigravity', [], 0, false, true),
      correlation: {
        applicable: false,
        note: 'L0 prefix-break correlation applies only to claude-code (Antigravity reads MEMORY.md via a tool call rather than static prompt-prefix injection).',
        eligibleSessions: 0,
        correlatedBreaks: 0,
      },
    };
  }

  const files: string[] = [];
  for (const dir of existingDirs) {
    // Strictly read transcript.jsonl only — never transcript_full.jsonl
    files.push(...walkFiles(dir, (name) => name === 'transcript.jsonl'));
  }

  let skippedLines = 0;
  let plannerRecordsSeen = 0;
  let plannerRecordsWithTokens = 0;
  const sessions: ParsedSession[] = [];

  for (const filePath of files) {
    let raw: string;
    let fallbackMs: number;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      fallbackMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }

    const steps: ParsedStep[] = [];
    for (const rawLine of raw.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        skippedLines++;
        continue;
      }

      if (!rec || typeof rec !== 'object') {
        skippedLines++;
        continue;
      }

      if (rec.type !== 'PLANNER_RESPONSE') continue;
      plannerRecordsSeen++;

      const hasInput = typeof rec.input_tokens === 'number';
      const hasCacheRead = typeof rec.cache_read_tokens === 'number';
      if (!hasInput && !hasCacheRead) continue;
      plannerRecordsWithTokens++;

      const tsStr =
        typeof rec.created_at === 'string'
          ? rec.created_at
          : typeof rec.timestamp === 'string'
            ? rec.timestamp
            : undefined;
      const tsMs = tsStr && Number.isFinite(Date.parse(tsStr)) ? Date.parse(tsStr) : fallbackMs;
      if (tsMs < cutoffMs) continue;

      const input = typeof rec.input_tokens === 'number' ? rec.input_tokens : 0;
      const cacheRead = typeof rec.cache_read_tokens === 'number' ? rec.cache_read_tokens : 0;
      const model =
        typeof rec.model === 'string' && rec.model.trim() ? rec.model.trim() : 'unknown';

      // Antigravity: when cache_read_tokens <= input_tokens, input_tokens is inclusive;
      // when cache_read_tokens > input_tokens (warm turns where input_tokens logs uncached delta only),
      // total input is input_tokens + cache_read_tokens so warm hit % is accurate rather than clamped to 100%.
      const denom = cacheRead > input ? input + cacheRead : input;
      steps.push({
        tsMs,
        model,
        cacheRead,
        denom,
        rawInputTokens: input,
      });
    }

    steps.sort((a, b) => a.tsMs - b.tsMs);
    if (steps.length > 0) {
      sessions.push({
        startTsMs: steps[0].tsMs,
        endTsMs: steps[steps.length - 1].tsMs,
        firstTurnCacheRead: steps[0].cacheRead,
        steps,
      });
    }
  }

  const unrecognizedFormat = plannerRecordsSeen > 0 && plannerRecordsWithTokens === 0;
  const report = aggregateSessions(
    'antigravity',
    sessions,
    skippedLines,
    true,
    true,
    unrecognizedFormat,
  );
  report.correlation = {
    applicable: false,
    note: 'L0 prefix-break correlation applies only to claude-code (Antigravity reads MEMORY.md via a tool call rather than static prompt-prefix injection).',
    eligibleSessions: 0,
    correlatedBreaks: 0,
  };
  return report;
}

export function analyzeCacheLogs(options: {
  engine?: CacheEngineOption;
  logDir?: string;
  days: number;
  nowMs?: number;
  userHome?: string;
  changedCompiles?: CompileMetricEvent[];
}): CacheAnalysisResult {
  const engine = (options.engine || 'all').toLowerCase();
  if (engine === 'cursor' || engine === 'codex') {
    return {
      unsupportedEngine: engine,
      unsupportedMessage: `Engine "${engine}" cache log parsing is not supported in v0.2 (GAP-01: local session log format unverified). Supported engines: claude-code, antigravity, all.`,
      engines: [],
      skippedLines: 0,
    };
  }
  if (engine !== 'claude-code' && engine !== 'antigravity' && engine !== 'all') {
    return {
      unsupportedEngine: engine,
      unsupportedMessage: `Unsupported engine "${engine}" (GAP-01). Supported engines: claude-code, antigravity, all.`,
      engines: [],
      skippedLines: 0,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.days * 24 * 60 * 60 * 1000;
  const userHome = options.userHome || getUserHome();
  const changedCompiles = options.changedCompiles || [];

  const reports: EngineCacheReport[] = [];

  if (engine === 'claude-code' || engine === 'all') {
    const dirs = options.logDir
      ? [options.logDir]
      : [path.join(userHome, '.claude', 'projects')];
    reports.push(parseClaudeCodeLogs(dirs, cutoffMs, changedCompiles));
  }

  if (engine === 'antigravity' || engine === 'all') {
    const dirs = options.logDir
      ? [options.logDir]
      : [
          path.join(userHome, '.gemini', 'antigravity', 'brain'),
          path.join(userHome, '.gemini', 'antigravity-cli', 'brain'),
        ];
    reports.push(parseAntigravityLogs(dirs, cutoffMs));
  }

  const skippedLines = reports.reduce((sum, r) => sum + r.skippedLines, 0);
  return { engines: reports, skippedLines };
}
