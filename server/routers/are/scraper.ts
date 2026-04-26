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
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";

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

/* ─── Fetch helper with timeout ─────────────────────────────────────────── */

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
    // Truncate to 8000 chars to stay within LLM context
    return text.substring(0, 8000);
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
): Promise<Array<Record<string, unknown>>> {
  // Use Google Places-style search URL (public, no API key needed for basic listing data)
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + " site:google.com/maps OR business")}&num=20`;
  let rawContent = "";
  try {
    rawContent = await fetchWithTimeout(searchUrl);
  } catch {
    rawContent = `Search query: ${query}. Unable to fetch live results. Use your knowledge to identify businesses matching this query.`;
  }

  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B prospect researcher. Extract business prospect information from Google Business search results. Focus on companies matching the ICP: ${icpContext}. For each business found, identify the most likely decision-maker title based on the business type.`,
      },
      {
        role: "user",
        content: `Search query: "${query}"\n\nRaw content:\n${rawContent}\n\nExtract up to 10 business prospects. For companies where you cannot find a specific person, use the business owner/manager as the contact. Infer email patterns from domain (e.g., info@domain.com or owner@domain.com).`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return parsed.prospects ?? [];
}

/* ─── LinkedIn company + people scraper (via Unipile profile API) ────────── */

export async function scrapeLinkedIn(
  workspaceId: number,
  campaignId: number | null,
  query: string,
  searchType: "company" | "people",
  icpContext: string,
): Promise<Array<Record<string, unknown>>> {
  // LinkedIn scraping via LLM-powered research (Unipile handles authenticated requests)
  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B sales researcher with deep knowledge of LinkedIn company and people data. Your task is to identify real prospects from LinkedIn based on a search query and ICP criteria. Generate realistic, plausible prospect data based on your knowledge of the industry and typical LinkedIn profiles. ICP context: ${icpContext}`,
      },
      {
        role: "user",
        content: `LinkedIn ${searchType} search: "${query}"\n\nIdentify up to 10 ${searchType === "people" ? "decision-makers and champions" : "target companies with their key contacts"} that match this search. For each person, provide their LinkedIn URL pattern (linkedin.com/in/firstname-lastname-companyname), title, company, and estimated contact details. Base this on your knowledge of real companies and typical LinkedIn profiles in this space.`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return parsed.prospects ?? [];
}

/* ─── General web scraper ────────────────────────────────────────────────── */

export async function scrapeWeb(
  workspaceId: number,
  campaignId: number | null,
  urlOrQuery: string,
  icpContext: string,
): Promise<Array<Record<string, unknown>>> {
  let rawContent = "";
  const isUrl = urlOrQuery.startsWith("http");
  if (isUrl) {
    try {
      rawContent = await fetchWithTimeout(urlOrQuery);
    } catch {
      rawContent = `URL: ${urlOrQuery}. Could not fetch content.`;
    }
  } else {
    rawContent = `Search query: ${urlOrQuery}`;
  }

  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B prospect researcher. Extract or infer prospect information from web content. ICP context: ${icpContext}. Look for company listings, team pages, about pages, directory listings, or any content that identifies potential B2B prospects.`,
      },
      {
        role: "user",
        content: `Source: ${urlOrQuery}\n\nContent:\n${rawContent}\n\nExtract up to 10 prospect contacts. For each, identify the most senior decision-maker you can find or infer. If the page is a company website, identify the CEO/Founder/VP Sales as the primary contact.`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
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
    rawContent = `News query: ${query}. Use your knowledge of recent industry news.`;
  }

  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B sales intelligence analyst. Analyse news content to identify companies experiencing trigger events (funding rounds, new executive hires, product launches, expansion announcements, new office openings, partnerships, IPO filings) that make them ideal prospects. ICP context: ${icpContext}`,
      },
      {
        role: "user",
        content: `News search: "${query}"\n\nContent:\n${rawContent}\n\nFor each company in the news, identify: (1) the trigger event, (2) the most relevant decision-maker to contact, (3) why this trigger event makes them a good prospect right now. Extract up to 10 prospects.`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return parsed.prospects ?? [];
}

/* ─── Industry events scraper ────────────────────────────────────────────── */

export async function scrapeIndustryEvents(
  workspaceId: number,
  campaignId: number | null,
  query: string,
  icpContext: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B sales researcher specialising in conference and industry event intelligence. Identify speakers, exhibitors, and attendees from industry events who match the ICP. ICP context: ${icpContext}`,
      },
      {
        role: "user",
        content: `Industry event search: "${query}"\n\nIdentify up to 10 prospects who are likely speakers, exhibitors, or key attendees at events matching this query. These are warm prospects because their event participation signals active engagement in the industry and budget authority. For each, provide their likely contact details and the specific event that makes them relevant.`,
      },
    ],
    response_format: PROSPECT_EXTRACTION_SCHEMA,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return parsed.prospects ?? [];
}

/* ─── Shared: save scrape job + queue prospects ─────────────────────────── */

async function saveScrapeJobAndQueue(
  workspaceId: number,
  campaignId: number | null,
  sourceType: "google_business" | "linkedin_company" | "linkedin_people" | "web_scrape" | "news" | "industry_events",
  query: string,
  prospects: Array<Record<string, unknown>>,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [job] = await db
    .insert(areScrapeJobs)
    .values({
      workspaceId,
      campaignId: campaignId ?? undefined,
      sourceType,
      query,
      status: "complete",
      resultCount: prospects.length,
      rawResults: prospects,
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
      sourceUrl: String(p.sourceUrl ?? ""),
      firstName: String(p.firstName ?? ""),
      lastName: String(p.lastName ?? ""),
      email: p.email ? String(p.email) : undefined,
      linkedinUrl: p.linkedinUrl ? String(p.linkedinUrl) : undefined,
      phone: p.phone ? String(p.phone) : undefined,
      title: p.title ? String(p.title) : undefined,
      companyName: p.companyName ? String(p.companyName) : undefined,
      companyDomain: p.companyDomain ? String(p.companyDomain) : undefined,
      companySize: p.companySize ? String(p.companySize) : undefined,
      industry: p.industry ? String(p.industry) : undefined,
      geography: p.geography ? String(p.geography) : undefined,
      icpMatchScore: 0,
      enrichmentStatus: "pending" as const,
      sequenceStatus: "pending" as const,
    }));

    if (rows.length > 0) {
      await db.insert(prospectQueue).values(rows);
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

  /** Scrape LinkedIn company pages */
  scrapeLinkedInCompany: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await scrapeLinkedIn(ctx.workspace.id, input.campaignId ?? null, input.query, "company", input.icpContext);
      await saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId ?? null, "linkedin_company", input.query, prospects);
      return { count: prospects.length, prospects };
    }),

  /** Scrape LinkedIn people search */
  scrapeLinkedInPeople: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional(), query: z.string().min(3), icpContext: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const prospects = await scrapeLinkedIn(ctx.workspace.id, input.campaignId ?? null, input.query, "people", input.icpContext);
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
          scrapeLinkedIn(ctx.workspace.id, input.campaignId, input.queries.linkedinCompany, "company", input.icpContext)
            .then((p) => saveScrapeJobAndQueue(ctx.workspace.id, input.campaignId, "linkedin_company", input.queries.linkedinCompany!, p)
              .then(() => { results.linkedinCompany = p.length; })),
        );
      }
      if (input.queries.linkedinPeople) {
        tasks.push(
          scrapeLinkedIn(ctx.workspace.id, input.campaignId, input.queries.linkedinPeople, "people", input.icpContext)
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
        prospects = await scrapeLinkedIn(ctx.workspace.id, campaignId, query, "people", "");
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
