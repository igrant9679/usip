/**
 * One reply vocabulary, everywhere (owner report 2026-08-28).
 *
 * Before: every surface picked its own emailReplies scope and they all
 * disagreed — Conversations/Home said 0, the Emails tab said 74,943 (the
 * owner's entire private inbox), and a genuine campaign reply was viewable
 * NOWHERE because the poller matched it to the ARE queue but never persisted
 * the match.
 *
 * The contract now: services/replyScope.ts is the ONE definition
 * (draft-matched OR campaign-matched), migration 0174 persists the campaign
 * linkage, and every reply surface uses the shared scope.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

const scope = read("services", "replyScope.ts");
const schema = read("..", "drizzle", "schema.ts");
const migrations = read("_core", "rawMigrations.ts");
const poller = read("inboundReplyPoller.ts");

describe("the shared scope and its plumbing exist", () => {
  it("replyScope defines genuine = draftId OR campaignId", () => {
    expect(scope).toMatch(/or\(isNotNull\(emailReplies\.draftId\), isNotNull\(emailReplies\.campaignId\)\)/);
    expect(scope).toContain("GENUINE_REPLY_SQL");
  });

  it("email_replies carries the campaign linkage columns (0174)", () => {
    for (const col of ['prospectId: int("prospectId")', 'prospectQueueId: int("prospectQueueId")', 'campaignId: int("campaignId")']) {
      // The columns must be inside the emailReplies table definition.
      const tbl = schema.slice(schema.indexOf("export const emailReplies"), schema.indexOf("export const", schema.indexOf("export const emailReplies") + 10));
      expect(tbl).toContain(col);
    }
    expect(migrations).toContain("0174_email_replies_campaign_linkage");
    // Backfill uses the same match rule as the live poller: workspace + email,
    // newest queue row wins.
    expect(migrations).toMatch(/MAX\(id\) maxId FROM `prospect_queue`/);
  });

  it("the poller persists the queue match instead of using it transiently", () => {
    expect(poller).toContain("prospectQueueId: matchedQueueRow?.id ?? null");
    expect(poller).toContain("campaignId: matchedQueueRow?.campaignId ?? null");
    expect(poller).toContain("prospectId: matchedProspectId");
  });
});

describe("every reply surface uses the shared scope", () => {
  const surfaces: Array<[string, string[], number]> = [
    // [file, path segments, minimum genuineReplyScope() call-sites]
    ["conversations list+stats", ["routers", "conversations.ts"], 2],
    ["attention unhandled+digest", ["routers", "attention.ts"], 3],
    ["emailActivity feed+stats", ["routers", "emailActivity.ts"], 2],
    ["replyClassifier sweep", ["services", "replyClassifier.ts"], 1],
    ["leadScoring engagement", ["routers", "leadScoring.ts"], 1],
    ["performanceMetrics attribution", ["services", "performanceMetrics.ts"], 1],
  ];
  for (const [label, segs, min] of surfaces) {
    it(`${label} calls genuineReplyScope()`, () => {
      const src = read(...segs);
      const calls = (src.match(/genuineReplyScope\(\)/g) ?? []).length;
      expect(calls, `${label}: expected >= ${min} call-sites`).toBeGreaterThanOrEqual(min);
    });
  }

  it("trend7d's replies bucket carries the raw-SQL fragment", () => {
    const ws = read("routers", "workspace.ts");
    expect(ws).toContain("GENUINE_REPLY_SQL");
    expect(ws).toMatch(/bucket\("email_replies", "receivedAt", GENUINE_REPLY_SQL\)/);
  });

  it("no surface file re-derives the scope inline against draftId alone", () => {
    // conversations + attention + emailActivity must not carry their own
    // isNotNull(draftId) reply filters any more (joins on draftId for
    // draft-specific breakdowns live elsewhere and are allowed).
    for (const segs of [["routers", "conversations.ts"], ["routers", "attention.ts"]] as const) {
      expect(read(...segs)).not.toContain("isNotNull(emailReplies.draftId)");
    }
  });
});
