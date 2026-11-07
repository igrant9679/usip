/**
 * Gaps the 2026-11-06 audit completion pass saw outside its rows.
 *
 *   1 · A row is joined to a campaign (and to the rows beside it) in its own
 *       workspace only. These joins matched on the id alone, so a row filed
 *       under another workspace's campaign carried that campaign's name onto
 *       this workspace's screens, counted in its enrichment backlog, and
 *       answered the cross-engine check with it.
 *   1b· The one door into a campaign refuses another workspace's campaign.
 *   1c· No join reads a table joined after it. The sent-email drawer did, and
 *       MySQL refuses that ON clause (error 1054).
 *   2 · The assistant reads synced mail as the screens show it: a rep sees
 *       genuine replies and their own mailbox, a manager every mailbox.
 *   3 · A Revenue Engine LinkedIn step goes from the campaign owner's account
 *       or waits, as a sequence's does. It fell back to a colleague's.
 *   4 · The campaign launcher shows a failed discovery run as failed.
 *
 * Run against the SQL-evaluating fake; LinkedIn and the profile lookup are
 * mocked, so nothing leaves the process. Screens are pinned by source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return { db: null as any, role: "rep", lookups: [] as string[], invites: [] as any[], dms: [] as any[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/linkedinEnrichment/unipileProfile", async (a) => ({
  ...(await a<typeof import("./services/linkedinEnrichment/unipileProfile")>()),
  retrieveLinkedInProfileByUrl: async (o: { linkedinUrl: string }) => { h.lookups.push(o.linkedinUrl); throw new Error("no LinkedIn in tests"); },
}));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async () => ({ allowed: true, reason: null, message: "ok", retryAfterMs: null }),
  recordLinkedInAction: async () => {},
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (x: unknown) => { h.dms.push(x); return { id: "m1", chatId: "c1" }; },
  sendLinkedInInvitation: async (x: unknown) => { h.invites.push(x); return {}; },
}));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => { throw new Error("no AI in tests"); } }));
// The enrich → sequence chain a push starts; nothing here should reach it.
vi.mock("./routers/are/prospects", async (a) => ({
  ...(await a<typeof import("./routers/are/prospects")>()),
  runEnrichAgent: async () => {},
  runSequenceAgent: async () => {},
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { countCandidates, countQuickenrichCandidates, queueDiagnostics, backfillQueueCompanies } from "./services/enrichmentSweeper";
import { activeCampaignsForProspects } from "./services/crossEngineEnrollment";
import { pushPeopleIntoCampaign } from "./services/are/pushPeople";
import { runExplorerQuery, viewerScope } from "./services/assistantDataExplorer";
import { dispatchLinkedInStep } from "./services/are/linkedinStep";

const WS = 2, FOREIGN = 9, ME = 20, COLLEAGUE = 30;
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "me@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
/** The block of `src` from `start` to the next `end` after it; throws if `start` is absent. */
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};

beforeEach(() => {
  h.role = "rep";
  h.lookups = [];
  h.invites = [];
  h.dms = [];
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: (_t, k) => (Number(k) === WS ? h.role : undefined) }) as Record<number, string>, wsId: () => WS });
  rows("are_campaigns").push(
    { id: 5, workspaceId: WS, name: "Ours", status: "active", ownerUserId: ME },
    { id: 77, workspaceId: FOREIGN, name: "Their campaign", status: "active", ownerUserId: 99 },
  );
});

/* ─── 1 · joins in the workspace ─────────────────────────────────────────── */

describe("1 · a row is joined to its own workspace's campaign only", () => {
  /** Queue rows with no email: one of each shape filed under our campaign, and the same under theirs. */
  const queueRow = (id: number, campaignId: number, o: Record<string, unknown>) => ({
    id, workspaceId: WS, campaignId, firstName: "Pat", lastName: `Row${id}`, email: null,
    companyName: null, companyDomain: null, linkedinUrl: null, enrichedAt: null, enrichmentError: null,
    enrichmentStatus: "pending", sequenceStatus: "pending", personProspectId: null, ...o,
  });
  beforeEach(() => {
    rows("prospect_queue").push(
      // has a domain: the pattern pass's
      queueRow(1, 77, { companyDomain: "acme.example" }),
      queueRow(2, 5, { companyDomain: "acme.example" }),
      // no domain, a LinkedIn URL: QuickEnrich's; no company name: the backfill's too
      queueRow(3, 77, { linkedinUrl: "https://www.linkedin.com/in/theirs" }),
      queueRow(4, 5, { linkedinUrl: "https://www.linkedin.com/in/ours", companyName: "Acme" }),
    );
  });

  it("the enrichment backlog counts this workspace's campaigns only", async () => {
    expect(await countCandidates(WS)).toBe(1);
    expect(await countQuickenrichCandidates(WS)).toBe(1);
    expect((await queueDiagnostics(WS)).noEmailTotal).toBe(2);
  });

  it("the company backfill never looks up a row filed under another workspace's campaign", async () => {
    const r = await backfillQueueCompanies({ workspaceId: WS, userId: ME, isAdmin: true });
    expect(r.stoppedBecause).toBe("no_candidates");
    expect(h.lookups).toEqual([]);
  });

  it("the cross-engine check names only this workspace's campaigns", async () => {
    rows("prospects").push(
      { id: 40, workspaceId: WS, email: "pat@acme.example" },
      { id: 41, workspaceId: WS, email: "sam@acme.example" },
    );
    rows("prospect_queue").push(
      queueRow(10, 77, { personProspectId: 40 }),
      queueRow(11, 5, { personProspectId: 41 }),
    );
    const hits = await activeCampaignsForProspects(WS, [40, 41]);
    expect(hits.get(40)).toBeUndefined();
    expect(hits.get(41)?.map((x) => x.campaignName)).toEqual(["Ours"]);
  });

  it("routing suggestions show this workspace's campaigns and people only", async () => {
    rows("prospects").push(
      { id: 41, workspaceId: WS, firstName: "Sam" },
      { id: 42, workspaceId: WS, firstName: "Kim" },
      { id: 900, workspaceId: FOREIGN, firstName: "Stranger" },
    );
    rows("campaign_routing_suggestions").push(
      { id: 1, workspaceId: WS, prospectId: 41, campaignId: 77, status: "pending", fit: 90 },
      { id: 2, workspaceId: WS, prospectId: 900, campaignId: 5, status: "pending", fit: 80 },
      { id: 3, workspaceId: WS, prospectId: 42, campaignId: 5, status: "pending", fit: 70 },
    );
    const got = await caller().are.campaigns.listRoutingSuggestions({ limit: 50 });
    expect(got.map((s) => [s.id, s.campaignName, s.firstName])).toEqual([[3, "Ours", "Kim"]]);
  });

  it("the Emails drawer names no other workspace's campaign or prospect", async () => {
    rows("prospect_queue").push(
      queueRow(20, 5, { email: "kim@acme.example" }),
      { id: 900, workspaceId: FOREIGN, campaignId: 77, email: "stranger@other.example" },
    );
    rows("are_execution_queue").push(
      { id: 11, workspaceId: WS, campaignId: 77, prospectQueueId: 900, status: "sent", messageContent: { subject: "s", body: "b" } },
      { id: 12, workspaceId: WS, campaignId: 5, prospectQueueId: 20, status: "sent", messageContent: { subject: "s", body: "b" } },
    );
    rows("email_log").push({ id: 31, workspaceId: WS, campaignId: 77, executionQueueId: 11, sendingAccountId: null, draftId: null, userId: null, bodyPreview: "p", fromEmail: "me@example.com" });

    const theirs = await caller().emailActivity.get({ kind: "queued", id: 11 });
    expect([theirs.campaignName, theirs.toEmail]).toEqual([null, null]);
    const ours = await caller().emailActivity.get({ kind: "queued", id: 12 });
    expect([ours.campaignName, ours.toEmail]).toEqual(["Ours", "kim@acme.example"]);
    expect((await caller().emailActivity.get({ kind: "log", id: 31 })).campaignName).toBeNull();
  });

  /** Every join to a campaign, anywhere in the server, matches the workspace as well as the id. */
  it("guard: no join to a campaign on its id alone", () => {
    const offenders: string[] = [];
    for (const f of serverSources()) {
      const src = read(relative(ROOT, f));
      for (const m of Array.from(src.matchAll(/\.(?:inner|left|right)Join\(\s*areCampaigns\s*,\s*([\s\S]*?)\)\s*\n/g))) {
        if (!/areCampaigns\.workspaceId/.test(m[1])) offenders.push(`${relative(ROOT, f)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("guard: every join on the Emails page, routing suggestions and the message preview matches the workspace", () => {
    const joins = (src: string) => Array.from(src.matchAll(/\.(?:inner|left)Join\((\w+),\s*([^\n]*)\)\n/g)).map((m) => ({ table: m[1], on: m[2] }));
    const unscoped = (src: string) => joins(src).filter((j) => j.table !== "users" && !j.on.includes(`${j.table}.workspaceId`)).map((j) => j.table);
    const ea = read("server/routers/emailActivity.ts");
    expect(joins(ea).length).toBeGreaterThan(10);
    expect(unscoped(ea)).toEqual([]);
    expect(unscoped(block(read("server/routers/are/campaigns.ts"), "listRoutingSuggestions:", "decideRoutingSuggestion:"))).toEqual([]);
    expect(unscoped(block(read("server/routers/are/execution.ts"), "getMessage:", "const signals"))).toEqual([]);
    expect(unscoped(block(read("server/routers/attention.ts"), "// Best-fit campaign suggestions", ".groupBy("))).toEqual([]);
  });
});

/* ─── 1b · the door into a campaign ──────────────────────────────────────── */

describe("1b · pushing people into a campaign", () => {
  it("refuses another workspace's campaign and writes nothing", async () => {
    rows("prospects").push({ id: 41, workspaceId: WS, firstName: "Sam", lastName: "Lee", email: "sam@acme.example" });
    const r = await pushPeopleIntoCampaign(WS, 77, [41]);
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual([{ prospectId: 41, reason: "Campaign not found in this workspace" }]);
    expect(rows("prospect_queue")).toEqual([]);
  });
});

/* ─── 1c · join order ────────────────────────────────────────────────────── */

const TABLES = new Set(Array.from(read("drizzle/schema.ts").matchAll(/export const (\w+) = mysqlTable/g)).map((m) => m[1]));

/** Joins whose ON names a table that the statement joins only later (MySQL error 1054). */
function lateJoins(file: string, src: string): string[] {
  const aliases = new Set(Array.from(src.matchAll(/const (\w+) = alias\(/g)).map((m) => m[1]));
  const isTable = (n: string) => TABLES.has(n) || aliases.has(n);
  const out: string[] = [];
  for (const m of Array.from(src.matchAll(/\.from\((\w+)\)([\s\S]*?)(?=\.where\(|\.groupBy\(|\.orderBy\(|\.limit\(|;)/g))) {
    const seen = new Set([m[1]]);
    for (const j of Array.from(m[2].matchAll(/\.(?:inner|left|right)Join\((\w+),([\s\S]*?)\)\s*(?=\n\s*(?:\/\/|\.)|$)/g))) {
      seen.add(j[1]);
      for (const r of Array.from(j[2].matchAll(/\b(\w+)\.\w+/g))) {
        if (isTable(r[1]) && !seen.has(r[1])) out.push(`${file}:${src.slice(0, m.index).split("\n").length} ${j[1]} reads ${r[1]}`);
      }
    }
  }
  return out;
}

function serverSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "__fakes__") walk(p); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(join(ROOT, "server"));
  return files;
}

describe("1c · a join reads only tables joined before it", () => {
  it("flags the sent-email drawer's old order", () => {
    const old = [
      "db.select({ a: emailLog.id })",
      "  .from(emailLog)",
      "  .leftJoin(execAccount, eq(execAccount.id, areExecutionQueue.sendingAccountId))",
      "  .leftJoin(areExecutionQueue, eq(areExecutionQueue.id, emailLog.executionQueueId))",
      "  .where(eq(emailLog.id, 1));",
    ].join("\n");
    expect(lateJoins("x.ts", `const execAccount = alias(sendingAccounts, "exec_account");\n${old}`)).toEqual(["x.ts:3 execAccount reads areExecutionQueue"]);
  });

  it("finds none anywhere in server/", () => {
    expect(serverSources().flatMap((f) => lateJoins(relative(ROOT, f), read(relative(ROOT, f))))).toEqual([]);
  });
});

/* ─── 2 · the assistant's synced mail ────────────────────────────────────── */

describe("2 · the assistant reads synced mail as the screens show it", () => {
  beforeEach(() => {
    // The explorer builds its query dynamically; the fake's builder is already dynamic.
    const select = h.db.select;
    h.db.select = (p?: unknown) => { const b = select(p); b.$dynamic = () => b; return b; };
    rows("email_replies").push(
      { id: 1, workspaceId: WS, userId: ME, draftId: null, campaignId: null, subject: "my own mail" },
      { id: 2, workspaceId: WS, userId: COLLEAGUE, draftId: null, campaignId: null, subject: "a colleague's private mail" },
      { id: 3, workspaceId: WS, userId: COLLEAGUE, draftId: 55, campaignId: null, subject: "a reply to a draft" },
      { id: 4, workspaceId: WS, userId: COLLEAGUE, draftId: null, campaignId: 5, subject: "a campaign reply" },
      { id: 5, workspaceId: FOREIGN, userId: ME, draftId: 56, campaignId: null, subject: "another workspace" },
    );
  });
  const ids = async (role: string) =>
    (await runExplorerQuery(WS, { entity: "email_replies", sort: [{ by: "id", direction: "asc" }] }, { userId: ME, role })).rows.map((r) => r.id);

  it("a rep sees genuine replies and their own mailbox, not a colleague's private mail", async () => {
    expect(await ids("rep")).toEqual([1, 3, 4]);
  });

  it("a manager sees every mailbox", async () => {
    expect(await ids("manager")).toEqual([1, 2, 3, 4]);
    expect(viewerScope("email_replies", { userId: ME, role: "admin" })).toBeUndefined();
  });
});

/* ─── 3 · Revenue Engine LinkedIn ────────────────────────────────────────── */

describe("3 · a Revenue Engine LinkedIn step goes from the campaign owner's account or waits", () => {
  const step = (campaignOwnerUserId: number | null) => dispatchLinkedInStep({
    workspaceId: WS, campaignId: 5, campaignOwnerUserId,
    prospect: { id: 7, workspaceId: WS, campaignId: 5, firstName: "Dana", lastName: "Q", linkedinUrl: "https://www.linkedin.com/in/dana-q", personProspectId: null } as never,
    body: "Hi Dana, a quick note.", stepIndex: 0,
  });
  beforeEach(() => {
    rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: COLLEAGUE, unipileAccountId: "acct-colleague", provider: "LINKEDIN" });
  });

  it("holds the step, with the reason, when only a colleague has an account", async () => {
    expect(await step(ME)).toEqual({ kind: "deferred", reason: "The campaign owner has no LinkedIn account connected", stopChannel: true });
    expect(await step(null)).toEqual({ kind: "deferred", reason: "The campaign has no owner to send as", stopChannel: true });
    expect([h.invites, h.dms]).toEqual([[], []]);
  });

  it("a held step reaches the campaign log", () => {
    const engine = read("server/areEngine.ts");
    expect(block(engine, "if (outcome.kind === \"deferred\") {", "continue;")).toContain("`LinkedIn steps held: ${outcome.reason}`");
  });
});

/* ─── 4 · the launcher ───────────────────────────────────────────────────── */

describe("4 · the campaign launcher shows a failed run as failed", () => {
  it("reads the run's status before it says complete", () => {
    const launcher = block(read("client/src/pages/usip/ARECampaignDetail.tsx"), "function CampaignDiscoveryLauncher(", "onError:");
    expect(launcher).toMatch(/if \(r\.status === "failed"\) \{\s*toast\.error\(`\$\{lead\}Run #\$\{r\.runId\} failed: \$\{r\.errorMessage \?\? "the finds could not be saved"\}`/);
    expect(launcher).toMatch(/\} else \{\s*toast\.success\(\s*`\$\{lead\}Discovery complete/);
    expect(launcher.match(/Discovery complete/g)).toHaveLength(1);
  });
});
