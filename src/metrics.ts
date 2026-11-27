import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHomeDir, getStateDir } from './config.js';
import { ProposalAction, Scope } from './types.js';

export type CompileTrigger = 'cli' | 'sync' | 'mcp-startup' | 'approve' | 'init';

export type ProposeSource = 'mcp' | 'import';

export type ProposeOutcome =
  | 'staged'
  | 'duplicate_blocked'
  | 'hygiene_blocked'
  | 'validation_error';

export type ReviewOutcome =
  | 'approved_committed'
  | 'approved_pushed'
  | 'approved_pr'
  | 'push_failed'
  | 'awaiting_commit'
  | 'rejected';

export interface CompileMetricEvent {
  type: 'compile';
  ts: string;
  trigger: CompileTrigger;
  initial: boolean;
  changed: boolean;
  l0_sha256: string;
  l0_tokens: number;
  corpus_tokens: number;
  active_entries: number;
}

export interface SearchMetricEvent {
  type: 'search';
  ts: string;
  scope?: Scope;
  result_count: number;
  zero_result: boolean;
  empty_query: boolean;
  latency_ms: number;
}

export interface GetMetricEvent {
  type: 'get';
  ts: string;
  found_ids: string[];
  ids_truncated?: boolean;
  found_count: number;
  not_found_count: number;
  latency_ms: number;
}

export interface ProposeMetricEvent {
  type: 'propose';
  ts: string;
  source: ProposeSource;
  scope: Scope;
  action: ProposalAction;
  outcome: ProposeOutcome;
  hygiene_category?: 'secret' | 'machine-path';
}

export interface ReviewOutcomeMetricEvent {
  type: 'review_outcome';
  ts: string;
  scope: Scope;
  outcome: ReviewOutcome;
}

export type MetricEvent =
  | CompileMetricEvent
  | SearchMetricEvent
  | GetMetricEvent
  | ProposeMetricEvent
  | ReviewOutcomeMetricEvent;

export const MAX_METRIC_LINE_BYTES = 4096;
export const MAX_GET_FOUND_IDS = 50;
export const METRICS_RETENTION_DAYS = 90;
export const METRICS_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const METRICS_TRIM_TARGET_BYTES = 8 * 1024 * 1024; // 8 MB
export const METRICS_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getMetricsPath(homeDir = getHomeDir()): string {
  return path.join(getStateDir(homeDir), 'metrics.jsonl');
}

export function getMetricsPrunedPath(homeDir = getHomeDir()): string {
  return path.join(getStateDir(homeDir), 'metrics.pruned');
}

export function getMetricsLockPath(homeDir = getHomeDir()): string {
  return path.join(getStateDir(homeDir), 'metrics.lock');
}

function serializeBoundedEvent(event: MetricEvent): string | null {
  let line = JSON.stringify(event) + '\n';
  if (Buffer.byteLength(line, 'utf8') <= MAX_METRIC_LINE_BYTES) {
    return line;
  }

  if (event.type === 'get' && event.found_ids.length > 0) {
    const trimmedIds = [...event.found_ids];
    while (trimmedIds.length > 0) {
      trimmedIds.pop();
      const candidate: GetMetricEvent = {
        ...event,
        found_ids: trimmedIds,
        ids_truncated: true,
      };
      line = JSON.stringify(candidate) + '\n';
      if (Buffer.byteLength(line, 'utf8') <= MAX_METRIC_LINE_BYTES) {
        return line;
      }
    }
  }

  return null;
}

export function appendMetric(event: MetricEvent, homeDir = getHomeDir()): void {
  try {
    const stateDir = getStateDir(homeDir);
    fs.mkdirSync(stateDir, { recursive: true });
    const line = serializeBoundedEvent(event);
    if (!line) return;
    const metricsPath = getMetricsPath(homeDir);
    fs.appendFileSync(metricsPath, line, 'utf8');
    maybePruneMetrics(homeDir);
  } catch {
    // Non-blocking fault tolerance: never fail MCP tool calls or CLI commands.
  }
}

export function maybePruneMetrics(
  homeDir = getHomeDir(),
  options: {
    nowMs?: number;
    maxBytes?: number;
    trimTargetBytes?: number;
    retentionDays?: number;
  } = {},
): boolean {
  try {
    const metricsPath = getMetricsPath(homeDir);
    if (!fs.existsSync(metricsPath)) return false;

    const nowMs = options.nowMs ?? Date.now();
    const maxBytes = options.maxBytes ?? METRICS_MAX_BYTES;
    const trimTargetBytes = options.trimTargetBytes ?? METRICS_TRIM_TARGET_BYTES;
    const retentionDays = options.retentionDays ?? METRICS_RETENTION_DAYS;

    const stat = fs.statSync(metricsPath);
    const oversized = stat.size > maxBytes;

    const prunedMarkerPath = getMetricsPrunedPath(homeDir);
    let pruneIntervalElapsed = true;
    if (fs.existsSync(prunedMarkerPath)) {
      try {
        const markerStat = fs.statSync(prunedMarkerPath);
        pruneIntervalElapsed = nowMs - markerStat.mtimeMs >= METRICS_PRUNE_INTERVAL_MS;
      } catch {
        pruneIntervalElapsed = true;
      }
    }

    if (!oversized && !pruneIntervalElapsed) {
      return false;
    }

    const lockDir = getMetricsLockPath(homeDir);
    try {
      // Single non-blocking attempt; if busy, skip pruning for this call.
      fs.mkdirSync(lockDir);
    } catch {
      return false;
    }

    try {
      const raw = fs.readFileSync(metricsPath, 'utf8');
      const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
      const lines = raw.split('\n');
      const keptLines: string[] = [];

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { ts?: unknown; type?: unknown };
          if (typeof parsed.ts !== 'string' || typeof parsed.type !== 'string') continue;
          const tsMs = Date.parse(parsed.ts);
          if (!Number.isFinite(tsMs)) continue;
          if (tsMs < cutoffMs) continue;
          keptLines.push(trimmed);
        } catch {
          // Drop malformed lines during pruning.
        }
      }

      // If still exceeding maxBytes, trim oldest records down to trimTargetBytes.
      const lineBytes = keptLines.map((l) => Buffer.byteLength(l, 'utf8') + 1);
      let totalBytes = lineBytes.reduce((sum, n) => sum + n, 0);
      let startIdx = 0;
      if (totalBytes > maxBytes) {
        while (startIdx < keptLines.length && totalBytes > trimTargetBytes) {
          totalBytes -= lineBytes[startIdx];
          startIdx++;
        }
      }

      const finalContent =
        startIdx < keptLines.length ? keptLines.slice(startIdx).join('\n') + '\n' : '';
      const tmpPath = `${metricsPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmpPath, finalContent, 'utf8');
      fs.renameSync(tmpPath, metricsPath);

      fs.writeFileSync(prunedMarkerPath, new Date(nowMs).toISOString() + '\n', 'utf8');
      return true;
    } finally {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch {
    return false;
  }
}

export interface ReadMetricsResult {
  exists: boolean;
  events: MetricEvent[];
  skippedLines: number;
}

export function readMetrics(homeDir = getHomeDir()): ReadMetricsResult {
  const metricsPath = getMetricsPath(homeDir);
  if (!fs.existsSync(metricsPath)) {
    return { exists: false, events: [], skippedLines: 0 };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(metricsPath, 'utf8');
  } catch {
    return { exists: true, events: [], skippedLines: 0 };
  }

  const events: MetricEvent[] = [];
  let skippedLines = 0;

  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<MetricEvent>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.type !== 'string' ||
        typeof parsed.ts !== 'string' ||
        !Number.isFinite(Date.parse(parsed.ts))
      ) {
        skippedLines++;
        continue;
      }
      events.push(parsed as MetricEvent);
    } catch {
      skippedLines++;
    }
  }

  return { exists: true, events, skippedLines };
}
