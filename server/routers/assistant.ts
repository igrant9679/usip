/**
 * Action-capable AI Assistant — chat with a bounded tool set.
 *
 * The loop: the model sees the tool registry (services/assistantTools.ts),
 * READ tools execute immediately, and the FIRST mutating tool call ends the
 * turn as a *pending action* the user must confirm in-chat. confirmAction
 * then executes it — both paths go through appRouter.createCaller(ctx), so
 * every role check, workspace scope, cap, and audit the UI's own procedures
 * enforce applies to the assistant identically. It is the same user pressing
 * a different button.
 *
 * Tool results are fed back as plain `[tool_result …]` user messages rather
 * than provider tool-protocol messages — invokeLLM's Message type cannot
 * carry assistant tool_calls for replay, and the envelope works identically
 * on every provider behind invokeLLM.
 *
 * Sends are structurally absent: no tool dispatches email or LinkedIn
 * messages, so the assistant cannot be talked into crossing the outbound
 * gate the autopilot dials enforce.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { inArray } from "drizzle-orm";
import { getDb } from "../db";
import { aiAssistantProposals, aiHelpConversations, aiHelpMessages, helpArticles, prospects } from "../../drizzle/schema";
import { invokeLLM, type Message } from "../_core/llm";
import { recordAudit } from "../audit";
import {
  ASSISTANT_TOOLS,
  TOOL_ARGS,
  type AssistantToolName,
  buildToolDigest,
  describeAction,
  isKnownTool,
  isMutatingTool,
  parseToolArgs,
  validateNavigateHref,
} from "../services/assistantTools";
import { buildEntityCatalog, runExplorerQuery } from "../services/assistantDataExplorer";
import { catalogRowForModel, describeGenericAction, getAction, getActionCatalog, invokeCallerPath, searchCatalog } from "../services/assistantActionCatalog";
import { PRODUCT_KNOWLEDGE } from "../productKnowledge";

// 8 rounds: a conversational plan (look up → preview → propose) plus the
// catalog round-trip (list_actions → run_action) fits; 5 cut the second leg.
const MAX_ROUNDS = 8;
/** Proposals per turn. A plan like "create the list, add them to the
 *  campaign, queue the calls" is three cards the user confirms one by one. */
const MAX_PROPOSALS_PER_TURN = 3;

/** Page through prospects.list with a described filter — the same query
 *  preview_people_filter ran, capped to what the confirmation card promised. */
async function collectFilterIds(caller: Awaited<ReturnType<typeof getCaller>>, filter: Record<string, unknown>, limit: number): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; ids.length < limit && page <= 10; page++) {
    const res = (await caller.prospects.list({ page, perPage: 200, ...filter } as never)) as { total: number; data: Array<{ id: number }> };
    ids.push(...res.data.map((p) => p.id));
    if (page * 200 >= res.total) break;
  }
  return ids.slice(0, limit);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
/** A proposal the user has not answered goes stale — the world it described
 *  (ids, counts) drifts, and a card left open for a day should not still be
 *  executable. */
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** Refuse any action whose prospectIds are not real rows in THIS workspace —
 *  the model can hallucinate an id, and the underlying procs create dangling
 *  references rather than checking. */
async function assertProspectsExist(workspaceId: number, ids: number[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const rows = await db.select({ id: prospects.id }).from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, ids)));
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown prospect id(s): ${missing.join(", ")} — ask the assistant to look the people up again.`,
    });
  }
}

type Caller = ReturnType<Awaited<typeof getCaller>>;
async function getCaller(ctx: unknown) {
  // Dynamic import breaks the routers.ts ⇄ assistant.ts cycle.
  const { appRouter } = await import("../routers");
  return appRouter.createCaller(ctx as never);
}

/** Compact a prospect row for LLM context — NEVER include profile_image
 *  (mirrored avatars are inline data URIs, kilobytes of base64 per row). */
const compactPerson = (p: Record<string, unknown>) => ({
  id: p.id,
  name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
  title: p.title ?? null,
  company: p.company ?? null,
  companyDomain: p.companyDomain ?? null,
  email: p.email ?? null,
  emailStatus: p.emailStatus ?? null,
  phone: p.phone ?? null,
  linkedinUrl: p.linkedinUrl ?? null,
  fitScore: (p as { fitScore?: number }).fitScore ?? null,
});

async function runReadTool(
  name: AssistantToolName,
  args: Record<string, unknown>,
  ctx: { workspace: { id: number } },
  caller: Awaited<ReturnType<typeof getCaller>>,
): Promise<{ result: unknown; summary: string }> {
  switch (name) {
    case "search_people": {
      const limit = Math.min(25, Number(args.limit ?? 10));
      const res = (await caller.prospects.list({
        page: 1, perPage: Math.max(10, limit), search: String(args.query),
      } as never)) as { total: number; data: Record<string, unknown>[] };
      return {
        result: { total: res.total, people: res.data.slice(0, limit).map(compactPerson) },
        summary: `Searched people for "${args.query}" — ${res.total} match(es)`,
      };
    }
    case "get_person": {
      const p = (await caller.prospects.get({ id: Number(args.prospectId) } as never)) as Record<string, unknown> | null;
      if (!p) return { result: { error: "not found" }, summary: `Person #${args.prospectId} not found` };
      const { fieldProvenance } = p as { fieldProvenance?: Record<string, { source?: string }> };
      return {
        result: {
          ...compactPerson(p),
          city: p.city ?? null, state: p.state ?? null, country: p.country ?? null,
          lastEnrichedAt: p.lastEnrichedAt ?? null,
          fieldSources: fieldProvenance
            ? Object.fromEntries(Object.entries(fieldProvenance).map(([k, v]) => [k, v?.source ?? "unknown"]))
            : {},
        },
        summary: `Fetched person #${args.prospectId}`,
      };
    }
    case "list_sequences": {
      const s = (await caller.sequences.list()) as Record<string, unknown>[];
      return {
        result: s.map((x) => ({ id: x.id, name: x.name, status: x.status, enrolledCount: x.enrolledCount ?? null })),
        summary: `Listed ${s.length} sequence(s)`,
      };
    }
    case "list_lists": {
      const l = (await caller.recordLists.list()) as Record<string, unknown>[];
      const people = l.filter((x) => x.entityType !== "companies");
      return {
        result: people.map((x) => ({ id: x.id, name: x.name, memberCount: x.memberCount ?? 0 })),
        summary: `Listed ${people.length} people list(s)`,
      };
    }
    case "list_campaigns": {
      const c = (await caller.are.campaigns.list({ limit: 20 } as never)) as Record<string, unknown>[];
      return {
        result: (c ?? []).map((x) => ({ id: x.id, name: x.name, status: x.status })),
        summary: `Listed ${(c ?? []).length} campaign(s)`,
      };
    }
    case "whats_waiting": {
      const s = await caller.attention.summary();
      // Bound the context cost — the summary is small, but never trust that.
      return { result: JSON.parse(JSON.stringify(s).slice(0, 4000)), summary: "Fetched the attention summary" };
    }
    case "deals_pipeline": {
      const board = (await caller.opportunities.board()) as Array<Record<string, unknown>>;
      const open = board.filter((o) => !/closed/i.test(String(o.stage ?? "")));
      const byStage = new Map<string, { count: number; value: number }>();
      for (const o of board) {
        const s = String(o.stage ?? "unknown");
        const agg = byStage.get(s) ?? { count: 0, value: 0 };
        agg.count++; agg.value += Number(o.value ?? 0);
        byStage.set(s, agg);
      }
      const topOpen = open
        .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
        .slice(0, 5)
        .map((o) => ({ id: o.id, name: o.name, account: o.accountName, stage: o.stage, value: Number(o.value ?? 0), winProb: o.winProb ?? null, closeDate: o.closeDate ?? null }));
      return {
        result: {
          totalDeals: board.length,
          openDeals: open.length,
          openValue: open.reduce((s, o) => s + Number(o.value ?? 0), 0),
          stages: Array.from(byStage.entries()).map(([stage, a]) => ({ stage, count: a.count, value: a.value })),
          topOpen,
        },
        summary: `Summarized the pipeline — ${open.length} open deal(s)`,
      };
    }
    case "preview_people_filter": {
      const filter = (args.filter ?? {}) as Record<string, unknown>;
      const res = (await caller.prospects.list({ page: 1, perPage: 10, ...filter } as never)) as { total: number; data: Record<string, unknown>[] };
      return {
        result: {
          total: res.total,
          sample: res.data.slice(0, 10).map((p) => ({ id: p.id, name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(), title: p.title ?? null, company: p.company ?? null })),
        },
        summary: `Previewed a people filter — ${res.total} match(es)`,
      };
    }
    case "list_data_entities":
      return { result: { entities: buildEntityCatalog() }, summary: "Listed the queryable data entities" };
    case "query_data": {
      const spec = args as { entity?: unknown };
      const r = await runExplorerQuery(ctx.workspace.id, args);
      return {
        result: r,
        summary: `Queried ${String(spec.entity)} — ${r.rows.length} row(s)${r.total !== undefined ? ` of ${r.total}` : ""}`,
      };
    }
    case "search_companies": {
      const limit = Math.min(50, Number(args.limit ?? 15));
      const res = (await caller.companies.search({
        page: 1, perPage: 200,
        filters: args.query ? { q: String(args.query) } : {},
      } as never)) as { total: number; data: Record<string, unknown>[] };
      let rows = res.data;
      if (args.hasDomain === true) rows = rows.filter((c) => c.domain);
      if (args.hasDomain === false) rows = rows.filter((c) => !c.domain);
      return {
        result: {
          total: args.hasDomain === undefined ? res.total : rows.length,
          companies: rows.slice(0, limit).map((c) => ({
            id: c.id, name: c.name, domain: c.domain ?? null, industry: c.industry ?? null,
            employeeCount: c.employeeCount ?? null, accountStage: c.accountStage ?? null,
            contactCount: c.contactCount ?? 0,
          })),
        },
        summary: `Searched companies${args.query ? ` for "${args.query}"` : ""} — ${args.hasDomain === undefined ? res.total : rows.length} match(es)`,
      };
    }
    case "get_company": {
      const c = (await caller.companies.get({ accountId: Number(args.companyId) } as never)) as Record<string, unknown> | null;
      if (!c) return { result: { error: "not found" }, summary: `Company #${args.companyId} not found` };
      const override = c.brandOverride as { domain?: string; name?: string } | null;
      return {
        result: {
          id: c.id, name: c.name, domain: c.domain ?? null, websiteUrl: c.websiteUrl ?? null,
          industry: c.industry ?? null, employeeCount: c.employeeCount ?? null, revenue: c.revenue ?? null,
          hq: [c.hqCity, c.hqState, c.hqCountry].filter(Boolean).join(", ") || null,
          accountStage: c.accountStage ?? null, accountScore: c.accountScore ?? null,
          accountRating: c.accountRating ?? null, contactCount: c.contactCount ?? 0,
          brandPinned: !!override,
          brandPin: override ? { domain: override.domain ?? null, name: override.name ?? null } : null,
          archived: !!c.archivedAt,
          description: typeof c.description === "string" ? c.description.slice(0, 400) : null,
        },
        summary: `Fetched company #${args.companyId}`,
      };
    }
    case "help_lookup": {
      const db = await getDb();
      if (!db) return { result: { articles: [] }, summary: "Help lookup unavailable" };
      const articles = await db
        .select({ id: helpArticles.id, slug: helpArticles.slug, title: helpArticles.title, summary: helpArticles.summary, body: helpArticles.bodyMarkdown })
        .from(helpArticles)
        .where(and(eq(helpArticles.workspaceId, ctx.workspace.id), eq(helpArticles.status, "published")))
        .limit(200); // catalogue passed 70 with the Operator's Manual; a cap below it drops the newest articles
      const tokens = Array.from(new Set(String(args.question).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []));
      const scored = articles
        .map((a) => {
          let score = 0;
          for (const t of tokens) {
            if ((a.title ?? "").toLowerCase().includes(t)) score += 4;
            if ((a.summary ?? "").toLowerCase().includes(t)) score += 2;
            if ((a.body ?? "").toLowerCase().includes(t)) score += 1;
          }
          return { a, score };
        })
        .sort((x, y) => y.score - x.score)
        .slice(0, 4);
      return {
        result: {
          articles: scored.map(({ a }) => ({ slug: a.slug, title: a.title, summary: a.summary, excerpt: (a.body ?? "").slice(0, 1200) })),
        },
        summary: `Looked up help for "${args.question}"`,
      };
    }
    case "list_actions": {
      const catalog = await getActionCatalog();
      const rows = searchCatalog(catalog, args.query as string | undefined, args.group as string | undefined, 15);
      return {
        result: { total: catalog.length, actions: rows.map(catalogRowForModel) },
        summary: `Searched the action catalog${args.query ? ` for "${args.query}"` : ""} — ${rows.length} of ${catalog.length}`,
      };
    }
    case "run_read_action": {
      const entry = await getAction(String(args.path));
      if (!entry) return { result: { error: `Unknown or disallowed action ${args.path} — use list_actions` }, summary: `Unknown action ${args.path}` };
      if (entry.kind !== "query") return { result: { error: `${entry.path} changes data — propose it with run_action instead` }, summary: `${entry.path} is a mutation` };
      const input = entry.parse(args.input ?? {});
      const r = await invokeCallerPath(caller, entry.path, input);
      return { result: JSON.parse(JSON.stringify(r ?? null).slice(0, 6000)), summary: `Ran ${entry.path}` };
    }
    case "list_report_fields": {
      const s = await caller.reports.schema();
      return { result: JSON.parse(JSON.stringify(s).slice(0, 6000)), summary: "Listed the report objects and columns" };
    }
    case "run_report": {
      const r = (await caller.reports.run(args as never)) as { rows?: unknown[]; total?: number };
      const rows = Array.isArray(r?.rows) ? r.rows : (Array.isArray(r) ? (r as unknown[]) : []);
      return {
        result: JSON.parse(JSON.stringify({ total: r?.total ?? rows.length, rows: rows.slice(0, 50) }).slice(0, 6000)),
        summary: `Ran a ${String(args.object)} report — ${rows.length} row(s)`,
      };
    }
    default:
      return { result: { error: "unknown tool" }, summary: `Unknown tool ${name}` };
  }
}

const SYSTEM_PROMPT = (pageKey: string | undefined) => `You are Velocity's in-app assistant and operator. You can look anything up, run reports, and do virtually anything the user can do in the app — create and edit campaigns, sequences, lists, deals, leads, tasks, meetings, proposals, quotes, workflows, personas, reports; add batches of people to campaigns, sequences and lists by criteria; log and queue calls — always by PROPOSING the action, which runs only after the user confirms the card in the chat.

How to work with the user:
- Be consultative. When a request is ambiguous in a way that changes the outcome (which campaign, which criteria, how many, draft or active), ask ONE focused question with ask_user and offer 2–4 concrete options. Do not ask about things you can look up or that have an obvious default.
- Make recommendations, with the reason and the number behind it. If asked "should I…" or "what should I do", look at the real data first (whats_waiting, query_data, run_report, are.metrics via run_read_action) and give a clear recommendation plus the one alternative worth considering.
- Walk the user through what you do: before a multi-step plan, state the steps in one line; as you act, say what each tool told you; after a confirmed action, say what happened and what the sensible next step is.
- For batches by criteria ("add all the CFOs in Texas to the sequence"): preview_people_filter first, tell the user the real count and a few names, then propose the batch tool (add_to_campaign_by_filter, enroll_by_filter, add_to_list_by_filter, create_list_from_filter) with the same filter. If the count looks wrong, refine the filter with the user before proposing.
- For anything no purpose-built tool covers, call list_actions to find the app action, read its input schema, look up any ids it needs, then run_read_action (queries) or run_action (mutations). Never guess a path or an id.
- Calls: Velocity does not place outbound calls (voice agents answer inbound call-backs only). "Call these people" means queue_calls (call tasks with the phone number) or log_call for a call that happened.
- The user should never be lost. End every answer with the sensible next step, or the one question that decides it. When they ask "what should I do next" or "what now", read whats_waiting and the page they are on, then give a short ordered plan and offer to start the first item.

Rules:
- Use tools for facts. Never invent prospect ids, sequence names, or counts — search first. For "how do I…" questions call help_lookup and answer from what it returns.
- You can see ALL of the workspace's data: query_data runs read-only filter/group/aggregate queries over every core table (people, companies, campaigns, email log, replies, meetings, tasks, deals, sequences, brand observations, audit log…). Use it for counting, auditing, "which rows…", and any question the purpose-built tools don't cover. Call list_data_entities first when unsure of an entity or column name — never guess one.
- Numeric ids may ONLY come from tool results — either this turn's, or an [assistant_context …] block at the end of an earlier assistant message (that block holds prior turns' tool results). If no real id is in context, look the person or object up again before proposing an action. The server rejects actions naming ids that don't exist.
- Mutating tools (every tool whose description says PROPOSE, plus run_action) only PROPOSE: calling one shows the user a confirmation card. You may propose up to three actions in one turn when they form one plan the user asked for (say what each card does); otherwise one. Only propose what the user asked for, with ids you obtained from lookups this conversation.
- create_campaign makes a DRAFT only: it never launches. If the user wants it running, that is a second step (set_campaign_status to active) in a later turn, after they have seen the draft. Fill targeting from what the user said; if they gave no name or no targeting, ask rather than invent.
- For "make a list of everyone who…" requests, call preview_people_filter first and tell the user the real count, then propose create_list_from_filter with the same filter.
- You cannot send email or LinkedIn messages, and must not promise to. Sends live behind the user's approval queues.
- Use navigate to hand the user a link when the answer is "go to this page".
- ask_user ends your turn and shows the options as buttons; the user's pick arrives as their next message. Use it for decisions, not for small talk.
- Tool results arrive as [tool_result …] messages. After reading one, either call another tool or give your final answer as plain text.
- Be concise and concrete. Short sentences, tight lists, real names and numbers from tool results.
- The user opened the assistant from this page: ${pageKey ?? "unknown"}. Use it to interpret "this page" / "here" and to pick navigate targets.
- For "what should I do today / this week / this month" call whats_waiting first, then answer as the routine below applied to those real counts — name the queues that are non-empty and skip the ones that are. For "where is X" / "how do I X" answer from the page map and, when depth is needed, help_lookup (the Help Center's Operator's Manual articles cover every page, routine and process).

OPERATOR'S MANUAL (the product's mental model, vocabulary, page map, dials and routines — trust it, and keep its vocabulary exact):
${PRODUCT_KNOWLEDGE}`;

export const assistantRouter = router({
  chat: workspaceProcedure
    .input(z.object({
      conversationId: z.number(),
      message: z.string().min(1).max(2000),
      pageKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [conv] = await db.select().from(aiHelpConversations)
        .where(and(eq(aiHelpConversations.id, input.conversationId), eq(aiHelpConversations.userId, ctx.user.id)))
        .limit(1);
      if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });

      const prior = await db.select().from(aiHelpMessages)
        .where(eq(aiHelpMessages.conversationId, input.conversationId))
        .orderBy(aiHelpMessages.createdAt)
        .limit(24);

      await db.insert(aiHelpMessages).values({ conversationId: input.conversationId, role: "user", body: input.message });

      const caller = await getCaller(ctx);
      const messages: Message[] = [
        { role: "system", content: SYSTEM_PROMPT(input.pageKey) },
        ...prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.body })),
        { role: "user", content: input.message },
      ];

      const toolEvents: Array<{ tool: string; summary: string }> = [];
      const toolResults: Array<{ tool: string; result: unknown }> = [];
      const navigations: Array<{ href: string; label: string }> = [];
      type Pending = { nonce: string; tool: string; args: Record<string, unknown>; description: string; expiresAt: string };
      const pendingActions: Pending[] = [];
      let question: { text: string; options: string[] } | null = null;
      let answer = "";

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await invokeLLM({
          messages,
          tools: ASSISTANT_TOOLS,
          toolChoice: "auto",
          maxTokens: 1400,
          workspaceId: ctx.workspace.id,
        });
        const msg = res.choices[0]?.message;
        const calls = msg?.tool_calls ?? [];
        const text = typeof msg?.content === "string" ? msg.content : "";

        if (calls.length === 0) { answer = text; break; }

        for (const call of calls) {
          const name = call.function.name;
          if (!isKnownTool(name)) {
            messages.push({ role: "user", content: `[tool_result ${name}]: {"error":"unknown tool"}` });
            continue;
          }
          let args: Record<string, unknown>;
          try {
            args = parseToolArgs(name, call.function.arguments) as Record<string, unknown>;
          } catch (e) {
            messages.push({ role: "user", content: `[tool_result ${name}]: {"error":${JSON.stringify((e as Error).message.slice(0, 200))}}` });
            continue;
          }

          if (isMutatingTool(name)) {
            // Proposals end the turn — the user decides from here. Each proposal
            // is a server-held row; the client only gets its nonce, and
            // confirm/decline consume that row (0168). The args that run are
            // the ones stored HERE, never the ones a client sends back. Up to
            // MAX_PROPOSALS_PER_TURN cards may be made in one turn (a plan).
            if (pendingActions.length >= MAX_PROPOSALS_PER_TURN) {
              messages.push({ role: "user", content: `[tool_result ${name}]: {"error":"proposal limit for this turn reached — the user will confirm the cards first"}` });
              continue;
            }
            let description = describeAction(name, args);
            if (name === "run_action") {
              // Generic gate: the path must be an allowlisted MUTATION and the
              // input must pass the procedure's own zod schema now, so the card
              // never promises something the confirm step would reject.
              const entry = await getAction(String(args.path));
              if (!entry) { messages.push({ role: "user", content: `[tool_result run_action]: {"error":"unknown or disallowed action — use list_actions"}` }); continue; }
              if (entry.kind !== "mutation") { messages.push({ role: "user", content: `[tool_result run_action]: {"error":"${entry.path} is a query — use run_read_action"}` }); continue; }
              try { args = { path: entry.path, input: entry.parse(args.input ?? {}) }; }
              catch (e) { messages.push({ role: "user", content: `[tool_result run_action]: {"error":${JSON.stringify(`input rejected: ${(e as Error).message.slice(0, 300)}`)}}` }); continue; }
              description = describeGenericAction(entry, args.input);
            }
            const nonce = randomBytes(24).toString("base64url");
            const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
            await db.insert(aiAssistantProposals).values({
              workspaceId: ctx.workspace.id, userId: ctx.user.id, conversationId: input.conversationId,
              nonce, tool: name, args, description, expiresAt,
            } as never);
            pendingActions.push({ nonce, tool: name, args, description, expiresAt: expiresAt.toISOString() });
            messages.push({ role: "user", content: `[tool_result ${name}]: {"ok":true,"note":"proposed — the user sees a confirmation card"}` });
            if (text) answer = text;
            continue;
          }
          if (name === "ask_user") {
            question = { text: String(args.question), options: (args.options as string[]) };
            if (text) answer = text;
            continue;
          }
          if (name === "navigate") {
            const href = String(args.href);
            if (validateNavigateHref(href)) {
              navigations.push({ href, label: String(args.label) });
              messages.push({ role: "user", content: `[tool_result navigate]: {"ok":true,"note":"link shown to the user"}` });
            } else {
              messages.push({ role: "user", content: `[tool_result navigate]: {"error":"href must be an in-app path"}` });
            }
            continue;
          }
          try {
            const { result, summary } = await runReadTool(name, args, ctx, caller);
            toolEvents.push({ tool: name, summary });
            toolResults.push({ tool: name, result });
            messages.push({ role: "user", content: `[tool_result ${name}]: ${JSON.stringify(result).slice(0, 6000)}` });
          } catch (e) {
            const emsg = (e as Error).message?.slice(0, 200) ?? "failed";
            toolEvents.push({ tool: name, summary: `${name} failed: ${emsg}` });
            messages.push({ role: "user", content: `[tool_result ${name}]: {"error":${JSON.stringify(emsg)}}` });
          }
        }
        if (pendingActions.length > 0 || question) {
          if (!answer) answer = question ? question.text : (pendingActions.length === 1 ? "Ready when you are — confirm below to run it." : `${pendingActions.length} actions proposed — confirm each card to run it.`);
          break;
        }
      }

      // Rounds exhausted mid-tool-use: the model has results it never got to
      // narrate (query_data turns hit this — first live probe ended on "Let me
      // check…" with the number sitting unread in a tool result). One final
      // call WITHOUT tools forces it to answer from what it gathered.
      if (!answer && pendingActions.length === 0 && !question) {
        messages.push({ role: "user", content: "[assistant_note]: Tool budget for this turn is used up. Answer the user's question now from the tool results above; say plainly if something is still missing." });
        const res = await invokeLLM({ messages, maxTokens: 1400, workspaceId: ctx.workspace.id });
        const msg = res.choices[0]?.message;
        answer = (typeof msg?.content === "string" ? msg.content : "") || "";
      }

      if (!answer) answer = "I couldn't produce an answer — try rephrasing.";

      // Store the answer PLUS a tool digest: later turns rebuild context from
      // stored messages, and ids the model looked up this turn must survive
      // into the next or it will act on invented ones.
      await db.insert(aiHelpMessages).values({
        conversationId: input.conversationId,
        role: "assistant",
        body: answer + buildToolDigest(toolResults),
      });
      await db.update(aiHelpConversations).set({ lastMessageAt: new Date() } as never)
        .where(and(eq(aiHelpConversations.workspaceId, ctx.workspace.id), eq(aiHelpConversations.id, input.conversationId)));

      return { answer, toolEvents, navigations, pendingAction: pendingActions[0] ?? null, pendingActions, question };
    }),

  /**
   * Execute a proposal the assistant made in THIS user's conversation. The
   * client sends only the nonce; the tool and args come from the stored
   * proposal row, which is consumed atomically (one outcome, once, inside
   * its TTL) BEFORE anything runs — so a double click, a replay, or a
   * hand-crafted payload cannot execute twice or execute something the
   * assistant never proposed. Execution still goes through createCaller under
   * the caller's own role, so the assistant can only do what the user could
   * do from the UI. (Before 0168 this took {tool,args} from the client.)
   */
  confirmAction: workspaceProcedure
    .input(z.object({ nonce: z.string().min(16).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [proposal] = await db.select().from(aiAssistantProposals)
        .where(and(
          eq(aiAssistantProposals.nonce, input.nonce),
          eq(aiAssistantProposals.workspaceId, ctx.workspace.id),
          eq(aiAssistantProposals.userId, ctx.user.id),
        )).limit(1);
      if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "That proposal isn't in this conversation any more — ask the assistant again." });
      if (proposal.consumedAt) throw new TRPCError({ code: "BAD_REQUEST", message: `That proposal was already ${proposal.outcome ?? "answered"}.` });
      if (proposal.expiresAt.getTime() < Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "That proposal has expired — ask the assistant again so it can re-check the details." });
      if (!isKnownTool(proposal.tool) || !isMutatingTool(proposal.tool)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not a confirmable action" });
      }
      const name = proposal.tool as AssistantToolName;
      // Re-validate the STORED args through the same gate that admitted them.
      const args = (TOOL_ARGS[name] as z.ZodTypeAny).parse(proposal.args) as Record<string, unknown>;

      // Consume first, atomically: whoever flips consumedAt wins; a second
      // confirm (double click, replay) sees 0 rows and stops here.
      const res = await db.update(aiAssistantProposals)
        .set({ consumedAt: new Date(), outcome: "confirmed" } as never)
        .where(and(eq(aiAssistantProposals.id, proposal.id), isNull(aiAssistantProposals.consumedAt)));
      const affected = Number((res as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0);
      if (affected !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "That proposal was already answered." });

      // Hallucinated-id guard: every prospect the action names must be a real
      // row in this workspace before anything executes.
      if (Array.isArray(args.prospectIds)) {
        await assertProspectsExist(ctx.workspace.id, args.prospectIds as number[]);
      }
      const caller = await getCaller(ctx);

      let summary = "";
      try {
      switch (name) {
        case "enroll_in_sequence": {
          const r = (await caller.sequences.bulkEnroll({
            sequenceId: args.sequenceId, prospectIds: args.prospectIds,
          } as never)) as { enrolled?: number; skippedAlreadyEnrolled?: number; blockedInvalidEmail?: number };
          summary = `Enrolled ${r.enrolled ?? 0}`
            + ((r.skippedAlreadyEnrolled ?? 0) > 0 ? `, ${r.skippedAlreadyEnrolled} already enrolled` : "")
            + ((r.blockedInvalidEmail ?? 0) > 0 ? `, ${r.blockedInvalidEmail} blocked (invalid email)` : "");
          break;
        }
        case "create_tasks": {
          const r = (await caller.tasks.bulkCreateForProspects(args as never)) as { created?: number };
          summary = `Created ${r.created ?? (args.prospectIds as number[]).length} task(s)`;
          break;
        }
        case "add_to_list": {
          let listId = args.listId as number | undefined;
          if (!listId) {
            const created = (await caller.recordLists.create({ name: args.newListName, entityType: "people" } as never)) as { id: number };
            listId = created.id;
          }
          const r = (await caller.recordLists.addMembers({
            listId, recordType: "prospect", recordIds: args.prospectIds,
          } as never)) as { added?: number };
          summary = `Added ${r.added ?? 0} to list #${listId}`;
          break;
        }
        case "enrich_prospects": {
          const r = (await caller.prospects.findContactInfoBatch({
            prospectIds: args.prospectIds, skipIfHasEmail: true,
          } as never)) as { processed: number; withEmail: number; reoonCredits: number; needsLinkedIn?: number[] };
          let liNote = "";
          if ((r.needsLinkedIn ?? []).length > 0) {
            await caller.linkedinEnrichment.run({ prospectIds: r.needsLinkedIn, triggerType: "people_bulk_action" } as never);
            liNote = `; LinkedIn profiles queued for ${r.needsLinkedIn!.length}`;
          }
          summary = `Enriched ${r.processed} — ${r.withEmail} with an email, ${r.reoonCredits} credit(s) spent${liNote}`;
          break;
        }
        case "set_campaign_status": {
          await caller.are.campaigns.setStatus({ id: args.campaignId, status: args.status } as never);
          summary = `Campaign #${args.campaignId} is now ${String(args.status)}`;
          break;
        }
        case "propose_meetings": {
          // meetings.propose drafts into the approval queue; approveAndSend is
          // a separate human step, so this stays on the right side of the
          // no-sends line even though a meeting invite is ultimately an email.
          let drafted = 0;
          const failed: number[] = [];
          for (const id of args.prospectIds as number[]) {
            try {
              await caller.meetings.propose({ relatedId: id, relatedType: "prospect" } as never);
              drafted++;
            } catch {
              failed.push(id);
            }
          }
          summary = `Drafted ${drafted} meeting proposal(s) — review them in the approval queue`
            + (failed.length ? `; ${failed.length} failed (#${failed.join(", #")})` : "");
          break;
        }
        case "create_campaign": {
          // DRAFT only, by construction: `launch` is not part of the tool's
          // args and is never passed, so the engine never ticks this campaign
          // until the user activates it (set_campaign_status or the page).
          const tg = (args.targeting ?? {}) as Record<string, unknown>;
          const ch = (args.channels ?? {}) as { email?: boolean; linkedin?: boolean };
          const created = (await caller.are.campaigns.create({
            name: args.name,
            description: args.description,
            autonomyMode: args.autonomyMode ?? "batch_approval",
            icpOverrides: {
              targetTitles: tg.targetTitles ?? [],
              targetIndustries: tg.targetIndustries ?? [],
              targetGeographies: tg.targetGeographies ?? [],
              keywords: tg.keywords ?? [],
              ...(tg.employeeMin ? { employeeMin: tg.employeeMin } : {}),
              ...(tg.employeeMax ? { employeeMax: tg.employeeMax } : {}),
            },
            targetProspectCount: args.targetProspectCount ?? 100,
            dailySendCap: args.dailySendCap ?? 25,
            channelsEnabled: { email: ch.email !== false, linkedin: !!ch.linkedin, sms: false, voice: false },
            goalType: args.goalType ?? "reply",
            sequencePrompt: args.sequencePrompt ?? null,
            launch: false,
          } as never)) as { id: number; launched: boolean };
          summary = `Created campaign "${args.name}" (#${created.id}) as a DRAFT — review it at /are/campaigns/${created.id}; it discovers and sends nothing until you activate it`;
          break;
        }
        case "create_list_from_filter": {
          const filter = args.filter as Record<string, unknown>;
          const limit = Number(args.limit ?? 500);
          const ids: number[] = [];
          // Page through the SAME query the preview used; the cap bounds the
          // blast radius the confirmation card promised.
          for (let page = 1; ids.length < limit && page <= 10; page++) {
            const res = (await caller.prospects.list({ page, perPage: 200, ...filter } as never)) as { total: number; data: Array<{ id: number }> };
            ids.push(...res.data.map((p) => p.id));
            if (page * 200 >= res.total) break;
          }
          const capped = ids.slice(0, limit);
          if (capped.length === 0) { summary = "No one matched the filter — no list created"; break; }
          const created = (await caller.recordLists.create({ name: args.newListName, entityType: "people" } as never)) as { id: number };
          const r = (await caller.recordLists.addMembers({
            listId: created.id, recordType: "prospect", recordIds: capped,
          } as never)) as { added?: number };
          summary = `Created list "${args.newListName}" (#${created.id}) with ${r.added ?? capped.length} people`;
          break;
        }
        case "set_company_brand": {
          // Hallucinated-id guard: get() 404s on ids outside this workspace,
          // where setBrandOverride would no-op and falsely report success.
          await caller.companies.get({ accountId: args.companyId } as never);
          await caller.companies.setBrandOverride({
            accountId: args.companyId,
            ...(args.name ? { name: args.name } : {}),
            ...(args.domain ? { domain: args.domain } : {}),
            reason: args.reason ?? "assistant-proposed pin",
          } as never);
          summary = `Pinned company #${args.companyId}${args.domain ? ` — domain ${args.domain}` : ""}${args.name ? ` — name "${args.name}"` : ""}`;
          break;
        }
        case "update_prospect": {
          await caller.prospects.update({ id: args.prospectId, ...(args.fields as object) } as never);
          const changed = Object.keys((args.fields ?? {}) as object).join(", ");
          summary = `Updated person #${args.prospectId} (${changed})`;
          break;
        }
        case "archive_prospects": {
          const ids = args.prospectIds as number[];
          let archived = 0;
          for (const id of ids) {
            await caller.prospects.archive({ id } as never);
            archived++;
          }
          summary = `Archived ${archived} ${archived === 1 ? "person" : "people"} (reversible from the People page)`;
          break;
        }
        case "run_action": {
          const entry = await getAction(String(args.path));
          if (!entry || entry.kind !== "mutation") throw new TRPCError({ code: "BAD_REQUEST", message: `Action ${args.path} is not allowed` });
          const parsed = entry.parse(args.input ?? {});
          const r = await invokeCallerPath(caller, entry.path, parsed);
          const out = JSON.stringify(r ?? null);
          summary = `Ran ${entry.path}${out && out !== "null" ? ` → ${out.length > 300 ? out.slice(0, 300) + "…" : out}` : ""}`;
          break;
        }
        case "add_to_campaign": {
          let added = 0, skipped = 0;
          for (const ids of chunk(args.prospectIds as number[], 100)) {
            const r = (await caller.are.prospects.pushExisting({ campaignId: args.campaignId, prospectIds: ids } as never)) as { added: unknown[]; skipped: unknown[] };
            added += r.added.length; skipped += r.skipped.length;
          }
          summary = `Added ${added} to campaign #${args.campaignId}${skipped ? `, ${skipped} skipped (already in the campaign or no identity)` : ""} — the engine enriches and writes to them next; the batch waits for approval`;
          break;
        }
        case "add_to_campaign_by_filter": {
          const ids = await collectFilterIds(caller, args.filter as Record<string, unknown>, Number(args.limit ?? 200));
          if (ids.length === 0) { summary = "No one matched the filter — nothing added"; break; }
          let added = 0, skipped = 0;
          for (const part of chunk(ids, 100)) {
            const r = (await caller.are.prospects.pushExisting({ campaignId: args.campaignId, prospectIds: part } as never)) as { added: unknown[]; skipped: unknown[] };
            added += r.added.length; skipped += r.skipped.length;
          }
          summary = `Added ${added} of ${ids.length} matching people to campaign #${args.campaignId}${skipped ? ` (${skipped} skipped — already there)` : ""}; the batch waits for approval before anything sends`;
          break;
        }
        case "enroll_by_filter": {
          const ids = await collectFilterIds(caller, args.filter as Record<string, unknown>, Number(args.limit ?? 200));
          if (ids.length === 0) { summary = "No one matched the filter — nobody enrolled"; break; }
          let enrolled = 0, already = 0, blocked = 0;
          for (const part of chunk(ids, 100)) {
            const r = (await caller.sequences.bulkEnroll({ sequenceId: args.sequenceId, prospectIds: part } as never)) as { enrolled?: number; skippedAlreadyEnrolled?: number; blockedInvalidEmail?: number };
            enrolled += r.enrolled ?? 0; already += r.skippedAlreadyEnrolled ?? 0; blocked += r.blockedInvalidEmail ?? 0;
          }
          summary = `Enrolled ${enrolled} of ${ids.length} matching people in sequence #${args.sequenceId}${already ? `, ${already} already enrolled` : ""}${blocked ? `, ${blocked} blocked (invalid email)` : ""}`;
          break;
        }
        case "add_to_list_by_filter": {
          const ids = await collectFilterIds(caller, args.filter as Record<string, unknown>, Number(args.limit ?? 500));
          if (ids.length === 0) { summary = "No one matched the filter — nothing added"; break; }
          const r = (await caller.recordLists.addMembers({ listId: args.listId, recordType: "prospect", recordIds: ids } as never)) as { added?: number };
          summary = `Added ${r.added ?? ids.length} of ${ids.length} matching people to list #${args.listId}`;
          break;
        }
        case "create_sequence": {
          const steps = (args.steps as Array<Record<string, unknown>>).map((s) => {
            switch (s.type) {
              case "email": return { type: "email", subject: s.subject, body: s.body };
              case "wait": return { type: "wait", days: s.days };
              case "task": return { type: "task", body: s.body };
              case "linkedin_dm": return { type: "linkedin_dm", body: s.body };
              default: return { type: "linkedin_invite", note: s.note };
            }
          });
          const created = (await caller.sequences.create({ name: args.name, description: args.description, steps } as never)) as { id: number };
          summary = `Created sequence "${args.name}" (#${created.id}) as a DRAFT with ${steps.length} step(s) — review it at /v2/sequences, activate it, then enroll people`;
          break;
        }
        case "log_call": {
          await caller.activities.logCall({ relatedType: "prospect", relatedId: args.prospectId, disposition: args.disposition, durationSec: args.durationSec ?? 0, outcome: args.outcome, notes: args.notes } as never);
          summary = `Logged a ${String(args.disposition).replace(/_/g, " ")} call on person #${args.prospectId}`;
          break;
        }
        case "queue_calls": {
          const r = (await caller.tasks.bulkCreateForProspects({ prospectIds: args.prospectIds, title: args.title ?? "Call", type: "call", priority: args.priority ?? "normal", dueInDays: args.dueInDays ?? 0 } as never)) as { created?: number };
          summary = `Queued ${r.created ?? (args.prospectIds as number[]).length} call task(s) — they are on the Tasks page with each person's number`;
          break;
        }
        case "save_report": {
          const r = (await caller.reports.save({ name: args.name, spec: args.spec } as never)) as { id?: number };
          summary = `Saved report "${args.name}"${r?.id ? ` (#${r.id})` : ""} — it is on the Reports page and can be scheduled`;
          break;
        }
        default:
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unhandled action" });
      }
      } catch (e) {
        // The proposal stays consumed (a partial action must not be re-run
        // blind); the failure is on the row and in the reply.
        const msg = (e as Error)?.message ?? "unknown error";
        await db.update(aiAssistantProposals)
          .set({ outcome: "failed", resultSummary: msg.slice(0, 2000) } as never)
          .where(eq(aiAssistantProposals.id, proposal.id));
        throw e;
      }

      await db.update(aiAssistantProposals)
        .set({ resultSummary: summary.slice(0, 2000) } as never)
        .where(eq(aiAssistantProposals.id, proposal.id));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "assistant_action",
        entityId: proposal.id,
        after: { tool: name, args, summary, nonce: input.nonce },
      });

      return { ok: true as const, summary };
    }),

  /** "Not now" — consume the proposal so it can never be confirmed later. */
  declineAction: workspaceProcedure
    .input(z.object({ nonce: z.string().min(16).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(aiAssistantProposals)
        .set({ consumedAt: new Date(), outcome: "declined" } as never)
        .where(and(
          eq(aiAssistantProposals.nonce, input.nonce),
          eq(aiAssistantProposals.workspaceId, ctx.workspace.id),
          eq(aiAssistantProposals.userId, ctx.user.id),
          isNull(aiAssistantProposals.consumedAt),
        ));
      return { ok: true as const };
    }),
});
