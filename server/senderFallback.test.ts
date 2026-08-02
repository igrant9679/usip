/**
 * A disabled mailbox must never send — including down the fallback path.
 *
 * THE SEAM: what happens to a live sequence when the mailbox it was configured
 * to send from is disconnected mid-flight. The answer turned out to be "it
 * keeps sending, from something else, silently".
 *
 * `pickAccountForSequenceDraft` deliberately refuses a campaign's configured
 * account when that account is disabled — its own comment says so: "a disabled
 * account shouldn't dispatch even when it's the campaign's only sender". It
 * returns null, and `deliverEmailDraft` then walked two more fallbacks:
 *
 *   1. the acting user's personal unipile mailbox   ← no `enabled` filter
 *   2. `the first sendingAccount in the workspace`  ← no `enabled` filter,
 *                                                     and no ORDER BY either
 *
 * So the refusal was undone two steps later. The mail still went out, from a
 * mailbox nobody chose, which could itself be disabled. Disabling is the
 * control an admin reaches for after a blacklisting, a bounce spike, or a rep
 * leaving; it has to mean the same thing everywhere or it means nothing.
 *
 * Asserted over the source because the selection is DB-backed — the same
 * verdict approvalQueueRanking reached about ranking that lives in SQL. What
 * is pinned here is the FILTER on each query, which is the thing that was
 * missing, not a re-implementation of the choice.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
/** Line-leading block comments only — a `/*` inside a string is not a comment. */
const strip = (s: string) =>
  s.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");

const src = strip(readFileSync(join(ROOT, "server/routers/sequences.ts"), "utf8"));

/** The sender-resolution block inside deliverEmailDraft. */
const resolution = (() => {
  const at = src.indexOf("let fromAccount: typeof sendingAccounts.$inferSelect | undefined;");
  expect(at, "the sender-resolution block was not found — every assertion below would be vacuous").toBeGreaterThan(0);
  const end = src.indexOf("const adapter = createEmailAdapter(fromAccount);", at);
  expect(end, "could not bound the resolution block").toBeGreaterThan(at);
  return src.slice(at, end);
})();

describe("the sender-resolution block", () => {
  it("was isolated, not truncated", () => {
    expect(resolution.length).toBeGreaterThan(600);
    // All three tiers must be inside the slice, or the counts below lie.
    expect(resolution).toContain("pickAccountForSequenceDraft");
    expect(resolution).toContain("unipileAccounts.userId");
  });

  it("still has exactly two fallback tiers plus a refusal", () => {
    /**
     * Three `if (!fromAccount)` blocks: the personal mailbox, the
     * workspace-wide pick, and finally the throw when nothing is available.
     * The count is pinned so that adding a fourth tier — a new way to dispatch
     * — fails here and has to be given an `enabled` filter deliberately.
     */
    const tiers = (resolution.match(/if \(!fromAccount\) \{/g) ?? []).length;
    expect(tiers, "a dispatch tier was added or removed").toBe(3);
    // The last one must refuse rather than select.
    const last = resolution.slice(resolution.lastIndexOf("if (!fromAccount) {"));
    expect(last).toMatch(/throw new TRPCError/);
    expect(last).not.toMatch(/await db\s*\n?\s*\.select/);
  });
});

describe("every fallback filters on enabled", () => {
  it("the personal-mailbox fallback does", () => {
    const at = resolution.indexOf("unipileAccounts.userId");
    expect(at).toBeGreaterThan(0);
    const q = resolution.slice(Math.max(0, at - 400), at + 400);
    expect(
      q,
      "\n\nThe personal-mailbox fallback selects without eq(sendingAccounts.enabled, true),\n" +
        "so a mailbox an admin disabled still sends.\n",
    ).toMatch(/eq\(sendingAccounts\.enabled, true\)/);
  });

  it("the workspace-wide fallback does", () => {
    const at = resolution.lastIndexOf("const [fallback] = await db");
    expect(at, "the workspace-wide fallback was not found").toBeGreaterThan(0);
    const q = resolution.slice(at, at + 500);
    expect(
      q,
      "\n\nThe last-resort fallback picks any sending account in the workspace.\n" +
        "Without eq(sendingAccounts.enabled, true) that includes disabled ones —\n" +
        "and this is the tier reached precisely BECAUSE the configured account\n" +
        "was disabled.\n",
    ).toMatch(/eq\(sendingAccounts\.enabled, true\)/);
  });

  it("counts the enabled filter once per fallback, so adding a tier without one fails", () => {
    const filters = (resolution.match(/eq\(sendingAccounts\.enabled, true\)/g) ?? []).length;
    expect(
      filters,
      "\n\nA fallback tier was added without an `enabled` filter, or one was removed.\n" +
        "Every tier that can dispatch must carry it.\n",
    ).toBe(2);
  });
});

describe("the last-resort fallback is deterministic", () => {
  it("orders its pick instead of taking whatever the DB returns first", () => {
    /**
     * `.limit(1)` with no ORDER BY let the storage engine decide which mailbox
     * a campaign sent from — and it may answer differently after an unrelated
     * write. A campaign's sending identity must not be incidental.
     */
    const at = resolution.lastIndexOf("const [fallback] = await db");
    const q = resolution.slice(at, at + 500);
    expect(q).toMatch(/\.orderBy\(asc\(sendingAccounts\.id\)\)/);
    expect(q.indexOf(".orderBy(")).toBeLessThan(q.indexOf(".limit(1)"));
  });

  it("imports asc as a real import, not a free identifier", () => {
    // esbuild bundles an undeclared identifier happily and it throws on the
    // first send. Fourth instance of that trap in this repo.
    expect(src).toMatch(/import \{[^}]*\basc\b[^}]*\} from "drizzle-orm"/);
  });
});

describe("substituting the campaign's sender is reported", () => {
  it("warns when a sequence draft falls back to another mailbox", () => {
    /**
     * The campaign's sender is a deliberate choice — a warmed domain, a
     * particular rep's identity. Substituting it silently is how a campaign
     * sends from the wrong address for weeks before anyone notices.
     */
    expect(resolution).toMatch(/console\.warn\(/);
    expect(resolution).toMatch(/FELL BACK to account/);
  });

  it("the warning is gated on the campaign sender NOT having been used", () => {
    // Otherwise it fires on every send and becomes noise nobody reads, which
    // is the same as not logging it.
    expect(resolution).toMatch(/if \(fromAccount && draft\.sequenceId && !sequenceSenderPicked\)/);
    expect(resolution).toMatch(/sequenceSenderPicked = true;/);
  });
});

describe("the campaign path itself still refuses a disabled account", () => {
  it("pickAccountForSequenceDraft filters the PINNED account on enabled", () => {
    /**
     * The behaviour the fallbacks were quietly undoing. If it ever softens,
     * the fallbacks stop being the interesting half.
     *
     * Bounded to the `senderType === "account"` branch. My first version
     * sliced 2200 characters from the function start, which swallowed the
     * POOL branch too — and that branch has its own `enabled` filter, so
     * deleting the pinned-account one left the assertion green. A window wide
     * enough to contain a second copy of what you are looking for is not a
     * check.
     */
    const at = src.indexOf('camp.senderType === "account" && camp.sendingAccountId');
    expect(at, "the pinned-account branch was not found").toBeGreaterThan(0);
    const end = src.indexOf('camp.senderType === "pool"', at);
    expect(end, "could not bound the pinned-account branch").toBeGreaterThan(at);
    const branch = src.slice(at, end);

    expect(branch.length).toBeGreaterThan(150); // floor: real code, not a fragment
    expect(
      branch,
      "\n\nThe campaign's pinned account is selected without an `enabled` filter,\n" +
        "so a disabled mailbox dispatches directly — no fallback needed.\n",
    ).toMatch(/eq\(sendingAccounts\.enabled, true\)/);
    // And it must still be scoped to the workspace that owns the campaign.
    expect(branch).toMatch(/eq\(sendingAccounts\.workspaceId, workspaceId\)/);
  });
});
