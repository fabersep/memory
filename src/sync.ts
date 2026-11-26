import { getHomeDir } from './config.js';
import { compileGlobalL0 } from './compiler.js';
import { getHeadSha, gitPullFfOnly, hasRemote } from './git.js';
import { UserConfig } from './types.js';

export interface SyncResult {
  ok: boolean;
  advanced: boolean;
  warnings: string[];
  errors: string[];
  recompiled: boolean;
}

export async function syncAllRoots(
  config: UserConfig,
  options: {
    homeDir?: string;
    timeoutMs?: number;
    recompile?: boolean;
  } = {},
): Promise<SyncResult> {
  const homeDir = options.homeDir || getHomeDir();
  const timeoutMs = options.timeoutMs ?? 5000;
  const shouldRecompile = options.recompile !== false;
  const warnings: string[] = [];
  const errors: string[] = [];
  let advanced = false;

  const roots = [config.roots.team, config.roots.personal].filter(Boolean);

  for (const root of roots) {
    if (!root) continue;
    if (!hasRemote(root.path)) continue;

    const beforeSha = getHeadSha(root.path);
    const pull = await gitPullFfOnly(root.path, timeoutMs);
    if (!pull.ok) {
      const msg = `[${root.scope}] ${pull.error || 'pull failed'}`;
      errors.push(msg);
      warnings.push(msg);
      continue;
    }
    const afterSha = getHeadSha(root.path);
    if (beforeSha !== afterSha) {
      advanced = true;
    }
  }

  let recompiled = false;
  if (shouldRecompile && errors.length === 0) {
    const comp = compileGlobalL0(config, { homeDir });
    if (comp.ok) {
      recompiled = true;
    } else {
      errors.push(...comp.errors);
    }
  }

  return {
    ok: errors.length === 0,
    advanced,
    warnings,
    errors,
    recompiled,
  };
}
