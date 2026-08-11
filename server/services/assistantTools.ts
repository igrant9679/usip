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
} as const;

export type AssistantToolName = keyof typeof TOOL_ARGS;

export const READ_TOOLS: AssistantToolName[] = [
  "search_people", "get_person", "list_sequences", "list_lists", "list_campaigns", "whats_waiting", "help_lookup",
];
export const MUTATING_TOOLS: AssistantToolName[] = [
  "enroll_in_sequence", "create_tasks", "add_to_list", "enrich_prospects", "set_campaign_status",
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
    default:
      return `Run ${name}`;
  }
}

/* ─── The LLM-facing tool definitions ────────────────────────────────────── */

const t = (name: string, description: string, parameters: Record<string, unknown>): Tool => ({
  type: "function",
  function: { name, description, parameters },
});

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
];
