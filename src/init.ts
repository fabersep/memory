import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCompiledL0Path, getHomeDir } from './config.js';
import { compileGlobalL0 } from './compiler.js';
import { c, hr, shouldUseColor } from './ui.js';
import { UserConfig } from './types.js';

export const BLOCK_START = '<!-- faber-memory:start -->';
export const BLOCK_END = '<!-- faber-memory:end -->';
export const TOOL_GUIDANCE_LINE =
  'Use the faber-memory MCP tools: memory_search and memory_get for the details behind these lines; when you learn a durable rule, decision, lesson or preference, call memory_propose (the user approves it later; never edit memory files directly).';
export const PROJECT_HINT_LINE = 'Project memory: run npx @fabersep/memory init';

export type EngineName = 'claude-code' | 'claude-desktop' | 'antigravity' | 'cursor' | 'codex';

export interface EngineSpec {
  name: EngineName;
  verifiedImport: boolean;
  gap: boolean;
  instructionFile?: (userHome: string) => string;
  mcpConfigFile?: (userHome: string) => string;
  renderBlock?: (compiledL0Path: string) => string;
}

export function getEngineSpecs(): Record<EngineName, EngineSpec> {
  return {
    'claude-code': {
      name: 'claude-code',
      verifiedImport: true,
      gap: false,
      instructionFile: (home) => path.join(home, '.claude', 'CLAUDE.md'),
      mcpConfigFile: (home) => path.join(home, '.claude.json'),
      renderBlock: (l0Path) =>
        `${BLOCK_START}\n@${l0Path}\n${TOOL_GUIDANCE_LINE}\n${BLOCK_END}`,
    },
    'claude-desktop': {
      name: 'claude-desktop',
      verifiedImport: false,
      gap: false,
      mcpConfigFile: (home) =>
        process.platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    },
    antigravity: {
      name: 'antigravity',
      verifiedImport: true,
      gap: false,
      instructionFile: (home) => path.join(home, '.gemini', 'GEMINI.md'),
      mcpConfigFile: (home) => path.join(home, '.gemini', 'config', 'mcp_config.json'),
      renderBlock: (l0Path) =>
        `${BLOCK_START}\nAt session start, read ${l0Path} (global L0 memory).\n${TOOL_GUIDANCE_LINE}\n${BLOCK_END}`,
    },
    cursor: {
      name: 'cursor',
      verifiedImport: false,
      gap: true,
      mcpConfigFile: (home) => path.join(home, '.cursor', 'mcp.json'),
    },
    codex: {
      name: 'codex',
      verifiedImport: false,
      gap: true,
    },
  };
}

export interface FilePlan {
  filePath: string;
  kind: 'instruction' | 'mcp-config';
  engine: EngineName;
  before: string | null;
  after: string;
  changed: boolean;
  backupPath?: string;
}

export interface InitPlanResult {
  plans: FilePlan[];
  backups: string[];
  notes: string[];
  projectHint?: string;
}

export function getUserHome(): string {
  return process.env.FABER_USER_HOME || os.homedir();
}

export function upsertManagedBlock(existing: string, block: string): string {
  const escapedStart = escapeRegex(BLOCK_START);
  const escapedEnd = escapeRegex(BLOCK_END);
  const regex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'g');
  if (regex.test(existing)) {
    let first = true;
    const replaced = existing.replace(regex, () => {
      if (first) {
        first = false;
        return block;
      }
      return '';
    });
    return replaced.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export function removeManagedBlock(existing: string): string {
  const escapedStart = escapeRegex(BLOCK_START);
  const escapedEnd = escapeRegex(BLOCK_END);
  const regex = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  const next = existing.replace(regex, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return next ? `${next}\n` : '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertMcpJson(existingRaw: string | null): string {
  let obj: Record<string, unknown> = {};
  if (existingRaw && existingRaw.trim()) {
    try {
      obj = JSON.parse(existingRaw) as Record<string, unknown>;
    } catch {
      obj = {};
    }
  }
  const servers =
    obj.mcpServers && typeof obj.mcpServers === 'object'
      ? { ...(obj.mcpServers as Record<string, unknown>) }
      : {};
  servers['faber-memory'] = {
    command: 'npx',
    args: ['-y', '@fabersep/memory', 'serve'],
  };
  obj.mcpServers = servers;
  return JSON.stringify(obj, null, 2) + '\n';
}

function removeMcpJson(existingRaw: string): string {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(existingRaw) as Record<string, unknown>;
  } catch {
    return existingRaw;
  }
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    const servers = { ...(obj.mcpServers as Record<string, unknown>) };
    delete servers['faber-memory'];
    obj.mcpServers = servers;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

export function detectTargetEngines(
  userHome: string,
  requested?: EngineName[],
): EngineName[] {
  if (requested && requested.length > 0) return requested;
  const detected: EngineName[] = [];
  if (fs.existsSync(path.join(userHome, '.claude'))) detected.push('claude-code');
  if (fs.existsSync(path.join(userHome, '.gemini'))) detected.push('antigravity');
  if (fs.existsSync(path.join(userHome, '.cursor'))) detected.push('cursor');
  if (detected.length === 0) detected.push('claude-code');
  return detected;
}

export function planOrApplyInit(
  config: UserConfig,
  options: {
    apply?: boolean;
    undo?: boolean;
    engines?: EngineName[];
    projectHint?: boolean;
    homeDir?: string;
    userHome?: string;
  } = {},
): InitPlanResult {
  const homeDir = options.homeDir || getHomeDir();
  const userHome = options.userHome || getUserHome();
  const specs = getEngineSpecs();
  const engines = detectTargetEngines(userHome, options.engines);
  const compiledL0Path = getCompiledL0Path(homeDir);
  const notes: string[] = [];
  const plans: FilePlan[] = [];
  const backups: string[] = [];

  if (options.apply && !options.undo) {
    // Always compile L0 BEFORE writing any user-level pointer (AC-19b1)
    const comp = compileGlobalL0(config, { homeDir, trigger: 'init' });
    if (!comp.ok) {
      throw new Error(`L0 compilation failed before init:\n${comp.errors.join('\n')}`);
    }
  }

  for (const engineName of engines) {
    const spec = specs[engineName];
    if (!spec) continue;

    if (spec.gap) {
      notes.push(
        `Engine "${engineName}" is marked GAP for user-level instruction import; wiring MCP-only delivery.`,
      );
    }

    if (spec.instructionFile && spec.renderBlock && !spec.gap) {
      const filePath = spec.instructionFile(userHome);
      const exists = fs.existsSync(filePath);
      const before = exists ? fs.readFileSync(filePath, 'utf8') : null;
      const after = options.undo
        ? before !== null
          ? removeManagedBlock(before)
          : ''
        : upsertManagedBlock(before || '', spec.renderBlock(compiledL0Path));
      const changed = (before ?? '') !== after;
      const plan: FilePlan = {
        filePath,
        kind: 'instruction',
        engine: engineName,
        before,
        after,
        changed,
      };
      if (options.undo && fs.existsSync(`${filePath}.bak`)) {
        plan.backupPath = `${filePath}.bak`;
        backups.push(`${filePath}.bak`);
      }
      plans.push(plan);
    }

    if (spec.mcpConfigFile) {
      const filePath = spec.mcpConfigFile(userHome);
      const exists = fs.existsSync(filePath);
      const before = exists ? fs.readFileSync(filePath, 'utf8') : null;
      const after = options.undo
        ? before !== null
          ? removeMcpJson(before)
          : ''
        : upsertMcpJson(before);
      const changed = (before ?? '') !== after;
      const plan: FilePlan = {
        filePath,
        kind: 'mcp-config',
        engine: engineName,
        before,
        after,
        changed,
      };
      if (options.undo && fs.existsSync(`${filePath}.bak`)) {
        plan.backupPath = `${filePath}.bak`;
        backups.push(`${filePath}.bak`);
      }
      plans.push(plan);
    }
  }

  if (options.apply || options.undo) {
    for (const p of plans) {
      if (!p.changed) continue;
      if (options.undo && p.before === null) continue;
      fs.mkdirSync(path.dirname(p.filePath), { recursive: true });
      if (!options.undo && p.before !== null) {
        const bakPath = `${p.filePath}.bak`;
        if (!fs.existsSync(bakPath)) {
          fs.writeFileSync(bakPath, p.before, 'utf8');
          p.backupPath = bakPath;
          backups.push(bakPath);
        }
      }
      fs.writeFileSync(p.filePath, p.after, 'utf8');
    }
  }

  return {
    plans,
    backups,
    notes,
    projectHint: options.projectHint ? PROJECT_HINT_LINE : undefined,
  };
}

export function formatUnifiedDiff(plan: FilePlan): string {
  const beforeLines = (plan.before ?? '').split('\n');
  const afterLines = plan.after.split('\n');
  const header = `--- ${plan.filePath} (before)\n+++ ${plan.filePath} (after)`;
  if (!plan.changed) {
    return `${header}\n (no changes)`;
  }
  const out: string[] = [header];
  for (const line of beforeLines) {
    if (line && !afterLines.includes(line)) out.push(`- ${line}`);
  }
  for (const line of afterLines) {
    if (line && !beforeLines.includes(line)) out.push(`+ ${line}`);
  }
  return out.join('\n');
}

export function formatPlanBeforeAfter(plan: FilePlan, useColor = shouldUseColor()): string {
  const lines: string[] = [];
  lines.push(c.dim(hr('═', 64), useColor));
  lines.push(
    `${c.bold(c.cyan(`[${plan.engine}]`, useColor), useColor)} ${c.bold(plan.kind, useColor)} — ${plan.filePath}`,
  );
  lines.push(c.dim(hr('─', 64), useColor));

  if (!plan.changed) {
    lines.push(c.dim('  (no changes)', useColor));
    return lines.join('\n');
  }

  const beforeLines = (plan.before ?? '').split('\n');
  const afterLines = plan.after.split('\n');
  const removed = beforeLines.filter((l) => l && !afterLines.includes(l));
  const added = afterLines.filter((l) => l && !beforeLines.includes(l));

  lines.push(c.bold(c.red('Before:', useColor), useColor));
  if (plan.before === null) {
    lines.push(c.dim('  (file does not exist yet)', useColor));
  } else if (removed.length === 0) {
    lines.push(c.dim('  (existing content kept as-is)', useColor));
  } else {
    for (const l of removed) {
      lines.push(c.red(`  - ${l}`, useColor));
    }
  }

  lines.push('');
  lines.push(c.bold(c.green('After:', useColor), useColor));
  if (added.length === 0) {
    lines.push(c.dim('  (removed faber-memory block/entry; remaining file preserved)', useColor));
  } else {
    for (const l of added) {
      lines.push(c.green(`  + ${l}`, useColor));
    }
  }

  return lines.join('\n');
}
