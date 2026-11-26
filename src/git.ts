import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
}

export function gitSync(args: string[], cwd?: string): GitExecResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
      message?: string;
    };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : e.message || '',
      code: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

export async function gitAsync(
  args: string[],
  cwd?: string,
  timeoutMs = 5000,
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string | null;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    const timedOut = Boolean(e.killed || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT');
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : e.message || '',
      code: typeof e.code === 'number' ? e.code : 1,
      timedOut,
    };
  }
}

export function isGitRepo(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const res = gitSync(['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

export function findGitRoot(startDir: string): string | null {
  if (!fs.existsSync(startDir)) return null;
  const res = gitSync(['-C', startDir, 'rev-parse', '--show-toplevel']);
  return res.ok ? res.stdout.trim() : null;
}

export function ensureGitIdentity(repoDir: string): void {
  const name = gitSync(['-C', repoDir, 'config', 'user.name']);
  if (!name.ok || !name.stdout.trim()) {
    gitSync(['-C', repoDir, 'config', 'user.name', 'Faber Memory']);
  }
  const email = gitSync(['-C', repoDir, 'config', 'user.email']);
  if (!email.ok || !email.stdout.trim()) {
    gitSync(['-C', repoDir, 'config', 'user.email', 'faber-memory@local']);
  }
}

export function gitInitSoloRepo(dir: string, defaultBranch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!isGitRepo(dir)) {
    const init = gitSync(['init', '-b', defaultBranch, dir]);
    if (!init.ok) {
      // Fallback for older git versions without -b
      const fallback = gitSync(['init', dir]);
      if (!fallback.ok) {
        throw new Error(`git init failed: ${fallback.stderr}`);
      }
      gitSync(['-C', dir, 'checkout', '-b', defaultBranch]);
    }
  }
  ensureGitIdentity(dir);
  if (!getHeadSha(dir)) {
    const commit = gitSync([
      '-C',
      dir,
      'commit',
      '--allow-empty',
      '-m',
      'chore: initialize faber-memory repository',
    ]);
    if (!commit.ok) {
      throw new Error(`initial git commit failed: ${commit.stderr}`);
    }
  }
}

export function gitCloneTeamRepo(url: string, destDir: string): string {
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const res = gitSync(['clone', url, destDir]);
  if (!res.ok) {
    throw new Error(`git clone failed: ${res.stderr.trim()}`);
  }
  ensureGitIdentity(destDir);
  return getDefaultBranch(destDir);
}

export function getHeadSha(repoDir: string): string | null {
  if (!fs.existsSync(repoDir)) return null;
  const res = gitSync(['-C', repoDir, 'rev-parse', 'HEAD']);
  return res.ok ? res.stdout.trim() : null;
}

export function getDefaultBranch(repoDir: string): string {
  const sym = gitSync(['-C', repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.ok && sym.stdout.trim()) {
    return sym.stdout.trim().replace(/^origin\//, '');
  }
  const head = gitSync(['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.ok && head.stdout.trim() && head.stdout.trim() !== 'HEAD') {
    return head.stdout.trim();
  }
  return 'main';
}

export function hasRemote(repoDir: string, remote = 'origin'): boolean {
  const res = gitSync(['-C', repoDir, 'remote', 'get-url', remote]);
  return res.ok && Boolean(res.stdout.trim());
}

export function getRemoteUrl(repoDir: string, remote = 'origin'): string | null {
  const res = gitSync(['-C', repoDir, 'remote', 'get-url', remote]);
  return res.ok ? res.stdout.trim() : null;
}

export function listHeadMarkdownFiles(repoDir: string, subPath = ''): string[] {
  const args = ['-C', repoDir, 'ls-tree', '-r', '--name-only', 'HEAD'];
  if (subPath) args.push('--', subPath);
  const res = gitSync(args);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.endsWith('.md'));
}

export function readHeadFile(repoDir: string, relPath: string): string | null {
  const posixPath = relPath.split(path.sep).join('/');
  const res = gitSync(['-C', repoDir, 'show', `HEAD:${posixPath}`]);
  return res.ok ? res.stdout : null;
}

export function getUncommittedFiles(repoDir: string, subPath = ''): string[] {
  const args = ['-C', repoDir, 'status', '--porcelain'];
  if (subPath) args.push('--', subPath);
  const res = gitSync(args);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
}

export function isDirty(repoDir: string, subPath = ''): boolean {
  return getUncommittedFiles(repoDir, subPath).length > 0;
}

export function gitCommitFiles(repoDir: string, relPaths: string[], message: string): void {
  ensureGitIdentity(repoDir);
  const add = gitSync(['-C', repoDir, 'add', '--', ...relPaths]);
  if (!add.ok) {
    throw new Error(`git add failed: ${add.stderr.trim()}`);
  }
  const commit = gitSync(['-C', repoDir, 'commit', '-m', message]);
  if (!commit.ok) {
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
}

export async function gitPullFfOnly(
  repoDir: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; error?: string; timedOut?: boolean; dirty?: boolean }> {
  if (isDirty(repoDir)) {
    return {
      ok: false,
      dirty: true,
      error: `Serving clone at ${repoDir} has uncommitted local edits; refusing git pull --ff-only.`,
    };
  }
  if (!hasRemote(repoDir)) {
    return { ok: true };
  }
  const res = await gitAsync(['-C', repoDir, 'pull', '--ff-only'], undefined, timeoutMs);
  if (res.ok) return { ok: true };
  if (res.timedOut) {
    return { ok: false, timedOut: true, error: `git pull --ff-only timed out after ${timeoutMs}ms` };
  }
  return { ok: false, error: res.stderr.trim() || 'git pull --ff-only failed' };
}

export function createThrowawayWorktree(repoDir: string, defaultBranch: string): string {
  // Fetch latest remote refs if available (best effort)
  if (hasRemote(repoDir)) {
    gitSync(['-C', repoDir, 'fetch', 'origin', defaultBranch]);
  }
  const tmpDir = path.join(
    os.tmpdir(),
    `faber-mem-wt-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const baseRef = gitSync(['-C', repoDir, 'rev-parse', '--verify', `origin/${defaultBranch}`]).ok
    ? `origin/${defaultBranch}`
    : defaultBranch;
  const add = gitSync(['-C', repoDir, 'worktree', 'add', '--detach', tmpDir, baseRef]);
  if (!add.ok) {
    throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
  }
  ensureGitIdentity(tmpDir);
  return tmpDir;
}

export function removeThrowawayWorktree(repoDir: string, worktreeDir: string): void {
  gitSync(['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir]);
  if (fs.existsSync(worktreeDir)) {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
  gitSync(['-C', repoDir, 'worktree', 'prune']);
}

export function isBranchProtectionRejection(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes('protected branch') ||
    lower.includes('branch protection') ||
    lower.includes('pre-receive hook declined') ||
    lower.includes('gh006') ||
    lower.includes('cannot push directly') ||
    lower.includes('direct push')
  );
}

export function buildCompareUrl(
  remoteUrl: string | null,
  defaultBranch: string,
  branchName: string,
): string {
  if (!remoteUrl) {
    return `branch:${branchName} (open a pull request against ${defaultBranch})`;
  }
  let webUrl = remoteUrl.trim();
  const sshMatch = webUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    webUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    webUrl = webUrl.replace(/\.git$/, '');
  }

  if (webUrl.includes('gitlab')) {
    return `${webUrl}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branchName)}&merge_request[target_branch]=${encodeURIComponent(defaultBranch)}`;
  }
  if (webUrl.includes('bitbucket')) {
    return `${webUrl}/pull-requests/new?source=${encodeURIComponent(branchName)}&dest=${encodeURIComponent(defaultBranch)}`;
  }
  if (webUrl.startsWith('http://') || webUrl.startsWith('https://')) {
    return `${webUrl}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branchName)}?expand=1`;
  }
  return `${webUrl}/compare/${defaultBranch}...${branchName}`;
}
