/**
 * Landing Pages — Admin-authored, publicly-hosted marketing pages with lead
 * capture (hosted at /l/:slug).
 *
 * Management (list/get/create/update/remove/setStatus) is **Admin-only** via
 * adminWsProcedure. The public surface (getBySlug/submit) is unauthenticated:
 * getBySlug serves a PUBLISHED page (and counts a view); submit autonomously
 * creates + routes + optionally enrolls a lead — the same inbound pipeline as
 * public forms. Best-effort on sub-steps so a submission is never lost.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { router, publicProcedure } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { landingPages, leads, enrollments } from "../../drizzle/schema";
import { resolveBookingUrl } from "../mergeVars";

type FormField = { key: string; label: string; required?: boolean };
const DEFAULT_FIELDS: FormField[] = [
  { key: "name", label: "Full name", required: true },
  { key: "email", label: "Work email", required: true },
  { key: "company", label: "Company" },
];

const sectionSchema = z.object({ heading: z.string().max(200), body: z.string().max(4000) });
const fieldSchema = z.object({ key: z.string().max(40), label: z.string().max(120), required: z.boolean().optional() });

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Fields an admin may set on create/update. */
const contentInput = z.object({
  name: z.string().min(1).max(160).optional(),
  status: z.enum(["draft", "published"]).optional(),
  headline: z.string().min(1).max(240).optional(),
  subheadline: z.string().max(500).nullable().optional(),
  heroImageUrl: z.string().max(2048).nullable().optional(),
  themeColor: z.string().max(16).optional(),
  sections: z.array(sectionSchema).max(20).nullable().optional(),
  seoDescription: z.string().max(300).nullable().optional(),
  formHeading: z.string().max(200).optional(),
  ctaButtonLabel: z.string().max(80).optional(),
  formFields: z.array(fieldSchema).max(12).nullable().optional(),
  autoCreateLead: z.boolean().optional(),
  autoRoute: z.boolean().optional(),
  autoEnrollSequenceId: z.number().int().positive().nullable().optional(),
  redirectUrl: z.string().max(2048).nullable().optional(),
  showBookingCta: z.boolean().optional(),
});

export const landingPagesRouter = router({
  /* ─────────────────────────── Admin management ───────────────────────── */

  list: adminWsProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(landingPages)
      .where(eq(landingPages.workspaceId, ctx.workspace.id))
      .orderBy(desc(landingPages.updatedAt));
  }),

  get: adminWsProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(landingPages)
      .where(and(eq(landingPages.id, input.id), eq(landingPages.workspaceId, ctx.workspace.id)));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: adminWsProcedure.input(contentInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const name = input.name ?? "Untitled landing page";
    const slug = `${slugify(name) || "page"}-${Date.now().toString(36).slice(-4)}`.slice(0, 80);
    const r = await db.insert(landingPages).values({
      workspaceId: ctx.workspace.id,
      slug,
      name,
      status: input.status ?? "draft",
      headline: input.headline ?? name,
      subheadline: input.subheadline ?? null,
      heroImageUrl: input.heroImageUrl ?? null,
      themeColor: input.themeColor ?? "#14B89A",
      sections: input.sections ?? [],
      seoDescription: input.seoDescription ?? null,
      formHeading: input.formHeading ?? "Get in touch",
      ctaButtonLabel: input.ctaButtonLabel ?? "Submit",
      formFields: input.formFields ?? DEFAULT_FIELDS,
      autoCreateLead: input.autoCreateLead ?? true,
      autoRoute: input.autoRoute ?? true,
      autoEnrollSequenceId: input.autoEnrollSequenceId ?? null,
      redirectUrl: input.redirectUrl ?? null,
      showBookingCta: input.showBookingCta ?? false,
      createdByUserId: ctx.user.id,
    } as never);
    const id = Number((r as any)[0]?.insertId ?? 0) || 0;
    return { id, slug };
  }),

  update: adminWsProcedure.input(z.object({ id: z.number() }).and(contentInput)).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { id, ...rest } = input;
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) set[k] = v;
    if (Object.keys(set).length === 0) return { ok: true as const };
    await db.update(landingPages).set(set as never)
      .where(and(eq(landingPages.id, id), eq(landingPages.workspaceId, ctx.workspace.id)));
    return { ok: true as const };
  }),

  setStatus: adminWsProcedure.input(z.object({ id: z.number(), status: z.enum(["draft", "published"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(landingPages).set({ status: input.status } as never)
        .where(and(eq(landingPages.id, input.id), eq(landingPages.workspaceId, ctx.workspace.id)));
      return { ok: true as const };
    }),

  remove: adminWsProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(landingPages)
      .where(and(eq(landingPages.id, input.id), eq(landingPages.workspaceId, ctx.workspace.id)));
    return { ok: true as const };
  }),

  /** Submissions list for a page (Admin). */
  submissions: adminWsProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    // Leads captured from this page's slug (source = "landing:<slug>").
    const [page] = await db.select({ slug: landingPages.slug }).from(landingPages)
      .where(and(eq(landingPages.id, input.id), eq(landingPages.workspaceId, ctx.workspace.id)));
    if (!page) return [];
    return db.select().from(leads)
      .where(and(eq(leads.workspaceId, ctx.workspace.id), eq(leads.source, `landing:${page.slug}`)))
      .orderBy(desc(leads.createdAt)).limit(200);
  }),

  /* ──────────────────────────── Public surface ────────────────────────── */

  /** PUBLIC: render payload for a PUBLISHED page (counts a view). */
  getBySlug: publicProcedure.input(z.object({ slug: z.string().min(1).max(80) })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [p] = await db.select().from(landingPages).where(eq(landingPages.slug, input.slug));
    if (!p || p.status !== "published") throw new TRPCError({ code: "NOT_FOUND", message: "Page not available" });
    // Best-effort view count — never block rendering.
    db.update(landingPages).set({ viewCount: sql`${landingPages.viewCount} + 1` } as never)
      .where(eq(landingPages.id, p.id)).catch(() => {});
    // Optional "Book a meeting" CTA → the page creator's self-serve booking page.
    let bookingUrl = "";
    if (p.showBookingCta) {
      try { bookingUrl = await resolveBookingUrl(p.workspaceId, p.createdByUserId); } catch { /* best-effort */ }
    }
    return {
      headline: p.headline,
      subheadline: p.subheadline,
      heroImageUrl: p.heroImageUrl,
      themeColor: p.themeColor,
      sections: (Array.isArray(p.sections) ? p.sections : []) as Array<{ heading: string; body: string }>,
      formHeading: p.formHeading,
      ctaButtonLabel: p.ctaButtonLabel,
      formFields: (Array.isArray(p.formFields) ? p.formFields : DEFAULT_FIELDS) as FormField[],
      bookingUrl: bookingUrl || null,
      name: p.name,
    };
  }),

  /** PUBLIC: handle a submission — autonomously create + route + enroll a lead. */
  submit: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(80), data: z.record(z.string(), z.any()) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [page] = await db.select().from(landingPages).where(eq(landingPages.slug, input.slug));
      if (!page || page.status !== "published") throw new TRPCError({ code: "NOT_FOUND", message: "Page not available" });

      const data = input.data ?? {};
      const email = str(data.email, 320);
      const rawName = str(data.name, 200);
      const firstName = str(data.firstName, 80) ?? (rawName ? rawName.split(" ")[0] : null);
      const lastName = str(data.lastName, 80) ?? (rawName ? rawName.split(" ").slice(1).join(" ") : null);
      const company = str(data.company, 200);
      const phone = str(data.phone, 40);

      if (page.autoCreateLead && (email || firstName)) {
        let ownerUserId: number | null = page.createdByUserId ?? null;
        if (page.autoRoute) {
          try {
            const { routeLeadOwner } = await import("./leadScoring");
            const routed = await routeLeadOwner(page.workspaceId, {
              title: null, company, source: "landing_page", score: 0, industry: null, country: null, state: null, city: null,
            } as any);
            if (routed) ownerUserId = routed;
          } catch (e) { console.error("[landingPages.submit] routing failed:", e); }
        }
        let leadId: number | null = null;
        try {
          const r = await db.insert(leads).values({
            workspaceId: page.workspaceId,
            firstName: firstName || "Unknown",
            lastName: lastName || "",
            email, phone, company,
            source: `landing:${page.slug}`,
            status: "new",
            ownerUserId,
          } as never);
          leadId = Number((r as any)[0]?.insertId ?? 0) || null;
        } catch (e) { console.error("[landingPages.submit] lead insert failed:", e); }

        if (leadId && page.autoEnrollSequenceId) {
          try {
            await db.insert(enrollments).values({
              workspaceId: page.workspaceId,
              sequenceId: page.autoEnrollSequenceId,
              leadId,
              status: "active",
              currentStep: 0,
              nextActionAt: new Date(),
            } as never);
          } catch (e) { console.error("[landingPages.submit] enroll failed:", e); }
        }
      }

      try {
        await db.update(landingPages).set({ submitCount: (page.submitCount ?? 0) + 1 } as never)
          .where(eq(landingPages.id, page.id));
      } catch { /* metric only */ }

      return { ok: true, redirectUrl: page.redirectUrl ?? null };
    }),
});
