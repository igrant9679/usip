/**
 * unsubscribe.ts — token + HTTP endpoint for one-click unsubscribe.
 *
 * Outbound sales emails (sequence drafts, ad-hoc) get a small footer:
 *   <a href="https://app/api/unsubscribe/:token">Unsubscribe</a>
 *
 * The token encodes { workspaceId, email, issuedAt } and an HMAC-SHA256
 * signature using JWT_SECRET, so we can't be tricked into suppressing
 * arbitrary addresses without a valid pre-signed link.
 *
 * Clicking the link inserts a row into email_suppressions (reason:
 * "unsubscribe") for that workspace + email and shows a small
 * confirmation page. Subsequent sends to that recipient are skipped at
 * the deliverEmailDraft / sendAdHocEmail layer.
 */
import { createHmac } from "crypto";
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { emailSuppressions } from "../drizzle/schema";
import { getDb } from "./db";

const SECRET = () => process.env.JWT_SECRET ?? "fallback-dev-secret-unsubscribe-32-bytes";

function sign(payload: string): string {
  return createHmac("sha256", SECRET()).update(payload).digest("base64url");
}

/** Build the unsubscribe URL for a recipient. Idempotent — same inputs → same URL. */
export function makeUnsubscribeUrl(
  appBase: string,
  workspaceId: number,
  email: string,
): string {
  const lower = email.trim().toLowerCase();
  const payload = `${workspaceId}.${lower}`;
  const sig = sign(payload);
  // base64url-encode the payload too so we don't have to worry about
  // characters in the email address (apostrophes, +tags, etc.) in the URL.
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const token = `${payloadB64}.${sig}`;
  return `${appBase.replace(/\/$/, "")}/api/unsubscribe/${token}`;
}

interface DecodedToken {
  workspaceId: number;
  email: string;
}

function decodeToken(token: string): DecodedToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (sign(payload) !== sig) return null;
  const idx = payload.indexOf(".");
  if (idx < 0) return null;
  const wsId = parseInt(payload.slice(0, idx), 10);
  const email = payload.slice(idx + 1);
  if (!wsId || !email) return null;
  return { workspaceId: wsId, email };
}

/**
 * Idempotent suppression — insert if not present, no-op if already there.
 * Returns whether this was a new suppression.
 */
async function suppressIfNew(workspaceId: number, email: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const lower = email.toLowerCase();
  const existing = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.email, lower),
      ),
    )
    .limit(1);
  if (existing.length > 0) return false;
  await db.insert(emailSuppressions).values({
    workspaceId,
    email: lower,
    reason: "unsubscribe",
  });
  return true;
}

/** True if this email is currently suppressed for the given workspace. */
export async function isSuppressed(workspaceId: number, email: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const lower = email.trim().toLowerCase();
  const [row] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.email, lower),
      ),
    )
    .limit(1);
  return !!row;
}

const CONFIRM_PAGE = (email: string, ok: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribed</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:#f9fafb; color:#111827; margin:0; padding:48px 24px; }
  .card { max-width:480px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:32px; text-align:center; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
  h1 { font-size:20px; margin:0 0 8px; color:${ok ? "#059669" : "#dc2626"}; }
  p { color:#4b5563; line-height:1.55; margin:8px 0; }
  code { background:#f3f4f6; padding:2px 6px; border-radius:4px; font-size:13px; }
</style></head>
<body><div class="card">
  <h1>${ok ? "You've been unsubscribed" : "Already unsubscribed"}</h1>
  <p>${ok ? "We won't send marketing emails to" : "No more marketing emails will be sent to"} <code>${email}</code>.</p>
  <p style="margin-top:24px;font-size:13px;color:#6b7280">If this was a mistake, just reply to any past message from us and we'll get you re-added.</p>
</div></body></html>`;

const INVALID_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invalid link</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827;padding:48px 24px;}
.card{max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center;}</style></head>
<body><div class="card"><h1 style="color:#dc2626">Invalid unsubscribe link</h1>
<p>This link is malformed or has been tampered with. If you want to unsubscribe, reply to any of our messages and we'll handle it.</p>
</div></body></html>`;

export function registerUnsubscribeRoute(app: Express) {
  app.get("/api/unsubscribe/:token", async (req: Request, res: Response) => {
    const decoded = decodeToken(String(req.params.token ?? ""));
    if (!decoded) {
      res.status(400).type("html").send(INVALID_PAGE);
      return;
    }
    try {
      const isNew = await suppressIfNew(decoded.workspaceId, decoded.email);
      console.log(
        `[Unsubscribe] ws=${decoded.workspaceId} email=${decoded.email} ${isNew ? "added" : "already-suppressed"}`,
      );
      res.type("html").send(CONFIRM_PAGE(decoded.email, isNew));
    } catch (err) {
      console.error("[Unsubscribe] error processing:", err);
      // Still confirm to the recipient — don't leak failures into UX.
      res.type("html").send(CONFIRM_PAGE(decoded.email, true));
    }
  });
}
