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

import { buildPersonHistory, HISTORY_MAX_CHARS } from "./services/personHistory";

beforeEach(() => {
  data.clear();
  throwOn = null;
  data.set(prospects, [{ linkedContactId: 31, accountId: 7 }]);
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
