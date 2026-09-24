/**
 * One funnel, one POPULATION.
 *
 * 🔴 /v2/analytics drew five bands with "% conversion" chevrons between them,
 * and the five bands answered five different questions over three different
 * windows:
 *
 *   Outreach sent  emailActivity.stats → every email_log row the workspace
 *                  ever transmitted, notifications and test sends included
 *   Replies        conversations.stats → reply ROWS, not people
 *   Interested     conversations.stats → reply rows classed willing_to_meet
 *   Meetings       meetings.stats.booked → `scheduled` + `invited` ONLY, so
 *                  the band FELL every time a meeting actually took place
 *   Deals won      opportunities.winLoss → a 90-DAY window, unlabelled,
 *                  beside four all-time bands
 *
 * On any workspace that runs sequences or books a meeting by hand, band 2 was
 * bigger than band 1 and the first chevron printed over 100%. A scope is not a
 * date and a campaign id — it is the SET OF PEOPLE being counted, and every
 * band of a funnel has to share it. getRevenueFunnel counts distinct
 * prospect_queue ids five times, so band N+1 is a subset of band N by
 * construction.
 *
 * The other half of the file is the labelling: numbers that legitimately
 * differ (the send log, the workspace's whole meeting book) stay on the page
 * and say what they are, because deleting them would just move the surprise.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOOKED_MEETING_STATUSES, MEETING_STATUSES } from "@shared/meetingStatus";
import { REVENUE_FUNNEL_STAGES } from "./services/performanceMetrics";
import { TOURS } from "./seedHelpContent";

const ROOT = join(__dirname, "..");
const read = (...segs: string[]) => readFileSync(join(ROOT, ...segs), "utf8");

const metrics = read("server", "services", "performanceMetrics.ts");
const analytics = read("client", "src", "pages", "usip", "AnalyticsV2.tsx");
const hub = read("client", "src", "pages", "usip", "AREHub.tsx");
const engine = read("server", "areEngine.ts");

const ANCHOR = "export async function getRevenueFunnel";
const fnAt = metrics.indexOf(ANCHOR);
const fn = metrics.slice(fnAt);

describe("getRevenueFunnel — one population, applied five times", () => {
  it("the slice under test is the function and nothing else (guards the anchor)", () => {
    expect(fnAt, "getRevenueFunnel moved or was renamed — re-anchor this file").toBeGreaterThan(-1);
    // It is deliberately the LAST export in the module, so a slice to EOF is
    // the function. Anything appended after it would silently widen every
    // assertion below into a whole-file scan.
    expect(
      metrics.indexOf("export async function ", fnAt + ANCHOR.length),
      "another exported function now follows getRevenueFunnel — bound the slice",
    ).toBe(-1);
    expect(fn.length).toBeGreaterThan(1500);
  });

  it("every band carries the tenant and the same campaign guard", () => {
    const ws = (fn.match(/eq\([A-Za-z]+\.workspaceId, workspaceId\)/g) ?? []).length;
    expect(
      ws,
      "a stage that omits workspaceId or campaignId is exactly the 90-day 'Deals won' band beside four all-time bands",
    ).toBeGreaterThanOrEqual(5);
    const camp = (fn.match(/campaignId !== null \? eq\([A-Za-z]+\.campaignId, campaignId\) : undefined/g) ?? []).length;
    expect(camp, "one campaign guard per band, or the bands narrow by different amounts").toBeGreaterThanOrEqual(5);
    for (const table of ["prospectQueue", "areExecutionQueue", "areSignalLog", "opportunities"]) {
      expect(fn, `${table} is no longer read — the funnel changed shape`).toContain(table);
    }
  });

  it("every band counts PEOPLE off the same spine", () => {
    expect((fn.match(/prospectQueueId/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((fn.match(/count\(distinct/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(
      fn,
      "email_log is workspace-wide transmitted mail with no prospect spine; contacted must come from are_execution_queue, the table the hub and the Sankey read",
    ).not.toContain(".from(emailLog)");
  });

  it("the sourcing staging rows are excluded from the top band", () => {
    // Migration 0180: sequenceStatus='sourcing' rows are staged without an
    // email, "invisible to the campaign queue and its counters", and
    // are/prospects.ts hides them from the Prospects tab. A plain count(*)
    // here would print a top band bigger than the tab beneath it.
    expect(fn).toMatch(/ne\(prospectQueue\.sequenceStatus, "sourcing"\)/);
  });

  it("the meetings cross-check spans meetings that already happened", () => {
    expect(fn, "use the named set, never a status literal — server/meetingStatus.test.ts scans for those").toContain(
      "bookedMeetingStatuses()",
    );
    expect(fn, "a band that empties as meetings complete is not a funnel stage").not.toMatch(/"scheduled"[^\]]*"invited"/);
  });

  it("won-ness comes from the pipeline flags, not the string 'won'", () => {
    // `opportunities.stage` has been a per-workspace VARCHAR since migration
    // 0082. A workspace whose closing stage is keyed `signed` would read
    // Closed won: 0 forever.
    expect(fn).toContain("stageIndexFor(");
    expect(fn).toContain("wonKeys");
  });

  it("meetings are people and closed-won is deals", () => {
    expect(REVENUE_FUNNEL_STAGES.map((s) => s.key)).toEqual(["sourced", "contacted", "replied", "meetings", "closed"]);
    expect(REVENUE_FUNNEL_STAGES.filter((s) => s.unit === "deals").map((s) => s.key)).toEqual(["closed"]);
  });
});

describe("BOOKED_MEETING_STATUSES — the third question about meeting status", () => {
  it("is the enum minus proposed, invited and cancelled", () => {
    // invited left the set 2026-09-24 (owner ask: "Count bookings only when
    // the prospect accepts"): an invite nobody has answered is not a booking.
    const expected = [...MEETING_STATUSES].filter((s) => s !== "proposed" && s !== "invited" && s !== "cancelled").sort();
    expect([...BOOKED_MEETING_STATUSES].sort()).toEqual(expected);
  });

  it("excludes proposed — an AI candidate the attendee never agreed to", () => {
    expect(BOOKED_MEETING_STATUSES).not.toContain("proposed");
    expect(BOOKED_MEETING_STATUSES).not.toContain("cancelled");
    // The whole reason it exists: `completed` counts.
    expect(BOOKED_MEETING_STATUSES).toContain("completed");
  });
});

describe("/v2/analytics renders the funnel and says what it is", () => {
  it("every band comes from the one proc", () => {
    expect(analytics).toContain("trpc.are.metrics.revenueFunnel.useQuery");
  });

  it("the funnel section reads nothing else", () => {
    const at = analytics.indexOf("Autonomous booking funnel");
    expect(at, "the funnel heading moved — re-anchor").toBeGreaterThan(-1);
    const band = analytics.slice(at, analytics.indexOf("</section>", at));
    expect(band.length, "the section slice is too small to be the real block").toBeGreaterThan(400);
    for (const ghost of ["wl.won", "meet.booked", "conv.willingToMeet", "outreach.sent"]) {
      expect(band, `${ghost} is a different population — a band fed by it cannot share the funnel's scope`).not.toContain(
        ghost,
      );
    }
  });

  it("the scope is printed on the page, not implied", () => {
    expect(analytics).toContain("All time · every campaign · people the engine sourced");
  });

  it("no conversion chevron crosses a unit change", () => {
    // meetings (people) → closed won (deals) would otherwise print a
    // deals-per-person ratio labelled "% conversion".
    expect(analytics).toMatch(/prev\.unit === f\.unit/);
  });

  it("the send-log card survives, relabelled, and the tour anchor stays", () => {
    // server/homeDashboardStats.test.ts:36 pins this call: the card is the
    // answer to "did anything go out at all", which the funnel cannot answer.
    expect(analytics).toContain("trpc.emailActivity.stats.useQuery");
    expect(analytics).toContain("Emails transmitted");
    expect(analytics, "seedHelpContent.ts spotlights this id — losing it makes the tour highlight nothing").toContain(
      'data-tour-id="analytics-overview"',
    );
  });

  it("'outreach' on that card means outreach", () => {
    const decl = analytics.slice(analytics.indexOf("const OUTREACH_LOG_SOURCES"), analytics.indexOf("const FUNNEL_LOOK"));
    expect(decl.length).toBeGreaterThan(40);
    for (const s of ["campaign", "sequence", "crm", "ai_draft", "mailbox"]) expect(decl).toContain(`"${s}"`);
    // services/email/logSend.ts also logs proposal / transactional / test /
    // other. Counting those as outreach is what made the card and the
    // Contacted band differ by a factor of two with nothing explaining it.
    for (const s of ["proposal", "transactional", "test", "other"]) expect(decl).not.toContain(`"${s}"`);
  });
});

describe("the surfaces that must agree with it", () => {
  it("the campaign Sankey and the funnel read the same two tables", () => {
    const sankey = metrics.slice(metrics.indexOf("export async function getStepFunnel"), fnAt);
    expect(sankey.length).toBeGreaterThan(400);
    for (const src of ["areExecutionQueue", "areSignalLog", 'eq(areExecutionQueue.status, "sent"']) {
      expect(sankey).toContain(src);
      expect(fn, `the funnel stopped reading ${src} — it can now disagree with the campaign Sankey`).toContain(src);
    }
  });

  it("the hub funnel is the workspace, not a page of campaigns", () => {
    expect(hub).toContain("trpc.are.campaigns.funnelTotals.useQuery");
    expect(
      hub,
      "are.campaigns.list orders by createdAt desc and applies the caller's limit, so summing its rows presented the newest 100 campaigns as the workspace total",
    ).not.toMatch(/acc\.discovered \+/);
  });

  it("the engine's contacted recompute carries the workspace", () => {
    const phase = engine.slice(engine.indexOf("Phase 6: COUNTERS"), engine.indexOf("Phase 7: DISCOVERY"));
    expect(phase.length, "the counter phase moved — re-anchor").toBeGreaterThan(400);
    expect(phase).toContain("eq(areExecutionQueue.workspaceId, wsId)");
  });

  it("the help tour and the funnel name the same stages", () => {
    // This is the pin that would have caught the original drift: the tour said
    // "sourced, contacted, replied, meetings, closed" while the page rendered
    // "Outreach sent, Replies, Interested, Meetings booked, Deals won".
    const tour = TOURS.filter((t) => t.route === "/v2/analytics")[0];
    expect(tour, "the Analytics tour moved — re-anchor").toBeTruthy();
    const step = tour!.steps.filter((s) => s.title === "The funnel end to end")[0];
    expect(step, "the funnel step was renamed — re-anchor").toBeTruthy();
    const labels = REVENUE_FUNNEL_STAGES.map((s) => s.label.toLowerCase());
    const words = ["sourced", "contacted", "replied", "meetings", "closed"];
    for (let i = 0; i < words.length; i++) {
      expect(step!.bodyMarkdown.toLowerCase(), `the tour no longer says "${words[i]}"`).toContain(words[i]);
      expect(
        labels.filter((l) => l.indexOf(words[i]) >= 0).length,
        `no funnel band is labelled "${words[i]}" — the tour promises a stage the page does not render`,
      ).toBeGreaterThan(0);
    }
  });
});
