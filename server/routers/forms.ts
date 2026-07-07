/**
 * forms router — lead-capture forms (/v2/forms) with autonomous submission
 * handling. A public submission (no auth) can:
 *   1. create a lead,
 *   2. auto-route it to a rep via the existing leadRouting rules (routeLeadOwner),
 *   3. auto-enroll the lead into a sequence,
 * feeding the top of the autonomous pipeline with zero manual steps.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { enrollments, forms, formSubmissions, leads } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { publicProcedure } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

const FIELD = z.object({ key: z.string(), label: z.string(), required: z.boolean().optional() });

function str(v: unknown, n: number): string | null {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, n) : null;
}

export const formsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(forms).where(eq(forms.workspaceId, ctx.workspace.id)).orderBy(desc(forms.createdAt));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db.select().from(forms).where(and(eq(forms.id, input.id), eq(forms.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  /** Public: fetch a form's renderable shape by its public id (active only). */
  getByPublicId: publicProcedure.input(z.object({ publicId: z.string() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db.select().from(forms).where(eq(forms.publicId, input.publicId));
    if (!row || row.status !== "active") return null;
    return { id: row.id, publicId: row.publicId, title: row.title, description: row.description, fields: row.fields, redirectUrl: row.redirectUrl };
  }),

  create: repProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      fields: z.array(FIELD).min(1),
      autoCreateLead: z.boolean().optional(),
      autoRoute: z.boolean().optional(),
      autoEnrollSequenceId: z.number().nullish(),
      redirectUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const publicId = nanoid(12);
      const r = await db.insert(forms).values({
        workspaceId: ctx.workspace.id,
        publicId,
        title: input.title,
        description: input.description ?? null,
        fields: input.fields,
        status: "active",
        autoCreateLead: input.autoCreateLead ?? true,
        autoRoute: input.autoRoute ?? true,
        autoEnrollSequenceId: input.autoEnrollSequenceId ?? null,
        redirectUrl: input.redirectUrl ?? null,
        createdByUserId: ctx.user.id,
      } as never);
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "form", entityId: id, after: { title: input.title } });
      return { id, publicId };
    }),

  update: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const patch: any = { ...input.patch };
    delete patch.id; delete patch.publicId; delete patch.workspaceId; // immutable
    await db.update(forms).set(patch).where(and(eq(forms.id, input.id), eq(forms.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  toggle: repProcedure.input(z.object({ id: z.number(), status: z.enum(["active", "inactive"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(forms).set({ status: input.status } as never).where(and(eq(forms.id, input.id), eq(forms.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(forms).where(and(eq(forms.id, input.id), eq(forms.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Recent webform leads + whether each is bridged to a prospect (Form-enrichment tab). */
  webformBridgeStatus: workspaceProcedure.query(async ({ ctx }) => {
    const { webformBridgeStatus } = await import("../services/leadBridge");
    return webformBridgeStatus(ctx.workspace.id);
  }),

  /** Manually bridge one webform lead to an account + prospect. */
  bridgeLead: workspaceProcedure
    .input(z.object({ leadId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const { bridgeLeadToRecords } = await import("../services/leadBridge");
      return bridgeLeadToRecords(ctx.workspace.id, input.leadId);
    }),

  submissions: workspaceProcedure.input(z.object({ formId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(formSubmissions)
      .where(and(eq(formSubmissions.workspaceId, ctx.workspace.id), eq(formSubmissions.formId, input.formId)))
      .orderBy(desc(formSubmissions.createdAt)).limit(200);
  }),

  /**
   * Public: handle a form submission. Autonomously creates + routes + enrolls a
   * lead per the form's settings. Best-effort — any sub-step failing still
   * records the submission.
   */
  submit: publicProcedure
    .input(z.object({ publicId: z.string(), data: z.record(z.string(), z.any()) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [form] = await db.select().from(forms).where(eq(forms.publicId, input.publicId));
      if (!form || form.status !== "active") throw new TRPCError({ code: "NOT_FOUND", message: "Form not available" });

      const data = input.data ?? {};
      const email = str(data.email, 320);
      const rawName = str(data.name, 200);
      const firstName = str(data.firstName, 80) ?? (rawName ? rawName.split(" ")[0] : null);
      const lastName = str(data.lastName, 80) ?? (rawName ? rawName.split(" ").slice(1).join(" ") : null);
      const company = str(data.company, 200);
      const title = str(data.title, 120);
      const phone = str(data.phone, 40);
      const name = [firstName, lastName].filter(Boolean).join(" ") || email || "Unknown";

      let leadId: number | null = null;
      let routedToUserId: number | null = null;

      if (form.autoCreateLead && (email || firstName)) {
        let ownerUserId: number | null = form.createdByUserId ?? null;
        if (form.autoRoute) {
          try {
            const { routeLeadOwner } = await import("./leadScoring");
            routedToUserId = await routeLeadOwner(form.workspaceId, { title, company, source: "webform", score: 0, industry: null, country: null, state: null, city: null } as any);
            if (routedToUserId) ownerUserId = routedToUserId;
          } catch (e) { console.error("[FormSubmit] routing failed:", e); }
        }
        try {
          const r = await db.insert(leads).values({
            workspaceId: form.workspaceId,
            firstName: firstName || "Unknown",
            lastName: lastName || "",
            email,
            phone,
            company,
            title,
            source: "webform",
            status: "new",
            ownerUserId,
          } as never);
          leadId = Number((r as any)[0]?.insertId ?? 0) || null;
        } catch (e) { console.error("[FormSubmit] lead insert failed:", e); }

        // Form-enrichment bridge: link the lead to an account + prospect so
        // enrichment/scoring can run on it. Best-effort, never blocks submit.
        if (leadId) {
          const lid = leadId;
          void import("../services/leadBridge")
            .then((m) => m.bridgeLeadToRecords(form.workspaceId, lid))
            .catch((e) => console.error("[FormSubmit] lead bridge failed:", (e as Error).message));
        }

        if (leadId && form.autoEnrollSequenceId) {
          try {
            await db.insert(enrollments).values({
              workspaceId: form.workspaceId,
              sequenceId: form.autoEnrollSequenceId,
              leadId,
              status: "active",
              currentStep: 0,
              nextActionAt: new Date(),
            } as never);
          } catch (e) { console.error("[FormSubmit] enroll failed:", e); }
        }
      }

      try {
        await db.insert(formSubmissions).values({
          workspaceId: form.workspaceId, formId: form.id, data, name, email, company, leadId, routedToUserId,
        } as never);
        await db.update(forms).set({ submitCount: (form.submitCount ?? 0) + 1 } as never).where(eq(forms.id, form.id));
      } catch (e) { console.error("[FormSubmit] submission insert failed:", e); }

      return { ok: true, redirectUrl: form.redirectUrl ?? null };
    }),
});
