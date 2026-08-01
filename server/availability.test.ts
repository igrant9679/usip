/**
 * Offerable times must belong to the person being offered them.
 *
 * The meeting autopilot's slot generator read "business-hour slots (10:00 /
 * 14:00 local)" and built them with `setHours()` + `getDay()`. **Local is the
 * Node process's timezone**, which in production is UTC — so it proposed 10:00
 * and 14:00 UTC, i.e. 6am and 10am to an Eastern prospect, and evaluated "is
 * this a weekend?" in UTC too. That is the identical defect already recorded and
 * fixed for the booking link ("It was UTC, which offered prospects 4am ET"):
 * fixed in one of the two generators, missed in the other — the one that mails a
 * stranger a proposal.
 *
 * The times were then handed to the LLM as `new Date(s).toLocaleString()` — the
 * host's zone, unlabelled — and the model wrote those digits into the invite. A
 * proposed time without a zone is not a time.
 *
 * And the zone it should have used was sitting unread: `workspace_settings.timezone`
 * is settable in Settings under copy promising it is "used for scheduling,
 * reporting, and activity timestamps", and NOTHING read it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  formatInZone, generateSlots, localDateOf, safeTimezone, tzOffsetMs, wallTimeToUtcMs, zonedDayKey,
} from "../shared/availability";
import { computeSlots } from "./services/meetingScheduler";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Hour-of-day of an instant, as read in a zone. */
const hourIn = (iso: string, tz: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false })
    .format(new Date(iso)).replace(/\D/g, "")) % 24;

const NY = "America/New_York";

describe("timezone primitives", () => {
  it("is DST-aware", () => {
    // Same wall-clock hour, two sides of a DST boundary: -5h in January, -4h in July.
    expect(tzOffsetMs(NY, Date.UTC(2026, 0, 15, 17))).toBe(-5 * 3600_000);
    expect(tzOffsetMs(NY, Date.UTC(2026, 6, 15, 17))).toBe(-4 * 3600_000);
  });

  it("maps a wall-clock time to the right UTC instant in both seasons", () => {
    expect(new Date(wallTimeToUtcMs(NY, 2026, 1, 15, 9 * 60)).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(new Date(wallTimeToUtcMs(NY, 2026, 7, 15, 9 * 60)).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("reads the local calendar date, not the UTC one", () => {
    // 01:30Z on the 16th is still the 15th in New York — the boundary that made
    // a UTC weekend check offer Saturday slots.
    expect(localDateOf(NY, Date.UTC(2026, 6, 16, 1, 30))).toMatchObject({ y: 2026, m: 7, d: 15 });
  });

  it("falls back to UTC for a bad zone instead of throwing", () => {
    expect(safeTimezone("Mars/Olympus_Mons")).toBe("UTC");
    expect(safeTimezone(null)).toBe("UTC");
    expect(safeTimezone(NY)).toBe(NY);
  });
});

/**
 * `zonedDayKey` was exported by d682552 as the tz-aware counterpart of
 * `toISOString().slice(0, 10)` — the inline form that put every row after
 * 4pm Pacific on tomorrow's bar and reported a deal closed 6pm Pacific as
 * closing the next day. It had NO tests. Replacing its body with exactly the
 * expression it exists to replace passed the whole suite.
 *
 * Every case below is a real instant checked against `Intl`, because zone
 * arithmetic is not intuition — the reportScheduler sweep asserted a
 * US/Pacific claim that was simply wrong until it was printed.
 */
describe("zonedDayKey", () => {
  it("returns the LOCAL calendar day, not the UTC one", () => {
    // 01:30Z on the 16th is still the 15th in New York.
    expect(zonedDayKey(NY, Date.UTC(2026, 6, 16, 1, 30))).toBe("2026-07-15");
    // ...and the same instant really is the 16th in UTC, so the two differ.
    expect(zonedDayKey("UTC", Date.UTC(2026, 6, 16, 1, 30))).toBe("2026-07-16");
  });

  it("flips the calendar day the other way east of UTC", () => {
    // 22:00Z on the 15th is already the 16th in Sydney.
    expect(zonedDayKey("Australia/Sydney", Date.UTC(2026, 6, 15, 22))).toBe("2026-07-16");
  });

  it("crosses the MONTH boundary, which is what broke the monthly report", () => {
    // 2026-02-01T08:00Z is Sat 31 Jan 22:00 in Honolulu — a report scheduled
    // "monthly, on the 1st" arrived on the last day of the month before.
    expect(zonedDayKey("Pacific/Honolulu", Date.UTC(2026, 1, 1, 8))).toBe("2026-01-31");
    expect(zonedDayKey("UTC", Date.UTC(2026, 1, 1, 8))).toBe("2026-02-01");
  });

  it("is DST-aware rather than a hardcoded offset", () => {
    // 07:30Z is the previous day in Los Angeles in January (PST, -8) but the
    // same day in July (PDT, -7). A fixed -8 passes one and fails the other.
    expect(zonedDayKey("America/Los_Angeles", Date.UTC(2026, 0, 15, 7, 30))).toBe("2026-01-14");
    expect(zonedDayKey("America/Los_Angeles", Date.UTC(2026, 6, 15, 7, 30))).toBe("2026-07-15");
  });

  it("zero-pads, so the keys sort and compare as strings", () => {
    // The whole point is `===` against another day key and ORDER in a chart.
    expect(zonedDayKey("UTC", Date.UTC(2026, 0, 5, 12))).toBe("2026-01-05");
    expect(zonedDayKey("UTC", Date.UTC(2026, 0, 5, 12)) < zonedDayKey("UTC", Date.UTC(2026, 0, 12, 12))).toBe(true);
  });

  it("falls back to UTC for a bad zone instead of throwing", () => {
    expect(zonedDayKey("Mars/Olympus_Mons", Date.UTC(2026, 6, 16, 1, 30))).toBe("2026-07-16");
  });
});

describe("formatInZone", () => {
  it("names the zone, so a bare hour can never be misread", () => {
    const s = formatInZone("2026-07-15T13:00:00.000Z", NY);
    expect(s).toContain("9:00");
    expect(s).toMatch(/EDT|GMT-4/);
  });

  it("renders the same instant differently in two zones", () => {
    const utc = formatInZone("2026-07-15T13:00:00.000Z", "UTC");
    expect(utc).toContain("1:00");
    expect(utc).not.toEqual(formatInZone("2026-07-15T13:00:00.000Z", NY));
  });
});

describe("generateSlots", () => {
  it("puts every slot inside the window as the REP reads it", () => {
    const slots = generateSlots([], 30, Date.UTC(2026, 6, 13, 12), {
      timezone: NY, startHour: 9, endHour: 17,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const h = hourIn(s, NY);
      expect(h, `${s} → ${h}h in ${NY}`).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(17);
    }
  });

  it("never offers a weekend in the rep's zone", () => {
    const slots = generateSlots([], 30, Date.UTC(2026, 6, 13, 12), { timezone: NY });
    for (const s of slots) {
      const dow = new Date(s).getUTCDay();
      // Every slot is 9-17 local, so its UTC weekday equals its local weekday.
      expect(dow === 0 || dow === 6, `${s} is a weekend`).toBe(false);
    }
  });

  it("honours the lead time and skips busy ranges", () => {
    const now = Date.UTC(2026, 6, 13, 12);
    const soon = generateSlots([], 30, now, { timezone: "UTC", leadMs: 48 * 3600_000 });
    expect(new Date(soon[0]).getTime()).toBeGreaterThanOrEqual(now + 48 * 3600_000);

    const busy = [{ startAt: new Date(Date.UTC(2026, 6, 14, 9)), endAt: new Date(Date.UTC(2026, 6, 14, 17)) }];
    const around = generateSlots(busy, 30, now, { timezone: "UTC" });
    expect(around.some((s) => s.startsWith("2026-07-14T"))).toBe(false);
  });
});

describe("computeSlots (meeting autopilot)", () => {
  it("proposes mid-morning / mid-afternoon in the WORKSPACE zone, not the host's", () => {
    // The bug: these came back as 10:00Z and 14:00Z — 6am and 10am in New York.
    const slots = computeSlots([], 2, 30, NY);
    expect(slots.length).toBe(2);
    expect(slots.map((s) => hourIn(s, NY)).sort()).toEqual([10, 14]);
  });

  it("returns slots in chronological order", () => {
    const slots = computeSlots([], 3, 30, NY);
    expect([...slots].sort()).toEqual(slots);
  });

  it("still yields proposals when the preferred hours are busy", () => {
    // A calendar blocking every 10:00 and 14:00 must degrade to other hours
    // rather than returning nothing — an autopilot that proposes no time is the
    // same as an autopilot that is off.
    const busy: Array<{ startAt: Date; endAt: Date }> = [];
    for (let d = 0; d < 20; d++) {
      busy.push({ startAt: new Date(Date.UTC(2026, 0, 1 + d, 14)), endAt: new Date(Date.UTC(2026, 0, 1 + d, 16)) });
      busy.push({ startAt: new Date(Date.UTC(2026, 0, 1 + d, 18)), endAt: new Date(Date.UTC(2026, 0, 1 + d, 20)) });
    }
    expect(computeSlots(busy, 2, 30, NY).length).toBeGreaterThan(0);
  });

  it("falls back to UTC rather than throwing on an unusable zone", () => {
    expect(computeSlots([], 1, 30, "Nowhere/Land").length).toBe(1);
  });
});

/* ─── Source guards ──────────────────────────────────────────────────────── */

/**
 * Files allowed to derive a time from the host clock, with the reason. Explicit,
 * not heuristic. `setHours`/`getDay`/`getHours` read the process timezone — a
 * deployment detail — so they may never decide a time somebody is offered, nor
 * label a figure somebody reads.
 *
 * `getMonth`/`getDate`/`getMinutes` are deliberately NOT banned: 24 sites use
 * them for ordinary date arithmetic (`d.setDate(d.getDate() + 1)`), and a rule
 * that flags two dozen correct call sites is a rule someone switches off. Same
 * judgement as secretRandomness.test.ts, which bans Math.random() for secrets
 * rather than banning the call.
 */
const HOST_CLOCK_ALLOWED: Record<string, string> = {
  "server/emailTracking.ts":
    "Local-midnight dedupe window for 'already logged a reminder today' — an " +
    "idempotency marker, not an offerable time. Also allowlisted in timeWindows.test.ts.",
  "server/_core/index.ts":
    "setHours(24,0,0,0) schedules the nightly AI batch at the host's next " +
    "midnight. A background job's CADENCE may follow the container clock — " +
    "nobody is offered this time and no figure is labelled with it. A " +
    "workspace-local nightly run would need one timer per workspace.",
};

describe("no offerable time comes from the host clock", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const files = sourceFiles(join(ROOT, "server"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("nothing schedules or buckets with setHours(), getDay() or getHours()", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      if (rel in HOST_CLOCK_ALLOWED) continue;
      const raw = readFileSync(f, "utf8");
      const src = stripComments(raw);
      if (!/\.setHours\(|\.getDay\(\)|\.getHours\(\)/.test(src)) continue;
      // Report from RAW source: line numbers taken from comment-stripped text
      // are wrong, because stripping block comments removes their newlines.
      const m = raw.match(/\.setHours\(|\.getDay\(\)|\.getHours\(\)/);
      const line = m?.index !== undefined ? raw.slice(0, m.index).split("\n").length : 0;
      offenders.push(`${rel}:${line}`);
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nHost-clock time arithmetic:\n  ${offenders.join("\n  ")}\n\n` +
            `Use @shared/availability. setHours()/getDay() read the container's\n` +
            `timezone, so a slot "at 10:00" is 10:00 UTC in production — 6am for an\n` +
            `Eastern prospect.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const stale = Object.keys(HOST_CLOCK_ALLOWED).filter(
      (rel) => !/\.setHours\(|\.getDay\(\)|\.getHours\(\)/.test(stripComments(read(rel))),
    );
    expect(stale).toEqual([]);
  });
});

describe("one slot generator, one timezone source", () => {
  it("generateSlots is defined only in the shared module", () => {
    const definers = [
      "server/routers/bookingLinks.ts",
      "server/services/meetingScheduler.ts",
    ].filter((rel) => /(function|const)\s+generateSlots/.test(stripComments(read(rel))));
    expect(
      definers,
      definers.length ? `\n\nSecond definition of generateSlots in:\n  ${definers.join("\n  ")}\n` : undefined,
    ).toEqual([]);
    expect(stripComments(read("shared/availability.ts"))).toMatch(/export function generateSlots/);
  });

  it("both schedulers import it from @shared/availability", () => {
    for (const rel of ["server/routers/bookingLinks.ts", "server/services/meetingScheduler.ts"]) {
      expect(stripComments(read(rel)), rel).toMatch(/from\s*"@shared\/availability"/);
    }
  });

  it("the workspace timezone setting has a reader", () => {
    // It was saved, described in Settings as governing "scheduling, reporting,
    // and activity timestamps", and read by NOTHING. A setting that is written
    // but never read is invisible unless a test asserts the read exists.
    expect(stripComments(read("server/services/workspaceTimezone.ts")))
      .toMatch(/workspaceSettings\.timezone/);
  });

  it("all three things Settings promises it governs actually read it", () => {
    const consumers: Record<string, string> = {
      "server/services/meetingScheduler.ts": "scheduling — proposed meeting slots",
      "server/routers/operations.ts": "reporting — the activity heatmap's day/hour buckets",
      "server/routers/activities.ts": "activity timestamps — the Tasks 'due today' count",
    };
    for (const [rel, why] of Object.entries(consumers)) {
      expect(stripComments(read(rel)), `${rel} (${why})`).toMatch(/getWorkspaceTimezone\(/);
    }
  });

  it("the autopilot passes the workspace zone into the generator", () => {
    expect(stripComments(read("server/services/meetingScheduler.ts")))
      .toMatch(/computeSlots\([^)]*workspaceTz/);
  });

  it("the times shown to the LLM and the rep carry their zone", () => {
    const sched = stripComments(read("server/services/meetingScheduler.ts"));
    // `toLocaleString()` with no zone is the bug: it renders in the host's zone
    // and says nothing about which one.
    expect(sched).not.toMatch(/toLocaleString\(\)/);
    expect(sched).toMatch(/formatInZone\(/);
    expect(stripComments(read("server/routers/bookingLinks.ts"))).toMatch(/formatInZone\(/);
  });
});
