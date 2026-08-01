/**
 * Guard for the quietest dead-wiring shape in this repo:
 *
 *   "a setting with a column, a save path, and no reader."
 *
 * It is invisible from every angle a normal check looks at. The column exists,
 * the mutation succeeds, the page redisplays the value it just saved, and the
 * user reasonably concludes the setting is in force. Nothing errors, ever.
 *
 * ARE Settings had six of these at once. Its own copy promised "New campaigns
 * will inherit this autonomy mode", "will have these channels pre-selected" and
 * "inherit this sequence structure" — and the campaign wizard hardcoded its own
 * values and read none of them. The autonomy one inverted a safety choice: the
 * column defaults to `batch_approval`, the wizard hardcoded `"full"`, so a
 * workspace that deliberately picked review_release still created campaigns
 * fully autonomous.
 *
 * This test reads the keys `settings.getAreSettings` returns and requires each
 * to be referenced somewhere that is NOT the router that returns it or the page
 * that edits it — i.e. somewhere that actually acts on it. Anything that is not
 * yet enforced must be named in KNOWN_UNENFORCED, so "this control does
 * nothing" is a tracked fact rather than a discovery.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Settings that exist, are saved, and are enforced by NOTHING. Each is a
 * control the user can set with no effect. Listed rather than silently
 * tolerated; delete an entry when it gains a real consumer, and delete the
 * setting itself if it turns out nobody wants it.
 */
const KNOWN_UNENFORCED: Record<string, string> = {
  areMaxConcurrentCampaigns:
    "No concurrency cap is enforced anywhere. canLaunchCampaign() is a readiness checklist, not this.",
  areSequenceQualityThreshold:
    "No reader. Nothing scores or gates generated sequences against it.",
  areIcpRegenSchedule:
    "No reader. runIcpInferenceAllWorkspaces uses its own fixed daily cadence + a <20h freshness skip.",
  areBrandVoice:
    "Only read back to redisplay. AI writers use buildBrandContext()/the brandVoice router instead — this is a second, losing vocabulary.",
  // These three are doubly dead: no reader AND no feature. areEngine.ts never
  // inserts a notification at all, so there is nothing for the toggles to gate.
  // Turning "Notify me when a meeting is booked" ON does nothing, and OFF does
  // equally nothing — which is the worse half, because a user who wants the
  // alert has no way to learn they will never get one.
  areNotifyOnMeetingBooked: "No reader, and areEngine sends no notifications at all.",
  areNotifyOnAutoApprove: "No reader, and areEngine sends no notifications at all.",
  areNotifyOnIcpUpdate: "No reader, and the ICP cron sends no notification.",
};

/** Files that merely define/serve/edit the setting rather than act on it. */
const NON_CONSUMERS = [
  "server/routers/admin.ts",
  "client/src/pages/usip/ARESettings.tsx",
  "drizzle/schema.ts",
  "server/_core/rawMigrations.ts",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Keys the getAreSettings query returns. */
function areSettingKeys(): string[] {
  const src = read("server/routers/admin.ts");
  const start = src.indexOf("getAreSettings:");
  const ret = src.indexOf("return {", start);
  const end = src.indexOf("\n  }),", ret);
  return [...src.slice(ret, end).matchAll(/^\s{6}(are[A-Za-z]+):/gm)].map((m) => m[1]);
}

describe("ARE settings are actually enforced", () => {
  const keys = areSettingKeys();

  it("finds the settings block (guards the scanner itself)", () => {
    expect(keys.length).toBeGreaterThan(8);
  });

  /**
   * THE REVERSE DIRECTION, which was missing entirely.
   *
   * Everything else here derives its key list FROM the getAreSettings return
   * block and checks each key is consumed. Delete a key from that block and it
   * simply drops out of the list — fewer keys, still above the floor, green.
   * Removing `areDefaultDailySendCap` passed.
   *
   * The harm is the one this file's own message describes: the column still
   * exists, settings.save still writes it, and the UI reads a value that is
   * never returned — so it renders a default, the user re-sets it, and their
   * choice silently never applies. "A control that silently does nothing is
   * worse than one that is absent."
   *
   * Anchored on the SCHEMA, which is the thing that cannot quietly shrink.
   */
  it("every are* column in workspace_settings is returned by getAreSettings", () => {
    const schema = read("drizzle/schema.ts");
    const start = schema.indexOf("export const workspaceSettings");
    expect(start, "workspaceSettings table not found in schema").toBeGreaterThan(-1);
    const block = schema.slice(start, schema.indexOf("\n});", start));
    const columns = [...block.matchAll(/^\s{2}(are[A-Za-z0-9]+):/gm)].map((m) => m[1]);

    // Floor: a scan that finds no columns would report a clean result.
    expect(columns.length, "no are* columns found — has the table been renamed?").toBeGreaterThan(10);

    const missing = columns.filter((c) => !keys.includes(c));
    expect(
      missing,
      missing.length
        ? `\n\nare* column(s) saved on workspace_settings but NOT returned by\n` +
            `getAreSettings:\n  ${missing.join("\n  ")}\n\n` +
            `The column still exists and settings.save still writes it, so the value is\n` +
            `stored and never read back. The ARE Settings page then renders a default,\n` +
            `the user re-sets it, and it silently never applies.\n`
        : undefined,
    ).toEqual([]);
  });

  it("every setting is either consumed by real code or declared unenforced", () => {
    const files = [...sourceFiles(join(ROOT, "server")), ...sourceFiles(join(ROOT, "client", "src"))]
      .map((f) => f.slice(ROOT.length + 1).split(sep).join("/"))
      .filter((f) => !NON_CONSUMERS.includes(f) && !/\.test\.tsx?$/.test(f));

    const blob = files.map((f) => read(f)).join("\n");

    const undeclared = keys.filter(
      (k) => !new RegExp(`\\b${k}\\b`).test(blob) && !(k in KNOWN_UNENFORCED),
    );
    expect(
      undeclared,
      undeclared.length
        ? `\n\nThese ARE settings are saved but nothing reads them:\n  ${undeclared.join("\n  ")}\n\n` +
            `Either wire them into the code that should honour them, or add them to\n` +
            `KNOWN_UNENFORCED with a note. A control that silently does nothing is worse\n` +
            `than one that is absent — the user believes it took effect.\n`
        : undefined,
    ).toEqual([]);
  });

  it("KNOWN_UNENFORCED has no stale entries", () => {
    // If a setting gains a consumer, the entry must go — otherwise the list
    // stops describing reality and the next dead setting hides inside it.
    const files = [...sourceFiles(join(ROOT, "server")), ...sourceFiles(join(ROOT, "client", "src"))]
      .map((f) => f.slice(ROOT.length + 1).split(sep).join("/"))
      .filter((f) => !NON_CONSUMERS.includes(f) && !/\.test\.tsx?$/.test(f));
    const blob = files.map((f) => read(f)).join("\n");

    const nowWired = Object.keys(KNOWN_UNENFORCED).filter((k) => new RegExp(`\\b${k}\\b`).test(blob));
    expect(
      nowWired,
      nowWired.length
        ? `\n\nThese are listed as unenforced but now have a consumer — drop them from\n` +
            `KNOWN_UNENFORCED:\n  ${nowWired.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("the campaign wizard seeds its form from the workspace defaults", () => {
    // The specific regression: blankForm() hardcoding values the settings page
    // says new campaigns inherit. autonomyMode is the one that inverted a
    // safety choice, so pin it by name.
    const wiz = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(wiz).toContain("areDefaultAutonomyMode");
    expect(wiz).toMatch(/autonomyMode:\s*wsDefaults\.autonomyMode/);
    expect(
      /autonomyMode:\s*"full"/.test(wiz),
      'ARECampaigns.tsx hardcodes autonomyMode "full" again — that overrides the workspace default and silently maximises autonomy.',
    ).toBe(false);
  });
});
