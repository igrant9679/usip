/**
 * Choosing which facts the chat agent gets to see this turn.
 *
 * Deliberately keyword scoring, not embeddings. A workspace writes a handful to
 * a few dozen entries by hand, so the whole corpus would fit in the prompt; the
 * only real job is keeping the prompt bounded and putting the most relevant
 * entries first. An embedding pipeline here would add a model call, a migration
 * and a cache to solve a problem that ranking a short list already solves — and
 * it could not be unit-tested the way this can.
 *
 * The design rule: NEVER return nothing. An agent handed no facts falls back on
 * invention, which is the exact failure this feature exists to stop. When
 * nothing matches the visitor's question we send the top entries by sortOrder,
 * so there is always something real to ground an answer in.
 */

export interface KnowledgeEntry {
  id: number;
  title: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
}

/** Prompt budget. Enough for several substantial answers, bounded per turn. */
export const MAX_KNOWLEDGE_CHARS = 4000;
const DEFAULT_LIMIT = 4;

/** Words too common to carry meaning — matching on them ranks everything equally. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "is", "are", "was", "were", "be", "been", "do", "does", "did", "you", "your", "we", "our",
  "us", "i", "it", "its", "this", "that", "these", "those", "what", "how", "why", "when", "where",
  "who", "can", "could", "would", "should", "will", "about", "into", "than", "then", "there", "have",
  "has", "had", "not", "any", "all", "just", "so", "as", "me", "my",
]);

function terms(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Score one entry against the visitor's words. Title matches count double —
 * entries are written as questions, so a title hit is a much stronger signal
 * that this is the thing being asked about than a passing mention in the body.
 */
function score(entry: KnowledgeEntry, queryTerms: Set<string>): number {
  if (!queryTerms.size) return 0;
  const titleTerms = new Set(terms(entry.title));
  const bodyTerms = new Set(terms(entry.body));
  let n = 0;
  // Array.from rather than iterating the Set directly — the project's tsc
  // target rejects Set iteration without downlevelIteration.
  for (const q of Array.from(queryTerms)) {
    if (titleTerms.has(q)) n += 2;
    else if (bodyTerms.has(q)) n += 1;
  }
  return n;
}

/**
 * Pick the entries to put in front of the model for this turn.
 *
 * Ties and no-match both fall back to sortOrder, so an admin's ordering is what
 * decides when relevance cannot — and the result is stable rather than
 * dependent on row order from the database.
 */
export function selectKnowledge(
  entries: KnowledgeEntry[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): KnowledgeEntry[] {
  const usable = (entries ?? []).filter((e) => e && e.enabled && (e.title || e.body));
  if (!usable.length || limit <= 0) return [];

  const queryTerms = new Set(terms(query));
  const byOrder = [...usable].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const scored = byOrder
    .map((entry, idx) => ({ entry, idx, s: score(entry, queryTerms) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.idx - b.idx);

  // Never nothing: relevance first, then the admin's own ordering to fill up.
  const picked: KnowledgeEntry[] = scored.slice(0, limit).map((r) => r.entry);
  for (const e of byOrder) {
    if (picked.length >= limit) break;
    if (!picked.includes(e)) picked.push(e);
  }
  return picked;
}

/**
 * Render entries for the prompt, truncated to a hard character budget so one
 * long answer cannot crowd out the transcript. Returns "" for no entries, which
 * the caller uses to omit the block entirely rather than print an empty heading.
 */
export function formatKnowledge(entries: KnowledgeEntry[], maxChars: number = MAX_KNOWLEDGE_CHARS): string {
  let out = "";
  for (const e of entries ?? []) {
    const block = `Q: ${e.title}\nA: ${e.body}\n\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}
