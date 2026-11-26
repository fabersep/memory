import {
  EntryFrontmatter,
  EntryStatus,
  EntryType,
  L0Mode,
  Scope,
  VALID_L0_MODES,
  VALID_STATUSES,
  VALID_TYPES,
} from './types.js';

export interface ParsedMarkdown {
  rawFrontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  body: string;
}

export function parseMarkdownWithFrontmatter(content: string): ParsedMarkdown {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { rawFrontmatter: {}, hasFrontmatter: false, body: normalized };
  }
  const endIdx = normalized.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { rawFrontmatter: {}, hasFrontmatter: false, body: normalized };
  }
  const afterClose = endIdx + 4;
  if (
    afterClose < normalized.length &&
    normalized[afterClose] !== '\n' &&
    normalized[afterClose] !== ' '
  ) {
    return { rawFrontmatter: {}, hasFrontmatter: false, body: normalized };
  }
  const yamlBlock = normalized.slice(4, endIdx);
  const rest = normalized.slice(afterClose).replace(/^\n/, '');
  return {
    rawFrontmatter: parseSimpleYaml(yamlBlock),
    hasFrontmatter: true,
    body: rest,
  };
}

function parseSimpleYaml(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1];
    const valStr = keyMatch[2].trim();

    if (valStr === '' || valStr === '|' || valStr === '>') {
      // Check indented block: array, nested map, or multiline scalar
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j].trim() === '')) {
        if (lines[j].trim() === '' && valStr === '') {
          j++;
          continue;
        }
        blockLines.push(lines[j]);
        j++;
      }

      if (valStr === '|' || valStr === '>') {
        const cleaned = blockLines.map((l) => l.replace(/^\s{2}/, ''));
        result[key] = (valStr === '>' ? cleaned.join(' ') : cleaned.join('\n')).trim();
      } else if (blockLines.length > 0 && blockLines.every((l) => /^\s*-\s+/.test(l))) {
        result[key] = blockLines.map((l) => unquote(l.replace(/^\s*-\s+/, '').trim()));
      } else if (blockLines.length > 0 && blockLines.some((l) => /^\s+[A-Za-z0-9_-]+:/.test(l))) {
        const nested: Record<string, string> = {};
        for (const bl of blockLines) {
          const nm = bl.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
          if (nm) nested[nm[1]] = unquote(nm[2].trim());
        }
        result[key] = nested;
      } else {
        result[key] = '';
      }
      i = j;
      continue;
    }

    if (valStr.startsWith('[') && valStr.endsWith(']')) {
      const inner = valStr.slice(1, -1).trim();
      result[key] = inner
        ? inner.split(',').map((item) => unquote(item.trim())).filter(Boolean)
        : [];
    } else {
      result[key] = unquote(valStr);
    }
    i++;
  }

  return result;
}

function unquote(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
    (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
  ) {
    return val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return val;
}

export function validateFrontmatter(
  raw: Record<string, unknown>,
  scope: Scope,
): { frontmatter?: EntryFrontmatter; errors: string[] } {
  const errors: string[] = [];

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) {
    errors.push('missing required frontmatter field "summary"');
  } else if (summary.includes('\n')) {
    errors.push('"summary" must be a single line');
  }

  const rawType = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!rawType) {
    errors.push('missing required frontmatter field "type"');
  } else if (!VALID_TYPES.includes(rawType as EntryType)) {
    errors.push(`invalid "type" "${rawType}" (expected one of: ${VALID_TYPES.join(', ')})`);
  }

  const rawStatus = typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim() : 'active';
  if (!VALID_STATUSES.includes(rawStatus as EntryStatus)) {
    errors.push(`invalid "status" "${rawStatus}" (expected one of: ${VALID_STATUSES.join(', ')})`);
  }

  const defaultL0: L0Mode = scope === 'project' ? 'none' : 'line';
  const rawL0 = typeof raw.l0 === 'string' && raw.l0.trim() ? raw.l0.trim() : defaultL0;
  if (!VALID_L0_MODES.includes(rawL0 as L0Mode)) {
    errors.push(`invalid "l0" "${rawL0}" (expected one of: ${VALID_L0_MODES.join(', ')})`);
  }

  let tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    tags = raw.tags.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof raw.tags === 'string' && raw.tags.trim()) {
    tags = raw.tags.split(',').map((t) => t.trim()).filter(Boolean);
  }

  const superseded_by =
    typeof raw.superseded_by === 'string' && raw.superseded_by.trim()
      ? raw.superseded_by.trim()
      : undefined;

  const last_verified =
    typeof raw.last_verified === 'string' && raw.last_verified.trim()
      ? raw.last_verified.trim()
      : undefined;

  if (errors.length > 0) {
    return { errors };
  }

  return {
    frontmatter: {
      summary,
      type: rawType as EntryType,
      tags,
      status: rawStatus as EntryStatus,
      superseded_by,
      l0: rawL0 as L0Mode,
      last_verified,
    },
    errors: [],
  };
}

function quoteIfNeeded(value: string): string {
  if (/[:#[\]{}&*!|>'"%@`,?]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

export function serializeEntryMarkdown(
  fm: {
    summary: string;
    type: EntryType;
    tags?: string[];
    status?: EntryStatus;
    superseded_by?: string;
    l0?: L0Mode;
    last_verified?: string;
  },
  body: string,
): string {
  const lines: string[] = ['---'];
  lines.push(`summary: ${quoteIfNeeded(fm.summary.replace(/\s+/g, ' ').trim())}`);
  lines.push(`type: ${fm.type}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => quoteIfNeeded(t)).join(', ')}]`);
  }
  if (fm.status && fm.status !== 'active') {
    lines.push(`status: ${fm.status}`);
  }
  if (fm.superseded_by) {
    lines.push(`superseded_by: ${fm.superseded_by}`);
  }
  if (fm.l0) {
    lines.push(`l0: ${fm.l0}`);
  }
  if (fm.last_verified) {
    lines.push(`last_verified: ${fm.last_verified}`);
  }
  lines.push('---');
  const trimmedBody = body.replace(/\r\n/g, '\n').trim();
  return `${lines.join('\n')}\n\n${trimmedBody}\n`;
}

export function extractLinks(body: string): string[] {
  const links = new Set<string>();
  const mdLinkRegex = /\[[^\]]+\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRegex.exec(body)) !== null) {
    links.add(m[1]);
  }
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  while ((m = urlRegex.exec(body)) !== null) {
    links.add(m[0].replace(/[.,;:!?]+$/, ''));
  }
  return Array.from(links);
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\.md$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'memory-entry'
  );
}
