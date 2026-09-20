/**
 * The six per-member permission toggles, and the rule that a toggle must DO
 * something (2026-09-20).
 *
 * WHAT WAS ACTUALLY WRONG. `checkPermission` had been fully written for months
 * and was called for three of the six keys. `view_all_leads` and
 * `access_billing` were read by nothing at all: an admin turned them off, got a
 * success toast, and the member kept every power the switch claimed to remove.
 * On top of that the Team page rendered the RAW override rows, so any key with
 * no row showed as OFF — including the three the server grants by default — and
 * its "Rep" preset button wrote `manage_sequences:false` while presenting
 * itself as "the rep defaults".
 *
 * So this file holds three different kinds of assertion, and all three are
 * load-bearing:
 *   1. BEHAVIOURAL — the gates fire, and the two deliberate carve-outs
 *      (pausing a sequence, running a report on screen) do not.
 *   2. UNIT — the resolver's precedence, its fail-open, and its two distinct
 *      refusal messages.
 *   3. SCANNER — every key in the shared list has a call site, with an
 *      allowlist that has to be argued for. Its absence is what let two
 *      toggles ship dead, and a per-key exemption is now a reviewed line of
 *      code rather than an oversight.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { getTableName } from "drizzle-orm";
import { PERMISSION_KEYS, RESTRICTED_BY_DEFAULT, defaultGranted, roleTemplate } from "../shared/permissions";
import type { TrpcContext } from "./_core/context";

const ROOT = join(__dirname, "..");

const h = vi.hoisted(() => ({ db: null as any }));

/**
 * ⚠️ MOCK THE DRIVER, NOT `./db`.
 *
 * The usual harness in this repo (`vi.mock("./db", { getDb })`) replaces what
 * OTHER modules see. The permission resolver lives inside db.ts and calls its
 * own module-local `getDb`, which that mock never touches — so it found no
 * database, took the deliberate fail-open branch, and every behavioural
 * assertion in this file passed while checking nothing. Mocking `drizzle`
 * itself puts the fake handle behind the real `getDb`, which is the only way
 * these gates are actually exercised.
 *
 * The handle DELEGATES rather than being returned directly: db.ts caches `_db`
 * on first use, so a fixed object would freeze whatever the first test scripted.
 */
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => ({
    select: (...a: unknown[]) => (h.db as any).select(...a),
    update: (...a: unknown[]) => (h.db as any).update(...a),
    delete: (...a: unknown[]) => (h.db as any).delete(...a),
    insert: (...a: unknown[]) => (h.db as any).insert(...a),
  }),
}));
process.env.DATABASE_URL = "mysql://fake/permission-enforcement-tests";

import { appRouter } from "./routers";
import { checkPermission, hasPermission, resolvePermissionMap } from "./db";

/* ── A fake db that dispatches on the real drizzle table objects ─────────── */

type PermRow = { feature: string; granted: boolean };

function makeDb(role: string, perms: PermRow[]) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { id: 1, name: "Acme", ownerUserId: 1, archivedAt: null },
            // lastActiveAt is NOW on purpose: a stale one makes the workspace
            // middleware fire an UPDATE this fake does not implement.
            mb: { id: 1, userId: 1, workspaceId: 1, role, deactivatedAt: null, lastActiveAt: new Date() },
          }]);
          return;
        }
        // Dispatch on the table NAME, not on object identity: the fail-open
        // test resets the module registry, after which db.ts's lazy
        // `import("../drizzle/schema")` hands back a different table object
        // for the same table and an identity check silently stops matching.
        switch (st.table ? getTableName(st.table as never) : "") {
          case "member_permissions": res(perms); break;
          case "usage_counters": res([]); break;
          case "workspace_members": res([{ c: 3 }]); break;
          case "sequences": res([{ id: 7, workspaceId: 1, ownerUserId: 1, isTemplate: false, visibility: "private", status: "draft", steps: [] }]); break;
          default: rej(new Error("fake db: unscripted select"));
        }
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: 1 }] }) }),
    delete: () => ({ where: async () => [{ affectedRows: 1 }] }),
    insert: () => ({ values: async () => [{ insertId: 9 }] }),
  };
}

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

/**
 * Returns the PERMISSION refusal message, or null when the call got past the
 * gate. Deliberately null for any other failure: the fake db cannot carry every
 * one of these procedures to completion, and "did the permission check fire"
 * is the only question this file is asking of them.
 */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const m = (e as Error).message ?? "";
    return /permission to use/.test(m) ? m : null;
  }
}

const caller = (role: string, perms: PermRow[]) => {
  h.db = makeDb(role, perms);
  return appRouter.createCaller(makeCtx());
};

const deny = (feature: string): PermRow[] => [{ feature, granted: false }];
const grant = (feature: string): PermRow[] => [{ feature, granted: true }];

/* ── 1. Behavioural ──────────────────────────────────────────────────────── */

describe("access_billing", () => {
  it("a rep with no override row reaches the billing usage counter", async () => {
    // THE TEST THAT FAILS if anyone puts access_billing back into
    // RESTRICTED_BY_DEFAULT. Enforcing it under the old default would have
    // taken Settings → Billing and credits away from every manager and rep in
    // every workspace, including ones that never opened the Permissions tab.
    const out = await caller("rep", []).usage.currentMonth();
    expect(out.llmTokens).toBe(0);
    expect(out.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("an explicit deny row refuses, with the override wording", async () => {
    await expect(caller("rep", deny("access_billing")).usage.currentMonth())
      .rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "You do not have permission to use: access_billing",
      });
  });

  it("the deny row refuses an ADMIN too — an override outranks the role", async () => {
    await expect(caller("admin", deny("access_billing")).usage.currentMonth())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("manage_sequences", () => {
  const authoring: Array<[string, (c: any) => Promise<unknown>]> = [
    ["fork", (c) => c.sequences.fork({ templateId: 7 })],
    ["updateMeta", (c) => c.sequences.updateMeta({ id: 7, name: "x" })],
    ["updateSteps", (c) => c.sequences.updateSteps({ id: 7, steps: [] })],
    ["saveCanvas", (c) => c.sequences.saveCanvas({ id: 7, nodes: [], edges: [] })],
  ];

  it("every authoring mutation refuses a member with the key denied", async () => {
    for (const [name, call] of authoring) {
      const msg = await refusal(() => call(caller("rep", deny("manage_sequences"))));
      expect(msg, `${name} is not gated on manage_sequences`).toBe("You do not have permission to use: manage_sequences");
    }
  });

  it("and none of them refuses a member with no row — the key is granted by default", async () => {
    for (const [name, call] of authoring) {
      const msg = await refusal(() => call(caller("rep", [])));
      expect(msg, `${name} refuses a rep who has no override row at all`).toBeNull();
    }
  });

  it("PAUSING a running sequence stays available with the key denied", async () => {
    // The carve-out, pinned so the next person does not tidy it into a single
    // unconditional call. `updateSteps` tells the user "Pause it first"; a
    // member who can watch a sequence send the wrong thing but cannot stop it
    // is a worse outcome than one who can pause something they may not edit.
    const msg = await refusal(() =>
      caller("rep", deny("manage_sequences")).sequences.setStatus({ id: 7, status: "paused" }));
    expect(msg).toBeNull();
  });

  it("but every OTHER status transition is gated", async () => {
    for (const status of ["active", "draft", "archived"] as const) {
      const msg = await refusal(() =>
        caller("rep", deny("manage_sequences")).sequences.setStatus({ id: 7, status }));
      expect(msg, `setStatus("${status}") is not gated`).toBe("You do not have permission to use: manage_sequences");
    }
  });
});

describe("export_data", () => {
  const spec = { object: "leads" as const, columns: ["status"], filters: [], limit: 10 };

  it("reports.exportCsv refuses a rep — the key is restricted by default", async () => {
    const msg = await refusal(() => caller("rep", []).reports.exportCsv(spec as never));
    expect(msg).toBe("Your role (rep) does not have permission to use: export_data");
  });

  it("and allows one an admin has explicitly granted it", async () => {
    const msg = await refusal(() => caller("rep", grant("export_data")).reports.exportCsv(spec as never));
    expect(msg).toBeNull();
  });

  it("reports.run is NOT gated — only the file is, not reading the numbers", async () => {
    const msg = await refusal(() => caller("rep", []).reports.run(spec as never));
    expect(msg).toBeNull();
  });

  it("structurally too: reports.ts gates the export and nothing else", () => {
    const src = readFileSync(join(ROOT, "server/routers/reports.ts"), "utf8");
    const at = src.indexOf('checkPermission(ctx, "export_data")');
    expect(at, "reports.exportCsv has lost its export_data gate").toBeGreaterThan(-1);
    // The gate must sit inside exportCsv, after `run` and before the saved-
    // report CRUD below it.
    expect(at).toBeGreaterThan(src.indexOf("exportCsv: workspaceProcedure"));
    expect(at).toBeLessThan(src.indexOf("/* saved reports */"));
  });
});

/* ── 2. Unit: the resolver ───────────────────────────────────────────────── */

const permCtx = (role: string) => ({ workspace: { id: 1 }, user: { id: 1 }, member: { role } });

describe("the resolver", () => {
  it("a row wins over the role default in BOTH directions", async () => {
    h.db = makeDb("rep", grant("export_data"));
    await expect(checkPermission(permCtx("rep"), "export_data")).resolves.toBeUndefined();

    h.db = makeDb("admin", deny("export_data"));
    await expect(checkPermission(permCtx("admin"), "export_data")).rejects.toThrow(/You do not have permission/);
  });

  it("names the OVERRIDE when a row refuses and the ROLE when a default does", async () => {
    // Two different fixes for the admin who gets the screenshot: go clear the
    // switch, versus go set one. Folding these into one string is a silent loss.
    h.db = makeDb("rep", deny("export_data"));
    await expect(checkPermission(permCtx("rep"), "export_data"))
      .rejects.toThrow("You do not have permission to use: export_data");

    h.db = makeDb("rep", []);
    await expect(checkPermission(permCtx("rep"), "export_data"))
      .rejects.toThrow("Your role (rep) does not have permission to use: export_data");
  });

  it("FAILS OPEN with no database, in both the throwing and the asking form", async () => {
    // Deliberate (server/db.ts). A non-DB env must not have every gated
    // feature refuse; pinned so a later "tighten this" does not fail closed.
    // A fresh module with DATABASE_URL unset is the only way to reach the
    // branch — db.ts caches its handle after the first successful connect.
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    vi.resetModules();
    try {
      const fresh = await import("./db");
      await expect(fresh.checkPermission(permCtx("rep"), "export_data")).resolves.toBeUndefined();
      await expect(fresh.hasPermission(permCtx("rep"), "export_data")).resolves.toBe(true);
      await expect(fresh.resolvePermissionMap(permCtx("rep"))).resolves.toMatchObject({ export_data: false });
    } finally {
      process.env.DATABASE_URL = prev;
      vi.resetModules();
    }
  });

  it("resolvePermissionMap answers every key, not just the ones with rows", async () => {
    h.db = makeDb("rep", []);
    const rep = await resolvePermissionMap(permCtx("rep"));
    expect(rep).toEqual({
      export_data: false,
      manage_sequences: true,
      view_all_leads: true,
      manage_integrations: true,
      access_billing: true,
      manage_api_keys: false,
    });

    h.db = makeDb("admin", []);
    const admin = await resolvePermissionMap(permCtx("admin"));
    for (const k of PERMISSION_KEYS) expect(admin[k], k).toBe(true);
  });

  it("and layers the rows on top", async () => {
    h.db = makeDb("rep", [{ feature: "export_data", granted: true }, { feature: "manage_sequences", granted: false }]);
    const map = await resolvePermissionMap(permCtx("rep"));
    expect(map.export_data).toBe(true);
    expect(map.manage_sequences).toBe(false);
    expect(map.view_all_leads).toBe(true);
  });
});

describe("the shared defaults", () => {
  it("access_billing is granted by default — the flip that made enforcing it safe", () => {
    expect(RESTRICTED_BY_DEFAULT).toEqual(["export_data", "manage_api_keys"]);
    expect(defaultGranted("access_billing", false)).toBe(true);
  });

  it("elevated roles bypass every restriction", () => {
    for (const k of PERMISSION_KEYS) expect(defaultGranted(k, true), k).toBe(true);
  });

  it("the role templates ARE the defaults, rather than a second opinion about them", () => {
    // The Team page's preset buttons used to carry their own table, and it
    // disagreed on four of the six keys — which is how clicking "Rep" revoked
    // manage_sequences while describing itself as the rep default.
    for (const isElevated of [true, false]) {
      const tpl = roleTemplate(isElevated);
      expect(Object.keys(tpl).sort()).toEqual(PERMISSION_KEYS.slice().sort());
      for (const k of PERMISSION_KEYS) expect(tpl[k], `${k} @ elevated=${isElevated}`).toBe(defaultGranted(k, isElevated));
    }
  });
});

/* ── 3. Scanner: a toggle must DO something ──────────────────────────────── */

function serverSources(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) {
        out.push({ rel: p.slice(ROOT.length + 1).split(sep).join("/"), src: readFileSync(p, "utf8") });
      }
    }
  };
  walk(join(ROOT, "server"));
  return out;
}

/**
 * Per key: where it is enforced, or the argued reason it is not.
 *
 * `enforced: false` must carry a reason, so an unwired toggle is a decision
 * somebody wrote down rather than something nobody noticed.
 */
const ENFORCEMENT: Record<string, { enforced: boolean; files?: string[]; reason?: string }> = {
  export_data: { enforced: true, files: ["server/routers/admin.ts", "server/routers/reports.ts"] },
  manage_sequences: { enforced: true, files: ["server/routers/sequences.ts"] },
  manage_integrations: { enforced: true, files: ["server/routers/integrations.ts"] },
  manage_api_keys: { enforced: true, files: ["server/routers/aiCredentials.ts", "server/routers/apollo.ts", "server/routers/prospectSources.ts", "server/routers/quickenrich.ts", "server/routers/reoon.ts"] },
  access_billing: { enforced: true, files: ["server/routers/admin.ts"] },
  view_all_leads: {
    enforced: false,
    reason: "Data scoping, not a gate: it must NARROW the lead lists, never throw. " +
      "Deferred deliberately — read-scoping alone would ship a member who cannot see " +
      "a lead but can still delete it by id, and the in-app assistant's data explorer " +
      "would hand the whole workspace back anyway. Until that lands the Team page " +
      "labels this switch as not enforced.",
  },
};

describe("no toggle ships dead", () => {
  const files = serverSources();

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("the Team page's switches are exactly the shared key list", () => {
    const team = readFileSync(join(ROOT, "client/src/pages/usip/Team.tsx"), "utf8");
    const block = team.slice(team.indexOf("const PERMISSION_DESCRIPTIONS"), team.indexOf("const PERMISSION_FEATURES"));
    expect(block.length, "PERMISSION_DESCRIPTIONS has moved or been renamed — re-anchor this scan").toBeGreaterThan(100);
    const keys: string[] = [];
    for (const m of block.matchAll(/^\s{4}(\w+):\s*\{\s*label:/gm)) keys.push(m[1]);
    expect(keys.slice().sort()).toEqual(PERMISSION_KEYS.slice().sort());
  });

  it("every key is either called somewhere under server/, or exempt with a reason", () => {
    const missing: string[] = [];
    for (const key of PERMISSION_KEYS) {
      const entry = ENFORCEMENT[key];
      expect(entry, `${key} is in PERMISSION_KEYS but not in this file's ENFORCEMENT map`).toBeDefined();
      const needle = new RegExp(`(checkPermission|hasPermission)\\(ctx, "${key}"\\)`);
      const hits = files.filter((f) => needle.test(f.src)).map((f) => f.rel).sort();
      if (!entry.enforced) {
        expect(entry.reason, `${key} is exempt but carries no reason`).toBeTruthy();
        expect(hits, `${key} is marked unenforced but IS called — flip enforced to true`).toEqual([]);
        continue;
      }
      if (hits.length === 0) missing.push(key);
      else expect(hits, `${key}'s call sites have moved`).toEqual((entry.files ?? []).slice().sort());
    }
    expect(
      missing,
      `These permission keys are stored, shown as a switch on the Team page, and read by NO server code. ` +
      `Either wire them to a checkPermission/hasPermission call or give them an argued exemption in ENFORCEMENT: ` +
      missing.join(", "),
    ).toEqual([]);
  });

  it("setPermissions refuses a key that is not in the shared list", () => {
    // It accepted any string ≤80 chars, so a typo was stored, read by nothing,
    // and reported to the admin as saved.
    const admin = readFileSync(join(ROOT, "server/routers/admin.ts"), "utf8");
    const at = admin.indexOf("setPermissions: adminWsProcedure");
    expect(at).toBeGreaterThan(-1);
    const body = admin.slice(at, at + 3000);
    expect(body).toMatch(/isPermissionKey/);
    expect(body).toMatch(/BAD_REQUEST/);
  });

  it("team.delete clears the member's overrides; team.deactivate deliberately does not", () => {
    // Nothing had ever deleted one of these rows, so deleting a member and
    // re-inviting the same person resurrected every deny set on them.
    const admin = readFileSync(join(ROOT, "server/routers/admin.ts"), "utf8");
    const deleteAt = admin.indexOf("delete: adminWsProcedure");
    const deactivateAt = admin.indexOf("deactivate: adminWsProcedure");
    expect(deleteAt).toBeGreaterThan(-1);
    expect(deactivateAt).toBeGreaterThan(-1);
    const cleanupAt = admin.indexOf("db.delete(memberPermissions)");
    expect(cleanupAt, "team.delete no longer clears member_permissions").toBeGreaterThan(deleteAt);
    // Scoped, or tenantScope.test.ts would flag it — and rightly.
    expect(admin.slice(cleanupAt, cleanupAt + 260)).toMatch(/eq\(memberPermissions\.workspaceId, ctx\.workspace\.id\)/);
    const deactivateBody = admin.slice(deactivateAt, deleteAt);
    expect(deactivateBody).not.toMatch(/db\.delete\(memberPermissions\)/);
  });
});
