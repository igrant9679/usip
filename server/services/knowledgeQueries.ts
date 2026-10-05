/**
 * knowledgeQueries.ts — what a writer is about, phrased as a question for
 * the knowledge base, for the writers that build their own prompts (owner ask
 * 2026-10-05: "Give ARE sequences and meeting proposals the passages too").
 *
 * The answer rides in buildBrandContext(workspaceId, { query }): the
 * passages from the company's documents that match, fenced as reference
 * material. Only the words that are about THIS person and THIS campaign go
 * in; generic copy instructions would outweigh them in the ranking.
 */

/**
 * An ARE per-person sequence: the prospect's industry, role, company and
 * pains, the hook, and the campaign's own instructions. The template
 * skeletons are left out on purpose: their wording ("follow up", "mention
 * the value") repeats across every step and is about no one in particular.
 */
export function areKnowledgeQuery(
  prospect: { title?: string | null; industry?: string | null },
  intel: { companyOneLiner?: string | null },
  painSignals: { signal?: string; evidence?: string }[],
  primaryHook: string,
  campaignText: string[],
): string {
  return [
    prospect.industry,
    prospect.title,
    intel.companyOneLiner,
    ...painSignals.map((p) => [p.signal, p.evidence].filter(Boolean).join(" ")),
    primaryHook,
    ...campaignText,
  ]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

/**
 * A website chat turn (owner ask 2026-10-05: "Give the chat agent the
 * passages too"): the visitor's last three messages, so a follow-up ("and
 * for five users?") still finds the page the first question did, plus the
 * page they are on. The agent's own words are left out: it would be
 * searching for what it already said.
 */
export function chatKnowledgeQuery(messages: { role: string; text?: string | null }[] | undefined, pageContext?: string | null): string {
  const visitor = (messages ?? []).filter((m) => m.role === "visitor").slice(-3).map((m) => m.text);
  return [...visitor, pageContext].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n").slice(0, 4000);
}

/**
 * A meeting proposal: the descriptor (their title and industry, or the gist
 * of the reply that asked for the meeting) and their company.
 */
export function proposalKnowledgeQuery(target: { descriptor?: string | null; company?: string | null }): string {
  return [target.descriptor, target.company].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n").slice(0, 4000);
}
