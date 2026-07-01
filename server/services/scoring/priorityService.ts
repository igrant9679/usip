/**
 * PriorityScoreService — the six Velocity Priority Score components + blend.
 *
 *   priority = 0.35 personFit + 0.30 companyFit + 0.15 intent
 *            + 0.10 engagement + 0.05 dataQuality + 0.05 sequenceReadiness
 *
 * personFit / companyFit read the latest persisted result of the workspace's
 * PRIMARY person / company fit models. intent, engagement, data-quality and
 * sequence-readiness are built-in calculators over real signals (activities,
 * enrollments, suppressions, field completeness). Weights are renormalized
 * over the components that actually apply to the object (a company has no
 * person-fit or sequence-readiness), so the blend always stays on 0..100.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import {
  scoreModels, scoreResults, priorityScoreResults,
  prospects, contacts, accounts, activities, enrollments, emailSuppressions,
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

/* ─── intent (best-effort from firmographic/signal JSON) ─── */
function intentScoreFromRow(row: Record<string, unknown>): number {
  const cf = (row.customFields ?? row.enrichmentData) as Record<string, unknown> | null;
  if (!cf || typeof cf !== "object") return 0;
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

/* ─── data quality ─── */
function personDataQuality(o: Record<string, unknown>, flags: { bounced: boolean }, nowMs: number): number {
  let raw = 0;
  const maxPossible = 100;
  if (o.firstName && o.lastName) raw += 10;
  if (o.title) raw += 10;
  if (o.company) raw += 10;
  if (o.companyDomain) raw += 10;
  if (o.emailStatus === "verified" || o.emailVerificationStatus === "safe") raw += 25;
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
  const verified = o.emailStatus === "verified" || o.emailVerificationStatus === "safe";
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
    if (!o) o = (await db.select().from(contacts)
      .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, objectId))).limit(1))[0] as Record<string, unknown> | undefined;
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
    const intent = intentScoreFromRow(o);
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
