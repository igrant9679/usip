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
 * ⚠️ GET ASKS, POST ACTS (2026-08-14). A bare GET used to suppress on sight,
 * and corporate mail security fetches every URL in an inbound message to scan
 * it — so each of those scans silently unsubscribed a recipient who had
 * clicked nothing, permanently, with nothing recorded to say it happened. GET
 * now returns a confirmation the recipient submits; POST inserts the
 * email_suppressions row (reason "unsubscribe", plus a `source` naming how it
 * arrived). Subsequent sends to that recipient are skipped at the
 * deliverEmailDraft / sendAdHocEmail layer.
 *
 * POST is also the RFC 8058 one-click endpoint — see unsubscribeHeaders.
 */
import { createHmac } from "crypto";
import { escapeHtml } from "@shared/escapeHtml";
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

/**
 * The RFC 8058 one-click headers for a recipient.
 *
 * Gmail and Yahoo have required these of bulk senders since February 2024.
 * Two things follow from having them, both about accuracy:
 *
 *   • the recipient's mail client shows a native Unsubscribe control, and
 *     pressing it POSTs to us — so the opt-out is RECORDED instead of
 *     happening invisibly, or not at all;
 *   • recipients who would otherwise reach for "report spam" (which we never
 *     see, and which damages the sending domain) have a cheaper option.
 *
 * `List-Unsubscribe-Post` is what tells the client it may act without opening
 * a browser. Sending the URL alone leaves clients free to GET it, which is
 * exactly what must not happen — see registerUnsubscribeRoute.
 */
export function unsubscribeHeaders(
  appBase: string,
  workspaceId: number,
  email: string,
): Record<string, string> {
  const url = makeUnsubscribeUrl(appBase, workspaceId, email);
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
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
 *
 * `source` records HOW the opt-out arrived (migration 0165). A suppression
 * list is only as good as its provenance: until the GET endpoint stopped
 * acting, some share of this list was mail scanners following a link.
 */
async function suppressIfNew(
  workspaceId: number,
  email: string,
  source: "link_confirmed" | "one_click_header" | "reply" | "manual",
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const lower = normalizeSuppressionEmail(email);
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
    source,
  });
  return true;
}

/** True if this email is currently suppressed for the given workspace. */
/**
 * The ONE normalisation for a suppression address, on reads AND writes.
 *
 * The suppression list had four writers and two readers, normalising four
 * different ways:
 *   unsubscribe.ts          trim + lowercase   (this file — the strict one)
 *   emailSuppressions.ts    lowercase only
 *   emailTracking.ts        RAW `event.email`  (bounce / spam-complaint webhooks)
 *   replyClassifier.ts      RAW `reply.fromEmail`
 * and the two readers disagreed too: isSuppressed trimmed, isEmailSuppressed
 * did not.
 *
 * Case is survivable — the column inherits MySQL 8's default
 * utf8mb4_0900_ai_ci, which is case-insensitive. Whitespace is NOT: that
 * collation is NO PAD, so a stored or queried address carrying a stray space
 * simply fails to match. A raw webhook or an inbound From header is exactly
 * where such a value comes from, and the cost of a miss here is mailing someone
 * who asked not to be mailed — a compliance failure, not a cosmetic one.
 *
 * So: normalise identically everywhere, and stop relying on a collation detail
 * to cover for it.
 */
export function normalizeSuppressionEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export async function isSuppressed(workspaceId: number, email: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const lower = normalizeSuppressionEmail(email);
  if (!lower) return false;
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
  <p>${ok ? "We won't send marketing emails to" : "No more marketing emails will be sent to"} <code>${escapeHtml(email)}</code>.</p>
  <p style="margin-top:24px;font-size:13px;color:#6b7280">If this was a mistake, just reply to any past message from us and we'll get you re-added.</p>
</div></body></html>`;

const INVALID_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invalid link</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827;padding:48px 24px;}
.card{max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center;}</style></head>
<body><div class="card"><h1 style="color:#dc2626">Invalid unsubscribe link</h1>
<p>This link is malformed or has been tampered with. If you want to unsubscribe, reply to any of our messages and we'll handle it.</p>
</div></body></html>`;

/**
 * The page a GET now returns: a confirmation the recipient has to submit.
 *
 * Corporate mail security (Proofpoint, Mimecast, Barracuda, Microsoft Safe
 * Links) fetches EVERY URL in an inbound message to scan it. While GET
 * suppressed on sight, each of those scans silently unsubscribed a recipient
 * who had never clicked anything — removing real prospects from every future
 * send, with nothing anywhere to say it had happened. It is the same
 * false-positive as a prefetched open pixel, except the damage is permanent.
 *
 * A scanner issues GET and stops. It does not submit forms. So the act moves
 * to POST, and GET becomes a question.
 */
const CONFIRM_FORM_PAGE = (email: string, token: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribe</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
  body { font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:#f9fafb; color:#111827; margin:0; padding:48px 24px; }
  .card { max-width:480px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:32px; text-align:center; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#4b5563; line-height:1.55; margin:8px 0; }
  code { background:#f3f4f6; padding:2px 6px; border-radius:4px; font-size:13px; }
  button { margin-top:20px; background:#dc2626; color:#fff; border:0; border-radius:8px; padding:12px 22px; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#b91c1c; }
</style></head>
<body><div class="card">
  <h1>Unsubscribe <code>${escapeHtml(email)}</code>?</h1>
  <p>You'll stop receiving marketing emails from us at this address.</p>
  <form method="POST" action="/api/unsubscribe/${encodeURIComponent(token)}">
    <button type="submit">Yes, unsubscribe me</button>
  </form>
  <p style="margin-top:20px;font-size:13px;color:#6b7280">Didn't mean to click this? Just close the page — nothing has changed yet.</p>
</div></body></html>`;

export function registerUnsubscribeRoute(app: Express) {
  /**
   * GET — ask, never act. See CONFIRM_FORM_PAGE.
   */
  app.get("/api/unsubscribe/:token", async (req: Request, res: Response) => {
    const raw = String(req.params.token ?? "");
    const decoded = decodeToken(raw);
    if (!decoded) {
      res.status(400).type("html").send(INVALID_PAGE);
      return;
    }
    // Already on the list: say so rather than asking them to confirm again.
    try {
      if (await isSuppressed(decoded.workspaceId, decoded.email)) {
        res.type("html").send(CONFIRM_PAGE(decoded.email, false));
        return;
      }
    } catch {
      // Fall through to the form — asking twice is harmless.
    }
    res.type("html").send(CONFIRM_FORM_PAGE(decoded.email, raw));
  });

  /**
   * POST — the act. Two callers, both deliberate:
   *
   *   1. the confirmation form above, submitted by a person;
   *   2. the recipient's own mail client, via RFC 8058 one-click unsubscribe
   *      (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`), which Gmail
   *      and Yahoo require of bulk senders and which posts the body
   *      `List-Unsubscribe=One-Click`.
   *
   * Case 2 is the accuracy win that matters most: without it, a recipient who
   * uses their mail client's Unsubscribe button either achieves nothing or —
   * far worse — is offered "report spam" instead, which we never see and which
   * costs domain reputation. With it, the intent lands in our suppression list.
   */
  app.post("/api/unsubscribe/:token", async (req: Request, res: Response) => {
    const decoded = decodeToken(String(req.params.token ?? ""));
    if (!decoded) {
      res.status(400).type("html").send(INVALID_PAGE);
      return;
    }
    // RFC 8058 posts exactly `List-Unsubscribe=One-Click`, form-urlencoded.
    // The confirmation form sends no fields, so the two are distinguishable.
    const body = req.body as Record<string, unknown> | undefined;
    const oneClick = String(body?.["List-Unsubscribe"] ?? "").trim() === "One-Click";
    try {
      const isNew = await suppressIfNew(
        decoded.workspaceId,
        decoded.email,
        oneClick ? "one_click_header" : "link_confirmed",
      );
      console.log(
        `[Unsubscribe] ws=${decoded.workspaceId} email=${decoded.email} ` +
          `via=${oneClick ? "one-click-header" : "confirm-form"} ${isNew ? "added" : "already-suppressed"}`,
      );
      // RFC 8058 clients want a 200 and ignore the body; humans get the page.
      res.type("html").send(CONFIRM_PAGE(decoded.email, isNew));
    } catch (err) {
      console.error("[Unsubscribe] error processing:", err);
      // Still confirm to the recipient — don't leak failures into UX.
      res.type("html").send(CONFIRM_PAGE(decoded.email, true));
    }
  });
}
