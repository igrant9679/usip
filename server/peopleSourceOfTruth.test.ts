/**
 * People and Companies are the sitewide person/company records — one location
 * each. Owner directive 2026-08-17: the scrapers, the ARE Hub, enrichment,
 * everything contributes to and reads from these two; no duplicate pages.
 *
 * Layer 1 (this): the standalone Contacts PAGE is retired, every list-of-people
 * surface reads People, and enrichment on a People row mirrors down to its
 * linked contact so the two stores cannot diverge again. Layer 2 (retiring the
 * contacts TABLE — 14 foreign keys) is a separate, deliberate migration.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const R = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("the Contacts page is retired, and its links still land somewhere", () => {
  const app = R("client/src/App.tsx");
  it("both /contacts routes render the redirect, not the old pages", () => {
    expect(app).toContain('<Route path="/contacts"><AuthGate><ContactRedirect /></AuthGate></Route>');
    expect(app).toContain('<Route path="/contacts/:id"><AuthGate><ContactRedirect /></AuthGate></Route>');
    expect(app).not.toMatch(/import Contacts from|<Contacts \/>|<ContactDetail \/>/);
  });
  it("/contacts/:id resolves to the linked PERSON, never a dead end", () => {
    const r = R("client/src/pages/usip/ContactRedirect.tsx");
    expect(r).toContain("setLocation(`/prospects/${c.personProspectId}`");
    // No linked person → People with the name searched, not a 404.
    expect(r).toContain("/v2/people?q=");
  });
  it("the legacy nav lists People and Companies as the records", () => {
    const shell = R("client/src/components/usip/Shell.tsx");
    expect(shell).toContain('{ href: "/v2/people", label: "People", icon: Users }');
    expect(shell).toContain('{ href: "/v2/companies", label: "Companies", icon: Building2 }');
    expect(shell).not.toContain('{ href: "/contacts", label: "Contacts"');
  });
  it("no page links to the Contacts LIST any more (deep links to :id are redirected)", () => {
    for (const p of ["client/src/pages/usip/Calls.tsx", "client/src/pages/usip/DataEnrichment.tsx", "client/src/pages/usip/ImportContacts.tsx", "client/src/pages/usip/DataHealth.tsx"]) {
      expect(R(p), p).not.toMatch(/["'`]\/contacts["'`?]/);
    }
  });
});

describe("Data Health describes People", () => {
  const src = R("server/routers/dataHealth.ts");
  // getMetrics ends where mergeContacts begins; mergeContacts legitimately
  // reads contacts (it merges contact rows) and must not be in this slice.
  const fn = src.slice(src.indexOf("getMetrics: workspaceProcedure"), src.indexOf("mergeContacts: repProcedure"));
  it("counts prospects, not contacts", () => {
    expect(fn).toContain(".from(prospects)");
    expect(fn).not.toContain(".from(contacts)");
    expect(fn).not.toMatch(/FROM \$\{contacts\}/);
  });
  it("uses the verification vocabulary the rows actually hold", () => {
    // prospects.emailStatus carries Reoon's verdicts (checked against prod:
    // valid / accept_all / risky / unknown populated; verified / unverified /
    // unavailable EMPTY in both workspaces).
    for (const v of ["'valid'", "'accept_all'", "'risky'", "'invalid'"]) expect(fn).toContain(`= ${v}`);
  });
  it("Fix-now links land on People with a real filter", () => {
    const page = R("client/src/pages/usip/DataHealth.tsx");
    expect(page).toContain('fixHref="/v2/people?missingEmail=1"');
    expect(page).toContain('fixHref="/v2/people?emailStatus=invalid"');
    expect(page).toContain('label="Total People"');
  });
});

describe("the People email-status filter matches what is stored", () => {
  const page = R("client/src/pages/usip/People.tsx");
  it("offers Reoon's verdicts, not the stale schema-comment wording", () => {
    for (const v of ['"valid"', '"accept_all"', '"risky"', '"invalid"', '"unknown"']) expect(page).toContain(`{ v: ${v}`);
    expect(page).not.toContain('{ v: "unverified"');
    expect(page).not.toContain('{ v: "unavailable"');
  });
  it("is seedable from the URL, so Data Health can deep-link into it", () => {
    expect(page).toContain('urlParams?.get("emailStatus")');
    expect(page).toContain('urlParams?.get("missingEmail") === "1"');
    expect(page).toContain("hasEmail: missingEmail ? false : (hasEmail || undefined)");
  });
});

describe("enrichment on People mirrors down to linked contacts, fill-only", () => {
  const src = R("server/services/personLink.ts");
  const fn = src.slice(src.indexOf("async function mirrorPersonFieldsToContacts"), src.indexOf("export interface LinkSummary"));
  it("is called from the ONE People write seam", () => {
    const merge = src.slice(src.indexOf("export async function mergeIntoPerson"), src.indexOf("async function mirrorPersonFieldsToContacts"));
    expect(merge).toContain("void mirrorPersonFieldsToContacts(workspaceId, personId, merged.fields)");
  });
  it("targets contacts linked by personProspectId", () => {
    expect(fn).toContain("eq(contacts.personProspectId, personId)");
  });
  it("only fills EMPTY contact fields — a curated value is never overwritten", () => {
    expect(fn).toMatch(/if \(current === null \|\| current === undefined \|\| String\(current\)\.trim\(\) === ""\)/);
  });
  it("is best-effort — never fails the People write", () => {
    expect(fn).toMatch(/catch \(e\) \{[\s\S]*console\.error/);
  });
  it("the catch-up backfill uses the same fill-only rule and defaults to dry-run", () => {
    const dh = R("server/routers/dataHealth.ts");
    const proc = dh.slice(dh.indexOf("syncContactsFromPeople:"), dh.indexOf("importMappingAudit:"));
    expect(proc).toContain("dryRun: z.boolean().default(true)");
    expect(proc).toContain("if (empty(cur) && !empty(from))");
    expect(proc).toContain("adminWsProcedure");
  });
});
