import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { BM25Index, findNearDuplicates } from './bm25.js';
import { getCompiledL0Path, getHomeDir, loadConfig } from './config.js';
import { compileGlobalL0 } from './compiler.js';
import { getHeadSha } from './git.js';
import { formatHygieneErrors, scanHygiene } from './hygiene.js';
import { createProposal, reconcileAwaitingCommitProposals } from './proposals.js';
import { loadAllScopes, LoadedAllScopes, resolveProjectRoot } from './store.js';
import { syncAllRoots } from './sync.js';
import {
  EntryType,
  L0Mode,
  ProposalAction,
  Scope,
  UserConfig,
  VALID_TYPES,
} from './types.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MCP_TOOLS = [
  {
    name: 'memory_search',
    description:
      'Search or list memory entries (L0/L1 summaries only). Empty query lists active entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword query; empty lists all.' },
        scope: { type: 'string', enum: ['team', 'personal', 'project'] },
        type: { type: 'string', enum: ['rule', 'decision', 'lesson', 'preference', 'reference'] },
        include_pending: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch full L2 Markdown body, frontmatter metadata, and links for one or more IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['ids'],
    },
  },
  {
    name: 'memory_propose',
    description:
      'Submit a create, update, or supersede proposal to pre-memory for human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'supersede'] },
        scope: { type: 'string', enum: ['team', 'personal', 'project'] },
        summary: { type: 'string' },
        type: { type: 'string', enum: ['rule', 'decision', 'lesson', 'preference', 'reference'] },
        body: { type: 'string' },
        target_id: { type: 'string' },
        entry_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        l0: { type: 'string', enum: ['none', 'line', 'body'] },
        force_new: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['action', 'scope', 'summary', 'type', 'body'],
    },
  },
] as const;

export class FaberMemoryMcpServer {
  private readonly homeDir: string;
  private readonly cwd: string;
  private readonly startupPullTimeoutMs: number;
  private mcpRoots: string[] | undefined;
  private index = new BM25Index();
  private lastHeadSignature = '';
  private lastLoaded: LoadedAllScopes | null = null;
  private startupWarnings: string[] = [];
  private startupPullPromise: Promise<void> | null = null;

  constructor(options: {
    homeDir?: string;
    cwd?: string;
    mcpRoots?: string[];
    startupPullTimeoutMs?: number;
  } = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.cwd = options.cwd || process.cwd();
    this.mcpRoots = options.mcpRoots;
    this.startupPullTimeoutMs = options.startupPullTimeoutMs ?? 5000;
  }

  public startNonBlockingSync(): void {
    const config = loadConfig(this.homeDir);
    // Ensure compiled L0 exists on startup if missing
    if (!fs.existsSync(getCompiledL0Path(this.homeDir))) {
      compileGlobalL0(config, { homeDir: this.homeDir });
    }
    this.startupPullPromise = syncAllRoots(config, {
      homeDir: this.homeDir,
      timeoutMs: this.startupPullTimeoutMs,
      recompile: true,
    })
      .then((res) => {
        if (res.warnings.length > 0) {
          this.startupWarnings.push(...res.warnings);
        }
      })
      .catch((err: unknown) => {
        this.startupWarnings.push(
          `Startup sync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  public async waitForStartupSyncForTest(): Promise<void> {
    if (this.startupPullPromise) {
      await this.startupPullPromise;
    }
  }

  public setMcpRoots(roots: string[]): void {
    this.mcpRoots = roots;
    this.lastHeadSignature = '';
  }

  private refreshIndexIfNeeded(): { config: UserConfig; loaded: LoadedAllScopes } {
    const config = loadConfig(this.homeDir);
    const projectRes = resolveProjectRoot(this.mcpRoots, this.cwd);
    const pending = reconcileAwaitingCommitProposals(this.homeDir);

    const teamSha = config.roots.team ? getHeadSha(config.roots.team.path) : '';
    const personalSha = config.roots.personal ? getHeadSha(config.roots.personal.path) : '';
    const projectSha =
      projectRes.source !== 'none' && projectRes.projectRoot
        ? getHeadSha(projectRes.projectRoot)
        : '';
    const pendingSig = pending.map((p) => `${p.id}:${p.status}`).join(',');
    const sig = `${teamSha}|${personalSha}|${projectSha}|${projectRes.source}|${pendingSig}`;

    if (sig !== this.lastHeadSignature || !this.lastLoaded) {
      this.lastLoaded = loadAllScopes(config, projectRes);
      this.index.rebuild(this.lastLoaded.activeEntries, pending);
      this.lastHeadSignature = sig;
    }

    return { config, loaded: this.lastLoaded };
  }

  private drainWarnings(loaded: LoadedAllScopes): string[] {
    const warnings = [...this.startupWarnings, ...loaded.uncommittedWarnings, ...loaded.shadowWarnings];
    this.startupWarnings = [];
    return warnings;
  }

  public listTools() {
    return MCP_TOOLS;
  }

  public handleToolCall(
    name: string,
    args: Record<string, unknown> = {},
  ): { content: { type: 'text'; text: string }[]; isError?: boolean } {
    if (name === 'memory_search') {
      const { loaded } = this.refreshIndexIfNeeded();
      const query = typeof args.query === 'string' ? args.query : '';
      const scope = typeof args.scope === 'string' ? (args.scope as Scope) : undefined;
      const type = typeof args.type === 'string' ? (args.type as EntryType) : undefined;
      const includePending = Boolean(args.include_pending);

      const results = this.index.search(query, { scope, type, includePending });
      const warnings = this.drainWarnings(loaded);
      const payload = {
        results,
        metadata: {
          project_root_source: loaded.projectResolution.source,
          warnings,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    }

    if (name === 'memory_get') {
      const { loaded } = this.refreshIndexIfNeeded();
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
      if (ids.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'ids array is required' }) }],
        };
      }
      const found = [];
      const notFound: string[] = [];
      for (const id of ids) {
        const matches = loaded.allEntries.filter((e) => e.id === id);
        if (matches.length === 0) {
          notFound.push(id);
        } else {
          for (const e of matches) {
            found.push({
              id: e.id,
              scope: e.scope,
              type: e.type,
              summary: e.summary,
              tags: e.tags,
              status: e.status,
              superseded_by: e.superseded_by,
              l0: e.l0,
              last_verified: e.last_verified,
              body: e.body,
              links: e.links,
              shadowed: e.shadowed,
              shadow_warning: e.shadowWarning,
            });
          }
        }
      }
      const warnings = this.drainWarnings(loaded);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ entries: found, not_found: notFound, warnings }, null, 2),
          },
        ],
      };
    }

    if (name === 'memory_propose') {
      const { config, loaded } = this.refreshIndexIfNeeded();
      const action = String(args.action || '') as ProposalAction;
      const scope = String(args.scope || '') as Scope;
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      const type = String(args.type || '') as EntryType;
      const body = typeof args.body === 'string' ? args.body.trim() : '';
      const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : undefined;
      const entryId = typeof args.entry_id === 'string' ? args.entry_id.trim() : undefined;
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const l0 = typeof args.l0 === 'string' ? (args.l0 as L0Mode) : undefined;
      const forceNew = Boolean(args.force_new);
      const reason = typeof args.reason === 'string' ? args.reason.trim() : undefined;

      if (!['create', 'update', 'supersede'].includes(action)) {
        return errorResponse('Invalid action; expected create, update, or supersede.');
      }
      if (!['team', 'personal', 'project'].includes(scope)) {
        return errorResponse('Invalid scope; expected team, personal, or project.');
      }
      if (!summary) {
        return errorResponse('summary is required.');
      }
      if (!VALID_TYPES.includes(type)) {
        return errorResponse(`Invalid type; expected one of: ${VALID_TYPES.join(', ')}`);
      }
      if (!body) {
        return errorResponse('body is required.');
      }

      // Validate target_id for update / supersede (AC-08c1, AC-08c2)
      if (action === 'update' || action === 'supersede') {
        if (!targetId) {
          return errorResponse(`target_id is required when action is "${action}".`);
        }
        const exists = loaded.activeEntries.some((e) => e.id === targetId && e.scope === scope) ||
          loaded.activeEntries.some((e) => e.id === targetId);
        if (!exists) {
          return errorResponse(`Target entry "${targetId}" not found in active memory.`);
        }
      }

      // Hygiene scan (AC-20a)
      const hygieneFindings = scanHygiene(`${summary}\n${body}`);
      if (hygieneFindings.length > 0) {
        return errorResponse(
          `Hygiene scan rejected proposal:\n${formatHygieneErrors(hygieneFindings)}`,
          { findings: hygieneFindings },
        );
      }

      // Near-duplicate check on create (AC-10, AC-11)
      if (action === 'create') {
        if (forceNew && !reason) {
          return errorResponse('A non-empty "reason" is required when force_new is true.');
        }
        if (!forceNew) {
          const pending = reconcileAwaitingCommitProposals(this.homeDir);
          const matches = findNearDuplicates(
            summary,
            body,
            loaded.activeEntries,
            pending,
            config.similarityThreshold,
          );
          if (matches.length > 0) {
            return errorResponse(
              'Near-duplicate entry found. Use action "update" or "supersede", or pass force_new: true with a reason.',
              {
                matches: matches.map((m) => ({
                  id: m.id,
                  scope: m.scope,
                  summary: m.summary,
                  pending: m.pending,
                  similarity: m.similarity,
                })),
              },
            );
          }
        }
      }

      try {
        const proposal = createProposal(
          config,
          {
            scope,
            action,
            entryId,
            targetId,
            summary,
            type,
            tags,
            l0,
            body,
            forceNew,
            reason,
            projectRootPath:
              scope === 'project' ? loaded.projectResolution.projectRoot : undefined,
          },
          this.homeDir,
        );
        this.lastHeadSignature = '';
        const warnings = this.drainWarnings(loaded);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'staged',
                  proposal_id: proposal.id,
                  entry_id: proposal.entryId,
                  scope: proposal.scope,
                  warnings,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    }

    return errorResponse(`Unknown tool: ${name}`);
  }

  public handleJsonRpc(req: JsonRpcRequest): Record<string, unknown> | null {
    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: '@fabersep/memory',
            version: '0.1.0',
          },
        },
      };
    }

    if (req.method === 'notifications/initialized') {
      return null;
    }

    if (req.method === 'ping') {
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} };
    }

    if (req.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: { tools: this.listTools() },
      };
    }

    if (req.method === 'tools/call') {
      const params = req.params || {};
      const toolName = String(params.name || '');
      const toolArgs = (params.arguments as Record<string, unknown>) || {};
      const res = this.handleToolCall(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: res,
      };
    }

    if (req.id === undefined) return null;
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  }

  public serveStdio(): void {
    this.startNonBlockingSync();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const resp = this.handleJsonRpc(req);
        if (resp) {
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch (err: unknown) {
        const errResp = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
        process.stdout.write(JSON.stringify(errResp) + '\n');
      }
    });
  }
}

function errorResponse(
  message: string,
  extra?: Record<string, unknown>,
): { isError: boolean; content: { type: 'text'; text: string }[] } {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}
