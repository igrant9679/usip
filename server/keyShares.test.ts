/**
 * An admin lends a workspace's keys to other workspaces (owner ask 2026-11-13:
 * "give admins (only Admins) the ability to share API keys and tokens (for the
 * LLMs and various 3rd party helper tools and sources) with other Spaces").
 *
 * A live link, not a copy: the borrower reads the lender's own key at call
 * time (services/keyShares). What these pin:
 *   - the order: own key, then a lent one; a lent key is never passed on
 *   - live: a rotated key is the new key at once, a cleared one is no key
 *   - only an admin of BOTH workspaces, holding manage_api_keys, can lend
 *   - the borrower is told who lends it and is never shown the key or its tail
 *   - every server file that reads a shareable key column resolves through
 *     the link, or is listed here with why it does not
 *
 * Through the real procedures against the SQL-evaluating fake with a real
 * member table, so each caller's role is the one on their row.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  delete process.env.REOON_API_KEY;
  delete process.env.QUICKENRICH_API_KEY;
  return { db: null as any };
});
// checkPermission reads member_permissions through ./db's own getDb, which a
// mock of the export cannot reach; this stands in for it over the same rows
// (an explicit deny row refuses even an admin, as the real one does).
const denied = (ctx: any, feature: string) =>
  (h.db.rowsOf("member_permissions") as any[]).some((r) => r.workspaceId === ctx.workspace.id && r.userId === ctx.user.id && r.feature === feature && r.granted === false);
vi.mock("./db", async (a) => ({
  ...(await a<typeof import("./db")>()),
  getDb: async () => h.db,
  hasPermission: async (ctx: any, feature: string) => !denied(ctx, feature),
  checkPermission: async (ctx: any, feature: string) => {
    if (denied(ctx, feature)) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "FORBIDDEN", message: `You do not have permission to use: ${feature}` });
    }
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { encryptSecret } from "./_core/crypto";
import { workspaceAnthropicKey } from "./_core/llm";
import { getApolloKey } from "./services/apollo";
import { getReoonKey } from "./services/reoon";
import { getQuickEnrichKey } from "./services/quickenrich";
import { workspaceXaiKey } from "./services/voiceGuards";
import { credentialView, loadCredentials, workspacesWithCredentials } from "./services/prospectSources/credentials";
import { getSource } from "./services/prospectSources/registry";
import { SHARE_KINDS, linkedKey, linkedKeys } from "./services/keyShares";

const ROOT = join(__dirname, "..");
const A = 2; // LSI Media: holds the keys
const B = 4; // CommunityForce: borrows
const C = 5; // Queue & Co
const GONE = 9; // archived
const OWNER = 10; // super_admin of A, B, C and GONE
const ADMIN_A = 11; // admin of A, only a rep in B
const REP = 12; // rep in A, admin in B
const MANAGER = 13; // manager in A and in B
const KEYS = {
  anthropic: "sk-ant-lsi-AAAA1111",
  xai: "xai-lsi-BBBB2222",
  apollo: "apollo-lsi-CCCC3333",
  reoon: "reoon-lsi-DDDD4444",
  quickenrich: "qe-lsi-EEEE5555",
  leadocean: "lo-lsi-FFFF6666",
};
const TAILS = Object.values(KEYS).map((k) => k.slice(-4));

const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = (ws: number) => rows("workspace_settings").find((r) => r.workspaceId === ws);
const caller = (userId: number, ws: number) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function code(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e.code as string; }
  return "OK";
}
const shareAll = async () => {
  for (const kind of ["anthropic", "xai", "apollo", "reoon", "quickenrich", "leadocean"] as const) {
    await caller(OWNER, A).keyShares.share({ kind, targetWorkspaceId: B });
  }
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  const user = (id: number) => ({ id, openId: `u${id}`, email: `u${id}@example.com`, name: `U${id}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  rows("users").push(user(OWNER), user(ADMIN_A), user(REP), user(MANAGER));
  const ws = (id: number, name: string, archivedAt: Date | null = null) => ({ id, name, slug: `ws${id}`, ownerUserId: OWNER, archivedAt, plan: "trial" });
  rows("workspaces").push(ws(A, "LSI Media"), ws(B, "CommunityForce"), ws(C, "Queue & Co"), ws(GONE, "Old", new Date("2026-01-01T00:00:00Z")));
  let mid = 0;
  const member = (workspaceId: number, userId: number, role: string) => ({ id: ++mid, workspaceId, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("workspace_members").push(
    member(A, OWNER, "super_admin"), member(B, OWNER, "super_admin"), member(C, OWNER, "super_admin"), member(GONE, OWNER, "super_admin"),
    member(A, ADMIN_A, "admin"), member(B, ADMIN_A, "rep"),
    member(A, REP, "rep"), member(B, REP, "admin"),
    member(A, MANAGER, "manager"), member(B, MANAGER, "manager"),
  );
  const base = { enforce2fa: false, timezone: "America/New_York", reoonVerificationEnabled: true, anthropicApiKeyEnc: null, openaiApiKeyEnc: null, geminiApiKeyEnc: null, xaiApiKeyEnc: null, apolloApiKeyEnc: null, reoonApiKeyEnc: null, quickenrichApiKeyEnc: null };
  rows("workspace_settings").push(
    { ...base, workspaceId: A, anthropicApiKeyEnc: encryptSecret(KEYS.anthropic), xaiApiKeyEnc: encryptSecret(KEYS.xai), apolloApiKeyEnc: encryptSecret(KEYS.apollo), reoonApiKeyEnc: encryptSecret(KEYS.reoon), quickenrichApiKeyEnc: encryptSecret(KEYS.quickenrich) },
    { ...base, workspaceId: B },
    { ...base, workspaceId: C },
    { ...base, workspaceId: GONE, apolloApiKeyEnc: encryptSecret("apollo-archived-ZZZZ") },
  );
  rows("prospect_source_credentials").push({ id: 1, workspaceId: A, sourceSlug: "leadocean", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: KEYS.leadocean })), config: { plan: "tier3" }, status: "valid", lastValidatedAt: new Date(), validationError: null, consecutiveFailures: 0, circuitOpenUntil: null });
});

describe("a lent key is the lender's key, read at call time", () => {
  it("without a share another workspace's key is no key", async () => {
    expect(await workspaceAnthropicKey(B)).toBe("");
    expect(await getApolloKey(B)).toBe("");
    expect(await getReoonKey(B)).toBe("");
    expect(await getQuickEnrichKey(B)).toBe("");
    expect(await workspaceXaiKey(B)).toBe("");
    expect(await loadCredentials(B, getSource("leadocean"))).toBeNull();
  });

  it("with a share, every read of that key in the borrower resolves the lender's", async () => {
    await shareAll();
    expect(await workspaceAnthropicKey(B)).toBe(KEYS.anthropic);
    expect(await getApolloKey(B)).toBe(KEYS.apollo);
    expect(await getReoonKey(B)).toBe(KEYS.reoon);
    expect(await getQuickEnrichKey(B)).toBe(KEYS.quickenrich);
    expect(await workspaceXaiKey(B)).toBe(KEYS.xai);
    const lo = await loadCredentials(B, getSource("leadocean"));
    // The lender's secret and account settings, as the BORROWER's search.
    expect(lo).toMatchObject({ workspaceId: B, secrets: { apiKey: KEYS.leadocean }, config: { plan: "tier3" } });
    // A third workspace was lent nothing.
    expect(await getApolloKey(C)).toBe("");
    expect(await loadCredentials(C, getSource("leadocean"))).toBeNull();
    // The polling crons walk the borrower too: it has runs and no row of its own.
    expect(await workspacesWithCredentials()).toEqual(expect.arrayContaining([{ workspaceId: A, slug: "leadocean" }, { workspaceId: B, slug: "leadocean" }]));
  });

  it("the three LLM providers come in one read, and only the ones lent", async () => {
    await caller(OWNER, A).keyShares.share({ kind: "anthropic", targetWorkspaceId: B });
    expect(await linkedKeys(B, ["anthropic", "openai", "gemini"])).toEqual({ anthropic: { ownerWorkspaceId: A, key: KEYS.anthropic } });
  });

  it("a workspace's own key always comes first", async () => {
    await shareAll();
    settings(B).apolloApiKeyEnc = encryptSecret("apollo-own-B");
    settings(B).anthropicApiKeyEnc = encryptSecret("sk-ant-own-B");
    expect(await getApolloKey(B)).toBe("apollo-own-B");
    expect(await workspaceAnthropicKey(B)).toBe("sk-ant-own-B");
  });

  it("is live: a rotated key is the new key at once, and a cleared key is no key", async () => {
    await shareAll();
    settings(A).apolloApiKeyEnc = encryptSecret("apollo-rotated");
    expect(await getApolloKey(B)).toBe("apollo-rotated");
    settings(A).apolloApiKeyEnc = null;
    expect(await getApolloKey(B)).toBe("");
    const o = await caller(OWNER, B).keyShares.overview();
    expect(o.keys.find((k) => k.kind === "apollo")!.borrowedFrom).toEqual({ workspaceId: A, name: "LSI Media", usable: false });
    // Nothing was ever stored in the borrower.
    expect(settings(B).apolloApiKeyEnc).toBeNull();
  });

  it("stops at once when the lender takes it back, or the borrower gives it up", async () => {
    await shareAll();
    expect(await caller(OWNER, A).keyShares.unshare({ kind: "apollo", targetWorkspaceId: B })).toEqual({ ok: true, removed: true });
    expect(await getApolloKey(B)).toBe("");
    expect(await caller(OWNER, B).keyShares.stopUsing({ kind: "xai" })).toEqual({ ok: true, removed: true });
    expect(await workspaceXaiKey(B)).toBe("");
    // The others stand.
    expect(await getReoonKey(B)).toBe(KEYS.reoon);
    // Taking back what is not lent is a no-op, not an error.
    expect(await caller(OWNER, A).keyShares.unshare({ kind: "apollo", targetWorkspaceId: B })).toEqual({ ok: true, removed: false });
  });

  it("a borrowed key is never passed on", async () => {
    await shareAll();
    // B borrows Apollo; it has none of its own to lend.
    expect(await code(caller(OWNER, B).keyShares.share({ kind: "apollo", targetWorkspaceId: C }))).toBe("BAD_REQUEST");
    // Even a row written some other way lends nothing: only the lender's own column is read.
    rows("workspace_key_shares").push({ id: 900, ownerWorkspaceId: B, targetWorkspaceId: C, keyKind: "apollo", createdByUserId: OWNER, createdAt: new Date() });
    expect(await linkedKey(C, "apollo")).toBe("");
    expect(await getApolloKey(C)).toBe("");
  });

  it("an archived workspace lends nothing", async () => {
    rows("workspace_key_shares").push({ id: 901, ownerWorkspaceId: GONE, targetWorkspaceId: C, keyKind: "apollo", createdByUserId: OWNER, createdAt: new Date() });
    expect(await getApolloKey(C)).toBe("");
  });

  it("Reoon switched off in the borrower stays off, whatever is lent", async () => {
    await shareAll();
    settings(B).reoonVerificationEnabled = false;
    expect(await getReoonKey(B)).toBe("");
  });

  it("a failed read lends nothing", async () => {
    await shareAll();
    const real = h.db;
    h.db = { select: () => { throw new Error("db down"); } };
    try {
      expect(await linkedKey(B, "apollo")).toBe("");
    } finally {
      h.db = real;
    }
  });
});

describe("only admins of both workspaces can lend", () => {
  it("a rep and a manager are refused everything here", async () => {
    for (const who of [REP, MANAGER]) {
      expect(await code(caller(who, A).keyShares.overview())).toBe("FORBIDDEN");
      expect(await code(caller(who, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
      expect(await code(caller(who, A).keyShares.unshare({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
      expect(await code(caller(who, A).keyShares.stopUsing({ kind: "apollo" }))).toBe("FORBIDDEN");
    }
    expect(rows("workspace_key_shares")).toHaveLength(0);
  });

  it("an admin of the lender who is not an admin of the borrower is refused", async () => {
    // ADMIN_A is an admin of A and only a rep in B; C it does not belong to at all.
    expect(await code(caller(ADMIN_A, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
    expect(await code(caller(ADMIN_A, A).keyShares.share({ kind: "apollo", targetWorkspaceId: C }))).toBe("FORBIDDEN");
    expect(await code(caller(ADMIN_A, A).keyShares.share({ kind: "apollo", targetWorkspaceId: 777 }))).toBe("FORBIDDEN");
    expect((await caller(ADMIN_A, A).keyShares.overview()).workspaces).toEqual([]);
    expect(rows("workspace_key_shares")).toHaveLength(0);
  });

  it("a deactivated or not-yet-accepted admin seat in the borrower does not count", async () => {
    const seat = rows("workspace_members").find((m) => m.workspaceId === B && m.userId === OWNER);
    seat.deactivatedAt = new Date();
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
    seat.deactivatedAt = null;
    seat.inviteToken = "pending";
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
  });

  it("not with itself, not with an archived workspace, and only a key it has", async () => {
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: A }))).toBe("BAD_REQUEST");
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: GONE }))).toBe("FORBIDDEN");
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "openai", targetWorkspaceId: B }))).toBe("BAD_REQUEST");
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "plivo" as never, targetWorkspaceId: B }))).toBe("BAD_REQUEST");
  });

  it("the Manage API keys switch, turned off for an admin, refuses the three writes", async () => {
    rows("member_permissions").push({ id: 1, workspaceId: A, userId: OWNER, feature: "manage_api_keys", granted: false });
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
    expect(await code(caller(OWNER, A).keyShares.unshare({ kind: "apollo", targetWorkspaceId: B }))).toBe("FORBIDDEN");
    expect(await code(caller(OWNER, A).keyShares.stopUsing({ kind: "apollo" }))).toBe("FORBIDDEN");
    expect((await caller(OWNER, A).keyShares.overview()).canManage).toBe(false);
  });

  it("one lender per key per borrower; sharing twice is the same share", async () => {
    settings(C).apolloApiKeyEnc = encryptSecret("apollo-own-C");
    await caller(OWNER, C).keyShares.share({ kind: "apollo", targetWorkspaceId: B });
    expect(await code(caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B }))).toBe("CONFLICT");
    expect(await getApolloKey(B)).toBe("apollo-own-C");
    expect(await caller(OWNER, C).keyShares.share({ kind: "apollo", targetWorkspaceId: B })).toEqual({ ok: true, already: true });
    expect(rows("workspace_key_shares")).toHaveLength(1);
  });

  it("both workspaces' audit logs say it", async () => {
    await caller(OWNER, A).keyShares.share({ kind: "apollo", targetWorkspaceId: B });
    const inB = rows("audit_log").filter((r) => r.workspaceId === B && r.entityType === "key_share");
    expect(inB).toHaveLength(1);
    expect(JSON.stringify(inB[0].after)).toContain("LSI Media");
    const inA = rows("audit_log").filter((r) => r.workspaceId === A && r.entityType === "key_share");
    expect(inA).toHaveLength(1);
    expect(JSON.stringify(inA[0].after)).toContain("CommunityForce");
    await caller(OWNER, B).keyShares.stopUsing({ kind: "apollo" });
    expect(rows("audit_log").filter((r) => r.entityType === "key_share").map((r) => r.workspaceId).sort()).toEqual([A, A, B, B]);
  });
});

describe("the borrower is told who lends it, and is never shown the key", () => {
  it("each status read says connected and names the lender, with no key tail anywhere", async () => {
    await shareAll();
    const b = caller(REP, B); // an admin of B
    const ai = await b.aiCredentials.get();
    expect(ai.anthropic).toMatchObject({ configured: true, masked: "", sharedFrom: "LSI Media" });
    expect(ai.openai).toMatchObject({ configured: false, sharedFrom: null });
    const apollo = await b.apollo.get();
    expect(apollo).toMatchObject({ configured: true, masked: "", sharedFrom: "LSI Media" });
    const reoon = await b.reoon.get();
    expect(reoon).toMatchObject({ configured: true, masked: "", source: "linked", sharedFrom: "LSI Media" });
    const qe = await b.quickenrich.get();
    expect(qe).toMatchObject({ configured: true, masked: "", source: "linked", sharedFrom: "LSI Media" });
    const xai = await b.voiceAgents.getSettings();
    expect(xai).toMatchObject({ configured: true, masked: "", sharedFrom: "LSI Media" });
    const views = await Promise.all((["leadocean", "apollo", "quickenrich"] as const).map((s) => credentialView(B, getSource(s))));
    for (const v of views) expect(v).toMatchObject({ configured: true, masked: "", source: "linked", sharedFrom: "LSI Media" });
    const overview = await caller(OWNER, B).keyShares.overview();
    const everything = JSON.stringify([ai, apollo, reoon, qe, xai, views, overview, await caller(OWNER, A).keyShares.overview()]);
    for (const tail of TAILS) expect(everything, tail).not.toContain(tail);
    for (const key of Object.values(KEYS)) expect(everything).not.toContain(key);
  });

  it("the lender still sees its own key's tail, and its overview names who borrows", async () => {
    await shareAll();
    expect((await caller(OWNER, A).apollo.get())).toMatchObject({ configured: true, masked: "••••3333", sharedFrom: null });
    const o = await caller(OWNER, A).keyShares.overview();
    expect(o.canManage).toBe(true);
    expect(o.workspaces).toEqual([{ id: B, name: "CommunityForce" }, { id: C, name: "Queue & Co" }]);
    expect(o.keys.map((k) => k.kind)).toEqual([...SHARE_KINDS]);
    expect(o.keys.find((k) => k.kind === "apollo")).toMatchObject({ hasOwnKey: true, sharedWith: [{ workspaceId: B, name: "CommunityForce" }], borrowedFrom: null });
    expect(o.keys.find((k) => k.kind === "openai")).toMatchObject({ hasOwnKey: false, sharedWith: [] });
    expect(o.keys.find((k) => k.kind === "leadocean")).toMatchObject({ hasOwnKey: true, sharedWith: [{ workspaceId: B, name: "CommunityForce" }] });
  });

  it("a borrower with its own key shows its own, not the lender's name", async () => {
    await shareAll();
    settings(B).apolloApiKeyEnc = encryptSecret("apollo-own-B-9999");
    expect(await caller(OWNER, B).apollo.get()).toMatchObject({ configured: true, masked: "••••9999", sharedFrom: null });
    expect(await credentialView(B, getSource("apollo"))).toMatchObject({ source: "workspace", masked: "••••9999" });
  });
});

describe("every read of a shareable key goes through the link", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

  /**
   * Why a file names a shareable key column and does NOT resolve a lent key.
   * A new file that reads one of these columns fails here until it either
   * resolves through services/keyShares or is argued into this list.
   */
  const OWN_KEY_ONLY: Record<string, string> = {
    "server/_core/rawMigrations.ts": "DDL",
    "server/_core/safeProjections.ts": "the list of columns withheld from members",
    "server/routers/spend.ts": "the platform owner's list of which workspaces hold their OWN key",
    "server/services/quickenrich.ts": "resolves through a dynamic import of ./keyShares (pinned below)",
    "server/services/reoon.ts": "resolves through a dynamic import of ./keyShares (pinned below)",
  };

  it("no server file reads a shareable key column around the link", () => {
    const out = execFileSync("git", ["grep", "-l", "-E", "(anthropic|openai|gemini|xai|apollo|reoon|quickenrich)ApiKeyEnc", "--", "server"], { cwd: ROOT, encoding: "utf8" });
    const files = out.split("\n").map((s) => s.trim()).filter((f) => f && !f.endsWith(".test.ts") && f !== "server/services/keyShares.ts");
    expect(files.length).toBeGreaterThan(10);
    const unresolved = files.filter((f) => !(f in OWN_KEY_ONLY) && !/from "(\.\.?\/)+(services\/)?keyShares"/.test(read(f)));
    expect(unresolved, "these read a shareable key column without services/keyShares").toEqual([]);
    for (const f of Object.keys(OWN_KEY_ONLY)) expect(files, `${f} no longer names a key column: drop it from OWN_KEY_ONLY`).toContain(f);
  });

  it("each key's getter falls to the lent key after its own", () => {
    expect(read("server/services/reoon.ts")).toContain('const lent = await linkedKey(workspaceId, "reoon");');
    expect(read("server/services/quickenrich.ts")).toContain('const lent = await linkedKey(workspaceId, "quickenrich");');
    expect(read("server/services/apollo.ts")).toContain('tryDecryptSecret(row?.enc) || (await linkedKey(workspaceId, "apollo"))');
    expect(read("server/_core/llm.ts")).toContain('tryDecryptSecret(row?.enc) || (await linkedKey(workspaceId, "anthropic"))');
    for (const f of ["server/_core/llm.ts", "server/_core/llmStream.ts"]) expect(read(f), f).toContain("const lent = await linkedKeys(workspaceId, missing);");
    for (const f of ["server/routers/voiceAgents.ts", "server/services/voiceGuards.ts", "server/services/voiceBridge.ts", "server/services/voiceRelay.ts"]) {
      expect(read(f), f).toMatch(/tryDecryptSecret\(\w+\?\.enc\) \|\| \(await linkedKey\([\w.]+, "xai"\)\)/);
    }
    const creds = read("server/services/prospectSources/credentials.ts");
    expect(creds).toContain("const lent = await linkedSourceRow(workspaceId, source.slug);");
  });

  it("the sharing panel is for admins, on the pages where the keys are entered", () => {
    const card = read("client/src/components/usip/settings/KeySharingCard.tsx");
    expect(card).toContain("if (!isAdmin) return null;");
    expect(card).toContain("trpc.keyShares.overview.useQuery(undefined, { enabled: isAdmin })");
    expect(read("client/src/pages/usip/Settings.tsx")).toContain("<KeySharingCard kinds={AI_KEY_KINDS} />");
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain("<KeySharingCard kinds={SOURCE_KEY_KINDS} />");
    expect(read("client/src/components/usip/settings/VoiceAgentsSection.tsx")).toContain("<KeySharingCard kinds={VOICE_KEY_KINDS} />");
    const router = read("server/routers/keyShares.ts");
    // Every procedure is admin-or-above, and every write checks the permission.
    expect(router.match(/: adminWsProcedure/g)).toHaveLength(4);
    expect(router).not.toMatch(/: (workspaceProcedure|repProcedure|managerProcedure|protectedProcedure|publicProcedure)/);
    expect(router.match(/await checkPermission\(ctx, "manage_api_keys"\);/g)).toHaveLength(3);
  });

  it("migration 0440 creates the table the schema describes", () => {
    const mig = read("server/_core/rawMigrations.ts");
    expect(mig).toContain('name: "0440_workspace_key_shares.sql"');
    expect(mig).toContain("UNIQUE KEY `uq_wks_target_kind` (`targetWorkspaceId`, `keyKind`)");
    expect(read("drizzle/schema.ts")).toContain('uniqueIndex("uq_wks_target_kind").on(t.targetWorkspaceId, t.keyKind)');
  });
});
