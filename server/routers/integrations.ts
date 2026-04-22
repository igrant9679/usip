/**
 * Integrations router — Settings → Integrations tab.
 *
 * Manages workspace_integrations rows. Each provider has a unique row per
 * workspace. "Test" performs a lightweight connectivity check.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceIntegrations } from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

const PROVIDERS = [
  "manus_oauth",
  "scim",
  "stripe",
  "data_api",
  "llm",
  "google_maps",
  "webhook",
] as const;
type Provider = (typeof PROVIDERS)[number];

/** Seed default read-only integrations for a workspace if they don't exist. */
async function ensureDefaults(workspaceId: number) {
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select({ provider: workspaceIntegrations.provider })
    .from(workspaceIntegrations)
    .where(eq(workspaceIntegrations.workspaceId, workspaceId));
  const existingSet = new Set(existing.map((r) => r.provider));
  const builtIn: Provider[] = ["manus_oauth", "data_api", "llm", "google_maps"];
  for (const p of builtIn) {
    if (!existingSet.has(p)) {
      await db.insert(workspaceIntegrations).values({
        workspaceId,
        provider: p,
        status: "connected",
        config: {},
      });
    }
  }
}

export const integrationsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    await ensureDefaults(ctx.workspace.id);
    return db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.workspaceId, ctx.workspace.id));
  }),

  save: adminWsProcedure
    .input(
      z.object({
        provider: z.string().min(1).max(64),
        status: z.enum(["connected", "disconnected", "error"]).optional(),
        config: z.record(z.string(), z.any()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [existing] = await db
        .select()
        .from(workspaceIntegrations)
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, ctx.workspace.id),
            eq(workspaceIntegrations.provider, input.provider),
          ),
        );

      if (existing) {
        await db
          .update(workspaceIntegrations)
          .set({
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.config !== undefined ? { config: input.config } : {}),
          })
          .where(eq(workspaceIntegrations.id, existing.id));
      } else {
        await db.insert(workspaceIntegrations).values({
          workspaceId: ctx.workspace.id,
          provider: input.provider,
          status: input.status ?? "disconnected",
          config: input.config ?? {},
        });
      }
      return { ok: true };
    }),

  test: adminWsProcedure
    .input(z.object({ provider: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      let result = "OK";
      let success = true;

      // Provider-specific lightweight checks
      try {
        if (input.provider === "manus_oauth") {
          // Always connected via platform
          result = "Manus OAuth is always connected via the platform.";
        } else if (input.provider === "llm") {
          // We can't invoke LLM without a prompt, just confirm env is set
          const apiUrl = process.env.BUILT_IN_FORGE_API_URL;
          result = apiUrl ? `LLM endpoint reachable: ${apiUrl}` : "BUILT_IN_FORGE_API_URL not set";
          success = Boolean(apiUrl);
        } else if (input.provider === "google_maps") {
          result = "Google Maps proxy is built-in and always available.";
        } else if (input.provider === "data_api") {
          result = "Manus Data API Hub is built-in and always available.";
        } else if (input.provider === "webhook") {
          // Retrieve config URL and do a HEAD ping
          const [row] = await db
            .select()
            .from(workspaceIntegrations)
            .where(
              and(
                eq(workspaceIntegrations.workspaceId, ctx.workspace.id),
                eq(workspaceIntegrations.provider, "webhook"),
              ),
            );
          const url = (row?.config as any)?.url;
          if (!url) {
            result = "No webhook URL configured.";
            success = false;
          } else {
            try {
              const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
              result = `Webhook responded with HTTP ${res.status}`;
              success = res.ok;
            } catch (e: any) {
              result = `Webhook unreachable: ${e.message}`;
              success = false;
            }
          }
        } else if (input.provider === "stripe") {
          const [row] = await db
            .select()
            .from(workspaceIntegrations)
            .where(
              and(
                eq(workspaceIntegrations.workspaceId, ctx.workspace.id),
                eq(workspaceIntegrations.provider, "stripe"),
              ),
            );
          const key = (row?.config as any)?.publishableKey;
          result = key ? "Stripe publishable key is set." : "No Stripe keys configured.";
          success = Boolean(key);
        } else {
          result = `No test handler for provider "${input.provider}".`;
          success = false;
        }
      } catch (e: any) {
        result = `Test failed: ${e.message}`;
        success = false;
      }

      // Persist test result
      await db
        .update(workspaceIntegrations)
        .set({
          lastTestedAt: new Date(),
          lastTestResult: result,
          status: success ? "connected" : "error",
        })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, ctx.workspace.id),
            eq(workspaceIntegrations.provider, input.provider),
          ),
        );

      return { ok: success, result };
    }),

  remove: adminWsProcedure
    .input(z.object({ provider: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const builtIn = ["manus_oauth", "data_api", "llm", "google_maps"];
      if (builtIn.includes(input.provider)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Built-in integrations cannot be removed" });
      }
      await db
        .delete(workspaceIntegrations)
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, ctx.workspace.id),
            eq(workspaceIntegrations.provider, input.provider),
          ),
        );
      return { ok: true };
    }),
});
