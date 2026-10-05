/**
 * Test calls (owner ask 2026-10-05: "a way to 'Test' a call any time"):
 * an admin has an outreach agent call a number now, outside calling hours,
 * with the guards that keep it a test: admins only, never a do-not-call
 * number, 10 a day, the same spend limits, and the tester is the person
 * called, so no prospect is ever invited or described.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(path.join(__dirname, ...p), "utf8");
const router = read("routers", "aiCalls.ts");
const test = router.slice(router.indexOf("testCall: adminWsProcedure"), router.indexOf("/* ── do-not-call list"));

describe("placing a test call", () => {
  it("is for admins, from an active outreach agent with a Plivo number", () => {
    expect(test).toContain("testCall: adminWsProcedure");
    expect(test).toContain('agent.purpose !== "outbound_outreach" || !agent.plivoNumber');
    expect(test).toContain('if (agent.status !== "active")');
  });
  it("never calls a do-not-call number, and stops at 10 a day", () => {
    expect(test).toContain("eq(callSuppressions.phone, to)");
    expect(test).toContain('if (dnc) throw new TRPCError({ code: "BAD_REQUEST", message: "That number is on the do-not-call list." });');
    expect(test).toContain("isNotNull(voiceCalls.testedByUserId), gte(voiceCalls.startedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))");
    expect(test).toContain("if (Number(n) >= MAX_TEST_CALLS_PER_DAY)");
    expect(router).toContain("export const MAX_TEST_CALLS_PER_DAY = 10;");
  });
  it("goes through the same spend limits, and Plivo cuts it at the same time limit", () => {
    expect(test).toContain("const admission = await admitInboundCall(wsId, null);");
    expect(test).toContain("timeLimit: OUTBOUND_TIME_LIMIT_SEC");
  });
  it("is marked a test, with who asked, and audited", () => {
    expect(test).toContain("testedByUserId: ctx.user.id,");
    expect(test).toContain('entityType: "ai_test_call"');
  });
  it("does not go through the approval queue or calling hours (that is the point)", () => {
    expect(test).not.toContain("isWithinCallingHours");
    expect(test).not.toContain("voiceCallRequests");
  });
});

describe("on the call", () => {
  it("the person called is the tester: their name and email, no prospect, no history", () => {
    const relay = read("services", "voiceRelay.ts");
    const branch = relay.slice(relay.indexOf("if (row.testedByUserId) {"), relay.indexOf("} else if (request) {"));
    expect(branch).toContain("db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.testedByUserId))");
    expect(branch).toContain("person = { name: u?.name ?? null, title: null, company: null, email: u?.email ?? null, tz: null };");
    expect(branch).not.toContain("prospectId =");
  });
  it("test calls are labelled in the call logs", () => {
    for (const f of [["..", "client", "src", "pages", "usip", "Calls.tsx"], ["..", "client", "src", "components", "usip", "settings", "VoiceAgentsSection.tsx"]]) {
      expect(read(...f)).toContain("{c.testedByUserId ? <span");
    }
  });
});
