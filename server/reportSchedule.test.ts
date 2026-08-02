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
import { activeRecipients, isDue, renderReportHtml } from "./services/reportScheduler";
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

/**
 * Offboarding must stop the DELIVERY, not just the login.
 *
 * `saved_reports.scheduleRecipients` is free text and nothing connected it to
 * membership. 3366f4b and e5da0fb revoked a deactivated member's access — they
 * could no longer sign in or see the workspace in the switcher — and this
 * hourly cron carried on emailing them the pipeline every week, indefinitely.
 * The body is runSpec() output: real deal, contact and pipeline rows.
 *
 * Two halves, because the two offboarding paths leave different evidence:
 *   deactivate → the membership row survives with deactivatedAt set, so the
 *                address is recognisable at SEND time and filtered here.
 *                Reactivating restores delivery with no setting lost.
 *   delete     → team.delete removes the membership row, and the user row too
 *                when no memberships remain. Nothing is left to recognise, so
 *                admin.ts strips the address at removal time instead.
 */
describe("activeRecipients — a revoked member stops receiving the data", () => {
  it("drops a deactivated member's address", () => {
    expect(activeRecipients(["rep@acme.com", "boss@acme.com"], ["rep@acme.com"])).toEqual([
      "boss@acme.com",
    ]);
  });

  it("KEEPS an external address that was never a member", () => {
    /**
     * The load-bearing half. Emailing a report to a client or an exec with no
     * Velocity account is what the free-text field is FOR. A filter that
     * dropped unknown addresses would quietly break every such schedule while
     * looking like a security fix.
     */
    expect(activeRecipients(["cfo@client.com", "rep@acme.com"], ["rep@acme.com"])).toEqual([
      "cfo@client.com",
    ]);
  });

  it("compares case-insensitively and ignores surrounding whitespace", () => {
    // An address is case-insensitive, and the field is comma-separated free
    // text typed by a human — "Rep@Acme.com , x" is the normal shape.
    expect(activeRecipients([" Rep@Acme.COM ", "boss@acme.com"], ["rep@acme.com"])).toEqual([
      "boss@acme.com",
    ]);
    expect(activeRecipients(["rep@acme.com"], [" REP@ACME.COM "])).toEqual([]);
  });

  it("returns everything when nobody is revoked", () => {
    const all = ["a@x.com", "b@x.com"];
    expect(activeRecipients(all, [])).toEqual(all);
  });

  it("can empty the list — the caller must not send to nobody", () => {
    // emailSavedReport turns this into a refusal rather than a send with an
    // empty `to`, which some transports happily accept.
    expect(activeRecipients(["rep@acme.com"], ["rep@acme.com"])).toEqual([]);
  });

  it("a member with a NULL email cannot affect anyone else's delivery", () => {
    // Such a row normalises to "" in the revoked set. It must decide nothing.
    expect(activeRecipients(["a@x.com", "b@x.com"], ["", "   "])).toEqual(["a@x.com", "b@x.com"]);
  });

  it("never returns a blank recipient, whoever is revoked", () => {
    /**
     * Dropped on its own account rather than as a side effect of the revoked
     * set. My first version filtered blanks out of the revoked set instead, so
     * whether a blank recipient survived depended on whether some UNRELATED
     * member happened to have a null email — and the test I wrote for it was
     * vacuous, passing with the filter removed. Caught by re-running the
     * battery; the function moved, not the assertion.
     */
    expect(activeRecipients(["", "  ", "a@x.com"], [])).toEqual(["a@x.com"]);
    expect(activeRecipients(["", "a@x.com"], [""])).toEqual(["a@x.com"]);
    expect(activeRecipients([""], ["rep@acme.com"])).toEqual([]);
  });
});

describe("the filter is actually wired into the send path", () => {
  const src = readFileSync(join(ROOT, "server/services/reportScheduler.ts"), "utf8");

  it("emailSavedReport filters before it sends", () => {
    const at = src.indexOf("export async function emailSavedReport");
    expect(at, "emailSavedReport not found").toBeGreaterThan(0);
    const fn = src.slice(at, at + 1800);
    expect(fn).toMatch(/const recipients = activeRecipients\(configured, await revokedMemberEmails\(/);
    // Ordering: the filter must precede the send, or it decides nothing.
    const filtered = fn.indexOf("activeRecipients(");
    const sent = fn.indexOf("sendSystemEmail(");
    expect(filtered).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(sent);
  });

  it("refuses to send when the filter empties the list", () => {
    const at = src.indexOf("export async function emailSavedReport");
    const fn = src.slice(at, at + 1800);
    expect(fn).toMatch(/if \(recipients\.length === 0\)[\s\S]{0,120}?return \{ ok: false/);
  });

  it("scopes the revoked lookup to the workspace AND to deactivated rows", () => {
    const at = src.indexOf("async function revokedMemberEmails");
    expect(at, "revokedMemberEmails not found").toBeGreaterThan(0);
    const fn = src.slice(at, at + 900);
    expect(fn).toMatch(/eq\(workspaceMembers\.workspaceId, workspaceId\)/);
    expect(fn).toMatch(/isNotNull\(workspaceMembers\.deactivatedAt\)/);
    // Without the join it cannot compare addresses at all.
    expect(fn).toMatch(/innerJoin\(users, eq\(users\.id, workspaceMembers\.userId\)\)/);
  });
});

describe("team.delete strips the departing member from every schedule", () => {
  const admin = readFileSync(join(ROOT, "server/routers/admin.ts"), "utf8");

  const del = (() => {
    const at = admin.indexOf("  delete: adminWsProcedure");
    expect(at, "team.delete not found").toBeGreaterThan(0);
    const next = admin.indexOf("bulkChangeRole:", at);
    expect(next, "could not bound the handler").toBeGreaterThan(at);
    return admin.slice(at, next);
  })();

  it("reads the workspace's schedules and rewrites them", () => {
    expect(del).toMatch(/from\(savedReports\)/);
    expect(del).toMatch(/eq\(savedReports\.workspaceId, ctx\.workspace\.id\)/);
    expect(del).toMatch(/await db\.update\(savedReports\)/);
  });

  it("matches the address case-insensitively", () => {
    // Invited as "Rep@Acme.com", typed into the schedule as "rep@acme.com".
    expect(del).toMatch(/tgtEmail = \(tgtUser\?\.email \?\? ""\)\.trim\(\)\.toLowerCase\(\)/);
    expect(del).toMatch(/e\.toLowerCase\(\) !== tgtEmail/);
  });

  it("turns the schedule OFF when it strips the last recipient", () => {
    // Otherwise the cron runs the report every hour and fails to deliver it
    // forever — "No valid recipients configured" on a loop.
    expect(del).toMatch(/scheduleRecipients: null, scheduleFreq: "none"/);
  });

  it("runs while the user record still exists", () => {
    /**
     * The whole reason this lives in the handler rather than at send time:
     * team.delete removes the membership row and, when no memberships remain,
     * the user row. Both destroy the evidence this needs. It must therefore
     * read tgtUser BEFORE the deletes and strip BEFORE them too.
     */
    const capture = del.indexOf("const [tgtUser] = await db.select()");
    const strip = del.indexOf("from(savedReports)");
    const delMember = del.indexOf("delete(workspaceMembers)");
    const delUser = del.indexOf("delete(users)");
    expect(capture).toBeGreaterThan(0);
    expect(strip).toBeGreaterThan(capture);
    expect(delMember).toBeGreaterThan(strip);
    expect(delUser).toBeGreaterThan(strip);
  });

  it("reports what it did, rather than doing it silently", () => {
    // An admin who set up that schedule needs to know it changed.
    expect(del).toMatch(/strippedFromReports/);
    expect(del).toMatch(/return \{ ok: true[^}]*strippedFromReports/);
  });
});
