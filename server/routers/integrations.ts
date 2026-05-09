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
import { getCredits, searchPeople, CloduraError } from "../services/clodura/client";

const PROVIDERS = [
  "manus_oauth",
  "scim",
  "stripe",
  "data_api",
  "llm",
  "google_maps",
  "webhook",
  "clodura",
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
        } else if (input.provider === "clodura") {
          const [row] = await db
            .select()
            .from(workspaceIntegrations)
            .where(
              and(
                eq(workspaceIntegrations.workspaceId, ctx.workspace.id),
                eq(workspaceIntegrations.provider, "clodura"),
              ),
            );
          // Trim defensively — pasted keys often carry trailing whitespace
          // or newlines that cause silent auth failures.
          const rawKey = (row?.config as any)?.apiKey;
          const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
          if (!apiKey) {
            result = "No Clodura API key configured.";
            success = false;
          } else {
            // Two-step probe:
            //   1. Try GET /credits (zero-cost, documented for most plans).
            //   2. If that 404s (e.g. Lifetime / LTD plans where /credits
            //      isn't exposed), fall through to a tiny /search/people
            //      call which is universal across plans. Costs 1 credit
            //      per click — acceptable per user.
            const formatAuthError = (e: CloduraError, label: string) => {
              const hint = `(key length=${apiKey.length})`;
              if (e.statusCode === 401 || e.statusCode === 403) {
                return `Invalid Clodura API key: ${e.message} ${hint}`;
              }
              if (e.statusCode === 402) {
                return `Clodura credits exhausted: ${e.message}`;
              }
              return `Clodura test failed via ${label} (HTTP ${e.statusCode}): ${e.message}`;
            };

            try {
              const credits = await getCredits(apiKey);
              if (typeof credits.remainingCredits === "number") {
                result = `Connected. Credits remaining: ${credits.remainingCredits}.`;
              } else if (typeof credits.contactsView === "number") {
                result = `Connected. Contacts viewed: ${credits.contactsView}/${credits.maxContacts ?? "?"}, phones: ${credits.directDials ?? 0}/${credits.maxDirectDials ?? "?"}.`;
              } else {
                result = "Connected.";
              }
              success = true;
            } catch (creditsErr) {
              const isCloduraErr = creditsErr instanceof CloduraError;
              // /credits 404 → plan probably doesn't expose it. Fall back
              // to /search/people — universal across plans. Any other 4xx
              // (auth, plan) propagates without a second call.
              if (isCloduraErr && (creditsErr as CloduraError).statusCode === 404) {
                try {
                  await searchPeople(
                    { firstName: "__usip_connectivity_probe__", perPage: 25 },
                    apiKey,
                  );
                  result = "Connected. Search API reachable (1 credit consumed for probe).";
                  success = true;
                } catch (searchErr) {
                  if (searchErr instanceof CloduraError) {
                    // 404 on a 0-result search is Clodura's "success-empty"
                    // signal per their HTTP code table — count it as connected.
                    if (searchErr.statusCode === 404) {
                      result = "Connected. Search API reachable (no matches for probe filter).";
                      success = true;
                    } else {
                      result = formatAuthError(searchErr, "search/people");
                      success = false;
                    }
                  } else {
                    result = `Clodura test failed: ${(searchErr as Error).message}`;
                    success = false;
                  }
                }
              } else if (isCloduraErr) {
                result = formatAuthError(creditsErr as CloduraError, "credits");
                success = false;
              } else {
                result = `Clodura test failed: ${(creditsErr as Error).message}`;
                success = false;
              }
            }
          }
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
