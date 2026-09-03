/**
 * addExistingPreview — a read-only REHEARSAL of pushPeopleIntoCampaign for
 * the Add-existing wizard on a Revenue Engine campaign (owner ask
 * 2026-09-03: bulk select, a table view, duplicate verification, and whether
 * and where each person already sits in other campaigns or sequences).
 *
 * Per selected person it answers exactly what the write path would do — by
 * calling the SAME classifier (classifyPushCandidate) over the SAME identity
 * index and the SAME active-sequence lookup the write path builds. A preview
 * that reimplemented those rules would agree with itself and drift from the
 * push (mirror-test bug class). On top of that it adds what the push does
 * not need but a human wants before confirming:
 *
 *   - duplicates WITHIN the selection: two People rows that are one human by
 *     the queue identity vocabulary. The push would admit the first and
 *     refuse the second as "Already in this campaign"; the wizard marks the
 *     later one up front so the user sees it is one person, not two.
 *   - other People rows OUTSIDE the selection that share an email or LinkedIn
 *     URL — the CRM holds two records for one person. Informational.
 *   - every campaign and sequence membership, active OR past, with status.
 *     The push refuses only on ACTIVE sequences and on any queue claim; the
 *     rest is shown so "is this person anywhere else?" has a full answer.
 */
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { areCampaigns, prospects } from "../../../drizzle/schema";
import { queueIdentityKeys, workspaceQueueIdentityIndex } from "./queueIdentity";
import { classifyPushCandidate, identityShapeOfPerson, type PushVerdictKind } from "./pushPeople";
import {
  ACTIVE_ENROLLMENT_STATUSES, ACTIVE_QUEUE_STATUSES,
  activeSequencesForProspects, campaignMembershipsForProspects, sequenceMembershipsForProspects,
} from "../crossEngineEnrollment";

export type PreviewVerdict = PushVerdictKind | "duplicate";

export const PREVIEW_VERDICTS: PreviewVerdict[] = ["ready", "already_here", "other_campaign", "active_sequence", "duplicate", "unidentifiable"];

export interface PreviewRow {
  prospectId: number;
  name: string;
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  verdict: PreviewVerdict;
  reason: string | null;
  /** The queue claim behind an already_here / other_campaign verdict. */
  claim: { campaignId: number | null; campaignName: string | null } | null;
  /** The earlier-selected person this row is a duplicate of. */
  duplicateOf: { prospectId: number; name: string } | null;
  /** Other People rows (not selected) that share an email or LinkedIn URL. */
  crmDuplicates: Array<{ prospectId: number; name: string; email: string | null; via: "email" | "linkedin" }>;
  campaigns: Array<{ campaignId: number; campaignName: string; sequenceStatus: string; active: boolean; isThisCampaign: boolean }>;
  sequences: Array<{ sequenceId: number; sequenceName: string; status: string; currentStep: number; active: boolean }>;
}

export interface PreviewResult {
  campaign: { id: number; name: string };
  rows: PreviewRow[];
  counts: Record<PreviewVerdict, number>;
}

/**
 * Union-find over identity keys: prospectId → the LOWEST prospectId that
 * shares a key with it, transitively (itself when it is first of its group).
 * Lowest-id-wins mirrors workspaceQueueIdentityIndex, where on a collision
 * the first (lowest-id) row wins. Pure.
 */
export function groupSelectionByIdentity(rows: Array<{ prospectId: number; keys: string[] }>): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  const owner = new Map<string, number>();
  const sorted = rows.slice().sort((a, b) => a.prospectId - b.prospectId);
  for (const r of sorted) parent.set(r.prospectId, r.prospectId);
  for (const r of sorted) {
    for (const k of r.keys) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, r.prospectId); else union(r.prospectId, o);
    }
  }
  const out = new Map<number, number>();
  for (const r of sorted) out.set(r.prospectId, find(r.prospectId));
  return out;
}

const emptyCounts = (): Record<PreviewVerdict, number> => ({
  ready: 0, already_here: 0, other_campaign: 0, active_sequence: 0, duplicate: 0, unidentifiable: 0,
});

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export async function previewAddExisting(
  workspaceId: number,
  campaign: { id: number; name: string },
  prospectIds: number[],
): Promise<PreviewResult> {
  const db = await getDb();
  const counts = emptyCounts();
  const ids = Array.from(new Set(prospectIds));
  if (!db || ids.length === 0) return { campaign, rows: [], counts };

  const people = await db
    .select({
      id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName,
      email: prospects.email, emailStatus: prospects.emailStatus, linkedinUrl: prospects.linkedinUrl,
      title: prospects.title, company: prospects.company, companyDomain: prospects.companyDomain,
    })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, ids)));
  if (people.length === 0) return { campaign, rows: [], counts };
  const peopleIds = people.map((p) => p.id);

  // The push's own inputs (same index, same active lookup) + the history.
  const [index, activeSeq, allSeq, allCamp] = await Promise.all([
    workspaceQueueIdentityIndex(workspaceId),
    activeSequencesForProspects(workspaceId, peopleIds),
    sequenceMembershipsForProspects(workspaceId, peopleIds),
    campaignMembershipsForProspects(workspaceId, peopleIds),
  ]);

  const nameOf = (p: { firstName: unknown; lastName: unknown; email?: unknown; id: number }) =>
    `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || String(p.email ?? "") || `#${p.id}`;
  const byId = new Map(people.map((p) => [p.id, p]));

  const shaped = people.map((p) => {
    const shape = identityShapeOfPerson(p);
    return { p, shape, keys: queueIdentityKeys(shape) };
  });
  const primaryOf = groupSelectionByIdentity(shaped.map((s) => ({ prospectId: s.p.id, keys: s.keys })));

  // Other People records for the same human — email or LinkedIn URL, exact
  // after lowercasing. Name+org is deliberately NOT used here: it would need
  // a scan of every row in the workspace, and a name match across records is
  // the kind of "same person" guess this codebase refuses to make on its own.
  const emails = Array.from(new Set(people.map((p) => norm(p.email)).filter(Boolean)));
  const urls = Array.from(new Set(people.map((p) => norm(p.linkedinUrl)).filter(Boolean)));
  const others = emails.length || urls.length
    ? await db
        .select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, email: prospects.email, linkedinUrl: prospects.linkedinUrl })
        .from(prospects)
        .where(and(
          eq(prospects.workspaceId, workspaceId),
          notInArray(prospects.id, peopleIds),
          or(
            emails.length ? inArray(sql`LOWER(${prospects.email})`, emails) : sql`false`,
            urls.length ? inArray(sql`LOWER(${prospects.linkedinUrl})`, urls) : sql`false`,
          ),
        ))
    : [];
  const othersByEmail = new Map<string, typeof others>();
  const othersByUrl = new Map<string, typeof others>();
  for (const o of others) {
    const e = norm(o.email); if (e) othersByEmail.set(e, [...(othersByEmail.get(e) ?? []), o]);
    const u = norm(o.linkedinUrl); if (u) othersByUrl.set(u, [...(othersByUrl.get(u) ?? []), o]);
  }

  // Classify first, so the campaign names a claim points at can be fetched
  // in one query.
  const verdicts = shaped.map((s) => ({ ...s, verdict: classifyPushCandidate(s.shape, campaign.id, index, activeSeq.get(s.p.id)) }));
  const claimIds = new Set<number>();
  for (const v of verdicts) if (v.verdict.kind === "other_campaign" && v.verdict.campaignId != null) claimIds.add(v.verdict.campaignId);
  const claimNames = new Map<number, string>();
  if (claimIds.size > 0) {
    const rows = await db.select({ id: areCampaigns.id, name: areCampaigns.name }).from(areCampaigns)
      .where(and(eq(areCampaigns.workspaceId, workspaceId), inArray(areCampaigns.id, Array.from(claimIds))));
    for (const r of rows) claimNames.set(r.id, r.name);
  }

  const activeSeqSet = new Set<string>(ACTIVE_ENROLLMENT_STATUSES);
  const activeQueueSet = new Set<string>(ACTIVE_QUEUE_STATUSES);

  const rows: PreviewRow[] = verdicts.map(({ p, verdict: v }) => {
    const primary = primaryOf.get(p.id);
    const dupOf = primary != null && primary !== p.id ? byId.get(primary) : undefined;
    // A person the push would admit, but who is the same human as an earlier
    // pick, is a duplicate — the push would refuse the second insert anyway
    // ("Already in this campaign", claimed within the batch); naming it up
    // front is the whole point of the verify step.
    const verdict: PreviewVerdict = v.kind === "ready" && dupOf ? "duplicate" : v.kind;
    const reason = verdict === "duplicate" && dupOf
      ? `Same person as ${nameOf(dupOf)} (also selected) — only one is added`
      : v.reason;
    counts[verdict] += 1;

    const claim = v.kind === "already_here"
      ? { campaignId: campaign.id, campaignName: campaign.name }
      : v.kind === "other_campaign"
        ? { campaignId: v.campaignId, campaignName: v.campaignId != null ? claimNames.get(v.campaignId) ?? null : null }
        : null;

    const seen = new Set<number>();
    const crmDuplicates: PreviewRow["crmDuplicates"] = [];
    const e = norm(p.email);
    for (const o of e ? othersByEmail.get(e) ?? [] : []) {
      if (seen.has(o.id)) continue; seen.add(o.id);
      crmDuplicates.push({ prospectId: o.id, name: nameOf(o), email: o.email, via: "email" });
    }
    const u = norm(p.linkedinUrl);
    for (const o of u ? othersByUrl.get(u) ?? [] : []) {
      if (seen.has(o.id)) continue; seen.add(o.id);
      crmDuplicates.push({ prospectId: o.id, name: nameOf(o), email: o.email, via: "linkedin" });
    }

    return {
      prospectId: p.id,
      name: nameOf(p),
      email: p.email ?? null,
      emailStatus: p.emailStatus ?? null,
      title: p.title ?? null,
      company: p.company ?? null,
      linkedinUrl: p.linkedinUrl ?? null,
      verdict,
      reason,
      claim,
      duplicateOf: dupOf ? { prospectId: dupOf.id, name: nameOf(dupOf) } : null,
      crmDuplicates,
      campaigns: (allCamp.get(p.id) ?? []).map((h) => ({
        campaignId: h.campaignId, campaignName: h.campaignName, sequenceStatus: h.sequenceStatus,
        active: activeQueueSet.has(h.sequenceStatus), isThisCampaign: h.campaignId === campaign.id,
      })),
      sequences: (allSeq.get(p.id) ?? []).map((h) => ({
        sequenceId: h.sequenceId, sequenceName: h.sequenceName, status: h.status, currentStep: h.currentStep,
        active: activeSeqSet.has(h.status),
      })),
    };
  });

  // Keep the caller's order (the selection order the user built).
  const pos = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (pos.get(a.prospectId) ?? 0) - (pos.get(b.prospectId) ?? 0));
  return { campaign, rows, counts };
}
