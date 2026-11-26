import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_STALE_DAYS,
  DEFAULT_TOKEN_BUDGET,
  UserConfig,
} from './types.js';

export function getHomeDir(): string {
  return process.env.FABER_MEMORY_HOME || path.join(os.homedir(), '.config', 'faber-memory');
}

export function getConfigPath(homeDir = getHomeDir()): string {
  return path.join(homeDir, 'config.json');
}

export function getStateDir(homeDir = getHomeDir()): string {
  return path.join(homeDir, 'state');
}

export function getCompiledL0Path(homeDir = getHomeDir()): string {
  return path.join(getStateDir(homeDir), 'MEMORY.md');
}

export function getPreMemoryRootDir(rootUuid: string, homeDir = getHomeDir()): string {
  return path.join(getStateDir(homeDir), 'pre-memory', rootUuid);
}

export function getAllPreMemoryBaseDir(homeDir = getHomeDir()): string {
  return path.join(getStateDir(homeDir), 'pre-memory');
}

export function getDefaultPersonalPath(): string {
  return path.join(os.homedir(), '.faber', 'memory');
}

export function getProjectRootUuid(projectRootPath: string): string {
  const normalized = path.resolve(projectRootPath);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `proj-${hash}`;
}

export function sanitizeUserTag(raw?: string): string {
  const source = raw || safeUsername();
  const cleaned = source.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return cleaned || 'dev';
}

function safeUsername(): string {
  try {
    return os.userInfo().username || 'dev';
  } catch {
    return process.env.USER || process.env.USERNAME || 'dev';
  }
}

export function defaultConfig(): UserConfig {
  return {
    version: 1,
    userTag: sanitizeUserTag(),
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    staleDays: DEFAULT_STALE_DAYS,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    roots: {},
  };
}

export function loadConfig(homeDir = getHomeDir()): UserConfig {
  const cfgPath = getConfigPath(homeDir);
  if (!fs.existsSync(cfgPath)) {
    return defaultConfig();
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<UserConfig>;
  return {
    version: 1,
    userTag: raw.userTag || sanitizeUserTag(),
    tokenBudget: typeof raw.tokenBudget === 'number' ? raw.tokenBudget : DEFAULT_TOKEN_BUDGET,
    staleDays: typeof raw.staleDays === 'number' ? raw.staleDays : DEFAULT_STALE_DAYS,
    similarityThreshold:
      typeof raw.similarityThreshold === 'number'
        ? raw.similarityThreshold
        : DEFAULT_SIMILARITY_THRESHOLD,
    roots: raw.roots || {},
  };
}

export function saveConfig(config: UserConfig, homeDir = getHomeDir()): void {
  fs.mkdirSync(homeDir, { recursive: true });
  const cfgPath = getConfigPath(homeDir);
  const tmpPath = `${cfgPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, cfgPath);
}

export function generateUuid(): string {
  return crypto.randomUUID();
}

export function generateProposalId(userTag: string): string {
  const tag = sanitizeUserTag(userTag);
  const suffix = crypto.randomBytes(2).toString('hex');
  return `p-${tag}-${suffix}`;
}

/**
 * Per-state-directory advisory lock using atomic mkdir with bounded retry.
 * Ensures concurrent compile/approve calls never interleave writes.
 */
export function withStateLock<T>(fn: () => T, homeDir = getHomeDir(), timeoutMs = 10000): T {
  const stateDir = getStateDir(homeDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockDir = path.join(stateDir, '.state.lock');
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), 'utf8');
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Clear stale locks older than 30s
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 30000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock at ${lockDir}`);
      }
      sleepSync(15 + Math.floor(Math.random() * 25));
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}
