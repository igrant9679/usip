/**
 * The writers of a person's email, run for real.
 *
 * Most of this file is P86 (audit 2026-10-20): no enrichment path makes a
 * suppressed person mailable again. At the end, two sweeper gaps found in the
 * same writers: a pattern-pass find never reached People (P82), and a People
 * row holding an empty-string address was never swept (P83).
 *
 * Suppression is keyed by what was suppressed — an address, a LinkedIn
 * profile, a domain — and every send checks the address it is about to use.
 * So replacing an unsubscribed address with a newly found one put the person
 * on no list at all. Each writer of a person's email is run here for real,
 * against the in-memory database, with the vendors mocked:
 *
 *   the comprehensive pass · mergeIntoPerson (the ARE agent's, the sweeper's
 *   and the sync's write-back) · the person link (a queue row matched by
 *   LinkedIn) · the sweeper's QuickEnrich and pattern passes · the ARE enrich
 *   agent (by source: it needs an LLM to run).
 *
 * Each has a control: a bounce is about the address, not the person, so a
 * bounced address may still be replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ db: null as any }));
const v = vi.hoisted(() => ({
  qe: vi.fn(),
  qeKey: vi.fn(),
  reoonKey: vi.fn(),
  reoonVerify: vi.fn(),
  balance: vi.fn(),
  resolve: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/quickenrich", () => ({ getQuickEnrichKey: v.qeKey, quickenrichFindEmailByLinkedIn: v.qe }));
vi.mock("./services/reoon", async (a) => ({
  ...(await a<typeof import("./services/reoon")>()),
  getReoonKey: v.reoonKey,
  reoonVerifySingle: v.reoonVerify,
  reoonCheckBalance: v.balance,
}));
vi.mock("./services/scraper", () => ({ resolveVerifiedEmail: v.resolve, lookupContactInfo: v.lookup }));
vi.mock("./services/prospectPromotion", () => ({ promoteProspectRow: async () => ({ promoted: false }) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { runComprehensiveEnrichment } from "./services/enrichment/comprehensivePass";
import { mergeIntoPerson, upsertPersonForRow } from "./services/personLink";
import { sweepWorkspace } from "./services/enrichmentSweeper";

const WS = 3;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const person = (id = 40) => rows("prospects").find((p) => p.id === id);
const queueRow = (id: number) => rows("prospect_queue").find((q) => q.id === id);

function seedPerson(over: Record<string, unknown> = {}) {
  rows("prospects").push({
    id: 40, workspaceId: WS, firstName: "Dana", lastName: "Reyes",
    email: "dana@oldco.com", emailStatus: null, linkedinUrl: "https://www.linkedin.com/in/dana-reyes",
    company: "Oldco", companyDomain: "oldco.com", title: "CFO", phone: "+15550100",
    enrichmentData: { scraped: true }, fieldProvenance: null, verificationStatus: null, catchAllEmail: null,
    ...over,
  });
}
const unsubscribe = (email: string, reason = "unsubscribe") =>
  rows("email_suppressions").push({ id: rows("email_suppressions").length + 1, workspaceId: WS, email, reason });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  vi.resetAllMocks();
  v.qeKey.mockResolvedValue("qk");
  v.reoonKey.mockResolvedValue("rk");
  v.balance.mockResolvedValue({ remaining_daily_credits: 5000 });
  v.reoonVerify.mockResolvedValue({ status: "safe" });
  v.qe.mockResolvedValue({ email: "dana@newco.com", reason: "found" });
  v.resolve.mockResolvedValue({ email: "dana@newco.com", status: "valid", creditsQuick: 1, creditsPower: 1 });
  v.lookup.mockResolvedValue(null);
});

const comprehensive = () =>
  runComprehensiveEnrichment({ workspaceId: WS, prospectId: 40, userId: 1, trigger: "test", queueLinkedInJob: false });

describe("the comprehensive pass", () => {
  it("leaves an unsubscribed person's address alone and spends nothing finding another", async () => {
    seedPerson();
    unsubscribe("dana@oldco.com");

    const r = await comprehensive();

    expect(person().email).toBe("dana@oldco.com");
    expect(r.email).toBe("dana@oldco.com");
    expect(v.qe).not.toHaveBeenCalled();
    expect(v.resolve).not.toHaveBeenCalled();
    expect(r.phases.quickenrich).toMatch(/address is on the email suppression list \(unsubscribe\)/);
    // The rest of the record still enriches: the pass is not refused outright.
    expect(person().lastEnrichedAt).toBeInstanceOf(Date);
  });

  it("finds no first address for someone whose LinkedIn profile is on the do-not-contact list", async () => {
    seedPerson({ email: null });
    rows("are_suppression_list").push({ id: 1, workspaceId: WS, email: null, linkedinUrl: "https://www.linkedin.com/in/dana-reyes", companyDomain: null, reason: "do_not_contact" });

    await comprehensive();

    expect(person().email).toBeNull();
    expect(v.qe).not.toHaveBeenCalled();
  });

  it("control: a bounced address is still replaced — a bounce is about the address, not the person", async () => {
    seedPerson();
    unsubscribe("dana@oldco.com", "bounce");

    await comprehensive();

    expect(person().email).toBe("dana@newco.com");
  });
});

describe("mergeIntoPerson, the write-back behind the ARE agent, the sweeper and the sync", () => {
  it("does not change a suppressed person's address, and still merges the rest", async () => {
    // The address on file as typed; the list holds it normalised, as every writer stores it.
    seedPerson({ title: null, email: "Dana@OldCo.com " });
    unsubscribe("dana@oldco.com");

    await mergeIntoPerson(WS, 40, { email: "dana@newco.com", emailVerification: "valid", title: "Finance Director", source: "test" });

    expect(person().email).toBe("Dana@OldCo.com ");
    expect(person().title).toBe("Finance Director");
  });

  it("control: an unsuppressed person's address is replaced by a verified find", async () => {
    seedPerson();

    await mergeIntoPerson(WS, 40, { email: "dana@newco.com", emailVerification: "valid", source: "test" });

    expect(person().email).toBe("dana@newco.com");
  });
});

describe("the person link", () => {
  const row = { id: 9, campaignId: 1, sourceType: "linkedin", firstName: "Dana", lastName: "Reyes",
    email: "dana@newco.com", linkedinUrl: "https://linkedin.com/in/dana-reyes", phone: null, title: null,
    companyName: null, companyDomain: null };
  // Matched through the LinkedIn tier: the enrichment table's profile identifier.
  const linkProfile = () => rows("prospect_linkedin_enrichments").push({
    id: 1, workspaceId: WS, prospectId: 40, linkedinProfileUrl: "https://www.linkedin.com/in/dana-reyes", linkedinProfileIdentifier: "dana-reyes",
  });

  it("a queue row matched on LinkedIn does not carry a new address onto a suppressed person", async () => {
    seedPerson({ fieldProvenance: { email: { source: "scrape", confidence: 10, at: "2020-01-01T00:00:00.000Z" } } });
    unsubscribe("dana@oldco.com", "spam_complaint");
    linkProfile();

    const r = await upsertPersonForRow(WS, row, { source: "test", confidence: 95 });

    expect(r?.personId).toBe(40);
    expect(person().email).toBe("dana@oldco.com");
  });

  it("control: the same row replaces the address of a person nobody suppressed", async () => {
    seedPerson({ fieldProvenance: { email: { source: "scrape", confidence: 10, at: "2020-01-01T00:00:00.000Z" } } });
    linkProfile();

    await upsertPersonForRow(WS, row, { source: "test", confidence: 95 });

    expect(person().email).toBe("dana@newco.com");
  });
});

describe("the enrichment sweeper", () => {
  function seedQueue(over: Record<string, unknown>) {
    rows("are_campaigns").push({ id: 1, workspaceId: WS, name: "Renewals" });
    rows("workspace_settings").push({ workspaceId: WS });
    rows("prospect_queue").push({
      id: 70, workspaceId: WS, campaignId: 1, firstName: "Dana", lastName: "Reyes", email: null,
      companyName: null, companyDomain: null, linkedinUrl: "https://www.linkedin.com/in/dana-r",
      enrichedAt: null, enrichmentError: null, sequenceStatus: null, personProspectId: 40,
      ...over,
    });
  }

  it("the QuickEnrich pass skips a row whose People record is unsubscribed, before spending", async () => {
    seedPerson();
    unsubscribe("dana@oldco.com");
    seedQueue({});

    const r = await sweepWorkspace(WS);

    expect(v.qe).not.toHaveBeenCalled();
    expect(queueRow(70).email).toBeNull();
    expect(queueRow(70).enrichmentError).toMatch(/^quickenrich: skipped — address is on the email suppression list/);
    expect(r.suppressedSkipped).toBe(1);
  });

  it("the pattern pass skips such a row too, and stamps it so the next run passes it over", async () => {
    seedPerson();
    unsubscribe("dana@oldco.com");
    seedQueue({ companyDomain: "newco.com", linkedinUrl: null });

    await sweepWorkspace(WS);

    expect(v.resolve).not.toHaveBeenCalled();
    expect(queueRow(70).email).toBeNull();
    expect(queueRow(70).enrichedAt).toBeInstanceOf(Date);
  });

  it("control: with a bounce on the People address, the pattern pass finds and writes one", async () => {
    seedPerson();
    unsubscribe("dana@oldco.com", "bounce");
    seedQueue({ companyDomain: "newco.com", linkedinUrl: null });

    await sweepWorkspace(WS);

    expect(v.resolve).toHaveBeenCalledTimes(1);
    expect(queueRow(70).email).toBe("dana@newco.com");
  });

  it("P82: a pattern-pass find reaches the People row, through the merge, with its verdict", async () => {
    seedPerson({ email: null });
    seedQueue({ companyDomain: "newco.com", linkedinUrl: null });

    await sweepWorkspace(WS);

    // The write-back is fire-and-forget, as the QuickEnrich pass's is.
    await vi.waitFor(() => expect(person().email).toBe("dana@newco.com"));
    expect(person().emailStatus).toBe("valid");
    expect(person().fieldProvenance?.email?.source).toBe("enrichment_sweeper_pattern");
  });

  it("P83: a People row whose address is an empty string is swept", async () => {
    // No queue rows: only the People pass can find this person.
    rows("workspace_settings").push({ workspaceId: WS });
    seedPerson({ email: "", enrichmentData: null, lastEnrichedAt: null, phone: "+15550100" });

    const r = await sweepWorkspace(WS);

    expect(r.fromProspects).toBe(1);
    expect(person().email).toBe("dana@newco.com");
  });
});

describe("the ARE enrich agent (by source — it needs a model to run)", () => {
  const src = readFileSync(join(__dirname, "routers/are/prospects.ts"), "utf8");
  const block = src.slice(src.indexOf("── Email acquisition"), src.indexOf("// Update prospect with ICP score"));

  it("asks before it looks for an address, by person, and fails closed", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("await suppressionBlockingNewEmail(workspaceId, {");
    expect(block).toContain("personProspectId: prospect.personProspectId");
    expect(block).toContain(`.catch(() => "unchecked")`);
    expect(block).toContain("if (!prospect.email && !emailBlocked) {");
  });
});
