import { MemoryEntry, Proposal, Scope, SearchResultItem, EntryType } from './types.js';

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

interface IndexedDoc {
  key: string;
  id: string;
  scope: Scope;
  type: EntryType;
  summary: string;
  tags: string[];
  pending: boolean;
  proposalId?: string;
  shadowed?: boolean;
  shadowWarning?: string;
  tokens: string[];
  termFreqs: Map<string, number>;
  length: number;
}

const SCOPE_ORDER: Record<Scope, number> = {
  team: 0,
  personal: 1,
  project: 2,
};

export class BM25Index {
  private docs: IndexedDoc[] = [];
  private docFreq = new Map<string, number>();
  private avgDocLen = 1;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  public rebuild(entries: MemoryEntry[], pendingProposals: Proposal[] = []): void {
    this.docs = [];
    this.docFreq.clear();

    for (const e of entries) {
      if (e.status !== 'active') continue;
      // Weight id, summary, and tags higher by repeating them in the token bag
      const weightedText = `${e.id} ${e.id} ${e.summary} ${e.summary} ${e.tags.join(' ')} ${e.body}`;
      const tokens = tokenize(weightedText);
      this.addDoc({
        key: `${e.scope}:${e.id}`,
        id: e.id,
        scope: e.scope,
        type: e.type,
        summary: e.summary,
        tags: e.tags,
        pending: false,
        shadowed: e.shadowed,
        shadowWarning: e.shadowWarning,
        tokens,
      });
    }

    for (const p of pendingProposals) {
      const weightedText = `${p.entryId} ${p.entryId} ${p.summary} ${p.summary} ${(p.tags || []).join(' ')} ${p.body}`;
      const tokens = tokenize(weightedText);
      this.addDoc({
        key: `pending:${p.id}`,
        id: p.id,
        scope: p.scope,
        type: p.type,
        summary: p.summary,
        tags: p.tags || [],
        pending: true,
        proposalId: p.id,
        tokens,
      });
    }

    const totalLen = this.docs.reduce((acc, d) => acc + d.length, 0);
    this.avgDocLen = this.docs.length > 0 ? totalLen / this.docs.length : 1;
  }

  private addDoc(input: Omit<IndexedDoc, 'termFreqs' | 'length'>): void {
    const termFreqs = new Map<string, number>();
    for (const t of input.tokens) {
      termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
    }
    for (const term of termFreqs.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
    }
    this.docs.push({
      ...input,
      termFreqs,
      length: input.tokens.length || 1,
    });
  }

  public search(
    query: string,
    options: {
      scope?: Scope;
      type?: EntryType;
      includePending?: boolean;
      limit?: number;
    } = {},
  ): SearchResultItem[] {
    const includePending = Boolean(options.includePending);
    const limit = options.limit || 50;

    const candidates = this.docs.filter((d) => {
      if (!includePending && d.pending) return false;
      if (options.scope && d.scope !== options.scope) return false;
      if (options.type && d.type !== options.type) return false;
      return true;
    });

    const queryTokens = tokenize(query || '');
    if (queryTokens.length === 0) {
      return candidates
        .sort((a, b) => {
          if (a.pending !== b.pending) return a.pending ? 1 : -1;
          if (SCOPE_ORDER[a.scope] !== SCOPE_ORDER[b.scope]) {
            return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .slice(0, limit)
        .map(toSearchResult);
    }

    const N = Math.max(this.docs.length, 1);
    const scored: { doc: IndexedDoc; score: number }[] = [];

    for (const doc of candidates) {
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) || 0;
        if (tf === 0) continue;
        const df = this.docFreq.get(term) || 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLen));
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }
      if (score > 0) {
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1));
    return scored.slice(0, limit).map((s) => toSearchResult(s.doc));
  }
}

function toSearchResult(doc: IndexedDoc): SearchResultItem {
  const item: SearchResultItem = {
    id: doc.id,
    scope: doc.scope,
    type: doc.type,
    summary: doc.summary,
    tags: doc.tags,
  };
  if (doc.pending) {
    item.pending = true;
    item.proposal_id = doc.proposalId;
  }
  if (doc.shadowed) {
    item.shadowed = true;
    item.shadow_warning = doc.shadowWarning;
  }
  return item;
}

export interface NearDuplicateMatch {
  id: string;
  scope: Scope;
  summary: string;
  pending: boolean;
  similarity: number;
}

export function computeSimilarity(textA: string, textB: string): number {
  const tokensA = new Set(tokenize(textA));
  const tokensB = new Set(tokenize(textB));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const overlap = intersection / Math.min(tokensA.size, tokensB.size);
  return 0.6 * jaccard + 0.4 * overlap;
}

export function findNearDuplicates(
  candidateSummary: string,
  candidateBody: string,
  activeEntries: MemoryEntry[],
  pendingProposals: Proposal[],
  threshold: number,
): NearDuplicateMatch[] {
  const candidateText = `${candidateSummary} ${candidateBody}`;
  const matches: NearDuplicateMatch[] = [];

  for (const e of activeEntries) {
    if (e.status !== 'active') continue;
    const sim = computeSimilarity(candidateText, `${e.summary} ${e.body}`);
    if (sim >= threshold) {
      matches.push({
        id: e.id,
        scope: e.scope,
        summary: e.summary,
        pending: false,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }

  for (const p of pendingProposals) {
    const sim = computeSimilarity(candidateText, `${p.summary} ${p.body}`);
    if (sim >= threshold) {
      matches.push({
        id: p.id,
        scope: p.scope,
        summary: p.summary,
        pending: true,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  return matches;
}
