/**
 * Scoring context loader + field resolver.
 *
 * Loads the object being scored (prospect/contact → person, account → company)
 * plus the minimal compliance/quality signals the fit models reference, then
 * resolves a criterion's `field_name` to a comparable value. Unknown fields
 * fall back to the row, then enrichmentData / customFields JSON, so custom
 * criteria keep working without code changes.
 *
 * Every query is workspace-scoped.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects, contacts, accounts, emailSuppressions, scoreResults, scoreModels,
} from "../../../drizzle/schema";
import type { ObjectType, Rating } from "./types";

export interface ScoringContext {
  objectType: ObjectType;
  objectId: number;
  workspaceId: number;
  object: Record<string, unknown>;
  nowMs: number;
  isUnsubscribed: boolean;
  isHardBounced: boolean;
  isSuppressed: boolean;
  /** Company Fit rating of the person's company (person overlay only). */
  companyFitRating: Rating | null;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

async function suppressionFlags(ws: number, email: string | null | undefined) {
  const out = { isUnsubscribed: false, isHardBounced: false, isSuppressed: false };
  if (!email) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = await db.select({ reason: emailSuppressions.reason })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.workspaceId, ws), eq(emailSuppressions.email, email)));
  for (const r of rows) {
    if (r.reason === "unsubscribe") { out.isUnsubscribed = true; out.isSuppressed = true; }
    if (r.reason === "bounce") { out.isHardBounced = true; }
    if (r.reason === "spam_complaint" || r.reason === "manual") { out.isSuppressed = true; }
  }
  return out;
}

/** Best-effort Company Fit rating for a person's company (matched by domain). */
async function companyFitForDomain(ws: number, domain: string | null | undefined): Promise<Rating | null> {
  if (!domain) return null;
  const db = await getDb();
  if (!db) return null;
  const acct = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.domain, domain))).limit(1);
  if (!acct.length) return null;
  const model = await db.select({ id: scoreModels.id }).from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.objectType, "company"),
      eq(scoreModels.isPrimary, true), eq(scoreModels.status, "active"))).limit(1);
  if (!model.length) return null;
  const res = await db.select({ rating: scoreResults.rating }).from(scoreResults)
    .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.scoreModelId, model[0].id),
      eq(scoreResults.objectType, "company"), eq(scoreResults.objectId, acct[0].id))).limit(1);
  return (res[0]?.rating as Rating) ?? null;
}

export async function loadScoringContext(
  workspaceId: number, objectType: ObjectType, objectId: number,
): Promise<ScoringContext | null> {
  const db = await getDb();
  if (!db) return null;
  const nowMs = Date.now();

  if (objectType === "person") {
    // Prospect first; fall back to contact (both are "person" objects).
    let row: Record<string, unknown> | undefined;
    const pr = await db.select().from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, objectId))).limit(1);
    row = pr[0] as Record<string, unknown> | undefined;
    if (!row) {
      const co = await db.select().from(contacts)
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, objectId))).limit(1);
      row = co[0] as Record<string, unknown> | undefined;
    }
    if (!row) return null;
    const email = (row.email as string | null) ?? null;
    const flags = await suppressionFlags(workspaceId, email);
    // Compliance: a rejected prospect is treated as suppressed (never enriched/scored for outreach).
    if (row.verificationStatus === "rejected") flags.isSuppressed = true;
    const companyFitRating = await companyFitForDomain(workspaceId, row.companyDomain as string | null);
    return { objectType, objectId, workspaceId, object: row, nowMs, ...flags, companyFitRating };
  }

  const ac = await db.select().from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, objectId))).limit(1);
  const row = ac[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    objectType, objectId, workspaceId, object: row, nowMs,
    isUnsubscribed: false, isHardBounced: false, isSuppressed: false, companyFitRating: null,
  };
}

function jsonField(obj: Record<string, unknown>, keys: string[], field: string): unknown {
  for (const k of keys) {
    const blob = obj[k];
    if (blob && typeof blob === "object") {
      const v = (blob as Record<string, unknown>)[field] ?? (blob as Record<string, unknown>)[camel(field)];
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** Resolve a criterion field_name to a comparable value for this object. */
export function resolveField(ctx: ScoringContext, fieldName: string): unknown {
  const o = ctx.object;
  const days = (d: unknown) => {
    const t = d ? new Date(d as string).getTime() : NaN;
    return Number.isNaN(t) ? null : Math.floor((ctx.nowMs - t) / 86400000);
  };
  switch (fieldName) {
    // ── person derived ──────────────────────────────────────────────
    case "location": return [o.city, o.state, o.country].filter(Boolean).join(", ");
    case "department": case "functional_area": return o.functionalArea ?? o.functional_area;
    case "has_verified_email": return ["verified", "valid", "safe"].includes(String(o.emailStatus ?? "")) || ["safe", "valid", "verified"].includes(String(o.emailVerificationStatus ?? ""));
    case "has_email": return !!o.email;
    case "has_phone": return !!o.phone;
    case "has_linkedin": case "has_linkedin_url": return !!(o.linkedinUrl ?? o.linkedin_url);
    case "has_current_title": return !!o.title;
    case "has_current_company": return !!o.company;
    case "has_company_domain": return !!o.companyDomain;
    case "data_age_days": return days(o.lastEnrichedAt ?? o.emailVerifiedAt ?? o.createdAt);
    case "company_fit_rating": return ctx.companyFitRating;
    case "is_suppressed": return ctx.isSuppressed;
    case "is_unsubscribed": return ctx.isUnsubscribed;
    case "is_hard_bounced": return ctx.isHardBounced;
    case "verification_status": return o.verificationStatus;
    // ── company derived ─────────────────────────────────────────────
    case "has_website": case "has_domain": return !!o.domain;
    case "employee_band": return o.employeeBand;
    case "revenue_band": return o.revenueBand;
    case "technologies": return jsonField(o, ["customFields", "enrichmentData"], "technologies");
    case "hiring_signals": return jsonField(o, ["customFields", "enrichmentData"], "hiringSignals");
    case "intent_topics": return jsonField(o, ["customFields", "enrichmentData"], "intentTopics");
    case "website_keywords": return jsonField(o, ["customFields", "enrichmentData"], "websiteKeywords");
    // ── direct column (snake or camel) ──────────────────────────────
    default: {
      if (fieldName in o) return o[fieldName];
      const c = camel(fieldName);
      if (c in o) return o[c];
      const fromJson = jsonField(o, ["enrichmentData", "customFields"], fieldName);
      return fromJson;
    }
  }
}

/** Short human display of a resolved value (for the breakdown "current value"). */
export function displayValue(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.slice(0, 6).map(String).join(", ").slice(0, 255);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 255);
}
