import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractLinks,
  parseMarkdownWithFrontmatter,
  validateFrontmatter,
} from './frontmatter.js';
import {
  findGitRoot,
  getHeadSha,
  getUncommittedFiles,
  isGitRepo,
  listHeadMarkdownFiles,
  readHeadFile,
} from './git.js';
import {
  MemoryEntry,
  ProjectRootResolution,
  Scope,
  UserConfig,
  ValidationError,
} from './types.js';

export const PROJECT_MEMORY_REL_DIR = '.faber/memory';

export interface LoadedScopeResult {
  scope: Scope;
  rootPath: string;
  headSha: string | null;
  entries: MemoryEntry[];
  errors: ValidationError[];
  uncommittedFiles: string[];
}

export function resolveProjectRoot(
  mcpRoots?: string[],
  cwd = process.cwd(),
): ProjectRootResolution {
  if (mcpRoots && mcpRoots.length > 0) {
    for (const rawRoot of mcpRoots) {
      const fsPath = rawRoot.startsWith('file://') ? safeFileUriToPath(rawRoot) : rawRoot;
      if (!fsPath) continue;
      const memDir = path.join(fsPath, PROJECT_MEMORY_REL_DIR);
      if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
        return { source: 'mcp-roots', projectRoot: fsPath, memoryDir: memDir };
      }
    }
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const memDir = path.join(gitRoot, PROJECT_MEMORY_REL_DIR);
    if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
      return { source: 'cwd', projectRoot: gitRoot, memoryDir: memDir };
    }
  }

  return { source: 'none' };
}

function safeFileUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export function loadScopeFromHead(
  repoDir: string,
  scope: Scope,
  subPath = '',
): LoadedScopeResult {
  if (!fs.existsSync(repoDir) || !isGitRepo(repoDir)) {
    return {
      scope,
      rootPath: repoDir,
      headSha: null,
      entries: [],
      errors: [],
      uncommittedFiles: [],
    };
  }

  const headSha = getHeadSha(repoDir);
  const uncommittedFiles = getUncommittedFiles(repoDir, subPath);
  if (!headSha) {
    return {
      scope,
      rootPath: repoDir,
      headSha: null,
      entries: [],
      errors: [],
      uncommittedFiles,
    };
  }

  const mdFiles = listHeadMarkdownFiles(repoDir, subPath);
  const entries: MemoryEntry[] = [];
  const errors: ValidationError[] = [];

  for (const relPath of mdFiles) {
    const base = path.basename(relPath);
    if (base.toLowerCase() === 'readme.md') {
      continue;
    }
    const rawContent = readHeadFile(repoDir, relPath);
    if (rawContent === null) continue;

    const parsed = parseMarkdownWithFrontmatter(rawContent);
    if (!parsed.hasFrontmatter) {
      errors.push({
        scope,
        filePath: relPath,
        message: 'missing YAML frontmatter (required fields: summary, type)',
      });
      continue;
    }

    const validated = validateFrontmatter(parsed.rawFrontmatter, scope);
    if (validated.errors.length > 0 || !validated.frontmatter) {
      for (const msg of validated.errors) {
        errors.push({ scope, filePath: relPath, message: msg });
      }
      continue;
    }

    const id = base.replace(/\.md$/i, '');
    entries.push({
      id,
      scope,
      filePath: relPath,
      ...validated.frontmatter,
      body: parsed.body.trim(),
      links: extractLinks(parsed.body),
    });
  }

  return {
    scope,
    rootPath: repoDir,
    headSha,
    entries,
    errors,
    uncommittedFiles,
  };
}

export interface LoadedAllScopes {
  team?: LoadedScopeResult;
  personal?: LoadedScopeResult;
  project?: LoadedScopeResult;
  projectResolution: ProjectRootResolution;
  allEntries: MemoryEntry[];
  activeEntries: MemoryEntry[];
  shadowWarnings: string[];
  uncommittedWarnings: string[];
}

export function loadAllScopes(
  config: UserConfig,
  projectResolution: ProjectRootResolution,
): LoadedAllScopes {
  const team = config.roots.team
    ? loadScopeFromHead(config.roots.team.path, 'team')
    : undefined;
  const personal = config.roots.personal
    ? loadScopeFromHead(config.roots.personal.path, 'personal')
    : undefined;
  const project =
    projectResolution.source !== 'none' && projectResolution.projectRoot
      ? loadScopeFromHead(projectResolution.projectRoot, 'project', PROJECT_MEMORY_REL_DIR)
      : undefined;

  const globalIds = new Map<string, Scope>();
  for (const e of team?.entries || []) {
    if (e.status === 'active') globalIds.set(e.id, 'team');
  }
  for (const e of personal?.entries || []) {
    if (e.status === 'active') globalIds.set(e.id, 'personal');
  }

  const shadowWarnings: string[] = [];
  if (project) {
    for (const e of project.entries) {
      if (e.status === 'active' && globalIds.has(e.id)) {
        const globalScope = globalIds.get(e.id)!;
        e.shadowed = true;
        e.shadowWarning = `Project entry "${e.id}" collides with active ${globalScope} entry "${e.id}" and is marked shadowed.`;
        shadowWarnings.push(e.shadowWarning);
      }
    }
  }

  const allEntries: MemoryEntry[] = [
    ...(team?.entries || []),
    ...(personal?.entries || []),
    ...(project?.entries || []),
  ];
  const activeEntries = allEntries.filter((e) => e.status === 'active');

  const uncommittedWarnings: string[] = [];
  if (team && team.uncommittedFiles.length > 0) {
    uncommittedWarnings.push(
      `Uncommitted edits in team memory root (${team.uncommittedFiles.join(', ')}); serving committed HEAD only.`,
    );
  }
  if (personal && personal.uncommittedFiles.length > 0) {
    uncommittedWarnings.push(
      `Uncommitted edits in personal memory root (${personal.uncommittedFiles.join(', ')}); serving committed HEAD only.`,
    );
  }
  if (project && project.uncommittedFiles.length > 0) {
    uncommittedWarnings.push(
      `Uncommitted edits in project memory (${project.uncommittedFiles.join(', ')}); run "git add ${project.uncommittedFiles.join(' ')} && git commit" to activate.`,
    );
  }

  return {
    team,
    personal,
    project,
    projectResolution,
    allEntries,
    activeEntries,
    shadowWarnings,
    uncommittedWarnings,
  };
}
