/**
 * Owner, 2026-11-24: "Give me the ability to search for a company (retrieving
 * employees) and search for a name of a person in the Data Enrichment screen
 * and in the People page", and "if the person or company isn't found I should
 * be prompted to allow the app to get it from a prospecting source".
 *
 * Find prospects searched by role; neither it nor People had anywhere to type
 * who you are looking for.
 *
 * Held here (the lookup itself is held in recordLookup.test.ts):
 *   1. the panel is on both screens;
 *   2. it searches the workspace's own records first, on Search, and goes
 *      outside ONLY from the button that asks to;
 *   3. it asks for a list, capped, so a company comes back with its people;
 *   4. saving several is one at a time, and a save that spends is confirmed
 *      with the total first.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LOOKUP_MAX, LOOKUP_TARGET, carriesMiddleName, lookupLimit, lookupSaveCost, orderByMiddleName, personQuery } from "@shared/recordLookup";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const card = read("../client/src/components/usip/NameLookupCard.tsx");
const between = (a: string, b: string) => card.slice(card.indexOf(a), card.indexOf(b));

describe("how many rows a lookup asks for", () => {
  it("six when nothing is asked, what was asked within the cap, and never more", () => {
    expect(lookupLimit(undefined)).toBe(LOOKUP_TARGET);
    expect(lookupLimit(null)).toBe(LOOKUP_TARGET);
    expect(lookupLimit(Number.NaN)).toBe(LOOKUP_TARGET);
    expect(lookupLimit(LOOKUP_MAX)).toBe(25);
    expect(lookupLimit(12.9)).toBe(12);
    expect(lookupLimit(5000)).toBe(LOOKUP_MAX);
    expect(lookupLimit(0)).toBe(1);
    expect(lookupLimit(-3)).toBe(1);
  });

  it("the endpoint refuses a limit above the cap", async () => {
    const { searchRouter } = await import("./routers/search");
    const input = (searchRouter as unknown as { _def: { procedures: Record<string, { _def: { inputs: Array<{ safeParse: (v: unknown) => { success: boolean } }> } }> } })._def.procedures.lookup._def.inputs[0];
    expect(input.safeParse({ q: "acme", kind: "company", limit: LOOKUP_MAX }).success).toBe(true);
    expect(input.safeParse({ q: "acme", kind: "company" }).success).toBe(true);
    expect(input.safeParse({ q: "acme", kind: "company", limit: LOOKUP_MAX + 1 }).success).toBe(false);
    expect(input.safeParse({ q: "acme", kind: "company", limit: 0 }).success).toBe(false);
  }, 120_000);

  it("the endpoint hands the limit to the lookup, which clamps it", () => {
    // A deliberate break showed nothing held this: the schema took a limit the lookup never received.
    const src = read("./routers/search.ts");
    const lookup = src.slice(src.indexOf("  lookup: workspaceProcedure"), src.indexOf("  createFromLookup: workspaceProcedure"));
    expect(lookup).toContain("input.q, input.kind, input.runId ?? null, { limit: input.limit ?? null },");
  });
});

describe("what saving a selection spends", () => {
  it("adds up by source, and free rows cost nothing", () => {
    expect(lookupSaveCost([])).toEqual({ total: 0, text: "" });
    expect(lookupSaveCost([{ saveCost: 0, via: "LinkedIn" }, { saveCost: 0, via: "Apollo.io" }])).toEqual({ total: 0, text: "" });
    expect(lookupSaveCost([{ saveCost: 1, via: "WarmySender" }])).toEqual({ total: 1, text: "1 WarmySender credit" });
    expect(lookupSaveCost([{ saveCost: 1, via: "WarmySender" }, { saveCost: 0, via: "LinkedIn" }, { saveCost: 1, via: "WarmySender" }, { saveCost: 2, via: "LeadOcean" }]))
      .toEqual({ total: 4, text: "2 WarmySender credits, 2 LeadOcean credits" });
  });
});

describe("a person is searched for field by field", () => {
  it("first and last name do the matching, with the company when given; the middle name never does", () => {
    expect(personQuery({ first: " Jane ", last: "Doe", company: "Acme" })).toBe("Jane Doe Acme");
    expect(personQuery({ first: "Jane", last: "Doe" })).toBe("Jane Doe");
    expect(personQuery({ first: "", last: "Doe", company: "" })).toBe("Doe");
    expect(personQuery({ first: "", last: "" })).toBe("");
    const search = between("const search = () => {", "/** Ask the prospect sources.");
    expect(search).toContain('setAsked(kind === "person" ? personQuery({ first, last, company }) : text);');
    expect(search).toContain('setAskedMiddle(kind === "person" ? middle : "");');
    // No record carries a middle name: sent as a search word it would match nobody.
    expect(search).not.toContain("personQuery({ first, middle");
  });

  it("a middle name is recognised as a word, or as an initial between the first and last names", () => {
    expect(carriesMiddleName("Jane Marie Doe", "Marie")).toBe(true);
    expect(carriesMiddleName("Jane M. Doe", "Marie")).toBe(true);
    expect(carriesMiddleName("Jane Marie Doe", "M")).toBe(true);
    expect(carriesMiddleName("Jane Marie Doe", "m.")).toBe(true);
    expect(carriesMiddleName("Jane Doe", "Marie")).toBe(false);
    expect(carriesMiddleName("Jane Anne Doe", "Marie")).toBe(false);
    // The first or last name starting with the letter is not a middle initial.
    expect(carriesMiddleName("Mary Doe", "M")).toBe(false);
    expect(carriesMiddleName("Jane Marie Doe", "")).toBe(false);
  });

  it("it orders the rows and rules nobody out", () => {
    const rows = [{ name: "Jane Doe" }, { name: "Jane Anne Doe" }, { name: "Jane Marie Doe" }, { name: "Jane M Doe" }];
    expect(orderByMiddleName(rows, "Marie").map((r) => r.name)).toEqual(["Jane Marie Doe", "Jane M Doe", "Jane Doe", "Jane Anne Doe"]);
    expect(orderByMiddleName(rows, "Marie")).toHaveLength(rows.length);
    expect(orderByMiddleName(rows, "  ")).toBe(rows);
    expect(card).toContain("orderByMiddleName([...records.data.people, ...records.data.leads], askedMiddle)");
    expect(card).toContain("const people = orderByMiddleName(found?.data?.people ?? [], askedMiddle);");
  });

  it("the panel has the four fields, and says what the middle name does", () => {
    for (const label of ["First name", "Middle name (optional)", "Last name", "Company (optional)"]) {
      expect(card, label).toContain(`aria-label="${label}"`);
    }
    expect(card).toContain("the middle name rules nobody out: a match that carries it is listed first.");
    // Search needs a first or a last name; a middle name or a company alone is not a person.
    expect(card).toContain('disabled={(kind === "person" ? personQuery({ first, last }) : text.trim()).length < 2}');
  });

  it("the search by role keeps every field it had", () => {
    const src = read("../client/src/pages/usip/FindProspects.tsx");
    for (const label of ["Job title", "Seniority", "Department", "Industry", "Company name (optional)", "Location", "Keywords (intent / triggers)"]) {
      expect(src, label).toContain(label);
    }
  });
});

describe("the panel is on both screens", () => {
  it("first on Find prospects, above the search by role", () => {
    const src = read("../client/src/pages/usip/FindProspects.tsx");
    const panel = src.slice(src.indexOf("export function FindProspectsPanel()"));
    expect(panel).toContain("<NameLookupCard />");
    expect(panel.indexOf("<NameLookupCard />")).toBeLessThan(panel.indexOf("{/* ── Search wizard ── */}"));
  });

  it("behind a header button on People", () => {
    const src = read("../client/src/pages/usip/People.tsx");
    expect(src).toContain("onClick={() => setNameLookupOpen(true)} data-people-name-lookup>");
    expect(src).toContain("Look up by name");
    expect(src).toContain('<Dialog open={nameLookupOpen} onOpenChange={setNameLookupOpen}>');
    expect(src).toContain('<NameLookupCard variant="bare" />');
  });
});

describe("own records first, and outside only when asked", () => {
  it("typing searches nothing: the records are read for what Search was pressed on", () => {
    expect(card).toContain("const q = parseRecordSearch(asked);");
    expect(card).toContain("{ q: q?.text ?? \"\" },\n    { enabled: !!q, staleTime: 30_000, retry: false },");
    expect(card).toContain('<form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>');
    // A new search drops what an older one found outside.
    expect(between("const search = () => {", "/** Ask the prospect sources.")).toContain("setOutside(null); setPicked(new Set()); setSaved({});");
  });

  it("the only thing that asks the sources is the button that asks permission to", () => {
    expect(card.match(/lookUp\(/g)).toHaveLength(1);
    expect(card).toContain("onClick={() => void lookUp()} data-name-lookup-go>");
    // No effect in the file at all: nothing can fire a lookup on its own.
    expect(card).not.toContain("useEffect");
    expect(card).not.toContain("search.lookup.useQuery");
  });

  it("the question is put once the records have answered, and says nobody matched", () => {
    const ask = between("{/* 2. Not found (or not enough): ASK before going outside. */}", "{found?.status === \"looking\" ? (");
    expect(ask).toContain('{q && records.data && !records.isFetching && plan && found?.status !== "looking" && !found?.data ? (');
    expect(ask).toContain("in this workspace matches");
    expect(ask).toContain("in your prospect sources?");
    expect(ask).toContain("Looking is free. Nothing is saved until you choose a row, and a row that spends credits says so first.");
    expect(ask).toContain("Look up in prospect sources");
    // With matches on file it is still offered, as a quieter second step.
    expect(ask).toContain('"Want more of the people who work there? Look in your prospect sources."');
  });

  it("asks for a list, and a repeat within a minute is not a second LinkedIn search", () => {
    const look = between("const lookUp = async () => {", "const people = found?.data?.people ?? [];");
    expect(look).toContain("const args = { q: q.text, kind: effective, limit: LOOKUP_MAX };");
    expect(look).toContain("utils.search.lookup.fetch(args, { staleTime: 60_000 })");
    expect(look).toContain("for (let i = 0; r.pending && i < LOOKUP_RESUMES && current(); i++) {");
    expect(look).toContain("all = mergeLookup(all, r);");
  });

  it("an email address or a domain is looked up as its company, and says so", () => {
    expect(card).toContain("const kinds = q ? lookupKindsFor(q) : ([\"person\", \"company\"] as LookupKind[]);");
    expect(card).toContain("const effective: LookupKind = kinds.indexOf(kind) === -1 ? kinds[0] : kind;");
    expect(card).toContain("No source finds a person from an email address or a domain");
  });

  it("what was found belongs to the search and the kind it was found for", () => {
    expect(card).toContain("const found = outside && q && outside.q === q.text && outside.kind === effective ? outside : null;");
  });
});

describe("saving what was found", () => {
  it("a row already here opens, and cannot be ticked", () => {
    expect(card).toContain("const hrefOf = (p: { ref: string; already: { href: string } | null }) => saved[p.ref] ?? p.already?.href ?? null;");
    expect(card).toContain("const fresh = people.filter((p) => !hrefOf(p));");
    expect(card).toContain("checked={picked.has(p.ref)} disabled={!!href || saving}");
    expect(card).toContain('>In People · open</Button>');
  });

  it("several are saved one after another, and one refusal does not lose the rest", () => {
    const save = between("const saveRows = async", "/** A save that spends anything is confirmed first");
    expect(save).toContain("if (saving || rows.length === 0) return;");
    expect(save).toContain("for (const row of rows) {");
    expect(save).toContain("const r = await createFromLookup.mutateAsync({ save: row.save });");
    expect(save).toContain("failed += 1;");
    expect(save).toContain("setSaved((s) => ({ ...s, [row.ref]: r.href }));");
    expect(save).toContain("void invalidatePeopleReads(utils);");
    expect(card).toContain("onError: (e) => toast.error(e.message || \"The record could not be saved.\"),");
  });

  it("a save that spends anything is confirmed with the total first; a free one is not", () => {
    const ask = between("const askThenSave = ", "const body = (");
    expect(ask).toContain("const cost = lookupSaveCost(rows);");
    expect(ask).toContain("if (cost.total === 0) return go();");
    expect(ask).toContain("confirmAction({");
    expect(ask).toContain("description: `This spends ${cost.text}. Rows from LinkedIn, Apollo and QuickEnrich are free.`,");
    // Every person save goes through it: one row or the ticked ones.
    expect(card).toContain("onClick={() => askThenSave([p], true)}>{saveLabel(p)}</Button>");
    expect(card).toContain("onClick={() => askThenSave(chosen, false)} data-name-lookup-save-selected>");
    expect(card.match(/saveRows\(/g)).toHaveLength(2); // inside askThenSave, and a company (always free)
  });

  it("the help says where it is", () => {
    const help = read("./seedHelpContent.ts");
    expect(help).toContain("**Find a person or a company by name**");
    expect(help).toContain("you are asked before your prospect sources are");
  });
});
