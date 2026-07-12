/**
 * voiceWebhook.ts — inbound xAI Voice Agent SIP webhook.
 *
 * xAI POSTs `realtime.call.incoming` here when someone calls a registered
 * agent phone number (a prospect returning a rep's call). Payload:
 *   { object:"event", type:"realtime.call.incoming",
 *     data:{ call_id, sip_headers:[{name,value},…] } }
 * Signed svix-style: webhook-id / webhook-timestamp / webhook-signature
 * headers; signature = base64(HMAC-SHA256(secret, `${id}.${ts}.${rawBody}`)),
 * header holds space-separated `v1,<base64>` entries. The signing secret is
 * per-registered-number (stored encrypted on the matching voice_agents row) —
 * so a VERIFYING secret also IDENTIFIES the agent when no To header is given.
 *
 * Phase 1 (this file): verify, log the call into voice_calls, and notify the
 * agent's owner in-app. Phase 2 (next unit) answers the call by opening
 * wss://api.x.ai/v1/realtime?call_id=… and sending the agent's session config.
 */
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import { notifications, voiceAgents, voiceCalls } from "../drizzle/schema";
import { getDb } from "./db";
import { tryDecryptSecret } from "./_core/crypto";
import { answerInboundCall } from "./services/voiceBridge";
import { matchCallerToRecord } from "./services/voiceCrmLink";

type SipHeader = { name?: string; value?: string };

function sipHeader(headers: SipHeader[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/** svix signature check. Secret may be raw or `whsec_<base64>`. */
export function verifySvixSignature(
  secret: string,
  msgId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  try {
    const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
    const expected = crypto.createHmac("sha256", key).update(`${msgId}.${timestamp}.${rawBody}`).digest("base64");
    return signatureHeader
      .split(/\s+/)
      .map((part) => part.split(",")[1] ?? "")
      .some((sig) => {
        if (!sig || sig.length !== expected.length) return false;
        try {
          return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

export function registerVoiceWebhookRoutes(app: Express): void {
  app.post("/api/voice/xai/webhook", async (req: Request, res: Response) => {
    try {
      const body = req.body as { type?: string; data?: { call_id?: string; sip_headers?: SipHeader[] } };
      if (body?.type !== "realtime.call.incoming" || !body.data?.call_id) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }
      const db = await getDb();
      if (!db) { res.status(500).json({ ok: false }); return; }

      const from = sipHeader(body.data.sip_headers, "From");
      const to = sipHeader(body.data.sip_headers, "To");

      // Candidate agents: active call-back receptionists with a webhook secret.
      const candidates = await db
        .select()
        .from(voiceAgents)
        .where(and(eq(voiceAgents.status, "active"), isNotNull(voiceAgents.sipWebhookSecretEnc)));

      // Verify the signature; the secret that verifies identifies the agent.
      const msgId = String(req.headers["webhook-id"] ?? "");
      const ts = String(req.headers["webhook-timestamp"] ?? "");
      const sigHeader = String(req.headers["webhook-signature"] ?? "");
      const rawBody = ((req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body))).toString("utf8");

      let agent =
        candidates.find((a) => {
          const secret = tryDecryptSecret(a.sipWebhookSecretEnc);
          return secret && msgId && ts && sigHeader && verifySvixSignature(secret, msgId, ts, rawBody, sigHeader);
        }) ?? null;

      // Fallback: match by called number for numbers registered without a
      // secret (manual console setup) — signature can't be checked then.
      if (!agent && to) {
        const digits = to.replace(/\D/g, "");
        const all = await db.select().from(voiceAgents).where(eq(voiceAgents.status, "active"));
        agent = all.find((a) => a.phoneNumber && digits.endsWith(a.phoneNumber.replace(/\D/g, ""))) ?? null;
        if (agent?.sipWebhookSecretEnc) agent = null; // has a secret but sig failed → reject
      }

      if (!agent) {
        res.status(401).json({ ok: false, error: "no agent verified for this call" });
        return;
      }

      // Best-effort caller → CRM record match (contact > lead > prospect).
      const match = await matchCallerToRecord(agent.workspaceId, from).catch(() => null);

      const insert = await db.insert(voiceCalls).values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        direction: "inbound",
        fromNumber: from?.slice(0, 32) ?? null,
        toNumber: (to ?? agent.phoneNumber)?.slice(0, 32) ?? null,
        xaiCallId: body.data.call_id.slice(0, 128),
        status: "ringing",
        relatedType: match?.relatedType ?? null,
        relatedId: match?.relatedId ?? null,
        userId: agent.ownerUserId ?? null,
        startedAt: new Date(),
      });
      const callRowId = Number((insert as unknown as { insertId?: number })?.insertId ?? 0);

      // Answer the call: fire-and-forget so this handler ACKs xAI fast.
      answerInboundCall({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        callRowId: callRowId,
        xaiCallId: body.data.call_id,
      });

      // Notify the member the agent answers for. kind stays inside the
      // notifications enum ("system") — do NOT invent a new enum value here.
      if (agent.ownerUserId) {
        await db.insert(notifications).values({
          workspaceId: agent.workspaceId,
          userId: agent.ownerUserId,
          kind: "system",
          title: `Call-back${match ? ` from ${match.name}` : from ? ` from ${from}` : ""}`,
          body: `Your voice agent "${agent.name}" answered an inbound call${match ? ` from ${match.name} (${match.relatedType})` : ""}.`,
          relatedType: "voice_call",
          relatedId: callRowId || null,
        });
      }

      res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[VoiceWebhook] failed:", e);
      res.status(500).json({ ok: false });
    }
  });
}
