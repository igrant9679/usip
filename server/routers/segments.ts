import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { z } from "zod";
import { getDb } from "../db";
import { audienceSegments, contacts } from "../../drizzle/schema";
import { eq, and, sql } from "drizzle-orm";

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

// ─── Evaluate rules against contacts in JS (post-fetch) ──────────────────────
function applyRule(contact: Record<string, any>, rule: Rule): boolean {
  const raw = contact[rule.field];
  const val = raw === null || raw === undefined ? "" : String(raw);
  const ruleVal = rule.value.toLowerCase();
  const valLower = val.toLowerCase();

  switch (rule.operator) {
    case "equals": return valLower === ruleVal;
    case "not_equals": return valLower !== ruleVal;
    case "contains": return valLower.includes(ruleVal);
    case "not_contains": return !valLower.includes(ruleVal);
    case "is_empty": return val === "";
    case "is_not_empty": return val !== "";
    case "gt": return new Date(val) > new Date(rule.value);
    case "lt": return new Date(val) < new Date(rule.value);
    default: return true;
  }
}

function evaluateRules(contact: Record<string, any>, rules: Rule[], matchType: "all" | "any"): boolean {
  if (rules.length === 0) return true;
  if (matchType === "all") return rules.every((r) => applyRule(contact, r));
  return rules.some((r) => applyRule(contact, r));
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
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // Evaluate count immediately
      const allContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, ctx.workspace.id));
      const count = allContacts.filter((c) =>
        evaluateRules(c as Record<string, any>, input.rules, input.matchType)
      ).length;

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
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // Re-evaluate count
      const allContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, ctx.workspace.id));
      const count = allContacts.filter((c) =>
        evaluateRules(c as Record<string, any>, input.rules, input.matchType)
      ).length;

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

  delete: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .delete(audienceSegments)
        .where(and(
          eq(audienceSegments.id, input.id),
          eq(audienceSegments.workspaceId, ctx.workspace.id),
        ));
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
      const allContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, ctx.workspace.id));
      const matching = allContacts.filter((c) =>
        evaluateRules(c as Record<string, any>, input.rules, input.matchType)
      );
      return { count: matching.length };
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

      const allContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, ctx.workspace.id));

      for (const seg of segs) {
        const rules = (seg.rules as Rule[]) ?? [];
        const count = allContacts.filter((c) =>
          evaluateRules(c as Record<string, any>, rules, (seg.matchType ?? "all") as "all" | "any")
        ).length;
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
      const { inArray } = await import("drizzle-orm");
      const rows = await db.select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.contactIds)));
      const newRules: Rule[] = rows
        .filter((r) => r.email && !existingIds.includes(r.email))
        .map((r) => ({ id: `manual-${r.id}`, field: "email" as const, operator: "equals" as const, value: r.email! }));
      const updatedRules = [...existingRules, ...newRules];
      const allContacts = await db.select().from(contacts).where(eq(contacts.workspaceId, ctx.workspace.id));
      const count = allContacts.filter((c) => evaluateRules(c as Record<string, any>, updatedRules, (seg.matchType ?? "all") as "all" | "any")).length;
      await db.update(audienceSegments).set({ rules: updatedRules, contactCount: count, lastEvaluatedAt: new Date() })
        .where(eq(audienceSegments.id, input.segmentId));
      return { added: newRules.length, total: count };
    }),

  getContacts: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const [seg] = await db
        .select()
        .from(audienceSegments)
        .where(and(
          eq(audienceSegments.id, input.id),
          eq(audienceSegments.workspaceId, ctx.workspace.id),
        ));
      if (!seg) return [];
      const allContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, ctx.workspace.id));
      const rules = (seg.rules as Rule[]) ?? [];
      return allContacts.filter((c) =>
        evaluateRules(c as Record<string, any>, rules, (seg.matchType ?? "all") as "all" | "any")
      );
    }),
});
