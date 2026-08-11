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
import { and, eq } from "drizzle-orm";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { aiHelpConversations, aiHelpMessages, helpArticles } from "../../drizzle/schema";
import { invokeLLM, type Message } from "../_core/llm";
import { recordAudit } from "../audit";
import {
  ASSISTANT_TOOLS,
  TOOL_ARGS,
  type AssistantToolName,
  describeAction,
  isKnownTool,
  isMutatingTool,
  parseToolArgs,
  validateNavigateHref,
} from "../services/assistantTools";

const MAX_ROUNDS = 5;

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
- Mutating tools (enroll_in_sequence, create_tasks, add_to_list, enrich_prospects, set_campaign_status) only PROPOSE: calling one shows the user a confirmation card. Call at most ONE per turn, only when the user asked for that action, and with ids you obtained from lookups this conversation.
- You cannot send email or LinkedIn messages, and must not promise to. Sends live behind the user's approval queues.
- Use navigate to hand the user a link when the answer is "go to this page".
- Tool results arrive as [tool_result …] messages. After reading one, either call another tool or give your final answer as plain text.
- Be concise and concrete. Short sentences, tight lists, real names and numbers from tool results.
- Current page: ${pageKey ?? "unknown"}.`;

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
      const navigations: Array<{ href: string; label: string }> = [];
      let pendingAction: { tool: string; args: Record<string, unknown>; description: string } | null = null;
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
            // First proposal wins the turn — the user decides from here.
            pendingAction = { tool: name, args, description: describeAction(name, args) };
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

      await db.insert(aiHelpMessages).values({ conversationId: input.conversationId, role: "assistant", body: answer });
      await db.update(aiHelpConversations).set({ lastMessageAt: new Date() } as never)
        .where(and(eq(aiHelpConversations.workspaceId, ctx.workspace.id), eq(aiHelpConversations.id, input.conversationId)));

      return { answer, toolEvents, navigations, pendingAction };
    }),

  /** Execute a previously proposed mutating action. The payload round-trips
   *  through the client, which is safe by construction: it executes under the
   *  caller's own session via createCaller, so the user can only make the
   *  assistant do what they could already do from the UI. */
  confirmAction: workspaceProcedure
    .input(z.object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!isKnownTool(input.tool) || !isMutatingTool(input.tool)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not a confirmable action" });
      }
      const name = input.tool as AssistantToolName;
      const args = (TOOL_ARGS[name] as z.ZodTypeAny).parse(input.args) as Record<string, unknown>;
      const caller = await getCaller(ctx);

      let summary = "";
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
        default:
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unhandled action" });
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "assistant_action",
        entityId: 0,
        after: { tool: name, args, summary },
      });

      return { ok: true as const, summary };
    }),
});
