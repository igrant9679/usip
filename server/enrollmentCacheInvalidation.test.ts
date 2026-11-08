/**
 * Every writer that changes who is in a sequence must invalidate every read
 * whose numbers come from that — through one function, not a subset each.
 *
 * The bug this exists for (found 2026-11-06, shipped broken by me in PR #24).
 * `AddToMenu` and the People `SelectionToolbar` invalidated
 * `getEnrollmentStats` and nothing else. That was correct until PR #24 moved
 * the v2 editor's Contacts tab onto `listEnrollments`, and then it was a
 * write nobody told the reader about: enrol from the People page and an open
 * Contacts tab kept showing the old counts and the old list. The counts were
 * honest about what they had read — what they had read was stale. Nothing
 * invalidated `sequences.list` / `sequences.get` (both carry the live
 * `enrolledCount`) or `getPerformanceAnalytics` (whose `totalEnrolled`,
 * `active`, `paused` and `exited` are enrolment counts) after a bulk enrol
 * either, so PR #29's new Report tab inherited the same lag.
 *
 * A subset is the failure mode, so the guard is not "assert the missing
 * line": it derives the writers from the source and fails if any of them
 * invalidates an enrolment read by hand instead of going through the shared
 * function. A writer added next year is covered without editing this file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client", "src");
const read = (abs: string) => readFileSync(abs, "utf8").replace(/\r\n/g, "\n");

/** Comments removed — a ban that also bans its own explanation is a trap. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

const FILES = walk(CLIENT).map((abs) => ({
  rel: abs.slice(CLIENT.length + 1).split(sep).join("/"),
  code: stripComments(read(abs)),
  raw: read(abs),
}));

const HELPER_REL = "lib/enrollmentCache.ts";
const helper = FILES.find((f) => f.rel === HELPER_REL);

/**
 * tRPC procedures that change who is in a sequence, or what state they are
 * in. `enroll` is the single-person one; the segment auto-enrol rules run
 * server-side and have no cache to invalidate.
 */
const ENROLMENT_WRITES = [
  "bulkEnroll", "enroll", "resumeEnrollment", "exitEnrollment",
  "pauseEnrollment", "pauseOnReply",
] as const;

/**
 * Reads whose answer changes when one of those writes lands. The first two
 * are shared with writes that have nothing to do with enrolment (create,
 * fork, publish, assign), so they are required IN the helper but not banned
 * outside it; the middle three answer only about enrolments, so a writer
 * touching them by hand is the subset bug coming back.
 */
const ENROLMENT_READS = ["list", "get", "listEnrollments", "getEnrollmentStats", "getEnrollmentStepStats", "getPerformanceAnalytics"] as const;
const ENROLMENT_ONLY_READS = ["listEnrollments", "getEnrollmentStats", "getEnrollmentStepStats"] as const;

const writerFiles = FILES.filter((f) =>
  f.rel !== HELPER_REL &&
  ENROLMENT_WRITES.some((w) => f.code.includes(`trpc.sequences.${w}.useMutation`)),
);

describe("the shared enrolment invalidation", () => {
  it("exists and names every enrolment-derived read", () => {
    expect(helper).toBeTruthy();
    expect(helper!.code).toContain("export function invalidateEnrollmentReads");
    for (const q of ENROLMENT_READS) {
      expect(helper!.code, `${q} must be invalidated`).toMatch(
        new RegExp(`\\bs\\.${q}\\.invalidate\\(`),
      );
    }
  });

  it("names nothing that no screen reads", () => {
    // A stale entry here would be invisible: invalidating a query nobody
    // reads is free and silent, so it would sit until someone wondered.
    for (const q of ENROLMENT_READS) {
      const readers = FILES.filter((f) => f.code.includes(`trpc.sequences.${q}.useQuery`));
      expect(readers.length, `${q} is invalidated but nothing reads it`).toBeGreaterThan(0);
    }
  });

  it("does not take over onError", () => {
    // A shared handler hid the per-site error declaration from
    // clientMutationErrors.test.ts once already (PR #29, b51fb4ab). This
    // function invalidates and nothing else.
    expect(helper!.code).not.toContain("onError");
    expect(helper!.code).not.toContain("toast");
  });
});

describe("every enrolment writer goes through it", () => {
  it("finds the writers this repo actually has", () => {
    // If this list shrinks, a writer was deleted or renamed and the rules
    // below stopped covering it — the point of deriving it from source.
    // 2026-11-07 (U14, one sequence editor): the bulk enrol picker moved out of
    // legacy Sequences.tsx into SequenceEnrollDialog so the v2 editor opens it,
    // and "Mark replied" (pauseOnReply) came into the editor as its own button.
    // Both are writers and both go through the shared function; the retired
    // page keeps its row actions, so it is still listed.
    expect(writerFiles.map((f) => f.rel).sort()).toEqual([
      "components/usip/AddToMenu.tsx",
      "components/usip/SequenceEnrollDialog.tsx",
      "components/usip/SequenceEnrollmentActions.tsx",
      "components/usip/SequenceMarkReply.tsx",
      "components/usip/people/SelectionToolbar.tsx",
      "pages/usip/Sequences.tsx",
    ]);
  });

  it("imports and calls the shared function in each", () => {
    for (const f of writerFiles) {
      expect(f.code, `${f.rel} must import it`).toContain(
        'import { invalidateEnrollmentReads } from "@/lib/enrollmentCache"',
      );
      expect(f.code, `${f.rel} must call it`).toContain("invalidateEnrollmentReads(utils");
    }
  });

  it("invalidates no enrolment-only read by hand", () => {
    for (const f of writerFiles) {
      for (const q of ENROLMENT_ONLY_READS) {
        expect(f.code, `${f.rel} invalidates ${q} by hand — use the shared function`).not.toMatch(
          new RegExp(`utils\\.sequences\\.${q}\\.invalidate\\(`),
        );
      }
    }
  });

  it("still declares its own onError at every write site", () => {
    // clientMutationErrors.test.ts owns this rule; asserted here too because
    // this change edited the bodies right next to those declarations.
    for (const f of writerFiles) {
      const sites = [...f.code.matchAll(/trpc\.sequences\.(\w+)\.useMutation\(\{([\s\S]*?)\n  \}\)/g)];
      for (const [, name, body] of sites) {
        if (!(ENROLMENT_WRITES as readonly string[]).includes(name)) continue;
        expect(body, `${f.rel}::${name} needs onError in its options`).toContain("onError");
      }
    }
  });
});

describe("the regression itself", () => {
  it("the v2 Contacts tab's query is one the enrol paths invalidate", () => {
    const editor = FILES.find((f) => f.rel === "pages/usip/SequenceEditor.tsx")!;
    // The tab reads listEnrollments and NOT getEnrollmentStats — that switch,
    // in PR #24, is what made the People-page enrol path go stale.
    expect(editor.code).toContain("trpc.sequences.listEnrollments.useQuery");
    expect(editor.code).not.toContain("getEnrollmentStats");
    expect(helper!.code).toMatch(/\bs\.listEnrollments\.invalidate\(/);

    // And the two paths that were only invalidating the old query reach it.
    for (const rel of ["components/usip/AddToMenu.tsx", "components/usip/people/SelectionToolbar.tsx"]) {
      const f = FILES.find((x) => x.rel === rel)!;
      expect(f.code).toContain("invalidateEnrollmentReads(utils, vars.sequenceId)");
    }
  });
});
