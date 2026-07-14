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
import { areScrapeJobs, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { parseLlmJson } from "./llmJson";
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { searchLinkedInProfiles } from "../../services/linkedinLookup";

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "super_admin";
}

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

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; USIP-ARE/1.0; +https://usipsales.manus.space)",
      },
    });
    const text = await res.text();
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
          content: `You are a B2B prospect researcher. Extract business prospect information ONLY from the provided Google Business search results — never invent businesses that aren't present in the content. Focus on companies matching the ICP: ${icpContext}. For each business found, identify the most likely decision-maker title based on the business type.`,
        },
        {
          role: "user",
          content: `Search query: "${query}" (results page ${page + 1})\n\nRaw content:\n${rawContent}\n\nExtract up to 10 business prospects that actually appear in the content above. For companies where you cannot find a specific person, use the business owner/manager as the contact. Only output an email if it appears in the content; otherwise leave email blank.`,
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
    for (const p of (parsed.prospects ?? []) as Array<Record<string, unknown>>) {
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
        content: `News search: "${query}"\n\nContent:\n${rawContent}\n\nFor each company actually mentioned in the content, identify: (1) the trigger event, (2) the most relevant decision-maker to contact, (3) why this trigger event makes them a good prospect right now. Extract up to 10 prospects. Only output an email if it appears in the content.`,
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
  return parsed.prospects ?? [];
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

/**
 * Column-width guards. Scraped values regularly exceed the prospect_queue
 * varchar widths — LinkedIn headlines run up to ~220 chars vs title's
 * varchar(120) — and MySQL strict mode then rejects the ENTIRE multi-row
 * INSERT ("Data too long for column 'title' at row N"), silently discarding
 * every prospect found that tick. Clamp before insert; never trust source
 * lengths. (Documented enum/varchar runtime-insert bug class.)
 */
function clampStr(v: unknown, max: number): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/** LLM scrapers emit placeholder names ("<UNKNOWN>", "N/A") when a source
 *  doesn't reveal one — those must become empty strings, not greet-able
 *  "Hi <UNKNOWN>" personalization inputs. */
const PLACEHOLDER_NAME =
  /^[\s<>[\]()"'.-]*(unknown|n\/?a|none|null|not\s*(available|found|known)|-+)[\s<>[\]()"'.-]*$/i;
function cleanName(v: unknown, max: number): string {
  const s = String(v ?? "").trim();
  if (!s || PLACEHOLDER_NAME.test(s)) return "";
  return s.length > max ? s.slice(0, max) : s;
}

export async function saveScrapeJobAndQueue(
  workspaceId: number,
  campaignId: number | null,
  sourceType: "google_business" | "linkedin_company" | "linkedin_people" | "web_scrape" | "news" | "industry_events",
  query: string,
  prospects: Array<Record<string, unknown>>,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

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
      errorMessage: prospects.length === 0
        ? "No prospects returned — source returned nothing or every result was deduplicated"
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
    };

    const rows = prospects.map((p) => ({
      workspaceId,
      campaignId,
      sourceType: sourceTypeMap[sourceType] ?? "web_scrape",
      sourceUrl: String(p.sourceUrl ?? ""), // text column — no clamp needed
      firstName: cleanName(p.firstName, 80),
      lastName: cleanName(p.lastName, 80),
      email: clampStr(p.email, 320),
      linkedinUrl: p.linkedinUrl ? String(p.linkedinUrl) : undefined, // text column
      phone: clampStr(p.phone, 40),
      title: clampStr(p.title, 120),
      companyName: clampStr(p.companyName, 200),
      companyDomain: clampStr(p.companyDomain, 200),
      companySize: clampStr(p.companySize, 40),
      industry: clampStr(p.industry, 80),
      geography: clampStr(p.geography, 120),
      // int column 0-100 — round and clamp (scores can arrive as floats)
      icpMatchScore: Math.max(0, Math.min(100, Math.round(Number((p as any).icpMatchScore ?? 0) || 0))),
      enrichmentStatus: "pending" as const,
      sequenceStatus: "pending" as const,
    }));

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
    }
  }
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

export const scraperRouter = router({
  /** List all scrape jobs for the workspace */
  listJobs: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), limit: z.number().default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areScrapeJobs.workspaceId, ctx.workspace.id)];
      if (input.campaignId) conditions.push(eq(areScrapeJobs.campaignId, input.campaignId));
      return db
        .select()
        .from(areScrapeJobs)
        .where(and(...conditions))
        .orderBy(desc(areScrapeJobs.createdAt))
        .limit(input.limit);
    }),

  /** Scrape Google Business listings */
  scrapeGoogleBusiness: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await scrapeGoogleBusiness(ctx.workspace.id, input.campaignId ?? null, input.query, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "google_business", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** LinkedIn search (company-oriented keywords) via real Unipile people search */
  scrapeLinkedInCompany: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await realLinkedInSearch(ctx, input.query, 25);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "linkedin_company", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** LinkedIn people search via real Unipile classic search */
  scrapeLinkedInPeople: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await realLinkedInSearch(ctx, input.query, 25);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "linkedin_people", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Scrape a specific URL or run a general web search */
  scrapeWeb: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), urlOrQuery: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await scrapeWeb(ctx.workspace.id, input.campaignId ?? null, input.urlOrQuery, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "web_scrape", input.urlOrQuery, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Monitor news for trigger events and extract prospects */
  scrapeNews: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await scrapeNews(ctx.workspace.id, input.campaignId ?? null, input.query, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "news", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Scrape industry events for speakers, exhibitors, and attendees */
  scrapeIndustryEvents: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await scrapeIndustryEvents(ctx.workspace.id, input.campaignId ?? null, input.query, input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "industry_events", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Run all scrapers in parallel for a campaign */
  runFullScrape: workspaceProcedure
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
      const results: Record<string, number> = {};
      const tasks: Promise<void>[] = [];

      if (input.queries.googleBusiness) {
        tasks.push(
          scrapeGoogleBusiness(ctx.workspace.id, input.campaignId, input.queries.googleBusiness, input.icpContext)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "google_business", input.queries.googleBusiness!, p)
              .then(() => { results.googleBusiness = p.length; })),
        );
      }
      if (input.queries.linkedinCompany) {
        tasks.push(
          realLinkedInSearch(ctx, input.queries.linkedinCompany, 25)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "linkedin_company", input.queries.linkedinCompany!, p)
              .then(() => { results.linkedinCompany = p.length; })),
        );
      }
      if (input.queries.linkedinPeople) {
        tasks.push(
          realLinkedInSearch(ctx, input.queries.linkedinPeople, 25)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "linkedin_people", input.queries.linkedinPeople!, p)
              .then(() => { results.linkedinPeople = p.length; })),
        );
      }
      if (input.queries.news) {
        tasks.push(
          scrapeNews(ctx.workspace.id, input.campaignId, input.queries.news, input.icpContext)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "news", input.queries.news!, p)
              .then(() => { results.news = p.length; })),
        );
      }
      if (input.queries.industryEvents) {
        tasks.push(
          scrapeIndustryEvents(ctx.workspace.id, input.campaignId, input.queries.industryEvents, input.icpContext)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "industry_events", input.queries.industryEvents!, p)
              .then(() => { results.industryEvents = p.length; })),
        );
      }
      if (input.queries.web) {
        tasks.push(
          scrapeWeb(ctx.workspace.id, input.campaignId, input.queries.web, input.icpContext)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "web_scrape", input.queries.web!, p)
              .then(() => { results.web = p.length; })),
        );
      }

      await Promise.allSettled(tasks);
      const total = Object.values(results).reduce((a, b) => a + b, 0);
      return { total, breakdown: results };
    }),

  /** Unified run — dispatches to the right scraper based on source */
  run: workspaceProcedure
    .input(
      z.object({
        campaignId: z.number(),
        source: z.enum(["google_business", "linkedin", "web", "news"]),
        query: z.string().min(2),
        limit: z.number().default(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
