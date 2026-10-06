/**
 * plivoWebhook.ts — Plivo's callbacks and the call-audio socket.
 *
 *   POST /api/voice/plivo/answer?ws=N[&call=R]  a call connected: answer with
 *        <Stream> to Velocity's relay. With `call` it is an approved outbound
 *        call the dialer placed; without, someone rang an agent's number.
 *   POST /api/voice/plivo/hangup?ws=N[&call=R]  the call ended: final status,
 *        duration, voicemail; closes the request.
 *   WS   /api/voice/plivo/stream?c=R&t=TOKEN    the audio, relayed to xAI.
 *
 * Every callback must carry a valid X-Plivo-Signature-V3 for the
 * workspace's Auth Token over the exact URL Plivo called, with a nonce not
 * seen before. The audio socket needs the short-lived token minted in the
 * signed answer (services/plivo.ts says why).
 */
import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { WebSocketServer } from "ws";
import { and, eq, inArray } from "drizzle-orm";
import { voiceAgents, voiceCalls } from "../drizzle/schema";
import { getDb } from "./db";
import { appBaseUrl } from "./appUrl";
import { activeOwnerOrNull } from "./_core/activeMembers";
import { checkStreamToken, hangupXml, nonceIsFresh, plivoCreds, streamXml, verifyV3 } from "./services/plivo";
import { toE164 } from "@shared/phoneFormat";
import { admitInboundCall } from "./services/voiceGuards";
import { matchCallerToRecord } from "./services/voiceCrmLink";
import { finishRequestForCall, startRelay } from "./services/voiceRelay";
import { agentNumberMatching } from "@shared/voiceCapacity";

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

function sendXml(res: Response, xml: string): void {
  res.status(200).type("application/xml").send(xml);
}

/** The workspace whose Plivo account signed this request, or null (and the response is sent). */
async function verified(req: Request, res: Response): Promise<number | null> {
  const ws = Number(req.query.ws);
  if (!Number.isInteger(ws) || ws <= 0) { res.status(400).end(); return null; }
  const creds = await plivoCreds(ws);
  if (!creds) { res.status(403).end(); return null; }
  const nonce = String(req.headers["x-plivo-signature-v3-nonce"] ?? "");
  const sig = String(req.headers["x-plivo-signature-v3"] ?? "");
  const params = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const url = `${appBaseUrl()}${req.originalUrl}`;
  if (!verifyV3(url, params, nonce, sig, creds.authToken) || !nonceIsFresh(nonce)) {
    res.status(401).end();
    return null;
  }
  return ws;
}

export function registerPlivoWebhookRoutes(app: Express): void {
  app.post("/api/voice/plivo/answer", async (req: Request, res: Response) => {
    try {
      const ws = await verified(req, res);
      if (ws == null) return;
      const db = await getDb();
      if (!db) { sendXml(res, hangupXml()); return; }
      const b = req.body as Record<string, string>;
      const callUuid = String(b.CallUUID ?? "").slice(0, 64);

      // An approved outbound call the dialer placed.
      if (req.query.call) {
        const rowId = Number(req.query.call);
        const [row] = await db.select({ id: voiceCalls.id, status: voiceCalls.status }).from(voiceCalls)
          .where(and(eq(voiceCalls.id, rowId), eq(voiceCalls.workspaceId, ws), eq(voiceCalls.direction, "outbound"), eq(voiceCalls.provider, "plivo"))).limit(1);
        if (!row || !["queued", "ringing", "in_progress"].includes(row.status)) { sendXml(res, hangupXml()); return; }
        await db.update(voiceCalls).set({ plivoCallUuid: callUuid || null, status: "ringing" })
          .where(and(eq(voiceCalls.id, rowId), inArray(voiceCalls.status, ["queued", "ringing"])));
        sendXml(res, streamXml(rowId));
        return;
      }

      // Someone rang an agent's Plivo number.
      const to = digits(b.To);
      // Stored as +E.164 (Plivo sends "15714798700"); shown with formatPhone.
      const from = toE164(String(b.From ?? ""))?.slice(0, 32) ?? null;
      const agents = await db.select().from(voiceAgents).where(and(eq(voiceAgents.workspaceId, ws), eq(voiceAgents.status, "active")));
      // Any of the agent's numbers (several per agent since 2026-10-06).
      const agent = agents.find((a) => agentNumberMatching(a, to)) ?? null;
      if (!agent) { sendXml(res, hangupXml()); return; }

      // Plivo retries an answer it thinks failed: one row per call.
      if (callUuid) {
        const [seen] = await db.select({ id: voiceCalls.id }).from(voiceCalls)
          .where(and(eq(voiceCalls.workspaceId, ws), eq(voiceCalls.plivoCallUuid, callUuid))).limit(1);
        if (seen) { sendXml(res, streamXml(seen.id)); return; }
      }

      const admission = await admitInboundCall(ws, from);
      const match = await matchCallerToRecord(ws, from).catch(() => null);
      const userId = await activeOwnerOrNull(ws, agent.ownerUserId);
      const ins = await db.insert(voiceCalls).values({
        workspaceId: ws,
        agentId: agent.id,
        direction: "inbound",
        provider: "plivo",
        plivoCallUuid: callUuid || null,
        fromNumber: from,
        toNumber: agentNumberMatching(agent, to) ?? agent.plivoNumber,
        status: admission.ok ? "ringing" : "failed",
        outcome: admission.ok ? null : admission.reason,
        relatedType: match?.relatedType ?? null,
        relatedId: match?.relatedId ?? null,
        userId,
        startedAt: new Date(),
        ...(admission.ok ? {} : { endedAt: new Date(), durationSec: 0 }),
      });
      const rowId = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);
      sendXml(res, admission.ok && rowId ? streamXml(rowId) : hangupXml());
    } catch (e) {
      console.error("[PlivoWebhook] answer failed:", e);
      if (!res.headersSent) sendXml(res, hangupXml());
    }
  });

  app.post("/api/voice/plivo/hangup", async (req: Request, res: Response) => {
    try {
      const ws = await verified(req, res);
      if (ws == null) return;
      const db = await getDb();
      if (!db) { res.status(200).end(); return; }
      const b = req.body as Record<string, string>;
      const callUuid = String(b.CallUUID ?? "").slice(0, 64);
      const where = req.query.call
        ? and(eq(voiceCalls.id, Number(req.query.call)), eq(voiceCalls.workspaceId, ws))
        : callUuid ? and(eq(voiceCalls.plivoCallUuid, callUuid), eq(voiceCalls.workspaceId, ws)) : null;
      if (!where) { res.status(200).end(); return; }
      const [row] = await db.select().from(voiceCalls).where(where).limit(1);
      if (!row) { res.status(200).end(); return; }

      const status = hangupStatus(b, row.status);
      const dur = Number(b.Duration ?? b.BillDuration);
      await db.update(voiceCalls).set({
        status,
        ...(callUuid && !row.plivoCallUuid ? { plivoCallUuid: callUuid } : {}),
        ...(Number.isFinite(dur) && dur >= 0 ? { durationSec: Math.round(dur) } : {}),
        endedAt: row.endedAt ?? new Date(),
        ...(status === "voicemail" && !row.result ? { result: null } : {}),
      }).where(eq(voiceCalls.id, row.id));
      await finishRequestForCall(row.id);
      res.status(200).end();
    } catch (e) {
      console.error("[PlivoWebhook] hangup failed:", e);
      if (!res.headersSent) res.status(200).end();
    }
  });
}

/**
 * The final status from Plivo's hangup parameters. Voicemail wins (Plivo hung
 * up on a machine); a call the relay already finished keeps "completed";
 * otherwise Plivo's CallStatus decides.
 */
export function hangupStatus(b: Record<string, string>, current: string): "completed" | "failed" | "no_answer" | "voicemail" | "busy" | "canceled" {
  if (String(b.Machine ?? "").toLowerCase() === "true") return "voicemail";
  const s = String(b.CallStatus ?? "").toLowerCase();
  if (current === "completed") return "completed";
  if (s === "busy") return "busy";
  if (s === "no-answer" || s === "timeout") return "no_answer";
  if (s === "failed") return "failed";
  if (s === "cancel" || s === "canceled" || s === "cancelled") return "canceled";
  if (current === "in_progress") return "completed";
  // Completed but never streamed: it rang out or was rejected.
  return s === "completed" && Number(b.Duration ?? b.BillDuration ?? 0) > 0 ? "completed" : "no_answer";
}

/** Rows with a relay running in this process: a token opens one relay, once. */
const relaying = new Set<number>();

export function attachPlivoStream(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://local"); } catch { return; }
    if (url.pathname !== "/api/voice/plivo/stream") return; // not ours (e.g. Vite HMR)
    const rowId = Number(url.searchParams.get("c"));
    const token = url.searchParams.get("t") ?? "";
    void (async () => {
      const ok = Number.isInteger(rowId) && rowId > 0 && checkStreamToken(rowId, token) && !relaying.has(rowId);
      const db = ok ? await getDb() : null;
      const [row] = db ? await db.select({ status: voiceCalls.status }).from(voiceCalls).where(eq(voiceCalls.id, rowId)).limit(1) : [];
      if (!ok || !row || !["queued", "ringing"].includes(row.status)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      relaying.add(rowId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("close", () => relaying.delete(rowId));
        void startRelay(ws, rowId);
      });
    })().catch(() => { try { socket.destroy(); } catch { /* noop */ } });
  });
}

/** How many calls this process is relaying right now (deploy check). */
export function liveRelayCount(): number {
  return relaying.size;
}
