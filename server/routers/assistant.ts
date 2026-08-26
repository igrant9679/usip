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

const MAX_ROUNDS = 5;
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
        .limit(80);
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
    default:
      return { result: { error: "unknown tool" }, summary: `Unknown tool ${name}` };
  }
}

const SYSTEM_PROMPT = (pageKey: string | undefined) => `You are Velocity's in-app assistant. You can look things up, guide the user step-by-step, and PROPOSE actions — the app runs a proposed action only after the user confirms it in the chat.

Rules:
- Use tools for facts. Never invent prospect ids, sequence names, or counts — search first. For "how do I…" questions call help_lookup and answer from what it returns.
- You can see ALL of the workspace's data: query_data runs read-only filter/group/aggregate queries over every core table (people, companies, campaigns, email log, replies, meetings, tasks, deals, sequences, brand observations, audit log…). Use it for counting, auditing, "which rows…", and any question the purpose-built tools don't cover. Call list_data_entities first when unsure of an entity or column name — never guess one.
- Numeric ids may ONLY come from tool results — either this turn's, or an [assistant_context …] block at the end of an earlier assistant message (that block holds prior turns' tool results). If no real id is in context, look the person or object up again before proposing an action. The server rejects actions naming ids that don't exist.
- Mutating tools (enroll_in_sequence, create_tasks, add_to_list, enrich_prospects, set_campaign_status, propose_meetings, create_list_from_filter, create_campaign, set_company_brand, update_prospect, archive_prospects) only PROPOSE: calling one shows the user a confirmation card. Call at most ONE per turn, only when the user asked for that action, and with ids you obtained from lookups this conversation.
- create_campaign makes a DRAFT only: it never launches. If the user wants it running, that is a second step (set_campaign_status to active) in a later turn, after they have seen the draft. Fill targeting from what the user said; if they gave no name or no targeting, ask rather than invent.
- For "make a list of everyone who…" requests, call preview_people_filter first and tell the user the real count, then propose create_list_from_filter with the same filter.
- You cannot send email or LinkedIn messages, and must not promise to. Sends live behind the user's approval queues.
- Use navigate to hand the user a link when the answer is "go to this page".
- Tool results arrive as [tool_result …] messages. After reading one, either call another tool or give your final answer as plain text.
- Be concise and concrete. Short sentences, tight lists, real names and numbers from tool results.
- The user opened the assistant from this page: ${pageKey ?? "unknown"}. Use it to interpret "this page" / "here" and to pick navigate targets.`;

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
        .limit(12);

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
      let pendingAction: { nonce: string; tool: string; args: Record<string, unknown>; description: string; expiresAt: string } | null = null;
      let answer = "";

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await invokeLLM({
          messages,
          tools: ASSISTANT_TOOLS,
          toolChoice: "auto",
          maxTokens: 900,
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
            // First proposal wins the turn — the user decides from here. The
            // proposal is a server-held row; the client only gets its nonce,
            // and confirm/decline consume that row (0168). The args that run
            // are the ones stored HERE, never the ones a client sends back.
            const description = describeAction(name, args);
            const nonce = randomBytes(24).toString("base64url");
            const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
            await db.insert(aiAssistantProposals).values({
              workspaceId: ctx.workspace.id, userId: ctx.user.id, conversationId: input.conversationId,
              nonce, tool: name, args, description, expiresAt,
            } as never);
            pendingAction = { nonce, tool: name, args, description, expiresAt: expiresAt.toISOString() };
            answer = text || `Ready when you are — confirm below to run it.`;
            break;
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
        if (pendingAction) break;
        if (round === MAX_ROUNDS - 1) {
          answer = text || "I gathered what I could — ask me to continue if you need more.";
        }
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

      return { answer, toolEvents, navigations, pendingAction };
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
