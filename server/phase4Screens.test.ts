/**
 * Phase 4 of the 2026-10-20 audit, part 2 — the slow screens (L6–L9, Calendar).
 *
 *   inline logos stay out of list responses: accounts.list sends the fields
 *   its pickers show (83 MB → small), company search sends a logo URL, and
 *   /api/media/account-logo serves the image to members only, cached and
 *   sandboxed (L6) · Companies counts its filter options on the server (L6) ·
 *   the Pipeline board reads account names only (L7) · IMAP lists the newest
 *   messages without searching the whole folder (L8) · vendor allowances are
 *   kept three minutes for display and sources are described side by side
 *   (L9) · indexes for "pulled today" and a meeting's reply (migration 0218).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    wsId: 2,
    imap: { exists: 0, fetched: [] as string[], searched: 0, uids: [] as number[] },
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./_core/sdk", () => ({
  sdk: {
    authenticateRequest: async (req: any) => {
      const id = Number(req.headers?.["x-test-user"] ?? 0);
      if (!id) throw new Error("no session");
      return { id };
    },
  },
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { exists: h.imap.exists };
    async connect() {}
    async logout() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { h.imap.searched++; return h.imap.uids; }
    async *fetch(range: string) {
      h.imap.fetched.push(range);
      const [a, b] = range.split(":");
      const lo = Number(a), hi = b === "*" ? h.imap.exists : Number(b);
      for (let seq = lo; seq <= hi; seq++) {
        yield { uid: 1000 + seq, flags: new Set(seq % 2 ? ["\\Seen"] : []), envelope: { subject: `m${seq}`, date: new Date(2026, 0, seq), from: [{ address: `p${seq}@x.example`, name: "" }] } };
      }
    }
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { encryptSecret } from "./_core/crypto";
import { decodeImageDataUri, serveAccountLogo } from "./_core/mediaRoutes";
import { accountLogoPath, resolveCompanyLogo } from "./services/company/logoService";
import { ImapSmtpAdapter } from "./emailAdapter";
import { __clearDisplayBudgetsForTests, describeSources, forgetDisplayBudget, listSources } from "./services/prospectSources/registry";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const LSI = 2, OTHER = 9;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;
const SVG_URI = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`;
const VERIFIED = new Date("2026-10-27T10:00:00Z");

function caller(ws = LSI) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

const acct = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, name: `Org ${id}`, domain: `org${id}.example`, industry: null, region: null,
  hqState: null, hqCountry: null, hqCity: null, archivedAt: null, updatedAt: new Date(2026, 9, id), createdAt: new Date(2026, 9, id),
  logoUrl: null, logoSourceType: null, logoStatus: null, logoLastVerifiedAt: null, ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [LSI]: "admin", [OTHER]: "admin" }, wsId: () => h.wsId });
});

describe("logos stay out of list responses (L6)", () => {
  const withLogo = { logoUrl: PNG_URI, logoSourceType: "website_logo", logoStatus: "available", logoLastVerifiedAt: VERIFIED };

  it("an inline logo is sent as its URL, versioned by when it was set; a remote one as it is", () => {
    expect(resolveCompanyLogo({ id: 7, ...withLogo }).url).toBe(`/api/media/account-logo/7?v=${VERIFIED.getTime()}`);
    expect(accountLogoPath(7, null)).toBe("/api/media/account-logo/7?v=0");
    expect(resolveCompanyLogo({ id: 7, ...withLogo, logoUrl: "https://cdn.example/l.png" }).url).toBe("https://cdn.example/l.png");
    // Without an id (the media route itself) the stored value comes back.
    expect(resolveCompanyLogo(withLogo).url).toBe(PNG_URI);
    // A logo the account may not show is not sent either way.
    expect(resolveCompanyLogo({ id: 7, ...withLogo, logoStatus: "blocked_by_policy" }).url).toBeNull();
  });

  it("company search sends the URL, not the image", async () => {
    h.db.rowsOf("accounts").push(acct(1, withLogo), acct(2));
    const r = await caller().companies.search({ filters: {}, sort: { field: "name", direction: "asc" }, page: 1, perPage: 50 });
    const one = r.data.find((a: any) => a.id === 1)!;
    expect(one.logo.url).toBe(`/api/media/account-logo/1?v=${VERIFIED.getTime()}`);
    expect(JSON.stringify(r)).not.toContain("base64");
  });

  it("accounts.list sends the fields pickers show, newest first, searched and limited by the server", async () => {
    h.db.rowsOf("accounts").push(acct(1, withLogo), acct(2, { name: "Acme County", industry: "Government" }), acct(3, { domain: "acme.example" }));
    h.db.rowsOf("accounts").push({ ...acct(4), workspaceId: OTHER });
    const all = await caller().accounts.list();
    expect(all.map((a) => a.id)).toEqual([3, 2, 1]);
    expect(Object.keys(all[0]).sort()).toEqual(["archivedAt", "domain", "hqCountry", "hqState", "id", "industry", "name", "region", "updatedAt"]);
    expect(JSON.stringify(all)).not.toContain("base64");
    expect((await caller().accounts.list({ search: "acme" })).map((a) => a.id)).toEqual([3, 2]);
    expect((await caller().accounts.list({ limit: 2 })).map((a) => a.id)).toEqual([3, 2]);
  });

  it("the Pipeline board reads account names, not whole accounts (L7)", () => {
    const crm = read("server/routers/crm.ts");
    const board = crm.slice(crm.indexOf("  board: workspaceProcedure"), crm.indexOf("  get: workspaceProcedure", crm.indexOf("  board: workspaceProcedure")));
    expect(board).toContain("db.select({ id: accounts.id, name: accounts.name }).from(accounts)");
    expect(board).not.toContain("db.select().from(accounts)");
  });

  it("Companies and Home no longer load every account", () => {
    const companies = read("client/src/pages/usip/Companies.tsx");
    expect(companies).not.toContain("trpc.accounts.list");
    expect(companies).toContain("trpc.companies.facets.useQuery");
    expect(read("client/src/pages/usip/Home.tsx")).toContain("trpc.accounts.list.useQuery({ limit: 5 })");
  });
});

describe("Companies counts its filter options on the server (L6)", () => {
  it("industries and locations, most first, without archived accounts or other workspaces", async () => {
    h.db.rowsOf("accounts").push(
      acct(1, { industry: "Government", hqState: "CA" }),
      acct(2, { industry: "Government ", region: "West", hqState: "" }),
      acct(3, { industry: "Education", hqCountry: "US" }),
      acct(4, { industry: "Retail", hqState: "NY", archivedAt: new Date() }),
      { ...acct(5, { industry: "Retail", hqState: "NY" }), workspaceId: OTHER },
      acct(6, { industry: "Education", hqState: "TX", region: "South", hqCountry: "US" }), // the state wins
    );
    expect(await caller().companies.facets()).toEqual({
      industries: [["Education", 2], ["Government", 2]],
      locations: [["CA", 1], ["TX", 1], ["US", 1], ["West", 1]],
    });
  });
});

describe("/api/media/account-logo serves members only (L6)", () => {
  function res() {
    const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
    r.send = (b: unknown) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  }
  const get = async (id: string, user?: number) => {
    const r = res();
    await serveAccountLogo({ params: { id }, headers: user ? { "x-test-user": String(user) } : {} } as any, r);
    return r;
  };
  beforeEach(() => {
    h.db = makeSqlFakeDb({ realMembers: true });
    h.db.rowsOf("workspace_members").push(
      { id: 1, workspaceId: LSI, userId: 11, role: "rep", deactivatedAt: null },
      { id: 2, workspaceId: OTHER, userId: 12, role: "admin", deactivatedAt: null },
      { id: 3, workspaceId: LSI, userId: 13, role: "rep", deactivatedAt: new Date() },
    );
    h.db.rowsOf("accounts").push(
      acct(1, { logoUrl: PNG_URI, logoSourceType: "website_logo", logoStatus: "available" }),
      acct(2, { logoUrl: SVG_URI, logoSourceType: "website_logo", logoStatus: "available" }),
      acct(3, { logoUrl: "https://cdn.example/l.png", logoSourceType: "website_logo", logoStatus: "available" }),
      acct(4, { logoUrl: PNG_URI, logoSourceType: "website_logo", logoStatus: "removed" }),
    );
  });

  it("the image, cached for a year, to a member of the account's workspace", async () => {
    const r = await get("1", 11);
    expect(r.statusCode).toBe(200);
    expect(Buffer.compare(r.body, PNG)).toBe(0);
    expect(r.headers["Content-Type"]).toBe("image/png");
    expect(r.headers["Cache-Control"]).toBe("private, max-age=31536000, immutable");
    expect(r.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("an SVG cannot run script when opened directly", async () => {
    const r = await get("2", 11);
    expect(r.headers["Content-Type"]).toBe("image/svg+xml");
    expect(r.headers["Content-Security-Policy"]).toContain("sandbox");
    expect(r.headers["Content-Security-Policy"]).toContain("default-src 'none'");
  });

  it("no session 401; another workspace, a deactivated member, no such account: 404 alike", async () => {
    expect((await get("1")).statusCode).toBe(401);
    expect((await get("1", 12)).statusCode).toBe(404);
    expect((await get("1", 13)).statusCode).toBe(404);
    expect((await get("99", 11)).statusCode).toBe(404);
    expect((await get("x", 11)).statusCode).toBe(404);
  });

  it("only a stored image the account may show", async () => {
    expect((await get("3", 11)).statusCode).toBe(404); // remote URL: nothing stored to serve
    expect((await get("4", 11)).statusCode).toBe(404); // removed
  });

  it("decodes base64 and percent-encoded images, and nothing that is not an image", () => {
    expect(decodeImageDataUri(PNG_URI)).toEqual({ type: "image/png", body: PNG });
    expect(decodeImageDataUri("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")?.body.toString()).toBe("<svg/>");
    expect(decodeImageDataUri(`data:text/html;base64,${Buffer.from("<script>").toString("base64")}`)).toBeNull();
    expect(decodeImageDataUri("https://cdn.example/l.png")).toBeNull();
    expect(decodeImageDataUri("data:image/png;base64,")).toBeNull();
  });

  it("is registered before the app's catch-all", () => {
    const idx = read("server/_core/index.ts");
    expect(idx).toContain("registerMediaRoutes(app);");
    expect(idx.indexOf("registerMediaRoutes(app);")).toBeLessThan(idx.indexOf("serveStatic(app)"));
  });
});

describe("IMAP lists the newest messages without searching the folder (L8)", () => {
  const adapter = () => new ImapSmtpAdapter({ id: 1, imapHost: "imap.example", imapUsername: "u", imapPassword: encryptSecret("p") } as any);
  afterEach(() => { h.imap = { exists: 0, fetched: [], searched: 0, uids: [] }; });

  it("fetches the last N by position, newest first", async () => {
    h.imap.exists = 120;
    const r = await adapter().listThreads("INBOX", undefined, 50);
    expect(h.imap.searched).toBe(0);
    expect(h.imap.fetched).toEqual(["71:*"]);
    expect(r.threads).toHaveLength(50);
    expect(r.threads[0].threadId).toBe("1120");
    expect(r.threads[49].threadId).toBe("1071");
  });

  it("a small folder from its first message; an empty one fetches nothing", async () => {
    h.imap.exists = 3;
    expect((await adapter().listThreads("INBOX", undefined, 50)).threads.map((t) => t.threadId)).toEqual(["1003", "1002", "1001"]);
    expect(h.imap.fetched).toEqual(["1:*"]);
    h.imap.exists = 0;
    h.imap.fetched = [];
    expect((await adapter().listThreads("INBOX")).threads).toEqual([]);
    expect(h.imap.fetched).toEqual([]);
  });
});

describe("source allowances are kept a few minutes for display (L9)", () => {
  afterEach(() => { __clearDisplayBudgetsForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("a vendor's answer is reused for three minutes and forgotten when credentials change; a local count never is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const table = listSources().find((s) => s.credentialMode === "table" && s.slug === "warmysender")!;
    const legacy = listSources().find((s) => s.credentialMode === "legacy")!;
    const creds = await import("./services/prospectSources/credentials");
    vi.spyOn(creds, "credentialView").mockResolvedValue({ configured: true } as any);
    vi.spyOn(creds, "loadCredentials").mockResolvedValue({ workspaceId: LSI, apiKey: "k", config: {} } as any);
    const vendor = vi.spyOn(table, "remainingBudget").mockResolvedValue([{ bucket: "verification", remaining: 5, limit: 10, used: 5, resetsAt: null, fundedBy: null }]);
    const local = vi.spyOn(legacy, "remainingBudget").mockResolvedValue([{ bucket: "leads", remaining: 1, limit: 2, used: 1, resetsAt: null, fundedBy: null }]);

    await describeSources(LSI);
    await describeSources(LSI);
    expect(vendor).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-10-27T12:02:59Z"));
    await describeSources(LSI);
    expect(vendor).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-27T12:03:00Z"));
    await describeSources(LSI);
    expect(vendor).toHaveBeenCalledTimes(2);

    forgetDisplayBudget(LSI, "warmysender");
    await describeSources(LSI);
    expect(vendor).toHaveBeenCalledTimes(3);
    await describeSources(OTHER);
    expect(vendor).toHaveBeenCalledTimes(4); // per workspace
  });

  it("saving or removing a source's key forgets its allowance; gating never reads the display copy", () => {
    const router = read("server/routers/prospectSources.ts");
    expect(router.match(/forgetDisplayBudget\(ctx\.workspace\.id, input\.slug\)/g)).toHaveLength(2);
    const registry = read("server/services/prospectSources/registry.ts");
    const eligible = registry.slice(registry.indexOf("export async function eligibleFor"));
    expect(eligible).toContain("await s.remainingBudget(creds)");
    expect(eligible).not.toContain("displayBudget(");
  });

  it("sources are described side by side, in registry order", () => {
    const registry = read("server/services/prospectSources/registry.ts");
    const describe = registry.slice(registry.indexOf("export async function describeSources"), registry.indexOf("export interface EligibleSource"));
    expect(describe).toContain("return Promise.all(listSources().map(async");
    expect(describe).not.toMatch(/for \(let i = 0; i < sources\.length/);
  });
});

describe("migration 0218: two reads that scanned a workspace's rows", () => {
  it("indexes \"pulled today\" and a meeting's reply, in the migration and the schema", () => {
    const mig = read("server/_core/rawMigrations.ts");
    const m = mig.slice(mig.indexOf('name: "0218_read_indexes.sql"'));
    expect(m).toContain("CREATE INDEX `ix_asj_ws_src_at` ON `are_scrape_jobs` (`workspaceId`, `sourceType`, `scrapedAt`)");
    expect(m).toContain("CREATE INDEX `ix_er_ws_meeting` ON `email_replies` (`workspaceId`, `meetingId`)");
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('index("ix_asj_ws_src_at").on(t.workspaceId, t.sourceType, t.scrapedAt)');
    expect(schema).toContain('index("ix_er_ws_meeting").on(t.workspaceId, t.meetingId)');
  });
});
