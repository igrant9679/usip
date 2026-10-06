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
import { recordAudit } from "../audit";
import { assignNumber, ensureApplication, getAccount, listNumbers, plivoCreds } from "../services/plivo";

export const XAI_API_BASE = "https://api.x.ai/v1";
// Pinned by name (owner 2026-10-04: "Go with Think Fast 2.0"). grok-voice-latest
// is an alias for it today, but xAI can move an alias; a pinned name cannot.
export const DEFAULT_VOICE_MODEL = "grok-voice-think-fast-2.0";
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

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
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
  /** Questions an outreach agent works into the call, one at a time (2026-10-06). */
  discoveryQuestions: z.array(z.string().max(200)).max(8).optional(),
});

const cleanQuestions = (qs: string[] | undefined) => (qs ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 8);

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

  /* ── Plivo telephony (owner 2026-10-04) ──────────────────────────────── */

  plivoStatus: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [row] = await db
      .select({ authId: workspaceSettings.plivoAuthId, enc: workspaceSettings.plivoAuthTokenEnc, appId: workspaceSettings.plivoAppId, aiCallsPausedAt: workspaceSettings.aiCallsPausedAt })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    const token = tryDecryptSecret(row?.enc);
    return {
      configured: !!row?.authId && !!token,
      authId: row?.authId ?? null,
      tokenMasked: maskSecret(token),
      appConnected: !!row?.appId,
      aiCallsPausedAt: row?.aiCallsPausedAt ?? null,
    };
  }),

  /**
   * AI calls' own switch (owner ask 2026-10-05): while paused, approved calls
   * wait instead of dialing. Calls to an agent's number are still answered.
   * Separate from Pause all outbound, which holds automated email.
   */
  setAiCallsPaused: adminWsProcedure
    .input(z.object({ paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const existing = await db.select({ w: workspaceSettings.workspaceId }).from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
      if (!existing.length) await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id });
      await db.update(workspaceSettings).set({ aiCallsPausedAt: input.paused ? new Date() : null })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "ai_calls_switch", entityId: null, after: { paused: input.paused } });
      return { ok: true, paused: input.paused };
    }),

  savePlivo: adminWsProcedure
    .input(z.object({ authId: z.string().max(64).optional(), authToken: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const existing = await db.select({ workspaceId: workspaceSettings.workspaceId }).from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
      if (existing.length === 0) await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id });
      const updates: Record<string, string | null> = {};
      if (input.authId !== undefined) {
        const id = input.authId.trim();
        if (id && !/^[A-Za-z0-9]{8,64}$/.test(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "That does not look like a Plivo Auth ID." });
        updates.plivoAuthId = id || null;
        // A different account: the application belongs to the old one.
        updates.plivoAppId = null;
      }
      if (input.authToken !== undefined) updates.plivoAuthTokenEnc = input.authToken.trim() ? encryptSecret(input.authToken.trim()) : null;
      if (Object.keys(updates).length) {
        await db.update(workspaceSettings).set(updates).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "plivo_connection", entityId: null, after: { authId: input.authId !== undefined, authToken: input.authToken !== undefined ? "changed" : "unchanged" } });
      return { ok: true };
    }),

  testPlivo: adminWsProcedure.mutation(async ({ ctx }) => {
    const creds = await plivoCreds(ctx.workspace.id);
    if (!creds) throw new TRPCError({ code: "BAD_REQUEST", message: "Add the Plivo Auth ID and Auth Token first." });
    try {
      const acct = await getAccount(creds);
      const numbers = await listNumbers(creds);
      return { ok: true, accountName: acct.name ?? null, credits: acct.cash_credits ?? null, numbers: numbers.length };
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
    }
  }),

  plivoNumbers: adminWsProcedure.query(async ({ ctx }) => {
    const creds = await plivoCreds(ctx.workspace.id);
    if (!creds) return [];
    try {
      return (await listNumbers(creds)).filter((n) => n.voiceEnabled);
    } catch {
      return [];
    }
  }),

  /**
   * Give an agent a Plivo number: Velocity creates (or updates) the
   * workspace's Plivo application, points the number at it, and records the
   * number on the agent. Calls to it are answered by this agent; approved AI
   * calls are placed from it. null takes the number off the agent.
   */
  connectPlivoNumber: adminWsProcedure
    .input(z.object({ agentId: z.number().int(), number: z.string().max(32).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const [agent] = await db.select().from(voiceAgents)
        .where(and(eq(voiceAgents.id, input.agentId), eq(voiceAgents.workspaceId, ctx.workspace.id))).limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.number === null) {
        await db.update(voiceAgents).set({ plivoNumber: null }).where(eq(voiceAgents.id, agent.id));
        return { ok: true, number: null };
      }
      const creds = await plivoCreds(ctx.workspace.id);
      if (!creds) throw new TRPCError({ code: "BAD_REQUEST", message: "Connect Plivo first." });
      const want = input.number.replace(/\D/g, "");
      try {
        const owned = (await listNumbers(creds)).find((n) => n.number.replace(/\D/g, "") === want);
        if (!owned) throw new TRPCError({ code: "BAD_REQUEST", message: "That number is not on this Plivo account." });
        const [s] = await db.select({ appId: workspaceSettings.plivoAppId }).from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
        const appId = await ensureApplication(ctx.workspace.id, creds, s?.appId ?? null);
        if (appId !== s?.appId) {
          await db.update(workspaceSettings).set({ plivoAppId: appId }).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
        }
        await assignNumber(creds, owned.number, appId);
        // One agent per number: it would otherwise be unclear who answers.
        await db.update(voiceAgents).set({ plivoNumber: null })
          .where(and(eq(voiceAgents.workspaceId, ctx.workspace.id), eq(voiceAgents.plivoNumber, owned.number)));
        await db.update(voiceAgents).set({ plivoNumber: owned.number }).where(eq(voiceAgents.id, agent.id));
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "voice_agent", entityId: agent.id, after: { plivoNumber: owned.number } });
        return { ok: true, number: owned.number };
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
      }
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
      discoveryQuestions: cleanQuestions(input.discoveryQuestions),
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
      if (input.discoveryQuestions !== undefined) patch.discoveryQuestions = cleanQuestions(input.discoveryQuestions);
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
