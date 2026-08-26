/**
 * The AI Assistant's bounded tool set — the ONE registry of what the
 * conversational assistant may see and do.
 *
 * Three tiers, and the tier IS the safety model:
 *
 *  - READ tools execute immediately inside the chat loop. They only ever go
 *    through the app's own tRPC procedures via createCaller, so workspace
 *    scoping and role checks are the same ones the UI enforces — the
 *    assistant can never read something its user couldn't open themselves.
 *  - NAVIGATE is client-side: the server validates the path shape and the
 *    client renders a link. Nothing executes.
 *  - MUTATING tools are never executed from the loop. The model calling one
 *    produces a *pending action* the user must confirm in-chat; only then
 *    does assistant.confirmAction run it — again through createCaller, again
 *    under the caller's own role, and audited as assistant_action.
 *
 * Deliberately absent: anything that dispatches email or LinkedIn messages.
 * Sends stay behind the autopilot dials and the AI Pipeline approval queue —
 * an assistant that can be talked into sending is an assistant that will be.
 */
import { z } from "zod";
import type { Tool } from "../_core/llm";
import { EXPLORER_SPEC } from "./assistantDataExplorer";

/* ─── Argument schemas (zod is the runtime gate; JSON schema is the LLM's) ── */

const idList = z.array(z.number().int().positive()).min(1).max(50);

/**
 * The described-filter vocabulary, shared by preview_people_filter (READ) and
 * create_list_from_filter (MUTATING) so what the model previews is exactly
 * what the confirmed action selects. A strict subset of prospects.list's
 * server-side filters — additions here must exist there.
 */
export const PEOPLE_FILTER = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  titleQ: z.string().trim().min(1).max(200).optional(),
  companyQ: z.string().trim().min(1).max(200).optional(),
  locationQ: z.string().trim().min(1).max(200).optional(),
  industryQ: z.string().trim().min(1).max(200).optional(),
  hasEmail: z.boolean().optional(),
  hasPhone: z.boolean().optional(),
  hasLinkedin: z.boolean().optional(),
  emailStatus: z.string().trim().min(1).max(40).optional(),
  tiers: z.array(z.enum(["high", "medium", "low"])).min(1).max(3).optional(),
  seniorities: z.array(z.string().trim().min(1).max(40)).min(1).max(12).optional(),
  scoreMinRating: z.enum(["fair", "good", "excellent"]).optional(),
});
export type PeopleFilter = z.infer<typeof PEOPLE_FILTER>;

const filterIsNonEmpty = (f: Record<string, unknown>) =>
  Object.values(f).some((v) => v !== undefined);

/** Human sentence for a filter — used in previews and confirmation cards. */
export function describePeopleFilter(f: PeopleFilter): string {
  const parts: string[] = [];
  if (f.search) parts.push(`matching "${f.search}"`);
  if (f.titleQ) parts.push(`title contains "${f.titleQ}"`);
  if (f.companyQ) parts.push(`company contains "${f.companyQ}"`);
  if (f.locationQ) parts.push(`location contains "${f.locationQ}"`);
  if (f.industryQ) parts.push(`industry contains "${f.industryQ}"`);
  if (f.hasEmail) parts.push("has an email");
  if (f.hasPhone) parts.push("has a phone");
  if (f.hasLinkedin) parts.push("has LinkedIn");
  if (f.emailStatus) parts.push(`email status ${f.emailStatus}`);
  if (f.tiers?.length) parts.push(`${f.tiers.join("/")} fit`);
  if (f.seniorities?.length) parts.push(`seniority ${f.seniorities.join("/")}`);
  if (f.scoreMinRating) parts.push(`score ${f.scoreMinRating}+`);
  return parts.join(", ") || "no filter";
}

export const TOOL_ARGS = {
  // READ
  search_people: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  get_person: z.object({ prospectId: z.number().int().positive() }),
  list_sequences: z.object({}).optional().or(z.object({}).passthrough()),
  list_lists: z.object({}).optional().or(z.object({}).passthrough()),
  list_campaigns: z.object({}).optional().or(z.object({}).passthrough()),
  whats_waiting: z.object({}).optional().or(z.object({}).passthrough()),
  help_lookup: z.object({ question: z.string().min(3).max(300) }),
  deals_pipeline: z.object({}).optional().or(z.object({}).passthrough()),
  preview_people_filter: z.object({ filter: PEOPLE_FILTER.refine(filterIsNonEmpty, { message: "At least one filter field is required" }) }),
  list_data_entities: z.object({}).optional().or(z.object({}).passthrough()),
  query_data: EXPLORER_SPEC,
  search_companies: z.object({
    query: z.string().trim().min(1).max(200).optional(),
    hasDomain: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_company: z.object({ companyId: z.number().int().positive() }),
  // NAVIGATE
  navigate: z.object({ href: z.string().min(1).max(200), label: z.string().min(1).max(80) }),
  // MUTATING
  enroll_in_sequence: z.object({ sequenceId: z.number().int().positive(), prospectIds: idList }),
  create_tasks: z.object({
    prospectIds: idList,
    title: z.string().min(1).max(200),
    type: z.enum(["follow_up", "call", "manual_email", "social_touch", "meeting_prep", "todo"]).default("follow_up"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    dueInDays: z.number().int().min(0).max(60).default(2),
  }),
  add_to_list: z.object({
    listId: z.number().int().positive().optional(),
    newListName: z.string().min(1).max(120).optional(),
    prospectIds: idList,
  }).refine((v) => !!v.listId || !!v.newListName, { message: "listId or newListName required" }),
  enrich_prospects: z.object({ prospectIds: z.array(z.number().int().positive()).min(1).max(25) }),
  set_campaign_status: z.object({
    campaignId: z.number().int().positive(),
    status: z.enum(["active", "paused"]),
  }),
  propose_meetings: z.object({
    prospectIds: z.array(z.number().int().positive()).min(1).max(5),
  }),
  create_list_from_filter: z.object({
    newListName: z.string().trim().min(1).max(120),
    filter: PEOPLE_FILTER.refine(filterIsNonEmpty, { message: "At least one filter field is required" }),
    limit: z.number().int().min(1).max(1000).default(500),
  }),
  /**
   * Create an autonomous (ARE) campaign as a DRAFT. Never launches: the
   * campaign sits at status draft, which the engine never ticks, until the
   * user activates it — a separate set_campaign_status confirmation or the
   * campaign page. Autonomy is limited to the two human-in-the-loop modes;
   * fully unattended sending is set on the campaign's settings page by a
   * human, not proposed by the assistant. Caps sit well inside the
   * procedure's own (target ≤ 1,000 of 10,000; daily cap ≤ 100 of 500).
   */
  create_campaign: z.object({
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional(),
    targeting: z.object({
      targetTitles: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
      targetIndustries: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
      targetGeographies: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
      keywords: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
      employeeMin: z.number().int().min(1).max(1_000_000).optional(),
      employeeMax: z.number().int().min(1).max(1_000_000).optional(),
    }).refine((v) => Object.values(v).some((x) => x !== undefined && !(Array.isArray(x) && x.length === 0)), { message: "Targeting needs at least one field" }),
    targetProspectCount: z.number().int().min(1).max(1000).default(100),
    dailySendCap: z.number().int().min(1).max(100).default(25),
    autonomyMode: z.enum(["batch_approval", "review_release"]).default("batch_approval"),
    channels: z.object({ email: z.boolean().default(true), linkedin: z.boolean().default(false) }).default({ email: true, linkedin: false }),
    goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).default("reply"),
    /** Voice/tone guidance for the Sequence Agent's copy. */
    sequencePrompt: z.string().trim().max(4000).optional(),
  }),
  /** Pin a company's brand identity (domain and/or display name) — the same
   *  user·100 override the company page offers; permanent until unpinned. */
  set_company_brand: z.object({
    companyId: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    domain: z.string().trim().min(3).max(200).optional(),
    reason: z.string().trim().max(300).optional(),
  }).refine((v) => !!v.name || !!v.domain, { message: "name or domain required" }),
  update_prospect: z.object({
    prospectId: z.number().int().positive(),
    // Mirrors prospects.update's editable contact fields — additions here
    // must exist there.
    fields: z.object({
      firstName: z.string().min(1).max(80).optional(),
      lastName: z.string().min(1).max(80).optional(),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      companyDomain: z.string().max(200).nullable().optional(),
      email: z.string().max(320).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
      city: z.string().max(80).nullable().optional(),
      state: z.string().max(80).nullable().optional(),
      country: z.string().max(80).nullable().optional(),
      industry: z.string().max(80).nullable().optional(),
      linkedinUrl: z.string().max(500).nullable().optional(),
    }).refine((f) => Object.values(f).some((v) => v !== undefined), { message: "At least one field is required" }),
  }),
  archive_prospects: z.object({ prospectIds: idList }),
} as const;

export type AssistantToolName = keyof typeof TOOL_ARGS;

export const READ_TOOLS: AssistantToolName[] = [
  "search_people", "get_person", "list_sequences", "list_lists", "list_campaigns", "whats_waiting", "help_lookup",
  "deals_pipeline", "preview_people_filter", "list_data_entities", "query_data", "search_companies", "get_company",
];
export const MUTATING_TOOLS: AssistantToolName[] = [
  "enroll_in_sequence", "create_tasks", "add_to_list", "enrich_prospects", "set_campaign_status",
  "propose_meetings", "create_list_from_filter", "create_campaign",
  "set_company_brand", "update_prospect", "archive_prospects",
];

export function isMutatingTool(name: string): name is AssistantToolName {
  return (MUTATING_TOOLS as string[]).includes(name);
}
export function isKnownTool(name: string): name is AssistantToolName {
  return name in TOOL_ARGS;
}

/** Parse + validate a tool call's raw JSON arguments. Throws on violation. */
export function parseToolArgs(name: AssistantToolName, rawJson: string): unknown {
  let parsed: unknown = {};
  if (rawJson && rawJson.trim()) parsed = JSON.parse(rawJson);
  return (TOOL_ARGS[name] as z.ZodTypeAny).parse(parsed ?? {});
}

/** In-app path only — same class of check as @shared/returnPath's redirect
 *  guard: must be a rooted path, never protocol-relative, no traversal. */
export function validateNavigateHref(href: string): boolean {
  return (
    href.startsWith("/") &&
    !href.startsWith("//") &&
    !href.includes("..") &&
    /^[a-zA-Z0-9/_?=&#-]+$/.test(href)
  );
}

/**
 * Compact digest of a turn's tool results, appended to the STORED assistant
 * message (not the displayed answer). Later turns rebuild their context from
 * stored messages, and without this the ids a lookup returned are gone by the
 * next turn — which is exactly how the first live verify produced a proposal
 * for a hallucinated prospect id: the model, asked to act on a person one
 * turn after finding him, had no id left to act with and invented one.
 */
export function buildToolDigest(entries: Array<{ tool: string; result: unknown }>): string {
  if (entries.length === 0) return "";
  const parts = entries.map((e) => `${e.tool}: ${JSON.stringify(e.result)}`.slice(0, 700));
  let digest = parts.join("\n");
  if (digest.length > 2000) digest = digest.slice(0, 2000);
  return `\n\n[assistant_context — tool results from this turn, for later turns; not shown to the user]\n${digest}`;
}

/** Human sentence for the confirmation card — states the blast radius. */
export function describeAction(name: AssistantToolName, args: Record<string, unknown>): string {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (name) {
    case "enroll_in_sequence":
      return `Enroll ${n(args.prospectIds)} ${n(args.prospectIds) === 1 ? "person" : "people"} in sequence #${args.sequenceId}`;
    case "create_tasks":
      return `Create "${args.title}" (${args.type ?? "follow_up"}, ${args.priority ?? "normal"}) for ${n(args.prospectIds)} ${n(args.prospectIds) === 1 ? "person" : "people"}, due in ${args.dueInDays ?? 2} day(s)`;
    case "add_to_list":
      return args.newListName
        ? `Create list "${args.newListName}" and add ${n(args.prospectIds)} ${n(args.prospectIds) === 1 ? "person" : "people"}`
        : `Add ${n(args.prospectIds)} ${n(args.prospectIds) === 1 ? "person" : "people"} to list #${args.listId}`;
    case "enrich_prospects":
      return `Run the full enrichment pass for ${n(args.prospectIds)} ${n(args.prospectIds) === 1 ? "person" : "people"} (may spend verification credits)`;
    case "set_campaign_status":
      return `Set campaign #${args.campaignId} to ${String(args.status).toUpperCase()}`;
    case "propose_meetings":
      return `Draft ${n(args.prospectIds)} meeting proposal${n(args.prospectIds) === 1 ? "" : "s"} — they land in your approval queue; nothing is scheduled or mailed until you approve each one`;
    case "create_list_from_filter":
      return `Create list "${args.newListName}" from everyone ${describePeopleFilter((args.filter ?? {}) as PeopleFilter)} (up to ${args.limit ?? 500} people)`;
    case "create_campaign": {
      const tg = (args.targeting ?? {}) as Record<string, unknown>;
      const bits: string[] = [];
      if (Array.isArray(tg.targetTitles) && tg.targetTitles.length) bits.push(`titles ${tg.targetTitles.join("/")}`);
      if (Array.isArray(tg.targetIndustries) && tg.targetIndustries.length) bits.push(`industries ${tg.targetIndustries.join("/")}`);
      if (Array.isArray(tg.targetGeographies) && tg.targetGeographies.length) bits.push(`in ${tg.targetGeographies.join("/")}`);
      if (Array.isArray(tg.keywords) && tg.keywords.length) bits.push(`keywords ${tg.keywords.join("/")}`);
      if (tg.employeeMin || tg.employeeMax) bits.push(`${tg.employeeMin ?? 1}–${tg.employeeMax ?? "∞"} employees`);
      const ch = (args.channels ?? {}) as { email?: boolean; linkedin?: boolean };
      const channels = [ch.email !== false ? "email" : null, ch.linkedin ? "LinkedIn" : null].filter(Boolean).join(" + ") || "email";
      const mode = args.autonomyMode === "review_release" ? "review & release" : "batch approval";
      return `Create campaign "${args.name}" as a DRAFT — targeting ${bits.join(", ") || "the workspace ICP"}; up to ${args.targetProspectCount ?? 100} prospects, ${args.dailySendCap ?? 25}/day cap, ${channels}, ${mode}. Nothing runs until you activate it.`;
    }
    case "set_company_brand": {
      const parts: string[] = [];
      if (args.domain) parts.push(`domain → ${args.domain}`);
      if (args.name) parts.push(`name → "${args.name}"`);
      return `Pin company #${args.companyId}'s brand: ${parts.join(", ")} — permanent until you unpin it from the company page`;
    }
    case "update_prospect": {
      const fields = (args.fields ?? {}) as Record<string, unknown>;
      const parts = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => (v === null ? `clear ${k}` : `${k} → "${String(v)}"`));
      return `Update person #${args.prospectId}: ${parts.join(", ")}`;
    }
    case "archive_prospects":
      return `Archive ${n(args.prospectIds)} ${n(args.prospectIds) === 1 ? "person" : "people"} (marked rejected — reversible from the People page)`;
    default:
      return `Run ${name}`;
  }
}

/* ─── The LLM-facing tool definitions ────────────────────────────────────── */

const t = (name: string, description: string, parameters: Record<string, unknown>): Tool => ({
  type: "function",
  function: { name, description, parameters },
});

/** LLM-facing mirror of PEOPLE_FILTER — keep the two in sync. */
const FILTER_SCHEMA = {
  type: "object",
  description: "People filter. Set only the fields the user described; at least one is required.",
  properties: {
    search: { type: "string", description: "Free text across name/company/title/email" },
    titleQ: { type: "string", description: "Job title contains (e.g. 'CFO')" },
    companyQ: { type: "string", description: "Company name contains" },
    locationQ: { type: "string", description: "City/state/country contains" },
    industryQ: { type: "string", description: "Industry contains" },
    hasEmail: { type: "boolean" },
    hasPhone: { type: "boolean" },
    hasLinkedin: { type: "boolean" },
    emailStatus: { type: "string", description: "e.g. 'valid'" },
    tiers: { type: "array", items: { type: "string", enum: ["high", "medium", "low"] }, description: "ICP fit tier(s)" },
    seniorities: { type: "array", items: { type: "string" }, description: "Seniority tokens, e.g. ['vp','c-level']" },
    scoreMinRating: { type: "string", enum: ["fair", "good", "excellent"], description: "Minimum fit-score rating" },
  },
};

export const ASSISTANT_TOOLS: Tool[] = [
  t("search_people", "Search the workspace's prospects by name, company, title, or email fragment. Returns compact rows with ids.", {
    type: "object",
    properties: {
      query: { type: "string", description: "Name, company, title, or email fragment" },
      limit: { type: "number", description: "Max rows (default 10, max 25)" },
    },
    required: ["query"],
  }),
  t("get_person", "Fetch one prospect's full detail: contact fields, company, enrichment status, and where each fact came from.", {
    type: "object",
    properties: { prospectId: { type: "number" } },
    required: ["prospectId"],
  }),
  t("list_sequences", "List the workspace's sequences with id, name, and status.", { type: "object", properties: {} }),
  t("list_lists", "List the workspace's people lists with id, name, and member count.", { type: "object", properties: {} }),
  t("list_campaigns", "List autonomous (ARE) campaigns with id, name, and status.", { type: "object", properties: {} }),
  t("whats_waiting", "The attention summary: everything currently waiting on a human (drafts, approvals, replies, proposed meetings, tasks, paused campaigns).", { type: "object", properties: {} }),
  t("help_lookup", "Search the Help Center for how-to guidance. Use for any 'how do I…' question before answering from memory.", {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  }),
  t("deals_pipeline", "Summarize the deals pipeline: opportunity count and total value per stage, overall totals, and the biggest open deals.", { type: "object", properties: {} }),
  t("preview_people_filter", "Count who matches a described people filter and show a small sample. Use this BEFORE create_list_from_filter so the user hears a real number.", {
    type: "object",
    properties: { filter: FILTER_SCHEMA },
    required: ["filter"],
  }),
  t("list_data_entities", "Catalog of everything query_data can query: entity names, what each holds, and their columns with types. Call this before query_data whenever you are not sure of an entity or column name.", { type: "object", properties: {} }),
  t("query_data", "Run a read-only query over any core table: filter, group, aggregate, sort. Use for counting, auditing, and any data question the purpose-built tools don't cover ('how many companies have no domain?', 'sends per campaign this week', 'tasks overdue by owner'). Entities/columns must come from list_data_entities. Results are capped at 100 rows; 'total' reports the full match count.", {
    type: "object",
    properties: {
      entity: { type: "string", description: "Entity name from list_data_entities (e.g. 'companies', 'people', 'email_log')" },
      select: { type: "array", items: { type: "string" }, description: "Columns to return (default: all whitelisted)" },
      filters: {
        type: "array",
        description: "ANDed conditions",
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "starts_with", "is_null", "not_null"] },
            value: { description: "Scalar, or array for 'in'; ISO date strings for date columns; omit for is_null/not_null" },
          },
          required: ["column", "op"],
        },
      },
      groupBy: { type: "array", items: { type: "string" }, description: "Group rows by these columns (returns one row per group)" },
      aggregate: {
        type: "array",
        description: "Aggregates to compute (with or without groupBy). count needs no column.",
        items: {
          type: "object",
          properties: {
            fn: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
            column: { type: "string" },
            as: { type: "string", description: "Output name" },
          },
          required: ["fn"],
        },
      },
      sort: { type: "array", items: { type: "object", properties: { by: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, required: ["by"] } },
      limit: { type: "number", description: "Max rows (default 25, max 100)" },
    },
    required: ["entity"],
  }),
  t("search_companies", "Search the workspace's companies by name/domain fragment, optionally only those with (or without) a resolved domain. Returns compact rows with ids.", {
    type: "object",
    properties: {
      query: { type: "string", description: "Name or domain fragment" },
      hasDomain: { type: "boolean", description: "true = only companies with a domain; false = only companies without one" },
      limit: { type: "number", description: "Max rows (default 15, max 50)" },
    },
  }),
  t("get_company", "Fetch one company's profile: identity (name, domain, brand pin state), firmographics, and scores.", {
    type: "object",
    properties: { companyId: { type: "number" } },
    required: ["companyId"],
  }),
  t("navigate", "Offer the user a link to an in-app page. Use after explaining where to go. href must be an in-app path starting with /.", {
    type: "object",
    properties: { href: { type: "string" }, label: { type: "string" } },
    required: ["href", "label"],
  }),
  t("enroll_in_sequence", "PROPOSE enrolling prospects into a sequence. The user must confirm before anything happens. Look up the sequence id with list_sequences first.", {
    type: "object",
    properties: {
      sequenceId: { type: "number" },
      prospectIds: { type: "array", items: { type: "number" } },
    },
    required: ["sequenceId", "prospectIds"],
  }),
  t("create_tasks", "PROPOSE creating a task for each given prospect. The user must confirm before anything happens.", {
    type: "object",
    properties: {
      prospectIds: { type: "array", items: { type: "number" } },
      title: { type: "string" },
      type: { type: "string", enum: ["follow_up", "call", "manual_email", "social_touch", "meeting_prep", "todo"] },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      dueInDays: { type: "number" },
    },
    required: ["prospectIds", "title"],
  }),
  t("add_to_list", "PROPOSE adding prospects to a people list (existing listId, or newListName to create one). The user must confirm.", {
    type: "object",
    properties: {
      listId: { type: "number" },
      newListName: { type: "string" },
      prospectIds: { type: "array", items: { type: "number" } },
    },
    required: ["prospectIds"],
  }),
  t("enrich_prospects", "PROPOSE running the full enrichment pass (emails, company, profile) for prospects. May spend verification credits. The user must confirm.", {
    type: "object",
    properties: { prospectIds: { type: "array", items: { type: "number" } } },
    required: ["prospectIds"],
  }),
  t("set_campaign_status", "PROPOSE pausing or activating an autonomous campaign. The user must confirm.", {
    type: "object",
    properties: { campaignId: { type: "number" }, status: { type: "string", enum: ["active", "paused"] } },
    required: ["campaignId", "status"],
  }),
  t("propose_meetings", "PROPOSE drafting a meeting proposal for up to 5 prospects. Each draft lands in the user's approval queue — nothing is scheduled or mailed until they approve it there. The user must confirm.", {
    type: "object",
    properties: { prospectIds: { type: "array", items: { type: "number" } } },
    required: ["prospectIds"],
  }),
  t("create_list_from_filter", "PROPOSE creating a people list from a described filter (everyone matching, up to a limit — not just looked-up ids). Preview with preview_people_filter first. The user must confirm.", {
    type: "object",
    properties: {
      newListName: { type: "string" },
      filter: FILTER_SCHEMA,
      limit: { type: "number", description: "Max people to add (default 500, max 1000)" },
    },
    required: ["newListName", "filter"],
  }),
  t("create_campaign", "PROPOSE creating an autonomous (ARE) outbound campaign as a DRAFT from the user's description: who to target (titles, industries, geographies, keywords, company size), how many prospects, daily cap, channels, goal, and tone guidance. It is created as status draft — it discovers and sends nothing until the user activates it (set_campaign_status, a separate confirmation). Autonomy is batch_approval (default) or review_release; fully unattended mode is not available here. If the user gave no name or no targeting, ask before proposing. The user must confirm.", {
    type: "object",
    properties: {
      name: { type: "string", description: "Campaign name (2-200 chars)" },
      description: { type: "string", description: "One or two sentences on purpose/offer" },
      targeting: {
        type: "object",
        description: "Who to find. At least one field.",
        properties: {
          targetTitles: { type: "array", items: { type: "string" }, description: "e.g. ['VP Finance','CFO']" },
          targetIndustries: { type: "array", items: { type: "string" } },
          targetGeographies: { type: "array", items: { type: "string" }, description: "Cities/states/countries" },
          keywords: { type: "array", items: { type: "string" }, description: "Company/topic keywords" },
          employeeMin: { type: "number" },
          employeeMax: { type: "number" },
        },
      },
      targetProspectCount: { type: "number", description: "How many prospects to work (default 100, max 1000)" },
      dailySendCap: { type: "number", description: "Max sends per day once active (default 25, max 100)" },
      autonomyMode: { type: "string", enum: ["batch_approval", "review_release"], description: "batch_approval (default): the user approves batches; review_release: the user reviews and releases each send" },
      channels: { type: "object", properties: { email: { type: "boolean" }, linkedin: { type: "boolean" } } },
      goalType: { type: "string", enum: ["meeting_booked", "reply", "opportunity_created"] },
      sequencePrompt: { type: "string", description: "Voice/tone guidance for the generated emails" },
    },
    required: ["name", "targeting"],
  }),
  t("set_company_brand", "PROPOSE pinning a company's brand identity — its domain and/or display name. A pin is the strongest identity signal (user-verified) and sets the company's icon; it is permanent until the user unpins it. Only propose a domain you have verified belongs to THIS organization. The user must confirm.", {
    type: "object",
    properties: {
      companyId: { type: "number" },
      name: { type: "string", description: "Corrected display name (optional)" },
      domain: { type: "string", description: "The company's own website domain, e.g. acme.org (optional)" },
      reason: { type: "string", description: "Why — shown in the audit trail" },
    },
    required: ["companyId"],
  }),
  t("update_prospect", "PROPOSE editing one person's contact fields (name, title, company, email, phone, location, LinkedIn). Set a field to null to clear it. The user must confirm.", {
    type: "object",
    properties: {
      prospectId: { type: "number" },
      fields: {
        type: "object",
        description: "Only the fields to change",
        properties: {
          firstName: { type: "string" }, lastName: { type: "string" },
          title: { type: ["string", "null"] }, company: { type: ["string", "null"] },
          companyDomain: { type: ["string", "null"] }, email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] }, city: { type: ["string", "null"] },
          state: { type: ["string", "null"] }, country: { type: ["string", "null"] },
          industry: { type: ["string", "null"] }, linkedinUrl: { type: ["string", "null"] },
        },
      },
    },
    required: ["prospectId", "fields"],
  }),
  t("archive_prospects", "PROPOSE archiving people (marks them rejected and hides them from working views; reversible, never a hard delete). The user must confirm.", {
    type: "object",
    properties: { prospectIds: { type: "array", items: { type: "number" } } },
    required: ["prospectIds"],
  }),
];
