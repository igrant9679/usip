/**
 * The rest of audit 2026-10-20, A75 (the prospects router): its "edit races",
 * "list ownership" and "vendor miss cache" parts named no line, so each was
 * found in the code it points at.
 *
 *   1 · Edit races — editSequenceStep read the steps (one JSON array), changed
 *       one, and wrote the whole array back. Two people editing different
 *       steps at once: the second save undid the first. It now writes only on
 *       the sequence version it read, and re-applies its step on a clash.
 *   2 · List ownership — the Prospects tab's "Add to list" goes through
 *       recordLists.addMembers, which now refuses another workspace's list
 *       (P46/P47). At the audit it wrote to any list id. Pinned here.
 *   3 · Vendor miss cache — the enrich agent paid QuickEnrich and the Reoon
 *       finder again for a person they had just found nothing for. A
 *       definitive miss is now remembered for 30 days.
 *
 * Executed against the SQL-evaluating fake. The AI, QuickEnrich and the
 * finder are mocked; nothing leaves the process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return {
    db: null as any,
    qe: [] as string[],
    finder: [] as string[],
    qeAnswer: { email: null as string | null, reason: "no_match", companyName: null as string | null, companyDomain: null as string | null },
    finderAnswer: { email: null as string | null, status: null as string | null, reason: "no_valid_pattern", creditsQuick: 3, creditsPower: 0 },
    racer: null as null | ((table: string) => void),
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => ({ choices: [{ message: { content: JSON.stringify({
    triggerEvents: [], painSignals: [], personalisationHooks: [], techStack: [], recentNews: [], industryEvents: [],
    linkedinSummary: "s", companyOneLiner: "c", inferredCompanyName: "", recommendedChannel: "email",
    recommendedTiming: { dayOfWeek: "Tue", hourOfDay: 9, timezone: "UTC" }, enrichmentConfidence: 50,
  }) } }] }),
}));
vi.mock("./services/quickenrich", async (a) => ({
  ...(await a<typeof import("./services/quickenrich")>()),
  getQuickEnrichKey: async () => "qe-test-key",
  quickenrichFindEmailByLinkedIn: async (_k: string, url: string) => { h.qe.push(url); return { ...h.qeAnswer }; },
}));
vi.mock("./services/scraper", async (a) => ({
  ...(await a<typeof import("./services/scraper")>()),
  resolveVerifiedEmail: async (i: { companyDomain: string }) => { h.finder.push(i.companyDomain); return { ...h.finderAnswer }; },
}));
vi.mock("./services/suppression", async (a) => ({ ...(await a<typeof import("./services/suppression")>()), suppressionBlockingNewEmail: async () => null }));
vi.mock("./services/research/downstreamAccounts", async (a) => ({ ...(await a<typeof import("./services/research/downstreamAccounts")>()), downstreamAccountFor: async () => null }));
vi.mock("./services/research/neverTarget", async (a) => ({ ...(await a<typeof import("./services/research/neverTarget")>()), campaignNeverTarget: async () => [] }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runEnrichAgent } from "./routers/are/prospects";

const WS = 2, FOREIGN = 9, ME = 20;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "me@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.qe = []; h.finder = []; h.racer = null;
  h.qeAnswer = { email: null, reason: "no_match", companyName: null, companyDomain: null };
  h.finderAnswer = { email: null, status: null, reason: "no_valid_pattern", creditsQuick: 3, creditsPower: 0 };
  h.db = makeSqlFakeDb({ roles: { [WS]: "manager" }, wsId: () => WS, beforeUpdate: (t) => h.racer?.(t) });
  rows("are_campaigns").push(
    { id: 5, workspaceId: WS, name: "C", status: "active", icpOverrides: {}, researchSectorId: null },
    { id: 6, workspaceId: WS, name: "C2", status: "active", icpOverrides: {}, researchSectorId: null },
  );
});

describe("1 · a step edit never undoes a concurrent edit of another step", () => {
  const seed = () => {
    rows("prospect_queue").push({ id: 40, workspaceId: WS, campaignId: 5, firstName: "Ann", lastName: "Lee", sequenceStatus: "approved" });
    rows("prospect_intelligence").push({
      id: 1, prospectQueueId: 40, workspaceId: WS, sequenceVersion: 0,
      generatedSequence: [{ stepIndex: 0, subject: "s0", body: "b0" }, { stepIndex: 1, subject: "s1", body: "b1" }],
    });
  };

  it("another save landing between the read and the write is kept, and this edit is applied on top", async () => {
    seed();
    let raced = false;
    h.racer = (t) => {
      if (t !== "prospect_intelligence" || raced) return;
      raced = true;
      // A colleague saves step 2 after this edit read the steps.
      const intel = rows("prospect_intelligence")[0];
      intel.generatedSequence = [intel.generatedSequence[0], { stepIndex: 1, subject: "s1", body: "colleague's step 2" }];
      intel.sequenceVersion = Number(intel.sequenceVersion) + 1;
    };
    const r = await caller().are.prospects.editSequenceStep({ prospectId: 40, arrayIndex: 0, body: "my step 1" });
    expect(r.success).toBe(true);
    const seq = rows("prospect_intelligence")[0].generatedSequence;
    expect(seq.map((s: any) => s.body)).toEqual(["my step 1", "colleague's step 2"]);
    expect(rows("prospect_intelligence")[0].sequenceVersion).toBe(2);
  });

  it("a sequence that keeps changing is refused with CONFLICT rather than overwritten", async () => {
    seed();
    h.racer = (t) => {
      if (t !== "prospect_intelligence") return;
      const intel = rows("prospect_intelligence")[0];
      intel.generatedSequence = [{ stepIndex: 0, subject: "s0", body: "regenerated" }, intel.generatedSequence[1]];
      intel.sequenceVersion = Number(intel.sequenceVersion) + 1;
    };
    await expect(caller().are.prospects.editSequenceStep({ prospectId: 40, arrayIndex: 1, body: "late" })).rejects.toThrow(/kept changing/);
    expect(rows("prospect_intelligence")[0].generatedSequence[1].body).toBe("b1");
  });

  it("every write of the steps bumps the version a step edit checks", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${__dirname}/routers/are/prospects.ts`, "utf8");
    const writes = src.split("generatedSequence: ").length - 1;
    const bumps = src.split("sequenceVersion: sql`${prospectIntelligence.sequenceVersion} + 1`").length - 1;
    // fixed copy, generated copy, and the step edit itself
    expect(bumps).toBe(3);
    expect(writes).toBeGreaterThanOrEqual(3);
  });
});

describe("2 · Add to list from a campaign never writes another workspace's list", () => {
  it("is refused, and nothing is added", async () => {
    rows("record_lists").push({ id: 70, workspaceId: FOREIGN, name: "Theirs", entityType: "people" });
    rows("prospects").push({ id: 300, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@example.com" });
    rows("prospect_queue").push({ id: 41, workspaceId: WS, campaignId: 5, firstName: "Ann", lastName: "Lee", email: "ann@example.com", personProspectId: 300, sequenceStatus: "pending" });
    await expect(caller().are.prospects.bulk({ campaignId: 5, prospectIds: [41], action: "addToList", listId: 70 } as never)).rejects.toThrow(/not in this workspace/);
    expect(rows("record_list_members")).toEqual([]);
  });
});

describe("3 · a paid email lookup that found nothing is not paid for again", () => {
  const queueRow = (id: number, campaignId: number, over: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, campaignId, firstName: "Ann", lastName: "Lee", email: null, linkedinUrl: "https://www.linkedin.com/in/ann-lee-123/",
    companyName: null, companyDomain: null, title: "CFO", industry: null, sourceType: "linkedin_people", enrichmentStatus: "pending",
    enrichAttempts: 0, sequenceStatus: "sourcing", personProspectId: null, updatedAt: new Date(), ...over,
  });

  it("QuickEnrich's empty answer for a profile is remembered, here and in another campaign", async () => {
    rows("prospect_queue").push(queueRow(50, 5));
    expect(await runEnrichAgent(50, WS)).toBe(true);
    expect(h.qe).toHaveLength(1);
    expect(rows("vendor_lookup_misses").map((m) => m.lookupKey)).toEqual(["qe:li:ann-lee-123"]);
    // Enrich again (a person's click): no second lookup.
    rows("prospect_queue")[0].enrichmentStatus = "pending";
    await runEnrichAgent(50, WS);
    // The same person in another campaign, by another URL shape: still remembered.
    rows("prospect_queue").push(queueRow(51, 6, { linkedinUrl: "linkedin.com/in/ann-lee-123" }));
    await runEnrichAgent(51, WS);
    expect(h.qe).toHaveLength(1);
    expect(rows("are_engine_logs").some((l) => /Did not pay to look up Ann Lee's email again: QuickEnrich/.test(String(l.message)))).toBe(true);
  });

  it("the finder's definitive miss is remembered; a failure that says nothing about the person is not", async () => {
    rows("prospect_queue").push(queueRow(52, 5, { linkedinUrl: null, companyDomain: "example.org" }));
    h.finderAnswer = { ...h.finderAnswer, reason: "reoon_key_missing" };
    await runEnrichAgent(52, WS);
    expect(rows("vendor_lookup_misses")).toEqual([]);
    rows("prospect_queue")[0].enrichmentStatus = "pending";
    h.finderAnswer = { ...h.finderAnswer, reason: "no_valid_pattern" };
    await runEnrichAgent(52, WS);
    expect(rows("vendor_lookup_misses").map((m) => m.lookupKey)).toEqual(["finder:ann|lee|example.org"]);
    rows("prospect_queue")[0].enrichmentStatus = "pending";
    await runEnrichAgent(52, WS);
    expect(h.finder).toEqual(["example.org", "example.org"]);
  });

  it("a miss older than 30 days is looked up again", async () => {
    rows("vendor_lookup_misses").push({ id: 1, workspaceId: WS, lookupKey: "qe:li:ann-lee-123", reason: "quickenrich:no_match", missedAt: new Date(Date.now() - 31 * 86_400_000) });
    rows("prospect_queue").push(queueRow(53, 5));
    await runEnrichAgent(53, WS);
    expect(h.qe).toHaveLength(1);
  });

  it("a no-email record that names the employer is not a miss: its domain feeds the finder", async () => {
    h.qeAnswer = { email: null, reason: "no_match", companyName: "Example", companyDomain: "example.org" };
    rows("prospect_queue").push(queueRow(54, 5));
    await runEnrichAgent(54, WS);
    expect(rows("vendor_lookup_misses").map((m) => m.lookupKey)).toEqual(["finder:ann|lee|example.org"]);
    expect(h.finder).toEqual(["example.org"]);
  });
});
