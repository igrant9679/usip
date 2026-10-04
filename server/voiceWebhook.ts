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
 *
 * Hardened 2026-10-04 (owner's security audit): every call must carry a valid
 * signature from a stored secret, signed within the last 5 minutes; a call id
 * is answered once however often it is delivered; and the spend limits in
 * services/voiceGuards.ts decide whether it is answered at all.
 */
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import { notifications, voiceAgents, voiceCalls } from "../drizzle/schema";
import { getDb } from "./db";
import { tryDecryptSecret } from "./_core/crypto";
import { activeOwnerOrNull, workspaceNotifyUserId } from "./_core/activeMembers";
import { answerInboundCall } from "./services/voiceBridge";
import { matchCallerToRecord } from "./services/voiceCrmLink";
import { admitInboundCall, hangupXaiCall, workspaceXaiKey } from "./services/voiceGuards";

/** svix's tolerance: a signed timestamp older or newer than this is a replay. */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;
/** A real realtime.call.incoming is well under 1 KB. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

type SipHeader = { name?: string; value?: string };

function sipHeader(headers: SipHeader[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/**
 * svix signature check. Secret may be raw or `whsec_<base64>`. The timestamp
 * is part of what is signed, so checking its age is what stops a captured
 * request being replayed later.
 */
export function verifySvixSignature(
  secret: string,
  msgId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string,
  nowMs = Date.now(),
): boolean {
  try {
    if (!secret || !msgId || !signatureHeader || !/^\d{1,12}$/.test(timestamp)) return false;
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) return false;
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
      const rawBody = ((req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body))).toString("utf8");
      // Every candidate secret is tried against the body; keep that cheap.
      if (rawBody.length > MAX_WEBHOOK_BYTES) {
        res.status(413).json({ ok: false });
        return;
      }

      // Candidate agents: active call-back receptionists with a webhook secret.
      const candidates = await db
        .select()
        .from(voiceAgents)
        .where(and(eq(voiceAgents.status, "active"), isNotNull(voiceAgents.sipWebhookSecretEnc)));

      // Verify the signature; the secret that verifies identifies the agent.
      const msgId = String(req.headers["webhook-id"] ?? "");
      const ts = String(req.headers["webhook-timestamp"] ?? "");
      const sigHeader = String(req.headers["webhook-signature"] ?? "");

      /**
       * The secret that verifies identifies the agent. There is deliberately
       * no other way in: until 2026-10-04 an agent saved WITHOUT a secret was
       * matched on the unsigned `To` header, so anyone who knew the number
       * could post a forged call, log it against a real contact (the From
       * header is matched to the CRM), notify the owner, and make Velocity
       * open an xAI session on the workspace's key for a call id of their
       * choosing. An agent with no secret now answers nothing.
       */
      const agent =
        candidates.find((a) => {
          const secret = tryDecryptSecret(a.sipWebhookSecretEnc);
          return !!secret && verifySvixSignature(secret, msgId, ts, rawBody, sigHeader);
        }) ?? null;

      if (!agent) {
        res.status(401).json({ ok: false, error: "no agent verified for this call" });
        return;
      }

      // xAI retries a delivery it thinks failed; a call is answered once.
      const callId = body.data.call_id.slice(0, 128);
      const [seen] = await db
        .select({ id: voiceCalls.id })
        .from(voiceCalls)
        .where(and(eq(voiceCalls.workspaceId, agent.workspaceId), eq(voiceCalls.xaiCallId, callId)))
        .limit(1);
      if (seen) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // Best-effort caller → CRM record match (contact > lead > prospect).
      const match = await matchCallerToRecord(agent.workspaceId, from).catch(() => null);

      /**
       * Who this call belongs to, and who hears about it.
       *
       * A voice agent outlives its owner's employment: the phone number stays
       * routed and xAI keeps posting calls to this webhook. Filed against a
       * departed rep, an inbound call-back is stamped with a user who cannot
       * sign in AND the "your voice agent answered a call" notification goes
       * nowhere — a real prospect rang back and nobody in the business knows.
       *
       * The notification falls through to the workspace resolver rather than
       * being dropped: an unattributed call still has to reach somebody.
       */
      const callOwnerUserId = await activeOwnerOrNull(agent.workspaceId, agent.ownerUserId);
      const callNotifyUserId = callOwnerUserId ?? (await workspaceNotifyUserId(agent.workspaceId));

      // Spend limits (concurrent calls, calls per number per hour, minutes
      // per day): every answered minute is billed to the workspace's key.
      const admission = await admitInboundCall(agent.workspaceId, from);

      const insert = await db.insert(voiceCalls).values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        direction: "inbound",
        fromNumber: from?.slice(0, 32) ?? null,
        toNumber: (to ?? agent.phoneNumber)?.slice(0, 32) ?? null,
        xaiCallId: callId,
        status: admission.ok ? "ringing" : "failed",
        outcome: admission.ok ? null : admission.reason,
        relatedType: match?.relatedType ?? null,
        relatedId: match?.relatedId ?? null,
        userId: callOwnerUserId,
        startedAt: new Date(),
        ...(admission.ok ? {} : { endedAt: new Date(), durationSec: 0 }),
      });
      const callRowId = Number((insert as unknown as { insertId?: number })?.insertId ?? 0);

      if (admission.ok) {
        // Answer the call: fire-and-forget so this handler ACKs xAI fast.
        answerInboundCall({
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          callRowId: callRowId,
          xaiCallId: body.data.call_id,
        });
      } else {
        // Not answered: end it in xAI so the caller is not left ringing.
        void workspaceXaiKey(agent.workspaceId).then((key) => hangupXaiCall(key, body.data!.call_id!));
      }

      // Notify the member the agent answers for. kind stays inside the
      // notifications enum ("system") — do NOT invent a new enum value here.
      // A number ringing over and over is not worth a notification each time.
      if (callNotifyUserId && (admission.ok || admission.code !== "repeat_caller")) {
        await db.insert(notifications).values({
          workspaceId: agent.workspaceId,
          userId: callNotifyUserId,
          kind: "system",
          title: `Call-back${match ? ` from ${match.name}` : from ? ` from ${from}` : ""}${admission.ok ? "" : " (not answered)"}`,
          body: admission.ok
            ? `Your voice agent "${agent.name}" answered an inbound call${match ? ` from ${match.name} (${match.relatedType})` : ""}.`
            : `Your voice agent "${agent.name}" did not answer an inbound call${match ? ` from ${match.name} (${match.relatedType})` : ""}. ${admission.reason}`,
          relatedType: "voice_call",
          relatedId: callRowId || null,
        });
      }

      res.status(200).json({ ok: true, answered: admission.ok });
    } catch (e) {
      console.error("[VoiceWebhook] failed:", e);
      res.status(500).json({ ok: false });
    }
  });
}
