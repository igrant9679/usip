/**
 * Inbound Chat Agents — Apollo "Chat" parity (public widget at /c/:slug).
 *
 * Management is Admin-only (adminWsProcedure). The public surface is
 * unauthenticated and deliberately narrow: three procedures, all keyed by the
 * agent slug or an opaque session token, never by a database id.
 *
 * The whole point of this module is that it books meetings WITHOUT sending
 * anything: a visitor arrives on a page, the agent qualifies them, creates a
 * routed lead, and — in `auto` mode — books a real slot on the rep's calendar
 * through the exact `bookSlotForLink` path that /b/:slug uses. No outbound
 * volume, no deliverability exposure, no enrichment credits.
 *
 * Autonomy (`mode`, the house Off/Approve/Auto convention):
 *   off      — the widget refuses to serve at all.
 *   approval — the agent chats and captures the lead, but a qualified visitor
 *              produces a task + notification for a human instead of a booking.
 *   auto     — the agent shows real availability and books it itself.
 */
import { z } from "zod";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { router, publicProcedure } from "../_core/trpc";
import { adminWsProcedure } from "../_core/workspace";
import { getDb } from "../db";
import {
  activities, bookingLinks, chatAgentKnowledge, chatAgents, chatSessions, enrollments, leads, notifications, tasks,
} from "../../drizzle/schema";
import { bookSlotForLink, openSlotsForLink } from "./bookingLinks";
import {
  decideOffer, mergeVisitor, runChatTurn,
  type ChatMessage, type VisitorFacts,
} from "../services/chatAgent";
import { formatKnowledge, selectKnowledge } from "../services/chatKnowledge";
import { describePageContext } from "../services/chatPageContext";

/** How many slots the widget offers. A short list converts; a wall of times doesn't. */
const SLOTS_SHOWN = 6;
/** Hard cap on turns per session — a public LLM endpoint needs a ceiling. */
const MAX_MESSAGES = 60;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function messagesOf(row: { messages: unknown }): ChatMessage[] {
  return Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [];
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The booking link whose calendar this agent offers, if the rep has one. */
async function linkForAgent(agent: typeof chatAgents.$inferSelect) {
  const db = await getDb();
  if (!db) return null;
  const userId = agent.bookingUserId ?? agent.createdByUserId;
  if (!userId) return null;
  const [link] = await db.select().from(bookingLinks)
    .where(and(eq(bookingLinks.workspaceId, agent.workspaceId), eq(bookingLinks.userId, userId)));
  return link && link.active ? link : null;
}

/** Fields an admin may set on create/update. */
const contentInput = z.object({
  name: z.string().min(1).max(160).optional(),
  status: z.enum(["draft", "published"]).optional(),
  mode: z.enum(["off", "approval", "auto"]).optional(),
  displayName: z.string().min(1).max(120).optional(),
  greeting: z.string().min(1).max(500).optional(),
  persona: z.string().max(4000).nullable().optional(),
  themeColor: z.string().max(16).optional(),
  showOnHostedPages: z.boolean().optional(),
  followUpMode: z.enum(["off", "approval", "auto"]).optional(),
  followUpDelayMin: z.number().int().min(5).max(1440).optional(),
  qualifyingQuestions: z.array(z.string().max(300)).max(8).nullable().optional(),
  qualifyThreshold: z.number().int().min(0).max(100).optional(),
  bookingUserId: z.number().int().positive().nullable().optional(),
  autoCreateLead: z.boolean().optional(),
  autoRoute: z.boolean().optional(),
  autoEnrollSequenceId: z.number().int().positive().nullable().optional(),
});

export const chatAgentsRouter = router({
  /* ─────────────────────────── Admin management ───────────────────────── */

  list: adminWsProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(chatAgents)
      .where(eq(chatAgents.workspaceId, ctx.workspace.id))
      .orderBy(desc(chatAgents.updatedAt));
  }),

  get: adminWsProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(chatAgents)
      .where(and(eq(chatAgents.id, input.id), eq(chatAgents.workspaceId, ctx.workspace.id)));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: adminWsProcedure.input(contentInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const name = input.name ?? "Website chat";
    const slug = `${slugify(name) || "chat"}-${Date.now().toString(36).slice(-4)}`.slice(0, 80);
    const r = await db.insert(chatAgents).values({
      workspaceId: ctx.workspace.id,
      slug,
      name,
      status: input.status ?? "draft",
      mode: input.mode ?? "off",
      displayName: input.displayName ?? "Assistant",
      greeting: input.greeting ?? "Hi! What brings you here today?",
      persona: input.persona ?? null,
      themeColor: input.themeColor ?? "#14B89A",
      showOnHostedPages: input.showOnHostedPages ?? false,
      qualifyingQuestions: input.qualifyingQuestions ?? [
        "What are you hoping to solve?",
        "Roughly how big is your team?",
        "What's your timeline?",
      ],
      qualifyThreshold: input.qualifyThreshold ?? 60,
      bookingUserId: input.bookingUserId ?? ctx.user.id,
      autoCreateLead: input.autoCreateLead ?? true,
      autoRoute: input.autoRoute ?? true,
      autoEnrollSequenceId: input.autoEnrollSequenceId ?? null,
      createdByUserId: ctx.user.id,
    } as never);
    return { id: Number((r as any)[0]?.insertId ?? 0) || 0, slug };
  }),

  update: adminWsProcedure.input(z.object({ id: z.number() }).and(contentInput)).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { id, ...rest } = input;
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) set[k] = v;
    if (Object.keys(set).length === 0) return { ok: true as const };
    await db.update(chatAgents).set(set as never)
      .where(and(eq(chatAgents.id, id), eq(chatAgents.workspaceId, ctx.workspace.id)));
    return { ok: true as const };
  }),

  remove: adminWsProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(chatAgents)
      .where(and(eq(chatAgents.id, input.id), eq(chatAgents.workspaceId, ctx.workspace.id)));
    // Orphaned transcripts would linger as untraceable rows; drop them with the agent.
    await db.delete(chatSessions)
      .where(and(eq(chatSessions.agentId, input.id), eq(chatSessions.workspaceId, ctx.workspace.id)));
    // Same for its knowledge (0136) — otherwise a later agent reusing the id
    // would silently inherit another agent's facts.
    await db.delete(chatAgentKnowledge)
      .where(and(eq(chatAgentKnowledge.agentId, input.id), eq(chatAgentKnowledge.workspaceId, ctx.workspace.id)));
    return { ok: true as const };
  }),

  /* ───────────────────── Knowledge (Migration 0136) ────────────────────── */

  knowledge: adminWsProcedure
    .input(z.object({ agentId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(chatAgentKnowledge)
        .where(and(
          eq(chatAgentKnowledge.agentId, input.agentId),
          eq(chatAgentKnowledge.workspaceId, ctx.workspace.id),
        ))
        .orderBy(chatAgentKnowledge.sortOrder, chatAgentKnowledge.id);
    }),

  /** Create or update one fact. Omit `id` to create. */
  knowledgeSave: adminWsProcedure
    .input(z.object({
      id: z.number().optional(),
      agentId: z.number(),
      title: z.string().min(1).max(240),
      body: z.string().min(1).max(8000),
      enabled: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(9999).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.id) {
        await db.update(chatAgentKnowledge)
          .set({
            title: input.title,
            body: input.body,
            enabled: input.enabled ?? true,
            sortOrder: input.sortOrder ?? 0,
          } as never)
          .where(and(
            eq(chatAgentKnowledge.id, input.id),
            eq(chatAgentKnowledge.workspaceId, ctx.workspace.id),
          ));
        return { id: input.id };
      }
      const r = await db.insert(chatAgentKnowledge).values({
        workspaceId: ctx.workspace.id,
        agentId: input.agentId,
        title: input.title,
        body: input.body,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
      } as never);
      return { id: Number((r as any)[0]?.insertId ?? 0) || 0 };
    }),

  knowledgeRemove: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(chatAgentKnowledge)
        .where(and(
          eq(chatAgentKnowledge.id, input.id),
          eq(chatAgentKnowledge.workspaceId, ctx.workspace.id),
        ));
      return { ok: true as const };
    }),

  /** Transcripts for one agent (most recent first). */
  sessions: adminWsProcedure
    .input(z.object({ agentId: z.number().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const where = input.agentId
        ? and(eq(chatSessions.workspaceId, ctx.workspace.id), eq(chatSessions.agentId, input.agentId))
        : eq(chatSessions.workspaceId, ctx.workspace.id);
      return db.select().from(chatSessions).where(where)
        .orderBy(desc(chatSessions.updatedAt)).limit(input.limit);
    }),

  /* ── Autonomy Control Center plug-in ──
     The Center speaks one mode per feature, but chat autonomy genuinely belongs
     per-agent (a pricing-page bot and a support bot are not the same risk). So
     read reports the most permissive published agent and write applies to all —
     honest about what the single control does. */
  getAutopilotSettings: adminWsProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, agentCount: 0, lastRunAt: null };
    const rows = await db.select({ mode: chatAgents.mode, updatedAt: chatAgents.updatedAt })
      .from(chatAgents).where(eq(chatAgents.workspaceId, ctx.workspace.id));
    const rank = { off: 0, approval: 1, auto: 2 } as const;
    let mode: "off" | "approval" | "auto" = "off";
    for (const r of rows) if (rank[r.mode as keyof typeof rank] > rank[mode]) mode = r.mode as typeof mode;
    return { mode, agentCount: rows.length, lastRunAt: null as Date | null };
  }),

  setAutopilotSettings: adminWsProcedure
    .input(z.object({ mode: z.enum(["off", "approval", "auto"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(chatAgents).set({ mode: input.mode } as never)
        .where(eq(chatAgents.workspaceId, ctx.workspace.id));
      return { ok: true as const };
    }),

  /* ──────────────────────────── Public surface ────────────────────────── */

  /** PUBLIC: the widget's boot payload for a PUBLISHED, non-off agent. */
  getPublic: publicProcedure.input(z.object({ slug: z.string().min(1).max(80) })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [a] = await db.select().from(chatAgents).where(eq(chatAgents.slug, input.slug));
    if (!a || a.status !== "published" || a.mode === "off") {
      throw new TRPCError({ code: "NOT_FOUND", message: "This chat is not available." });
    }
    return {
      displayName: a.displayName,
      greeting: a.greeting,
      themeColor: a.themeColor,
      name: a.name,
    };
  }),

  /**
   * PUBLIC: one visitor turn.
   *
   * Returns the agent's reply plus, when the visitor has earned it and the
   * agent is in `auto` mode, real bookable slots. `token` is minted on the
   * first turn and is the visitor's only handle on the session afterwards.
   */
  send: publicProcedure
    .input(z.object({
      slug: z.string().min(1).max(80),
      token: z.string().max(64).optional(),
      message: z.string().min(1).max(2000),
      /** Where the widget is embedded (0138). Untrusted, length-capped, stored once. */
      pageUrl: z.string().max(1000).optional(),
      pageTitle: z.string().max(300).optional(),
      referrer: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [agent] = await db.select().from(chatAgents).where(eq(chatAgents.slug, input.slug));
      if (!agent || agent.status !== "published" || agent.mode === "off") {
        throw new TRPCError({ code: "NOT_FOUND", message: "This chat is not available." });
      }

      // Resolve or mint the session. A token for a DIFFERENT agent is treated
      // as absent rather than honoured — tokens are not portable between widgets.
      let session = null as typeof chatSessions.$inferSelect | null;
      if (input.token) {
        const [s] = await db.select().from(chatSessions).where(eq(chatSessions.token, input.token));
        if (s && s.agentId === agent.id) session = s;
      }
      if (!session) {
        const token = randomUUID();
        await db.insert(chatSessions).values({
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          token,
          messages: [{ role: "agent", text: agent.greeting, at: new Date().toISOString() }],
          pageUrl: input.pageUrl ?? null,
          pageTitle: input.pageTitle ?? null,
          referrer: input.referrer ?? null,
        } as never);
        const [created] = await db.select().from(chatSessions).where(eq(chatSessions.token, token));
        if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not start the chat." });
        session = created;
        db.update(chatAgents).set({ sessionCount: sql`${chatAgents.sessionCount} + 1` } as never)
          .where(eq(chatAgents.id, agent.id)).catch(() => {});
      }

      const history = messagesOf(session);
      if (history.length >= MAX_MESSAGES) {
        return {
          token: session.token,
          reply: "Thanks for all of that — I've passed your details to the team and someone will be in touch shortly.",
          slots: [] as string[],
          durationMin: 0,
          booked: session.status === "booked",
        };
      }

      const messages: ChatMessage[] = [
        ...history,
        { role: "visitor", text: input.message.slice(0, 2000), at: new Date().toISOString() },
      ];

      const link = agent.mode === "auto" ? await linkForAgent(agent) : null;
      const known: Partial<VisitorFacts> = {
        name: session.visitorName, email: session.visitorEmail,
        company: session.visitorCompany, phone: session.visitorPhone,
      };

      // Facts the agent may answer from (0136), ranked against what the visitor
      // just asked. Best-effort: an agent with no knowledge behaves exactly as
      // it did before, it just has less to go on.
      let knowledge = "";
      try {
        const rows = await db.select({
          id: chatAgentKnowledge.id,
          title: chatAgentKnowledge.title,
          body: chatAgentKnowledge.body,
          enabled: chatAgentKnowledge.enabled,
          sortOrder: chatAgentKnowledge.sortOrder,
        }).from(chatAgentKnowledge).where(eq(chatAgentKnowledge.agentId, agent.id));
        knowledge = formatKnowledge(selectKnowledge(rows, input.message));
      } catch { /* knowledge is an improvement, never a prerequisite */ }

      const turn = await runChatTurn({
        workspaceId: agent.workspaceId,
        displayName: agent.displayName,
        persona: agent.persona,
        qualifyingQuestions: strArray(agent.qualifyingQuestions),
        messages,
        known,
        canBook: !!link,
        knowledge,
        pageContext: describePageContext({
          pageUrl: session.pageUrl ?? input.pageUrl ?? null,
          pageTitle: session.pageTitle ?? input.pageTitle ?? null,
          referrer: session.referrer ?? input.referrer ?? null,
        }),
      });

      const visitor = mergeVisitor(known, turn.extracted);
      messages.push({ role: "agent", text: turn.reply, at: new Date().toISOString() });

      const action = decideOffer({
        mode: agent.mode as "off" | "approval" | "auto",
        score: turn.score,
        threshold: agent.qualifyThreshold,
        hasEmail: !!visitor.email,
        wantsMeeting: turn.wantsMeeting,
        alreadyBooked: session.status === "booked",
      });

      // Capture the lead as soon as we have an email — independent of the
      // booking decision, so an `approval`-mode agent still fills the CRM.
      let leadId = session.leadId;
      if (!leadId && visitor.email && agent.autoCreateLead) {
        leadId = await createLeadForSession(agent, visitor, turn.intent);
        if (leadId) {
          db.update(chatAgents).set({ leadCount: sql`${chatAgents.leadCount} + 1` } as never)
            .where(eq(chatAgents.id, agent.id)).catch(() => {});
        }
      }

      let slots: string[] = [];
      let effective = action;
      let reply = turn.reply;
      if (action === "book") {
        if (link) {
          try {
            slots = (await openSlotsForLink(link)).slice(0, SLOTS_SHOWN);
          } catch (e) {
            console.error("[chatAgents] slot lookup failed:", (e as Error).message);
          }
        }
        // The rep has published no availability, or the horizon is full. Fall
        // back to a human rather than leaving a qualified visitor staring at a
        // promise of times that never appear.
        if (slots.length === 0) {
          effective = "handoff";
          reply = `${reply}\n\nI don't have open times in front of me right now — someone from the team will reach out shortly to find one.`;
        }
      }
      // Fire the handoff on the TRANSITION into qualified only. Without this
      // guard every later turn of the same conversation would mint another
      // task and another notification for the same visitor.
      if (effective === "handoff" && session.status !== "qualified") {
        await handoffToRep(agent, session.token, visitor, turn.summary, leadId);
      }

      const qualified = turn.score >= agent.qualifyThreshold;
      messages[messages.length - 1] = { role: "agent", text: reply, at: messages[messages.length - 1].at };
      await db.update(chatSessions).set({
        messages,
        messageCount: messages.length,
        visitorName: visitor.name,
        visitorEmail: visitor.email,
        visitorCompany: visitor.company,
        visitorPhone: visitor.phone,
        score: turn.score,
        qualified,
        intent: turn.intent,
        aiSummary: turn.summary,
        leadId,
        status: session.status === "booked" ? "booked" : qualified ? "qualified" : "active",
      } as never).where(eq(chatSessions.id, session.id));

      return {
        token: session.token,
        reply,
        slots,
        durationMin: link?.durationMin ?? 0,
        booked: session.status === "booked",
      };
    }),

  /** PUBLIC: the visitor picks one of the offered slots. */
  book: publicProcedure
    .input(z.object({
      token: z.string().min(1).max(64),
      startAt: z.string().datetime(),
      name: z.string().max(200).optional(),
      email: z.string().email().max(320).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [session] = await db.select().from(chatSessions).where(eq(chatSessions.token, input.token));
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "This chat has expired." });
      if (session.meetingId) throw new TRPCError({ code: "CONFLICT", message: "You've already booked a time." });

      const [agent] = await db.select().from(chatAgents).where(eq(chatAgents.id, session.agentId));
      if (!agent || agent.status !== "published" || agent.mode !== "auto") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Booking is not available on this chat." });
      }
      const link = await linkForAgent(agent);
      if (!link) throw new TRPCError({ code: "NOT_FOUND", message: "No availability is published for this team." });

      // Prefer what the visitor typed on the confirm step; fall back to what the
      // conversation already established.
      const email = input.email ?? session.visitorEmail;
      const name = input.name ?? session.visitorName ?? "Website visitor";
      if (!email) throw new TRPCError({ code: "BAD_REQUEST", message: "We need an email address to send the invite." });

      const start = new Date(input.startAt);
      if (Number.isNaN(start.getTime()) || start.getTime() < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Please pick a valid future time." });
      }

      const booked = await bookSlotForLink(link, {
        startAt: start,
        name,
        email,
        notes: session.aiSummary ? `From website chat: ${session.aiSummary}` : null,
        leadSource: `chat:${agent.slug}`,
        existingLeadId: session.leadId,
        meetingSource: "inbound",
        notificationSuffix: "Booked autonomously by the website chat agent.",
      });

      await db.update(chatSessions).set({
        status: "booked",
        meetingId: booked.meetingId,
        leadId: booked.leadId ?? session.leadId,
        visitorEmail: email,
        visitorName: name,
      } as never).where(eq(chatSessions.id, session.id));
      db.update(chatAgents).set({ meetingCount: sql`${chatAgents.meetingCount} + 1` } as never)
        .where(eq(chatAgents.id, agent.id)).catch(() => {});

      return { ok: true as const, scheduledAt: booked.scheduledAt, calendarBooked: booked.calendarBooked };
    }),
});

/* ────────────────────────────── side effects ─────────────────────────────── */

/** Create + route the inbound lead for a chat session. Best-effort. */
async function createLeadForSession(
  agent: typeof chatAgents.$inferSelect,
  visitor: VisitorFacts,
  intent: string | null,
): Promise<number | null> {
  const db = await getDb();
  if (!db || !visitor.email) return null;
  const parts = (visitor.name ?? "").trim().split(/\s+/).filter(Boolean);

  let ownerUserId: number | null = agent.bookingUserId ?? agent.createdByUserId ?? null;
  if (agent.autoRoute) {
    try {
      const { routeLeadOwner } = await import("./leadScoring");
      const routed = await routeLeadOwner(agent.workspaceId, {
        title: null, company: visitor.company, source: "chat", score: 0,
        industry: null, country: null, state: null, city: null,
      } as any);
      if (routed) ownerUserId = routed;
    } catch (e) {
      console.error("[chatAgents] routing failed:", (e as Error).message);
    }
  }

  let leadId: number | null = null;
  try {
    const r = await db.insert(leads).values({
      workspaceId: agent.workspaceId,
      firstName: parts[0] || "Website",
      lastName: parts.slice(1).join(" ") || "visitor",
      email: visitor.email,
      phone: visitor.phone,
      company: visitor.company,
      source: `chat:${agent.slug}`,
      status: "new",
      ownerUserId,
    } as never);
    leadId = Number((r as any)[0]?.insertId ?? 0) || null;
  } catch (e) {
    console.error("[chatAgents] lead insert failed:", (e as Error).message);
    return null;
  }

  if (leadId && intent) {
    try {
      await db.insert(activities).values({
        workspaceId: agent.workspaceId,
        type: "note",
        relatedType: "lead",
        relatedId: leadId,
        subject: `Website chat: ${intent}`.slice(0, 240),
        body: `Captured by the "${agent.name}" chat agent.`,
        actorUserId: null,
      } as never);
    } catch { /* timeline only */ }
  }

  if (leadId && agent.autoEnrollSequenceId) {
    try {
      await db.insert(enrollments).values({
        workspaceId: agent.workspaceId,
        sequenceId: agent.autoEnrollSequenceId,
        leadId,
        status: "active",
        currentStep: 0,
        nextActionAt: new Date(),
      } as never);
    } catch (e) {
      console.error("[chatAgents] enroll failed:", (e as Error).message);
    }
  }
  return leadId;
}

/**
 * `approval` mode: a qualified visitor becomes a rep's problem, not a booking.
 * A task (not just a notification) so it shows up in the same queue as every
 * other piece of work and can't be dismissed into nothing.
 */
async function handoffToRep(
  agent: typeof chatAgents.$inferSelect,
  token: string,
  visitor: VisitorFacts,
  summary: string | null,
  leadId: number | null,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const ownerUserId = agent.bookingUserId ?? agent.createdByUserId ?? null;
  const who = visitor.name || visitor.email || "A website visitor";

  try {
    await db.insert(tasks).values({
      workspaceId: agent.workspaceId,
      title: `Follow up: ${who} (website chat)`.slice(0, 240),
      description: `${summary ?? "Qualified on the website chat."}\n\nEmail: ${visitor.email ?? "—"}\nCompany: ${visitor.company ?? "—"}\nTranscript: /v2/chat?session=${token}`,
      type: "follow_up",
      priority: "high",
      status: "open",
      ownerUserId,
      relatedType: leadId ? "lead" : null,
      relatedId: leadId,
      source: "ai",
      aiReasoning: `The "${agent.name}" chat agent qualified this visitor. Agent is in Approve mode, so booking was left to a human.`,
    } as never);
  } catch (e) {
    console.error("[chatAgents] handoff task failed:", (e as Error).message);
  }

  if (ownerUserId) {
    try {
      await db.insert(notifications).values({
        workspaceId: agent.workspaceId,
        userId: ownerUserId,
        kind: "system",
        title: `Qualified website chat: ${who}`,
        body: `${summary ?? "A visitor qualified on the website chat."} Reach out — the agent did not book (Approve mode).`,
      } as never);
    } catch { /* best-effort */ }
  }
}
