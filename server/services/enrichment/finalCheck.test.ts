/**
 * Final-check + generic-inbox guarantees:
 *
 *  - generic-inbox detection is ONE shared definition and covers the
 *    owner-named prefixes (incl. admissions@ for the nonprofit ICP);
 *  - it is NEVER conflated with Reoon's accept_all verdict;
 *  - a Reoon-valid GENERIC address does not stop the upgrade ladder;
 *  - the email mirror fires ONLY for verified person-specific addresses
 *    over an empty-or-generic queue copy;
 *  - the check gates on need (missing/generic/unverified/stale) so
 *    enrollment never re-spends on a fresh verified person;
 *  - the enrollment phase is wired to it, tick-bounded, before suppression.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isGenericInboxEmail } from "../../../shared/genericEmail";
import { emailToMirror, personNeedsFinalCheck } from "./finalCheck";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("isGenericInboxEmail — one shared definition", () => {
  it("flags the generic organizational prefixes", () => {
    for (const e of ["info@acme.org", "Admissions@school.edu", "contact@x.com", "hello@x.com", "support@x.com", "office@x.com", "admin@x.com", "sales@x.com", "marketing@x.com", "enrollment@x.edu", "reception@x.com"]) {
      expect(isGenericInboxEmail(e), `${e} should be generic`).toBe(true);
    }
  });
  it("never flags person addresses — including ones CONTAINING the words", () => {
    for (const e of ["jane.doe@acme.org", "sally@x.com", "information.smith@x.com" /* prefix must be the WHOLE local part */]) {
      expect(isGenericInboxEmail(e), `${e} should NOT be generic`).toBe(false);
    }
    expect(isGenericInboxEmail(null)).toBe(false);
    expect(isGenericInboxEmail("")).toBe(false);
  });
  it("the scraper imports the shared definition instead of its own copy", () => {
    const src = read("server/services/scraper/index.ts");
    expect(src).toContain('from "@shared/genericEmail"');
    expect(src).not.toMatch(/const ROLE_ACCOUNT = \/\^/);
  });
});

describe("comprehensivePass — generic primaries don't block the upgrade", () => {
  it("emailIsProven requires valid AND non-generic; the demoted generic is preserved", () => {
    const src = read("server/services/enrichment/comprehensivePass.ts");
    expect(src).toContain('p.emailStatus === "valid" && !primaryIsGeneric');
    expect(src).toContain("patch.catchAllEmail = p.email.slice(0, 320)");
    // The catch-all write keys on a real replacement by a person address.
    expect(src).toMatch(/emailDecision\?\.action === "replaced" && primaryIsGeneric/);
  });
});

describe("personNeedsFinalCheck", () => {
  const fresh = new Date();
  it("missing / generic / unverified / stale each trigger", () => {
    expect(personNeedsFinalCheck({ email: null, emailStatus: null, lastEnrichedAt: fresh })).toBe(true);
    expect(personNeedsFinalCheck({ email: "info@acme.org", emailStatus: "valid", lastEnrichedAt: fresh })).toBe(true);
    expect(personNeedsFinalCheck({ email: "jane@acme.org", emailStatus: "risky", lastEnrichedAt: fresh })).toBe(true);
    expect(personNeedsFinalCheck({ email: "jane@acme.org", emailStatus: "valid", lastEnrichedAt: new Date(Date.now() - 31 * 86_400_000) })).toBe(true);
  });
  it("a fresh verified person-specific email does NOT re-spend", () => {
    expect(personNeedsFinalCheck({ email: "jane@acme.org", emailStatus: "valid", lastEnrichedAt: fresh })).toBe(false);
  });
});

describe("emailToMirror — the only queue mutation the check may make", () => {
  const verified = { email: "jane@acme.org", emailStatus: "valid" };
  it("mirrors over empty or generic queue copies", () => {
    expect(emailToMirror(verified, null)).toBe("jane@acme.org");
    expect(emailToMirror(verified, "info@acme.org")).toBe("jane@acme.org");
  });
  it("never overwrites an existing person-specific queue email", () => {
    expect(emailToMirror(verified, "j.doe@acme.org")).toBeNull();
  });
  it("never mirrors unverified, generic, or identical addresses", () => {
    expect(emailToMirror({ email: "jane@acme.org", emailStatus: "accept_all" }, null)).toBeNull();
    expect(emailToMirror({ email: "info@acme.org", emailStatus: "valid" }, null)).toBeNull();
    expect(emailToMirror(verified, "JANE@acme.org")).toBeNull();
  });
});

describe("enrollment wiring (structural)", () => {
  it("the enroll phase runs the final check, tick-bounded, BEFORE suppression", () => {
    const src = read("server/areEngine.ts");
    const check = src.indexOf("runFinalCheckForQueueRow");
    expect(check).toBeGreaterThan(-1);
    expect(src).toContain("FINAL_CHECKS_PER_TICK = 5");
    const suppression = src.indexOf("Suppressed? Skip rather than enroll", check);
    expect(suppression).toBeGreaterThan(check); // check precedes the suppression gate
  });
});
