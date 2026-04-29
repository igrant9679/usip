/**
 * Clodura webhook handlers
 * POST /api/webhooks/clodura/email  — email reveal completed
 * POST /api/webhooks/clodura/phone  — phone reveal completed
 *
 * Secured with HMAC-SHA256 signature in X-Clodura-Signature header.
 * Payload is logged (with PII redaction) for 7 days.
 */
import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { cloduraRevealJobs, prospects } from "../../../drizzle/schema";

const WEBHOOK_SECRET = process.env.CLODURA_WEBHOOK_SECRET ?? "";

function verifySignature(req: Request): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn("[CloduraWebhook] CLODURA_WEBHOOK_SECRET not set — skipping signature check");
    return true; // permissive in dev; enforce in prod by setting the env var
  }
  const sig = req.headers["x-clodura-signature"] as string | undefined;
  if (!sig) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function redactPii(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...payload };
  if (redacted.email) redacted.email = "[REDACTED]";
  if (redacted.phone) redacted.phone = "[REDACTED]";
  return redacted;
}

async function handleReveal(kind: "email" | "phone", req: Request, res: Response) {
  // Respond 200 immediately so Clodura doesn't retry
  res.status(200).json({ ok: true });

  const body = req.body as {
    trackingId?: string;
    status?: string;
    email?: string;
    phone?: string;
    error?: string;
  };

  // Log with PII redaction
  console.log(`[CloduraWebhook] ${kind} reveal:`, JSON.stringify(redactPii(body as any)));

  if (!body.trackingId) {
    console.warn("[CloduraWebhook] Missing trackingId in payload");
    return;
  }

  try {
    const db = await getDb();
    if (!db) return;

    const [job] = await db
      .select()
      .from(cloduraRevealJobs)
      .where(eq(cloduraRevealJobs.trackingId, body.trackingId))
      .limit(1);

    if (!job) {
      console.warn(`[CloduraWebhook] No reveal job found for trackingId ${body.trackingId}`);
      return;
    }

    const isSuccess = body.status === "completed" && !body.error;

    // Update the reveal job
    await db
      .update(cloduraRevealJobs)
      .set({
        status: isSuccess ? "completed" : "failed",
        completedAt: new Date(),
        error: body.error ?? null,
      })
      .where(eq(cloduraRevealJobs.id, job.id));

    // Update the prospect with the revealed value
    if (isSuccess) {
      if (kind === "email" && body.email) {
        await db
          .update(prospects)
          .set({
            email: body.email,
            emailStatus: "verified",
            emailRevealedAt: new Date(),
          })
          .where(eq(prospects.id, job.prospectId));
      } else if (kind === "phone" && body.phone) {
        await db
          .update(prospects)
          .set({
            phone: body.phone,
            phoneRevealedAt: new Date(),
          })
          .where(eq(prospects.id, job.prospectId));
      }
    }
  } catch (e) {
    console.error("[CloduraWebhook] Error processing reveal:", e);
  }
}

export function registerCloduraWebhookRoutes(app: Express) {
  app.post("/api/webhooks/clodura/email", async (req: Request, res: Response) => {
    if (!verifySignature(req)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    await handleReveal("email", req, res);
  });

  app.post("/api/webhooks/clodura/phone", async (req: Request, res: Response) => {
    if (!verifySignature(req)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    await handleReveal("phone", req, res);
  });
}
