import * as fs from 'node:fs';
import * as path from 'node:path';
import { findNearDuplicates } from './bm25.js';
import { getHomeDir } from './config.js';
import { parseMarkdownWithFrontmatter, slugify } from './frontmatter.js';
import { scanHygiene } from './hygiene.js';
import {
  approveProposalsBatch,
  createProposal,
  reconcileAwaitingCommitProposals,
} from './proposals.js';
import { loadAllScopes, resolveProjectRoot } from './store.js';
import { EntryType, Proposal, Scope, UserConfig, VALID_TYPES } from './types.js';

export type ImportSourceType = 'markdown-dir' | 'claude-memory' | 'agents-md' | 'cursor-rules';

export const CLAUDE_DISABLE_AUTOMEMORY_GUIDANCE =
  'To disable Claude Code auto-memory so future writes do not bypass pre-memory, set "autoMemoryEnabled": false in ~/.claude/settings.json (or CLAUDE_CODE_DISABLE_AUTO_MEMORY=1).';

export interface ImportResult {
  staged: Proposal[];
  approvedIds: string[];
  duplicates: { source: string; matchedId: string; summary: string }[];
  skippedHygiene: { source: string; reason: string }[];
  notes: string[];
}

function inferType(raw: Record<string, unknown>, filename: string): EntryType {
  if (typeof raw.type === 'string' && VALID_TYPES.includes(raw.type as EntryType)) {
    return raw.type as EntryType;
  }
  const lower = filename.toLowerCase();
  if (lower.includes('decision')) return 'decision';
  if (lower.includes('lesson') || lower.includes('mistake')) return 'lesson';
  if (lower.includes('pref') || lower.includes('style')) return 'preference';
  if (lower.includes('ref') || lower.includes('catalog')) return 'reference';
  return 'rule';
}

function inferSummary(raw: Record<string, unknown>, body: string, fallbackName: string): string {
  for (const key of ['summary', 'description', 'name', 'title']) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) {
      return val.replace(/\s+/g, ' ').trim();
    }
  }
  const firstHeading = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('#'));
  if (firstHeading) {
    return firstHeading.replace(/^#+\s*/, '').trim();
  }
  const firstLine = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (firstLine || fallbackName).slice(0, 140);
}

function splitTopLevelHeadings(content: string): { title: string; body: string }[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^#{1,2}\s+(.+)$/);
    if (m) {
      if (current && current.lines.join('\n').trim()) {
        sections.push(current);
      }
      current = { title: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current && current.lines.join('\n').trim()) {
    sections.push(current);
  }
  return sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

function collectMarkdownFiles(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  const results: string[] = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const full = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      results.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && /\.(md|mdc)$/i.test(entry.name)) {
      results.push(full);
    }
  }
  return results.sort();
}

export async function runImport(
  config: UserConfig,
  options: {
    from: ImportSourceType;
    sourcePath: string;
    scope?: Scope;
    splitHeadings?: boolean;
    approve?: boolean;
    homeDir?: string;
    cwd?: string;
  },
): Promise<ImportResult> {
  const homeDir = options.homeDir || getHomeDir();
  const targetScope: Scope = options.scope || 'personal';
  const cwd = options.cwd || process.cwd();

  if (options.approve && targetScope !== 'personal') {
    throw new Error('--approve during import is allowed in solo (personal) mode only.');
  }

  const projectRes = resolveProjectRoot(undefined, cwd);
  const loaded = loadAllScopes(config, projectRes);
  const pending = reconcileAwaitingCommitProposals(homeDir);

  const staged: Proposal[] = [];
  const duplicates: { source: string; matchedId: string; summary: string }[] = [];
  const skippedHygiene: { source: string; reason: string }[] = [];
  const notes: string[] = [];

  if (options.from === 'claude-memory') {
    notes.push(CLAUDE_DISABLE_AUTOMEMORY_GUIDANCE);
  }

  const candidates: {
    source: string;
    entryId: string;
    summary: string;
    type: EntryType;
    tags: string[];
    body: string;
  }[] = [];

  if (options.from === 'markdown-dir' || options.from === 'claude-memory') {
    const files = collectMarkdownFiles(options.sourcePath);
    for (const filePath of files) {
      const base = path.basename(filePath);
      if (base.toLowerCase() === 'memory.md' || base.toLowerCase() === 'catalog.md' || base.toLowerCase() === 'readme.md') {
        continue;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseMarkdownWithFrontmatter(raw);
      const summary = inferSummary(parsed.rawFrontmatter, parsed.body, base);
      const type = inferType(parsed.rawFrontmatter, base);
      const tags: string[] = [];
      if (Array.isArray(parsed.rawFrontmatter.tags)) {
        tags.push(...parsed.rawFrontmatter.tags.map(String));
      }
      const meta = parsed.rawFrontmatter.metadata as Record<string, string> | undefined;
      if (meta && typeof meta.scope === 'string' && meta.scope.trim()) {
        tags.push(`legacy-scope:${meta.scope.trim()}`);
      }
      candidates.push({
        source: filePath,
        entryId: slugify(base),
        summary,
        type,
        tags,
        body: parsed.body.trim() || summary,
      });
    }
  } else {
    // agents-md or cursor-rules
    const files = collectMarkdownFiles(options.sourcePath);
    for (const filePath of files) {
      const base = path.basename(filePath);
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseMarkdownWithFrontmatter(raw);
      if (options.splitHeadings) {
        const sections = splitTopLevelHeadings(parsed.body);
        if (sections.length > 0) {
          for (const sec of sections) {
            candidates.push({
              source: `${filePath}#${sec.title}`,
              entryId: slugify(sec.title),
              summary: sec.title,
              type: 'rule',
              tags: [options.from],
              body: sec.body,
            });
          }
          continue;
        }
      }
      const summary = inferSummary(parsed.rawFrontmatter, parsed.body, base);
      candidates.push({
        source: filePath,
        entryId: slugify(base),
        summary,
        type: 'rule',
        tags: [options.from],
        body: parsed.body.trim() || summary,
      });
    }
  }

  for (const c of candidates) {
    const hygiene = scanHygiene(`${c.summary}\n${c.body}`);
    if (hygiene.length > 0) {
      skippedHygiene.push({
        source: c.source,
        reason: hygiene.map((h) => h.message).join('; '),
      });
      continue;
    }

    const dupes = findNearDuplicates(
      c.summary,
      c.body,
      loaded.activeEntries,
      [...pending, ...staged],
      config.similarityThreshold,
    );
    if (dupes.length > 0) {
      duplicates.push({
        source: c.source,
        matchedId: dupes[0].id,
        summary: dupes[0].summary,
      });
      continue;
    }

    const proposal = createProposal(
      config,
      {
        scope: targetScope,
        action: 'create',
        entryId: c.entryId,
        summary: c.summary,
        type: c.type,
        tags: c.tags,
        body: c.body,
        projectRootPath: targetScope === 'project' ? projectRes.projectRoot : undefined,
      },
      homeDir,
    );
    staged.push(proposal);
  }

  const approvedIds: string[] = [];
  if (options.approve && staged.length > 0) {
    const outcome = await approveProposalsBatch(config, staged, { homeDir });
    if (!outcome.ok) {
      throw new Error(`Import --approve failed: ${outcome.errors.join('; ')}`);
    }
    approvedIds.push(...outcome.approvedIds);
  }

  return {
    staged,
    approvedIds,
    duplicates,
    skippedHygiene,
    notes,
  };
}
