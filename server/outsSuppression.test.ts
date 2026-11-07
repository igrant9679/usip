/**
 * Suppression by person, and the list as CSV (audit 2026-10-20, F7 and F27).
 *
 * F7: suppression was keyed only by address, LinkedIn profile or domain, so a
 * person who said no was mailable again at a new address (a merge, an edit,
 * enrichment). Each opt-out now carries the People row where it is known, and
 * every check that knows whose address it is asks by person too.
 *
 * F27: the page could only show 50 at a time and had no way in or out; it
 * now exports the filtered list and imports a CSV. (Server-side search
 * already landed with O53; obSuppressionsSearch pins it.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, sent: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "" }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: async (input: unknown) => { h.sent.push(input); return { messageId: "m1" }; } }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { describeSuppression, findSuppression, suppressionBlockingNewEmail, suppressionPersonId } from "./services/suppression";
import { readReason, readSuppressionCsv, recordUnsubscribeByToken } from "./routers/emailSuppressions";
import { deliverEmailDraft } from "./routers/sequences";
import { PERSON_REF_TABLES } from "./services/personMerge";

const WS = 2;
const OTHER = 4;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}

function fresh(role = "admin") {
  h.db = makeSqlFakeDb({ roles: { [WS]: role }, wsId: () => WS });
  h.sent = [];
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "A", email: "a@lsi.example", emailSignature: null });
  rows("prospects").push(
    { id: 301, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann.new@acme.example", linkedinUrl: null, companyDomain: null },
    { id: 302, workspaceId: WS, firstName: "Bo", lastName: "Ng", email: null, linkedinUrl: "https://www.linkedin.com/in/bo-ng", companyDomain: null },
    { id: 303, workspaceId: WS, firstName: "Cy", lastName: "Oh", email: "cy@acme.example", linkedinUrl: null, companyDomain: null },
    { id: 901, workspaceId: OTHER, firstName: "X", lastName: "Y", email: "cy@acme.example", linkedinUrl: null, companyDomain: null },
  );
}
beforeEach(() => fresh());

/* ── F7: the check asks by person ───────────────────────────────────────── */

describe("an opt-out follows the person to a new address (F7)", () => {
  it("matches a suppression recorded against the person, whatever address is asked", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann.old@acme.example", reason: "unsubscribe", prospectId: 301 });
    expect(await findSuppression(WS, { email: "ann.new@acme.example" }, "email")).toBeNull(); // by address alone: missed
    const hit = await findSuppression(WS, { email: "ann.new@acme.example", personId: 301 }, "email");
    expect(hit).toEqual({ list: "email_suppressions", matched: "person", reason: "unsubscribe" });
    expect(describeSuppression(hit!)).toBe("person is on the email suppression list (unsubscribe)");
    expect(await findSuppression(WS, { personId: 301 }, "linkedin")).not.toBeNull(); // every channel
  });

  it("never by person for a bounce, nor across workspaces", async () => {
    rows("email_suppressions").push(
      { id: 1, workspaceId: WS, email: "ann.old@acme.example", reason: "bounce", prospectId: 301 },
      { id: 2, workspaceId: OTHER, email: "z@acme.example", reason: "unsubscribe", prospectId: 303 },
    );
    expect(await findSuppression(WS, { email: "ann.new@acme.example", personId: 301 }, "email")).toBeNull();
    expect(await findSuppression(WS, { personId: 303 }, "any")).toBeNull();
  });

  it("the do-not-contact list matches by person too, with no address on the row", async () => {
    rows("are_suppression_list").push({ id: 1, workspaceId: WS, email: null, linkedinUrl: null, companyDomain: null, reason: "do_not_contact", prospectId: 302 });
    expect(await findSuppression(WS, { email: "bo@new.example", personId: 302 }, "email")).toMatchObject({ list: "are_suppression_list", matched: "person" });
  });

  it("enrichment may not give a person who said no a new address", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann.old@acme.example", reason: "spam_complaint", prospectId: 301 });
    expect(await suppressionBlockingNewEmail(WS, { email: null, personProspectId: 301 })).toMatchObject({ matched: "person" });
  });

  it("a draft to the person at a new address is not sent", async () => {
    rows("sending_accounts").push({ id: 1, workspaceId: WS, name: "Box", fromEmail: "rep@lsi.example", fromName: "Rep", enabled: true, provider: "smtp", unipileAccountId: null });
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann.old@acme.example", reason: "unsubscribe", prospectId: 301 });
    rows("email_drafts").push({ id: 50, workspaceId: WS, subject: "Hi", body: "Hi", toProspectId: 301, toEmail: "ann.new@acme.example", status: "approved", createdByUserId: 1, sequenceId: null, enrollmentId: null, aiGenerated: false });
    const e = await refusal(deliverEmailDraft({ workspaceId: WS, userId: 1, draftId: 50, claimFrom: ["approved"] }));
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(h.sent).toEqual([]);
    expect(rows("email_drafts")[0].status).toBe("rejected");
  });

  it("every check that knows whose address it is passes the person", () => {
    const engine = read("server/sequenceEngine.ts");
    expect(engine).toContain("{ email: toEmail, linkedinUrl, companyDomain, personId }, \"email\")");
    expect(engine).toContain("personId: enrollment.prospectId ?? personProspectId ?? null }, \"linkedin\")");
    const are = read("server/areEngine.ts");
    for (const v of ["row", "lp", "p"]) expect(are).toContain(`personId: ${v}.personProspectId ?? null }`);
    expect(read("server/services/are/pushPeople.ts")).toContain("personId: p.id }, \"any\")");
    expect(read("server/websiteTracking.ts")).toContain("personId: contacts.personProspectId");
    const seq = readFileSync(join(root, "server/routers/sequences.ts"), "latin1");
    expect(seq).toContain("findSuppression(workspaceId, { email: toEmail, personId: recipient.personId }, \"email\")");
  });
});

/* ── F7: writers record the person ──────────────────────────────────────── */

describe("each opt-out records the person where it is known (F7)", () => {
  it("finds the person from a People id, a campaign row, a contact, or the address — never for a bounce", async () => {
    rows("prospect_queue").push({ id: 7, workspaceId: WS, personProspectId: 302 });
    rows("contacts").push({ id: 8, workspaceId: WS, personProspectId: 303, email: "c@x.example" });
    expect(await suppressionPersonId(WS, { prospectId: 301 })).toBe(301);
    expect(await suppressionPersonId(WS, { prospectId: 901 })).toBeNull(); // another workspace's row
    expect(await suppressionPersonId(WS, { prospectQueueId: 7 })).toBe(302);
    expect(await suppressionPersonId(WS, { contactId: 8 })).toBe(303);
    expect(await suppressionPersonId(WS, { email: " CY@acme.example " })).toBe(303);
    expect(await suppressionPersonId(WS, { reason: "bounce", prospectId: 301 })).toBeNull();
  });

  it("an unsubscribe link records the draft's person", async () => {
    rows("email_drafts").push({ id: 60, workspaceId: WS, toEmail: "ann.new@acme.example", toProspectId: 301, toContactId: null, trackingToken: "tok-60" });
    await recordUnsubscribeByToken("tok-60");
    expect(rows("email_suppressions")[0]).toMatchObject({ email: "ann.new@acme.example", reason: "unsubscribe", prospectId: 301 });
  });

  it("adding one by hand finds the person with that address, except for a bounce", async () => {
    await caller().emailSuppressions.add({ email: "cy@acme.example", reason: "manual" });
    await caller().emailSuppressions.add({ email: "cy@acme.example", reason: "bounce" });
    const [manual, bounce] = rows("email_suppressions");
    expect(manual.prospectId).toBe(303);
    expect(bounce.prospectId).toBeNull();
  });

  it("opting out People records each person, and puts someone with no address on the do-not-contact list by person", async () => {
    const r = await caller().emailSuppressions.addByProspects({ prospectIds: [301, 302] });
    expect(r).toMatchObject({ suppressed: 2, byPersonOnly: 1 });
    expect(rows("email_suppressions")[0]).toMatchObject({ email: "ann.new@acme.example", prospectId: 301 });
    expect(rows("are_suppression_list")[0]).toMatchObject({ prospectId: 302, reason: "do_not_contact", linkedinUrl: "https://www.linkedin.com/in/bo-ng" });
    expect(await findSuppression(WS, { personId: 302 }, "linkedin")).not.toBeNull();
  });

  it("the other writers pass the person, and a merge carries it", () => {
    expect(read("server/unsubscribe.ts")).toContain('suppressionPersonId(workspaceId, { reason: "unsubscribe", email: lower })');
    expect(read("server/services/replyClassifier.ts")).toContain("prospectId: await suppressionPersonId(workspaceId, {");
    const exec = read("server/routers/are/execution.ts");
    expect(exec).toContain("prospectId: prospect.personProspectId ?? null,");
    expect(exec).toContain('prospectId: signalType === "email_bounce" ? null : prospect.personProspectId ?? null,');
    expect(read("server/routers/are/prospectsBulk.ts")).toContain('prospectId: siteReason === "bounce" ? null : r.personProspectId ?? null,');
    expect(read("server/emailTracking.ts")).toContain('prospectId: suppressionReason === "bounce" ? null : await suppressionPersonId(workspaceId, {');
    const keys = PERSON_REF_TABLES.map((t) => t.key);
    expect(keys).toContain("emailSuppressions.prospectId");
    expect(keys).toContain("areSuppressionList.prospectId");
  });

  it("migration 0341 adds the columns and fills them, bounces left by address, idempotently", () => {
    const m = read("server/_core/rawMigrations.ts");
    const block = m.slice(m.indexOf('name: "0341_suppression_person.sql"'), m.indexOf("],", m.indexOf('name: "0341_suppression_person.sql"')));
    expect(block).toContain("ALTER TABLE `email_suppressions` ADD COLUMN `prospectId` int NULL");
    expect(block).toContain("ALTER TABLE `are_suppression_list` ADD COLUMN `prospectId` int NULL");
    const updates = block.split("\n").filter((l) => l.includes("UPDATE"));
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u).toContain("`prospectId` IS NULL");
      expect(u).toContain("<> 'bounce'");
    }
  });

  it("the page names the person an opt-out follows", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann.old@acme.example", reason: "unsubscribe", prospectId: 301, createdAt: new Date() });
    const [row] = await caller().emailSuppressions.list({ reason: "all", limit: 50, offset: 0 });
    expect(row.personName).toBe("Ann Lee");
    expect(read("client/src/pages/usip/EmailSuppressions.tsx")).toContain("Person: {row.personName || `#${row.prospectId}`}");
  });
});

/* ── F27: CSV export and import ─────────────────────────────────────────── */

describe("the list exports to CSV (F27)", () => {
  beforeEach(() => {
    rows("email_suppressions").push(
      { id: 1, workspaceId: WS, email: "a@x.example", reason: "unsubscribe", source: "link_confirmed", notes: "=HYPERLINK(\"x\")", prospectId: null, createdAt: new Date("2026-11-01T00:00:00Z") },
      { id: 2, workspaceId: WS, email: "b@x.example", reason: "bounce", source: null, notes: null, prospectId: null, createdAt: new Date("2026-11-02T00:00:00Z") },
      { id: 3, workspaceId: OTHER, email: "c@x.example", reason: "unsubscribe", source: null, notes: null, prospectId: null, createdAt: new Date() },
    );
  });

  it("every row of the filter, this workspace only, newest first, with spreadsheet-safe cells", async () => {
    const all = await caller().emailSuppressions.exportCsv({ reason: "all" });
    const lines = all.csv.trim().split("\r\n");
    expect(lines[0]).toBe("email,reason,source,notes,person_id,created_at");
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["b@x.example", "a@x.example"]);
    expect(all.csv).toContain("'=HYPERLINK");
    expect(all).toMatchObject({ count: 2, truncated: false });
    const bounces = await caller().emailSuppressions.exportCsv({ reason: "bounce" });
    expect(bounces.count).toBe(1);
  });

  it("admins only", async () => {
    fresh("rep");
    expect((await refusal(caller().emailSuppressions.exportCsv({ reason: "all" }))).code).toBe("FORBIDDEN");
  });
});

describe("a CSV imports into the list (F27)", () => {
  it("reads the email, reason and notes columns, skips bad and repeated rows, and records the person", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "dup@x.example", reason: "manual", prospectId: null });
    const csv = [
      "Name,Email Address,Reason,Notes",
      "Cy,CY@acme.example,Unsubscribed,asked by phone",
      "Ann,ann.new@acme.example,hard bounce,",
      "Dup,dup@x.example,,",
      "Bad,not-an-address,,",
      "Cy again,cy@acme.example,unsubscribe,",
    ].join("\n");
    const r = await caller().emailSuppressions.importCsv({ csv, defaultReason: "manual" });
    expect(r).toMatchObject({ added: 2, alreadySuppressed: 1, invalid: 1, truncated: false });
    const added = rows("email_suppressions").filter((x) => x.source === "import");
    expect(added.find((x) => x.email === "cy@acme.example")).toMatchObject({ reason: "unsubscribe", notes: "asked by phone", prospectId: 303, workspaceId: WS });
    expect(added.find((x) => x.email === "ann.new@acme.example")).toMatchObject({ reason: "bounce", prospectId: null });
  });

  it("a file of bare addresses works, with the reason chosen on the page", async () => {
    const r = await caller().emailSuppressions.importCsv({ csv: "one@x.example\ntwo@x.example\n", defaultReason: "unsubscribe" });
    expect(r.added).toBe(2);
    expect(rows("email_suppressions").map((x) => x.reason)).toEqual(["unsubscribe", "unsubscribe"]);
  });

  it("a file with no addresses is refused, saying so; reps cannot import", async () => {
    expect((await refusal(caller().emailSuppressions.importCsv({ csv: "name,phone\nAnn,555", defaultReason: "manual" }))).code).toBe("BAD_REQUEST");
    fresh("rep");
    expect((await refusal(caller().emailSuppressions.importCsv({ csv: "a@x.example", defaultReason: "manual" }))).code).toBe("FORBIDDEN");
  });

  it("reads the usual reason spellings", () => {
    expect(["Unsubscribed", "opt-out", "Hard Bounce", "spam complaint", "DNC", "whatever"].map(readReason))
      .toEqual(["unsubscribe", "unsubscribe", "bounce", "spam_complaint", "manual", null]);
    expect(readSuppressionCsv("email\nx@y.example\n", "manual").rows).toEqual([{ email: "x@y.example", reason: "manual", notes: null }]);
  });

  it("the page exports through the server and imports a chosen file", () => {
    const src = read("client/src/pages/usip/EmailSuppressions.tsx");
    expect(src).toContain("utils.client.emailSuppressions.exportCsv.query({ reason: reasonFilter as any, search: searchDebounced || undefined })");
    expect(src).toContain("importMutation.mutate({ csv: importText, defaultReason: importReason as any })");
    expect(src).toContain('aria-label="CSV file to import"');
  });
});
