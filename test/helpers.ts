import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_BIN = path.resolve(__dirname, '../src/cli.js');

export function makeTempDir(prefix = 'faber-mem-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runCli(
  args: string[],
  options: {
    homeDir: string;
    userHome?: string;
    cwd?: string;
    input?: string;
  },
): { status: number; stdout: string; stderr: string } {
  const cwd = options.cwd || os.tmpdir();
  fs.mkdirSync(cwd, { recursive: true });
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    input: options.input,
    encoding: 'utf8',
    env: {
      ...process.env,
      FABER_MEMORY_HOME: options.homeDir,
      FABER_USER_HOME: options.userHome || path.join(options.homeDir, 'user-home'),
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

export function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function commitMarkdownFile(
  repoDir: string,
  relPath: string,
  content: string,
  message = `add ${relPath}`,
): void {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  git(['-C', repoDir, 'config', 'user.name', 'Test User']);
  git(['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  git(['-C', repoDir, 'add', '--', relPath]);
  git(['-C', repoDir, 'commit', '-m', message]);
}

export function createBareRemoteWithMain(baseDir: string, protectMain = false): {
  bareDir: string;
  seedDir: string;
} {
  const bareDir = path.join(baseDir, 'remote.git');
  const seedDir = path.join(baseDir, 'seed');
  fs.mkdirSync(bareDir, { recursive: true });
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, seedDir]);
  git(['-C', seedDir, 'config', 'user.name', 'Seed User']);
  git(['-C', seedDir, 'config', 'user.email', 'seed@example.com']);
  commitMarkdownFile(
    seedDir,
    'team-rule.md',
    `---\nsummary: Always run tests before merging\ntype: rule\n---\n\nRun the test suite on every pull request.\n`,
    'seed team rule',
  );
  git(['-C', seedDir, 'push', '-u', 'origin', 'main']);

  if (protectMain) {
    const hookPath = path.join(bareDir, 'hooks', 'pre-receive');
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh
while read oldrev newrev refname; do
  if [ "$refname" = "refs/heads/main" ]; then
    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2
    exit 1
  fi
done
exit 0
`,
      { mode: 0o755 },
    );
  }

  return { bareDir, seedDir };
}
