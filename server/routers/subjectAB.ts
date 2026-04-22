/**
 * Sprint 4 — Subject-Line A/B + Spam Analyzer
 * Generates 3-5 subject-line variants for an email draft, scores each for
 * spam risk, and persists the results in subject_variants.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { emailDrafts, subjectVariants } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

/* ─── spam heuristics (deterministic, no LLM needed) ──────────────────── */

const SPAM_RULES: { pattern: RegExp; rule: string; severity: "high" | "medium" | "low"; score: number }[] = [
  { pattern: /\b(free|FREE)\b/, rule: "Contains 'free'", severity: "high", score: 15 },
  { pattern: /\b(urgent|URGENT|act now|ACT NOW)\b/i, rule: "Urgency language", severity: "high", score: 12 },
  { pattern: /\b(guaranteed|GUARANTEED)\b/i, rule: "Guaranteed claim", severity: "high", score: 12 },
  { pattern: /\b(click here|CLICK HERE)\b/i, rule: "Click-bait phrase", severity: "high", score: 10 },
  { pattern: /\$\d+/, rule: "Dollar amount in subject", severity: "medium", score: 8 },
  { pattern: /[!]{2,}/, rule: "Multiple exclamation marks", severity: "medium", score: 8 },
  { pattern: /[?]{2,}/, rule: "Multiple question marks", severity: "medium", score: 6 },
  { pattern: /\b(win|winner|won|prize)\b/i, rule: "Win/prize language", severity: "medium", score: 8 },
  { pattern: /\b(buy now|order now)\b/i, rule: "Direct purchase CTA", severity: "medium", score: 7 },
  { pattern: /[A-Z]{5,}/, rule: "Excessive capitalization", severity: "low", score: 5 },
  { pattern: /.{80,}/, rule: "Subject line too long (>80 chars)", severity: "low", score: 4 },
  { pattern: /\b(re:|fwd:)/i, rule: "Fake reply/forward prefix", severity: "medium", score: 9 },
  { pattern: /\b(limited time|limited offer)\b/i, rule: "Limited-time pressure", severity: "medium", score: 7 },
  { pattern: /\b(100%|100 percent)\b/i, rule: "100% claim", severity: "low", score: 4 },
  { pattern: /\b(no cost|no obligation|no risk)\b/i, rule: "No-cost/no-risk claim", severity: "medium", score: 6 },
];

function analyzeSpam(subject: string): { score: number; flags: { rule: string; severity: string; description: string }[] } {
  const flags: { rule: string; severity: string; description: string }[] = [];
  let score = 0;
  for (const r of SPAM_RULES) {
    if (r.pattern.test(subject)) {
      flags.push({ rule: r.rule, severity: r.severity, description: `Matched: "${subject.match(r.pattern)?.[0]}"` });
      score += r.score;
    }
  }
  return { score: Math.min(score, 100), flags };
}

/* ─── router ─────────────────────────────────────────────────────────────── */

export const subjectABRouter = router({
  /** List existing variants for a draft */
  list: workspaceProcedure
    .input(z.object({ emailDraftId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(subjectVariants)
        .where(and(eq(subjectVariants.emailDraftId, input.emailDraftId), eq(subjectVariants.workspaceId, ctx.workspace.id)));
    }),

  /** Generate 3-5 AI subject-line variants + spam analysis for a draft */
  generate: repProcedure
    .input(
      z.object({
        emailDraftId: z.number(),
        count: z.number().int().min(2).max(5).default(3),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [draft] = await db
        .select()
        .from(emailDrafts)
        .where(and(eq(emailDrafts.id, input.emailDraftId), eq(emailDrafts.workspaceId, ctx.workspace.id)));
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });

      // Generate variants via LLM
      let variants: { subject: string; rationale: string }[] = [];
      try {
        const out = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are a B2B email copywriter. Generate ${input.count} distinct subject-line variants for the email below. Vary style: curiosity, direct, question, social-proof, value-prop. Output JSON only.`,
            },
            {
              role: "user",
              content: `Current subject: ${draft.subject}\n\nEmail body:\n${draft.body?.slice(0, 600)}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "variants",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  variants: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        subject: { type: "string" },
                        rationale: { type: "string" },
                      },
                      required: ["subject", "rationale"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["variants"],
                additionalProperties: false,
              },
            },
          },
        });
        const content = out.choices?.[0]?.message?.content;
        const parsed = typeof content === "string" ? JSON.parse(content) : content;
        variants = parsed.variants ?? [];
      } catch {
        // Fallback: use current subject as only variant
        variants = [{ subject: draft.subject, rationale: "Original subject (LLM unavailable)" }];
      }

      // Delete old variants for this draft
      await db.delete(subjectVariants).where(and(eq(subjectVariants.emailDraftId, input.emailDraftId), eq(subjectVariants.workspaceId, ctx.workspace.id)));

      // Insert new variants with spam analysis
      const rows = variants.map((v, i) => {
        const spam = analyzeSpam(v.subject);
        return {
          workspaceId: ctx.workspace.id,
          emailDraftId: input.emailDraftId,
          subject: v.subject,
          spamScore: String(spam.score),
          spamFlags: spam.flags,
          aiRationale: v.rationale,
          isSelected: i === 0, // first is default selected
        };
      });

      if (rows.length > 0) {
        await db.insert(subjectVariants).values(rows);
      }

      return rows.map((r) => ({ ...r, spamScore: Number(r.spamScore) }));
    }),

  /** Select a variant (apply its subject to the draft) */
  select: repProcedure
    .input(z.object({ variantId: z.number(), emailDraftId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify variant belongs to workspace
      const [variant] = await db
        .select()
        .from(subjectVariants)
        .where(and(eq(subjectVariants.id, input.variantId), eq(subjectVariants.workspaceId, ctx.workspace.id)));
      if (!variant) throw new TRPCError({ code: "NOT_FOUND" });

      // Clear all isSelected for this draft
      await db
        .update(subjectVariants)
        .set({ isSelected: false })
        .where(and(eq(subjectVariants.emailDraftId, input.emailDraftId), eq(subjectVariants.workspaceId, ctx.workspace.id)));

      // Set this one as selected
      await db.update(subjectVariants).set({ isSelected: true }).where(eq(subjectVariants.id, input.variantId));

      // Apply subject to draft
      await db
        .update(emailDrafts)
        .set({ subject: variant.subject })
        .where(and(eq(emailDrafts.id, input.emailDraftId), eq(emailDrafts.workspaceId, ctx.workspace.id)));

      return { ok: true };
    }),

  /** Analyze spam score for an arbitrary subject string (no persistence) */
  analyze: workspaceProcedure
    .input(z.object({ subject: z.string().min(1).max(200) }))
    .query(({ input }) => {
      return analyzeSpam(input.subject);
    }),
});
