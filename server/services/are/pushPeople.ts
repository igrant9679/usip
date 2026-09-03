/**
 * pushPeople — the ONE write path that puts existing People into an ARE
 * campaign. Extracted from are.prospects.pushExisting (phase 3, 2026-09-02)
 * so the campaign router's auto mode and the manual "Add to…" menu insert
 * rows through exactly the same identity dedupe, cross-engine check, and
 * enrich → sequence follow-up. Two insert sites would drift.
 *
 * The DECISION for one candidate — refuse, and why, or admit — lives in
 * `classifyPushCandidate` below, a pure function over the identity index and
 * the active-sequence lookup. The Add-existing wizard's preview
 * (services/are/addExistingPreview.ts) calls the same function over the same
 * inputs, so what the wizard shows before the click is what the push does
 * after it. A preview with its own copy of these rules would agree with
 * itself and drift from here (mirror-test bug class).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects, prospectQueue } from "../../../drizzle/schema";
import { existingClaim, queueIdentityKeys, type QueueIdentityShape } from "./queueIdentity";
import type { ActiveSequenceHit } from "../crossEngineEnrollment";

export interface PushResult {
  added: Array<{ prospectId: number; queueId: number }>;
  skipped: Array<{ prospectId: number; reason: string }>;
}

export type PushVerdictKind = "ready" | "active_sequence" | "unidentifiable" | "already_here" | "other_campaign";

export type PushVerdict =
  | { kind: "ready"; reason: null }
  | { kind: "active_sequence"; reason: string; sequenceId: number; sequenceName: string }
  | { kind: "unidentifiable"; reason: string }
  | { kind: "already_here"; reason: string; rowId: number }
  | { kind: "other_campaign"; reason: string; campaignId: number | null; rowId: number };

/**
 * What the push will do with one person, in the order the push checks:
 *   1. a Sequence is actively working them → refuse (two engines, one inbox)
 *   2. no identity key at all → refuse (cannot be deduped, ever)
 *   3. the identity is already claimed by a queue row → refuse, naming the
 *      campaign (this one, or another — exclusivity is workspace-wide)
 *   4. otherwise → ready
 *
 * `index` is the workspace queue identity index; `seqHits` the ACTIVE
 * sequence hits for this person (undefined = none). Pure: no I/O.
 */
export function classifyPushCandidate(
  shape: QueueIdentityShape,
  campaignId: number,
  index: Map<string, { rowId: number; campaignId: number | null }>,
  seqHits: ActiveSequenceHit[] | undefined,
): PushVerdict {
  if (seqHits?.length) {
    return {
      kind: "active_sequence",
      reason: `In an active sequence ("${seqHits[0].sequenceName}") — exit it first so two engines don't mail them`,
      sequenceId: seqHits[0].sequenceId,
      sequenceName: seqHits[0].sequenceName,
    };
  }
  // Identity-less rows are refused at ingest everywhere else; a manual
  // push is no exception. Without a key this person cannot be deduped,
  // and the queue fills with untraceable duplicates.
  if (queueIdentityKeys(shape).length === 0) {
    return { kind: "unidentifiable", reason: "No email, LinkedIn URL, or name + company to identify them by" };
  }
  const claim = existingClaim(index, shape);
  if (claim) {
    if (claim.campaignId === campaignId) {
      return { kind: "already_here", reason: "Already in this campaign", rowId: claim.rowId };
    }
    return {
      kind: "other_campaign",
      reason: `Already in another campaign (id ${claim.campaignId ?? "—"}) — a prospect can only be in one at a time`,
      campaignId: claim.campaignId,
      rowId: claim.rowId,
    };
  }
  return { kind: "ready", reason: null };
}

/** The identity shape the queue vocabulary reads from a People row. */
export function identityShapeOfPerson(p: {
  email: unknown; linkedinUrl: unknown; firstName: unknown; lastName: unknown; company: unknown; companyDomain: unknown;
}): QueueIdentityShape {
  return {
    email: p.email, linkedinUrl: p.linkedinUrl,
    firstName: p.firstName, lastName: p.lastName,
    companyName: p.company, companyDomain: p.companyDomain,
  };
}

export async function pushPeopleIntoCampaign(
  workspaceId: number,
  campaignId: number,
  prospectIds: number[],
  opts: { generateSequence?: boolean; routing?: { fit: number; reasoning: string | null } | null } = {},
): Promise<PushResult> {
  const db = await getDb();
  const added: PushResult["added"] = [];
  const skipped: PushResult["skipped"] = [];
  if (!db || prospectIds.length === 0) return { added, skipped };

  const people = await db
    .select({
      id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName,
      email: prospects.email, linkedinUrl: prospects.linkedinUrl, phone: prospects.phone,
      title: prospects.title, company: prospects.company, companyDomain: prospects.companyDomain,
    })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, prospectIds)));

  const { workspaceQueueIdentityIndex } = await import("./queueIdentity");
  const { activeSequencesForProspects } = await import("../crossEngineEnrollment");
  const index = await workspaceQueueIdentityIndex(workspaceId);
  // The other engine's view: a person a Sequence is actively working must
  // not also be picked up by a campaign.
  const inSequence = await activeSequencesForProspects(workspaceId, people.map((p) => p.id));

  for (const p of people) {
    const shape = identityShapeOfPerson(p);
    const verdict = classifyPushCandidate(shape, campaignId, index, inSequence.get(p.id));
    if (verdict.kind !== "ready") {
      skipped.push({ prospectId: p.id, reason: verdict.reason });
      continue;
    }

    const [row] = await db.insert(prospectQueue).values({
      workspaceId,
      campaignId,
      sourceType: "internal_contact",
      firstName: p.firstName, lastName: p.lastName,
      email: p.email, linkedinUrl: p.linkedinUrl, phone: p.phone,
      title: p.title, companyName: p.company, companyDomain: p.companyDomain,
      // The link back to People — what keeps enrichment, field history and
      // the drawer pointing at one person rather than a queue-only copy.
      personProspectId: p.id,
      // A routed person carries the router's fit so screening sees a real
      // score; a manual push stays 0 — the enrichment selector's "unscored,
      // let it through" escape hatch.
      icpMatchScore: opts.routing?.fit ?? 0,
      enrichmentStatus: "pending",
      sequenceStatus: "pending",
    }).$returningId();

    added.push({ prospectId: p.id, queueId: row.id });
    // Claim the identity for the rest of THIS batch too, so pushing the
    // same person twice in one selection cannot slip past.
    for (const k of queueIdentityKeys(shape)) if (!index.has(k)) index.set(k, { rowId: row.id, campaignId });
  }

  // Enrich → sequence, in that order, off the request path.
  const { runEnrichAgent, runSequenceAgent } = await import("../../routers/are/prospects");
  for (const a of added) {
    void (async () => {
      await runEnrichAgent(a.queueId, workspaceId);
      if (opts.generateSequence !== false) {
        // allowWithoutIntel: enrichment may legitimately find nothing for
        // this person, and a manual push should still produce a sequence.
        await runSequenceAgent(a.queueId, workspaceId, campaignId, { force: false, allowWithoutIntel: true });
      }
    })().catch((e) => console.error(`[pushPeopleIntoCampaign] queue ${a.queueId}:`, (e as Error)?.message ?? e));
  }

  return { added, skipped };
}
