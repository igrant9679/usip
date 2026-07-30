/**
 * The warmup ramp is a rate limit, so it must obey one clock.
 *
 * `warmupEngine` sends real SMTP mail on a 30-minute timer to protect a sending
 * domain's reputation. Four things were wrong with it, and three are shapes this
 * repo has already fixed elsewhere:
 *
 *  1. **The ramp and the counter used DIFFERENT DAYS.** `dayTarget` counted a
 *     rolling 24 hours from `warmupStartedAt`; `warmupTodayDate` has always been
 *     a UTC calendar day. An account first seen at 18:00 UTC sends its 2 for day
 *     one, the counter resets at 00:00 UTC, and the rolling clock still says day
 *     one until 18:00 — so day one delivers 4. One budget, two boundaries: the
 *     cadence sweep's finding (fa246a5) in a new place.
 *
 *  2. **No overlap guard.** Every other interval engine is wrapped in
 *     `guardOverlap`; this one — the only one that sends real mail on a timer —
 *     was not. A tick does up to 4 serial SMTP sends per account, and a slow
 *     host pushes it past the interval.
 *
 *  3. **Lost update.** `warmupSentToday: sentToday + sent` in JS, from a row
 *     read at the top of the tick. Fourth instance of the shape fixed in
 *     72aa576, 9bb4f3d and 899ca52 — and the one place it matters most, because
 *     the number it corrupts is a send cap.
 *
 *  4. **"A plausible working window" meant 07:00–19:00 UTC**, i.e. 03:00–15:00
 *     for an Eastern mailbox. Warmup mail arriving at 3am from a business
 *     address is the opposite of the "looks organic to receiving providers" the
 *     file's own header claims.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayTarget, warmupDayNumber } from "./services/warmupEngine";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const at = (iso: string) => new Date(iso);

describe("warmupDayNumber", () => {
  it("advances on the UTC day boundary, the same one the counter resets on", () => {
    const started = at("2026-07-01T18:00:00Z");
    expect(warmupDayNumber(started, at("2026-07-01T18:30:00Z"))).toBe(1);
    expect(warmupDayNumber(started, at("2026-07-01T23:59:59Z"))).toBe(1);
    // 00:00 UTC: warmupTodayDate rolls over, so the ramp must roll over too.
    // The old rolling-24h version still returned 1 here, which is what let day
    // one send twice its target.
    expect(warmupDayNumber(started, at("2026-07-02T00:00:00Z"))).toBe(2);
    expect(warmupDayNumber(started, at("2026-07-02T17:59:00Z"))).toBe(2);
  });

  it("is not fooled by a late-evening start", () => {
    // The worst case for the old code: started 23:59, one minute later it is a
    // new UTC day and a new counter — so it must be a new ramp day.
    const started = at("2026-07-01T23:59:00Z");
    expect(warmupDayNumber(started, at("2026-07-02T00:01:00Z"))).toBe(2);
  });

  it("counts whole calendar days across a month boundary", () => {
    expect(warmupDayNumber(at("2026-07-30T10:00:00Z"), at("2026-08-02T10:00:00Z"))).toBe(4);
  });

  it("never returns less than 1, and null without a start", () => {
    expect(warmupDayNumber(null)).toBeNull();
    expect(warmupDayNumber(undefined)).toBeNull();
    // Clock skew: a start stamped in the future must not produce day 0 or -3,
    // which would make the target negative and stall the ramp.
    expect(warmupDayNumber(at("2026-07-10T00:00:00Z"), at("2026-07-01T00:00:00Z"))).toBe(1);
  });
});

describe("dayTarget", () => {
  it("ramps 2, 4, 6 … and caps", () => {
    const s = at("2026-07-01T00:00:00Z");
    expect(dayTarget(s, at("2026-07-01T12:00:00Z"))).toBe(2);
    expect(dayTarget(s, at("2026-07-02T12:00:00Z"))).toBe(4);
    expect(dayTarget(s, at("2026-07-03T12:00:00Z"))).toBe(6);
    // Cap at 40: day 20 reaches it and nothing after exceeds it.
    expect(dayTarget(s, at("2026-07-20T12:00:00Z"))).toBe(40);
    expect(dayTarget(s, at("2026-07-28T12:00:00Z"))).toBe(40);
  });

  it("never exceeds the day's target across the counter's own boundary", () => {
    // The invariant the two clocks broke: within ONE UTC day — the window the
    // counter covers — the target is a single number.
    const started = at("2026-07-01T18:00:00Z");
    const sameDay = ["2026-07-01T18:00:00Z", "2026-07-01T20:00:00Z", "2026-07-01T23:59:00Z"];
    const targets = new Set(sameDay.map((t) => dayTarget(started, at(t))));
    expect(targets.size).toBe(1);
    const nextDay = new Set(
      ["2026-07-02T00:00:00Z", "2026-07-02T12:00:00Z", "2026-07-02T23:00:00Z"].map((t) => dayTarget(started, at(t))),
    );
    expect(nextDay.size).toBe(1);
    expect([...nextDay][0]).toBeGreaterThan([...targets][0]);
  });
});

/* ─── Source guards ──────────────────────────────────────────────────────── */

describe("warmup engine wiring", () => {
  const src = stripComments(read("server/services/warmupEngine.ts"));

  it("increments its counters in SQL, not in JS", () => {
    // `sentToday + sent` reads a row from the top of the tick; two overlapping
    // ticks then record two batches as one and the ramp is spent twice.
    expect(src).toMatch(/warmupTotalSent: sql`/);
    expect(src).toMatch(/sql`\$\{sendingAccounts\.warmupSentToday\} \+ /);
    expect(src).not.toMatch(/warmupSentToday: sentToday \+ sent/);
    expect(src).not.toMatch(/warmupTotalSent: \(acct\.warmupTotalSent/);
  });

  it("derives both the ramp day and the counter day from a UTC day", () => {
    expect(src).toMatch(/from\s*"@shared\/timeWindows"/);
    expect(src).toMatch(/utcDayStart\(/);
    // The rolling-24h arithmetic must not come back.
    expect(src).not.toMatch(/now\.getTime\(\) - .*startedAt.*\) \/ 86_400_000/);
  });

  it("checks working hours in the workspace's timezone, not the container's", () => {
    // getUTCHours() on the tick was the whole bug: the window is a claim about
    // the recipient's day, not the server's.
    expect(src).not.toMatch(/const hour = now\.getUTCHours\(\)/);
    expect(src).toMatch(/getWorkspaceTimezone\(/);
    expect(src).toMatch(/zonedDowHour\(/);
  });

  it("is overlap-guarded like every other interval engine", () => {
    // It sends real SMTP mail on a timer — the one engine that most needs this,
    // and the only one that did not have it.
    const core = stripComments(read("server/_core/index.ts"));
    expect(core).toMatch(/guardOverlap\("Warmup"/);
    // And the guarded runner is what the interval calls.
    expect(core).toMatch(/setInterval\(runWarmup,/);
  });

  it("still describes its own window truthfully", () => {
    // The header claimed "07:00–19:00 UTC" while the code now reads the
    // workspace zone. A header that contradicts the code is how the last four
    // sweeps started.
    const header = read("server/services/warmupEngine.ts").slice(0, 1400);
    expect(header).not.toMatch(/07:00–19:00 UTC/);
    expect(header).toMatch(/WORKSPACE'S OWN TIMEZONE/i);
  });
});
