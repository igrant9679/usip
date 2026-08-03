/**
 * Promoting a cleaned prospect into the CRM — the missing link in
 * import → clean → enrol.
 *
 * CSV import writes `contacts`; the enrichment sweeper only reads `prospects`
 * and `prospect_queue`; segment→sequence rules only read `contacts`. So an
 * imported list was never cleaned, and a cleaned prospect never became
 * something a campaign could enrol. This is the piece that closes it.
 *
 * PROMOTE ON A VERIFIED EMAIL ONLY (owner's decision, 2026-08-02) — which also
 * settles "may an unverified row reach a campaign?": it cannot, because only
 * promoted rows become contacts and only contacts are enrolled. That makes the
 * status predicate the load-bearing part of this file.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const strip = (s: string) =>
  s.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Injectable db, so the promotion can be exercised without a database. */
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("./db", () => ({ getDb: async () => h.db }));

import { isPromotableEmailStatus, PROMOTABLE_EMAIL_STATUSES } from "./services/prospectPromotion";

describe("isPromotableEmailStatus — the whole product rule in one predicate", () => {
  it("promotes a verified address", () => {
    expect(isPromotableEmailStatus("valid")).toBe(true);
  });

  it("REFUSES accept_all, risky, invalid and unknown", () => {
    /**
     * `accept_all` is a domain that accepts everything — it says nothing about
     * whether the person exists. `risky` covers role accounts, disposables and
     * full inboxes. This list feeds campaigns that send automatically, so
     * mailing either is how a warmed domain gets burned.
     *
     * Every Reoon status is named explicitly rather than testing "not valid",
     * so a NEW status added upstream fails this test instead of silently
     * inheriting whichever branch it happens to fall into.
     */
    for (const s of ["accept_all", "risky", "invalid", "unknown"]) {
      expect(isPromotableEmailStatus(s), s).toBe(false);
    }
  });

  it("refuses the absence of a verdict", () => {
    // An unverified row has emailStatus NULL — never verified is not verified.
    expect(isPromotableEmailStatus(null)).toBe(false);
    expect(isPromotableEmailStatus(undefined)).toBe(false);
    expect(isPromotableEmailStatus("")).toBe(false);
  });

  it("is a single definition, so widening it is one decision", () => {
    expect([...PROMOTABLE_EMAIL_STATUSES]).toEqual(["valid"]);
  });

  it("covers the full Reoon status union — no status is unclassified", () => {
    /**
     * Read from reoon.ts rather than hardcoded here: a status added there and
     * not considered here would otherwise be refused by accident rather than
     * by decision, and nobody would know it existed.
     */
    const reoon = read("server/services/reoon.ts");
    const block = reoon.slice(reoon.indexOf("export type VerificationStatus"));
    const statuses = [...block.slice(0, 200).matchAll(/\|\s*"(\w+)"/g)].map((m) => m[1]);
    expect(statuses.length, "could not parse the VerificationStatus union").toBeGreaterThanOrEqual(5);
    for (const s of statuses) {
      expect(typeof isPromotableEmailStatus(s), `${s} unhandled`).toBe("boolean");
    }
    // Exactly one of them may promote.
    expect(statuses.filter(isPromotableEmailStatus)).toEqual(["valid"]);
  });
});

/* ─── Behavioural: the promotion itself ─────────────────────────────────── */

interface FakeRow { [k: string]: unknown }

/**
 * Minimal chainable drizzle fake. Records inserts and updates so the test can
 * assert what the promotion DID, not merely that it returned something.
 */
function fakeDb(prospectRow: FakeRow | null, opts: { existingContactId?: number; existingAccountId?: number } = {}) {
  const inserted: Array<{ table: string; values: FakeRow }> = [];
  const updated: Array<{ table: string; set: FakeRow }> = [];
  let selectTarget = "";

  const chain: any = {
    select: () => chain,
    from: (t: any) => {
      selectTarget = String(t?.[Symbol.for("drizzle:BaseName")] ?? t?._?.name ?? "");
      return chain;
    },
    where: () => chain,
    limit: async () => {
      if (selectTarget.includes("prospect")) return prospectRow ? [prospectRow] : [];
      if (selectTarget.includes("contact")) return opts.existingContactId ? [{ id: opts.existingContactId }] : [];
      if (selectTarget.includes("account")) return opts.existingAccountId ? [{ id: opts.existingAccountId }] : [];
      return [];
    },
    insert: (t: any) => ({
      values: (v: FakeRow) => {
        inserted.push({ table: String(t?.[Symbol.for("drizzle:BaseName")] ?? ""), values: v });
        return { $returningId: async () => [{ id: 900 + inserted.length }] };
      },
    }),
    update: (t: any) => ({
      set: (v: FakeRow) => ({
        where: async () => {
          updated.push({ table: String(t?.[Symbol.for("drizzle:BaseName")] ?? ""), set: v });
        },
      }),
    }),
  };
  return Object.assign(chain, { inserted, updated });
}

describe("promoteVerifiedProspect", () => {
  beforeEach(() => {
    h.db = null;
  });

  const verified = {
    id: 7, workspaceId: 1, email: "jane@acme.com", emailStatus: "valid",
    firstName: "Jane", lastName: "Doe", company: "Acme", companyDomain: "acme.com",
    linkedContactId: null, accountId: null, title: null, phone: null,
    linkedinUrl: null, city: null, seniority: null, industry: null,
  };

  it("refuses a row whose email is not verified — and writes NOTHING", async () => {
    const db = fakeDb({ ...verified, emailStatus: "accept_all" });
    h.db = db;
    const { promoteVerifiedProspect } = await import("./services/prospectPromotion");
    const out = await promoteVerifiedProspect(1, 7);
    expect(out).toEqual({ promoted: false, reason: "not_verified" });
    // The refusal must be silent in the database, not "created then rejected".
    expect(db.inserted).toEqual([]);
    expect(db.updated).toEqual([]);
  });

  it("refuses a row with no email at all", async () => {
    h.db = fakeDb({ ...verified, email: null, emailStatus: null });
    const { promoteVerifiedProspect } = await import("./services/prospectPromotion");
    expect(await promoteVerifiedProspect(1, 7)).toEqual({ promoted: false, reason: "no_email" });
  });

  it("is IDEMPOTENT — an already-linked prospect creates nothing", async () => {
    /**
     * The sweeper can reach the same row on a later pass. A promotion that ran
     * twice would put the same person in the CRM twice and then into a
     * campaign twice, which is the double-send this repo already fixed once at
     * the enrollment layer.
     */
    const db = fakeDb({ ...verified, linkedContactId: 42, accountId: 11 });
    h.db = db;
    const { promoteVerifiedProspect } = await import("./services/prospectPromotion");
    const out = await promoteVerifiedProspect(1, 7);
    expect(out).toEqual({ promoted: true, contactId: 42, accountId: 11, alreadyLinked: true });
    expect(db.inserted).toEqual([]);
    expect(db.updated).toEqual([]);
  });

  it("returns not_found for another workspace's prospect", async () => {
    h.db = fakeDb(null);
    const { promoteVerifiedProspect } = await import("./services/prospectPromotion");
    expect(await promoteVerifiedProspect(1, 7)).toEqual({ promoted: false, reason: "not_found" });
  });

  it("fails closed when the database is unavailable", async () => {
    h.db = null;
    const { promoteVerifiedProspect } = await import("./services/prospectPromotion");
    expect(await promoteVerifiedProspect(1, 7)).toEqual({ promoted: false, reason: "db_unavailable" });
  });
});

/* ─── Structural: the wiring that behaviour cannot see ──────────────────── */

describe("the promotion is wired the way it claims", () => {
  const src = strip(read("server/services/prospectPromotion.ts"));
  const matching = strip(read("server/services/crmMatching.ts"));
  const execution = strip(read("server/routers/are/execution.ts"));

  it("writes the link back, so the next sweep sees it as promoted", () => {
    // Without this the row promotes again on every pass.
    expect(src).toMatch(/\.update\(prospects\)[\s\S]{0,160}?linkedContactId: contactId/);
  });

  it("matches an existing contact before creating one", () => {
    const create = src.indexOf(".insert(contacts)");
    const match = src.indexOf("findContactByEmail(");
    expect(match).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(0);
    expect(match).toBeLessThan(create);
  });

  it("SHARES its account matching with the ARE promotion", () => {
    /**
     * Two copies of "is this the same company?" is how one of them silently
     * starts creating duplicate accounts — the drift class this repo has swept
     * out of slugify, canonicalText and mergeKeys. Both promotions call the
     * one definition.
     */
    expect(src).toMatch(/from "\.\/crmMatching"/);
    expect(execution).toMatch(/findOrCreateAccount\(db, workspaceId, \{/);
    // And the old inline copy must be gone, not merely bypassed.
    expect(execution).not.toMatch(/\.insert\(accounts\)\.values\(/);
  });

  it("matches an account by DOMAIN before name", () => {
    // Two "Acme" rows are usually different companies; one domain is one
    // company. Reversing this merges unrelated businesses.
    const byDomain = matching.indexOf("accounts.domain");
    const byName = matching.indexOf("accounts.name");
    expect(byDomain).toBeGreaterThan(0);
    expect(byName).toBeGreaterThan(0);
    expect(byDomain).toBeLessThan(byName);
  });

  it("compares addresses in SQL, not by loading the workspace's contacts", () => {
    /**
     * This runs once per promoted prospect and a sweep promotes hundreds a day
     * against a CRM that may hold tens of thousands of rows. My first version
     * selected every contact and filtered in JS.
     */
    const fn = matching.slice(matching.indexOf("export async function findContactByEmail"));
    expect(fn.length, "findContactByEmail not found").toBeGreaterThan(200);
    // The address comparison happens in the WHERE clause...
    expect(fn).toMatch(/sql`lower\(\$\{contacts\.email\}\) = \$\{needle\}`/);
    // ...and the query is bounded, so it can never walk the table.
    expect(fn).toMatch(/\.limit\(1\)/);
    /**
     * Asserted as those two positive properties rather than as
     * `not.toMatch(/rows.find(/)`, which was the first version: that catches
     * exactly one spelling of JS filtering and any other (`.filter(…)[0]`,
     * a for-loop) would walk straight past it. A negative assertion about an
     * identifier is not a check on where the work happens.
     */
  });
});
