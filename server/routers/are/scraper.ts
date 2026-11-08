/**
 * ARE — Scraper Router
 *
 * AI-powered prospect discovery from multiple web sources:
 *   - Google Business Profile (company listings, ratings, categories)
 *   - LinkedIn company pages and people search (via Unipile + LLM)
 *   - General web scraping (company websites, directories)
 *   - News monitoring (funding, hires, product launches, expansions)
 *   - Industry events (conferences, trade shows, speaker lists)
 *
 * The LLM acts as the extraction and normalisation engine for all sources.
 * Raw HTML/text is passed to the LLM which extracts structured prospect data.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, areScrapeJobs, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { parseLlmJson } from "./llmJson";
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { managerProcedure, workspaceProcedure, isAdminRole } from "../../_core/workspace";
import { cleanScrapedField, isPlaceholderToken, usableDomainOrNull, usableEmailOrNull, usablePhoneOrNull } from "@shared/fieldHygiene";
import { searchLinkedInProfiles } from "../../services/linkedinLookup";
import { queueIdentityColumns } from "../../services/are/queueIdentity";
import { safeFetch } from "../../services/scraper/ssrfGuard";
import { findSuppression } from "../../services/suppression";

// isAdminRole comes from _core/workspace.ts — one rank map for the repo.

/**
 * Real LinkedIn people search via Unipile (replaces the old fabricating
 * scrapeLinkedIn). Routes through the workspace's bridged LinkedIn account
 * pool and maps verified hits into the prospect-queue shape. Returns [] when
 * no account is bridged or the search fails — never invented data.
 */
async function realLinkedInSearch(
  ctx: { workspace: { id: number }; user: { id: number }; member: { role: string } },
  query: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const res = await searchLinkedInProfiles({
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    isAdmin: isAdminRole(ctx.member.role),
    keywords: query,
    limit: Math.min(Math.max(limit, 1), 25),
    source: "scraper",
  });
  if (!res.ok) return [];
  return res.hits.map((h) => ({
    firstName: h.firstName,
    lastName: h.lastName,
    title: h.headline,
    companyName: h.company,
    linkedinUrl: h.linkedinUrl,
    sourceUrl: h.linkedinUrl,
    geography: h.location,
  }));
}

/* ─── Shared prospect extraction schema ─────────────────────────────────── */

const PROSPECT_EXTRACTION_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "extracted_prospects",
    strict: true,
    schema: {
      type: "object",
      properties: {
        prospects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              firstName: { type: "string" },
              lastName: { type: "string" },
              title: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
              linkedinUrl: { type: "string" },
              companyName: { type: "string" },
              companyDomain: { type: "string" },
              companySize: { type: "string" },
              industry: { type: "string" },
              geography: { type: "string" },
              sourceUrl: { type: "string" },
              triggerEvent: { type: "string" },
              confidence: { type: "number" },
            },
            required: [
              "firstName", "lastName", "title", "email", "phone",
              "linkedinUrl", "companyName", "companyDomain", "companySize",
              "industry", "geography", "sourceUrl", "triggerEvent", "confidence",
            ],
            additionalProperties: false,
          },
        },
        summary: { type: "string" },
      },
      required: ["prospects", "summary"],
      additionalProperties: false,
    },
  },
};

/* ─── Fetch helper with timeout + HTML cleanup ──────────────────────────
 *
 * Raw HTML is hugely token-inefficient — a typical Google SERP is 200k+
 * chars of inline scripts, CSS, base64 images, and tracking IDs. The LLM
 * only needs the visible text + anchor hrefs to extract prospects. We
 * strip everything else BEFORE sending, which cuts the prompt size ~10×
 * and the token bill proportionally. Cap at 6000 chars of cleaned text
 * (was 8000 of raw HTML) — roughly the same useful signal at ~25% the
 * tokens. */

function cleanForLLM(rawHtml: string): string {
  let s = rawHtml;
  // Drop script/style/noscript blocks entirely — pure overhead.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  // Drop HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Drop SVGs (often huge inline icons).
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  // Strip remaining tags but keep their text + href attribute values
  // so anchor URLs (LinkedIn profile URLs etc.) survive extraction.
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi, " [$1] ");
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities the LLM doesn't need to see encoded.
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s.substring(0, 6000);
}

/**
 * Through the SSRF guard (audit 2026-10-20): `scrapeWeb` takes a member's URL
 * as-is, and a plain fetch would have read cloud metadata or anything on the
 * private network and handed the body to the LLM — and back to the caller.
 */
/**
 * Audit 2026-10-20 (A25): the status was never checked, so Google's 429 and
 * its "unusual traffic" page were cleaned and handed to the model as search
 * results — a paid model call on a refusal page, every tick. A refusal now
 * throws, and every caller already treats a failed fetch as "nothing found".
 */
export function refusalOf(status: number, body: string): string | null {
  if (status === 429) return "rate limited (HTTP 429)";
  if (status >= 400) return `HTTP ${status}`;
  // Google's own refusal pages only: a company page that loads a captcha
  // widget is still a page with content.
  if (/our systems have detected unusual traffic|\/sorry\/index|before you continue to google/i.test(body.slice(0, 20000))) {
    return "a captcha or consent page, not results";
  }
  return null;
}

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; USIP-ARE/1.0; +https://usipsales.manus.space)",
      },
    });
    const text = await res.text();
    const refused = refusalOf(res.status, text);
    if (refused) throw new Error(`${new URL(url).hostname} refused the request: ${refused}`);
    return cleanForLLM(text);
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Google Business scraper ───────────────────────────────────────────── */

export async function scrapeGoogleBusiness(
  workspaceId: number,
  campaignId: number | null,
  query: string,
  icpContext: string,
  pages = 3,
): Promise<Array<Record<string, unknown>>> {
  // Page through the SERP (start=0,10,20…) and extract per page, merging
  // unique prospects across pages. A page that fails to fetch or comes back
  // empty stops paging — we do NOT fall back to "use your knowledge", which
  // would fabricate businesses that don't exist.
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (let page = 0; page < pages; page++) {
    const start = page * 10;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + " site:google.com/maps OR business")}&num=20&start=${start}`;
    let rawContent = "";
    try {
      rawContent = await fetchWithTimeout(searchUrl);
    } catch {
      break;
    }
    if (!rawContent.trim()) break;

    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a B2B prospect researcher. Extract business prospect information ONLY from the provided Google Business search results — never invent businesses that aren't present in the content. Focus on companies matching the ICP: ${icpContext}. Never invent a person: a name goes in firstName/lastName only if that person's name appears in the content.`,
        },
        {
          role: "user",
          // Audit 2026-10-20, P73: this asked for "the business owner/manager
          // as the contact" where no person was found, which invites a name.
          content: `Search query: "${query}" (results page ${page + 1})\n\nRaw content:\n${rawContent}\n\nExtract up to 10 business prospects that actually appear in the content above. Where the content names no person for a business, leave firstName, lastName and title blank and give the business only. Only output an email if it appears in the content; otherwise leave email blank.`,
        },
      ],
      response_format: PROSPECT_EXTRACTION_SCHEMA,
      workspaceId,
      maxTokens: 1500,
      temperature: 0.3,
    });

    const content = result.choices[0]?.message?.content;
    if (!content) continue;
    const parsed = parseLlmJson(content, "scrapeGoogleBusiness");
    for (const p of dropUnsourcedPeople((parsed.prospects ?? []) as Array<Record<string, unknown>>, rawContent)) {
      const key = String(p.linkedinUrl || p.email || `${p.firstName}|${p.lastName}|${p.companyName}`).toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
  }
  return merged;
}

/* ─── General web scraper ────────────────────────────────────────────────── */

export async function scrapeWeb(
  workspaceId: number,
  campaignId: number | null,
  urlOrQuery: string,
  icpContext: string,
): Promise<Array<Record<string, unknown>>> {
  // A bare (non-URL) query has no live page to extract from — there's no
  // search API wired here, so the only thing the LLM could do is invent
  // prospects from memory. Refuse rather than fabricate.
  if (!urlOrQuery.startsWith("http")) {
    console.warn(`[scrapeWeb] non-URL query "${urlOrQuery}" skipped — no live page to extract from`);
    return [];
  }
  let rawContent = "";
  try {
    rawContent = await fetchWithTimeout(urlOrQuery);
  } catch {
    return []; // fetch failed — no content, don't guess
  }
  if (!rawContent.trim()) return [];

  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B prospect researcher. Extract prospect information ONLY from the provided web page content — never invent people or companies that don't appear in it. ICP context: ${icpContext}. Look for company listings, team pages, about pages, directory listings, or any content that identifies potential B2B prospects.`,
      },
      {
        role: "user",
        content: `Source: ${urlOrQuery}\n\nContent:\n${rawContent}\n\nExtract up to 10 prospect contacts that actually appear in the content above. Identify the most senior decision-maker present. Only output an email if it appears in the content; otherwise leave it blank.`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
    workspaceId,
    maxTokens: 1500,
    temperature: 0.3,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = parseLlmJson(content, "scrapeWeb");
  return parsed.prospects ?? [];
}

/* ─── News monitor ───────────────────────────────────────────────────────── */

export async function scrapeNews(
  workspaceId: number,
  campaignId: number | null,
  query: string,
  icpContext: string,
): Promise<Array<Record<string, unknown>>> {
  // Search news sources for trigger events
  const newsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let rawContent = "";
  try {
    rawContent = await fetchWithTimeout(newsUrl);
  } catch {
    return []; // news feed unreachable — don't fabricate from memory
  }
  if (!rawContent.trim()) return [];

  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B sales intelligence analyst. Analyse ONLY the provided news content to identify companies experiencing trigger events (funding rounds, new executive hires, product launches, expansion announcements, new office openings, partnerships, IPO filings) that make them ideal prospects — never invent companies or events absent from the content. ICP context: ${icpContext}`,
      },
      {
        role: "user",
        // P73: this asked for "the most relevant decision-maker to contact",
        // which the model answered with a name whether or not one was there.
        content: `News search: "${query}"\n\nContent:\n${rawContent}\n\nFor each company actually mentioned in the content, identify: (1) the trigger event, (2) a person named in the content in connection with it, if there is one — otherwise leave firstName, lastName and title blank; never supply a name the content does not contain, (3) why this trigger event makes them a good prospect right now. Extract up to 10 prospects. Only output an email if it appears in the content.`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
    workspaceId,
    maxTokens: 1500,
    temperature: 0.3,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = parseLlmJson(content, "scrapeNews");
  return dropUnsourcedPeople(parsed.prospects ?? [], rawContent);
}

/**
 * Research must not invent people (audit 2026-10-20, P73). A name — or an
 * email — the model returns that is not in the text it was given is taken
 * off the find, which stays as the company it is about. Compared without
 * case, accents or punctuation, a name counting when its first and last
 * words both appear.
 */
export function dropUnsourcedPeople(found: Array<Record<string, unknown>>, sourceText: string): Array<Record<string, unknown>> {
  const fold = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = ` ${fold(sourceText).replace(/[^a-z0-9@.]+/g, " ")} `;
  const hasWord = (w: string) => words.includes(` ${w} `) || words.includes(` ${w}. `);
  const wordsOf = (s: unknown) => fold(s).replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const text = fold(sourceText);
  return found.map((p) => {
    const first = wordsOf(p.firstName);
    const last = wordsOf(p.lastName);
    const named = first.length > 0 || last.length > 0;
    const sourced = named && first.every(hasWord) && last.every(hasWord);
    const email = String(p.email ?? "").trim();
    const out: Record<string, unknown> = { ...p };
    if (named && !sourced) {
      out.firstName = "";
      out.lastName = "";
      // A title guessed for the invented person goes with them.
      out.title = "";
    }
    if (email && !text.includes(fold(email))) out.email = "";
    return out;
  });
}

/* ─── Industry events scraper ────────────────────────────────────────────── */

export async function scrapeIndustryEvents(
  _workspaceId: number,
  _campaignId: number | null,
  query: string,
  _icpContext: string,
): Promise<Array<Record<string, unknown>>> {
  // DISABLED. This fetched nothing and asked the LLM to name "likely"
  // speakers/exhibitors with "their likely contact details" — pure
  // fabrication. Until a real event-data source (e.g. a conference
  // agenda/exhibitor-list fetch) is wired in, return nothing rather than
  // invent attendees.
  console.warn(`[scrapeIndustryEvents] disabled (was fabricating attendees). query="${query}"`);
  return [];
}

/* ─── Shared: save scrape job + queue prospects ─────────────────────────── */

/** The scrape job's own source vocabulary — the `are_scrape_jobs` enum. */
export type ScrapeSourceType =
  | "google_business" | "linkedin_company" | "linkedin_people" | "web_scrape"
  | "news" | "industry_events" | "apollo" | "internal" | "quickenrich" | "warmysender" | "leadocean";

/**
 * Sources that still exist in the enum and in stored history but cannot run,
 * with the sentence a caller should be told instead of a bare zero.
 *
 * `industry_events` fetched nothing and asked the model to name "likely"
 * speakers and exhibitors with "their likely contact details", so it was
 * disabled rather than left to invent attendees. **That guard holds** — the
 * function returns [] and logs.
 *
 * What it did not do was SAY so (found 2026-11-01). Both endpoints still wrote
 * a scrape job reading "No prospects returned — source returned nothing or
 * every result was deduplicated", which claims a search ran and found nobody,
 * and returned `count: 0` with no reason. That is the same shape as the four
 * uninstrumented sources reading "Ready", fixed the same night: a refusal the
 * code makes correctly and no surface reports, so an unknown reads as a
 * measurement. A zero and a refusal are different claims.
 *
 * NOT removed, deliberately. The endpoints, the type member and the
 * `are_scrape_jobs` / `prospect_queue` enum values all stay: deleting a source
 * from a DB enum rewrites stored history, `industry_event` queue rows may
 * predate the disable, and whether the feature comes back is the owner's call.
 * Honest, not absent.
 */
export const DISABLED_SCRAPE_SOURCES: Partial<Record<ScrapeSourceType, string>> = {
  industry_events:
    "Industry events is disabled — it had no event-data source and was inventing attendees, so nothing was searched and nothing was added. It stays off until a real agenda or exhibitor-list fetch is wired in.",
};

/** Column-width guards live inside @shared/fieldHygiene's cleaners now:
 *  scraped values regularly exceed the prospect_queue varchar widths
 *  (LinkedIn headlines ~220 chars vs title's varchar(120)), and MySQL strict
 *  mode rejects the ENTIRE multi-row INSERT — so every cleaner clamps too.
 *
 *  LLM scrapers emit placeholder tokens ("<UNKNOWN>", "N/A") when a source
 *  doesn't reveal a value. Names were cleaned from day one (a greet-able
 *  "Hi <UNKNOWN>" was the original bug); since 2026-08-12 EVERY scraped
 *  string field goes through @shared/fieldHygiene — the owner's screenshot
 *  showed "<UNKNOWN>" living in email/phone, where it blocked enrichment
 *  ("has an email" checks are truthiness checks) and hid the row from the
 *  sweeper. Migration 0159 repaired the rows already stored. */
function cleanName(v: unknown, max: number): string {
  return cleanScrapedField(v, max) ?? "";
}

export async function saveScrapeJobAndQueue(
  workspaceId: number,
  campaignId: number | null,
  sourceType: ScrapeSourceType,
  query: string,
  prospects: Array<Record<string, unknown>>,
  opts: {
    /**
     * The caller already filtered these rows against the workspace's whole
     * queue and claimed them within its own run (runDiscovery does, once per
     * run). Reading the whole queue again for every source it saves was the
     * engine's N+1 (audit 2026-10-20, A34). Every other caller leaves it unset.
     */
    identityChecked?: boolean;
  } = {},
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Campaign exclusivity belt (owner directive 2026-08-12): a person already
  // in ANY campaign's queue is never queued again — not for a sibling
  // campaign (one campaign per prospect) and not for the same one (dedup).
  // The engine pre-filters its own discovery; this is the choke point that
  // covers every other caller, so a new ingest path cannot skip the rule.
  if (campaignId && prospects.length > 0 && !opts.identityChecked) {
    const { queueIdentityIndexFor, existingClaim, queueIdentityKeys } = await import("../../services/are/queueIdentity");
    // Only the rows sharing a key with this batch, by index (A34).
    const index = await queueIdentityIndexFor(workspaceId, prospects);
    const before = prospects.length;
    // Claimed as each row is kept (audit A12): the same person twice in one
    // batch — two spellings of a profile URL, an address in two cases — both
    // passed a check against the index read before the batch, and both queued.
    prospects = prospects.filter((p) => {
      if (existingClaim(index, p)) return false;
      for (const k of queueIdentityKeys(p)) index.set(k, { rowId: 0, campaignId });
      return true;
    });
    const dropped = before - prospects.length;
    if (dropped > 0) {
      console.log(`[scraper] ws=${workspaceId} campaign=${campaignId}: ${dropped} prospect(s) dropped — identity already claimed in this workspace's queue`);
    }
  }

  // A queue row with NO name, NO LinkedIn and NO email is not a prospect —
  // it is a scrape artifact (news pages produce them) that renders as "—"
  // and can never be reconciled, enriched, or mailed. Refuse at ingest
  // (owner directive 2026-08-13); the audit used to flag these AFTER they
  // appeared, which meant every engine tick could mint new ones.
  {
    const before = prospects.length;
    prospects = prospects.filter((p) =>
      cleanName(p.firstName, 80) || cleanName(p.lastName, 80)
      || usableEmailOrNull(p.email)
      || (p.linkedinUrl && !isPlaceholderToken(p.linkedinUrl)),
    );
    const dropped = before - prospects.length;
    if (dropped > 0) {
      console.log(`[scraper] ws=${workspaceId} campaign=${campaignId ?? "-"}: ${dropped} identity-less row(s) refused (no name, no LinkedIn, no email)`);
    }
  }

  // A scrape that returned zero prospects is a *failed* run from the
  // user's perspective — typically the source returned nothing (blocked,
  // rate-limited, query too narrow) or every result was filtered out by
  // dedup. Mark it failed so it stands out in the Scraper tab; the
  // Logs tab still carries the per-source breakdown for why.
  const [job] = await db
    .insert(areScrapeJobs)
    .values({
      workspaceId,
      campaignId: campaignId ?? undefined,
      sourceType,
      query,
      status: prospects.length === 0 ? "failed" : "complete",
      resultCount: prospects.length,
      rawResults: prospects,
      // A disabled source did not search and find nobody — it did not search.
      // Saying the former in the audit row is how a refusal became a zero.
      errorMessage: prospects.length === 0
        ? DISABLED_SCRAPE_SOURCES[sourceType]
          ?? "No prospects returned — source returned nothing or every result was deduplicated"
        : null,
      scrapedAt: new Date(),
    })
    .$returningId();

  if (campaignId && prospects.length > 0) {
    const sourceTypeMap: Record<string, typeof prospectQueue.$inferInsert["sourceType"]> = {
      google_business: "google_business",
      linkedin_company: "linkedin_company",
      linkedin_people: "linkedin_people",
      web_scrape: "web_scrape",
      news: "news_event",
      industry_events: "industry_event",
      apollo: "apollo",
      internal: "internal_contact",
      quickenrich: "quickenrich",
      warmysender: "warmysender",
      leadocean: "leadocean",
    };

    // The internal-CRM source yields a MIX of contacts and leads in one batch,
    // which the job-level sourceType can't express. Rows may therefore carry
    // `__queueSourceType` to pin their own prospect_queue value; anything else
    // falls back to the job's mapping. Validated against the enum before use —
    // an out-of-set string here fails at runtime INSERT, not at compile time.
    const QUEUE_SOURCE_TYPES = new Set([
      "internal_contact", "internal_lead",
      "google_business", "linkedin_company", "linkedin_people",
      "web_scrape", "news_event", "industry_event",
      "apollo", "zoominfo", "clay", "ai_research",
      "quickenrich",
      "warmysender",
      "leadocean",
    ]);
    const rowSourceType = (p: Record<string, unknown>) => {
      const override = String(p.__queueSourceType ?? "");
      if (override && QUEUE_SOURCE_TYPES.has(override)) {
        return override as typeof prospectQueue.$inferInsert["sourceType"];
      }
      return sourceTypeMap[sourceType] ?? "web_scrape";
    };

    const candidates = prospects.map((p) => {
      // Shape rules, not just token cleaning: an email without an @ or a
      // phone without a digit is scraper garbage whatever it says.
      const email = usableEmailOrNull(p.email) ?? undefined;
      return {
        workspaceId,
        campaignId,
        sourceType: rowSourceType(p),
        sourceUrl: String(p.sourceUrl ?? ""), // text column — no clamp needed
        firstName: cleanName(p.firstName, 80),
        lastName: cleanName(p.lastName, 80),
        email,
        linkedinUrl: p.linkedinUrl && !isPlaceholderToken(p.linkedinUrl) ? String(p.linkedinUrl) : undefined, // text column
        phone: usablePhoneOrNull(p.phone) ?? undefined,
        title: cleanScrapedField(p.title, 120),
        companyName: cleanScrapedField(p.companyName, 200),
        companyDomain: usableDomainOrNull(p.companyDomain) ?? undefined,
        companySize: cleanScrapedField(p.companySize, 40),
        industry: cleanScrapedField(p.industry, 80),
        geography: cleanScrapedField(p.geography, 120),
        // Its stored keys, so the next check finds it by index (A34).
        ...queueIdentityColumns({ email, linkedinUrl: p.linkedinUrl && !isPlaceholderToken(p.linkedinUrl) ? String(p.linkedinUrl) : undefined, firstName: cleanName(p.firstName, 80), lastName: cleanName(p.lastName, 80), companyName: cleanScrapedField(p.companyName, 200), companyDomain: usableDomainOrNull(p.companyDomain) ?? undefined }),
        // int column 0-100 — round and clamp (scores can arrive as floats)
        icpMatchScore: Math.max(0, Math.min(100, Math.round(Number((p as any).icpMatchScore ?? 0) || 0))),
        enrichmentStatus: "pending" as const,
        /**
         * F17's auto-reject, carried on the row the way `__queueSourceType`
         * is. Queued as `skipped` WITH a reason rather than dropped, so the
         * Rejections tab shows them and restore puts them back — an
         * out-of-territory verdict is reversible and should look it.
         */
        ...((p as { __territoryReject?: string }).__territoryReject
          ? {
              rejectedAt: new Date(),
              rejectionKind: "territory" as const,
              rejectionReason: String((p as { __territoryReject?: string }).__territoryReject),
            }
          : {}),
        // THE NO-EMAIL DOOR (owner rule 2026-09-16, migration 0180): a
        // candidate without a usable address never enters the campaign's
        // working queue — it stages as 'sourcing' (hidden from the Prospects
        // tab and every counter) while the enrich phase hunts the email.
        // The engine's ADMIT step promotes it the moment one lands.
        sequenceStatus: ((p as { __territoryReject?: string }).__territoryReject
          ? "skipped"
          : email ? "pending" : "sourcing") as "pending" | "sourcing" | "skipped",
      };
    });

    /**
     * The ONE suppression check, at DISCOVERY (audit 2026-10-20, A8): someone
     * on either list — by address, LinkedIn profile or company domain — never
     * enters the queue, so no enrichment, scoring or review is spent on them.
     * A bounce alone does not keep them out; it stops their email steps.
     */
    const rows: typeof candidates = [];
    for (const r of candidates) {
      if (!(await findSuppression(workspaceId, { email: r.email, linkedinUrl: r.linkedinUrl, companyDomain: r.companyDomain }, "any"))) rows.push(r);
    }
    if (rows.length < candidates.length) {
      console.log(`[saveScrapeJobAndQueue] ${candidates.length - rows.length} suppressed candidate(s) not queued (campaign ${campaignId})`);
    }

    if (rows.length > 0) {
      try {
        await db.insert(prospectQueue).values(rows);
      } catch (batchErr) {
        // A single poisoned row must never discard the whole batch: retry
        // row-by-row so every valid prospect still lands, and surface the
        // first row-level cause for the Logs tab.
        let saved = 0;
        let firstRowErr: unknown = null;
        for (const r of rows) {
          try {
            await db.insert(prospectQueue).values(r);
            saved++;
          } catch (e) {
            if (!firstRowErr) firstRowErr = e;
          }
        }
        console.error(
          `[saveScrapeJobAndQueue] batch insert failed; per-row fallback saved ${saved}/${rows.length}.`,
          (batchErr as Error)?.message, firstRowErr,
        );
        if (saved === 0) throw batchErr;
      }

      // People-as-master (migration 0153): every retained campaign prospect
      // gets a canonical People record. Fire-and-forget — linking must never
      // fail an ingest; the boot backfill sweeps anything this misses.
      void import("../../services/personLink")
        .then((m) => m.linkUnlinkedQueueRows({ workspaceId, campaignId, limit: rows.length + 25 }))
        .then((r) => {
          if (r.linked > 0) console.log(`[personLink] campaign ${campaignId}: linked=${r.linked} created=${r.created} skipped=${r.skippedNoIdentity}`);
        })
        .catch((e) => console.error("[personLink] ingest link failed:", (e as Error)?.message ?? e));
    }
  }
}

/**
 * A scrape's campaign must be this workspace's (audit 2026-10-20, A42): the id
 * went into the job and every queued row as given, so a scrape could fill
 * another tenant's campaign queue. Checked before any source is searched.
 */
async function assertCampaignHere(workspaceId: number, campaignId: number | null | undefined): Promise<void> {
  if (campaignId == null) return;
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [c] = await db.select({ id: areCampaigns.id }).from(areCampaigns)
    .where(and(eq(areCampaigns.id, campaignId), eq(areCampaigns.workspaceId, workspaceId))).limit(1);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

/**
 * Running a scrape spends the workspace's source credits and fills a campaign's
 * review queue, so it is a manager's (audit 2026-10-20, A36). The job list
 * stays open to everyone.
 */
export const scraperRouter = router({
  /** List all scrape jobs for the workspace */
  /**
   * Recent scrape jobs for the Scraper tab: what the cards show, never
   * rawResults — every discovered prospect of every job, which the list sent
   * and nothing read (A44). At most 200, newest first, the id breaking ties.
   */
  listJobs: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areScrapeJobs.workspaceId, ctx.workspace.id)];
      if (input.campaignId) conditions.push(eq(areScrapeJobs.campaignId, input.campaignId));
      return db
        .select({
          id: areScrapeJobs.id, campaignId: areScrapeJobs.campaignId, sourceType: areScrapeJobs.sourceType,
          query: areScrapeJobs.query, status: areScrapeJobs.status, resultCount: areScrapeJobs.resultCount,
          errorMessage: areScrapeJobs.errorMessage, scrapedAt: areScrapeJobs.scrapedAt, createdAt: areScrapeJobs.createdAt,
        })
        .from(areScrapeJobs)
        .where(and(...conditions))
        .orderBy(desc(areScrapeJobs.createdAt), desc(areScrapeJobs.id))
        .limit(input.limit);
    }),

  /** Scrape Google Business listings */
  scrapeGoogleBusiness: managerProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const prospects = await scrapeGoogleBusiness(ctx.workspace.id, input.campaignId ?? null, input.query, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "google_business", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** LinkedIn search (company-oriented keywords) via real Unipile people search */
  scrapeLinkedInCompany: managerProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const prospects = await realLinkedInSearch(ctx, input.query, 25);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "linkedin_company", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** LinkedIn people search via real Unipile classic search */
  scrapeLinkedInPeople: managerProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const prospects = await realLinkedInSearch(ctx, input.query, 25);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "linkedin_people", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Scrape a specific URL or run a general web search */
  scrapeWeb: managerProcedure
    .input(z.object({ campaignId: z.number().optional(), urlOrQuery: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const prospects = await scrapeWeb(ctx.workspace.id, input.campaignId ?? null, input.urlOrQuery, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "web_scrape", input.urlOrQuery, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Monitor news for trigger events and extract prospects */
  scrapeNews: managerProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const prospects = await scrapeNews(ctx.workspace.id, input.campaignId ?? null, input.query, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "news", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /**
   * Industry events — DISABLED, and now it says which it is.
   *
   * No client calls this and none should: `scraper.run`, which the campaign's
   * Scraper tab uses, offers google_business / linkedin / web / news only. It
   * is still reachable over tRPC, and the owner drives this API directly, so
   * returning a bare `count: 0` left "no attendees matched my ICP"
   * indistinguishable from "this source does nothing and cannot".
   *
   * `disabled` is read from the map rather than hardcoded, so deleting the
   * entry when a real event-data source is wired in makes this null on its own.
   */
  scrapeIndustryEvents: managerProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const prospects = await scrapeIndustryEvents(ctx.workspace.id, input.campaignId ?? null, input.query, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "industry_events", input.query, prospects);
      return { count: prospects.length, prospects, disabled: DISABLED_SCRAPE_SOURCES.industry_events ?? null };
    }),

  /** Run all scrapers for a campaign: they search in parallel and save in turn (A12). */
  runFullScrape: managerProcedure
    .input(
      z.object({
        campaignId: z.number(),
        queries: z.object({
          googleBusiness: z.string().optional(),
          linkedinCompany: z.string().optional(),
          linkedinPeople: z.string().optional(),
          web: z.string().optional(),
          news: z.string().optional(),
          industryEvents: z.string().optional(),
        }),
        icpContext: z.string().default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      const results: Record<string, number> = {};
      // A source that cannot run must not arrive as a 0 beside sources that
      // searched and found nobody. Keyed by the same name as `breakdown`, so a
      // caller reading one finds the other.
      const disabled: Record<string, string> = {};
      const jobs: Array<{ key: string; sourceType: ScrapeSourceType; query: string; scrape: () => Promise<Array<Record<string, unknown>>> }> = [];
      const q = input.queries;
      if (q.googleBusiness) jobs.push({ key: "googleBusiness", sourceType: "google_business", query: q.googleBusiness, scrape: () => scrapeGoogleBusiness(ctx.workspace.id, input.campaignId, q.googleBusiness!, input.icpContext) });
      if (q.linkedinCompany) jobs.push({ key: "linkedinCompany", sourceType: "linkedin_company", query: q.linkedinCompany, scrape: () => realLinkedInSearch(ctx, q.linkedinCompany!, 25) });
      if (q.linkedinPeople) jobs.push({ key: "linkedinPeople", sourceType: "linkedin_people", query: q.linkedinPeople, scrape: () => realLinkedInSearch(ctx, q.linkedinPeople!, 25) });
      if (q.news) jobs.push({ key: "news", sourceType: "news", query: q.news, scrape: () => scrapeNews(ctx.workspace.id, input.campaignId, q.news!, input.icpContext) });
      if (q.industryEvents) {
        const why = DISABLED_SCRAPE_SOURCES.industry_events;
        if (why) disabled.industryEvents = why;
        // Still recorded, so the attempt keeps its place in the audit trail —
        // with its real reason in errorMessage, not the generic one.
        jobs.push({ key: "industryEvents", sourceType: "industry_events", query: q.industryEvents, scrape: () => scrapeIndustryEvents(ctx.workspace.id, input.campaignId, q.industryEvents!, input.icpContext) });
      }
      if (q.web) jobs.push({ key: "web", sourceType: "web_scrape", query: q.web, scrape: () => scrapeWeb(ctx.workspace.id, input.campaignId, q.web!, input.icpContext) });

      /**
       * Scraped in parallel, SAVED ONE AT A TIME (audit 2026-10-20, A12). Saved
       * in parallel, every save read the queue before any of them wrote, so a
       * person two sources both found was queued twice. In turn, each save
       * sees what the one before it queued.
       */
      const scraped = await Promise.allSettled(jobs.map((j) => j.scrape()));
      for (let i = 0; i < jobs.length; i++) {
        const got = scraped[i];
        if (got.status !== "fulfilled") continue;
        try {
          await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, jobs[i].sourceType, jobs[i].query, got.value);
          results[jobs[i].key] = got.value.length;
        } catch (e) {
          console.error(`[runFullScrape] saving ${jobs[i].sourceType} failed:`, (e as Error)?.message ?? e);
        }
      }
      const total = Object.values(results).reduce((a, b) => a + b, 0);
      return { total, breakdown: results, disabled };
    }),

  /** Unified run — dispatches to the right scraper based on source */
  run: managerProcedure
    .input(
      z.object({
        campaignId: z.number(),
        source: z.enum(["google_business", "linkedin", "web", "news"]),
        query: z.string().min(2),
        limit: z.number().default(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCampaignHere(ctx.workspace.id, input.campaignId);
      let prospects: any[] = [];
      const { campaignId, source, query } = input;
      if (source === "google_business") {
        prospects = await scrapeGoogleBusiness(ctx.workspace.id, campaignId, query, "");
        await saveScrapeJobAndQueue(ctx.workspace.id, campaignId, "google_business", query, prospects);
      } else if (source === "linkedin") {
        prospects = await realLinkedInSearch(ctx, query, input.limit);
        await saveScrapeJobAndQueue(ctx.workspace.id, campaignId, "linkedin_people", query, prospects);
      } else if (source === "news") {
        prospects = await scrapeNews(ctx.workspace.id, campaignId, query, "");
        await saveScrapeJobAndQueue(ctx.workspace.id, campaignId, "news", query, prospects);
      } else {
        prospects = await scrapeWeb(ctx.workspace.id, campaignId, query, "");
        await saveScrapeJobAndQueue(ctx.workspace.id, campaignId, "web_scrape", query, prospects);
      }
      return { source, prospectsAdded: prospects.length };
    }),
});
