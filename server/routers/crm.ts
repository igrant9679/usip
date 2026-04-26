import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, isNotNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import {
  accounts,
  activities,
  contacts,
  customers,
  dealLineItems,
  emailDrafts,
  leads,
  opportunities,
  opportunityContactRoles,
  products,
  enrollments,
  sequences,
  territories,
  users,
  workspaceMembers,
  workspaceSettings,
  proposals,
} from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

/* ──────────────────────────────────────────────────────────────────────── */

export const accountsRouter = router({
  list: workspaceProcedure
    .input(z.object({ search: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(accounts)
        .where(eq(accounts.workspaceId, ctx.workspace.id))
        .orderBy(desc(accounts.updatedAt));
      const q = input?.search?.toLowerCase().trim();
      return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.domain ?? "").toLowerCase().includes(q)) : rows;
    }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  /** Build a tree view of all accounts (parent → children + ARR rollup). */
  hierarchy: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { roots: [] as any[] };
    const all = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const byId = new Map(all.map((a) => [a.id, { ...a, children: [] as any[], rolledArr: Number(a.arr ?? 0) }]));
    const roots: any[] = [];
    for (const a of Array.from(byId.values())) {
      if (a.parentAccountId && byId.has(a.parentAccountId)) byId.get(a.parentAccountId)!.children.push(a);
      else roots.push(a);
    }
    const roll = (n: any): number => {
      let total = Number(n.arr ?? 0);
      for (const c of n.children) total += roll(c);
      n.rolledArr = total;
      return total;
    };
    roots.forEach(roll);
    return { roots };
  }),

  create: repProcedure
    .input(
      z.object({
        name: z.string().min(1),
        domain: z.string().optional(),
        industry: z.string().optional(),
        region: z.string().optional(),
        employeeBand: z.string().optional(),
        revenueBand: z.string().optional(),
        parentAccountId: z.number().optional(),
        territoryId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(accounts).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId: ctx.user.id });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "account", entityId: id, after: input });
      return { id };
    }),

  update: repProcedure
    .input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      await db.update(accounts).set(input.patch).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "account", entityId: input.id, before, after: input.patch });
      return { ok: true };
    }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
    await db.delete(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "account", entityId: input.id, before });
    return { ok: true };
  }),

  /** Detail view: account row + all associated contacts. */
  getWithContacts: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [account] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
      if (!account) return null;
      const accountContacts = await db.select().from(contacts).where(and(eq(contacts.accountId, input.id), eq(contacts.workspaceId, ctx.workspace.id))).orderBy(contacts.firstName);
      return { account, contacts: accountContacts };
    }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const contactsRouter = router({
  list: workspaceProcedure
    .input(z.object({ accountId: z.number().optional(), search: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(contacts).where(eq(contacts.workspaceId, ctx.workspace.id)).orderBy(desc(contacts.updatedAt));
      if (input?.accountId) rows = rows.filter((c) => c.accountId === input.accountId);
      const q = input?.search?.toLowerCase().trim();
      if (q) rows = rows.filter((c) => `${c.firstName} ${c.lastName} ${c.email ?? ""}`.toLowerCase().includes(q));
      return rows;
    }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        title: z.string().optional(),
        accountId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(contacts).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId: ctx.user.id });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "contact", entityId: id, after: input });
      return { id };
    }),

  update: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    await db.update(contacts).set(input.patch).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "contact", entityId: input.id, before, after: input.patch });
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    await db.delete(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "contact", entityId: input.id, before });
    return { ok: true };
  }),

  /** Detail view: contact row + joined account row. */
  getWithAccount: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
      if (!contact) return null;
      const account = contact.accountId
        ? (await db.select().from(accounts).where(and(eq(accounts.id, contact.accountId), eq(accounts.workspaceId, ctx.workspace.id))))[0] ?? null
        : null;
      return { contact, account };
    }),

  /** Bulk enroll contacts into a sequence */
  bulkAddToSequence: repProcedure
    .input(
      z.object({
        contactIds: z.array(z.number()).min(1),
        sequenceId: z.number(),
        startStep: z.number().default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify sequence belongs to workspace
      const [seq] = await db
        .select({ id: sequences.id, name: sequences.name })
        .from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!seq) throw new TRPCError({ code: "NOT_FOUND", message: "Sequence not found" });

      // Check enrollment guard setting
      const [settings] = await db
        .select({ blockInvalid: workspaceSettings.blockInvalidEmailsFromSequences })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      const blockInvalid = settings?.blockInvalid ?? false;

      // Fetch contacts
      const rows = await db
        .select({ id: contacts.id, email: contacts.email, emailVerificationStatus: contacts.emailVerificationStatus })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.contactIds)));

      const results: { contactId: number; status: "enrolled" | "skipped"; reason?: string }[] = [];

      for (const contact of rows) {
        // Guard: block invalid emails
        if (blockInvalid && contact.emailVerificationStatus === "invalid") {
          results.push({ contactId: contact.id, status: "skipped", reason: "Invalid email address" });
          continue;
        }
        // Check if already enrolled
        const [existing] = await db
          .select({ id: enrollments.id })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.sequenceId, input.sequenceId),
              eq(enrollments.contactId, contact.id),
              eq(enrollments.status, "active"),
            ),
          )
          .limit(1);
        if (existing) {
          results.push({ contactId: contact.id, status: "skipped", reason: "Already enrolled" });
          continue;
        }
        await db.insert(enrollments).values({
          workspaceId: ctx.workspace.id,
          sequenceId: input.sequenceId,
          contactId: contact.id,
          currentStep: input.startStep,
          status: "active",
        });
        results.push({ contactId: contact.id, status: "enrolled" });
      }

      const enrolled = results.filter((r) => r.status === "enrolled").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      return { enrolled, skipped, results, sequenceName: seq.name };
    }),

  /** Send an ad-hoc email to a list of contacts */
  sendAdHocEmail: repProcedure
    .input(
      z.object({
        contactIds: z.array(z.number()).min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
        aiGenerated: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Fetch contacts
      const rows = await db
        .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.contactIds)));

      const results: { contactId: number; status: "sent" | "skipped"; reason?: string }[] = [];

      for (const contact of rows) {
        if (!contact.email) {
          results.push({ contactId: contact.id, status: "skipped", reason: "No email address" });
          continue;
        }
        // Create an emailDraft record in 'sent' status
        await db.insert(emailDrafts).values({
          workspaceId: ctx.workspace.id,
          toContactId: contact.id,
          subject: input.subject,
          body: input.body,
          status: "sent",
          aiGenerated: input.aiGenerated,
          createdByUserId: ctx.user.id,
          sentAt: new Date(),
        });
        // Log a Timeline activity so the email appears in the contact's timeline
        await db.insert(activities).values({
          workspaceId: ctx.workspace.id,
          type: "email",
          relatedType: "contact",
          relatedId: contact.id,
          subject: input.subject,
          body: input.body,
          actorUserId: ctx.user.id,
          occurredAt: new Date(),
        });
        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "create",
          entityType: "email_draft",
          entityId: 0,
          after: { contactId: contact.id, subject: input.subject, aiGenerated: input.aiGenerated },
        });
        results.push({ contactId: contact.id, status: "sent" });
      }

      const sent = results.filter((r) => r.status === "sent").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      return { sent, skipped, results };
    }),

  /** AI-powered contact enrichment: suggest missing firmographic fields using LLM. */
  enrich: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" });

      // Get account name if linked
      let accountName = "";
      if (contact.accountId) {
        const [acct] = await db.select({ name: accounts.name }).from(accounts).where(and(eq(accounts.id, contact.accountId), eq(accounts.workspaceId, ctx.workspace.id)));
        accountName = acct?.name ?? "";
      }

      const prompt = `You are a B2B sales data enrichment assistant. Based on the following contact information, suggest likely values for any missing fields. Return ONLY a JSON object with the fields listed in the schema — do not include fields that are already filled in or that you cannot reasonably infer.

Contact:
- Name: ${contact.firstName} ${contact.lastName}
- Email: ${contact.email ?? "unknown"}
- Current title: ${contact.title ?? "unknown"}
- Phone: ${contact.phone ?? "unknown"}
- Company: ${accountName || "unknown"}
- LinkedIn: ${contact.linkedinUrl ?? "unknown"}
- City: ${contact.city ?? "unknown"}
- Seniority: ${contact.seniority ?? "unknown"}

Return a JSON object with ONLY the fields you can reasonably suggest from this information. Possible fields: title, phone, linkedinUrl, city, seniority. For seniority use one of: c_suite, vp, director, manager, individual_contributor. Do not hallucinate — only suggest values you are reasonably confident about based on the name, email domain, and company.`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a B2B data enrichment assistant. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "enrichment",
            strict: true,
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                phone: { type: "string" },
                linkedinUrl: { type: "string" },
                city: { type: "string" },
                seniority: { type: "string" },
              },
              required: [],
              additionalProperties: false,
            },
          },
        },
      });

      const raw = response?.choices?.[0]?.message?.content ?? "{}";
      let suggestions: Record<string, string> = {};
      try { suggestions = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)); } catch { suggestions = {}; }

      // Only apply non-empty suggestions to fields that are currently empty
      const patch: Record<string, any> = {};
      for (const [field, value] of Object.entries(suggestions)) {
        if (!value || typeof value !== "string") continue;
        const current = (contact as any)[field];
        if (current === null || current === undefined || current === "") {
          patch[field] = value;
        }
      }

      if (Object.keys(patch).length > 0) {
        await db.update(contacts).set(patch).where(eq(contacts.id, input.id));
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "contact", entityId: input.id, before: contact, after: patch });
      }

      return { suggestions, applied: patch, fieldsUpdated: Object.keys(patch) };
    }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const leadsRouter = router({
  list: workspaceProcedure
    .input(z.object({ status: z.string().optional(), search: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(leads).where(eq(leads.workspaceId, ctx.workspace.id)).orderBy(desc(leads.score));
      if (input?.status) rows = rows.filter((l) => l.status === input.status);
      const q = input?.search?.toLowerCase().trim();
      if (q) rows = rows.filter((l) => `${l.firstName} ${l.lastName} ${l.company ?? ""} ${l.email ?? ""}`.toLowerCase().includes(q));
      return rows;
    }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        title: z.string().optional(),
        source: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Apply lead-routing rules first; fall back to creator as owner.
      const { routeLeadOwner } = await import("./leadScoring");
      const routedOwner = await routeLeadOwner(ctx.workspace.id, {
        title: input.title ?? null,
        company: input.company ?? null,
        source: input.source ?? null,
        score: 0,
        industry: null,
        country: null,
        state: null,
        city: null,
      });
      const ownerUserId = routedOwner ?? ctx.user.id;
      const r = await db.insert(leads).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId, status: "new" });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "lead", entityId: id, after: { ...input, ownerUserId, routed: routedOwner != null } });
      return { id, ownerUserId, routed: routedOwner != null };
    }),

  update: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    await db.update(leads).set(input.patch).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead", entityId: input.id, before, after: input.patch });
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    await db.delete(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "lead", entityId: input.id, before });
    return { ok: true };
  }),

  /** Convert a lead → account + contact (+ optional opportunity). */
  convert: repProcedure
    .input(z.object({ id: z.number(), createOpportunity: z.boolean().default(true), opportunityValue: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
      if (!lead) throw new TRPCError({ code: "NOT_FOUND" });

      const accR = await db.insert(accounts).values({
        workspaceId: ctx.workspace.id, name: lead.company ?? `${lead.firstName} ${lead.lastName}`, ownerUserId: ctx.user.id,
      });
      const accountId = Number((accR as any)[0]?.insertId ?? 0);

      const conR = await db.insert(contacts).values({
        workspaceId: ctx.workspace.id, accountId, firstName: lead.firstName, lastName: lead.lastName, email: lead.email, phone: lead.phone, title: lead.title, isPrimary: true, ownerUserId: ctx.user.id,
      });
      const contactId = Number((conR as any)[0]?.insertId ?? 0);

      let opportunityId: number | null = null;
      if (input.createOpportunity) {
        const oR = await db.insert(opportunities).values({
          workspaceId: ctx.workspace.id, accountId,
          name: `${lead.company ?? lead.lastName} – New opportunity`,
          stage: "discovery", value: String(input.opportunityValue ?? 25000), winProb: 25, ownerUserId: ctx.user.id,
        });
        opportunityId = Number((oR as any)[0]?.insertId ?? 0);
      }

      await db.update(leads).set({
        status: "converted",
        convertedAccountId: accountId,
        convertedContactId: contactId,
        convertedOpportunityId: opportunityId,
      }).where(eq(leads.id, lead.id));

      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead", entityId: lead.id, after: { converted: true, accountId, contactId, opportunityId } });
      return { accountId, contactId, opportunityId };
    }),

  /** AI lead scoring re-run for one lead. Server-side LLM. */
  rescore: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });

    const { invokeLLM } = await import("../_core/llm");
    let score = 50;
    let grade = "C";
    let reasons: string[] = ["Default heuristic score"];
    try {
      const out = await invokeLLM({
        messages: [
          { role: "system", content: "You score B2B sales leads. Output JSON only." },
          {
            role: "user",
            content: `Score this lead 0-100. Title weighting: C-level/VP=high, manager=medium, individual=low. Engagement is unknown. Return JSON {score:int, grade:"A"|"B"|"C"|"D", reasons:[string]}.\n\nName: ${lead.firstName} ${lead.lastName}\nTitle: ${lead.title}\nCompany: ${lead.company}\nSource: ${lead.source}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lead_score",
            strict: true,
            schema: {
              type: "object",
              properties: {
                score: { type: "integer" },
                grade: { type: "string", enum: ["A", "B", "C", "D"] },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["score", "grade", "reasons"],
              additionalProperties: false,
            },
          },
        },
      });
      const content = out.choices?.[0]?.message?.content;
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      score = Math.max(0, Math.min(100, Number(parsed.score)));
      grade = String(parsed.grade);
      reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : reasons;
    } catch (e) {
      console.warn("[lead.rescore] LLM failed; using heuristic", e);
      const titleLow = (lead.title ?? "").toLowerCase();
      let s = 40;
      if (/chief|cxo|cmo|cro|cfo|ceo/.test(titleLow)) s += 35;
      else if (/vp|vice president|head/.test(titleLow)) s += 25;
      else if (/director/.test(titleLow)) s += 15;
      else if (/manager/.test(titleLow)) s += 8;
      score = Math.min(100, s + Math.floor(Math.random() * 15));
      grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
      reasons = [`Title-based ${score}`, "Engagement unknown — assumed neutral"];
    }
    await db.update(leads).set({ score, grade, scoreReasons: reasons }).where(eq(leads.id, lead.id));
    return { score, grade, reasons };
  }),

  /** Send an ad-hoc email to a lead and log it in the timeline */
  sendAdHocEmail: repProcedure
    .input(
      z.object({
        leadId: z.number(),
        subject: z.string().min(1),
        body: z.string().min(1),
        aiGenerated: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
      if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
      if (!lead.email) throw new TRPCError({ code: "BAD_REQUEST", message: "Lead has no email address" });
      // Create emailDraft record
      await db.insert(emailDrafts).values({
        workspaceId: ctx.workspace.id,
        subject: input.subject,
        body: input.body,
        status: "sent",
        aiGenerated: input.aiGenerated,
        createdByUserId: ctx.user.id,
        sentAt: new Date(),
      });
      // Log a Timeline activity on the lead record
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "email",
        relatedType: "lead",
        relatedId: input.leadId,
        subject: input.subject,
        body: input.body,
        actorUserId: ctx.user.id,
        occurredAt: new Date(),
      });
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "email_draft",
        entityId: 0,
        after: { leadId: input.leadId, subject: input.subject, aiGenerated: input.aiGenerated },
      });
      return { ok: true };
    }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const opportunitiesRouter = router({
  list: workspaceProcedure
    .input(z.object({ stage: z.string().optional(), ownerOnly: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(opportunities).where(eq(opportunities.workspaceId, ctx.workspace.id)).orderBy(desc(opportunities.updatedAt));
      if (input?.stage) rows = rows.filter((o) => o.stage === input.stage);
      if (input?.ownerOnly) rows = rows.filter((o) => o.ownerUserId === ctx.user.id);
      return rows;
    }),

  /** Kanban board grouped by stage. */
  board: workspaceProcedure.input(z.object({ ownerUserId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const where = input?.ownerUserId
      ? and(eq(opportunities.workspaceId, ctx.workspace.id), eq(opportunities.ownerUserId, input.ownerUserId))
      : eq(opportunities.workspaceId, ctx.workspace.id);
    const rows = await db.select().from(opportunities).where(where);
    const acctRows = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const accMap = new Map(acctRows.map((a) => [a.id, a.name]));
    return rows.map((r) => ({ ...r, accountName: accMap.get(r.accountId) ?? "?" }));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure
    .input(
      z.object({
        name: z.string().min(1),
        accountId: z.number(),
        value: z.number().min(0).default(0),
        stage: z.enum(["discovery", "qualified", "proposal", "negotiation", "won", "lost"]).default("discovery"),
        winProb: z.number().min(0).max(100).default(20),
        closeDate: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(opportunities).values({
        workspaceId: ctx.workspace.id, accountId: input.accountId, name: input.name,
        value: String(input.value), stage: input.stage, winProb: input.winProb,
        closeDate: input.closeDate ? new Date(input.closeDate) : null, ownerUserId: ctx.user.id,
      });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "opportunity", entityId: id, after: input });
      return { id };
    }),

  /** Move card on Kanban. */
  setStage: repProcedure.input(z.object({ id: z.number(), stage: z.enum(["discovery", "qualified", "proposal", "negotiation", "won", "lost"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    const winProb = input.stage === "won" ? 100 : input.stage === "lost" ? 0 : before.winProb;
    await db.update(opportunities).set({ stage: input.stage, winProb, daysInStage: 0 }).where(eq(opportunities.id, input.id));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "opportunity", entityId: input.id, before: { stage: before.stage }, after: { stage: input.stage } });
    return { ok: true };
  }),

  update: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    const patch: any = { ...input.patch };
    if (patch.value !== undefined) patch.value = String(patch.value);
    if (patch.closeDate && typeof patch.closeDate === "string") patch.closeDate = new Date(patch.closeDate);
    await db.update(opportunities).set(patch).where(eq(opportunities.id, input.id));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "opportunity", entityId: input.id, before, after: input.patch });
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    await db.delete(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "opportunity", entityId: input.id, before });
    return { ok: true };
  }),

  /* ── Contact Roles ── */
  listRoles: workspaceProcedure.input(z.object({ opportunityId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const roles = await db.select().from(opportunityContactRoles).where(and(eq(opportunityContactRoles.opportunityId, input.opportunityId), eq(opportunityContactRoles.workspaceId, ctx.workspace.id)));
    if (roles.length === 0) return [];
    const cs = await db.select().from(contacts).where(eq(contacts.workspaceId, ctx.workspace.id));
    const cMap = new Map(cs.map((c) => [c.id, c]));
    return roles.map((r) => ({ ...r, contact: cMap.get(r.contactId) ?? null }));
  }),

  addRole: repProcedure
    .input(z.object({ opportunityId: z.number(), contactId: z.number(), role: z.enum(["champion", "decision_maker", "influencer", "evaluator", "blocker", "user", "other"]), isPrimary: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      try {
        await db.insert(opportunityContactRoles).values({ ...input, workspaceId: ctx.workspace.id });
      } catch (e) {
        throw new TRPCError({ code: "CONFLICT", message: "That contact already has that role on this opportunity." });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "opportunity_contact_role", after: input });
      return { ok: true };
    }),

  removeRole: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(opportunityContactRoles).where(and(eq(opportunityContactRoles.id, input.id), eq(opportunityContactRoles.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /* ── Line items ── */
  listLineItems: workspaceProcedure.input(z.object({ opportunityId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const items = await db.select().from(dealLineItems).where(and(eq(dealLineItems.opportunityId, input.opportunityId), eq(dealLineItems.workspaceId, ctx.workspace.id)));
    const ps = await db.select().from(products).where(eq(products.workspaceId, ctx.workspace.id));
    const pMap = new Map(ps.map((p) => [p.id, p]));
    return items.map((i) => ({ ...i, product: pMap.get(i.productId) ?? null }));
  }),

  addLineItem: repProcedure
    .input(z.object({ opportunityId: z.number(), productId: z.number(), quantity: z.number().int().min(1).default(1), unitPrice: z.number().min(0), discountPct: z.number().min(0).max(100).default(0) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const lineTotal = input.quantity * input.unitPrice * (1 - input.discountPct / 100);
      await db.insert(dealLineItems).values({
        workspaceId: ctx.workspace.id,
        opportunityId: input.opportunityId,
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: String(input.unitPrice),
        discountPct: String(input.discountPct),
        lineTotal: String(lineTotal),
      });
      // Update opp value to sum of line items
      const items = await db.select().from(dealLineItems).where(and(eq(dealLineItems.opportunityId, input.opportunityId), eq(dealLineItems.workspaceId, ctx.workspace.id)));
      const total = items.reduce((s, i) => s + Number(i.lineTotal), 0);
      await db.update(opportunities).set({ value: String(total) }).where(eq(opportunities.id, input.opportunityId));
      return { ok: true };
    }),

  removeLineItem: repProcedure.input(z.object({ id: z.number(), opportunityId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(dealLineItems).where(and(eq(dealLineItems.id, input.id), eq(dealLineItems.workspaceId, ctx.workspace.id)));
    const items = await db.select().from(dealLineItems).where(and(eq(dealLineItems.opportunityId, input.opportunityId), eq(dealLineItems.workspaceId, ctx.workspace.id)));
    const total = items.reduce((s, i) => s + Number(i.lineTotal), 0);
    await db.update(opportunities).set({ value: String(total) }).where(eq(opportunities.id, input.opportunityId));
    return { ok: true };
  }),

  /** Weighted pipeline forecast grouped by close month. */
  forecast: workspaceProcedure
    .input(z.object({ stages: z.array(z.string()).optional() }).optional())
    .query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const allRows = await db.select().from(opportunities).where(eq(opportunities.workspaceId, ctx.workspace.id));
    // Collect all available stages (excluding lost) for the filter dropdown
    const availableStages = [...new Set(allRows.filter((o) => o.stage !== "lost").map((o) => o.stage))].sort();
    const filterStages = input?.stages && input.stages.length > 0 ? input.stages : null;
    const rows = filterStages ? allRows.filter((o) => filterStages.includes(o.stage)) : allRows;
    const byMonth: Record<string, { month: string; total: number; weighted: number; count: number; stages: Record<string, number> }> = {};
    const byStage: Record<string, { stage: string; total: number; weighted: number; count: number }> = {};
    let grandTotal = 0;
    let grandWeighted = 0;
    for (const opp of rows) {
      if (opp.stage === "lost") continue;
      const val = Number(opp.value ?? 0);
      const prob = opp.winProb ?? 20;
      const weighted = val * (prob / 100);
      grandTotal += val;
      grandWeighted += weighted;
      if (!byStage[opp.stage]) byStage[opp.stage] = { stage: opp.stage, total: 0, weighted: 0, count: 0 };
      byStage[opp.stage].total += val;
      byStage[opp.stage].weighted += weighted;
      byStage[opp.stage].count++;
      const closeDate = opp.closeDate ? new Date(opp.closeDate) : null;
      const monthKey = closeDate
        ? `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`
        : "no-date";
      if (!byMonth[monthKey]) byMonth[monthKey] = { month: monthKey, total: 0, weighted: 0, count: 0, stages: {} };
      byMonth[monthKey].total += val;
      byMonth[monthKey].weighted += weighted;
      byMonth[monthKey].count++;
      byMonth[monthKey].stages[opp.stage] = (byMonth[monthKey].stages[opp.stage] ?? 0) + val;
    }
    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    const stages = Object.values(byStage);
    return { grandTotal, grandWeighted, months, stages, availableStages };
  }),

  /** Detail view: opportunity + account + contact roles + recent activities. */
  getWithRelated: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [opp] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) return null;
      const account = (await db.select().from(accounts).where(and(eq(accounts.id, opp.accountId), eq(accounts.workspaceId, ctx.workspace.id))))[0] ?? null;
      const roles = await db.select().from(opportunityContactRoles).where(and(eq(opportunityContactRoles.opportunityId, input.id), eq(opportunityContactRoles.workspaceId, ctx.workspace.id)));
      const contactIds = roles.map((r) => r.contactId);
      const oppContacts = contactIds.length > 0
        ? await db.select().from(contacts).where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, contactIds)))
        : [];
      const cMap = new Map(oppContacts.map((c) => [c.id, c]));
      const contactRoles = roles.map((r) => ({ ...r, contact: cMap.get(r.contactId) ?? null }));
      return { opportunity: opp, account, contactRoles };
    }),

  /**
   * Chronological timeline of all activities for an opportunity.
   * Includes calls, meetings, notes, and AI meeting summaries pushed to the opportunity.
   */
  getTimeline: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify opportunity belongs to workspace
      const [opp] = await db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });
      // Fetch all activities linked to this opportunity
      const rows = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, ctx.workspace.id),
            eq(activities.relatedType, "opportunity"),
            eq(activities.relatedId, input.id),
          )
        )
        .orderBy(desc(activities.createdAt))
        .limit(200);
      return rows.map((a) => ({
        id: a.id,
        type: a.type,
        subject: a.subject ?? null,
        body: a.body ?? null,
        disposition: a.disposition ?? null,
        occurredAt: a.occurredAt ?? a.createdAt,
        createdAt: a.createdAt,
        createdByUserId: a.createdByUserId ?? null,
        // Flag activities that are pushed AI meeting summaries
        isMeetingSummary: a.type === "note" && typeof a.subject === "string" && a.subject.startsWith("Meeting Summary:"),
      }));
    }),

  /**
   * Revenue chart data: closed-won value and weighted pipeline forecast
   * grouped by month, for the Mockup B Dashboard home screen.
   */
  revenueChart: workspaceProcedure
    .input(z.object({ months: z.number().int().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.workspaceId, ctx.workspace.id));

      // Build month buckets for the last N months
      const buckets: Record<string, { label: string; revenue: number; forecast: number }> = {};
      for (let i = input.months - 1; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleString("en-US", { month: "short" });
        buckets[key] = { label, revenue: 0, forecast: 0 };
      }

      for (const opp of rows) {
        const val = Number(opp.value ?? 0);
        const prob = opp.winProb ?? 20;
        const closeDate = opp.closeDate ? new Date(opp.closeDate) : null;
        if (!closeDate) continue;
        const key = `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`;
        if (!buckets[key]) continue;
        if (opp.stage === "won") {
          buckets[key].revenue += val;
        } else if (opp.stage !== "lost") {
          buckets[key].forecast += val * (prob / 100);
        }
      }

      return Object.values(buckets);
    }),

  /** Live stat-card deltas: current vs previous month for pipeline, closed-won, leads, customers. */
  dashboardStats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const wid = ctx.workspace.id;
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const lastMonthEnd = thisMonthStart - 1;
    const allOpps = await db.select().from(opportunities).where(eq(opportunities.workspaceId, wid));
    const allLeads = await db.select({ id: leads.id, createdAt: leads.createdAt }).from(leads).where(eq(leads.workspaceId, wid));
    const allCustomers = await db.select({ id: customers.id, createdAt: customers.createdAt }).from(customers).where(eq(customers.workspaceId, wid));
    const openOpps = allOpps.filter((o) => o.stage !== "won" && o.stage !== "lost");
    const wonOpps = allOpps.filter((o) => o.stage === "won");
    const pipelineNow = openOpps.reduce((s, o) => s + Number(o.value ?? 0), 0);
    const pipelinePrev = allOpps.filter((o) => o.stage !== "won" && o.stage !== "lost" && (o.updatedAt ?? 0) >= lastMonthStart && (o.updatedAt ?? 0) <= lastMonthEnd).reduce((s, o) => s + Number(o.value ?? 0), 0);
    const closedWonNow = wonOpps.filter((o) => (o.updatedAt ?? 0) >= thisMonthStart).length;
    const closedWonPrev = wonOpps.filter((o) => (o.updatedAt ?? 0) >= lastMonthStart && (o.updatedAt ?? 0) <= lastMonthEnd).length;
    const leadsNow = allLeads.filter((l) => (l.createdAt ?? 0) >= thisMonthStart).length;
    const leadsPrev = allLeads.filter((l) => (l.createdAt ?? 0) >= lastMonthStart && (l.createdAt ?? 0) <= lastMonthEnd).length;
    const custNow = allCustomers.length;
    const custPrev = allCustomers.filter((c) => (c.createdAt ?? 0) < thisMonthStart).length;
    const delta = (a: number, b: number) => b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100);
    // Proposal health counts
    const STALE_MS = 48 * 60 * 60 * 1000;
    const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;
    const nowTs = Date.now();
    const allProposals = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        sentAt: proposals.sentAt,
        emailOpenedAt: proposals.emailOpenedAt,
        expiresAt: proposals.expiresAt,
      })
      .from(proposals)
      .where(eq(proposals.workspaceId, wid));
    const staleProposals = allProposals.filter(
      (p) =>
        p.status === "sent" &&
        p.emailOpenedAt === null &&
        p.sentAt !== null &&
        nowTs - new Date(p.sentAt).getTime() > STALE_MS,
    ).length;
    const expiringProposals = allProposals.filter(
      (p) =>
        p.expiresAt !== null &&
        new Date(p.expiresAt).getTime() >= nowTs &&
        new Date(p.expiresAt).getTime() - nowTs <= EXPIRING_SOON_MS &&
        p.status !== "accepted" &&
        p.status !== "not_accepted",
    ).length;
    return {
      pipelineValue: pipelineNow,
      pipelineDelta: delta(pipelineNow, pipelinePrev),
      closedWonCount: closedWonNow,
      closedWonDelta: delta(closedWonNow, closedWonPrev),
      activeLeads: allLeads.length,
      leadsDelta: delta(leadsNow, leadsPrev),
      customerCount: custNow,
      customerDelta: delta(custNow, custPrev),
      openOppsCount: openOpps.length,
      totalWonValue: wonOpps.reduce((s, o) => s + Number(o.value ?? 0), 0),
      staleProposals,
      expiringProposals,
    };
  }),

  /** Stage funnel: count + value per open pipeline stage. */
  stageFunnel: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, ctx.workspace.id), sql`${opportunities.stage} NOT IN ('won','lost')`))
    const stageOrder = ["prospect", "qualified", "proposal", "negotiation", "closing"];
    const map: Record<string, { count: number; value: number }> = {};
    for (const o of rows) {
      const s = o.stage ?? "prospect";
      if (!map[s]) map[s] = { count: 0, value: 0 };
      map[s].count++;
      map[s].value += Number(o.value ?? 0);
    }
    return stageOrder.filter((s) => map[s]).map((s) => ({ stage: s.charAt(0).toUpperCase() + s.slice(1), count: map[s].count, value: map[s].value }));
  }),

  /** Top 5 reps by closed-won value (this month, fallback to all-time). */
  topReps: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const thisMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const rows = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, ctx.workspace.id), eq(opportunities.stage, "won")));
    const thisMonth = rows.filter((o) => (o.updatedAt ?? 0) >= thisMonthStart);
    const buildMap = (src: typeof rows) => {
      const m: Record<number, { value: number; count: number }> = {};
      for (const o of src) { const uid = o.ownerUserId ?? 0; if (!m[uid]) m[uid] = { value: 0, count: 0 }; m[uid].value += Number(o.value ?? 0); m[uid].count++; }
      return m;
    };
    const source = Object.keys(buildMap(thisMonth)).length > 0 ? buildMap(thisMonth) : buildMap(rows);
    const memberRows = await db.select({ userId: workspaceMembers.userId, name: users.name }).from(workspaceMembers).leftJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, ctx.workspace.id));
    const nameMap = Object.fromEntries(memberRows.map((m) => [m.userId, m.name ?? "Rep"]));
    return Object.entries(source).map(([uid, v]) => ({ userId: Number(uid), name: nameMap[Number(uid)] ?? "Rep", value: v.value, count: v.count })).sort((a, b) => b.value - a.value).slice(0, 5);
  }),

  /** Win/loss ratio for the last 90 days. */
  winLoss: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { won: 0, lost: 0, wonValue: 0, lostValue: 0 };
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const rows = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, ctx.workspace.id), sql`${opportunities.stage} IN ('won','lost')`));
    const recent = rows.filter((o) => (o.updatedAt ?? 0) >= cutoff);
    return { won: recent.filter((o) => o.stage === "won").length, lost: recent.filter((o) => o.stage === "lost").length, wonValue: recent.filter((o) => o.stage === "won").reduce((s, o) => s + Number(o.value ?? 0), 0), lostValue: recent.filter((o) => o.stage === "lost").reduce((s, o) => s + Number(o.value ?? 0), 0) };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const territoriesRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(territories).where(eq(territories.workspaceId, ctx.workspace.id));
  }),

  create: workspaceProcedure
    .input(z.object({ name: z.string().min(1), rules: z.record(z.string(), z.any()).optional(), ownerUserId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(territories).values({ ...input, workspaceId: ctx.workspace.id });
      return { ok: true };
    }),

  update: workspaceProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(territories).set(input.patch).where(and(eq(territories.id, input.id), eq(territories.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(territories).where(and(eq(territories.id, input.id), eq(territories.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const productsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(products).where(eq(products.workspaceId, ctx.workspace.id)).orderBy(products.name);
  }),

  create: workspaceProcedure
    .input(z.object({
      sku: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      category: z.string().optional(),
      listPrice: z.number().min(0),
      cost: z.number().min(0).default(0),
      billingCycle: z.enum(["one_time", "monthly", "annual"]).default("annual"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      try {
        await db.insert(products).values({ ...input, listPrice: String(input.listPrice), cost: String(input.cost), workspaceId: ctx.workspace.id, active: true });
      } catch (e) {
        throw new TRPCError({ code: "CONFLICT", message: "SKU already exists" });
      }
      return { ok: true };
    }),

  update: workspaceProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const patch: any = { ...input.patch };
    if (patch.listPrice !== undefined) patch.listPrice = String(patch.listPrice);
    if (patch.cost !== undefined) patch.cost = String(patch.cost);
    await db.update(products).set(patch).where(and(eq(products.id, input.id), eq(products.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(products).where(and(eq(products.id, input.id), eq(products.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});
