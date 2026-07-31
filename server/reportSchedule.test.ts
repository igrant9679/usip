/**
 * A scheduled report is due in the CUSTOMER's morning, not the container's.
 *
 * `isDue` was entirely UTC: `getUTCHours() < 8`, `getUTCDay() === 1`,
 * `getUTCDate() === 1`, and a `toISOString()` day for the already-sent marker.
 * The module header called that "delivered in the morning" — but 08:00 UTC is
 * 8am in exactly one timezone. It is midnight in US Pacific, 3am in US Eastern
 * and 7pm in Sydney, and at UTC-9 or further west the calendar day flips, so
 * "monthly, on the 1st" fired on the last day of the previous month.
 *
 * `workspace_settings.timezone` is settable in Settings under copy promising it
 * governs "scheduling, reporting, and activity timestamps". `c791703` wired all
 * three and read "reporting" as the activity heatmap; this is the other
 * reporting surface — the one actually called Reports.
 *
 * Every instant below was verified against Intl before being asserted, and the
 * comment on each says what the local clock reads there.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDue, renderReportHtml } from "./services/reportScheduler";
import { zonedDayKey } from "@shared/availability";

const ROOT = join(__dirname, "..");

const LA = "America/Los_Angeles";
const NY = "America/New_York";
const SYD = "Australia/Sydney";
const HNL = "Pacific/Honolulu";

/** 2026-01-05 is a Monday; 2026-02-01 is a Sunday. */
const at = (iso: string) => new Date(iso);

describe("isDue — daily", () => {
  it("still fires at 08:00 for a UTC workspace (no behaviour change there)", () => {
    expect(isDue("daily", null, at("2026-01-05T08:00:00Z"), "UTC")).toBe(true);
    expect(isDue("daily", null, at("2026-01-05T07:00:00Z"), "UTC")).toBe(false);
  });

  it("does NOT fire at 08:00 UTC for US Pacific — that is midnight there", () => {
    // The regression assertion: this instant is Mon Jan 5, 00:00 in LA.
    expect(isDue("daily", null, at("2026-01-05T08:00:00Z"), LA)).toBe(false);
  });

  it("fires at 08:00 local for US Pacific", () => {
    expect(isDue("daily", null, at("2026-01-05T15:00:00Z"), LA)).toBe(false); // 07:00 LA
    expect(isDue("daily", null, at("2026-01-05T16:00:00Z"), LA)).toBe(true);  // 08:00 LA
  });

  it("tracks DST rather than a fixed offset", () => {
    // Same wall-clock hour, six months apart: 15:00Z is 07:00 PST in January
    // and 08:00 PDT in July. A hardcoded -8 would get one of these wrong.
    expect(isDue("daily", null, at("2026-01-05T15:00:00Z"), LA)).toBe(false);
    expect(isDue("daily", null, at("2026-07-06T15:00:00Z"), LA)).toBe(true);
  });

  it("fires at 08:00 local for US Eastern and Sydney", () => {
    expect(isDue("daily", null, at("2026-01-05T08:00:00Z"), NY)).toBe(false); // 03:00 EST
    expect(isDue("daily", null, at("2026-01-05T13:00:00Z"), NY)).toBe(true);  // 08:00 EST
    expect(isDue("daily", null, at("2026-01-04T20:00:00Z"), SYD)).toBe(false); // 07:00 AEDT Jan 5
    expect(isDue("daily", null, at("2026-01-04T21:00:00Z"), SYD)).toBe(true);  // 08:00 AEDT Jan 5
  });
});

describe("isDue — the already-sent marker is a LOCAL day", () => {
  it("does not resend within the same local day", () => {
    const sent = at("2026-01-05T16:30:00Z"); // Mon 08:30 LA
    // Mon 16:00 LA — a NEW UTC day (Jan 6), the same LA day.
    expect(isDue("daily", sent, at("2026-01-06T00:00:00Z"), LA)).toBe(false);
  });

  it("sends again once the local day rolls over", () => {
    const sent = at("2026-01-05T16:30:00Z"); // Mon 08:30 LA
    expect(isDue("daily", sent, at("2026-01-06T16:00:00Z"), LA)).toBe(true); // Tue 08:00 LA
  });
});

describe("isDue — weekly and monthly land on the right LOCAL day", () => {
  it("weekly does not fire on Sunday evening in Hawaii", () => {
    // 2026-01-05T08:00Z is Sun Jan 4, 22:00 HST — UTC's Monday, not theirs.
    expect(isDue("weekly", null, at("2026-01-05T08:00:00Z"), HNL)).toBe(false);
    // Mon Jan 5, 08:00 HST.
    expect(isDue("weekly", null, at("2026-01-05T18:00:00Z"), HNL)).toBe(true);
  });

  it("weekly fires on the local Monday for US Pacific", () => {
    expect(isDue("weekly", null, at("2026-01-06T16:00:00Z"), LA)).toBe(false); // Tue 08:00 LA
    expect(isDue("weekly", null, at("2026-01-05T16:00:00Z"), LA)).toBe(true);  // Mon 08:00 LA
  });

  it("monthly does not fire on the last day of the PREVIOUS month in Hawaii", () => {
    // 2026-02-01T08:00Z is Sat 31 Jan, 22:00 HST. The old code sent there.
    expect(isDue("monthly", null, at("2026-02-01T08:00:00Z"), HNL)).toBe(false);
    // Sun 1 Feb, 08:00 HST.
    expect(isDue("monthly", null, at("2026-02-01T18:00:00Z"), HNL)).toBe(true);
  });
});

describe("isDue — unchanged rules", () => {
  it("never fires for freq none, or an unknown freq", () => {
    expect(isDue("none", null, at("2026-01-05T16:00:00Z"), LA)).toBe(false);
    expect(isDue("nonsense", null, at("2026-01-05T16:00:00Z"), LA)).toBe(false);
  });

  it("falls back to UTC for a missing or nonsense timezone", () => {
    // safeTimezone's job — a bad value must not throw inside a cron loop.
    expect(isDue("daily", null, at("2026-01-05T08:00:00Z"))).toBe(true);
    expect(isDue("daily", null, at("2026-01-05T08:00:00Z"), "Not/AZone")).toBe(true);
  });
});

describe("the emailed report renders dates in the workspace's zone", () => {
  const result = {
    grouped: false,
    columns: [{ key: "closeDate", label: "Close date", kind: "date" as const }],
    // 2026-01-05T08:00Z is Sun 4 Jan, 22:00 in Honolulu.
    rows: [{ closeDate: new Date("2026-01-05T08:00:00Z") }],
  };

  it("prints the local calendar day, not the UTC one", () => {
    expect(renderReportHtml("Deals", result, HNL)).toContain("2026-01-04");
    expect(renderReportHtml("Deals", result, "UTC")).toContain("2026-01-05");
  });

  it("names the zone, so a date in an email is never ambiguous", () => {
    // Same rule as formatInZone: a time without a zone is not a time.
    expect(renderReportHtml("Deals", result, HNL)).toContain("Pacific/Honolulu");
  });

  it("still escapes the report name", () => {
    const html = renderReportHtml('Q1 <img src=x onerror="alert(1)">', result, "UTC");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("zonedDayKey", () => {
  it("returns the local calendar day, not the UTC one", () => {
    expect(zonedDayKey("UTC", Date.parse("2026-01-05T08:00:00Z"))).toBe("2026-01-05");
    expect(zonedDayKey(HNL, Date.parse("2026-01-05T08:00:00Z"))).toBe("2026-01-04");
    expect(zonedDayKey(SYD, Date.parse("2026-01-04T21:00:00Z"))).toBe("2026-01-05");
  });

  it("zero-pads, so keys sort lexicographically", () => {
    expect(zonedDayKey("UTC", Date.parse("2026-02-01T12:00:00Z"))).toBe("2026-02-01");
    expect(zonedDayKey("UTC", Date.parse("2026-11-09T12:00:00Z"))).toBe("2026-11-09");
  });
});

/**
 * Anti-drift. Comments are stripped first — this module's own header now quotes
 * `getUTCHours()` and `toISOString()` while explaining the bug, and a raw scan
 * would match the prose. That trap has bitten this repo five times.
 */
describe("reportScheduler does not reach for the container's clock", () => {
  const src = readFileSync(join(ROOT, "server/services/reportScheduler.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("finds source to scan (guards the scanner itself)", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("isDue");
  });

  it("uses no UTC-day or UTC-hour accessor", () => {
    expect(src).not.toMatch(/getUTCHours\(\)|getUTCDay\(\)|getUTCDate\(\)/);
    expect(src).not.toMatch(/toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/);
  });

  it("resolves the workspace timezone instead", () => {
    expect(src).toContain("getWorkspaceTimezone");
    expect(src).toContain("zonedDayKey");
  });
});
