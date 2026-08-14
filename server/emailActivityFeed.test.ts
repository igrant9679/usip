/**
 * "All emails sitewide … should appear in the Emails sidebar" (owner ask
 * 2026-08-14).
 *
 * The page read `emailDrafts.list` and nothing else, so it showed CRM ad-hoc
 * sends and AI drafts. ARE campaign mail lived on are_execution_queue; Inbox
 * composes and replies, proposal mail and every transactional message were
 * recorded NOWHERE — the mail left the building and Velocity kept no evidence.
 *
 * Two things are worth guarding, and they are different in kind:
 *
 *   1. the merge rule (a real unit test — mergeFeed is pure), because getting
 *      pagination wrong here fails SILENTLY, which is exactly how the ARE
 *      Active tab came up empty in 320072b; and
 *   2. that every transmission point actually writes the log, because a
 *      logger nothing calls is this codebase's dominant defect shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  mergeFeed,
  emailSourceLabel,
  isEngaged,
  feedSourceApplies,
  EMAIL_SOURCES,
  type EmailFeedRow,
} from "@shared/emailActivity";
import { previewOf } from "./services/email/logSend";

const router = readFileSync("server/routers/emailActivity.ts", "utf8");
const adapter = readFileSync("server/emailAdapter.ts", "utf8");
const delivery = readFileSync("server/emailDelivery.ts", "utf8");
const operations = readFileSync("server/routers/operations.ts", "utf8");
const migrations = readFileSync("server/_core/rawMigrations.ts", "utf8");
const page = readFileSync("client/src/pages/usip/EmailsV2.tsx", "utf8");

function row(key: string, at: string, extra: Partial<EmailFeedRow> = {}): EmailFeedRow {
  return {
    key, kind: "log", id: Number(key.split(":")[1] ?? 0), direction: "outbound",
    source: "crm", sourceLabel: null, subject: null, preview: null,
    fromEmail: null, fromName: null, toEmail: null, status: "sent", failureReason: null,
    at, openCount: 0, clickCount: 0, openedAt: null, bouncedAt: null, bounceType: null,
    repliedAt: null, draftId: null, executionQueueId: null, campaignId: null,
    prospectQueueId: null, contactId: null, leadId: null, sequenceId: null,
    sendingAccountId: null, userId: null, stepIndex: null,
    ...extra,
  };
}

describe("the four sources merge into one true ordering", () => {
  it("interleaves sources strictly by time, newest first", () => {
    const logs = [row("log:1", "2026-08-14T10:00:00Z"), row("log:2", "2026-08-12T10:00:00Z")];
    const queued = [row("queued:9", "2026-08-13T10:00:00Z", { kind: "queued", source: "campaign" })];
    const inbound = [row("inbound:4", "2026-08-11T10:00:00Z", { kind: "inbound", direction: "inbound" })];
    const merged = mergeFeed([logs, [], queued, inbound], { limit: 10, offset: 0 });
    expect(merged.map((r) => r.key)).toEqual(["log:1", "queued:9", "log:2", "inbound:4"]);
  });

  it("pages without dropping or repeating a row", () => {
    const a = Array.from({ length: 6 }, (_, i) => row(`log:${i}`, `2026-08-${20 - i}T10:00:00Z`));
    const b = Array.from({ length: 6 }, (_, i) => row(`queued:${i}`, `2026-08-${20 - i}T09:00:00Z`, { kind: "queued" }));
    const p1 = mergeFeed([a, b], { limit: 4, offset: 0 }).map((r) => r.key);
    const p2 = mergeFeed([a, b], { limit: 4, offset: 4 }).map((r) => r.key);
    const p3 = mergeFeed([a, b], { limit: 4, offset: 8 }).map((r) => r.key);
    const all = [...p1, ...p2, ...p3];
    expect(new Set(all).size).toBe(all.length);       // nothing repeated
    expect(all.length).toBe(12);                      // nothing dropped
  });

  it("breaks timestamp ties deterministically", () => {
    // Two rows sharing a second must not swap between requests, or one can
    // slip through the gap between page 1 and page 2.
    const same = "2026-08-14T10:00:00Z";
    const first = mergeFeed([[row("log:1", same)], [row("queued:2", same, { kind: "queued" })]], { limit: 5, offset: 0 });
    const second = mergeFeed([[row("queued:2", same, { kind: "queued" })], [row("log:1", same)]], { limit: 5, offset: 0 });
    expect(first.map((r) => r.key)).toEqual(second.map((r) => r.key));
  });

  it("survives a source contributing nothing", () => {
    expect(mergeFeed([[], [], [], []], { limit: 10, offset: 0 })).toEqual([]);
  });

  it("treats an unparseable timestamp as oldest rather than throwing", () => {
    const merged = mergeFeed([[row("log:1", "not a date"), row("log:2", "2026-08-14T10:00:00Z")]], { limit: 5, offset: 0 });
    expect(merged[0].key).toBe("log:2");
  });
});

describe("the feed filters in SQL, before the limit", () => {
  it("applies every filter as a WHERE condition, not a post-fetch .filter()", () => {
    // The defect this guards is silent: a JS filter over an already-limited
    // page looks fine and is simply missing rows.
    expect(router).not.toMatch(/rows\s*\.filter\(/);
    expect(router).toContain("conds.push");
    for (const frag of ["emailLog.source", "emailLog.status", "emailLog.campaignId"]) {
      expect(router, frag).toContain(frag);
    }
    // Each source takes offset+limit so the merged window is the true window.
    expect(router).toContain("const take = input.offset + input.limit");
    expect(router).toContain("limit(takePlus)");
  });

  it("orders every source before limiting it", () => {
    const orderBys = router.match(/\.orderBy\(desc\(/g) ?? [];
    const limits = router.match(/\.limit\(takePlus\)/g) ?? [];
    expect(orderBys.length).toBeGreaterThanOrEqual(limits.length);
    expect(limits.length).toBe(4); // one per source
  });

  it("excludes rows that another source already owns, rather than deduping after", () => {
    // A draft or execution row that has a log row is the log row's story —
    // the log carries the delivery outcome and the failure reason.
    const notExists = router.match(/NOT EXISTS \(SELECT 1 FROM \\`email_log\\`/g) ?? [];
    expect(notExists.length).toBe(2);
  });

  it("counts the chips across the workspace, not across the page", () => {
    const stats = router.slice(router.indexOf("stats: workspaceProcedure"));
    expect(stats).toContain("groupBy(emailLog.source)");
    expect(stats.slice(0, stats.indexOf("get: workspaceProcedure"))).not.toContain("limit(");
  });
});

describe("every transmission point writes the log", () => {
  it("logs from the adapter factory, which every account-attributed send passes", () => {
    const factory = adapter.slice(adapter.indexOf("export function createEmailAdapter"));
    expect(factory).toContain("logEmailSend");
    // Failures are logged too: "it never went out, and here is why" is the row
    // a user most needs, and an only-on-success log never writes it.
    expect(factory).toContain('status: "failed"');
    expect(factory).toContain('status: "sent"');
    expect(factory).toContain("throw err");
  });

  it("logs the transactional path, which never touches an adapter", () => {
    const fn = delivery.slice(delivery.indexOf("export async function sendWorkspaceEmail"));
    expect(fn).toContain("logEmailSend");
    expect(fn).toContain('source: opts.logSource ?? "transactional"');
  });

  it("logs scheduled reports, the third point the usage meter also counts", () => {
    const near = operations.slice(operations.indexOf("Transmission point 3 of 3"));
    expect(near.slice(0, 1500)).toContain("logEmailSend");
  });

  it("carries the campaign, step and prospect onto ARE campaign sends", () => {
    const engine = readFileSync("server/areEngine.ts", "utf8");
    const call = engine.slice(engine.indexOf("sendCampaignEmailViaPool(wsId"));
    expect(call.slice(0, 900)).toContain('source: "campaign"');
    expect(call.slice(0, 900)).toContain("executionQueueId: step.id");
    expect(call.slice(0, 900)).toContain("prospectQueueId: p.id");
  });

  it("tags the paths that previously recorded nothing at all", () => {
    const mailbox = readFileSync("server/routers/mailbox.ts", "utf8");
    const proposals = readFileSync("server/routers/proposals.ts", "utf8");
    expect((mailbox.match(/source: "mailbox"/g) ?? []).length).toBe(2); // sendNew + sendReply
    expect(proposals).toContain('source: "proposal"');
  });
});

describe("the log table and its history", () => {
  it("ships as migration 0163 with a backfill from both existing homes", () => {
    const m = migrations.slice(migrations.indexOf('name: "0163_email_log.sql"'));
    const block = m.slice(0, m.indexOf("];"));
    expect(block).toContain("CREATE TABLE IF NOT EXISTS `email_log`");
    // Without the backfill the fix would look like it had not worked: the page
    // would start empty on a workspace with thousands of sent emails.
    expect(block).toContain("FROM `email_drafts` d WHERE d.`status` = 'sent'");
    expect(block).toContain("FROM `are_execution_queue` q");
    // Re-runnable without duplicating.
    expect((block.match(/NOT EXISTS \(SELECT 1 FROM `email_log`/g) ?? []).length).toBe(2);
  });

  it("does not copy engagement counters into the log", () => {
    // Copying them would create a second set to keep in step — which is how
    // are_ab_variants ended up with columns nothing ever wrote.
    const m = migrations.slice(migrations.indexOf('name: "0163_email_log.sql"'));
    const block = m.slice(0, m.indexOf("];"));
    expect(block).not.toContain("openCount");
    expect(block).not.toContain("clickCount");
  });
});

describe("the page shows the record, not just the subject line", () => {
  it("hands its filters to the server", () => {
    expect(page).toContain("trpc.emailActivity.list.useQuery");
    expect(page).toContain("search: searchDebounced");
    expect(page).toContain("offset: page * PAGE");
  });

  it("names the source of every row and links the records behind it", () => {
    expect(page).toContain("emailSourceLabel(row.source)");
    expect(page).toContain("/are/campaigns/${row.campaignId}");
    expect(page).toContain("/contacts/${row.contactId}");
    expect(page).toContain("/leads/${row.leadId}");
  });

  it("keeps the review actions that were the old page's only reason to exist", () => {
    for (const m of ["emailDrafts.approve", "emailDrafts.reject", "emailDrafts.send"]) {
      expect(page, m).toContain(m);
    }
    expect(page).toContain("emailAutoSend.updateAutoSendSettings");
  });
});

describe("the source and status filters compose", () => {
  const f = (direction: string, source: string, status: string) =>
    ({ direction, source, status }) as Parameters<typeof feedSourceApplies>[0];

  it("does not query the scheduled source when the user asked for sent", () => {
    // The bug this replaced: returning on the SOURCE check alone meant
    // "campaign + sent" also queried the scheduled-and-failed source, putting
    // rows on screen that the filter had just excluded.
    expect(feedSourceApplies(f("all", "campaign", "sent"), "queued")).toBe(false);
    expect(feedSourceApplies(f("all", "campaign", "sent"), "log")).toBe(true);
  });

  it("keeps the review queue out of every status but 'needs review'", () => {
    expect(feedSourceApplies(f("all", "all", "awaiting"), "draft")).toBe(true);
    expect(feedSourceApplies(f("all", "all", "awaiting"), "log")).toBe(false);
    expect(feedSourceApplies(f("all", "all", "awaiting"), "queued")).toBe(false);
  });

  it("routes a failure to both places one can be recorded", () => {
    // Inside the adapter → email_log. Before it (no eligible account, daily
    // cap) → only the execution row.
    expect(feedSourceApplies(f("all", "all", "failed"), "log")).toBe(true);
    expect(feedSourceApplies(f("all", "all", "failed"), "queued")).toBe(true);
    expect(feedSourceApplies(f("all", "all", "failed"), "draft")).toBe(false);
  });

  it("honours direction over everything else", () => {
    expect(feedSourceApplies(f("outbound", "all", "all"), "inbound")).toBe(false);
    expect(feedSourceApplies(f("inbound", "all", "all"), "log")).toBe(false);
    expect(feedSourceApplies(f("inbound", "all", "all"), "inbound")).toBe(true);
    // …and an impossible combination returns nothing rather than everything.
    expect(feedSourceApplies(f("inbound", "all", "sent"), "inbound")).toBe(false);
  });

  it("lets a campaign filter reach only campaign-capable sources", () => {
    expect(feedSourceApplies(f("all", "campaign", "all"), "queued")).toBe(true);
    expect(feedSourceApplies(f("all", "campaign", "all"), "draft")).toBe(false);
    expect(feedSourceApplies(f("all", "sequence", "all"), "draft")).toBe(true);
    expect(feedSourceApplies(f("all", "sequence", "all"), "queued")).toBe(false);
  });
});

describe("small rules the feed depends on", () => {
  it("labels every source it can be given", () => {
    for (const s of EMAIL_SOURCES) expect(emailSourceLabel(s.id)).not.toBe("");
    expect(emailSourceLabel("brand_new_path")).toBe("Brand new path");
    expect(emailSourceLabel(null)).toBe("Other");
  });

  it("counts an open, a click or a reply as engagement", () => {
    expect(isEngaged(row("log:1", "2026-08-14", { openCount: 1 }))).toBe(true);
    expect(isEngaged(row("log:2", "2026-08-14", { clickCount: 2 }))).toBe(true);
    expect(isEngaged(row("log:3", "2026-08-14", { repliedAt: "2026-08-14" }))).toBe(true);
    expect(isEngaged(row("log:4", "2026-08-14"))).toBe(false);
  });

  it("stores a readable preview rather than raw markup", () => {
    expect(previewOf("<p>Hi Dana</p><p>Quick question</p>", null)).toContain("Hi Dana");
    expect(previewOf("<p>Hi</p>", null)).not.toContain("<p>");
    expect(previewOf(null, null)).toBeNull();
    expect((previewOf("x".repeat(5000), null) ?? "").length).toBe(2000);
  });
});
