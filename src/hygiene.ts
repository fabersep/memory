import { HygieneFinding } from './types.js';

interface PatternRule {
  category: 'secret' | 'machine-path';
  pattern: string;
  regex: RegExp;
  label: string;
}

const RULES: PatternRule[] = [
  {
    category: 'secret',
    pattern: 'private-key',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    label: 'Private key header detected',
  },
  {
    category: 'secret',
    pattern: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    label: 'JWT token detected',
  },
  {
    category: 'secret',
    pattern: 'bearer-token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
    label: 'Bearer token detected',
  },
  {
    category: 'secret',
    pattern: 'api-key-prefix',
    regex:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    label: 'Known API key prefix detected',
  },
  {
    category: 'secret',
    pattern: 'credential-assignment',
    regex:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/i,
    label: 'Credential assignment detected',
  },
  {
    category: 'machine-path',
    pattern: 'macos-user-path',
    regex: /\/Users\/[A-Za-z0-9._-]+\//,
    label: 'Machine-specific macOS home path detected',
  },
  {
    category: 'machine-path',
    pattern: 'linux-user-path',
    regex: /\/home\/[A-Za-z0-9._-]+\//,
    label: 'Machine-specific Linux home path detected',
  },
  {
    category: 'machine-path',
    pattern: 'windows-user-path',
    regex: /\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/,
    label: 'Machine-specific Windows home path detected',
  },
];

export function scanHygiene(content: string): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const rule of RULES) {
      const match = rule.regex.exec(lineText);
      if (match) {
        const redactedSnippet = lineText
          .replace(rule.regex, rule.category === 'secret' ? '[REDACTED]' : '[MACHINE_PATH]')
          .trim()
          .slice(0, 120);
        findings.push({
          line: i + 1,
          category: rule.category,
          pattern: rule.pattern,
          message: `${rule.label} (${rule.category}/${rule.pattern}) at line ${i + 1}`,
          redactedSnippet,
        });
        break;
      }
    }
  }

  return findings;
}

export function normalizeMachinePaths(content: string): { content: string; replacements: number } {
  let replacements = 0;
  const next = content.replace(/(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//g, () => {
    replacements++;
    return '~/';
  });
  return { content: next, replacements };
}

export function formatHygieneErrors(findings: HygieneFinding[], sourceName?: string): string {
  const prefix = sourceName ? `${sourceName}: ` : '';
  return findings
    .map((f) => `${prefix}line ${f.line} [${f.category}/${f.pattern}]: ${f.message} (${f.redactedSnippet})`)
    .join('\n');
}
