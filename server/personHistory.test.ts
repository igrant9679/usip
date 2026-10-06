/**
 * What the AI phone agent is told about a person (2026-10-05): the latest
 * emails both ways, deals, meetings, earlier calls and Revenue Engine
 * research, each cleaned to one line, capped, and never failing the call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  areExecutionQueue, contacts, emailDrafts, emailReplies, meetings, opportunities, opportunityContactRoles,
  prospectIntelligence, prospectQueue, prospects, voiceCalls,
} from "../drizzle/schema";

type Row = Record<string, any>;
const data = new Map<unknown, Row[]>();
let throwOn: unknown = null;
const fakeDb: any = {
  select: () => ({
    from: (table: unknown) => {
      const rows = () => {
        if (table === throwOn) throw new Error("boom");
        return data.get(table) ?? [];
      };
      const q: any = { where: () => q, orderBy: () => q, limit: () => Promise.resolve(rows()), then: (r: any, j: any) => Promise.resolve().then(rows).then(r, j) };
      return q;
    },
  }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));

import { buildPersonHistory, HISTORY_MAX_CHARS, personIdForRecord } from "./services/personHistory";
import { readFileSync } from "fs";
import path from "path";

beforeEach(() => {
  data.clear();
  throwOn = null;
  data.set(prospects, [{ linkedContactId: 31, accountId: 7 }]);
});

describe("personIdForRecord: the person behind a caller's CRM match", () => {
  it("a person is themselves", async () => {
    data.set(prospects, [{ id: 9 }]);
    expect(await personIdForRecord(4, "prospect", 9)).toBe(9);
  });
  it("a contact made from a person resolves to that person", async () => {
    data.set(contacts, [{ personProspectId: 9 }]);
    expect(await personIdForRecord(4, "contact", 31)).toBe(9);
  });
  it("a contact without that link resolves through the person that links to it", async () => {
    data.set(contacts, [{ personProspectId: null }]);
    data.set(prospects, [{ id: 12 }]);
    expect(await personIdForRecord(4, "contact", 31)).toBe(12);
  });
  it("a lead resolves to the person converted to it", async () => {
    data.set(prospects, [{ id: 13 }]);
    expect(await personIdForRecord(4, "lead", 55)).toBe(13);
    // The fake ignores filters, so the column itself is pinned: a lead is the
    // person whose linkedLeadId it is, never one whose linkedContactId shares the number.
    const src = readFileSync(path.join(__dirname, "services", "personHistory.ts"), "utf8");
    const lead = src.slice(src.indexOf('if (relatedType === "lead")'), src.indexOf("return null;\n  } catch"));
    expect(lead).toContain("eq(prospects.workspaceId, workspaceId), eq(prospects.linkedLeadId, relatedId)");
    const contact = src.slice(src.indexOf('if (relatedType === "contact")'), src.indexOf('if (relatedType === "lead")'));
    expect(contact).toContain("eq(contacts.id, relatedId), eq(contacts.workspaceId, workspaceId)");
    expect(contact).toContain("eq(prospects.workspaceId, workspaceId), eq(prospects.linkedContactId, relatedId)");
  });
  it("no match, no person", async () => {
    data.set(prospects, []);
    data.set(contacts, []);
    expect(await personIdForRecord(4, "contact", 31)).toBeNull();
    expect(await personIdForRecord(4, "account", 1)).toBeNull();
    expect(await personIdForRecord(4, null, null)).toBeNull();
  });
  it("the Plivo agent's call-ins use it too", () => {
    const relay = readFileSync(path.join(__dirname, "services", "voiceRelay.ts"), "utf8");
    // 2026-10-06: a test call uses the person it plays (historyFor), never the call row.
    expect(relay).toContain("const historyPersonId = row.testedByUserId ? historyFor : prospectId ?? (await personIdForRecord(wsId, row.relatedType, row.relatedId));");
    expect(relay).toContain("const history = historyPersonId ? await buildPersonHistory(wsId, historyPersonId) : null;");
  });
});

describe("buildPersonHistory", () => {
  it("assembles emails, replies, the deal, meetings, calls and research, one clean line each", async () => {
    data.set(emailDrafts, [{ subject: "Grants season", body: "<p>Hi Dana,&nbsp;saw your\nnews</p>", sentAt: new Date("2026-09-20T12:00:00Z") }]);
    data.set(prospectQueue, [{ id: 501 }]);
    data.set(areExecutionQueue, [{ executedAt: new Date("2026-09-25T12:00:00Z"), channel: "email", messageContent: { subject: "Quick follow-up", body: "Any thoughts?" } }]);
    data.set(emailReplies, [{ receivedAt: new Date("2026-09-30T12:00:00Z"), bodyText: "Send me pricing\r\nfor 3 programs.", replyClass: "interested" }]);
    data.set(contacts, [{ id: 31 }]);
    data.set(opportunityContactRoles, [{ opportunityId: 88 }]);
    data.set(opportunities, [{ name: "Acme renewal", stage: "proposal", value: "24000.00", nextStep: "Send revised quote" }]);
    data.set(meetings, [{ title: "Acme intro", status: "invited", scheduledAt: new Date("2026-10-08T15:00:00Z") }]);
    data.set(voiceCalls, [{ startedAt: new Date("2026-10-01T15:00:00Z"), status: "completed", result: "call_back", direction: "outbound" }]);
    data.set(prospectIntelligence, [{ companyOneLiner: "Runs 40 scholarship programs.", painSignals: ["Manual review in spreadsheets"], triggerEvents: [{ title: "New CFO" }], recentNews: [], personalisationHooks: [] }]);

    const h = await buildPersonHistory(4, 9);
    const lines = h.split("\n");
    expect(lines).toEqual([
      'We emailed 2026-09-25: "Quick follow-up" Any thoughts?',
      'We emailed 2026-09-20: "Grants season" Hi Dana, saw your news',
      "They replied 2026-09-30 (interested): Send me pricing for 3 programs.",
      "Deal: Acme renewal, stage proposal, value 24000.00. Next step: Send revised quote",
      "Meeting invited for 2026-10-08: Acme intro",
      "Earlier AI call 2026-10-01 (outbound): call back",
      "Their company: Runs 40 scholarship programs.",
      "Likely pain points: Manual review in spreadsheets",
      "Recent triggers: New CFO",
    ]);
  });

  it("is capped, keeping whole lines", async () => {
    // Every source full: well over the cap before it is applied.
    const long = (c: string) => `${c} `.repeat(300);
    data.set(emailDrafts, Array.from({ length: 3 }, () => ({ subject: long("s"), body: long("b"), sentAt: new Date() })));
    data.set(emailReplies, Array.from({ length: 3 }, () => ({ receivedAt: new Date(), bodyText: long("r"), replyClass: "interested" })));
    data.set(contacts, [{ id: 31 }]);
    data.set(opportunityContactRoles, [{ opportunityId: 1 }, { opportunityId: 2 }]);
    data.set(opportunities, Array.from({ length: 2 }, () => ({ name: long("o"), stage: "proposal", value: "1", nextStep: long("n") })));
    data.set(meetings, Array.from({ length: 3 }, () => ({ title: long("m"), status: "invited", scheduledAt: new Date() })));
    data.set(prospectQueue, [{ id: 1 }]);
    data.set(prospectIntelligence, [{ companyOneLiner: long("y"), painSignals: [long("z"), long("w"), long("v")], triggerEvents: [long("t")], recentNews: [long("e")], personalisationHooks: [long("h")] }]);
    const h = await buildPersonHistory(4, 9);
    expect(h.length).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(h.length).toBeGreaterThan(HISTORY_MAX_CHARS - 400);
    // Whole lines only: the last line is complete, not cut mid-sentence.
    expect(h.split("\n").every((l) => /^(We emailed|They replied|Deal:|Meeting|Earlier AI call|Their company|Likely pain|Recent triggers|In the news|Personal hooks)/.test(l))).toBe(true);
  });

  it("an unknown person has no history", async () => {
    data.set(prospects, []);
    expect(await buildPersonHistory(4, 9)).toBe("");
  });

  it("never fails the call: a broken lookup means no history, not an error", async () => {
    throwOn = emailReplies;
    await expect(buildPersonHistory(4, 9)).resolves.toBe("");
  });
});
