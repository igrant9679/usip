/**
 * The Research engine (Research module, phase 2; owner, 2026-10-14).
 *
 * A run researches one market or one sector on the web and writes a DRAFT for
 * a person to review; it never changes a market, sector or persona itself.
 * Two passes, the shape Downstream proved (lib/ai.js):
 *
 *   1. Research — Claude with web search and web fetch, framed by the
 *      workspace's own company profile and knowledge base, writes a brief in
 *      prose with the source of every figure.
 *   2. Draft — the brief becomes the structured record (shared/researchShape)
 *      through one forced tool call, using only what the brief says.
 *
 * Then the shared cleaners run (personal data out, lengths capped), and every
 * link in the draft must be a page the research actually searched, opened or
 * cited: a link the model wrote from memory is removed and reported, so
 * "every fact carries a source" means a source someone can open.
 *
 * Runs bill the workspace's own Anthropic key (never the server's), go through
 * the same monthly AI budget as every other call, and record their tokens,
 * searches and cost as they go. At most RESEARCH_CONCURRENCY run at once on
 * this server; the router allows one per person and a daily number per person.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, lt } from "drizzle-orm";
import { researchJobs, researchMarkets, researchSectors } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { runAnthropicServerTools } from "../../_core/llm";
import { buildBrandContext } from "../brandContext";
import {
  cleanMarketContent,
  cleanPersonaResearch,
  cleanSectorContent,
  looksPersonal,
  type MarketContent,
  type SectorContent,
} from "@shared/researchShape";
import { requestCostUsd, researchModelOf, type ResearchModelId, type ResearchUsage } from "@shared/researchModels";

/* ── Limits ─────────────────────────────────────────────────────────────── */

export const RESEARCH_CONCURRENCY = 2;
export const MAX_SEARCHES = 12;
export const MAX_FETCHES = 8;
/** Pages are long; a run reads the useful part of eight, not all of eight. */
const FETCH_MAX_CONTENT_TOKENS = 12_000;
const MAX_CONTINUATIONS = 6;
const BRIEF_MAX_TOKENS = 16_000;
const DRAFT_MAX_TOKENS = 16_000;
const RUN_TIMEOUT_MS = 25 * 60_000;
/** A queued or running job no process is working on, untouched this long, was cut off by a restart. */
export const ORPHAN_AFTER_MS = 10 * 60_000;

export const WEB_SEARCH_TOOL = "web_search_20260209";
export const WEB_FETCH_TOOL = "web_fetch_20260209";

/* ── Draft shape ────────────────────────────────────────────────────────── */

export type PersonaDraft = { name: string; titles: string[]; cares: string; pains: string[]; objections: string[]; angle: string };
export type ResearchDraft =
  | { kind: "market"; content: MarketContent }
  | { kind: "sector"; content: SectorContent; personas: PersonaDraft[] };

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Job = typeof researchJobs.$inferSelect;
type SourceLink = { title: string; url: string };

/* ── Links ──────────────────────────────────────────────────────────────── */

/** Comparable form of a URL: no scheme, no www., no fragment, no trailing slash, host lower-cased. */
export function linkKey(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return "";
  }
}

/**
 * Keeps only links the research saw. Walks the draft and blanks any `url` or
 * `source` field whose link is not in `seen`. A row that loses its link is
 * dropped when the link was the point of it: a source ({title, url}) or a
 * figure ({value, …, source}), since a number nobody can check is worse than
 * no number. Anything else (a program, a competitor, a glossary term) stays,
 * without the link. Returns the links it removed.
 */
export function keepSeenLinks(content: Record<string, unknown>, seen: Set<string>): string[] {
  const removed: string[] = [];
  const LOST = Symbol("lost");
  const check = (v: string): boolean => {
    if (!v) return true;
    const k = linkKey(v);
    if (k && seen.has(k)) return true;
    removed.push(v);
    return false;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk).filter((x) => {
        if (!x || typeof x !== "object" || !(LOST in (x as object))) return true;
        const o = x as Record<string, unknown>;
        return !("value" in o) && !("title" in o && "url" in o);
      }).map((x) => {
        if (x && typeof x === "object" && LOST in (x as object)) delete (x as Record<symbol, unknown>)[LOST];
        return x;
      });
    }
    if (node && typeof node === "object") {
      const o: Record<string | symbol, unknown> = { ...(node as Record<string, unknown>) };
      for (const [k, v] of Object.entries(o)) {
        if ((k === "url" || k === "source") && typeof v === "string") {
          if (!check(v)) { o[k] = ""; o[LOST] = true; }
        } else o[k] = walk(v);
      }
      return o;
    }
    return node;
  };
  const out = walk(content) as Record<string, unknown>;
  for (const k of Object.keys(content)) delete content[k];
  Object.assign(content, out);
  return removed;
}

/* ── What a response tells us ───────────────────────────────────────────── */

/** Every page a response searched, opened or cited, and the progress lines for it. */
export function readBlocks(blocks: Anthropic.ContentBlock[]): { sources: SourceLink[]; cited: string[]; text: string } {
  const sources: SourceLink[] = [];
  const cited: string[] = [];
  let text = "";
  for (const b of blocks) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result") sources.push({ title: r.title || r.url, url: r.url });
    } else if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result") {
      sources.push({ title: b.content.content?.title || b.content.url, url: b.content.url });
    } else if (b.type === "text") {
      text += b.text;
      for (const c of b.citations ?? []) {
        if (c.type === "web_search_result_location") {
          cited.push(c.url);
          sources.push({ title: c.title || c.url, url: c.url });
        }
      }
    }
  }
  return { sources, cited, text };
}

export function progressLine(block: Anthropic.ContentBlock): string | null {
  if (block.type !== "server_tool_use") return null;
  const input = (block.input ?? {}) as { query?: string; url?: string };
  if (block.name === "web_search" && input.query) return `Searching: ${String(input.query).slice(0, 200)}`;
  if (block.name === "web_fetch" && input.url) return `Reading: ${String(input.url).slice(0, 300)}`;
  return null;
}

/* ── Prompts ────────────────────────────────────────────────────────────── */

/** The seller's company facts and knowledge, without the brand voice (irrelevant to research). */
async function sellerProfile(workspaceId: number, query: string): Promise<string> {
  const block = await buildBrandContext(workspaceId, { query }).catch(() => "");
  const kept = block.split(/\n\n(?=## )/).filter((s) => !s.startsWith("## Brand voice"));
  return kept.join("\n\n").trim();
}

const RULES = [
  "Research organizations, never people: do not record the name, email address or phone number of any individual.",
  "Search the web and read the most useful pages. Prefer primary sources: government and agency data, regulators, industry associations, annual reports, reputable trade press. Note how recent each source is.",
  "Every number must come from a page you found. Put the page's full URL in parentheses right after the figure. If you cannot find a number, say it is unknown; never estimate silently.",
  "Write for a salesperson: concrete and specific, no filler.",
];

export function researchSystemPrompt(seller: string, today: string): string {
  return [
    "You are a B2B market researcher. You research markets and the sectors inside them so a sales team knows who buys, why, how to reach them and how to talk to them.",
    `Today is ${today}.`,
    seller
      ? `The company you research for (judge fit against what it sells; the research is about its buyers, not about it):\n\n${seller}`
      : "The company you research for has not described what it sells yet. Judge fit in general terms and say so.",
    `Rules:\n${RULES.map((r) => `- ${r}`).join("\n")}`,
  ].join("\n\n");
}

export function sectorBriefPrompt(args: { market: string; marketOverview: string; sector: string; focus: string; current?: SectorContent }): string {
  return [
    `Market: ${args.market}${args.marketOverview ? `\n${args.marketOverview}` : ""}`,
    `Sector to research: ${args.sector}`,
    args.focus ? `What the person who asked wants to know: ${args.focus}` : "",
    args.current
      ? `What we already have on this sector. Check it, correct what is wrong or out of date, and fill the gaps:\n${JSON.stringify(args.current)}`
      : "",
    [
      "Write the brief with these headings, in this order:",
      "1. Summary: who these organizations are and why they would buy.",
      "2. Size: how many organizations there are, and what they spend (with sources).",
      "3. Money: where their money comes from, who it passes through, and the programs or budget lines that pay for this kind of purchase.",
      "4. Buyers: the roles that buy or sign off, their job titles as they appear on LinkedIn, and for each: what they care about, their pains, their objections, and the angle that works.",
      "5. How they buy: process, cycle, approvals, procurement rules; and what they must report or comply with.",
      "6. Who helps them today: incumbents, consultants, in-house teams.",
      "7. Messaging: what to lead with, what to avoid saying, and the words they use.",
      "8. Targeting: LinkedIn industries, organization types, a company size range, search keywords, and short words that mark a person or company as off target.",
      "9. Changes to watch: policy, funding or market changes coming.",
      "10. Open questions you could not answer.",
      "11. Scores from 1 (low) to 5 (high) for reach, money, pain, fit (to what the company sells) and access, each with one line of reasoning.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

export function marketBriefPrompt(args: { market: string; focus: string; current?: MarketContent }): string {
  return [
    `Market to research: ${args.market}`,
    args.focus ? `What the person who asked wants to know: ${args.focus}` : "",
    args.current
      ? `What we already have on this market. Check it, correct what is wrong or out of date, and fill the gaps:\n${JSON.stringify(args.current)}`
      : "",
    [
      "Write the brief with these headings, in this order:",
      "1. Overview: one headline sentence, then how this market works: who is in it, where the money comes from, what is changing.",
      "2. Sectors: the 5 to 12 groups of organizations inside it that buy alike, each with one line on why it is or is not worth researching for the company.",
      "3. Glossary: 10 to 25 terms this market uses, each with a plain definition.",
      "4. Competitors: who sells something like the company's offer into this market, their positioning, and public pricing if any.",
      "5. Open questions you could not answer.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

/* ── Draft schemas (pass 2) ─────────────────────────────────────────────── */

const S = { type: "string" } as const;
const L = { type: "array", items: S } as const;
const O = (properties: Record<string, unknown>) => ({ type: "object", properties });
const A = (properties: Record<string, unknown>) => ({ type: "array", items: O(properties) });
const SCORE = { type: ["integer", "null"], minimum: 1, maximum: 5 };

export const SECTOR_DRAFT_SCHEMA = O({
  shortName: S,
  tagline: S,
  summary: S,
  scores: O({ reach: SCORE, money: SCORE, pain: SCORE, fit: SCORE, access: SCORE }),
  buyers: O({ roles: L, painPoints: L }),
  targeting: O({
    titles: L, industries: L, geographies: L, keywords: L,
    employeeMin: { type: ["integer", "null"] }, employeeMax: { type: ["integer", "null"] },
    organizationTypes: L, exclude: L,
  }),
  messaging: O({ leadWith: L, avoid: L, vocabulary: L, sampleOpening: S }),
  facts: O({
    marketSize: A({ value: S, label: S, source: S }),
    moneyFlow: O({ sources: L, intermediaries: A({ name: S, role: S, count: S }), recipients: A({ type: S, approxCount: S, notes: S }) }),
    programs: A({ name: S, agency: S, flow: S, purpose: S, typicalAward: S, url: S }),
    buying: L, obligations: L, helpers: L, policyWatch: L,
  }),
  openQuestions: L,
  sources: A({ title: S, url: S }),
  personas: A({ name: S, titles: L, cares: S, pains: L, objections: L, angle: S }),
});

export const MARKET_DRAFT_SCHEMA = O({
  tagline: S,
  overview: O({ headline: S, lede: S }),
  suggestedSectors: A({ name: S, why: S }),
  glossary: A({ term: S, definition: S, source: S }),
  competitors: A({ name: S, category: S, positioning: S, pricing: S, url: S }),
  openQuestions: L,
  sources: A({ title: S, url: S }),
});

const DRAFT_SYSTEM = [
  "Turn the research brief into the structured record.",
  "Use only what the brief says. Copy figures exactly as written. For each figure, put the URL the brief gives for it.",
  "Only use URLs from the brief or the numbered source list. Leave a field empty when the brief does not support it.",
  "Job titles: clean titles as they appear on LinkedIn. Industries: LinkedIn industry names. Never-target words: short single words or short phrases.",
  "Lists of sentences (pains, lead-with, avoid, open questions) are one short sentence per item.",
  "Personas (sector only): 2 to 4 distinct buyer roles from the brief, each with its job titles, what they care about, pains, objections and the angle that works. Describe roles, never named people.",
  "Never include a person's name, email address or phone number anywhere.",
].join("\n");

/* ── Cleaning the model's draft ─────────────────────────────────────────── */

export function cleanPersonas(raw: unknown, dropped: string[]): PersonaDraft[] {
  const out: PersonaDraft[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(raw) ? raw.slice(0, 8) : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 120) : "";
    if (name.length < 2 || seen.has(name.toLowerCase())) continue;
    if (looksPersonal(name)) { dropped.push("personas.name"); continue; }
    seen.add(name.toLowerCase());
    const titles = cleanSectorContent({ targeting: { titles: o.titles } }).content.targeting.titles.slice(0, 15);
    const r = cleanPersonaResearch(o);
    dropped.push(...r.dropped.map((d) => `personas.${d}`));
    out.push({ name, titles, ...r.content });
  }
  return out.slice(0, 6);
}

/** Cleans a pass-2 tool input into the draft a person reviews. Exported for tests. */
export function finishDraft(args: {
  kind: "market" | "sector";
  name: string;
  input: Record<string, unknown>;
  seen: SourceLink[];
  cited: string[];
  today: string;
}): { draft: ResearchDraft; dropped: string[] } {
  const seenKeys = new Set(args.seen.map((s) => linkKey(s.url)).filter(Boolean));
  const input = { ...args.input };
  const linkDrops = keepSeenLinks(input, seenKeys);
  const dropped: string[] = linkDrops.map((u) => `link the research never opened: ${u}`);

  // The record's own sources: what the model listed and kept, then what the brief cited.
  const citedRows = args.cited.map((u) => args.seen.find((s) => linkKey(s.url) === linkKey(u)) ?? { title: u, url: u });
  const listed = Array.isArray(input.sources) ? (input.sources as SourceLink[]) : [];
  input.sources = [...listed, ...citedRows].slice(0, 60);

  if (args.kind === "market") {
    const c = cleanMarketContent({ ...input, name: args.name, status: "draft" });
    dropped.push(...c.dropped);
    return { draft: { kind: "market", content: c.content }, dropped };
  }
  const c = cleanSectorContent({ ...input, name: args.name, status: "draft", asOf: args.today });
  dropped.push(...c.dropped);
  const personas = cleanPersonas(input.personas, dropped);
  return { draft: { kind: "sector", content: c.content, personas }, dropped };
}

/* ── Errors people can act on ───────────────────────────────────────────── */

export function friendlyError(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 401) return "The workspace's Anthropic key was refused. An admin can check it in Settings → Integrations → AI provider keys.";
  if (/credit balance|billing/i.test(msg)) return "The workspace's Anthropic account is out of credit. Add credit in the Anthropic Console, then run it again.";
  if (/web search is not enabled|web_search.*not enabled/i.test(msg)) return "Web search is turned off for this Anthropic organization. An admin can turn it on in the Anthropic Console (Settings → Capabilities).";
  if (status === 429) return "Anthropic is rate-limiting this key right now. Try again in a few minutes.";
  return msg.slice(0, 480);
}

/* ── The queue ──────────────────────────────────────────────────────────── */

const active = new Map<number, AbortController>();
let waiting: number[] = [];

/** True while this server is working on, or about to work on, the job. */
export function isJobLive(id: number): boolean {
  return active.has(id) || waiting.includes(id);
}

export function enqueueResearchJob(id: number): void {
  if (isJobLive(id)) return;
  waiting.push(id);
  pump();
}

export function cancelResearchJob(id: number): void {
  waiting = waiting.filter((x) => x !== id);
  active.get(id)?.abort();
}

function pump(): void {
  while (active.size < RESEARCH_CONCURRENCY && waiting.length) {
    const id = waiting.shift()!;
    const ac = new AbortController();
    active.set(id, ac);
    const timer = setTimeout(() => ac.abort(new Error("timeout")), RUN_TIMEOUT_MS);
    runResearchJob(id, ac.signal)
      .catch((e) => console.error(`[research] job ${id} crashed:`, e instanceof Error ? e.message : e))
      .finally(() => {
        clearTimeout(timer);
        active.delete(id);
        pump();
      });
  }
}

/**
 * Marks a workspace's queued or running jobs that nothing is working on as
 * failed: a deploy or restart cut them off. Called before the router counts
 * or lists runs, so one cannot block a person forever.
 */
export async function failOrphanedJobs(db: Db, workspaceId: number): Promise<void> {
  const rows = await db
    .select({ id: researchJobs.id })
    .from(researchJobs)
    .where(and(
      eq(researchJobs.workspaceId, workspaceId),
      inArray(researchJobs.status, ["queued", "running"]),
      lt(researchJobs.updatedAt, new Date(Date.now() - ORPHAN_AFTER_MS)),
    ));
  const ids = rows.map((r) => r.id).filter((id) => !isJobLive(id));
  if (!ids.length) return;
  await db
    .update(researchJobs)
    .set({ status: "failed", error: "Stopped when the server restarted. Run it again. Nothing more was charged.", finishedAt: new Date() })
    .where(and(eq(researchJobs.workspaceId, workspaceId), inArray(researchJobs.id, ids)));
}

/* ── One run ────────────────────────────────────────────────────────────── */

type Totals = { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; searches: number; fetches: number; costUsd: number };

function addUsage(t: Totals, model: ResearchModelId, u: ResearchUsage): void {
  t.inputTokens += u.input_tokens ?? 0;
  t.outputTokens += u.output_tokens ?? 0;
  t.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  t.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  t.searches += u.server_tool_use?.web_search_requests ?? 0;
  t.fetches += u.server_tool_use?.web_fetch_requests ?? 0;
  t.costUsd += requestCostUsd(model, u);
}

const totalsRow = (t: Totals) => ({ ...t, costUsd: t.costUsd.toFixed(4) });

/**
 * How the draft is asked for, learned on the first two live runs (2026-10-14):
 *   - a FORCED tool call is refused by Opus 5.5 ("tool_choice: type tool and
 *     any are not supported for this model");
 *   - a structured output (output_config.format) of the sector schema is
 *     refused as "The compiled grammar is too large".
 * So the record tool is offered with tool_choice "auto" and the prompt tells
 * the model to call it. A non-strict tool compiles no grammar, and the shared
 * cleaners check every field anyway. A model that answers in JSON text
 * instead is read too.
 */
export function draftInputOf(res: Pick<Anthropic.Message, "content" | "stop_reason">, toolName: string): Record<string, unknown> {
  if (res.stop_reason === "refusal") throw new Error("The model declined to write the draft. Try again with a narrower focus.");
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === toolName);
  if (call && call.input && typeof call.input === "object" && !Array.isArray(call.input)) return call.input as Record<string, unknown>;
  if (res.stop_reason === "max_tokens") throw new Error("The draft was longer than the model could write in one go. Use Draft again, or narrow the focus.");
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Error("The draft step returned something that is not a draft. Use Draft again.");
}

/**
 * Runs one job. A job that already holds a brief (its drafting failed, and a
 * person asked to draft again) skips the research and drafts from what was
 * paid for; its tokens, cost and progress carry on from where they were.
 */
export async function runResearchJob(id: number, signal: AbortSignal): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, id)).limit(1);
  if (!job || job.status !== "queued") return;

  const model = researchModelOf(job.model);
  const totals: Totals = {
    inputTokens: job.inputTokens ?? 0,
    outputTokens: job.outputTokens ?? 0,
    cacheWriteTokens: job.cacheWriteTokens ?? 0,
    cacheReadTokens: job.cacheReadTokens ?? 0,
    searches: job.searches ?? 0,
    fetches: job.fetches ?? 0,
    costUsd: Number(job.costUsd ?? 0) || 0,
  };
  const progress: { at: string; line: string }[] = Array.isArray(job.progress) ? [...(job.progress as { at: string; line: string }[])] : [];
  const save = (patch: Partial<typeof researchJobs.$inferInsert>) =>
    db
      .update(researchJobs)
      .set({ ...patch, progress: progress.slice(-200), ...totalsRow(totals) })
      .where(and(eq(researchJobs.id, id), eq(researchJobs.workspaceId, job.workspaceId)));
  const note = (line: string) => {
    progress.push({ at: new Date().toISOString(), line });
    save({}).catch(() => {});
  };

  await db
    .update(researchJobs)
    .set({ status: "running", startedAt: new Date(), error: null })
    .where(and(eq(researchJobs.id, id), eq(researchJobs.workspaceId, job.workspaceId), eq(researchJobs.status, "queued")));
  try {
    const today = new Date().toISOString().slice(0, 10);
    let brief = job.brief ?? "";
    let seen: SourceLink[] = Array.isArray(job.sources) ? (job.sources as SourceLink[]) : [];
    const cited: string[] = [];

    if (!brief.trim()) {
      // Pass 1: the web-researched brief.
      const ctx = await loadContext(db, job);
      note(job.kind === "market" ? `Researching the market "${job.subject}"` : `Researching the sector "${job.subject}"`);
      const system = researchSystemPrompt(await sellerProfile(job.workspaceId, `${ctx.marketName} ${job.subject}`), today);
      const user = job.kind === "market"
        ? marketBriefPrompt({ market: job.subject, focus: job.focus ?? "", current: ctx.currentMarket })
        : sectorBriefPrompt({ market: ctx.marketName, marketOverview: ctx.marketOverview, sector: job.subject, focus: job.focus ?? "", current: ctx.currentSector });
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      seen = [];
      let container: string | undefined;
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
        if (signal.aborted) throw signal.reason ?? new Error("cancelled");
        if (turn > 0) note(`Continuing the research (part ${turn + 1})`);
        const res = await runAnthropicServerTools({
          workspaceId: job.workspaceId,
          signal,
          // Dynamic filtering can report one search twice; show it once.
          onBlock: (b) => { const l = progressLine(b); if (l && progress[progress.length - 1]?.line !== l) note(l); },
          params: {
            model,
            max_tokens: BRIEF_MAX_TOKENS,
            system,
            messages,
            // A paused turn is sent back whole; caching makes the repeat a cache
            // read (Opus 5.5: $0.20 instead of $4 per million tokens). The first
            // live run, uncached, spent 760k input tokens across its parts.
            cache_control: { type: "ephemeral" },
            ...(container ? { container } : {}),
            tools: [
              { type: WEB_SEARCH_TOOL, name: "web_search", max_uses: Math.max(1, MAX_SEARCHES - totals.searches) },
              { type: WEB_FETCH_TOOL, name: "web_fetch", max_uses: Math.max(1, MAX_FETCHES - totals.fetches), max_content_tokens: FETCH_MAX_CONTENT_TOKENS },
            ],
          },
        });
        addUsage(totals, model, res.usage);
        const r = readBlocks(res.content);
        seen.push(...r.sources);
        cited.push(...r.cited);
        brief += r.text;
        container = (res as { container?: { id?: string } | null }).container?.id ?? container;
        await save({});
        if (res.stop_reason !== "pause_turn") {
          if (res.stop_reason === "max_tokens") note("The brief reached its length limit; drafting from what it has.");
          break;
        }
        messages.push({ role: "assistant", content: res.content as unknown as Anthropic.ContentBlockParam[] });
      }
      if (!brief.trim()) throw new Error("The research came back empty. Try again, or add a focus to the request.");
      // Kept the moment it exists: if drafting fails, Draft again starts here
      // instead of paying for the research twice.
      seen = dedupeSources(seen).slice(0, 200);
      await save({ brief, sources: seen });
    } else {
      note("Drafting again from the saved research");
    }

    // Pass 2: the structured draft, from the brief alone.
    if (signal.aborted) throw signal.reason ?? new Error("cancelled");
    note("Writing the draft");
    const sourceList = dedupeSources(seen).map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n");
    const toolName = job.kind === "market" ? "record_market" : "record_sector";
    const res2 = await runAnthropicServerTools({
      workspaceId: job.workspaceId,
      signal,
      params: {
        model,
        max_tokens: DRAFT_MAX_TOKENS,
        system: `${DRAFT_SYSTEM}\nCall the ${toolName} tool exactly once with the whole record. Do not answer in text.`,
        messages: [{ role: "user", content: `Research brief:\n\n${brief}\n\nSources the research searched or read:\n${sourceList || "(none)"}` }],
        tools: [{
          name: toolName,
          description: job.kind === "market" ? "Record the market research." : "Record the sector research.",
          input_schema: (job.kind === "market" ? MARKET_DRAFT_SCHEMA : SECTOR_DRAFT_SCHEMA) as Anthropic.Tool["input_schema"],
        }],
        tool_choice: { type: "auto" },
      },
    });
    addUsage(totals, model, res2.usage);
    const input = draftInputOf(res2, toolName);

    const { draft, dropped } = finishDraft({ kind: job.kind, name: job.subject, input, seen, cited, today });
    const linkDrops = dropped.filter((d) => d.startsWith("link ")).length;
    note(linkDrops ? `Draft ready. Removed ${linkDrops} ${linkDrops === 1 ? "link" : "links"} the research never opened.` : "Draft ready for review");
    await save({ status: "done", draft, dropped, error: null, finishedAt: new Date() });
  } catch (e) {
    const cancelled = signal.aborted && !(signal.reason instanceof Error && signal.reason.message === "timeout");
    if (cancelled) note("Stopped");
    await save({
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : signal.aborted ? "The run took longer than 25 minutes and was stopped." : friendlyError(e),
      finishedAt: new Date(),
    }).catch(() => {});
  }
}

function dedupeSources(list: SourceLink[]): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  for (const s of list) {
    const k = linkKey(s.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ title: (s.title || s.url).slice(0, 300), url: s.url });
  }
  return out;
}

async function loadContext(db: Db, job: Job): Promise<{ marketName: string; marketOverview: string; currentMarket?: MarketContent; currentSector?: SectorContent }> {
  let marketName = "";
  let marketOverview = "";
  let currentMarket: MarketContent | undefined;
  let currentSector: SectorContent | undefined;
  if (job.marketId != null) {
    const [m] = await db
      .select()
      .from(researchMarkets)
      .where(and(eq(researchMarkets.id, job.marketId), eq(researchMarkets.workspaceId, job.workspaceId)))
      .limit(1);
    if (m) {
      const c = cleanMarketContent(m).content;
      marketName = c.name;
      marketOverview = [c.overview.headline, c.overview.lede].filter(Boolean).join("\n").slice(0, 3000);
      if (job.kind === "market") currentMarket = c;
    }
  }
  if (job.sectorId != null) {
    const [s] = await db
      .select()
      .from(researchSectors)
      .where(and(eq(researchSectors.id, job.sectorId), eq(researchSectors.workspaceId, job.workspaceId)))
      .limit(1);
    if (s) currentSector = cleanSectorContent(s).content;
  }
  return { marketName, marketOverview, currentMarket, currentSector };
}
