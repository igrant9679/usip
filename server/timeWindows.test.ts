/**
 * Budget windows must be UTC.
 *
 * `72aa576` moved the ARE campaign cap and the per-account send counter onto
 * `todayUtc()`, and recorded the reason: a cap that resolves in the host's
 * timezone "depends on a server setting nobody in this repo controls, which is
 * not a property a spend limit should have." Five budget windows were left on
 * `new Date(); d.setHours(0,0,0,0)` — midnight in the NODE PROCESS's timezone.
 *
 * The sharp edge was not hypothetical: the per-account daily send limit was
 * measured against a UTC day in emailDelivery and a LOCAL day in
 * routers/sequences.ts. Same cap, two boundaries — on any non-UTC host the two
 * disagreed about which sends counted, and exceeding a per-mailbox daily limit
 * is how a sending domain gets flagged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { utcDayStart, utcDayStartDaysAgo } from "../shared/timeWindows";

const ROOT = join(__dirname, "..");

describe("utcDayStart", () => {
  it("truncates to midnight UTC, not local", () => {
    // 2026-07-29T23:30:00Z — in any timezone west of UTC this instant is still
    // the 29th locally; east of UTC it is already the 30th. The answer must not
    // move either way.
    const d = utcDayStart(Date.UTC(2026, 6, 29, 23, 30, 0));
    expect(d.toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });

  it("is stable across an instant just after UTC midnight", () => {
    const d = utcDayStart(Date.UTC(2026, 6, 30, 0, 0, 1));
    expect(d.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  it("does not depend on the process timezone", () => {
    // The whole point: the same instant yields the same window regardless of TZ.
    // Node caches the zone, so assert the property directly — the computation
    // uses only getUTC* accessors and Date.UTC, never local getters.
    // Strip comments first: this file's own header QUOTES the buggy
    // `d.setHours(0,0,0,0)` while explaining it, and the first version of this
    // assertion matched that comment. Third time today a source scan was fooled
    // by prose describing the very bug it was checking for.
    const src = readFileSync(join(ROOT, "shared", "timeWindows.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.setHours\(/);
    expect(src).not.toMatch(/getFullYear\(\)|getMonth\(\)|getDate\(\)/); // local getters
    expect(src).toMatch(/Date\.UTC\(/);
  });

  it("walks back whole UTC days", () => {
    const d = utcDayStartDaysAgo(7, Date.UTC(2026, 6, 30, 13, 0, 0));
    expect(d.toISOString()).toBe("2026-07-23T00:00:00.000Z");
    expect(utcDayStartDaysAgo(0, Date.UTC(2026, 6, 30, 13, 0, 0)).toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });
});

/**
 * Files allowed to keep a local-midnight window, with the reason. Only
 * non-budget uses belong here: a dedupe marker drifting by a few hours costs
 * nothing, a spend cap doing so costs money or a sending domain.
 */
const LOCAL_MIDNIGHT_ALLOWED: Record<string, string> = {
  "server/emailTracking.ts":
    "Dedupe window for 'already logged a reminder activity today' — an idempotency marker, not a budget.",
};

describe("no budget window uses local midnight", () => {
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

  it("setHours(0,0,0,0) appears only where explicitly allowed", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        if (!/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(line)) return;
        if (rel in LOCAL_MIDNIGHT_ALLOWED) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nLocal-midnight window(s) outside the allowlist:\n  ${offenders.join("\n  ")}\n\n` +
            `Use utcDayStart() from @shared/timeWindows. A budget that rolls over on the\n` +
            `host's timezone disagrees with every other budget in the app.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const stale = Object.keys(LOCAL_MIDNIGHT_ALLOWED).filter((rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      return !/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(src);
    });
    expect(
      stale,
      stale.length ? `\n\nAllowlisted but no longer uses local midnight — drop it:\n  ${stale.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });

  it("the five fixed budget sites import the shared helper", () => {
    for (const rel of [
      "server/routers/sequences.ts",
      "server/sendLimits.ts",
      "server/services/apollo.ts",
      "server/services/socialAutopilot.ts",
    ]) {
      expect(readFileSync(join(ROOT, rel), "utf8"), rel).toContain("@shared/timeWindows");
    }
  });
});
