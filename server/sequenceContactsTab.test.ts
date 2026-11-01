/**
 * The v2 sequence editor's Contacts tab (/v2/sequences/:id), rebuilt
 * 2026-11-01.
 *
 * It rendered six tiles. Two were the same enrolled count printed twice, and
 * the other four were the literal number `0` in the accent colour — four
 * decorations in the type of a measurement — above an empty-state card that
 * rendered unconditionally and never listed a single enrolled person, however
 * many there were. Same family as the F12 "Ready" that was asserted from the
 * absence of any evidence: a panel answering a question it has no data for.
 *
 * These guards protect the decisions, not the layout:
 *
 *   1. The tiles are the enrollment states the SCHEMA has, and the set is
 *      pinned against `enrollments.status` itself — so a fifth state added to
 *      the enum fails here instead of quietly going uncounted.
 *   2. The invented labels stay deleted. They are only banned in CODE: the
 *      comment that explains why they went has to be free to name them, which
 *      is the mistake this project already made once (AREHub, PR #22).
 *   3. An unknown is not drawn as a zero. While the query is loading or has
 *      failed the tiles read "—" and the failure is stated in words.
 *   4. The counts and the list come from ONE query, so they cannot disagree.
 *   5. "Enrolled" keeps the definition `liveEnrolledCounts` uses, or the
 *      header would contradict the count on the Sequences list.
 *   6. The empty state is reachable only when there is nobody to list.
 *
 * No jsdom in this suite, so these are source pins; the rendering itself
 * belongs to a browser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const editorSrc = read("client/src/pages/usip/SequenceEditor.tsx");
const schema = read("drizzle/schema.ts");
const router = read("server/routers/sequences.ts");

/**
 * The file with its comments removed. Every "is it still gone?" assertion runs
 * against this, never the raw source — a ban that also bans its own
 * explanation is a guard that punishes documenting the decision.
 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const editorCode = stripComments(editorSrc);

/** The Contacts tab component, comments and all. */
const tabBlock = (() => {
  const i = editorSrc.indexOf("function ContactsTab(");
  const j = editorSrc.indexOf("\nfunction AddStepButton(", i);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  return editorSrc.slice(i, j);
})();
const tabCode = stripComments(tabBlock);

describe("Contacts tab — the tiles are the states the schema has", () => {
  it("pins the tile set to the enrollments.status enum", () => {
    // The enum, read out of the enrollments table block rather than matched
    // loosely: several tables have a column called `status`.
    const table = schema.slice(
      schema.indexOf("export const enrollments = mysqlTable("),
      schema.indexOf("export const emailDrafts = mysqlTable("),
    );
    const m = /status:\s*mysqlEnum\("status",\s*\[([^\]]+)\]\)/.exec(table);
    expect(m).toBeTruthy();
    const schemaStates = m![1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    expect(schemaStates).toEqual(["active", "paused", "finished", "exited"]);

    const states = [...editorCode.matchAll(/\{\s*key:\s*"([a-z]+)",\s*label:\s*"([A-Za-z]+)"/g)];
    expect(states.map((s) => s[1])).toEqual(schemaStates);
    // And each one is labelled as itself, not re-badged into a funnel stage.
    expect(states.map((s) => s[2])).toEqual(["Active", "Paused", "Finished", "Exited"]);
  });

  it("counts every tile off the listed rows, with no literal tile values", () => {
    expect(tabCode).toContain("ENROLLMENT_STATES.map((s) =>");
    expect(tabCode).toContain("counts[s.key]");
    // The old shape: a tile whose value was written into the array literal.
    expect(tabCode).not.toMatch(/\{\s*l:\s*"[A-Za-z ]+",\s*v:\s*0\s*\}/);
    expect(tabCode).not.toMatch(/v:\s*seq\.enrolledCount/);
  });

  it("keeps the four invented labels out of the code", () => {
    // Banned in code only — see the file header. Each of these was a tile
    // with nothing behind it in `enrollments`.
    for (const label of ["Cold", "Approaching", "Interested", "In progress"]) {
      expect(editorCode).not.toContain(`"${label}"`);
      expect(editorCode).not.toContain(`>${label}<`);
    }
    // "Replied" is the one that is buildable, from the analytics service and
    // not from enrollment state. Until it is wired up it must not appear.
    expect(tabCode).not.toContain("Replied");
    // The explanation is expected to survive in the comments, so that whoever
    // wants the tiles back learns why they went.
    expect(editorSrc).toContain("getPerformanceAnalytics");
  });
});

describe("Contacts tab — an unknown is not a zero", () => {
  it("renders an em dash, not 0, until the rows are read", () => {
    // Unknown is keyed off the rows existing, not off a loading flag: this
    // query is enabled only when the tab opens, so `isLoading` is false with
    // no data on the first paint and a flag-based check flashed four zeros.
    expect(tabCode).toContain("const rows = Array.isArray(query.data) ? (query.data as any[]) : null;");
    expect(tabCode).toContain("const known = query.isError ? null : rows;");
    // The count is only reachable under `known`; the other branch is a dash.
    expect(tabCode).toMatch(/known\s*\?\s*\(counts\[s\.key\]\s*\?\?\s*0\)\s*:\s*<span/);
    expect(tabCode).toContain("—");
    expect(tabCode).toContain("Not read yet — not zero");
  });

  it("says so in words when the read failed", () => {
    expect(tabCode).toContain("query.isError && (");
    expect(tabCode).toContain("shown as unknown rather than zero");
    // Neither a failed read nor an unread one may fall through to the
    // "nobody is enrolled" card. Both branches are taken before it, and the
    // slice starts at the list so the indexes below cannot be satisfied by
    // some earlier mention of either check.
    const at = tabCode.indexOf("{query.isError ? null : known === null ? (");
    expect(at).toBeGreaterThan(-1);
    const list = tabCode.slice(at);
    const empty = list.indexOf("No contacts enrolled yet");
    expect(empty).toBeGreaterThan(-1);
    expect(list.indexOf("query.isError ? null")).toBeLessThan(empty);
    expect(list.indexOf("known === null ?")).toBeLessThan(empty);
  });

  it("derives the header count the way liveEnrolledCounts does", () => {
    // Bounded to that function: the same inArray appears again further down
    // the router, and an unbounded slice would be satisfied by the wrong one.
    const from = router.indexOf("export async function liveEnrolledCounts");
    const live = router.slice(from, router.indexOf("\n}", from));
    expect(live).toContain('inArray(enrollments.status, ["active", "paused", "finished"])');
    expect(tabCode).toMatch(
      /const enrolled = known\s*\?\s*\(counts\.active \?\? 0\) \+ \(counts\.paused \?\? 0\) \+ \(counts\.finished \?\? 0\)\s*:\s*null;/,
    );
    expect(tabCode).toContain("`${enrolled} enrolled`");
  });
});

describe("Contacts tab — it lists the people", () => {
  it("lists them from the existing resolver, once", () => {
    const calls = [...editorCode.matchAll(/trpc\.sequences\.listEnrollments/g)];
    expect(calls).toHaveLength(1);
    // A second source of enrollment numbers is a second number that can
    // disagree with the rows on screen.
    expect(editorCode).not.toContain("getEnrollmentStats");
    expect(editorCode).not.toContain("getEnrollmentStepStats");
  });

  it("shows WHO, with the link the resolver already returns", () => {
    // The row's label itself, not just a mention of the field — the avatar
    // initial also reads personName, and pinning only that let a mutant put
    // "Enrollment #372" back as the name while still passing.
    expect(tabCode).toContain("const name = e?.personName || `Enrollment #${e?.id}`;");
    expect(tabCode).toContain("`/prospects/${e.personId}`");
    expect(tabCode).toContain("e?.leadHref");
    expect(tabCode).toContain("Step {(e?.currentStep ?? 0) + 1}");
    // An auto-resuming pause reads differently from a rep's own pause.
    expect(tabCode).toContain("e?.resumeAt");
  });

  it("shows the empty state only when nobody is enrolled", () => {
    expect(tabCode).toMatch(/ordered\.length === 0 \? \(/);
    const before = tabCode.slice(0, tabCode.indexOf("No contacts enrolled yet"));
    expect(before).toContain("ordered.length === 0");
    // The old version rendered the card unconditionally and said "N enrolled"
    // inside it as a bare string.
    expect(tabCode).not.toMatch(/\$\{seq\.enrolledCount\}\s*enrolled/);
  });

  it("does not offer an action it has not wired up", () => {
    // Read-only by decision: pause / resume / exit live on legacy /sequences,
    // recorded as a gap. A button that looks live and does nothing is the
    // same defect class as a tile that shows a zero it cannot compute.
    expect(tabCode).not.toContain("resumeEnrollment");
    expect(tabCode).not.toContain("exitEnrollment");
    expect(tabCode).toContain("Read-only.");
  });
});
