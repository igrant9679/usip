/**
 * PriorityScoreService — the six Velocity Priority Score components + blend.
 *
 *   priority = 0.35 personFit + 0.30 companyFit + 0.15 intent
 *            + 0.10 engagement + 0.05 dataQuality + 0.05 sequenceReadiness
 *
 * personFit / companyFit read the latest persisted result of the workspace's
 * PRIMARY person / company fit models. engagement, data-quality and
 * sequence-readiness are built-in calculators over real signals (activities,
 * enrollments, suppressions, field completeness). Weights are renormalized
 * over the components that actually apply to the object (a company has no
 * person-fit or sequence-readiness), so the blend always stays on 0..100.
 *
 * INTENT has two sources, and is NULL — renormalized away, not counted as a
 * zero — when neither measured anything:
 *   • tracked website visits (`website_visits.intent`, classified at write time
 *     by @shared/pageIntent). Contacts only; visits carry no prospect id.
 *   • the row's own signal JSON (intentTopics, hiringSignals, …).
 *
 * ⚠️ The JSON half has NO WRITER anywhere in this repo — every occurrence of
 * those keys is a read — so before website visits were wired in, intent was 0
 * for every row in the system while still consuming its full 0.15 weight. That
 * is a flat ~15% off every priority score: harmless to the ORDER, but it pushed
 * records down through the absolute hot/warm/cold thresholds.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import {
  scoreModels, scoreResults, priorityScoreResults,
  prospects, contacts, accounts, activities, enrollments, emailSuppressions,
  websiteVisits,
} from "../../../drizzle/schema";
import {
  PRIORITY_WEIGHTS, PRIORITY_THRESHOLDS, ratingFor, clamp, round2,
  type ObjectType, type PriorityComputation, type Rating,
} from "./types";

const DAY = 86400000;

/* ─── recency decay ─── */
function engagementDecay(ageDays: number): number {
  if (ageDays <= 7) return 1.0;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.5;
  if (ageDays <= 180) return 0.25;
  return 0.1;
}

/* ─── primary fit-model result lookups ─── */
async function primaryFitScore(ws: number, objectType: ObjectType, objectId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const [model] = await db.select({ id: scoreModels.id }).from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.objectType, objectType),
      eq(scoreModels.isPrimary, true), eq(scoreModels.status, "active"))).limit(1);
  if (!model) return null;
  const [res] = await db.select({ n: scoreResults.normalizedScore }).from(scoreResults)
    .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.scoreModelId, model.id),
      eq(scoreResults.objectType, objectType), eq(scoreResults.objectId, objectId))).limit(1);
  return res ? Number(res.n) : null;
}

/* ─── engagement (activities, decayed) ─── */
async function engagementScore(ws: number, objectId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select().from(activities)
    .where(and(eq(activities.workspaceId, ws), eq(activities.relatedId, objectId),
      inArray(activities.relatedType, ["prospect", "contact", "lead"])))
    .orderBy(desc(activities.occurredAt)).limit(200);
  const now = Date.now();
  let score = 0;
  for (const a of rows) {
    let base = 0;
    if (a.type === "meeting") base = 75;
    else if (a.type === "call") base = a.callDisposition === "connected" ? 25 : a.callDisposition === "callback_requested" ? 20 : 5;
    else if (a.type === "email") base = 5;
    else if (a.type === "linkedin") base = 10;
    if (!base) continue;
    const age = Math.max(0, Math.floor((now - new Date(a.occurredAt).getTime()) / DAY));
    score += base * engagementDecay(age);
  }
  return round2(clamp(score, 0, 100));
}

/* ─── intent ─── */

/** The signal keys the JSON calculator understands. */
const INTENT_JSON_KEYS = [
  "intentTopics",
  "hiringSignals",
  "websiteKeywords",
  "recentFunding",
  "recentExecChange",
  "recentNews",
] as const;

/**
 * Intent from the row's own signal JSON.
 *
 * 🔴 Returns NULL when the row carries no intent data at all, where it used to
 * return 0. `blend()` skips null components and renormalises — that is how a
 * company already reports "no person-fit" — and this function was the one place
 * that answered "not measured" with a hard zero.
 *
 * It mattered because NOTHING IN THE REPO WRITES THESE KEYS. Every occurrence
 * of intentTopics / hiringSignals / websiteKeywords / recentFunding /
 * recentExecChange / recentNews is a read. So intent was 0 for every row in the
 * system, and being counted at its full 0.15 weight it took a flat ~15% off
 * every priority score — which does not change the ORDER but does push records
 * down through the absolute hot/warm/cold thresholds.
 *
 * An empty array IS a measurement (`intentTopics: []` legitimately scores 0);
 * an absent key is not.
 */
function intentScoreFromRow(row: Record<string, unknown>): number | null {
  const cf = (row.customFields ?? row.enrichmentData) as Record<string, unknown> | null;
  if (!cf || typeof cf !== "object") return null;
  if (!INTENT_JSON_KEYS.some((k) => k in cf)) return null;
  let score = 0;
  const arr = (k: string) => (Array.isArray((cf as Record<string, unknown>)[k]) ? ((cf as Record<string, unknown>)[k] as unknown[]) : []);
  const topics = arr("intentTopics");
  if (topics.length) score += Math.min(30, 10 * topics.length);
  if (arr("hiringSignals").length) score += 15;
  if (arr("websiteKeywords").length) score += 10;
  if (cf.recentFunding) score += 10;
  if (cf.recentExecChange) score += 8;
  if (cf.recentNews) score += 10;
  return round2(clamp(score, 0, 100));
}

/**
 * Intent from tracked website visits — a signal this app ALREADY COLLECTS.
 *
 * `website_visits.intent` is written by the public tracker and classified at
 * write time by `@shared/pageIntent` (a `/pricing` hit is high, `/careers` is
 * not a buying signal). Until now its only reader was the /v2/website-visitors
 * list: a real, per-person intent signal sitting next to a scorer that was
 * looking for keys nothing writes.
 *
 * Pure so every band and decay case is testable without a database.
 *
 * Returns the STRONGEST decayed signal rather than a sum: five visits to
 * /pricing is one person interested in pricing, not five times the intent.
 * Null — not 0 — when there are no visits, for the same reason as above.
 */
export function intentFromVisitRows(
  rows: Array<{ intent: string | null; createdAt: Date | string }>,
  nowMs: number,
): number | null {
  const BAND: Record<string, number> = { high: 100, medium: 55, low: 20 };
  let best = 0;
  let measured = false;
  for (const r of rows) {
    const base = BAND[String(r.intent ?? "").toLowerCase()];
    if (base === undefined) continue; // unclassified visit says nothing
    const t = new Date(r.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    measured = true;
    const age = Math.max(0, Math.floor((nowMs - t) / DAY));
    // The same decay curve as engagement — one recency rule, not a second one.
    best = Math.max(best, base * engagementDecay(age));
  }
  return measured ? round2(clamp(best, 0, 100)) : null;
}

/**
 * Visit-derived intent for a CONTACT.
 *
 * Scoped on workspaceId AND contactId. `website_visits` takes its contactId
 * from a PUBLIC, unauthenticated beacon — the cross-tenant hole fixed in
 * `24c720e` — so a read that keys on the id alone is exactly the mistake that
 * bug was.
 */
async function websiteIntentScore(ws: number, contactId: number, nowMs: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ intent: websiteVisits.intent, createdAt: websiteVisits.createdAt })
    .from(websiteVisits)
    .where(and(eq(websiteVisits.workspaceId, ws), eq(websiteVisits.contactId, contactId)))
    .orderBy(desc(websiteVisits.createdAt))
    .limit(200);
  return intentFromVisitRows(rows, nowMs);
}

/** The strongest available signal, or null when none was measured. */
function strongestIntent(...values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? Math.max.apply(null, present) : null;
}

/* ─── data quality ─── */
function personDataQuality(o: Record<string, unknown>, flags: { bounced: boolean }, nowMs: number): number {
  let raw = 0;
  const maxPossible = 100;
  if (o.firstName && o.lastName) raw += 10;
  if (o.title) raw += 10;
  if (o.company) raw += 10;
  if (o.companyDomain) raw += 10;
  if (["verified", "valid", "safe"].includes(String(o.emailStatus ?? "")) || ["safe", "valid", "verified"].includes(String(o.emailVerificationStatus ?? ""))) raw += 25;
  if (o.phone) raw += 15;
  if (o.linkedinUrl ?? o.linkedin_url) raw += 10;
  if (o.city || o.state || o.country) raw += 5;
  const enrichedAt = o.lastEnrichedAt ?? o.emailVerifiedAt;
  const ageDays = enrichedAt ? Math.floor((nowMs - new Date(enrichedAt as string).getTime()) / DAY) : null;
  if (ageDays != null && ageDays <= 30) raw += 5;
  if (ageDays != null && ageDays > 180) raw -= 15;
  if (flags.bounced) raw -= 40;
  return round2(clamp((raw / maxPossible) * 100, 0, 100));
}

function companyDataQuality(o: Record<string, unknown>): number {
  let raw = 0;
  const maxPossible = 100;
  if (o.name) raw += 20;
  if (o.domain) raw += 20;
  if (o.industry) raw += 20;
  if (o.employeeBand) raw += 15;
  if (o.revenueBand) raw += 15;
  if (o.region) raw += 10;
  return round2(clamp((raw / maxPossible) * 100, 0, 100));
}

/* ─── sequence readiness (person only) ─── */
export interface SequenceReadiness { score: number; notReady: boolean; reasons: string[]; }
async function sequenceReadiness(
  ws: number, objectId: number, o: Record<string, unknown>,
  flags: { unsubscribed: boolean; bounced: boolean; suppressed: boolean },
): Promise<SequenceReadiness> {
  const db = await getDb();
  const reasons: string[] = [];
  const hasEmail = !!o.email;
  const verified = ["verified", "valid", "safe"].includes(String(o.emailStatus ?? "")) || ["safe", "valid", "verified"].includes(String(o.emailVerificationStatus ?? ""));
  if (!hasEmail) reasons.push("Missing email");
  if (flags.suppressed) reasons.push("Suppressed");
  if (flags.unsubscribed) reasons.push("Unsubscribed");
  if (flags.bounced) reasons.push("Hard bounced");

  let activeSeq = false;
  if (db) {
    const [enr] = await db.select({ id: enrollments.id }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, ws), eq(enrollments.prospectId, objectId), eq(enrollments.status, "active"))).limit(1);
    activeSeq = !!enr;
  }

  const hardFail = reasons.length > 0;
  if (hardFail) return { score: 0, notReady: true, reasons };

  const maxPossible = 130; // sum of all positive criteria
  let raw = 0;
  if (verified) raw += 25;
  if (o.firstName && o.company) raw += 20;         // personalization fields present
  if (!activeSeq) raw += 15;                        // not already enrolled
  raw += 20;                                        // not suppressed (checked above)
  raw += 20;                                        // not unsubscribed (checked above)
  raw += 10;                                        // mailbox/send limits assumed available
  if (!flags.bounced) raw += 10;                    // no recent bounce
  const score = round2(clamp((raw / maxPossible) * 100, 0, 100));
  return { score, notReady: false, reasons: [] };
}

/* ─── suppression flags (shared) ─── */
async function personFlags(ws: number, email: string | null | undefined, verificationStatus: unknown) {
  const out = { unsubscribed: false, bounced: false, suppressed: verificationStatus === "rejected" };
  if (!email) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = await db.select({ reason: emailSuppressions.reason }).from(emailSuppressions)
    .where(and(eq(emailSuppressions.workspaceId, ws), eq(emailSuppressions.email, email)));
  for (const r of rows) {
    if (r.reason === "unsubscribe") { out.unsubscribed = true; out.suppressed = true; }
    if (r.reason === "bounce") out.bounced = true;
    if (r.reason === "spam_complaint" || r.reason === "manual") out.suppressed = true;
  }
  return out;
}

/* ─── blend ─── */
function blend(components: Partial<Record<keyof typeof PRIORITY_WEIGHTS, number | null>>): { score: number; rating: Rating } {
  let weighted = 0, wsum = 0;
  for (const [k, w] of Object.entries(PRIORITY_WEIGHTS) as [keyof typeof PRIORITY_WEIGHTS, number][]) {
    const v = components[k];
    if (v == null) continue;
    weighted += v * w; wsum += w;
  }
  const score = wsum > 0 ? round2(clamp(weighted / wsum, 0, 100)) : 0;
  return { score, rating: ratingFor(score, PRIORITY_THRESHOLDS) };
}

export interface PriorityResult extends PriorityComputation { sequenceReadiness: SequenceReadiness | null; }

export async function calculatePriorityForObject(
  ws: number, objectType: ObjectType, objectId: number,
): Promise<PriorityResult | null> {
  const db = await getDb();
  if (!db) return null;
  const nowMs = Date.now();

  if (objectType === "person") {
    let o = (await db.select().from(prospects)
      .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, objectId))).limit(1))[0] as Record<string, unknown> | undefined;
    // Which table the person came from decides whether website visits can be
    // attributed: website_visits carries contactId/leadId, never a prospectId.
    let isContact = false;
    if (!o) {
      o = (await db.select().from(contacts)
        .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, objectId))).limit(1))[0] as Record<string, unknown> | undefined;
      isContact = !!o;
    }
    if (!o) return null;

    const flags = await personFlags(ws, o.email as string | null, o.verificationStatus);
    const personFit = await primaryFitScore(ws, "person", objectId);

    // Company overlay by domain.
    let companyFit: number | null = null;
    if (o.companyDomain) {
      const [acct] = await db.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.workspaceId, ws), eq(accounts.domain, o.companyDomain as string))).limit(1);
      if (acct) companyFit = await primaryFitScore(ws, "company", acct.id);
    }
    const engagement = await engagementScore(ws, objectId);
    // Two possible sources, and null unless at least one actually measured
    // something. Visits only attach to a contact.
    const intent = strongestIntent(
      intentScoreFromRow(o),
      isContact ? await websiteIntentScore(ws, objectId, nowMs) : null,
    );
    const dataQuality = personDataQuality(o, { bounced: flags.bounced }, nowMs);
    const seq = await sequenceReadiness(ws, objectId, o, flags);

    const { score, rating } = blend({
      person_fit: personFit, company_fit: companyFit, intent,
      engagement, data_quality: dataQuality, sequence_readiness: seq.score,
    });
    return {
      personFitScore: personFit, companyFitScore: companyFit, intentScore: intent,
      engagementScore: engagement, dataQualityScore: dataQuality, sequenceReadinessScore: seq.score,
      priorityScore: score, priorityRating: rating, sequenceReadiness: seq,
    };
  }

  // company
  const [o] = await db.select().from(accounts)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, objectId))).limit(1);
  if (!o) return null;
  const row = o as Record<string, unknown>;
  const companyFit = await primaryFitScore(ws, "company", objectId);
  const engagement = await engagementScore(ws, objectId);
  const intent = intentScoreFromRow(row);
  const dataQuality = companyDataQuality(row);
  const { score, rating } = blend({
    company_fit: companyFit, intent, engagement, data_quality: dataQuality,
    person_fit: null, sequence_readiness: null,
  });
  return {
    personFitScore: null, companyFitScore: companyFit, intentScore: intent,
    engagementScore: engagement, dataQualityScore: dataQuality, sequenceReadinessScore: null,
    priorityScore: score, priorityRating: rating, sequenceReadiness: null,
  };
}

export async function persistPriority(ws: number, objectType: ObjectType, objectId: number, p: PriorityComputation): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const dec = (n: number | null) => (n == null ? null : String(n));
  const [existing] = await db.select({ id: priorityScoreResults.id }).from(priorityScoreResults)
    .where(and(eq(priorityScoreResults.workspaceId, ws), eq(priorityScoreResults.objectType, objectType),
      eq(priorityScoreResults.objectId, objectId))).limit(1);
  const values = {
    workspaceId: ws, objectType, objectId,
    personFitScore: dec(p.personFitScore), companyFitScore: dec(p.companyFitScore),
    intentScore: dec(p.intentScore), engagementScore: dec(p.engagementScore),
    dataQualityScore: dec(p.dataQualityScore), sequenceReadinessScore: dec(p.sequenceReadinessScore),
    priorityScore: String(p.priorityScore), priorityRating: p.priorityRating, calculatedAt: new Date(),
  };
  if (existing) await db.update(priorityScoreResults).set(values as never).where(eq(priorityScoreResults.id, existing.id));
  else await db.insert(priorityScoreResults).values(values as never);
}
