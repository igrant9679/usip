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
import { clampSweepCap } from "@shared/enrichmentLimits";

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

describe("promoteProspectRow", () => {
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
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    const out = await promoteProspectRow(1, 7);
    expect(out).toEqual({ promoted: false, reason: "not_verified" });
    // The refusal must be silent in the database, not "created then rejected".
    expect(db.inserted).toEqual([]);
    expect(db.updated).toEqual([]);
  });

  it("refuses a row with no email at all", async () => {
    h.db = fakeDb({ ...verified, email: null, emailStatus: null });
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    expect(await promoteProspectRow(1, 7)).toEqual({ promoted: false, reason: "no_email" });
  });

  it("is IDEMPOTENT — an already-linked prospect creates nothing", async () => {
    /**
     * The sweeper can reach the same row on a later pass. A promotion that ran
     * twice would put the same person in the CRM twice and then into a
     * campaign twice, which is the double-send this repo already fixed once at
     * the enrollment layer.
     */
    // The linked contact must still EXIST for the link to be trusted — see the
    // stale-link case below.
    const db = fakeDb({ ...verified, linkedContactId: 42, accountId: 11 }, { existingContactId: 42 });
    h.db = db;
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    const out = await promoteProspectRow(1, 7);
    expect(out).toEqual({ promoted: true, contactId: 42, accountId: 11, alreadyLinked: true });
    expect(db.inserted).toEqual([]);
    expect(db.updated).toEqual([]);
  });

  it("recovers from a STALE link when the contact was deleted", async () => {
    /**
     * Contacts can be purged out from under a prospect, leaving a
     * linkedContactId pointing at nothing. Trusting it makes promotion a
     * silent, permanent no-op for that row.
     *
     * This behaviour came from `prospects.promoteToContact`, which had it while
     * this function did not — the duplication that consolidating removed. Kept
     * because it is the half the other implementation got right.
     */
    const db = fakeDb({ ...verified, linkedContactId: 42, accountId: 11 }); // no existing contact
    h.db = db;
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    const out = await promoteProspectRow(1, 7);
    expect(out.promoted).toBe(true);
    expect((out as { alreadyLinked: boolean }).alreadyLinked, "must re-create, not reuse").toBe(false);
    // The stale link is cleared before the row is promoted again.
    expect(db.updated.some((u) => u.set.linkedContactId === null), "stale link not cleared").toBe(true);
  });

  it("promotes an UNVERIFIED row when the caller opts out of the gate", async () => {
    /**
     * The manual People-page path: a human looking at one prospect has made a
     * judgement the unattended sweeper cannot. The default stays verified-only,
     * so this can never happen by omission.
     */
    h.db = fakeDb({ ...verified, emailStatus: "accept_all" });
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    const out = await promoteProspectRow(1, 7, { requireVerified: false });
    expect(out.promoted).toBe(true);
  });

  it("returns not_found for another workspace's prospect", async () => {
    h.db = fakeDb(null);
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    expect(await promoteProspectRow(1, 7)).toEqual({ promoted: false, reason: "not_found" });
  });

  it("fails closed when the database is unavailable", async () => {
    h.db = null;
    const { promoteProspectRow } = await import("./services/prospectPromotion");
    expect(await promoteProspectRow(1, 7)).toEqual({ promoted: false, reason: "db_unavailable" });
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

/**
 * ...and the pipeline it sits in: import → clean → promote → enrol.
 *
 * Each seam here was a place the chain used to break. Import wrote `contacts`,
 * which the sweeper never reads; the sweeper found addresses nothing acted on;
 * segment rules only ever saw `contacts`. The parts existed and did not touch.
 */
describe("import → clean → promote → enrol is actually connected", () => {
  const imports = strip(read("server/routers/imports.ts"));
  const sweeper = strip(read("server/services/enrichmentSweeper.ts"));
  const ui = read("client/src/pages/usip/ImportContacts.tsx");

  it("import can target the prospects backlog", () => {
    expect(imports).toMatch(/const DESTINATION = z\.enum\(\["contacts", "prospects"\]\)\.default\("contacts"\)/);
    expect(imports).toMatch(/\.insert\(prospects\)/);
  });

  it("defaults to contacts, so an existing importer is unchanged", () => {
    // A destination that defaulted to `prospects` would silently reroute every
    // caller's import into a backlog they never asked for.
    expect(imports).toMatch(/z\.enum\(\["contacts", "prospects"\]\)\.default\("contacts"\)/);
  });

  it("the PREVIEW dedupes against the same table the import writes", () => {
    /**
     * Both procedures call one helper. This file's own header records what
     * happened last time they diverged: the preview reported rows as
     * duplicates that the import then created.
     */
    expect((imports.match(/existingRowsForDestination\(db, wsId, input\.destination\)/g) ?? []).length).toBe(2);
    // Both procedures ACCEPT it too — one that didn't would silently dedupe
    // against contacts while the other wrote prospects. Counted rather than
    // matched within a window: the two inputs are ~200 lines apart, and a
    // proximity regex would have been asserting layout, not wiring.
    expect((imports.match(/^\s+destination: DESTINATION,$/gm) ?? []).length).toBe(2);
  });

  it("imported prospects are left LOOKING UNWORKED, or the sweeper skips them", () => {
    /**
     * `enrichmentData IS NULL` is the sweeper's "not attempted" marker. Writing
     * anything into it at import time would make every row look already-worked
     * and none of them would ever be cleaned — the whole point of the import.
     */
    const builder = imports.slice(imports.indexOf("const buildProspectValues"));
    expect(builder.length).toBeGreaterThan(200);
    expect(builder.slice(0, 900)).not.toMatch(/enrichmentData/);
  });

  it("the audit row records what it created, contact OR prospect", () => {
    /**
     * BOTH insert paths — the chunked batch and the per-row fallback that
     * takes over when a chunk fails. Asserted as a count: a file-level match
     * is satisfied by either one alone, so deleting the pair from the chunk
     * path left this green while every batched import mislabelled its rows.
     */
    expect((imports.match(/contactId: toProspects \? null : /g) ?? []).length, "chunk + per-row fallback").toBe(2);
    expect((imports.match(/prospectId: toProspects \? /g) ?? []).length).toBe(2);
  });

  it("the sweeper promotes a prospect once its address verifies", () => {
    // The seam that did not exist: a found address that nothing acted on.
    expect(sweeper).toMatch(/import \{ promoteProspectRow \} from "\.\/prospectPromotion"/);
    expect(sweeper).toMatch(/await promoteProspectRow\(workspaceId, p\.id\)/);
  });

  it("promotion only runs when an address was actually found", () => {
    const loop = sweeper.slice(sweeper.indexOf("for (const p of rows) {"));
    const found = loop.indexOf("if (r.email) {");
    const promote = loop.indexOf("promoteProspectRow(");
    expect(found, "the found-email branch is gone").toBeGreaterThan(0);
    expect(promote).toBeGreaterThan(found);
  });

  it("a failed promotion cannot abort a sweep that already spent credits", () => {
    /**
     * Matched on the promotion's OWN handler, by its message.
     *
     * The first version sliced 400 characters from the promotion call and
     * looked for `catch (e)` — which found the sweep loop's outer catch a
     * little further down, so deleting the promotion's handler entirely left
     * it green. A window wide enough to contain a sibling of the thing you are
     * looking for is not a check; this is the second time that exact shape has
     * slipped a mutation through in this session.
     */
    const loop = sweeper.slice(sweeper.indexOf("for (const p of rows) {"));
    expect(loop).toMatch(/catch \(e\) \{[\s\S]{0,120}?promotion failed for prospect/);
  });

  it("counts only NEW promotions, not re-promotions of an already-linked row", () => {
    // promoteProspectRow is idempotent and reports alreadyLinked; counting
    // those would inflate the run summary on every subsequent sweep.
    expect(sweeper).toMatch(/if \(outcome\.promoted && !outcome\.alreadyLinked\) result\.promoted\+\+/);
  });

  it("the destination is reachable from the UI and sent on BOTH calls", () => {
    // A control the page never sends is the dead wiring this repo keeps finding.
    expect(ui).toMatch(/setDestination/);
    expect((ui.match(/^\s+destination,$/gm) ?? []).length, "validate + commit").toBe(2);
  });
});

/**
 * The sweep ceiling, and the control for it.
 *
 * The bound used to be the literal `500` written THREE times — the zod input,
 * the domain pass's row limit, and the run cap. Three copies of a limit is how
 * a setting accepts 1000 while the engine quietly clamps to 500: a control
 * that reports success and does nothing, which is this repo's signature
 * defect. Raised to 1000 at the owner's request, from one definition.
 *
 * And there was no UI at all: setSweepSettings accepted `dailyCap` and the
 * Autonomy Control Center only ever sent `mode`, so the cap could not be
 * changed from anywhere in the product.
 */
describe("the sweep daily cap", () => {
  const sweeper = strip(read("server/services/enrichmentSweeper.ts"));
  const router = strip(read("server/routers/prospects.ts"));
  const limits = read("shared/enrichmentLimits.ts");
  const settingsUi = read("client/src/pages/usip/Settings.tsx");

  it("has ONE definition, and it is 1000", () => {
    expect(limits).toMatch(/export const SWEEP_DAILY_CAP_MAX = 1000;/);
    expect(limits).toMatch(/export const SWEEP_DAILY_CAP_MIN = 1;/);
  });

  it("no literal 500 clamp survives anywhere on this path", () => {
    /**
     * The actual failure mode: the engine clamping lower than the setting
     * allows. A `Math.min(500, …)` left behind would cap every workspace at
     * 500 while the UI cheerfully accepted 1000.
     */
    expect(sweeper).not.toMatch(/Math\.min\(\s*500\s*,/);
    expect(router).not.toMatch(/dailyCap: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/);
  });

  it("the engine clamps through the shared helper", () => {
    expect(sweeper).toMatch(/import \{ clampSweepCap, SWEEP_DAILY_CAP_DEFAULT \} from "@shared\/enrichmentLimits"/);
    // Both clamp sites: the run cap and the domain pass's row limit.
    expect((sweeper.match(/clampSweepCap\(/g) ?? []).length, "run cap + domain pass").toBe(2);
  });

  it("the setter's bound comes from the same constants", () => {
    expect(router).toMatch(/dailyCap: z\.number\(\)\.int\(\)\.min\(SWEEP_DAILY_CAP_MIN\)\.max\(SWEEP_DAILY_CAP_MAX\)/);
  });

  it("clampSweepCap actually clamps, in both directions", () => {
    // Behavioural — the one part of this that can be tested by calling it.
    expect(clampSweepCap(5000)).toBe(1000);
    expect(clampSweepCap(0)).toBe(1);
    expect(clampSweepCap(-10)).toBe(1);
    expect(clampSweepCap(250)).toBe(250);
    // A caller passing nothing usable gets the default, not NaN or zero.
    expect(clampSweepCap(undefined)).toBe(50);
    expect(clampSweepCap(Number.NaN)).toBe(50);
    // Fractions cannot become a fractional LIMIT clause.
    expect(clampSweepCap(10.9)).toBe(10);
  });

  it("is adjustable from Settings, and the control SENDS the cap", () => {
    /**
     * A control that renders and never sends is the dead wiring this repo
     * keeps finding — and it is exactly what the Autonomy Control Center did
     * with this setting for months.
     */
    expect(settingsUi).toMatch(/id: "enrichment", label: "Data enrichment"/);
    expect(settingsUi).toMatch(/tab === "enrichment" && <EnrichmentTab \/>/);
    expect(settingsUi).toMatch(/setSweepSettings\.useMutation/);
    expect(settingsUi).toMatch(/saveMut\.mutate\(\{ mode: mode as any, dailyCap: Math\.floor\(capNum\) \}\)/);
  });

  it("the Settings input bounds come from the shared constants too", () => {
    // Retyping 1000 here is how the form starts accepting what the server rejects.
    expect(settingsUi).toMatch(/from "@shared\/enrichmentLimits"/);
    expect(settingsUi).toMatch(/min=\{SWEEP_DAILY_CAP_MIN\}/);
    expect(settingsUi).toMatch(/max=\{SWEEP_DAILY_CAP_MAX\}/);
  });
});
