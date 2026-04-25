/**
 * Unipile Account Webhook Handler
 *
 * POST /api/unipile/account-webhook?userId=<id>&workspaceId=<id>
 *
 * Unipile calls this URL (notify_url) after a user successfully completes the
 * Hosted Auth Wizard. The payload is:
 *   { status: "CREATION_SUCCESS" | "RECONNECTED", account_id: string, name: string }
 *
 * We fetch the full account details from Unipile and upsert a row into
 * unipile_accounts so the Connected Accounts page shows the new account
 * immediately.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { unipileAccounts } from "../drizzle/schema";
import { getUnipileAccount } from "./lib/unipile";

export function registerUnipileWebhookRoutes(app: Express) {
  /**
   * Account connection webhook — called by Unipile after OAuth completes.
   * userId and workspaceId are passed as query params in the notify_url.
   */
  app.post(
    "/api/unipile/account-webhook",
    async (req: Request, res: Response) => {
      // Always respond 200 quickly so Unipile doesn't retry
      res.status(200).json({ ok: true });

      try {
        const userId = parseInt(String(req.query.userId ?? ""), 10);
        const workspaceId = parseInt(String(req.query.workspaceId ?? ""), 10);

        if (!userId || !workspaceId) {
          console.warn("[UnipileWebhook] Missing userId or workspaceId in query params");
          return;
        }

        const body = req.body as {
          status?: string;
          account_id?: string;
          name?: string;
        };

        const { status, account_id } = body;

        if (!account_id) {
          console.warn("[UnipileWebhook] Missing account_id in webhook body:", body);
          return;
        }

        if (status !== "CREATION_SUCCESS" && status !== "RECONNECTED") {
          // Ignore other statuses (e.g. CREATION_FAILED)
          console.log(`[UnipileWebhook] Ignoring status=${status} for account ${account_id}`);
          return;
        }

        console.log(
          `[UnipileWebhook] ${status} for account ${account_id} (userId=${userId}, workspaceId=${workspaceId})`,
        );

        // Fetch full account details from Unipile
        const acct = await getUnipileAccount(account_id);

        // Extract display name and profile picture from connection_params
        let displayName: string | null = acct.name ?? null;
        let profilePicture: string | null = null;

        if (acct.connection_params) {
          // connection_params has a key per provider (e.g. "im" for LinkedIn)
          const providerKey = Object.keys(acct.connection_params)[0];
          if (providerKey) {
            const params = acct.connection_params[providerKey] as Record<
              string,
              unknown
            >;
            if (typeof params.username === "string" && params.username) {
              displayName = params.username;
            }
            if (
              typeof params.profile_picture_url === "string" &&
              params.profile_picture_url
            ) {
              profilePicture = params.profile_picture_url;
            }
          }
        }

        const db = await getDb();

        // Check if this account already exists for this user
        const [existing] = await db
          .select({ id: unipileAccounts.id })
          .from(unipileAccounts)
          .where(
            and(
              eq(unipileAccounts.unipileAccountId, account_id),
              eq(unipileAccounts.userId, userId),
            ),
          )
          .limit(1);

        if (existing) {
          // Update status on reconnect
          await db
            .update(unipileAccounts)
            .set({
              status: "OK",
              displayName: displayName ?? undefined,
              profilePicture: profilePicture ?? undefined,
              connectedAt: new Date(),
            })
            .where(eq(unipileAccounts.id, existing.id));

          console.log(
            `[UnipileWebhook] Updated existing account row id=${existing.id}`,
          );
        } else {
          // Insert new row
          await db.insert(unipileAccounts).values({
            workspaceId,
            userId,
            unipileAccountId: account_id,
            provider: acct.type, // e.g. "LINKEDIN"
            displayName,
            profilePicture,
            status: "OK",
            connectedAt: new Date(),
          });

          console.log(
            `[UnipileWebhook] Inserted new account ${account_id} (${acct.type}) for userId=${userId}`,
          );
        }
      } catch (err) {
        console.error("[UnipileWebhook] Error processing webhook:", err);
      }
    },
  );
}
