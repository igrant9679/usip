/**
 * The Renewals board's columns, pinned for the first time.
 *
 * This page has twice shipped a column list that did not match the enum:
 *
 *   · the first column was `"secure"`, a value customers.renewalStage cannot
 *     hold, so `buckets["early"]` — the DEFAULT every newly-won customer is
 *     stamped with — did not exist and `?.push()` dropped them silently. Reps
 *     undercounted their whole book while "Secure" sat empty.
 *   · the hand-written replacement then ordered the columns early / 30 / 60 /
 *     90, so a card advancing through its contract travelled right, then left,
 *     then left again.
 *
 * Both are the same defect: a literal list beside the enum, drifting. The board
 * now reads RENEWAL_STAGES, whose order IS the schema's, and this file is what
 * stops the literal coming back. vitest only collects server/**, so a client
 * page can only be pinned from here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RENEWAL_STAGES } from "@shared/renewalStage";

const ROOT = join(__dirname, "..");
const SRC = readFileSync(join(ROOT, "client/src/pages/usip/Renewals.tsx"), "utf8");
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

describe("the columns come from the enum, not from a copy of it", () => {
  it("imports the shared list", () => {
    expect(stripped).toMatch(/import \{[^}]*RENEWAL_STAGES[^}]*\} from "@shared\/renewalStage"/);
    expect(stripped).toContain("RENEWAL_STAGES.map(");
  });

  it("declares no literal column ids of its own", () => {
    // The fingerprint of both historic bugs: an array of `{ id: "…" }` objects
    // enumerating the stages next to the enum that already enumerates them.
    const literals = stripped.match(/\{\s*id:\s*"[a-z_]+"/g) ?? [];
    expect(
      literals,
      literals.length
        ? `\n\nRenewals.tsx enumerates column ids again:\n  ${literals.join("\n  ")}\n\n` +
            `Use RENEWAL_STAGES from @shared/renewalStage — a literal list beside\n` +
            `the enum is how "secure" and the early/30/60/90 ordering both shipped.\n`
        : undefined,
    ).toEqual([]);
  });

  it("gives every stage a tone", () => {
    // TONE is keyed Record<RenewalStage, …>, so tsc catches a missing key —
    // but tsc cannot see a key someone deleted along with a cast, and the
    // board renders `undefined` as an unstyled pill rather than failing.
    RENEWAL_STAGES.forEach((stage) => {
      expect(stripped, `TONE has no entry for ${stage}`).toMatch(
        new RegExp(`\\b${stage}:\\s*"(success|info|warning|danger|muted)"`),
      );
    });
  });
});

describe("the safety net survives", () => {
  it("an unrecognised stage still lands in _unbucketed, not in the bin", () => {
    // If the enum gains a value the board has not been taught about, those
    // records must stay visible. renewalStageFor deliberately passes an
    // unknown stored value straight through for the same reason.
    expect(stripped).toContain("buckets._unbucketed");
    expect(stripped).toContain("Unrecognised stage");
  });
});
