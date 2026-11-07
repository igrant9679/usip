/**
 * Segments on People (audit 2026-10-20, P21 and F42, batch RESB), against the
 * real routers and the SQL fake.
 *
 *   the People field map   a new segment reads People: its fields (company,
 *                          industry, state, country added), archived people
 *                          left out, "Is primary contact" refused
 *   moved segments         keep every rule; a rule People have no field for
 *                          is flagged, enrols no one, and must go before save
 *   members                a paged members page of People, in the columns the
 *                          page already shows; Refresh counts on People
 *   auto-enrol             enrols People; the dry run says would enrol X, Y
 *                          already enrolled, Z blocked, and writes nothing;
 *                          turning a moved rule on clears its "moved" mark;
 *                          nothing is enrolled while outbound is paused
 *   the migration          switches every rule off before moving segments,
 *                          touches only rows still on contacts, and new
 *                          segments default to People
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/crossEngineEnrollment", async (a) => ({
  ...(await a<typeof import("./services/crossEngineEnrollment")>()),
  // Person 6 is being worked by a campaign.
  activeCampaignsForProspects: async (_ws: number, ids: number[]) => new Map(ids.filter((id) => id === 6).map((id) => [id, [1]])),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runSegmentEnrollmentForWorkspace } from "./routers/segmentRules";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { invalidateSendWindowCache } from "./services/sendWindow";
import { CONTACT_TO_PEOPLE_FIELD, PEOPLE_SEGMENT_FIELDS, SEGMENT_FIELDS, unmappedRules } from "@shared/segmentRules";
import { dryRunLine, turnOnSummary, wouldEnrolLine } from "../client/src/lib/segmentAutoEnrol";

const WS = 2, OTHER = 9;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const caller = (role = "admin") => {
  h.db.__role = role;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
};
const person = (id: number, o: Record<string, unknown> = {}) => rows("prospects").push({
  id, workspaceId: WS, firstName: `P${id}`, lastName: "Lee", title: "VP Sales", company: "Acme", industry: "Software", state: "TX", country: "US",
  email: `p${id}@acme.example`, emailStatus: "valid", verificationStatus: "verified", linkedinUrl: null, companyDomain: null,
  createdAt: new Date("2026-10-01T12:00:00Z"), ...o,
});
const vp = { id: "r1", field: "title", operator: "contains", value: "vp" };

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  _clearWorkspaceTimezoneCache();
  invalidateSendWindowCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
});

describe("a new segment reads People, through the People field map (P21, F42)", () => {
  it("counts People with People's fields, leaves archived people out, and refuses a contact-only field", async () => {
    person(1); person(2, { industry: "Retail" }); person(3, { verificationStatus: "rejected" }); person(4, { title: "Analyst" });
    person(5, { verificationStatus: null });
    rows("prospects").push({ id: 99, workspaceId: OTHER, firstName: "X", lastName: "Y", title: "VP", verificationStatus: null });
    // A CRM contact matching the rule is not a member of a People segment.
    rows("contacts").push({ id: 50, workspaceId: WS, firstName: "C", lastName: "C", title: "VP", email: "c@x.example" });

    const { id, count } = await caller().segments.create({ name: "Software VPs", matchType: "all", rules: [vp, { id: "r2", field: "industry", operator: "equals", value: "software" }] });
    expect(count).toBe(2); // 1 and 5; 2 is Retail, 3 archived, 4 an analyst
    expect(row("audience_segments", id)).toMatchObject({ subject: "people", contactCount: 2 });
    for (const field of ["company", "state", "country"]) {
      const r = await caller().segments.evaluate({ rules: [{ id: "x", field: field as any, operator: "is_not_empty", value: "" }], matchType: "all" });
      // 1, 2, 4 and 5: everyone but the archived one.
      expect(r, field).toMatchObject({ subject: "people", count: 4 });
    }
    await expect(caller().segments.create({ name: "P", matchType: "all", rules: [{ id: "p", field: "isPrimary", operator: "equals", value: "true" }] }))
      .rejects.toThrow(/contact field People don't have/);
  });

  it("the field map: every contact field but one has its People field, and Email status is People's", () => {
    for (const [contactField, peopleField] of Object.entries(CONTACT_TO_PEOPLE_FIELD)) {
      expect(SEGMENT_FIELDS[contactField], contactField).toBeDefined();
      if (peopleField) expect(PEOPLE_SEGMENT_FIELDS[peopleField], contactField).toBe(SEGMENT_FIELDS[contactField]);
    }
    expect(Object.entries(CONTACT_TO_PEOPLE_FIELD).filter(([, v]) => v === null).map(([k]) => k)).toEqual(["isPrimary"]);
    expect(read("server/services/segmentSql.ts")).toContain("emailVerificationStatus: prospects.emailStatus, createdAt: prospects.createdAt,");
  });
});

describe("a moved segment keeps its rules, and one People can't read is flagged (P21)", () => {
  beforeEach(() => {
    person(1); person(2);
    rows("audience_segments").push({
      id: 5, workspaceId: WS, name: "Primary VPs", matchType: "all", subject: "people", movedToPeopleAt: new Date(), contactCount: null,
      rules: [vp, { id: "r9", field: "isPrimary", operator: "equals", value: "true" }],
    });
  });

  it("lists the flag, enrols no one from it, and refuses to save it until the rule goes", async () => {
    const [seg] = await caller().segments.list();
    expect(seg.unmapped.map((r: any) => r.field)).toEqual(["isPrimary"]);
    expect(seg.unmappedNote).toBe("Is primary contact is not a field People have");
    expect(unmappedRules(seg.rules as any, "contacts")).toEqual([]);
    // Kept as saved.
    expect((row("audience_segments", 5).rules as any[]).map((r) => r.field)).toEqual(["title", "isPrimary"]);

    rows("sequences").push({ id: 3, workspaceId: WS, name: "S", status: "active" });
    const p = await caller().segmentRules.preview({ segmentId: 5, sequenceId: 3 });
    expect(p).toMatchObject({ wouldEnrol: 0, refused: expect.stringContaining("Is primary contact is not a field People have") });

    await expect(caller().segments.update({ id: 5, name: "Primary VPs", matchType: "all", rules: [vp, { id: "r9", field: "isPrimary", operator: "equals", value: "true" }] }))
      .rejects.toThrow(/contact field People don't have/);
    await caller().segments.update({ id: 5, name: "VPs", matchType: "all", rules: [vp] });
    expect(row("audience_segments", 5)).toMatchObject({ contactCount: 2, rules: [vp] });
  });
});

describe("a paged members page of People, and Refresh counts on People (F42)", () => {
  it("pages People newest first in the page's columns, and Refresh recounts each segment on its own table", async () => {
    for (let i = 1; i <= 60; i++) person(i);
    person(61, { title: "Analyst" });
    rows("audience_segments").push({ id: 5, workspaceId: WS, name: "VPs", matchType: "all", subject: "people", rules: [vp], contactCount: 0 });
    // A segment never moved still counts contacts.
    rows("contacts").push({ id: 1, workspaceId: WS, firstName: "C", lastName: "C", title: "VP", email: "c@x.example" });
    rows("audience_segments").push({ id: 6, workspaceId: WS, name: "Old", matchType: "all", rules: [vp], contactCount: 0 });

    const p1 = await caller().segments.getContacts({ id: 5, perPage: 50 });
    expect(p1).toMatchObject({ subject: "people", total: 60, page: 1 });
    expect(p1.rows).toHaveLength(50);
    expect(p1.rows[0]).toMatchObject({ id: 60, personProspectId: 60, companyName: "Acme", emailVerificationStatus: "valid" });
    expect(Object.keys(p1.rows[0]).sort()).toEqual(["companyName", "createdAt", "email", "emailVerificationStatus", "firstName", "id", "lastName", "personProspectId", "title"]);
    const p2 = await caller().segments.getContacts({ id: 5, page: 2, perPage: 50 });
    expect(p2.rows.map((r: any) => r.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

    await caller().segments.refresh({});
    expect(row("audience_segments", 5).contactCount).toBe(60);
    expect(row("audience_segments", 6).contactCount).toBe(1);
  });
});

describe("auto-enrol on People, with a dry run first (P21, F42)", () => {
  beforeEach(() => {
    person(1); person(2); person(3);
    person(4, { email: null });                    // no address: blocked
    person(5);                                      // already enrolled
    person(6);                                      // in a campaign: blocked
    person(7, { email: "gone@acme.example" });      // suppressed: blocked
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "gone@acme.example", reason: "unsubscribe" });
    rows("audience_segments").push({ id: 5, workspaceId: WS, name: "VPs", matchType: "all", subject: "people", rules: [vp] });
    rows("sequences").push({ id: 3, workspaceId: WS, name: "Intro", status: "active" });
    rows("enrollments").push({ id: 900, workspaceId: WS, sequenceId: 3, prospectId: 5, contactId: null, leadId: null, status: "active" });
    rows("segment_sequence_rules").push({ id: 1, workspaceId: WS, segmentId: 5, sequenceId: 3, enabled: false, offReason: "moved_to_people", enrolledCount: 0 });
  });

  it("the dry run says who would be enrolled, who already is and who is blocked, and enrols no one", async () => {
    const p = await caller().segmentRules.preview({ segmentId: 5, sequenceId: 3 });
    expect(p).toMatchObject({ subject: "people", exact: true, matched: 7, wouldEnrol: 3, alreadyEnrolled: 1, blocked: { invalidEmail: 1, inCampaign: 1, suppressed: 1 } });
    expect(p.sample.map((s: any) => s.name).sort()).toEqual(["P1 Lee", "P2 Lee", "P3 Lee"]);
    expect(rows("enrollments")).toHaveLength(1);
    expect(dryRunLine(p as any)).toBe("Would enrol 3 people · 1 already enrolled · 3 blocked: 1 with no usable address, 1 in a campaign, 1 suppressed");
    expect(wouldEnrolLine(p as any)).toContain("3 people would be enrolled");
    expect(turnOnSummary(p as any).title).toBe("Enrol 3 people?");
  });

  it("turning the moved rule on needs the confirmed count, clears its mark, and the hourly run enrols the People", async () => {
    await expect(caller().segmentRules.save({ id: 1, segmentId: 5, sequenceId: 3, enabled: true })).rejects.toThrow(/would enrol up to 3 people/);
    await caller().segmentRules.save({ id: 1, segmentId: 5, sequenceId: 3, enabled: true, confirmedWouldEnrol: 3 });
    expect(row("segment_sequence_rules", 1)).toMatchObject({ enabled: true, offReason: null });
    const listed = await caller().segmentRules.list();
    expect(listed[0]).toMatchObject({ segmentSubject: "people" });

    const r = await runSegmentEnrollmentForWorkspace(WS);
    expect(r).toMatchObject({ enrolled: 3, peopleSkipped: 4 });
    const added = rows("enrollments").filter((e) => e.id !== 900);
    expect(added.map((e) => e.prospectId).sort()).toEqual([1, 2, 3]);
    expect(added.every((e) => e.contactId == null)).toBe(true);
    expect(row("segment_sequence_rules", 1).lastRunSummary).toMatchObject({ matched: 7, enrolled: 3, subject: "people" });
  });

  it("enrols no one while outbound is paused, and says so on each rule", async () => {
    row("segment_sequence_rules", 1).enabled = true;
    rows("workspace_settings").push({ workspaceId: WS, outboundPausedAt: new Date() });
    invalidateSendWindowCache(WS);
    const r = await runSegmentEnrollmentForWorkspace(WS);
    expect(r).toMatchObject({ enrolled: 0, rulesRefused: 1 });
    expect(rows("enrollments")).toHaveLength(1);
    expect(row("segment_sequence_rules", 1).lastRunSummary.refused).toMatch(/paused/i);
  });
});

describe("the migration moves segments and switches their rules off first (P21)", () => {
  const block = () => {
    const src = read("server/_core/rawMigrations.ts");
    const from = src.indexOf('name: "0363_segments_on_people.sql"');
    expect(from).toBeGreaterThan(-1);
    return src.slice(from, src.indexOf("],", from));
  };

  it("every rule on a contacts segment goes off, marked, before any segment moves; both touch only rows still on contacts", () => {
    const m = block();
    const off = "UPDATE `segment_sequence_rules` SET `enabled` = 0, `offReason` = 'moved_to_people' WHERE `enabled` = 1 AND `segmentId` IN (SELECT `id` FROM `audience_segments` WHERE `subject` = 'contacts')";
    const move = "UPDATE `audience_segments` SET `subject` = 'people', `movedToPeopleAt` = NOW(), `contactCount` = NULL, `lastEvaluatedAt` = NULL WHERE `subject` = 'contacts'";
    expect(m).toContain(off);
    expect(m).toContain(move);
    const before = m.slice(0, m.indexOf(move));
    expect(before).toContain(off);
    // Existing rows start as contacts, new ones default to People afterwards.
    expect(m).toContain("ALTER TABLE `audience_segments` ADD COLUMN `subject` varchar(16) NOT NULL DEFAULT 'contacts'");
    expect(m.slice(m.indexOf(move))).toContain("ALTER TABLE `audience_segments` ALTER COLUMN `subject` SET DEFAULT 'people'");
    // Nothing turns a rule ON.
    expect(m).not.toMatch(/`enabled` = 1,|SET `enabled` = 1/);
  });

  it("the schema mirrors it", () => {
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('subject: varchar("subject", { length: 16 }).default("people").notNull(),');
    expect(schema).toContain('offReason: varchar("offReason", { length: 32 }),');
  });
});

describe("the screens say People and offer the dry run (P21, F42)", () => {
  it("Segments: People fields, the unmapped warning, the subject-aware counts and members page", () => {
    const seg = read("client/src/pages/usip/Segments.tsx");
    expect(seg).toContain('{ value: "company", label: "Company", type: "text" },');
    expect(seg).toContain("is a contact field People don't have. This rule was kept when the segment moved to People");
    expect(seg).toContain('? seg.contactCount == null ? "Not counted on People yet"');
    expect(seg).toContain("{seg.unmappedNote}: edit this segment before it is used.");
    expect(seg).toContain('"This segment reads People. Archived people are left out."');
    expect(seg).toContain("evalMut.mutate({ rules: form.rules, matchType: form.matchType, ...(initial ? { segmentId: initial.id } : {}) });");
  });

  it("Auto-Enroll: a Dry run on each rule, and a moved rule says why it is off", () => {
    const sr = read("client/src/pages/usip/SegmentRules.tsx");
    expect(sr).toContain('<Button size="sm" variant="ghost" className="text-xs" onClick={() => void runDry(rule)}>Dry run</Button>');
    expect(sr).toContain("await utils.segmentRules.preview.fetch({ segmentId: rule.segmentId, sequenceId: rule.sequenceId }, { staleTime: 0 });");
    expect(sr).toContain('rule.offReason === "moved_to_people"');
    expect(sr).toContain("{dryRunLine(dryRun.result)}");
    expect(sr).toContain("A dry run enrols no one.");
  });
});
