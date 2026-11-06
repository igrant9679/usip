import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { z } from "zod";
import { getDb } from "../db";
import { audienceSegments, campaigns, contacts, segmentSequenceRules } from "../../drizzle/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { segmentProblem } from "@shared/segmentRules";
import { countSegment, segmentWhere } from "../services/segmentSql";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";

// ─── Rule schema ──────────────────────────────────────────────────────────────
const RuleSchema = z.object({
  id: z.string(),
  field: z.enum([
    "email", "firstName", "lastName", "title", "phone", "linkedinUrl",
    "seniority", "city", "emailVerificationStatus", "isPrimary", "createdAt",
  ]),
  operator: z.enum([
    "equals", "not_equals", "contains", "not_contains",
    "is_empty", "is_not_empty", "gt", "lt",
  ]),
  value: z.string(),
});

type Rule = z.infer<typeof RuleSchema>;

// ─── Counting ────────────────────────────────────────────────────────────────
// The rules compile to one WHERE clause and the database counts
// (services/segmentSql.ts, audit 2026-10-20, P52). Every count used to load
// every contact in the workspace and filter them here.

/** Refuses a segment that cannot mean what it says (P1, P19). */
function assertSavable(rules: Rule[]) {
  const problem = segmentProblem(rules);
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
}

// ─── Router ───────────────────────────────────────────────────────────────────
export const segmentsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(audienceSegments)
      .where(eq(audienceSegments.workspaceId, ctx.workspace.id))
      .orderBy(audienceSegments.name);
  }),

  create: workspaceProcedure
    .input(z.object({
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      matchType: z.enum(["all", "any"]).default("all"),
      rules: z.array(RuleSchema),
    }))
    .mutation(async ({ ctx, input }) => {
      assertSavable(input.rules);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const count = await countSegment(db, ctx.workspace.id, input.rules, input.matchType);

      const [result] = await db.insert(audienceSegments).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        description: input.description ?? null,
        matchType: input.matchType,
        rules: input.rules,
        contactCount: count,
        lastEvaluatedAt: new Date(),
        createdByUserId: ctx.user.id,
      });
      return { id: (result as any).insertId, count };
    }),

  update: workspaceProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      matchType: z.enum(["all", "any"]),
      rules: z.array(RuleSchema),
    }))
    .mutation(async ({ ctx, input }) => {
      assertSavable(input.rules);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const count = await countSegment(db, ctx.workspace.id, input.rules, input.matchType);

      await db
        .update(audienceSegments)
        .set({
          name: input.name,
          description: input.description ?? null,
          matchType: input.matchType,
          rules: input.rules,
          contactCount: count,
          lastEvaluatedAt: new Date(),
        })
        .where(and(
          eq(audienceSegments.id, input.id),
          eq(audienceSegments.workspaceId, ctx.workspace.id),
        ));
      return { count };
    }),

  /**
   * Deleting a segment left its auto-enrol rules and broadcasts pointing at
   * nothing (audit 2026-10-20, P54). A segment a rule uses is refused until
   * the rule is deleted, on Segment Auto-Enroll where rules live. Broadcasts
   * (the retired /campaigns) have no screen left to unlink one from, so their
   * link is cleared with the segment.
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [seg] = await db
        .select({ id: audienceSegments.id })
        .from(audienceSegments)
        .where(and(
          eq(audienceSegments.id, input.id),
          eq(audienceSegments.workspaceId, ctx.workspace.id),
        ));
      if (!seg) throw new TRPCError({ code: "NOT_FOUND", message: "That segment is not in this workspace." });
      const rules = await db
        .select({ id: segmentSequenceRules.id })
        .from(segmentSequenceRules)
        .where(and(
          eq(segmentSequenceRules.segmentId, input.id),
          eq(segmentSequenceRules.workspaceId, ctx.workspace.id),
        ));
      if (rules.length > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${rules.length} auto-enroll rule${rules.length === 1 ? " uses" : "s use"} this segment. Delete ${rules.length === 1 ? "it" : "them"} on Segment Auto-Enroll first.`,
        });
      }
      await db.transaction(async (tx) => {
        await tx
          .update(campaigns)
          .set({ audienceSegmentId: null })
          .where(and(
            eq(campaigns.audienceSegmentId, input.id),
            eq(campaigns.workspaceId, ctx.workspace.id),
          ));
        await tx
          .delete(audienceSegments)
          .where(and(
            eq(audienceSegments.id, input.id),
            eq(audienceSegments.workspaceId, ctx.workspace.id),
          ));
      });
      return { ok: true };
    }),

  evaluate: workspaceProcedure
    .input(z.object({
      rules: z.array(RuleSchema),
      matchType: z.enum(["all", "any"]).default("all"),
      segmentId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      return { count: await countSegment(db, ctx.workspace.id, input.rules, input.matchType) };
    }),

  refresh: workspaceProcedure
    .input(z.object({ id: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const segs = input.id
        ? await db.select().from(audienceSegments).where(and(
            eq(audienceSegments.id, input.id),
            eq(audienceSegments.workspaceId, ctx.workspace.id),
          ))
        : await db.select().from(audienceSegments).where(
            eq(audienceSegments.workspaceId, ctx.workspace.id),
          );

      for (const seg of segs) {
        const rules = (seg.rules as Rule[]) ?? [];
        const count = await countSegment(db, ctx.workspace.id, rules, (seg.matchType ?? "all") as "all" | "any");
        await db
          .update(audienceSegments)
          .set({ contactCount: count, lastEvaluatedAt: new Date() })
          .where(eq(audienceSegments.id, seg.id));
      }
      return { refreshed: segs.length };
    }),

  /** Manually add contacts to a segment by injecting a rule that matches their IDs */
  addContacts: workspaceProcedure
    .input(z.object({
      segmentId: z.number(),
      contactIds: z.array(z.number()).min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [seg] = await db.select().from(audienceSegments).where(and(
        eq(audienceSegments.id, input.segmentId),
        eq(audienceSegments.workspaceId, ctx.workspace.id),
      ));
      if (!seg) throw new Error("Segment not found");
      // Add a rule for each contactId not already covered
      const existingRules = (seg.rules as Rule[]) ?? [];
      const existingIds = existingRules
        .filter((r) => r.field === "email" && r.operator === "equals")
        .map((r) => r.value);
      // Fetch emails for the given contactIds
      const rows = await db.select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.contactIds)));
      // NOT a defence against a lead id: a lead id that happens to collide with
      // a contact id in this workspace resolves fine and this check passes. The
      // fix for that is that no surface passes lead ids any more (Leads.tsx,
      // 2026-09-20) and leadsSegmentPlumbing.test.ts pins the shape. What this
      // catches is a stale or foreign id, which used to be dropped silently
      // while the toast still said "Added N".
      if (rows.length !== input.contactIds.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "One or more ids are not contacts in this workspace — they may have been deleted, or they are leads/prospects. Segments are contact-keyed; put a lead into outreach with Add to… on the Leads page.",
        });
      }
      const newRules: Rule[] = rows
        .filter((r) => r.email && !existingIds.includes(r.email))
        .map((r) => ({ id: `manual-${r.id}`, field: "email" as const, operator: "equals" as const, value: r.email! }));
      // Membership is expressed as an email-EQUALS rule, so under matchType
      // "all" (the column default, drizzle/schema.ts) a second such rule can
      // never match anybody. Appending to a segment that already says something
      // collapsed it to one person or to nobody, and the update below stamped
      // that collapsed number over contactCount — a button that destroyed the
      // segment and reported success. Refuse instead (2026-09-20).
      const effectiveMatch = (seg.matchType ?? "all") as "all" | "any";
      if (newRules.length > 0 && effectiveMatch === "all" && existingRules.length + newRules.length > 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This segment matches on ALL rules, so adding members by email would make it match nobody. Switch the segment to 'any', or add a rule that describes them.",
        });
      }
      const updatedRules = [...existingRules, ...newRules];
      const count = await countSegment(db, ctx.workspace.id, updatedRules, effectiveMatch);
      await db.update(audienceSegments).set({ rules: updatedRules, contactCount: count, lastEvaluatedAt: new Date() })
        .where(and(eq(audienceSegments.id, input.segmentId), eq(audienceSegments.workspaceId, ctx.workspace.id)));
      return { added: newRules.length, total: count };
    }),

  /**
   * One page of the segment's contacts, newest first, and how many there are
   * now (P52). Nothing called this, so a segment's members could not be seen
   * (audit 2026-10-20, P20); the segment's own page reads it. The columns the
   * page shows only, and each contact's People record when it has one, since
   * segments read the contacts table and not People (P21).
   */
  getContacts: workspaceProcedure
    .input(z.object({
      id: z.number(),
      page: z.number().int().min(1).default(1),
      perPage: z.number().int().min(10).max(200).default(50),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [seg] = await db
        .select()
        .from(audienceSegments)
        .where(and(
          eq(audienceSegments.id, input.id),
          eq(audienceSegments.workspaceId, ctx.workspace.id),
        ));
      if (!seg) throw new TRPCError({ code: "NOT_FOUND", message: "That segment is not in this workspace." });
      const page = { page: input.page, perPage: input.perPage };
      const where = segmentWhere(ctx.workspace.id, (seg.rules as Rule[]) ?? [], (seg.matchType ?? "all") as "all" | "any", await getWorkspaceTimezone(ctx.workspace.id));
      if (!where) return { ...page, rows: [], total: 0 };
      const [rows, [{ total }]] = await Promise.all([
        db.select({
          id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
          title: contacts.title, companyName: contacts.companyName, emailVerificationStatus: contacts.emailVerificationStatus,
          personProspectId: contacts.personProspectId, createdAt: contacts.createdAt,
        }).from(contacts).where(where).orderBy(desc(contacts.id)).limit(input.perPage).offset((input.page - 1) * input.perPage),
        db.select({ total: sql<number>`count(*)` }).from(contacts).where(where),
      ]);
      return { ...page, rows, total: Number(total) };
    }),
});
