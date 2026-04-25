/**
 * Unipile Webhook Handlers
 *
 * POST /api/unipile/account-webhook?userId=<id>&workspaceId=<id>
 *   Called by Unipile's Hosted Auth Wizard notify_url after a user successfully
 *   connects or reconnects an account.
 *   Payload: { status: "CREATION_SUCCESS" | "RECONNECTED", account_id: string, name: string }
 *
 * POST /api/unipile/status-webhook
 *   Called by a registered Unipile account_status webhook for any account
 *   status change across all connected accounts.
 *   Payload: { AccountStatus: { account_id: string, account_type: string, message: string } }
 *   Relevant message values:
 *     "OK"          — account is healthy
 *     "CREDENTIALS" — token expired / needs re-authentication
 *     "ERROR"       — synchronisation error
 *     "STOPPED"     — account synchronisation stopped
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { unipileAccounts, users } from "../drizzle/schema";
import { generateHostedAuthLink, getUnipileAccount } from "./lib/unipile";

// Statuses that mean the account needs re-authentication
const EXPIRED_STATUSES = new Set(["CREDENTIALS", "ERROR", "STOPPED"]);

export function registerUnipileWebhookRoutes(app: Express) {
  // ─── 1. Hosted Auth Wizard notify_url ─────────────────────────────────────
  /**
   * Called by Unipile after the user completes the Hosted Auth Wizard.
   * userId and workspaceId are embedded in the notify_url query params.
   */
  app.post(
    "/api/unipile/account-webhook",
    async (req: Request, res: Response) => {
      // Respond 200 immediately so Unipile doesn't retry
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
          const providerKey = Object.keys(acct.connection_params)[0];
          if (providerKey) {
            const params = acct.connection_params[providerKey] as Record<string, unknown>;
            if (typeof params.username === "string" && params.username) {
              displayName = params.username;
            }
            if (typeof params.profile_picture_url === "string" && params.profile_picture_url) {
              profilePicture = params.profile_picture_url;
            }
          }
        }

        const db = await getDb();

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
          await db
            .update(unipileAccounts)
            .set({
              status: "OK",
              displayName: displayName ?? undefined,
              profilePicture: profilePicture ?? undefined,
              connectedAt: new Date(),
            })
            .where(eq(unipileAccounts.id, existing.id));

          console.log(`[UnipileWebhook] Updated existing account row id=${existing.id}`);
        } else {
          await db.insert(unipileAccounts).values({
            workspaceId,
            userId,
            unipileAccountId: account_id,
            provider: acct.type,
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
        console.error("[UnipileWebhook] Error processing account-webhook:", err);
      }
    },
  );

  // ─── 2. Account status webhook (CREDENTIALS / ERROR / STOPPED) ────────────
  /**
   * Registered as a Unipile account_status webhook.
   * Receives status change events for all accounts connected to this Unipile DSN.
   *
   * On CREDENTIALS / ERROR / STOPPED:
   *   1. Mark the local unipile_accounts row as disabled (status = message)
   *   2. Send a re-authentication email to the account owner with a fresh reconnect link
   */
  app.post(
    "/api/unipile/status-webhook",
    async (req: Request, res: Response) => {
      res.status(200).json({ ok: true });

      try {
        const body = req.body as {
          AccountStatus?: {
            account_id?: string;
            account_type?: string;
            message?: string;
          };
        };

        const event = body?.AccountStatus;
        if (!event?.account_id || !event?.message) {
          console.warn("[UnipileStatusWebhook] Unexpected payload shape:", body);
          return;
        }

        const { account_id, message: statusMsg } = event;

        console.log(`[UnipileStatusWebhook] account=${account_id} status=${statusMsg}`);

        const db = await getDb();

        // Find the local row for this Unipile account
        const [row] = await db
          .select()
          .from(unipileAccounts)
          .where(eq(unipileAccounts.unipileAccountId, account_id))
          .limit(1);

        if (!row) {
          console.warn(`[UnipileStatusWebhook] No local row for account_id=${account_id}`);
          return;
        }

        // Always update the status so the UI can reflect the current state
        await db
          .update(unipileAccounts)
          .set({ status: statusMsg })
          .where(eq(unipileAccounts.id, row.id));

        console.log(`[UnipileStatusWebhook] Updated account id=${row.id} status → ${statusMsg}`);

        // Only send re-auth email for expired/broken statuses
        if (!EXPIRED_STATUSES.has(statusMsg)) {
          return;
        }

        // Look up the user's email address
        const [user] = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, row.userId))
          .limit(1);

        if (!user?.email) {
          console.warn(`[UnipileStatusWebhook] No email for userId=${row.userId}`);
          return;
        }

        // Generate a fresh reconnect link
        const appBase = (process.env.MANUS_APP_URL ?? "").replace(/\/$/, "");
        if (!appBase) {
          console.warn("[UnipileStatusWebhook] MANUS_APP_URL not set — skipping reconnect email");
          return;
        }

        const notifyUrl = `${appBase}/api/unipile/account-webhook?userId=${row.userId}&workspaceId=${row.workspaceId}`;
        const successRedirectUrl = `${appBase}/connected-accounts?connected=1`;
        const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

        let reconnectUrl: string;
        try {
          const result = await generateHostedAuthLink({
            type: "reconnect",
            providers: [row.provider],
            expiresOn,
            notifyUrl,
            successRedirectUrl,
            name: String(row.userId),
            reconnectAccount: account_id,
          });
          reconnectUrl = result.url;
        } catch (linkErr) {
          console.error("[UnipileStatusWebhook] Failed to generate reconnect link:", linkErr);
          return;
        }

        const providerLabel = row.provider ?? "social";
        const accountLabel = row.displayName ?? account_id;
        const statusLabel =
          statusMsg === "CREDENTIALS"
            ? "expired credentials"
            : statusMsg === "ERROR"
              ? "a synchronisation error"
              : "being stopped";

        const { sendWorkspaceEmail } = await import("./emailDelivery");
        await sendWorkspaceEmail(row.workspaceId, {
          to: user.email,
          subject: `Action required: Reconnect your ${providerLabel} account`,
          html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:8px">Your ${providerLabel} account needs attention</h2>
  <p>Hi ${user.name ?? user.email.split("@")[0]},</p>
  <p>Your <strong>${providerLabel}</strong> account <em>${accountLabel}</em> has been disconnected due to ${statusLabel}.</p>
  <p>To restore access and continue receiving messages and updates, please reconnect your account:</p>
  <p style="margin:24px 0">
    <a href="${reconnectUrl}"
       style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
      Reconnect ${providerLabel} account
    </a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link: <a href="${reconnectUrl}">${reconnectUrl}</a></p>
  <p style="color:#6b7280;font-size:13px">This link expires in 24 hours. If you need a new link, visit <a href="${appBase}/connected-accounts">Connected Accounts</a> and click Reconnect.</p>
  <p style="color:#9ca3af;font-size:12px">If you did not expect this email, you can safely ignore it.</p>
</div>`,
          text: `Your ${providerLabel} account (${accountLabel}) needs to be reconnected. Visit: ${reconnectUrl}`,
        });

        console.log(
          `[UnipileStatusWebhook] Sent re-auth email to ${user.email} for account ${account_id}`,
        );
      } catch (err) {
        console.error("[UnipileStatusWebhook] Error processing status-webhook:", err);
      }
    },
  );
}
