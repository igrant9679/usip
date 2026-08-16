/**
 * Guards for the defects found in the 2026-08-16 deep test report.
 *
 * Each block names the production evidence, because every one of these was
 * invisible until something displayed a number that contradicted another
 * number. Source assertions where the code needs a live DB; mutation-checked
 * against the pre-fix sources.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  // No end-of-file fallback: a moved anchor must fail its boundary test rather
  // than silently widening every assertion below it.
  return { a, b, text: src.slice(a, b) };
};

describe("expired meeting proposals cannot be booked (report #1)", () => {
  // Live: 129 proposals, 81 holding ONLY past times, every Approve & send
  // enabled. Booking one wrote a real past-dated calendar event.
  const src = read("server/services/meetingScheduler.ts");
  const { a, b, text: fn } = slice(src, "export async function sendMeetingInvite", "\nexport ");

  it("the anchors hold", () => {
    expect(a, "sendMeetingInvite moved — re-anchor").toBeGreaterThan(-1);
    expect(b, "no export follows — re-anchor").toBeGreaterThan(a);
  });

  it("refuses a time in the past", () => {
    expect(fn).toContain('reason: "time_in_past"');
    expect(fn).toMatch(/start\.getTime\(\) <= nowMs/);
  });

  it("defaults to the earliest FUTURE slot, not times[0]", () => {
    // Defaulting to times[0] is what made the default action the harmful one.
    expect(fn).toContain("times.filter(isFuture)");
    expect(fn).not.toMatch(/\?\?\s*times\[0\]/);
  });

  it("distinguishes 'no times' from 'all expired'", () => {
    expect(fn).toContain('"all_times_expired"');
  });

  it("the guard is on the shared path, not only the button", () => {
    // sendMeetingInvite is what the autonomous scheduler calls too.
    const client = read("client/src/pages/usip/MeetingsV2.tsx");
    expect(client).toContain("disabled={pending || expired || !chosen}");
    expect(client).toMatch(/const future = times\.filter/);
  });
});

describe("reply counts mean replies (report #2)", () => {
  // Live: conversations.stats reported 70,484 unhandled in LSI where the true
  // figure is 0 — email_replies holds every synced inbound message.
  const src = read("server/routers/conversations.ts");

  it("stats scopes to replies to something we sent", () => {
    const { text } = slice(src, "stats: workspaceProcedure", "\n  detail");
    expect(text).toContain("isNotNull(emailReplies.draftId)");
  });

  it("list scopes the same way, so header and rows agree", () => {
    const { text } = slice(src, "list: workspaceProcedure", "stats: workspaceProcedure");
    expect(text).toContain("isNotNull(emailReplies.draftId)");
  });
});

describe("pipeline alerts point at something real (report #3)", () => {
  it("orphaned alerts are not returned", () => {
    const src = read("server/routers/pipelineAlerts.ts");
    const { text } = slice(src, "list: workspaceProcedure", "/** Dismiss an alert */");
    expect(text).toMatch(/\.filter\(\(a\) => oppMap\[a\.opportunityId\]\)/);
    expect(text).not.toMatch(/opportunity: oppMap\[a\.opportunityId\] \?\? null/);
  });

  it("View Opp links to the opportunity, not the board", () => {
    // Was href={`/pipeline`} — a template literal with no interpolation.
    const src = read("client/src/pages/usip/PipelineAlerts.tsx");
    expect(src).toContain("href={`/opportunities/${alert.opportunityId}`}");
  });
});

describe("calendar times survive a round trip (report #5)", () => {
  const src = read("client/src/pages/usip/Calendar.tsx");

  it("datetime-local is filled with LOCAL wall-clock, not UTC", () => {
    // toISOString() into datetime-local showed 05:31 at 01:32 Eastern, and
    // because the write parsed local correctly the error compounded +4h per
    // edit.
    expect(src).toContain("getTimezoneOffset() * 60000");
    expect(src).toMatch(/const toLocalInput =/);
  });

  it("no raw toISOString feeds a datetime-local default", () => {
    expect(src).not.toMatch(/\?\? new Date\(\)\)\.toISOString\(\)\.slice\(0, 16\)/);
  });
});

describe("a first sighting is not a job change (report #6)", () => {
  // Live: 52 of 54 job-change tasks read "moved from their previous company"
  // because oldValue was null — the prospect had not moved, we had simply
  // never seen their employer before.
  it("the diff marks first observations", () => {
    const src = read("server/services/linkedinEnrichment/snapshot.ts");
    expect(src).toContain("firstObservation: before === \"\"");
  });

  it("re-engagement excludes them, and excludes the domain field", () => {
    const src = read("server/services/linkedinEnrichment/jobChangeReengagement.ts");
    const { text } = slice(src, "export async function onJobChangeDetected", "\n  // 1)");
    expect(text).toContain("!c.firstObservation");
    expect(text).toContain('c.fieldName === "current_company_name"');
  });

  it("refuses rather than printing a placeholder", () => {
    // Asserted as the FALLBACK PATTERN, not the bare strings — the strings
    // still appear in the comment explaining why they were removed, and a
    // test that cannot tell code from prose fails on its own documentation.
    const src = read("server/services/linkedinEnrichment/jobChangeReengagement.ts");
    expect(src).not.toMatch(/\|\|\s*"their previous company"/);
    expect(src).not.toMatch(/\|\|\s*"a new company"/);
    expect(src).toContain('reason: "incomplete_company_change"');
  });

  it("the manual re-engage path is covered by the same refusal", () => {
    // reengageProspectManually builds a DetectedChange by hand from a STORED
    // change row, so it carries no firstObservation flag — it is guarded
    // instead by the empty-value check inside maybeCreateJobChangeReengagement,
    // which both entry points pass through.
    const src = read("server/services/linkedinEnrichment/jobChangeReengagement.ts");
    const manual = src.slice(src.indexOf("export async function reengageProspectManually"));
    expect(manual).toContain("maybeCreateJobChangeReengagement(");
    const shared = src.slice(src.indexOf("export async function maybeCreateJobChangeReengagement"));
    expect(shared).toContain('reason: "incomplete_company_change"');
  });

  it("will not re-engage someone who 'moved to Retired'", () => {
    const src = read("server/services/linkedinEnrichment/jobChangeReengagement.ts");
    expect(src).toContain("NOT_AN_EMPLOYER");
    expect(src).toContain('reason: "new_company_not_an_employer"');
  });
});

describe("tasks due today means due today (report #8)", () => {
  it("Home reads the server stat instead of recounting", () => {
    // The client filter had no lower bound, so 144 overdue tasks counted as
    // due today (186 shown, true value 0), and it used the browser's day.
    const src = read("client/src/pages/usip/Home.tsx");
    expect(src).toContain("taskStats?.dueToday ?? 0");
    expect(src).not.toMatch(/setHours\(23, 59, 59, 999\)/);
  });
});

describe("one inbound message makes one notification (report #9)", () => {
  it("the dedupe is in the operation, not one caller", () => {
    // The IMAP poller guarded its own loop; the SendGrid webhook calls the
    // same function and bypassed it. 23 of 26 notifications appeared twice.
    const src = read("server/inboundReplyPoller.ts");
    const { text } = slice(src, "export async function processInboundReply", "// 1. Match to outbound draft");
    expect(text).toContain("eq(emailReplies.messageId, data.messageId)");
    expect(text).toContain("if (seen) return;");
  });
});

describe("a transport failure is not a verdict on the prospect", () => {
  // Live: 3 of 61 terminally-failed rows were `http_error`.
  const src = read("server/services/enrichmentSweeper.ts");

  it("transport failures stay retryable", () => {
    expect(src).toContain("QUICKENRICH_TRANSPORT_FAILURES");
    expect(src).toMatch(/new Set\(\["http_error", "network_error", "unrecognised_shape"\]\)/);
  });

  it("a genuine no_match still settles as failed", () => {
    expect(src).toMatch(/\/\/ A genuine miss[\s\S]{0,120}enrichmentStatus = "failed"/);
  });

  it("does not stamp enrichedAt when it never looked", () => {
    expect(src).toContain("delete patch.enrichedAt");
  });
});
