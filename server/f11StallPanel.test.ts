/**
 * F11 — "Why is this campaign stalled?" (built 2026-10-30).
 *
 * The panel's whole value is that its numbers are true, so these guards are
 * about truthfulness rather than layout. Three kinds, deliberately:
 *
 *   1. REAL BEHAVIOUR for `nextSendWindowOpening`, including both sides of the
 *      1 Nov 2026 DST change. It is pure, which is exactly why it was put in
 *      @shared/sendWindow instead of the router: a claim like "opens 6:00 AM
 *      Monday" is the kind that is right in October and wrong in November, and
 *      a source pin could never catch that.
 *   2. A DRIFT GUARD on the sender-pool trace. A spent pool leaves no per-row
 *      state — the engine re-schedules the rows and clears their failureReason
 *      — so the panel reads one dispatch log line, matched by a substring. If
 *      the engine rewords that line and nothing fails, the panel quietly
 *      reports "no pool trouble" for a pool that is spent. So the marker is
 *      extracted from the router and asserted against the engine's own source.
 *   3. SOURCE PINS on the scoping and on the tense. Each count has to be
 *      computed the way the ENGINE computes it (the 'skipped' exclusion in
 *      "queue full" once killed discovery on all three live campaigns), and the
 *      two gates that leave no trace have to stay in their own present-tense
 *      block, never dressed up as counts of a period.
 *
 * There is no jsdom and no testing-library in this suite, so nothing here
 * renders the panel. The pins read source text; the rendered behaviour belongs
 * to a browser and is checked against the running app.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wallTimeToUtcMs } from "@shared/availability";
import { isWithinSendWindow, nextSendWindowOpening } from "@shared/sendWindow";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const router = read("server/routers/are/campaigns.ts");
const engine = read("server/areEngine.ts");
const panel = read("client/src/components/usip/are/CampaignStallPanel.tsx");
const page = read("client/src/pages/usip/ARECampaignDetail.tsx");

const NY = "America/New_York";
const KATHMANDU = "Asia/Kathmandu"; // UTC+05:45, all year
const WEEKDAYS_6_TO_17 = { startHour: 6, endHour: 17, days: [1, 2, 3, 4, 5] };

describe("nextSendWindowOpening: the hour it names is the window's hour, in any offset", () => {
  /**
   * These dates are FIXED on purpose — they straddle the end of US daylight
   * time (1 Nov 2026) — which is the opposite of the floating-fixture rule:
   * a date computed off Date.now() must not carry a frozen offset, and a date
   * chosen to sit on a transition must not float off it.
   */
  it("crosses the 1 Nov 2026 DST change without drifting an hour", () => {
    // Saturday 24 Oct, still EDT → Monday 26 Oct 06:00 EDT.
    const beforeChange = nextSendWindowOpening(
      wallTimeToUtcMs(NY, 2026, 10, 24, 12 * 60), NY, WEEKDAYS_6_TO_17,
    );
    expect(beforeChange).toBe(wallTimeToUtcMs(NY, 2026, 10, 26, 6 * 60));

    // Saturday 31 Oct, EDT → Monday 2 Nov 06:00 EST, an hour the other side of
    // the change. Offset arithmetic frozen at -04:00 lands on 05:00 EST here;
    // this is the assertion that catches it.
    const afterChange = nextSendWindowOpening(
      wallTimeToUtcMs(NY, 2026, 10, 31, 12 * 60), NY, WEEKDAYS_6_TO_17,
    );
    expect(afterChange).toBe(wallTimeToUtcMs(NY, 2026, 11, 2, 6 * 60));

    // And the control: the two Mondays are 48h + 1h apart in real time
    // precisely BECAUSE the zone changed. If both were the same offset this
    // difference would be exactly 48h, and the test above would be passing for
    // the wrong reason.
    expect(afterChange! - beforeChange!).toBe((7 * 24 + 1) * 3_600_000);
  });

  it("names 09:00 and not 09:45 in a zone offset by three quarters of an hour", () => {
    // The reason the search steps quarter-hours. Every local whole hour in
    // Kathmandu falls at :15 past a UTC hour, so an hourly search would skip
    // the opening instant and report the window opening 45 minutes late.
    const open = nextSendWindowOpening(
      wallTimeToUtcMs(KATHMANDU, 2026, 11, 2, 0), KATHMANDU, { startHour: 9, endHour: 17, days: [0, 1, 2, 3, 4, 5, 6] },
    );
    expect(open).toBe(wallTimeToUtcMs(KATHMANDU, 2026, 11, 2, 9 * 60));
  });

  it("returns an instant that is genuinely inside the window, never merely near it", () => {
    for (const from of [
      wallTimeToUtcMs(NY, 2026, 11, 2, 5 * 60 + 59), // a minute before opening
      wallTimeToUtcMs(NY, 2026, 11, 2, 17 * 60), // the moment it shuts
      wallTimeToUtcMs(NY, 2026, 11, 7, 10 * 60), // a Saturday
      wallTimeToUtcMs(NY, 2026, 12, 31, 23 * 60), // across a year boundary
    ]) {
      const open = nextSendWindowOpening(from, NY, WEEKDAYS_6_TO_17);
      expect(open, `an opening after ${new Date(from).toISOString()}`).not.toBeNull();
      expect(open!).toBeGreaterThanOrEqual(from);
      expect(isWithinSendWindow(open!, NY, WEEKDAYS_6_TO_17)).toBe(true);
      // Nothing before it is inside the window: it is the FIRST opening.
      expect(isWithinSendWindow(open! - 15 * 60_000, NY, WEEKDAYS_6_TO_17)).toBe(false);
    }
  });

  it("is already-open-safe: asked inside the window it does not jump to next week", () => {
    const inside = wallTimeToUtcMs(NY, 2026, 11, 2, 10 * 60);
    const open = nextSendWindowOpening(inside, NY, WEEKDAYS_6_TO_17);
    expect(open).toBe(inside);
  });
});

describe("the sender pool's only trace stays pinned to the engine's own wording", () => {
  it("the marker the panel's query matches on is a literal substring of the engine's log line", () => {
    const marker = /const POOL_HELD_MARKER = "([^"]+)";/.exec(router)?.[1];
    expect(marker, "POOL_HELD_MARKER in the campaigns router").toBeTruthy();
    // THE DRIFT GUARD. If the engine's dispatch line is reworded and this
    // marker is not, the panel reports "no spent pool on record" for a pool
    // that is spent — a silent false negative, which is the failure mode this
    // whole gate exists to prevent.
    expect(engine).toContain(marker!);
    // And the engine still resets the rows rather than recording a reason,
    // which is WHY a log line is all there is to read.
    expect(engine).toContain('.set({ status: "scheduled", failureReason: null, executedAt: null })');
  });

  it("is read from the log, and the reason text is taken from after the marker", () => {
    expect(router).toContain("like(areEngineLogs.message, `%${POOL_HELD_MARKER}%`)");
    expect(router).toContain("poolLog.message.indexOf(POOL_HELD_MARKER) + POOL_HELD_MARKER.length");
    // lastSeenAt is only written when a line repeats, so a line seen once has
    // none; falling back to createdAt stops a real sighting reading as never.
    expect(router).toContain("(poolLog.lastSeenAt ?? poolLog.createdAt).toISOString()");
  });
});

describe("every count is scoped the way the engine scopes it", () => {
  it("queue-full uses the engine's 'skipped'-excluding definition", () => {
    // An unfiltered count(*) here held every campaign at "queue full" forever
    // once rejects accumulated and killed discovery on all three live
    // campaigns (areEngine.ts phase 7). A panel that counted differently would
    // say "queue full" while the engine was happily discovering.
    const sum = "sum(case when ${prospectQueue.sequenceStatus} <> 'skipped' then 1 else 0 end)";
    expect(router).toContain(sum);
    expect(engine).toContain(sum);
    expect(router).toContain("full: working >= campaign.targetProspectCount");
  });

  it("copy-held and no-email are approved-only, as the engine's gates are", () => {
    // A held row that is not approved yet is not blocking a send; counting
    // every non-null copyHoldReason would overstate the gate.
    const held = router.indexOf("const heldScope = [");
    expect(held, "heldScope").toBeGreaterThan(-1);
    // Asserted on the sliced block, not on indexOf positions: a missing
    // anchor makes indexOf return -1, and -1 is less than everything, so
    // `toBeLessThan(end)` would pass for the very mutant it exists to catch.
    // Mutation-tested on 2026-10-30, which is how that was found.
    const heldScope = router.slice(held, router.indexOf("];", held));
    expect(heldScope).toContain('eq(prospectQueue.sequenceStatus, "approved")');
    expect(heldScope).toContain("isNotNull(prospectIntelligence.copyHoldReason)");
    // The email gate is the engine's: an email STEP in the sequence and no
    // address — not every row without one, since LinkedIn-only sequences
    // enrol without an address.
    expect(router).toContain("JSON_SEARCH(${prospectIntelligence.generatedSequence}, 'one', 'email', NULL, '$[*].channel')");
  });

  it("the daily cap counts the workspace's day, not UTC midnight", () => {
    // A31: the cap rolled over at UTC midnight while the window ran in the
    // workspace zone, so for an Eastern workspace the day restarted mid-evening.
    expect(router).toContain("startOfLocalDay(await getWorkspaceTimezone(wsId), now)");
    expect(router).not.toContain("setUTCHours(0, 0, 0, 0)");
  });

  it("'no dossier' is the ABSENCE of a row, so it left-joins", () => {
    const noDossier = router.indexOf("// No dossier:");
    const leftJoin = router.indexOf(".leftJoin(prospectIntelligence", noDossier);
    const isNullSeq = router.indexOf("isNull(prospectIntelligence.generatedSequence)", leftJoin);
    expect(noDossier).toBeGreaterThan(-1);
    expect(leftJoin).toBeGreaterThan(noDossier);
    expect(isNullSeq).toBeGreaterThan(leftJoin);
    // And the other half of that gate is counted apart, because "wait for the
    // writer" and "regenerate this" are different instructions.
    expect(router).toContain("unusableSequence: num(unusable)");
  });

  it("'paused' is returned as three facts and rendered as three", () => {
    expect(router).toContain("workspaceOutbound: workspacePaused");
    expect(router).toContain("campaignStatus: campaign.status");
    expect(router).toContain("prospects: num(pausedProspects)");
    expect(panel).toContain("Workspace outbound:");
    expect(panel).toContain("This campaign: {g.paused.campaignStatus}");
    expect(panel).toContain("No individual prospect is paused");
  });
});

describe("the two gates that leave no trace are kept in the present tense", () => {
  it("they live in their own block, labelled as describing this moment", () => {
    const block1 = panel.indexOf("Stopping sends right now");
    const block2 = panel.indexOf("Why prospects aren't moving");
    expect(block1).toBeGreaterThan(-1);
    expect(block2).toBeGreaterThan(block1);
    expect(panel).toContain("leave no per-row trace, so they describe this moment — not a period");
    // The window's number is stored state read NOW — scheduled rows past their
    // time — not a tally of blocked sends, because nothing recorded those.
    expect(panel).toContain("at the first tick inside the window");
    expect(router).toContain('eq(areExecutionQueue.status, "scheduled")');
    expect(router).toContain("lte(areExecutionQueue.scheduledAt, now)");
  });

  it("the pool line says it is the engine's last word, not a live check", () => {
    expect(panel).toContain("This is the engine's last word on the pool, not a live check of it");
  });

  it("no pool line on record reads as 'not seen in N days', never as zero", () => {
    // ENGINE_LOG_RETENTION_DAYS is the horizon, so beyond it there is nothing
    // to find. Saying "0" there would be a lie with a number on it.
    expect(panel).toContain("has not reported a spent pool for this campaign in the last {s.poolLogRetentionDays} days");
    expect(router).toContain("poolLogRetentionDays: ENGINE_LOG_RETENTION_DAYS");
    // The horizon must come from the constant, not be transcribed next to it.
    expect(panel).not.toMatch(/last 30 days/);
  });

  it("names no next opening while outbound is paused", () => {
    // The pause has no end date: "opens 6:00 AM" would promise a send that is
    // not coming.
    expect(router).toContain("const nextOpen = windowOpen || workspacePaused\n        ? null");
    expect(panel).toContain("The pause has no end date");
  });
});

describe("an unknown is never rendered as a zero", () => {
  it("a failed read says 'not determined' and says the counts are unknown", () => {
    const fail = panel.indexOf("if (isError || !data)");
    expect(fail).toBeGreaterThan(-1);
    expect(panel).toContain("not determined");
    expect(panel).toContain("None of these counts is zero");
    // The failure branch is tested BEFORE anything reads `data`, or it is
    // unreachable and the panel renders zeros from an absent response.
    expect(fail).toBeLessThan(panel.indexOf("const { sending: s, gates: g } = data;"));
  });
});

describe("the top reason is ordered by what it blocks, not by size", () => {
  it("whole-campaign blockers come before per-row ones", () => {
    // Releasing six held sequences changes nothing while the workspace pause
    // is on, so the headline must not name the bigger number.
    const chain = router.slice(router.indexOf("const topReason ="), router.indexOf("return {", router.indexOf("const topReason =")));
    const at = (k: string) => chain.indexOf(`"${k}"`);
    expect(at("workspacePaused")).toBeGreaterThan(-1);
    expect(at("workspacePaused")).toBeLessThan(at("campaignNotActive"));
    expect(at("campaignNotActive")).toBeLessThan(at("windowClosed"));
    expect(at("windowClosed")).toBeLessThan(at("copyHeld"));
    expect(at("copyHeld")).toBeLessThan(at("queueFull"));
  });

  it("every key the server can return has wording on the client", () => {
    const chain = router.slice(router.indexOf("const topReason ="), router.indexOf("return {", router.indexOf("const topReason =")));
    const keys = [...chain.matchAll(/\? "([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(8);
    const wording = panel.slice(panel.indexOf("const TOP_REASON"), panel.indexOf("};", panel.indexOf("const TOP_REASON")));
    for (const k of keys) expect(wording, `wording for topReason "${k}"`).toContain(`${k}:`);
    // Null is its own answer — "not stalled" — and must not fall through to a
    // blank headline.
    expect(panel).toContain("Nothing is blocking it right now");
  });
});

describe("the panel is where the question is asked", () => {
  it("sits above the tabs on the campaign detail page", () => {
    const mount = page.indexOf("<CampaignStallPanel campaignId={campaignId} onJump={setTab} />");
    const tabs = page.indexOf("<Tabs value={tab} onValueChange={setTab}>");
    expect(mount, "the panel is mounted").toBeGreaterThan(-1);
    expect(mount).toBeLessThan(tabs);
  });
});
