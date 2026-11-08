/**
 * What the workflow rule editor offers as names instead of ids (audit
 * 2026-10-20, G71: it asked for a user id, a sequence id, a stage key typed by
 * hand, an account id in a condition) and what its dry run picks a record
 * from (F46). Everything here is read in the caller's workspace only.
 */
import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { accounts, areCampaigns, contacts, crmPipelineStages, leads, opportunities, sequences, tasks, users, workspaceMembers } from "../../drizzle/schema";
import { LEGACY_STAGE_KEYS } from "../_core/stageSemantics";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type EditorOptions = {
  users: Array<{ id: number; name: string }>;
  sequences: Array<{ id: number; name: string; status: string }>;
  stages: Array<{ key: string; label: string }>;
  /** Revenue Engine campaigns, for a signal rule's campaign condition. */
  campaigns: Array<{ id: number; name: string }>;
};

/** People who still work here, every sequence, and every stage key with its label. */
export async function workflowEditorOptions(db: Db, workspaceId: number): Promise<EditorOptions> {
  const [members, seqs, stageRows, camps] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deactivatedAt))),
    db.select({ id: sequences.id, name: sequences.name, status: sequences.status })
      .from(sequences).where(eq(sequences.workspaceId, workspaceId)).orderBy(desc(sequences.id)).limit(500),
    db.select({ key: crmPipelineStages.key, label: crmPipelineStages.label })
      .from(crmPipelineStages).where(eq(crmPipelineStages.workspaceId, workspaceId)).orderBy(crmPipelineStages.sortOrder),
    db.select({ id: areCampaigns.id, name: areCampaigns.name })
      .from(areCampaigns).where(eq(areCampaigns.workspaceId, workspaceId)).orderBy(desc(areCampaigns.id)).limit(500),
  ]);
  const stages: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  for (const s of stageRows) if (!seen.has(s.key)) { seen.add(s.key); stages.push({ key: s.key, label: s.label || s.key }); }
  // A workspace with no pipeline configured uses the legacy keys (crm.ts seeds them).
  if (stages.length === 0) for (const k of LEGACY_STAGE_KEYS) stages.push({ key: k, label: k[0]!.toUpperCase() + k.slice(1) });
  return {
    users: members.map((m) => ({ id: m.id, name: m.name || m.email || `User ${m.id}` })).sort((a, b) => a.name.localeCompare(b.name)),
    sequences: seqs.map((s) => ({ id: s.id, name: s.name || `Sequence ${s.id}`, status: String(s.status) })),
    stages,
    campaigns: camps.map((c) => ({ id: c.id, name: c.name || `Campaign ${c.id}` })),
  };
}

export type RecordPickType = "lead" | "contact" | "opportunity" | "task" | "account";
export type RecordPick = { id: number; label: string; sub: string | null };

const full = (f?: string | null, l?: string | null) => [f, l].filter(Boolean).join(" ");

/**
 * Up to 20 records of one type matching `q` by name or email (most recent
 * first when `q` is empty), or exactly the ones named by `ids` so a saved
 * value can be shown by name.
 */
export async function searchWorkflowRecords(
  db: Db,
  workspaceId: number,
  type: RecordPickType,
  q: string | undefined,
  ids?: number[],
): Promise<RecordPick[]> {
  const term = (q ?? "").trim().slice(0, 80);
  const pat = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const byIds = ids && ids.length ? ids.slice(0, 50) : null;
  if (type === "lead") {
    const rows = await db.select({ id: leads.id, firstName: leads.firstName, lastName: leads.lastName, email: leads.email, company: leads.company })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId),
        byIds ? inArray(leads.id, byIds) : term ? or(like(leads.firstName, pat), like(leads.lastName, pat), like(leads.email, pat), like(leads.company, pat)) : undefined))
      .orderBy(desc(leads.id)).limit(20);
    return rows.map((r) => ({ id: r.id, label: full(r.firstName, r.lastName) || r.email || `Lead ${r.id}`, sub: [r.email, r.company].filter(Boolean).join(" · ") || null }));
  }
  if (type === "contact") {
    const rows = await db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, title: contacts.title })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId),
        byIds ? inArray(contacts.id, byIds) : term ? or(like(contacts.firstName, pat), like(contacts.lastName, pat), like(contacts.email, pat)) : undefined))
      .orderBy(desc(contacts.id)).limit(20);
    return rows.map((r) => ({ id: r.id, label: full(r.firstName, r.lastName) || r.email || `Contact ${r.id}`, sub: [r.email, r.title].filter(Boolean).join(" · ") || null }));
  }
  if (type === "opportunity") {
    const rows = await db.select({ id: opportunities.id, name: opportunities.name, stage: opportunities.stage })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, workspaceId), byIds ? inArray(opportunities.id, byIds) : term ? like(opportunities.name, pat) : undefined))
      .orderBy(desc(opportunities.id)).limit(20);
    return rows.map((r) => ({ id: r.id, label: r.name || `Deal ${r.id}`, sub: r.stage ?? null }));
  }
  if (type === "task") {
    const rows = await db.select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), byIds ? inArray(tasks.id, byIds) : term ? like(tasks.title, pat) : undefined))
      .orderBy(desc(tasks.id)).limit(20);
    return rows.map((r) => ({ id: r.id, label: r.title || `Task ${r.id}`, sub: r.status ?? null }));
  }
  const rows = await db.select({ id: accounts.id, name: accounts.name, domain: accounts.domain })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), byIds ? inArray(accounts.id, byIds) : term ? or(like(accounts.name, pat), like(accounts.domain, pat)) : undefined))
    .orderBy(desc(accounts.id)).limit(20);
  return rows.map((r) => ({ id: r.id, label: r.name || `Account ${r.id}`, sub: r.domain ?? null }));
}
