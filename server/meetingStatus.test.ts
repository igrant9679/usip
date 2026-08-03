/**
 * "Is this meeting still live?" must have one answer.
 *
 * THREE files asked it and each answered with its own array literal, and no two
 * agreed:
 *
 *   bookingLinks.BUSY_MEETING_STATUSES        proposed invited scheduled rescheduled
 *   meetingScheduler.ACTIVE_MEETING_STATUSES  proposed invited scheduled
 *   meetingReminders.REMINDER_STATUSES                 invited scheduled
 *
 * 🔴 The autopilot's copy was the one that bit. That array decides whether a
 * prospect ALREADY has a live meeting; without `rescheduled` a prospect who
 * moved their meeting stopped counting, read as unbooked, and got a SECOND
 * proposal — in `auto` mode, a second invite. The dealAutopilot/`snoozed`
 * finding (9f2e78f) in a different table: the person tells us when they are
 * free, and the engine books over it.
 *
 * 🔴 The reminder copy failed the other way: a meeting the attendee MOVED got
 * no reminder, while the time they abandoned had already had one.
 *
 * The guard parses the enum out of schema.ts, so an EIGHTH status fails here
 * until somebody classifies it — rather than defaulting to "not live" and
 * silently disabling every check at once.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  MEETING_STATUSES,
  LIVE_MEETING_STATUSES,
  CLOSED_MEETING_STATUSES,
  REMINDABLE_MEETING_STATUSES,
  isLiveMeetingStatus,
  liveMeetingStatuses,
  remindableMeetingStatuses,
} from "@shared/meetingStatus";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── The list matches the database ───────────────────────────────────────── */

describe("the shared list is the schema's list", () => {
  /**
   * Parsed from `meetings`' own enum. Bounded to that table: scanning raw
   * source for the enum block is how the task-status parser picked up a
   * SEVENTH status out of a trailing comment (9f2e78f), so the window starts
   * at the meetings table and stops at its closing status line.
   */
  const schemaEnum = (() => {
    const src = read("drizzle/schema.ts");
    const tableAt = src.indexOf(`export const meetings = mysqlTable(`);
    expect(tableAt, "the meetings table was not found — this whole file would be vacuous").toBeGreaterThan(-1);
    const enumAt = src.indexOf(`status: mysqlEnum("status", [`, tableAt);
    expect(enumAt, "the status enum was not found inside the meetings table").toBeGreaterThan(tableAt);
    const end = src.indexOf("])", enumAt);
    expect(end, "could not bound the status enum").toBeGreaterThan(enumAt);
    // Strip comments FIRST — the enum block annotates each value inline.
    const block = strip(src.slice(enumAt, end));
    return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).filter((v) => v !== "status");
  })();

  it("found a real enum (floor)", () => {
    expect(schemaEnum.length).toBeGreaterThanOrEqual(7);
  });

  it("MEETING_STATUSES is exactly the database enum, in order", () => {
    expect([...MEETING_STATUSES]).toEqual(schemaEnum);
  });

  it("LIVE and CLOSED are exhaustive and disjoint over it", () => {
    /**
     * The assertion that makes an eighth status a decision instead of an
     * accident: a new value belongs to one side or the other, and until
     * somebody says which, this fails.
     */
    const union = [...LIVE_MEETING_STATUSES, ...CLOSED_MEETING_STATUSES].sort();
    expect(union).toEqual([...MEETING_STATUSES].sort());
    for (const s of LIVE_MEETING_STATUSES) {
      expect(CLOSED_MEETING_STATUSES, `${s} is in both sets`).not.toContain(s);
    }
  });

  it("rescheduled counts as LIVE — the bug this file exists for", () => {
    expect(LIVE_MEETING_STATUSES).toContain("rescheduled");
    expect(isLiveMeetingStatus("rescheduled")).toBe(true);
  });

  it("the remindable set is a strict subset of live, excluding proposed", () => {
    /**
     * Narrower ON PURPOSE. A `proposed` meeting is an AI-drafted candidate the
     * attendee never agreed to — "a quick reminder about our meeting" would be
     * asserting an appointment that does not exist, to a stranger.
     */
    for (const s of REMINDABLE_MEETING_STATUSES) {
      expect(LIVE_MEETING_STATUSES, `${s} is remindable but not live`).toContain(s);
    }
    expect(REMINDABLE_MEETING_STATUSES).not.toContain("proposed");
    expect(REMINDABLE_MEETING_STATUSES).toContain("rescheduled");
    expect(REMINDABLE_MEETING_STATUSES.length).toBeLessThan(LIVE_MEETING_STATUSES.length);
  });

  it("the mutable copies are copies, not the shared arrays", () => {
    // Drizzle's inArray mutates nothing, but a caller that sorts the result
    // would otherwise reorder the definition for everyone.
    const a = liveMeetingStatuses();
    a.push("completed");
    expect(LIVE_MEETING_STATUSES).not.toContain("completed");
    expect(remindableMeetingStatuses()).not.toBe(REMINDABLE_MEETING_STATUSES);
  });

  it("unknown values are not live", () => {
    expect(isLiveMeetingStatus("")).toBe(false);
    expect(isLiveMeetingStatus("Scheduled")).toBe(false);
    expect(isLiveMeetingStatus("pending")).toBe(false);
  });
});

/* ── Nobody re-declares it ───────────────────────────────────────────────── */

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      out.push(rel);
    }
  };
  walk("server");
  return out;
}

describe("no file keeps its own meeting-status list", () => {
  const files = serverFiles();

  it("scans real source (floor)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("no inline array literal enumerates meeting statuses", () => {
    /**
     * Scans for the RULE, not the NAME — `8ec606b`'s lesson, where a fifth copy
     * hid under the identifier `t`. Any array literal containing two or more
     * meeting-status strings is a re-declaration, whatever it is called.
     */
    const offenders: string[] = [];
    for (const f of files) {
      const src = strip(read(f));
      for (const m of src.matchAll(/\[[^\]\n]{0,200}?\]/g)) {
        const hits = [...MEETING_STATUSES].filter((s) => m[0].includes(`"${s}"`));
        // Two is the threshold: a single `"scheduled"` is an ordinary
        // comparison, but two together is somebody rebuilding the set.
        if (hits.length >= 2) offenders.push(`${f}  ${m[0].slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nInline meeting-status arrays:\n  ${offenders.join("\n  ")}\n\n` +
          `Import liveMeetingStatuses() / remindableMeetingStatuses() from\n` +
          `@shared/meetingStatus instead. Three hand-written copies disagreed,\n` +
          `and the autopilot's — missing "rescheduled" — booked a second meeting\n` +
          `over one the prospect had just moved.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the three original consumers read the shared definition", () => {
    // Floor + direction: naming them means deleting a consumer's import fails
    // here rather than silently reverting it to a literal.
    const expectImport = (rel: string) =>
      expect(read(rel), `${rel} no longer imports @shared/meetingStatus`)
        .toMatch(/^import \{[^}]*\} from "@shared\/meetingStatus";$/m);
    expectImport("server/routers/bookingLinks.ts");
    expectImport("server/services/meetingScheduler.ts");
    expectImport("server/services/meetingReminders.ts");
    // The FOURTH copy, which the scanner above found on its first run: this
    // router kept the whole enum for a z.enum(). Same shape as activities.ts
    // under the task-status guard.
    expectImport("server/routers/meetings.ts");
  });
});

/* ── The transition that had to reset something ──────────────────────────── */

describe("rescheduling clears the reminder stamp", () => {
  it("sets reminderSentAt back to null in the same statement", () => {
    /**
     * `reminderSentAt` records "we have reminded them about THIS meeting", and
     * the reminder cron only considers rows where it is NULL. Left stamped
     * across a reschedule, the attendee got a reminder for the time they
     * abandoned and none for the time they chose.
     *
     * Pinned as one statement: setting the new time in one UPDATE and clearing
     * the stamp in another would leave a window where the cron could fire on
     * the new time with the old stamp still absent.
     */
    const src = strip(read("server/routers/meetings.ts"));
    const at = src.indexOf("reschedule: repProcedure");
    expect(at, "the reschedule procedure was not found").toBeGreaterThan(-1);
    const end = src.indexOf("complete: repProcedure", at);
    expect(end, "could not bound the reschedule procedure").toBeGreaterThan(at);
    const proc = src.slice(at, end);
    expect(proc.length).toBeGreaterThan(200);

    expect(proc).toMatch(/status: "rescheduled"/);
    expect(proc).toMatch(/scheduledAt: new Date\(input\.scheduledAt\)/);
    expect(proc, "a rescheduled meeting still carries its old reminder stamp")
      .toMatch(/reminderSentAt: null/);
  });
});
