/**
 * A partial update leaves alone what it does not name (audit N4, N5).
 *
 * In Zod 4, `.partial()` keeps a field's `.default()`: parsing `{ id }` against
 * `z.object({ status: z.enum([...]).default("active") }).partial()` still yields
 * `status: "active"`. Every update schema built as `createSchema.partial()` on a
 * schema with defaults therefore rewrote those fields on every save:
 *
 *   - voice agents: saving a paused agent's form switched it back on, and the
 *     Active switch reset its voice and model (N4);
 *   - custom fields: a patch that left out Required, Show in list or Sort order
 *     reset them (N5);
 *   - personas: linking or unlinking a sector emptied titles, industries,
 *     places and keywords (same flaw, found by the N4 sweep);
 *   - sender pools: a rename turned a weighted pool round-robin (same sweep).
 *
 * Also here: voiceAgents.create returned id 0, because it read insertId off
 * mysql2's [ResultSetHeader, fields] array instead of its first element.
 *
 * Everything runs the real procedures against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { PRESET_PERSONAS } from "./routers/personas";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
});

describe("voice agents (N4)", () => {
  const agent = (o: Record<string, unknown> = {}) => {
    rows("voice_agents").push({
      id: 5, workspaceId: WS, ownerUserId: null, name: "Outreach", purpose: "outbound_outreach",
      voice: "rex", model: "grok-custom-model", instructions: null, phoneNumber: null,
      sipWebhookSecretEnc: null, languageHint: null, status: "paused", discoveryQuestions: [], ...o,
    });
    return 5;
  };

  it("saving a paused agent's form, which sends no status, leaves it paused", async () => {
    const id = agent();
    // The edit form's payload: everything but status.
    await caller().voiceAgents.update({
      id, name: "Outreach 2", purpose: "outbound_outreach", ownerUserId: null, voice: "rex", model: "grok-custom-model",
      instructions: null, phoneNumber: null, languageHint: null, discoveryQuestions: [],
    });
    expect(row("voice_agents", id)).toMatchObject({ name: "Outreach 2", status: "paused" });
  });

  it("the Active switch, which sends only status, leaves voice and model as they were", async () => {
    const id = agent();
    await caller().voiceAgents.update({ id, status: "active" });
    expect(row("voice_agents", id)).toMatchObject({ status: "active", voice: "rex", model: "grok-custom-model" });
  });

  it("create still fills in voice, model and status when they are left out", async () => {
    await caller().voiceAgents.create({ name: "New", purpose: "outbound_outreach", ownerUserId: null });
    const created = rows("voice_agents").find((r) => r.name === "New");
    expect(created.status).toBe("active");
    expect(created.voice).toBe("eve");
    expect(typeof created.model).toBe("string");
    expect(created.model.length).toBeGreaterThan(0);
  });

  it("create returns the new agent's id, which the form needs to save its Plivo numbers", async () => {
    agent();
    const out = await caller().voiceAgents.create({ name: "New", purpose: "outbound_outreach", ownerUserId: null });
    const created = rows("voice_agents").find((r) => r.name === "New");
    expect(created.id).toBeGreaterThan(0);
    expect(out.id).toBe(created.id);
  });
});

describe("custom fields (N5)", () => {
  it("a patch that names only the label leaves Required, Show in list and Sort order as they were", async () => {
    rows("custom_field_defs").push({
      id: 3, workspaceId: WS, entityType: "lead", fieldKey: "budget_band", label: "Budget", fieldType: "text",
      options: null, required: true, showInList: true, sortOrder: 7,
    });
    await caller().customFields.updateDef({ id: 3, patch: { label: "Budget band" } });
    expect(row("custom_field_defs", 3)).toMatchObject({ label: "Budget band", required: true, showInList: true, sortOrder: 7 });
  });

  it("create still defaults them", async () => {
    await caller().customFields.createDef({ entityType: "lead", fieldKey: "tier_name", label: "Tier", fieldType: "text" });
    expect(rows("custom_field_defs").find((r) => r.fieldKey === "tier_name")).toMatchObject({ required: false, showInList: false, sortOrder: 0 });
  });
});

describe("personas (same flaw)", () => {
  const persona = () => {
    rows("personas").push({
      id: 4, workspaceId: WS, name: "CFOs", description: null,
      targetTitles: ["CFO"], targetIndustries: ["SaaS"], targetGeographies: ["US"], keywords: ["finance"],
      employeeMin: null, employeeMax: null, sectorId: 8, categoryId: null,
    });
    return 4;
  };

  it("unlinking a persona from its sector keeps its targeting", async () => {
    const id = persona();
    await caller().personas.update({ id, sectorId: null });
    expect(row("personas", id)).toMatchObject({
      sectorId: null, targetTitles: ["CFO"], targetIndustries: ["SaaS"], targetGeographies: ["US"], keywords: ["finance"],
    });
  });

  it("a preset's overrides replace only what they name", async () => {
    const preset = PRESET_PERSONAS.find((p) => p.key === "saas_revops")!;
    await caller().personas.createFromPreset({ presetKey: preset.key, overrides: { name: "My RevOps" } });
    expect(rows("personas").find((r) => r.name === "My RevOps")).toMatchObject({
      targetTitles: preset.targetTitles, targetIndustries: preset.targetIndustries,
      targetGeographies: preset.targetGeographies, keywords: preset.keywords,
    });
  });
});

describe("sender pools (same flaw)", () => {
  it("renaming a weighted pool keeps it weighted", async () => {
    rows("sender_pools").push({ id: 6, workspaceId: WS, name: "Pool", description: null, rotationStrategy: "weighted" });
    await caller().senderPools.update({ id: 6, name: "Pool B" });
    expect(row("sender_pools", 6)).toMatchObject({ name: "Pool B", rotationStrategy: "weighted" });
  });
});
