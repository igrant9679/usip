/**
 * assistantActionCatalog — "virtually any action you can do in the app",
 * for the AI Assistant (owner ask 2026-09-08).
 *
 * Instead of hand-writing a tool per feature, the catalog is DERIVED from
 * the tRPC app router: every procedure is a candidate, a policy decides
 * whether the assistant may see it, and zod 4's JSON-schema export turns the
 * procedure's own input gate into the schema the model fills in. So the
 * assistant's reach grows with the product, and its inputs are validated by
 * the exact schema the UI's own calls go through.
 *
 * The policy is the safety model, and it is explicit:
 *   - ALLOWED_GROUPS: only routers in this map are exposed (CRM, outreach,
 *     lists, reports, engine, inbound, analytics…). Admin, security, billing,
 *     credentials, team, workspace and danger-zone routers are never listed.
 *   - DENY_LEAF: any procedure whose last segment sends, deletes, wipes, or
 *     touches secrets is excluded regardless of router — sends stay behind
 *     the approval queues (the line the assistant has never crossed), and
 *     hard deletes are a human's click, not a chat reply.
 *   - Queries execute immediately in the chat loop (through createCaller,
 *     under the user's own role). Mutations are PROPOSED and run only after
 *     the user confirms the card — same as every purpose-built tool.
 *
 * assistantActionCatalog.test.ts pins the policy: the catalog is large, and
 * nothing matching the deny list ever appears in it.
 */
import { z } from "zod";

export type ActionKind = "query" | "mutation";

export interface CatalogEntry {
  /** Dotted tRPC path, e.g. "sequences.create". */
  path: string;
  kind: ActionKind;
  group: string;
  title: string;
  description: string;
  /** JSON schema for the procedure input (zod → JSON schema), or a permissive object when the input is untyped. */
  inputSchema: Record<string, unknown>;
  /** The zod gate the confirm path re-validates the stored input with. */
  parse: (input: unknown) => unknown;
  /** True for the approval-queue sends — the card and the model are told email goes out. */
  sends: boolean;
}

/** Router prefix → group label + what it is for (the model reads these). */
export const ALLOWED_GROUPS: Record<string, { group: string; description: string }> = {
  prospects: { group: "People", description: "People (prospects): search, create, update, verify, enrich, convert to lead, archive" },
  contacts: { group: "CRM", description: "Contacts on accounts" },
  accounts: { group: "CRM", description: "Accounts (companies in the CRM)" },
  companies: { group: "CRM", description: "Company records: search, brand pin, enrich, duplicates" },
  leads: { group: "CRM", description: "Leads: create, update, convert, rescore" },
  opportunities: { group: "CRM", description: "Deals / opportunities: create, update, stage moves" },
  deals: { group: "CRM", description: "Deal autopilot and pipeline helpers" },
  tasks: { group: "CRM", description: "Tasks: create, complete, snooze, approve drafts" },
  activities: { group: "CRM", description: "Log calls, meetings and notes on records" },
  crmNotes: { group: "CRM", description: "Notes on CRM records" },
  "customFields": { group: "CRM", description: "Custom fields on records" },
  cs: { group: "Customer Success", description: "Customers, health, renewals, QBRs" },
  meetings: { group: "Outreach", description: "Meetings: create, propose, reschedule, complete, dispositions, autopilot settings" },
  conversations: { group: "Outreach", description: "Inbound replies: classify, mark handled, apply the suggested action" },
  sequences: { group: "Outreach", description: "Sequences: create, update steps, enroll, pause, archive" },
  emailDrafts: { group: "Outreach", description: "Email drafts: approve, reject, compose" },
  emailTemplates: { group: "Outreach", description: "Email templates" },
  snippets: { group: "Outreach", description: "Reusable snippets" },
  sequenceAb: { group: "Outreach", description: "Sequence subject A/B tests" },
  campaigns: { group: "Marketing", description: "Broadcasts (one message to a segment) and their audiences" },
  segments: { group: "Marketing", description: "Saved audiences (rule-based)" },
  segmentRules: { group: "Marketing", description: "Auto-enroll a segment into a sequence" },
  are: { group: "Revenue Engine", description: "Autonomous campaigns: create, update, status, approve/skip/restore people, push people in, regenerate sequences, routing and proposals, metrics, ICP" },
  recordLists: { group: "Lists", description: "People and company lists: create, add and remove members" },
  personas: { group: "Configuration", description: "Buyer personas and categories" },
  brandVoice: { group: "Configuration", description: "Brand voice profile" },
  scoring: { group: "Configuration", description: "Fit-scoring models and criteria" },
  leadScoring: { group: "Configuration", description: "Lead scoring thresholds and recalculation" },
  leadRouting: { group: "Configuration", description: "Lead assignment rules" },
  workflows: { group: "Automation", description: "Workflow rules: create, update, toggle, test fire" },
  workflowsAi: { group: "Automation", description: "AI workflow suggestions" },
  optimization: { group: "Automation", description: "Optimisation recommendations: approve, dismiss, revert" },
  proposals: { group: "Proposals", description: "Client proposals: create, update, sections, milestones, share links, extensions" },
  quotes: { group: "Proposals", description: "Quotes and line items" },
  products: { group: "Proposals", description: "Product catalog" },
  reports: { group: "Analytics", description: "Row-level reports: run, save, schedule, export" },
  dashboards: { group: "Analytics", description: "Custom dashboards and widgets" },
  forecast: { group: "Analytics", description: "Forecast" },
  forms: { group: "Inbound", description: "Lead-capture forms" },
  landingPages: { group: "Inbound", description: "Hosted landing pages" },
  chatAgents: { group: "Inbound", description: "Website chat agents, knowledge and sessions" },
  websiteVisitors: { group: "Inbound", description: "Website visitor tracking" },
  bookingLinks: { group: "Inbound", description: "Your booking link" },
  voiceAgents: { group: "Dialer", description: "AI voice agents (inbound call-backs) and call logs" },
  notifications: { group: "Daily", description: "Inbox notifications" },
  attention: { group: "Daily", description: "What needs a human" },
  mindmaps: { group: "Analytics", description: "Planning canvases" },
  discovery: { group: "Prospecting", description: "Find Prospects searches" },
  prospectImports: { group: "Prospecting", description: "CSV import jobs" },
  dataHealth: { group: "Prospecting", description: "Duplicates, gaps and import audits" },
  emailVerification: { group: "Prospecting", description: "Email verification jobs" },
  helpCenter: { group: "Help", description: "Help articles (read)" },
};

/**
 * Procedures the assistant never sees, whatever router they live in.
 * Sends and messages: the outbound gate. Deletes and wipes: a human's click.
 * Secrets and credentials: never a chat argument.
 */
export const DENY_LEAF = /(send|dispatch|message|reply(?!Class)|delete|remove|purge|wipe|destroy|reset|password|invite|apiKey|secret|token|credential|transfer|archiveWorkspace|acceptByToken|submit$|book$|byToken|import)/i;
/** Whole paths that are read-only public surfaces or otherwise out of scope. */
export const DENY_PATH = /^(helpCenter\.(upsert|create|update|delete|generate)|chatAgents\.(getPublic|sessionByToken)|landingPages\.(getBySlug)|forms\.getByPublicId|bookingLinks\.getPublic|are\.execution\.(pause|resume))/;

/**
 * The approval-queue sends (owner decision 2026-09-09: "open the
 * approval-queue sends to it too"). These are the exact procedures the
 * Emails / Email Drafts / Meetings pages run when a human presses Send or
 * Approve & send on something already approved or proposed — they are
 * exempt from DENY_LEAF and from the router allowlist, flagged `sends`, and
 * their confirm card says out loud that email goes out now. Composing and
 * sending arbitrary mail (contacts.sendAdHocEmail, unipile.sendMessage,
 * proposals.sendToClient) stays excluded: the assistant sends what a queue
 * already holds, never what it wrote a moment ago.
 */
export const SEND_ALLOWLIST: Record<string, string> = {
  "emailDrafts.send": "SENDS EMAIL NOW: send one approved draft to its recipient.",
  "smtpConfig.sendDraft": "SENDS EMAIL NOW: send one approved draft through the workspace sender.",
  "smtpConfig.sendBulkApproved": "SENDS EMAIL NOW: send every approved draft (or the given draftIds, max 200), one per second.",
  "meetings.approveAndSend": "SENDS EMAIL NOW: approve one proposed meeting and email the calendar invite (chosenTime optional — earliest future slot by default).",
  "meetings.approveAllProposed": "SENDS EMAIL NOW: approve and send every pending meeting proposal (expired ones are skipped and reported).",
  "tasks.sendChatFollowUp": "SENDS EMAIL NOW: approve one chat follow-up task and email the suggested follow-up to the visitor.",
  "tasks.sendAllChatFollowUps": "SENDS EMAIL NOW: approve and send every pending chat follow-up (max 50).",
  "tasks.sendSocialInvite": "SENDS A LINKEDIN INVITE NOW: approve one Social Autopilot invite task (within LinkedIn limits).",
  "tasks.sendAllSocialInvites": "SENDS LINKEDIN INVITES NOW: approve every pending Social Autopilot invite task (stops at the LinkedIn limit).",
};

/** Humanise "are.prospects.pushExisting" → "Push existing (Revenue Engine › prospects)". */
export function titleFor(path: string): string {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1];
  const words = leaf.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const scope = parts.slice(0, -1).join(" › ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${scope})`;
}

/** Hand-written descriptions for the actions people ask for most. Everything else gets the router's group description. */
export const ACTION_DESCRIPTIONS: Record<string, string> = {
  "sequences.create": "Create a sequence (draft) with steps: email {subject, body}, wait {days}, task {body}, linkedin_dm {body}, linkedin_invite {note}.",
  "sequences.update": "Edit a sequence's name, description, status or steps.",
  "sequences.bulkEnroll": "Enroll people (prospectIds) into a sequence.",
  "are.campaigns.create": "Create a Revenue Engine campaign (draft unless launch=true).",
  "are.campaigns.update": "Edit a campaign: targeting, sources, prompt, cadence, caps, autonomy mode.",
  "are.campaigns.setStatus": "Set a campaign draft / active / paused / completed.",
  "are.campaigns.approveAllPending": "Approve every enriched, still-pending person in a campaign.",
  "are.prospects.pushExisting": "Add existing people (prospectIds) into a campaign — the Add existing wizard's write path.",
  "are.prospects.approve": "Approve one campaign prospect for sequencing.",
  "are.prospects.bulkApprove": "Approve up to 200 campaign prospects.",
  "are.prospects.bulkReject": "Reject up to 200 campaign prospects with a reason.",
  "are.prospects.generateSequence": "Write (or rewrite with force) one person's campaign sequence.",
  "are.prospects.enrichBatch": "Enrich the next N pending people in a campaign.",
  "recordLists.create": "Create a people or companies list.",
  "recordLists.addMembers": "Add records to a list (recordType prospect | contact | account).",
  "recordLists.removeMember": "Remove one record from a list.",
  "tasks.create": "Create one task (title, type, priority, dueAt, relatedType/relatedId).",
  "tasks.bulkCreateForProspects": "Create the same task for many people.",
  "activities.logCall": "Log a call on a record (disposition, duration, notes).",
  "activities.logMeeting": "Log a meeting on a record.",
  "activities.addNote": "Add a note to a record.",
  "meetings.create": "Create a meeting record manually.",
  "meetings.propose": "Draft a meeting proposal for a prospect (lands in the approval queue).",
  "meetings.reschedule": "Move a scheduled meeting.",
  "meetings.complete": "Mark a meeting completed with a disposition.",
  "opportunities.create": "Create a deal on an account.",
  "opportunities.update": "Update a deal (stage, value, close date, probability, next step).",
  "leads.create": "Create a lead.",
  "leads.convert": "Convert a lead into account + contact + opportunity.",
  "prospects.create": "Create a person record.",
  "prospects.update": "Update a person's fields.",
  "prospects.convertToLead": "Turn a person into a lead.",
  "reports.run": "Run a report spec (object, columns, filters, groupBy, aggregate, sort, limit) and get rows.",
  "reports.save": "Save a report spec under a name.",
  "reports.setSchedule": "Email a saved report daily / weekly / monthly to recipients.",
  "segments.create": "Create a rule-based audience.",
  "campaigns.create": "Create a broadcast (audience + copy; not sending yet).",
  "proposals.create": "Create a client proposal.",
  "quotes.create": "Create a quote on a deal.",
  "workflows.create": "Create a workflow rule (trigger, conditions, actions).",
  "chatAgents.create": "Create a website chat agent.",
  "forms.create": "Create a lead-capture form.",
  "landingPages.create": "Create a landing page.",
  "personas.create": "Create a buyer persona.",
  "brandVoice.save": "Update the brand voice.",
  "conversations.applyAction": "Apply the AI's suggested action to one reply (may propose a meeting).",
  "conversations.markHandled": "Mark a reply handled.",
  "optimization.approve": "Apply or record one optimisation recommendation.",
  "workflowsAi.applySuggestion": "Turn one AI workflow suggestion into a rule.",
  "bookingLinks.update": "Edit your booking link (title, duration, window, timezone).",
};

type ProcedureLike = { _def?: { type?: string; inputs?: unknown[] } };
type RouterLike = { _def?: { procedures?: Record<string, ProcedureLike> } };

let cache: CatalogEntry[] | null = null;

/** Build (once) the catalog from a router instance. Exported for tests. */
export function buildCatalogFrom(router: RouterLike): CatalogEntry[] {
  const procs = router._def?.procedures ?? {};
  const out: CatalogEntry[] = [];
  for (const path of Object.keys(procs).sort()) {
    const proc = procs[path];
    const type = proc?._def?.type;
    if (type !== "query" && type !== "mutation") continue;
    const root = path.split(".")[0];
    const sends = path in SEND_ALLOWLIST;
    const allow = ALLOWED_GROUPS[root] ?? (sends ? { group: "Outreach", description: "Approval-queue sends" } : undefined);
    if (!allow) continue;
    const leaf = path.split(".").pop() ?? "";
    if (!sends && (DENY_LEAF.test(leaf) || DENY_PATH.test(path))) continue;
    const zodInput = (proc._def?.inputs ?? [])[0] as z.ZodTypeAny | undefined;
    let inputSchema: Record<string, unknown> = { type: "object", additionalProperties: true, description: "Untyped input — pass what the page would" };
    if (zodInput) {
      try {
        const js = z.toJSONSchema(zodInput, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
        delete js.$schema;
        inputSchema = js;
      } catch {
        // Leave the permissive schema; the zod gate still validates at confirm time.
      }
    }
    out.push({
      path,
      kind: type,
      group: allow.group,
      title: titleFor(path),
      description: SEND_ALLOWLIST[path] ?? ACTION_DESCRIPTIONS[path] ?? `${allow.description}.`,
      inputSchema,
      parse: (input: unknown) => (zodInput ? zodInput.parse(input ?? {}) : input),
      sends,
    });
  }
  return out;
}

export async function getActionCatalog(): Promise<CatalogEntry[]> {
  if (cache) return cache;
  // Dynamic import breaks the routers.ts ⇄ assistant cycle.
  const { appRouter } = await import("../routers");
  cache = buildCatalogFrom(appRouter as unknown as RouterLike);
  return cache;
}

export async function getAction(path: string): Promise<CatalogEntry | undefined> {
  return (await getActionCatalog()).find((a) => a.path === path);
}

/** Token-scored search over path, title, description and group. */
export function searchCatalog(catalog: CatalogEntry[], query: string | undefined, group?: string, limit = 15): CatalogEntry[] {
  let rows = catalog;
  if (group) rows = rows.filter((a) => a.group.toLowerCase() === group.toLowerCase());
  if (!query || !query.trim()) return rows.slice(0, limit);
  // Stopwords and two-letter tokens ("to" is inside "into", "restore",
  // "into a campaign") otherwise match every boilerplate description.
  const STOP = new Set(["the", "and", "for", "with", "into", "from", "all", "this", "that", "them", "they", "their", "new", "one", "some", "every"]);
  const tokens = Array.from(new Set((query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((t) => !STOP.has(t))));
  const scored = rows.map((a) => {
    const path = a.path.toLowerCase();
    const title = a.title.toLowerCase();
    const desc = a.description.toLowerCase();
    // Hand-described actions are the ones people ask for in plain words, so
    // their description words carry real signal; a router-group boilerplate
    // description ("Autonomous campaigns: create, update, …") matches every
    // sibling procedure equally and must not outrank them.
    const described = !!ACTION_DESCRIPTIONS[a.path] || a.sends;
    let score = 0;
    for (const t of tokens) {
      if (path.includes(t)) score += 4;
      if (title.includes(t)) score += 3;
      if (desc.includes(t)) score += described ? 6 : 1;
      if (a.group.toLowerCase().includes(t)) score += 1;
    }
    if (score > 0 && described) score += 4;
    return { a, score };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map((x) => x.a);
}

/** Compact catalog row for the model (schema included so it can fill inputs). */
export function catalogRowForModel(a: CatalogEntry) {
  return { path: a.path, kind: a.kind, group: a.group, title: a.title, description: a.description, input: a.inputSchema };
}

/** Confirmation-card sentence for a generic action. */
export function describeGenericAction(a: CatalogEntry, input: unknown): string {
  const args = JSON.stringify(input ?? {});
  const short = args.length > 300 ? `${args.slice(0, 300)}…` : args;
  return `${a.sends ? "⚠ Sends now — " : ""}Run ${a.title}: ${a.description} Input: ${short}`;
}

/** Walk a dotted path on the tRPC caller and invoke it. */
export async function invokeCallerPath(caller: unknown, path: string, input: unknown): Promise<unknown> {
  const fn = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), caller);
  if (typeof fn !== "function") throw new Error(`Unknown procedure ${path}`);
  return (fn as (i: unknown) => Promise<unknown>)(input);
}
