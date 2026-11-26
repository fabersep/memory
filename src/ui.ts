import * as fs from 'node:fs';

export const DOCS_TROUBLESHOOTING_URL =
  'https://github.com/fabersep/memory/blob/main/docs/troubleshooting.md';

export function troubleshootingLink(anchor: string): string {
  return `${DOCS_TROUBLESHOOTING_URL}#${anchor}`;
}

export function shouldUseColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

function wrap(code: string, text: string, enabled = shouldUseColor()): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const c = {
  bold: (s: string, on?: boolean) => wrap('1', s, on),
  dim: (s: string, on?: boolean) => wrap('2', s, on),
  red: (s: string, on?: boolean) => wrap('31', s, on),
  green: (s: string, on?: boolean) => wrap('32', s, on),
  yellow: (s: string, on?: boolean) => wrap('33', s, on),
  blue: (s: string, on?: boolean) => wrap('34', s, on),
  magenta: (s: string, on?: boolean) => wrap('35', s, on),
  cyan: (s: string, on?: boolean) => wrap('36', s, on),
};

export function hr(char = '─', width = 64): string {
  return char.repeat(width);
}

export function normalizeTeamUrl(input: string): { url: string; normalized: boolean } {
  const trimmed = input.trim();
  if (!trimmed) return { url: trimmed, normalized: false };

  // Already a full URL or SSH git spec
  if (
    /^(?:https?|ssh|git|file):\/\//i.test(trimmed) ||
    /^git@[^:]+:.+/.test(trimmed)
  ) {
    return { url: trimmed, normalized: false };
  }

  // Local path (relative, absolute, home, or existing directory)
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~') ||
    fs.existsSync(trimmed)
  ) {
    return { url: trimmed, normalized: false };
  }

  // Host + path without protocol, e.g. github.com/org/repo or gitlab.com/org/repo.git
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[^/\s]+\/[^/\s]+/.test(trimmed)) {
    const withGit = trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
    return { url: `https://${withGit}`, normalized: true };
  }

  // GitHub shorthand: org/repo
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    const clean = trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
    return { url: `https://github.com/${clean}`, normalized: true };
  }

  return { url: trimmed, normalized: false };
}

export function inferErrorAnchor(message: string): string | null {
  const lower = message.toLowerCase();
  if (lower.includes('machine-path') || lower.includes('home path')) return 'machine-specific-paths';
  if (lower.includes('secret') || lower.includes('private key') || lower.includes('api key') || lower.includes('token')) {
    return 'secrets-detected';
  }
  if (lower.includes('budget') || lower.includes('1500')) return 'l0-budget-exceeded';
  if (lower.includes('duplicate') || lower.includes('collision')) return 'duplicate-ids';
  if (lower.includes('dirty') || lower.includes('uncommitted')) return 'dirty-serving-clone';
  if (lower.includes('push') && lower.includes('fail')) return 'push-failed';
  return null;
}
