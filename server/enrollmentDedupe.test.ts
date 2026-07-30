/**
 * Duplicate enrollment from the inbound surfaces.
 *
 * `enrollments` has no unique index (only ix_enr_seq / ix_enr_prospect), and
 * sequenceEngine does not deduplicate by recipient address at send time — it
 * resolves `toEmail` per enrollment and sends. So two active enrollments for one
 * person means every step of the sequence goes out twice, and nothing downstream
 * catches it.
 *
 * crm.ts's bulk enroll already guarded this by (sequenceId, contactId). The
 * three inbound surfaces did not, and a contactId/leadId check would not have
 * saved them: forms.submit, landingPages.submit and the chat agent each INSERT A
 * NEW LEAD on every submission — there is no find-or-create by email. Submit the
 * form twice and you get two lead rows, two active enrollments, and the sequence
 * twice.
 *
 * The dedupe key is therefore the EMAIL. Duplicate LEAD rows are left alone on
 * purpose: lead matching is a product decision this codebase is deliberately
 * conservative about (CSV import's matchOnNameCompany is opt-in and defaults
 * OFF). Double-sending to a stranger is the harm worth preventing here, and it
 * is preventable without touching lead identity.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { hasActiveEnrollmentForEmail } from "./services/enrollmentDedupe";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Minimal chainable fake of the drizzle select builder. */
function fakeDb(rows: unknown[], onWhere?: (v: unknown) => void) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: (v: unknown) => { onWhere?.(v); return chain; },
    limit: async () => rows,
  };
  return chain;
}

describe("hasActiveEnrollmentForEmail", () => {
  it("reports true when a matching active enrollment exists", async () => {
    expect(await hasActiveEnrollmentForEmail(fakeDb([{ id: 1 }]), 1, 2, "a@b.com")).toBe(true);
  });

  it("reports false when none exists", async () => {
    expect(await hasActiveEnrollmentForEmail(fakeDb([]), 1, 2, "a@b.com")).toBe(false);
  });

  it("skips the check when there is no email", async () => {
    // Nothing to dedupe on, and an empty address cannot be mailed anyway.
    let queried = false;
    const db = fakeDb([{ id: 1 }], () => { queried = true; });
    expect(await hasActiveEnrollmentForEmail(db, 1, 2, null)).toBe(false);
    expect(await hasActiveEnrollmentForEmail(db, 1, 2, "   ")).toBe(false);
    expect(queried).toBe(false);
  });

  it("fails OPEN on a database error", async () => {
    // A submitted form that silently enrolls nobody is worse than a rare
    // duplicate, so an error must not be read as "already enrolled".
    const db: any = { select: () => { throw new Error("db down"); } };
    expect(await hasActiveEnrollmentForEmail(db, 1, 2, "a@b.com")).toBe(false);
  });
});

describe("every inbound surface that auto-enrols checks first", () => {
  const INBOUND = [
    "server/routers/forms.ts",
    "server/routers/landingPages.ts",
    "server/routers/chatAgents.ts",
  ];

  for (const file of INBOUND) {
    it(`${file} guards its enrollment insert`, () => {
      const src = read(file);
      expect(src, `${file} no longer inserts enrollments — update this list`).toContain("insert(enrollments)");
      expect(src).toContain("hasActiveEnrollmentForEmail");
    });
  }

  it("no OTHER router auto-enrols without a dedupe check", () => {
    // Catches a fourth inbound surface being added later with the same omission.
    const dir = join(ROOT, "server", "routers");
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
      }
    })(dir);

    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      const src = readFileSync(f, "utf8");
      if (!src.includes("insert(enrollments)")) continue;
      const guarded =
        src.includes("hasActiveEnrollmentForEmail") ||
        // crm.ts / segmentRules.ts / sequences.ts guard by contactId or
        // prospectId against a record they looked up rather than created.
        /Already enrolled|already enrolled|existingEnrol|alreadyEnrolled/.test(src) ||
        /\.from\(enrollments\)/.test(src);
      if (!guarded) offenders.push(rel);
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nRouter(s) inserting enrollments with no dedupe of any kind:\n  ${offenders.join("\n  ")}\n\n` +
            `enrollments has no unique index and sequenceEngine does not dedupe by\n` +
            `recipient at send time, so a duplicate enrollment sends the whole sequence\n` +
            `again. Use hasActiveEnrollmentForEmail() from services/enrollmentDedupe.\n`
        : undefined,
    ).toEqual([]);
  });
});
