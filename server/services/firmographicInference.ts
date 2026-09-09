/**
 * firmographicInference — fill blank company industry / country (and the
 * people under them) by inference, honestly labelled.
 *
 * Owner ask 2026-09-09 ("do option 3"): CommunityForce had 1,311 people and
 * 685 companies with NO industry and mostly no country, so campaign proposals
 * could not cluster them. Velocity has no firmographics provider (company
 * enrichment is identification-only by the 2026-08-11 decision), so the only
 * source available today is the model reading the company's own name, domain,
 * website and description plus a few employee titles.
 *
 * Rules that keep this honest:
 *   - Fills BLANKS only. Never displaces a value any other source wrote.
 *   - Every write is recorded: an organization_enrichment_events row
 *     (sourceVendor "ai_inference") per company, and on people the country
 *     goes through the provenance ledger at low confidence (35) so a real
 *     source replaces it on the next pass; industry has no ledger slot, so it
 *     is written directly and the event row is its audit.
 *   - "Unknown" is not written. It is recorded as an event so the company is
 *     not retried for 30 days.
 *   - Serial, paced, background: one model call per company (~1/s), no
 *     userId on the call so the per-user burst limit does not apply, and a
 *     failure on one company never stops the run.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { accounts, organizationEnrichmentEvents, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { mergeAll, type ProvenanceMap } from "./enrichment/fieldMerge";

export const AI_INFERENCE_VENDOR = "ai_inference";
export const AI_INFERENCE_CONFIDENCE = 35;
const RETRY_AFTER_DAYS = 30;

/** A compact, campaign-useful taxonomy. The model must pick one or "Unknown". */
export const INDUSTRIES = [
  "Nonprofit", "Foundation / Philanthropy", "Higher Education", "K-12 Education", "Government", "Healthcare",
  "Financial Services", "Insurance", "SaaS", "IT Services", "Telecommunications", "Media & Entertainment",
  "Manufacturing", "Construction", "Real Estate", "Retail", "Consumer Goods", "Hospitality & Travel",
  "Transportation & Logistics", "Energy & Utilities", "Agriculture", "Professional Services", "Legal",
  "Marketing & Advertising", "Staffing & HR", "Pharmaceuticals & Biotech", "Aerospace & Defense",
  "Automotive", "Religious Organization", "Membership Association", "Other",
] as const;

type Inference = { industry: string | null; country: string | null; confidence: number; reasoning: string };

async function inferOne(workspaceId: number, facts: { name: string | null; domain: string | null; website: string | null; description: string | null; city: string | null; state: string | null; titles: string[] }): Promise<Inference> {
  const res = await invokeLLM({
    workspaceId,
    messages: [
      { role: "system", content: "You classify organisations for a B2B CRM. From the facts given, choose the organisation's industry from the list and its headquarters country. If the facts do not support a confident answer, say Unknown — never guess a country from a name alone. Return JSON only." },
      { role: "user", content:
        `Name: ${facts.name ?? "unknown"}\nDomain: ${facts.domain ?? "unknown"}\nWebsite: ${facts.website ?? "unknown"}\n` +
        `Description: ${(facts.description ?? "").slice(0, 600) || "none"}\nKnown city/state: ${[facts.city, facts.state].filter(Boolean).join(", ") || "none"}\n` +
        `Employee titles seen: ${facts.titles.slice(0, 5).join("; ") || "none"}\n\n` +
        `Industries (pick exactly one, or Unknown): ${INDUSTRIES.join(" | ")}\n` +
        `Country: the full English country name (e.g. United States, United Kingdom, Australia) or Unknown. A .gov domain is United States; .gov.au is Australia; .ac.uk / .org.uk / .co.uk is United Kingdom; .ca is Canada; .edu is United States unless the facts say otherwise.` },
    ],
    outputSchema: {
      name: "firmographics",
      schema: {
        type: "object",
        properties: {
          industry: { type: "string", enum: [...INDUSTRIES, "Unknown"] },
          country: { type: "string" },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          reasoning: { type: "string" },
        },
        required: ["industry", "country", "confidence", "reasoning"],
        additionalProperties: false,
      },
    },
    max_tokens: 200,
  });
  const raw = res.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "{}";
  let parsed: Partial<Inference> = {};
  try { parsed = JSON.parse(text); } catch { /* fall through to Unknown */ }
  const industry = typeof parsed.industry === "string" && (INDUSTRIES as readonly string[]).includes(parsed.industry) ? parsed.industry : null;
  const countryRaw = typeof parsed.country === "string" ? parsed.country.trim() : "";
  const country = countryRaw && !/^unknown$/i.test(countryRaw) && countryRaw.length <= 80 ? countryRaw : null;
  const confidence = Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(100, Number(parsed.confidence))) : 0;
  return { industry, country, confidence, reasoning: String(parsed.reasoning ?? "").slice(0, 300) };
}

export interface InferenceTally { companiesTried: number; companiesFilled: number; peopleFilled: number; unlinkedGroupsTried: number; unlinkedPeopleFilled: number; unknown: number; failed: number }

/** Companies still blank in industry or country, not tried in the last 30 days. */
export async function firmographicStatus(workspaceId: number): Promise<{ companiesBlank: number; companiesTriedRecently: number; peopleBlankIndustry: number; peopleBlankCountry: number; unlinkedPeopleBlank: number }> {
  const db = await getDb();
  if (!db) return { companiesBlank: 0, companiesTriedRecently: 0, peopleBlankIndustry: 0, peopleBlankCountry: 0, unlinkedPeopleBlank: 0 };
  const since = new Date(Date.now() - RETRY_AFTER_DAYS * 86400000);
  const [[cb], [ct], [pi], [pc], [up]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), or(isNull(accounts.industry), isNull(accounts.hqCountry)))),
    db.select({ n: sql<number>`count(distinct ${organizationEnrichmentEvents.accountId})` }).from(organizationEnrichmentEvents).where(and(eq(organizationEnrichmentEvents.workspaceId, workspaceId), eq(organizationEnrichmentEvents.sourceVendor, AI_INFERENCE_VENDOR), gte(organizationEnrichmentEvents.createdAt, since))),
    db.select({ n: sql<number>`count(*)` }).from(prospects).where(and(eq(prospects.workspaceId, workspaceId), isNull(prospects.industry))),
    db.select({ n: sql<number>`count(*)` }).from(prospects).where(and(eq(prospects.workspaceId, workspaceId), isNull(prospects.country))),
    db.select({ n: sql<number>`count(*)` }).from(prospects).where(and(eq(prospects.workspaceId, workspaceId), isNull(prospects.accountId), isNull(prospects.industry))),
  ]);
  return { companiesBlank: Number(cb?.n ?? 0), companiesTriedRecently: Number(ct?.n ?? 0), peopleBlankIndustry: Number(pi?.n ?? 0), peopleBlankCountry: Number(pc?.n ?? 0), unlinkedPeopleBlank: Number(up?.n ?? 0) };
}

/** Apply an inference to the people under a company / in a group: blanks only, country through the ledger. */
async function applyToPeople(workspaceId: number, ids: number[], inf: Inference, now: string): Promise<number> {
  const db = await getDb();
  if (!db || ids.length === 0) return 0;
  const rows = await db.select({ id: prospects.id, industry: prospects.industry, country: prospects.country, fieldProvenance: prospects.fieldProvenance })
    .from(prospects).where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, ids)));
  let filled = 0;
  for (const p of rows) {
    const patch: Record<string, unknown> = {};
    if (!p.industry && inf.industry) patch.industry = inf.industry;
    if (!p.country && inf.country) {
      const merged = mergeAll({ country: p.country }, (p.fieldProvenance ?? {}) as ProvenanceMap, [
        { field: "country", value: inf.country, source: AI_INFERENCE_VENDOR, confidence: AI_INFERENCE_CONFIDENCE, at: now },
      ]);
      if (merged.fields.country) { patch.country = merged.fields.country; patch.fieldProvenance = merged.ledger; }
    }
    if (Object.keys(patch).length === 0) continue;
    await db.update(prospects).set(patch as never).where(and(eq(prospects.id, p.id), eq(prospects.workspaceId, workspaceId)));
    filled++;
  }
  return filled;
}

/**
 * The pass. Serial and bounded; intended to be started fire-and-forget from
 * a procedure and observed through firmographicStatus.
 */
export async function runFirmographicInference(workspaceId: number, opts: { limit?: number; dryRun?: boolean; onProgress?: (t: InferenceTally) => void } = {}): Promise<InferenceTally> {
  const tally: InferenceTally = { companiesTried: 0, companiesFilled: 0, peopleFilled: 0, unlinkedGroupsTried: 0, unlinkedPeopleFilled: 0, unknown: 0, failed: 0 };
  const db = await getDb();
  if (!db) return tally;
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 800));
  const since = new Date(Date.now() - RETRY_AFTER_DAYS * 86400000);

  // ── Companies ──
  const tried = await db.select({ accountId: organizationEnrichmentEvents.accountId }).from(organizationEnrichmentEvents)
    .where(and(eq(organizationEnrichmentEvents.workspaceId, workspaceId), eq(organizationEnrichmentEvents.sourceVendor, AI_INFERENCE_VENDOR), gte(organizationEnrichmentEvents.createdAt, since)));
  const triedIds = new Set(tried.map((t) => t.accountId).filter((x): x is number => typeof x === "number"));
  const candidates = (await db.select().from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), or(isNull(accounts.industry), isNull(accounts.hqCountry))))
    .orderBy(desc(accounts.id)).limit(limit + triedIds.size)).filter((a) => !triedIds.has(a.id)).slice(0, limit);

  for (const acct of candidates) {
    tally.companiesTried++;
    try {
      const people = await db.select({ id: prospects.id, title: prospects.title }).from(prospects)
        .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.accountId, acct.id))).limit(25);
      const inf = await inferOne(workspaceId, {
        name: acct.name, domain: acct.domain, website: acct.websiteUrl, description: acct.description,
        city: acct.hqCity, state: acct.hqState, titles: people.map((p) => p.title).filter((t): t is string => !!t),
      });
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {};
      const fieldsUpdated: string[] = [];
      if (!acct.industry && inf.industry) { patch.industry = inf.industry; fieldsUpdated.push("industry"); }
      if (!acct.hqCountry && inf.country) { patch.hqCountry = inf.country; fieldsUpdated.push("hqCountry"); }
      if (!opts.dryRun) {
        if (fieldsUpdated.length > 0) {
          await db.update(accounts).set(patch as never).where(and(eq(accounts.id, acct.id), eq(accounts.workspaceId, workspaceId)));
          tally.companiesFilled++;
          tally.peopleFilled += await applyToPeople(workspaceId, people.map((p) => p.id), inf, now);
        } else {
          tally.unknown++;
        }
        await db.insert(organizationEnrichmentEvents).values({
          workspaceId, accountId: acct.id, globalOrganizationId: acct.globalOrganizationId ?? null,
          sourceVendor: AI_INFERENCE_VENDOR, sourceType: "model_inference",
          status: fieldsUpdated.length > 0 ? "enriched" : "no_result",
          fieldsUpdated: fieldsUpdated.length ? fieldsUpdated : null, enrichedByUserId: null,
        } as never);
      } else if (fieldsUpdated.length > 0) tally.companiesFilled++; else tally.unknown++;
    } catch (e) {
      tally.failed++;
      console.error(`[FirmographicInference] account ${acct.id} failed:`, (e as Error).message);
    }
    opts.onProgress?.(tally);
    await new Promise((r) => setTimeout(r, 400));
  }

  // ── People with no company link: one inference per distinct company name/domain ──
  const unlinked = await db.select({ id: prospects.id, company: prospects.company, companyDomain: prospects.companyDomain, title: prospects.title, industry: prospects.industry, country: prospects.country })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), isNull(prospects.accountId), or(isNull(prospects.industry), isNull(prospects.country))))
    .limit(2000);
  const groups = new Map<string, typeof unlinked>();
  for (const p of unlinked) {
    const key = (p.companyDomain ?? "").toLowerCase().trim() || (p.company ?? "").toLowerCase().trim();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  let groupBudget = Math.max(0, limit - tally.companiesTried);
  for (const [, members] of Array.from(groups.entries())) {
    if (groupBudget-- <= 0) break;
    tally.unlinkedGroupsTried++;
    try {
      const sample = members[0];
      const inf = await inferOne(workspaceId, {
        name: sample.company, domain: sample.companyDomain, website: null, description: null, city: null, state: null,
        titles: members.map((m) => m.title).filter((t): t is string => !!t),
      });
      if (!inf.industry && !inf.country) { tally.unknown++; continue; }
      if (!opts.dryRun) tally.unlinkedPeopleFilled += await applyToPeople(workspaceId, members.map((m) => m.id), inf, new Date().toISOString());
    } catch (e) {
      tally.failed++;
      console.error(`[FirmographicInference] group failed:`, (e as Error).message);
    }
    opts.onProgress?.(tally);
    await new Promise((r) => setTimeout(r, 400));
  }
  return tally;
}
