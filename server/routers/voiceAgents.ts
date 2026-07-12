/**
 * voiceAgents.ts — Grok (xAI) voice agents for automated phone outreach and
 * team-member call-backs.
 *
 * Vendor surface (docs.x.ai → model-capabilities/audio/voice-agent):
 *   - Auth: `Authorization: Bearer <XAI_API_KEY>` (workspace BYOK, AES-GCM
 *     encrypted in workspace_settings.xaiApiKeyEnc — same pattern as the
 *     Anthropic/OpenAI/Gemini keys in aiCredentials.ts).
 *   - Voices list: GET https://api.x.ai/v1/tts/voices — doubles as the live
 *     key-verification ping (no audio is billed).
 *   - Realtime WS: wss://api.x.ai/v1/realtime?model=… (control plane; the SIP
 *     leg carries the audio for phone calls).
 *   - Inbound SIP call-backs: xAI POSTs `realtime.call.incoming` to our
 *     webhook (server/voiceWebhook.ts) with a call_id; answering means opening
 *     the WS with that call_id and sending session.update + response.create —
 *     that answer-bridge is the next build unit (needs a ws client dep).
 *
 * Permissions: admins manage everything. A non-admin member may create/edit/
 * delete ONLY their own callback_receptionist agent (ownerUserId = self) —
 * "team members receive call backs; the agent answers on their behalf".
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { users, voiceAgents, voiceCalls, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { encryptSecret, maskSecret, tryDecryptSecret } from "../_core/crypto";
import { roleRank } from "../_core/workspace";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";

export const XAI_API_BASE = "https://api.x.ai/v1";
export const DEFAULT_VOICE_MODEL = "grok-voice-latest";
/** Documented built-in voices — fallback when no key is configured yet. */
const BUILTIN_VOICES = ["eve", "ara", "rex", "sal", "leo"];

async function getXaiKey(workspaceId: number): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({ enc: workspaceSettings.xaiApiKeyEnc })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return tryDecryptSecret(row?.enc);
}

function isAdmin(role: string): boolean {
  return roleRank(role as never) >= roleRank("admin");
}

const agentInput = z.object({
  name: z.string().min(1).max(120),
  purpose: z.enum(["outbound_outreach", "callback_receptionist"]),
  ownerUserId: z.number().int().nullable().optional(),
  voice: z.string().min(1).max(40).default("eve"),
  model: z.string().min(1).max(64).default(DEFAULT_VOICE_MODEL),
  instructions: z.string().max(8000).nullable().optional(),
  phoneNumber: z.string().max(32).nullable().optional(),
  /** Webhook signing secret from the xAI console number registration (shown once there). */
  sipWebhookSecret: z.string().max(200).nullable().optional(),
  languageHint: z.string().max(16).nullable().optional(),
  status: z.enum(["active", "paused"]).default("active"),
});

/** Non-admins may only manage their own callback agent. Throws otherwise. */
function assertCanManage(role: string, userId: number, agent: { purpose: string; ownerUserId: number | null }) {
  if (isAdmin(role)) return;
  if (agent.purpose === "callback_receptionist" && agent.ownerUserId === userId) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only admins can manage this agent (members may manage their own call-back agent).",
  });
}

export const voiceAgentsRouter = router({
  /* ── workspace xAI credential ─────────────────────────────────────────── */

  getSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const [row] = await db
      .select({ enc: workspaceSettings.xaiApiKeyEnc, model: workspaceSettings.xaiVoiceModel })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    const key = tryDecryptSecret(row?.enc);
    return {
      configured: key.length > 0,
      masked: maskSecret(key),
      model: row?.model ?? DEFAULT_VOICE_MODEL,
    };
  }),

  saveSettings: adminWsProcedure
    .input(z.object({ apiKey: z.string().optional(), model: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      // ensure the settings row exists (same guard as aiCredentials)
      const existing = await db
        .select({ workspaceId: workspaceSettings.workspaceId })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      if (existing.length === 0) await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id });

      const updates: Record<string, string | null> = {};
      if (input.apiKey !== undefined) updates.xaiApiKeyEnc = input.apiKey === "" ? null : encryptSecret(input.apiKey);
      if (input.model !== undefined) updates.xaiVoiceModel = input.model === "" ? null : input.model;
      if (Object.keys(updates).length > 0) {
        await db.update(workspaceSettings).set(updates).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      }
      return { ok: true };
    }),

  /** Live key verification — GET /v1/tts/voices with the stored key. */
  testKey: adminWsProcedure.mutation(async ({ ctx }) => {
    const key = await getXaiKey(ctx.workspace.id);
    if (!key) throw new TRPCError({ code: "BAD_REQUEST", message: "No xAI API key configured" });
    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(`${XAI_API_BASE}/tts/voices`, { headers: { Authorization: `Bearer ${key}` } });
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Could not reach api.x.ai: ${e instanceof Error ? e.message : String(e)}` });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TRPCError({ code: "BAD_REQUEST", message: `xAI rejected the key (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}` });
    }
    const data: unknown = await res.json().catch(() => null);
    const voices = Array.isArray(data) ? data : Array.isArray((data as any)?.voices) ? (data as any).voices : [];
    return { ok: true, voiceCount: voices.length, latencyMs: Date.now() - start };
  }),

  /** Voice options for the agent form — live from xAI when a key exists. */
  listVoices: workspaceProcedure.query(async ({ ctx }) => {
    const key = await getXaiKey(ctx.workspace.id);
    if (key) {
      try {
        const res = await fetch(`${XAI_API_BASE}/tts/voices`, { headers: { Authorization: `Bearer ${key}` } });
        if (res.ok) {
          const data: unknown = await res.json();
          const raw = Array.isArray(data) ? data : Array.isArray((data as any)?.voices) ? (data as any).voices : [];
          const names = raw
            .map((v: any) => (typeof v === "string" ? v : v?.name ?? v?.id ?? v?.voice_id))
            .filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
          if (names.length > 0) return { voices: names, live: true };
        }
      } catch {
        /* fall through to builtin list */
      }
    }
    return { voices: BUILTIN_VOICES, live: false };
  }),

  /* ── agents CRUD ──────────────────────────────────────────────────────── */

  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const agents = await db
      .select()
      .from(voiceAgents)
      .where(eq(voiceAgents.workspaceId, ctx.workspace.id))
      .orderBy(voiceAgents.id);
    // resolve owner names for "answers on behalf of" display
    const ownerIds = [...new Set(agents.map((a) => a.ownerUserId).filter((v): v is number => v != null))];
    const owners = ownerIds.length
      ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ownerIds))
      : [];
    const ownerById = new Map(owners.map((o) => [o.id, o]));
    return agents.map((a) => ({
      ...a,
      // never expose the webhook secret; report presence only
      sipWebhookSecretEnc: undefined,
      hasWebhookSecret: !!a.sipWebhookSecretEnc,
      owner: a.ownerUserId != null ? (ownerById.get(a.ownerUserId) ?? null) : null,
      canManage:
        isAdmin(ctx.member.role) ||
        (a.purpose === "callback_receptionist" && a.ownerUserId === ctx.user.id),
    }));
  }),

  create: workspaceProcedure.input(agentInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    const ownerUserId =
      input.purpose === "callback_receptionist"
        ? (input.ownerUserId ?? ctx.user.id)
        : (input.ownerUserId ?? null);
    assertCanManage(ctx.member.role, ctx.user.id, { purpose: input.purpose, ownerUserId });
    const r = await db.insert(voiceAgents).values({
      workspaceId: ctx.workspace.id,
      ownerUserId,
      name: input.name.trim(),
      purpose: input.purpose,
      voice: input.voice.trim(),
      model: input.model.trim(),
      instructions: input.instructions?.trim() || null,
      phoneNumber: input.phoneNumber?.trim() || null,
      sipWebhookSecretEnc: input.sipWebhookSecret ? encryptSecret(input.sipWebhookSecret) : null,
      languageHint: input.languageHint?.trim() || null,
      status: input.status,
    });
    return { id: Number((r as unknown as { insertId?: number })?.insertId ?? 0) };
  }),

  update: workspaceProcedure
    .input(agentInput.partial().extend({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      const [agent] = await db
        .select()
        .from(voiceAgents)
        .where(and(eq(voiceAgents.id, input.id), eq(voiceAgents.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      assertCanManage(ctx.member.role, ctx.user.id, agent);
      // a member cannot re-purpose their callback agent into a workspace outreach agent
      if (!isAdmin(ctx.member.role) && input.purpose === "outbound_outreach") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can configure outreach agents" });
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.purpose !== undefined) patch.purpose = input.purpose;
      if (input.ownerUserId !== undefined) {
        const effectivePurpose = input.purpose ?? agent.purpose;
        // A callback agent always has an owner — null from the picker means "me".
        patch.ownerUserId = !isAdmin(ctx.member.role)
          ? agent.ownerUserId
          : effectivePurpose === "callback_receptionist"
            ? (input.ownerUserId ?? ctx.user.id)
            : input.ownerUserId;
      }
      if (input.voice !== undefined) patch.voice = input.voice.trim();
      if (input.model !== undefined) patch.model = input.model.trim();
      if (input.instructions !== undefined) patch.instructions = input.instructions?.trim() || null;
      if (input.phoneNumber !== undefined) patch.phoneNumber = input.phoneNumber?.trim() || null;
      if (input.sipWebhookSecret !== undefined) {
        patch.sipWebhookSecretEnc = input.sipWebhookSecret ? encryptSecret(input.sipWebhookSecret) : null;
      }
      if (input.languageHint !== undefined) patch.languageHint = input.languageHint?.trim() || null;
      if (input.status !== undefined) patch.status = input.status;
      if (Object.keys(patch).length > 0) {
        await db.update(voiceAgents).set(patch).where(eq(voiceAgents.id, agent.id));
      }
      return { ok: true };
    }),

  remove: workspaceProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    const [agent] = await db
      .select()
      .from(voiceAgents)
      .where(and(eq(voiceAgents.id, input.id), eq(voiceAgents.workspaceId, ctx.workspace.id)))
      .limit(1);
    if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
    assertCanManage(ctx.member.role, ctx.user.id, agent);
    await db.delete(voiceAgents).where(eq(voiceAgents.id, agent.id));
    return { ok: true };
  }),

  /* ── call log ─────────────────────────────────────────────────────────── */

  listCalls: workspaceProcedure
    .input(z.object({ agentId: z.number().int().optional(), limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const where = input?.agentId
        ? and(eq(voiceCalls.workspaceId, ctx.workspace.id), eq(voiceCalls.agentId, input.agentId))
        : eq(voiceCalls.workspaceId, ctx.workspace.id);
      const rows = await db
        .select()
        .from(voiceCalls)
        .where(where)
        .orderBy(desc(voiceCalls.createdAt))
        .limit(input?.limit ?? 50);
      const agentIds = [...new Set(rows.map((r) => r.agentId))];
      const agents = agentIds.length
        ? await db
            .select({ id: voiceAgents.id, name: voiceAgents.name })
            .from(voiceAgents)
            .where(and(eq(voiceAgents.workspaceId, ctx.workspace.id), inArray(voiceAgents.id, agentIds)))
        : [];
      const agentById = new Map(agents.map((a) => [a.id, a.name]));
      return rows.map((r) => ({ ...r, agentName: agentById.get(r.agentId) ?? `Agent #${r.agentId}` }));
    }),
});
