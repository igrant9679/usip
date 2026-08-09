/**
 * graphOAuth — the /api/graph/callback endpoint for Microsoft 365.
 *
 * The flow: the client asks tRPC (graph.getConnectUrl) for an authorize URL
 * carrying a 15-minute SIGNED state (userId + workspaceId), the browser
 * round-trips through login.microsoftonline.com, and Microsoft lands here
 * with ?code&state. The state signature — not a session cookie — is what
 * authenticates the landing, so the flow survives any cookie policy the
 * redirect chain applies. On success the refresh token is encrypted at rest
 * and the browser is bounced to /connected-accounts with a status flag the
 * card reads for its toast.
 */
import type { Express, Request, Response } from "express";
import { getDb } from "./db";
import { graphConnections } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { encryptSecret } from "./_core/crypto";
import {
  exchangeCode,
  graphEnvConfigured,
  verifyOAuthState,
  graphFetch,
  getConnection,
  clearTokenCache,
  GRAPH_SCOPES,
} from "./services/msgraph";

export function registerGraphOAuthRoutes(app: Express): void {
  app.get("/api/graph/callback", async (req: Request, res: Response) => {
    const fail = (reason: string) =>
      res.redirect(302, `/connected-accounts?graph=error&reason=${encodeURIComponent(reason.slice(0, 200))}`);

    try {
      if (!graphEnvConfigured()) return fail("MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET are not set");
      const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
      if (error) return fail(error_description ?? error);
      if (!code || !state) return fail("Missing code or state");

      const who = await verifyOAuthState(state);
      if (!who) return fail("Sign-in link expired — try Connect again");

      const tokens = await exchangeCode(code);
      if (!tokens.refresh_token) {
        return fail(tokens.error_description ?? tokens.error ?? "Microsoft returned no refresh token");
      }

      const db = await getDb();
      if (!db) return fail("Database unavailable");

      // Upsert BEFORE the profile fetch: the connection must survive even if
      // the /me call hiccups — the email is cosmetic, the token is not.
      const existing = await getConnection(who.workspaceId, who.userId);
      if (existing) {
        clearTokenCache(existing.id);
        await db.update(graphConnections)
          .set({ refreshTokenEnc: encryptSecret(tokens.refresh_token), scopes: GRAPH_SCOPES, status: "active" })
          .where(eq(graphConnections.id, existing.id));
      } else {
        await db.insert(graphConnections).values({
          workspaceId: who.workspaceId,
          userId: who.userId,
          refreshTokenEnc: encryptSecret(tokens.refresh_token),
          scopes: GRAPH_SCOPES,
          status: "active",
        });
      }

      // Best-effort display email.
      try {
        const conn = await getConnection(who.workspaceId, who.userId);
        if (conn) {
          const me = await graphFetch<{ mail?: string; userPrincipalName?: string }>(conn, "/me");
          const email = me.mail ?? me.userPrincipalName ?? null;
          if (email) {
            await db.update(graphConnections)
              .set({ msEmail: email })
              .where(and(eq(graphConnections.workspaceId, who.workspaceId), eq(graphConnections.userId, who.userId)));
          }
        }
      } catch {
        /* cosmetic */
      }

      return res.redirect(302, "/connected-accounts?graph=connected");
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });
}
