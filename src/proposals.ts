import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generateProposalId,
  getAllPreMemoryBaseDir,
  getHomeDir,
  getPreMemoryRootDir,
  getProjectRootUuid,
  withStateLock,
} from './config.js';
import { compileGlobalL0 } from './compiler.js';
import {
  parseMarkdownWithFrontmatter,
  serializeEntryMarkdown,
  slugify,
} from './frontmatter.js';
import {
  buildCompareUrl,
  createThrowawayWorktree,
  getDefaultBranch,
  getRemoteUrl,
  gitCommitFiles,
  gitPullFfOnly,
  gitSync,
  isBranchProtectionRejection,
  readHeadFile,
  removeThrowawayWorktree,
} from './git.js';
import { formatHygieneErrors, scanHygiene } from './hygiene.js';
import { PROJECT_MEMORY_REL_DIR } from './store.js';
import {
  EntryType,
  L0Mode,
  Proposal,
  ProposalAction,
  RootConfig,
  Scope,
  TeamSubmitMode,
  UserConfig,
} from './types.js';

export const CACHE_GUIDANCE_NOTE =
  'Note: Updated L0 applies to new sessions; batching reviews at session end maximizes prompt-cache reuse.';

export function saveProposal(proposal: Proposal, homeDir = getHomeDir()): string {
  const dir = getPreMemoryRootDir(proposal.rootUuid, homeDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${proposal.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2) + '\n', 'utf8');
  return filePath;
}

export function deleteProposal(proposal: Proposal, homeDir = getHomeDir()): void {
  const filePath = path.join(getPreMemoryRootDir(proposal.rootUuid, homeDir), `${proposal.id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function listAllProposals(homeDir = getHomeDir()): Proposal[] {
  const baseDir = getAllPreMemoryBaseDir(homeDir);
  if (!fs.existsSync(baseDir)) return [];

  const proposals: Proposal[] = [];
  for (const rootUuid of fs.readdirSync(baseDir)) {
    const rootDir = path.join(baseDir, rootUuid);
    if (!fs.statSync(rootDir).isDirectory()) continue;
    for (const file of fs.readdirSync(rootDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf8')) as Proposal;
        proposals.push(raw);
      } catch {
        // Skip malformed file
      }
    }
  }
  proposals.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return proposals;
}

export function reconcileAwaitingCommitProposals(homeDir = getHomeDir()): Proposal[] {
  const all = listAllProposals(homeDir);
  const remaining: Proposal[] = [];

  for (const p of all) {
    if (p.status === 'awaiting_commit' && p.projectRootPath && p.targetFilePath) {
      const committed = readHeadFile(p.projectRootPath, p.targetFilePath);
      if (committed !== null) {
        deleteProposal(p, homeDir);
        continue;
      }
    }
    remaining.push(p);
  }

  return remaining;
}

export function findProposalById(id: string, homeDir = getHomeDir()): Proposal | null {
  const all = reconcileAwaitingCommitProposals(homeDir);
  return all.find((p) => p.id === id) || null;
}

export function createProposal(
  config: UserConfig,
  input: {
    scope: Scope;
    action: ProposalAction;
    entryId?: string;
    targetId?: string;
    summary: string;
    type: EntryType;
    tags?: string[];
    l0?: L0Mode;
    body: string;
    forceNew?: boolean;
    reason?: string;
    projectRootPath?: string;
  },
  homeDir = getHomeDir(),
): Proposal {
  let rootUuid: string;
  if (input.scope === 'personal') {
    if (!config.roots.personal) {
      throw new Error('Personal memory root is not configured.');
    }
    rootUuid = config.roots.personal.uuid;
  } else if (input.scope === 'team') {
    if (!config.roots.team) {
      throw new Error('Team memory root is not configured.');
    }
    rootUuid = config.roots.team.uuid;
  } else {
    if (!input.projectRootPath) {
      throw new Error('Project scope requires an active project root.');
    }
    rootUuid = getProjectRootUuid(input.projectRootPath);
  }

  const entryId =
    input.action === 'update' && input.targetId
      ? input.targetId
      : input.entryId
        ? slugify(input.entryId)
        : slugify(input.summary);

  const proposal: Proposal = {
    id: generateProposalId(config.userTag),
    rootUuid,
    scope: input.scope,
    action: input.action,
    entryId,
    targetId: input.targetId,
    summary: input.summary.replace(/\s+/g, ' ').trim(),
    type: input.type,
    tags: input.tags || [],
    l0: input.l0,
    body: input.body.trim(),
    forceNew: input.forceNew,
    reason: input.reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
    projectRootPath: input.projectRootPath,
  };

  saveProposal(proposal, homeDir);
  return proposal;
}

export function rejectProposal(id: string, homeDir = getHomeDir()): Proposal {
  const proposal = findProposalById(id, homeDir);
  if (!proposal) {
    throw new Error(`Proposal "${id}" not found in pre-memory.`);
  }
  deleteProposal(proposal, homeDir);
  return proposal;
}

function applyProposalFilesToDir(
  repoDir: string,
  subDir: string,
  proposal: Proposal,
): string[] {
  const touched: string[] = [];
  const targetDir = subDir ? path.join(repoDir, subDir) : repoDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const relEntryPath = subDir
    ? path.posix.join(subDir, `${proposal.entryId}.md`)
    : `${proposal.entryId}.md`;
  const absEntryPath = path.join(repoDir, relEntryPath);

  const markdown = serializeEntryMarkdown(
    {
      summary: proposal.summary,
      type: proposal.type,
      tags: proposal.tags,
      status: 'active',
      l0: proposal.l0 || (proposal.scope === 'project' ? 'none' : 'line'),
    },
    proposal.body,
  );
  fs.writeFileSync(absEntryPath, markdown, 'utf8');
  touched.push(relEntryPath);

  if (proposal.action === 'supersede' && proposal.targetId && proposal.targetId !== proposal.entryId) {
    const targetRel = subDir
      ? path.posix.join(subDir, `${proposal.targetId}.md`)
      : `${proposal.targetId}.md`;
    const targetAbs = path.join(repoDir, targetRel);
    if (fs.existsSync(targetAbs)) {
      const existingRaw = fs.readFileSync(targetAbs, 'utf8');
      const parsed = parseMarkdownWithFrontmatter(existingRaw);
      const oldSummary =
        typeof parsed.rawFrontmatter.summary === 'string'
          ? parsed.rawFrontmatter.summary
          : proposal.targetId;
      const oldType =
        typeof parsed.rawFrontmatter.type === 'string'
          ? (parsed.rawFrontmatter.type as EntryType)
          : 'rule';
      const oldTags = Array.isArray(parsed.rawFrontmatter.tags)
        ? parsed.rawFrontmatter.tags.map(String)
        : [];
      const updatedOld = serializeEntryMarkdown(
        {
          summary: oldSummary,
          type: oldType,
          tags: oldTags,
          status: 'superseded',
          superseded_by: proposal.entryId,
          l0: 'none',
        },
        parsed.body,
      );
      fs.writeFileSync(targetAbs, updatedOld, 'utf8');
      touched.push(targetRel);
    }
  }

  return touched;
}

export interface ApproveOutcome {
  ok: boolean;
  approvedIds: string[];
  messages: string[];
  errors: string[];
  compareUrl?: string;
  recompiledL0?: boolean;
}

export async function approveProposalsBatch(
  config: UserConfig,
  proposals: Proposal[],
  options: {
    homeDir?: string;
    teamSubmitModeOverride?: TeamSubmitMode;
  } = {},
): Promise<ApproveOutcome> {
  const homeDir = options.homeDir || getHomeDir();
  const messages: string[] = [];
  const errors: string[] = [];
  const approvedIds: string[] = [];
  let compareUrl: string | undefined;
  let recompiledL0 = false;

  if (proposals.length === 0) {
    return { ok: true, approvedIds: [], messages: ['No proposals to approve.'], errors: [] };
  }

  // Hygiene check every proposal first (AC-20b1)
  for (const p of proposals) {
    const findings = scanHygiene(`${p.summary}\n${p.body}`);
    if (findings.length > 0) {
      errors.push(formatHygieneErrors(findings, `proposal ${p.id}`));
    }
  }
  if (errors.length > 0) {
    return { ok: false, approvedIds: [], messages: [], errors };
  }

  // Group by scope
  const byScope = new Map<Scope, Proposal[]>();
  for (const p of proposals) {
    const list = byScope.get(p.scope) || [];
    list.push(p);
    byScope.set(p.scope, list);
  }

  // 1. Personal scope: single commit + single L0 recompile
  const personalProps = byScope.get('personal') || [];
  if (personalProps.length > 0) {
    const root = config.roots.personal;
    if (!root) {
      errors.push('Personal memory root is not configured.');
      return { ok: false, approvedIds, messages, errors };
    }
    const touched: string[] = [];
    for (const p of personalProps) {
      touched.push(...applyProposalFilesToDir(root.path, '', p));
    }
    const commitMsg =
      personalProps.length === 1
        ? `memory(${personalProps[0].action}): ${personalProps[0].entryId} [${personalProps[0].id}]`
        : `memory(batch): approve ${personalProps.length} proposals (${personalProps.map((p) => p.id).join(', ')})`;

    gitCommitFiles(root.path, touched, commitMsg);
    for (const p of personalProps) {
      deleteProposal(p, homeDir);
      approvedIds.push(p.id);
    }
    const comp = compileGlobalL0(config, { homeDir });
    if (!comp.ok) {
      errors.push(...comp.errors);
      return { ok: false, approvedIds, messages, errors };
    }
    recompiledL0 = true;
    messages.push(
      `Approved ${personalProps.length} personal proposal(s) in 1 commit and recompiled L0 (${comp.estimatedTokens}/${comp.budget} tokens).`,
    );
  }

  // 2. Project scope: write uncommitted file(s) and mark awaiting_commit
  const projectProps = byScope.get('project') || [];
  if (projectProps.length > 0) {
    for (const p of projectProps) {
      if (!p.projectRootPath) {
        errors.push(`Project proposal ${p.id} is missing projectRootPath.`);
        continue;
      }
      const touched = applyProposalFilesToDir(p.projectRootPath, PROJECT_MEMORY_REL_DIR, p);
      p.status = 'awaiting_commit';
      p.targetFilePath = touched[0];
      saveProposal(p, homeDir);
      approvedIds.push(p.id);
      messages.push(
        `Staged project memory file ${touched[0]} (uncommitted). Run: git add ${touched.join(' ')} && git commit -m "memory: ${p.entryId}"`,
      );
    }
    if (errors.length > 0) {
      return { ok: false, approvedIds, messages, errors };
    }
  }

  // 3. Team scope: throwaway git worktree from origin/<defaultBranch>
  const teamProps = byScope.get('team') || [];
  if (teamProps.length > 0) {
    const root = config.roots.team;
    if (!root) {
      errors.push('Team memory root is not configured.');
      return { ok: false, approvedIds, messages, errors };
    }
    const res = await approveTeamBatch(
      config,
      root,
      teamProps,
      homeDir,
      options.teamSubmitModeOverride,
    );
    if (!res.ok) {
      errors.push(...res.errors);
      return { ok: false, approvedIds, messages, errors };
    }
    approvedIds.push(...res.approvedIds);
    messages.push(...res.messages);
    if (res.compareUrl) compareUrl = res.compareUrl;
    if (res.recompiledL0) recompiledL0 = true;
  }

  if (recompiledL0) {
    messages.push(CACHE_GUIDANCE_NOTE);
  }

  return {
    ok: true,
    approvedIds,
    messages,
    errors: [],
    compareUrl,
    recompiledL0,
  };
}

async function approveTeamBatch(
  config: UserConfig,
  root: RootConfig,
  teamProps: Proposal[],
  homeDir: string,
  overrideMode?: TeamSubmitMode,
): Promise<ApproveOutcome> {
  const defaultBranch = root.defaultBranch || getDefaultBranch(root.path);
  const submitMode: TeamSubmitMode = overrideMode || root.submitMode || 'auto';
  const branchName =
    teamProps.length === 1
      ? `memory/proposal-${teamProps[0].id}`
      : `memory/proposal-${teamProps[0].id}-batch`;

  let worktreeDir: string | null = null;
  try {
    worktreeDir = createThrowawayWorktree(root.path, defaultBranch);
    const touched: string[] = [];
    for (const p of teamProps) {
      touched.push(...applyProposalFilesToDir(worktreeDir, '', p));
    }
    const commitMsg =
      teamProps.length === 1
        ? `memory(${teamProps[0].action}): ${teamProps[0].entryId} [${teamProps[0].id}]`
        : `memory(batch): approve ${teamProps.length} proposals (${teamProps.map((p) => p.id).join(', ')})`;

    gitCommitFiles(worktreeDir, touched, commitMsg);

    const remoteUrl = root.remote || getRemoteUrl(root.path);

    if (submitMode === 'auto') {
      const directPush = gitSync(['-C', worktreeDir, 'push', 'origin', `HEAD:${defaultBranch}`]);
      if (directPush.ok) {
        for (const p of teamProps) {
          deleteProposal(p, homeDir);
        }
        // Sync serving clone & recompile L0
        const pull = await gitPullFfOnly(root.path, 5000);
        let recompiledL0 = false;
        if (pull.ok) {
          const comp = compileGlobalL0(config, { homeDir });
          if (comp.ok) recompiledL0 = true;
        }
        return {
          ok: true,
          approvedIds: teamProps.map((p) => p.id),
          messages: [
            `Pushed ${teamProps.length} team proposal(s) directly to origin/${defaultBranch} and synced local L0.`,
          ],
          errors: [],
          recompiledL0,
        };
      }

      if (!isBranchProtectionRejection(directPush.stderr)) {
        markPushFailed(teamProps, directPush.stderr.trim() || 'git push failed', homeDir);
        return {
          ok: false,
          approvedIds: [],
          messages: [],
          errors: [`Team push failed: ${directPush.stderr.trim() || 'unknown remote error'}`],
        };
      }
      // Fall through to PR branch push on branch protection rejection
    }

    const prPush = gitSync([
      '-C',
      worktreeDir,
      'push',
      'origin',
      `HEAD:refs/heads/${branchName}`,
    ]);
    if (!prPush.ok) {
      markPushFailed(teamProps, prPush.stderr.trim() || 'git push branch failed', homeDir);
      return {
        ok: false,
        approvedIds: [],
        messages: [],
        errors: [`Team PR branch push failed: ${prPush.stderr.trim() || 'unknown remote error'}`],
      };
    }

    const compareUrl = buildCompareUrl(remoteUrl, defaultBranch, branchName);
    for (const p of teamProps) {
      deleteProposal(p, homeDir);
    }
    return {
      ok: true,
      approvedIds: teamProps.map((p) => p.id),
      messages: [
        `Pushed branch ${branchName} to remote.`,
        `Create PR: ${compareUrl}`,
      ],
      errors: [],
      compareUrl,
      recompiledL0: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    markPushFailed(teamProps, msg, homeDir);
    return {
      ok: false,
      approvedIds: [],
      messages: [],
      errors: [`Team approval failed: ${msg}`],
    };
  } finally {
    if (worktreeDir) {
      removeThrowawayWorktree(root.path, worktreeDir);
    }
  }
}

function markPushFailed(proposals: Proposal[], error: string, homeDir: string): void {
  withStateLock(() => {
    for (const p of proposals) {
      p.status = 'push_failed';
      p.error = error;
      saveProposal(p, homeDir);
    }
  }, homeDir);
}
