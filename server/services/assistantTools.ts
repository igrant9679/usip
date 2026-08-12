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
} as const;

export type AssistantToolName = keyof typeof TOOL_ARGS;

export const READ_TOOLS: AssistantToolName[] = [
  "search_people", "get_person", "list_sequences", "list_lists", "list_campaigns", "whats_waiting", "help_lookup",
  "deals_pipeline", "preview_people_filter",
];
export const MUTATING_TOOLS: AssistantToolName[] = [
  "enroll_in_sequence", "create_tasks", "add_to_list", "enrich_prospects", "set_campaign_status",
  "propose_meetings", "create_list_from_filter",
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
];
