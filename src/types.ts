export type Scope = 'personal' | 'team' | 'project';

export type EntryType = 'rule' | 'decision' | 'lesson' | 'preference' | 'reference';

export type EntryStatus = 'active' | 'deprecated' | 'superseded';

export type L0Mode = 'none' | 'line' | 'body';

export type TeamSubmitMode = 'auto' | 'pr';

export type ProposalAction = 'create' | 'update' | 'supersede';

export type ProposalStatus = 'pending' | 'awaiting_commit' | 'push_failed';

export type ProjectRootSource = 'mcp-roots' | 'cwd' | 'none';

export const COMPILER_VERSION = '0.1.0';
export const DEFAULT_TOKEN_BUDGET = 1500;
export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.45;
export const VALID_TYPES: readonly EntryType[] = [
  'rule',
  'decision',
  'lesson',
  'preference',
  'reference',
];
export const VALID_STATUSES: readonly EntryStatus[] = [
  'active',
  'deprecated',
  'superseded',
];
export const VALID_L0_MODES: readonly L0Mode[] = ['none', 'line', 'body'];

export interface RootConfig {
  uuid: string;
  path: string;
  scope: 'personal' | 'team';
  remote?: string;
  defaultBranch?: string;
  submitMode?: TeamSubmitMode;
}

export interface UserConfig {
  version: 1;
  userTag: string;
  tokenBudget: number;
  staleDays: number;
  similarityThreshold: number;
  roots: {
    personal?: RootConfig;
    team?: RootConfig;
  };
}

export interface EntryFrontmatter {
  summary: string;
  type: EntryType;
  tags: string[];
  status: EntryStatus;
  superseded_by?: string;
  l0: L0Mode;
  last_verified?: string;
}

export interface MemoryEntry extends EntryFrontmatter {
  id: string;
  scope: Scope;
  filePath: string;
  body: string;
  links: string[];
  shadowed?: boolean;
  shadowWarning?: string;
}

export interface ValidationError {
  scope: Scope;
  filePath: string;
  message: string;
}

export interface HygieneFinding {
  line: number;
  category: 'secret' | 'machine-path';
  pattern: string;
  message: string;
  redactedSnippet: string;
}

export interface Proposal {
  id: string;
  rootUuid: string;
  scope: Scope;
  action: ProposalAction;
  entryId: string;
  targetId?: string;
  summary: string;
  type: EntryType;
  tags: string[];
  l0?: L0Mode;
  body: string;
  forceNew?: boolean;
  reason?: string;
  status: ProposalStatus;
  createdAt: string;
  error?: string;
  projectRootPath?: string;
  targetFilePath?: string;
}

export interface ProjectRootResolution {
  source: ProjectRootSource;
  projectRoot?: string;
  memoryDir?: string;
}

export interface SearchResultItem {
  id: string;
  scope: Scope;
  type: EntryType;
  summary: string;
  tags: string[];
  pending?: boolean;
  proposal_id?: string;
  shadowed?: boolean;
  shadow_warning?: string;
}
