import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** The installed package version, read from package.json (dist/src/ -> ../../package.json). */
export function getPackageVersion(): string {
  if (cached) return cached;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof raw.version === 'string' && raw.version.trim()) {
      cached = raw.version.trim();
      return cached;
    }
  } catch {
    // Fallback below
  }
  cached = '0.0.0';
  return cached;
}
