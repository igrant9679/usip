/**
 * voiceBridge.ts — answers inbound xAI SIP calls with the configured agent.
 *
 * The audio flows over the SIP leg entirely inside xAI — this bridge is the
 * CONTROL PLANE only: it opens wss://api.x.ai/v1/realtime?call_id={id} with
 * the workspace's xAI key, pushes the agent's session config (voice,
 * instructions, VAD), triggers the greeting via response.create, then follows
 * events to keep the voice_calls row truthful (in_progress → completed,
 * duration, transcript digest). Uses the `ws` package because Railway runs
 * Node 20 (no global WebSocket) and the Authorization header is required.
 */
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { users, voiceAgents, voiceCalls, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { logCallActivity } from "./voiceCrmLink";

const XAI_REALTIME_WS = "wss://api.x.ai/v1/realtime";
const XAI_API_BASE = "https://api.x.ai/v1";
/** Hard safety cap — hang up runaway calls (also caps vendor spend at $0.05/min). */
const MAX_CALL_MS = 30 * 60 * 1000;

type BridgeOpts = {
  workspaceId: number;
  agentId: number;
  callRowId: number;
  xaiCallId: string;
};

async function finalizeRow(
  callRowId: number,
  patch: { status: "completed" | "failed"; outcome?: string | null; startedAtMs?: number },
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const [row] = await db.select({ startedAt: voiceCalls.startedAt }).from(voiceCalls).where(eq(voiceCalls.id, callRowId)).limit(1);
    const started = patch.startedAtMs ?? (row?.startedAt ? new Date(row.startedAt).getTime() : null);
    const ended = new Date();
    await db
      .update(voiceCalls)
      .set({
        status: patch.status,
        outcome: patch.outcome?.slice(0, 8000) ?? null,
        endedAt: ended,
        durationSec: started ? Math.max(0, Math.round((ended.getTime() - started) / 1000)) : null,
      })
      .where(eq(voiceCalls.id, callRowId));
  } catch (e) {
    console.error("[VoiceBridge] finalize failed:", e);
  }
}

function defaultInstructions(agentName: string, ownerName: string | null): string {
  const onBehalf = ownerName ? ` You answer calls on behalf of ${ownerName}, who is currently unavailable.` : "";
  return (
    `You are ${agentName}, a professional AI phone assistant.${onBehalf} ` +
    `The caller is likely returning a call about a business conversation. Greet them briefly, ` +
    `find out who is calling and what they need, offer to take a detailed message or arrange a ` +
    `time for a call back, and confirm their contact details. Be concise, warm and professional. ` +
    `Never claim to be human. If asked something you don't know, say you'll pass the question along.`
  );
}

/**
 * Answer an inbound call. Fire-and-forget from the webhook (the webhook must
 * ACK xAI quickly); all outcomes land on the voice_calls row.
 */
export function answerInboundCall(opts: BridgeOpts): void {
  void (async () => {
    const db = await getDb();
    if (!db) return;

    const [agent] = await db.select().from(voiceAgents).where(eq(voiceAgents.id, opts.agentId)).limit(1);
    if (!agent) {
      await finalizeRow(opts.callRowId, { status: "failed", outcome: "Agent no longer exists" });
      return;
    }
    const [ws] = await db
      .select({ enc: workspaceSettings.xaiApiKeyEnc, model: workspaceSettings.xaiVoiceModel })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, opts.workspaceId))
      .limit(1);
    const apiKey = tryDecryptSecret(ws?.enc);
    if (!apiKey) {
      await finalizeRow(opts.callRowId, { status: "failed", outcome: "No xAI API key configured — call not answered" });
      return;
    }
    let ownerName: string | null = null;
    if (agent.ownerUserId) {
      const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, agent.ownerUserId)).limit(1);
      ownerName = owner?.name ?? null;
    }

    const startedAtMs = Date.now();
    const transcript: string[] = [];
    let opened = false;
    let finalized = false;
    const finishOnce = async (status: "completed" | "failed", note?: string) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(capTimer);
      const digest = transcript.length ? transcript.join("\n") : null;
      await finalizeRow(opts.callRowId, {
        status,
        outcome: [note, digest].filter(Boolean).join("\n\n") || null,
        startedAtMs,
      });
      // Completed calls that matched a CRM record land on its timeline as a
      // real `call` activity (no-op when unmatched).
      if (status === "completed") {
        await logCallActivity(opts.callRowId, agent.name).catch((e) =>
          console.error("[VoiceBridge] activity log failed:", e),
        );
      }
    };

    const sock = new WebSocket(`${XAI_REALTIME_WS}?call_id=${encodeURIComponent(opts.xaiCallId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const capTimer = setTimeout(() => {
      // REST hangup is authoritative; closing the WS alone doesn't end the call.
      void fetch(`${XAI_API_BASE}/realtime/calls/${encodeURIComponent(opts.xaiCallId)}/hangup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      }).catch(() => {});
      try { sock.close(); } catch { /* noop */ }
      void finishOnce("completed", "Call ended by 30-minute safety cap.");
    }, MAX_CALL_MS);

    sock.on("open", () => {
      opened = true;
      const session: Record<string, unknown> = {
        voice: agent.voice || "eve",
        instructions: agent.instructions?.trim() || defaultInstructions(agent.name, ownerName),
        turn_detection: { type: "server_vad" },
      };
      if (agent.languageHint) {
        session.audio = { input: { transcription: { language_hint: agent.languageHint } } };
      }
      sock.send(JSON.stringify({ type: "session.update", session }));
      // Trigger the greeting — the agent speaks first on a call-back.
      sock.send(JSON.stringify({ type: "response.create" }));
    });

    sock.on("message", (buf: WebSocket.RawData) => {
      try {
        const evt = JSON.parse(buf.toString());
        if (evt?.type === "session.created") {
          void (async () => {
            const dbi = await getDb();
            await dbi?.update(voiceCalls).set({ status: "in_progress" }).where(eq(voiceCalls.id, opts.callRowId));
          })();
        }
        // Best-effort transcript: item texts + audio transcripts.
        if (evt?.type === "conversation.item.created" && evt.item?.content) {
          const role = evt.item.role ?? "unknown";
          for (const c of evt.item.content) {
            const text = c?.text ?? c?.transcript;
            if (typeof text === "string" && text.trim()) transcript.push(`${role}: ${text.trim()}`);
          }
        }
        if (evt?.type === "response.output_audio_transcript.done" && typeof evt.transcript === "string") {
          transcript.push(`assistant: ${evt.transcript.trim()}`);
        }
        if (evt?.type === "error") {
          console.error("[VoiceBridge] xAI event error:", JSON.stringify(evt).slice(0, 500));
        }
      } catch {
        /* non-JSON frame — ignore */
      }
    });

    sock.on("close", () => {
      void finishOnce(opened ? "completed" : "failed", opened ? undefined : "WebSocket closed before the session was established");
    });
    sock.on("error", (err: Error) => {
      console.error("[VoiceBridge] WS error:", err.message);
      void finishOnce(opened ? "completed" : "failed", `Bridge error: ${err.message}`);
    });
  })().catch(async (e) => {
    console.error("[VoiceBridge] fatal:", e);
    await finalizeRow(opts.callRowId, { status: "failed", outcome: `Bridge crashed: ${e instanceof Error ? e.message : String(e)}` });
  });
}
