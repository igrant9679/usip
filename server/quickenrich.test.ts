/**
 * QuickEnrich BYOK — key resolution, the free connection test, and the guards
 * that keep this integration honest while it has no engine consumer.
 *
 * Three failure classes this file exists to prevent, all from this repo's own
 * history: the migration reaching schema.ts but not rawMigrations.ts (the
 * dominant prod-breaking bug — runRawMigrations swallows failures, so the app
 * boots identically either way); a settings surface growing controls nothing
 * consults (three inert switches found on 2026-08-03); and a credential that
 * leaks through a status endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const mocks = vi.hoisted(() => {
  // _core/env.ts snapshots process.env at module load, so the encryption key
  // must exist BEFORE any import graph touches it — hoisted runs first. Only
  // set when absent: a real key in the environment must win.
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) {
    process.env.ENCRYPTION_KEY = "a".repeat(64); // test-only, never persisted
  }
  return {
    getDb: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ getDb: mocks.getDb, checkPermission: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb, checkPermission: vi.fn() }));

import { encryptSecret } from "./_core/crypto";
import { getQuickEnrichKey, quickenrichTestKey, QUICKENRICH_BASE } from "./services/quickenrich";

/** Chainable fake returning one workspace_settings row. */
function dbWithRow(row: Record<string, unknown> | null) {
  const q: any = {
    select: () => q, from: () => q, where: () => q,
    limit: () => Promise.resolve(row ? [row] : []),
  };
  return q;
}

const ENV = ["QUICKENRICH_API_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.resetAllMocks();
  for (const v of ENV) { saved[v] = process.env[v]; delete process.env[v]; }
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of ENV) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("getQuickEnrichKey — same contract as getReoonKey/getApolloKey", () => {
  it("prefers the workspace's own encrypted key", async () => {
    // Round-trips through the REAL encryptSecret/tryDecryptSecret, so a drift
    // in the ciphertext format fails here and not in production.
    mocks.getDb.mockResolvedValue(dbWithRow({ enc: encryptSecret("ws-key-123") }));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("ws-key-123");
  });

  it("falls back to the env var when the workspace column is empty", async () => {
    mocks.getDb.mockResolvedValue(dbWithRow(null));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("env-key");
  });

  it("falls back to the env var when the ciphertext is corrupt", async () => {
    // tryDecryptSecret's whole purpose: a mangled column must degrade to the
    // deploy-wide key, not crash the request.
    mocks.getDb.mockResolvedValue(dbWithRow({ enc: "not:valid:ciphertext" }));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("env-key");
  });

  it("returns empty when neither exists — callers gate on falsiness", async () => {
    mocks.getDb.mockResolvedValue(dbWithRow(null));
    expect(await getQuickEnrichKey(7)).toBe("");
  });

  it("skips the DB entirely without a workspaceId", async () => {
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(null)).toBe("env-key");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("a DB failure degrades to the env var rather than throwing", async () => {
    mocks.getDb.mockRejectedValue(new Error("connection refused"));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("env-key");
  });
});

describe("quickenrichTestKey — proves the key without spending", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  it("calls the FREE endpoint, never a paid one", async () => {
    // contact-finder is the one endpoint their docs price at 0 credits. A test
    // that spends a credit per click is a meter, not a test.
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: [] }));
    await quickenrichTestKey("k");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mocks.fetch.mock.calls[0];
    expect(url).toBe(`${QUICKENRICH_BASE}/api/employees/contact-finder`);
    expect(opts.headers.Authorization).toBe("Bearer k");
    expect(url).not.toContain("/api/employees/search");
  });

  it("reads a 401/403 as a bad key, with a message that says so", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(401, {}));
    const r = await quickenrichTestKey("bad");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.message).toContain("rejected");
  });

  it("reads a 5xx as THEIR outage, not a bad key", async () => {
    // The distinction the settings card shows the user: "replace your key" and
    // "try again later" are different instructions.
    mocks.fetch.mockResolvedValue(jsonResponse(503, {}));
    const r = await quickenrichTestKey("k");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("503");
    expect(r.message).not.toContain("rejected");
  });

  it("counts sample rows when the envelope is recognisable", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: [{}, {}, {}] }));
    expect((await quickenrichTestKey("k")).sampleRows).toBe(3);
  });

  it("a 2xx with an alien body still passes — authentication is the question", async () => {
    mocks.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => { throw new Error("not json"); } });
    const r = await quickenrichTestKey("k");
    expect(r.ok).toBe(true);
    expect(r.sampleRows).toBeNull();
  });

  it("network failure returns ok:false rather than throwing", async () => {
    mocks.fetch.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await quickenrichTestKey("k");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("migration parity — the dominant prod-breaking bug, pre-empted", () => {
  it("0146 exists in rawMigrations and adds the column schema declares", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    const at = migrations.indexOf("0146_quickenrich_key.sql");
    expect(at, "migration 0146 missing from rawMigrations — schema-only columns break prod silently").toBeGreaterThan(-1);
    const block = migrations.slice(at, at + 400);
    expect(block).toContain("ADD COLUMN `quickenrichApiKeyEnc` text NULL");

    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('quickenrichApiKeyEnc: text("quickenrichApiKeyEnc")');
  });
});

describe("no inert controls, no leaks", () => {
  const routerSrc = read("server/routers/quickenrich.ts");
  const schema = read("drizzle/schema.ts");

  it("stores ONLY the key — caps and modes ship with the engine that reads them", () => {
    /**
     * The inert-settings class: a control that saves and reads back while no
     * path consults it. If this fails because you are ADDING the sourcing
     * integration, delete it and add the consuming-path test instead — that is
     * the intended lifecycle, not a loophole.
     */
    for (const col of ["quickenrichDailyCap", "quickenrichMode", "quickenrichSweepMode"]) {
      expect(schema.includes(col), `${col} exists but nothing consumes QuickEnrich yet`).toBe(false);
    }
  });

  it("the status endpoint never returns the key", () => {
    const getBlock = routerSrc.slice(routerSrc.indexOf("get: workspaceProcedure"), routerSrc.indexOf("upsert:"));
    expect(getBlock.length).toBeGreaterThan(300);
    expect(getBlock).toContain("maskSecret(");
    // The decrypted value must feed ONLY configured/masked/source.
    expect(getBlock).not.toMatch(/masked: (workspaceKey|effective)[,\s]*$/m);
    expect(getBlock).not.toMatch(/key: (workspaceKey|effective|envKey)/);
  });

  it("writes go through encryptSecret; the raw input is never stored", () => {
    const upsert = routerSrc.slice(routerSrc.indexOf("upsert:"), routerSrc.indexOf("test:"));
    expect(upsert).toContain("encryptSecret(input.apiKey.trim())");
    expect(upsert).not.toMatch(/quickenrichApiKeyEnc:\s*input\.apiKey\s*[,}]/);
  });

  it("mutations are admin-gated and permission-checked", () => {
    const upsert = routerSrc.slice(routerSrc.indexOf("upsert:"), routerSrc.indexOf("test:"));
    expect(upsert).toContain("adminWsProcedure");
    expect(upsert).toContain('checkPermission(ctx, "manage_api_keys")');
    const test = routerSrc.slice(routerSrc.indexOf("test: "));
    expect(test).toContain("adminWsProcedure");
  });

  it("the router is registered", () => {
    const routers = read("server/routers.ts");
    expect(routers).toContain("quickenrich: quickenrichRouter");
  });

  it("both settings surfaces mount the card", () => {
    for (const rel of ["client/src/pages/usip/SettingsHub.tsx", "client/src/pages/usip/ARESettings.tsx"]) {
      expect(read(rel).includes("QuickEnrichSourceCard"), `${rel} does not mount the card`).toBe(true);
    }
  });

  it("the card says campaigns do NOT pull from it yet", () => {
    // The overclaim guard. When the source integration lands, update the copy
    // and this assertion together.
    const card = read("client/src/components/usip/settings/QuickEnrichSourceCard.tsx");
    expect(card).toContain("campaigns do not pull from QuickEnrich yet");
  });
});
