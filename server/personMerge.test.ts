/**
 * personMerge — the guard on a path that DELETES PRODUCTION ROWS.
 *
 * Velocity had no People merge until 2026-09-20; `personContactDuplicates`
 * classified pairs as `needs_merge` and offered nothing. LSI Media carried 99
 * flagged pairs across 50 clusters, 18 of them COMPLEMENTARY — one row with a
 * phone and no city, its twin with a city and no phone. A merge that picks a
 * winner and discards the rest loses that customer's data permanently and
 * there is no undo, so the rules are pinned here rather than trusted:
 *
 *  · SURVIVOR — contact-linked first, then LOWEST id. Deterministic, so the
 *    row a human approved in the preview is the row that survives the confirm.
 *  · THE APPROVED IDS ARE THE PLAN — execute takes {survivorId, loserIds} and
 *    refuses the cluster if the re-plan disagrees. Deterministic is not stable:
 *    the Link repair on the same page writes the very column the survivor rule
 *    reads.
 *  · FIELD UNION — the survivor's non-blank values are never overwritten, and
 *    `0` / `false` are values, not blanks; except that a column which only
 *    DESCRIBES another column travels with it (ATOMIC_FIELD_GROUPS).
 *  · IDENTITY GUARD — a cluster whose rows disagree on lastName or
 *    companyDomain is two humans behind one mailbox; it is skipped, not
 *    guessed at.
 *  · COMPLETENESS, derived from drizzle/schema.ts — every column that
 *    references a People row, and every POLYMORPHIC table that can, must be
 *    handled or excluded with a stated reason.
 *  · ORDER — record, repoint, THEN delete, with the delete scoped by
 *    workspaceId. Asserted twice: once on the source text, once by running the
 *    real function against a recording fake db.
 *
 * 2026-09-20: the completeness pin in the first cut matched three HARD-CODED
 * column names, so it was green by construction for every reference shape it
 * did not already know — and five real references were in fact missed. It
 * derives its candidates from the schema now, including the polymorphic ones a
 * column-name scan cannot see.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  ATOMIC_FIELD_GROUPS,
  EXCLUDED_POLY_REFS,
  IDENTITY_FIELDS,
  MERGEABLE_FIELDS,
  NON_MERGEABLE_FIELDS,
  PERSON_POLY_REF_TABLES,
  PERSON_REF_TABLES,
  PROPOSAL_JSON_REF,
  PROPOSAL_SCAN_CAP,
  identityConflict,
  isBlankValue,
  pickSurvivor,
  sameIdSet,
  trimAuditPayload,
  unionPersonFields,
} from "./services/personMerge";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dialect = new MySqlDialect();
const render = (x: unknown) => {
  try {
    return dialect.sqlToQuery(x as never);
  } catch {
    return { sql: "", params: [] as unknown[] };
  }
};

/* ── The survivor rule ────────────────────────────────────────────────────── */

describe("survivor selection is deterministic", () => {
  it("a row a contact already points at beats a lower id", () => {
    // contacts.personProspectId is what the CRM, promotion and the "Add
    // existing" wizard resolve through. Keeping that row keeps every existing
    // link valid with no repoint at all.
    const v = pickSurvivor([
      { id: 3489, contactLinkCount: 0 },
      { id: 3490, contactLinkCount: 1 },
    ]);
    expect(v).toEqual({ survivorId: 3490, reason: "contact-linked", loserIds: [3489] });
  });

  it("several contact-linked rows tie-break on the LOWEST id", () => {
    // 13 of LSI's 50 clusters have BOTH People rows linked to a contact, so
    // this is the common case, not an edge.
    const v = pickSurvivor([
      { id: 91, contactLinkCount: 2 },
      { id: 40, contactLinkCount: 1 },
      { id: 77, contactLinkCount: 3 },
    ]);
    expect(v.survivorId).toBe(40);
    expect(v.reason).toBe("contact-linked");
    expect(v.loserIds).toEqual([77, 91]);
  });

  it("no contact-linked row at all → lowest id, and the losers come back sorted", () => {
    const v = pickSurvivor([
      { id: 3492, contactLinkCount: 0 },
      { id: 3491, contactLinkCount: 0 },
      { id: 3600, contactLinkCount: 0 },
    ]);
    expect(v).toEqual({ survivorId: 3491, reason: "lowest-id", loserIds: [3492, 3600] });
  });

  it("the input order never decides — the same set gives the same survivor", () => {
    const set = [
      { id: 50, contactLinkCount: 0 },
      { id: 12, contactLinkCount: 0 },
      { id: 31, contactLinkCount: 0 },
    ];
    const a = pickSurvivor(set);
    const b = pickSurvivor(set.slice().reverse());
    expect(a).toEqual(b);
  });

  it("is never keyed on updatedAt, which churns on every sweep", () => {
    // prospects.updatedAt carries onUpdateNow(): an enrichment sweep between
    // the preview and the confirm would change the survivor, so the merge a
    // human approved would not be the merge that ran.
    const src = read("server/services/personMerge.ts");
    const fn = src.slice(src.indexOf("export function pickSurvivor"), src.indexOf("export interface PersonMergeFill"));
    expect(fn).not.toContain("updatedAt");
    expect(fn).not.toContain("Math.random");
  });

  it("an id set comparison decides whether the approved plan still holds", () => {
    // 2026-09-20: deterministic is not stable. The Link repair one section
    // above on Data Health writes contacts.personProspectId — the very column
    // pickSurvivor reads — so the confirm compares ids rather than re-deriving.
    expect(sameIdSet([3491], [3491])).toBe(true);
    expect(sameIdSet([3491, 3600], [3600, 3491])).toBe(true);
    expect(sameIdSet([3491], [3491, 3600])).toBe(false);
    expect(sameIdSet([3491], [3492])).toBe(false);
  });
});

/* ── The field union — the rule that makes the 18 complementary clusters safe */

describe("field union fills blanks and never overwrites", () => {
  it("one row's phone and the other's city BOTH survive", () => {
    // rfrye@displayitinc.com, prospects 3491/3492 on prod: neither row is
    // wrong, and a winner-takes-all merge loses half the record.
    const survivor = { id: 3492, phone: null, city: "Dallas" };
    const { patch, filled } = unionPersonFields(survivor, [{ id: 3491, phone: "9496006300", city: null }], ["phone", "city"]);
    expect(patch).toEqual({ phone: "9496006300" });
    expect(filled).toEqual([{ field: "phone", fromPersonId: 3491 }]);
  });

  it("a non-empty survivor value is NEVER overwritten", () => {
    const { patch, filled } = unionPersonFields(
      { id: 1, title: "VP Marketing" },
      [{ id: 2, title: "Chief Marketing Officer" }],
      ["title"],
    );
    expect(patch).toEqual({});
    expect(filled).toEqual([]);
  });

  it("blanks fill from the LOWEST loser id first", () => {
    const { patch, filled } = unionPersonFields(
      { id: 1, phone: "" },
      [{ id: 9, phone: "999" }, { id: 4, phone: "444" }],
      ["phone"],
    );
    expect(patch).toEqual({ phone: "444" });
    expect(filled).toEqual([{ field: "phone", fromPersonId: 4 }]);
  });

  it("null, undefined and \"\" (including whitespace) are blanks", () => {
    expect(isBlankValue(null)).toBe(true);
    expect(isBlankValue(undefined)).toBe(true);
    expect(isBlankValue("")).toBe(true);
    expect(isBlankValue("   ")).toBe(true);
    const { patch } = unionPersonFields(
      { id: 1, a: null, b: undefined, c: "  " },
      [{ id: 2, a: "A", b: "B", c: "C" }],
      ["a", "b", "c"],
    );
    expect(patch).toEqual({ a: "A", b: "B", c: "C" });
  });

  it("0 and false are VALUES, not blanks", () => {
    // confidenceScore 0 is a real score and linkedinUrlVerified false is a
    // real verdict. Treating either as a gap lets a loser's `true` overwrite a
    // survivor's deliberate `false` — which is an overwrite, and this merge
    // never overwrites.
    expect(isBlankValue(0)).toBe(false);
    expect(isBlankValue(false)).toBe(false);
    const { patch, filled } = unionPersonFields(
      { id: 1, confidenceScore: 0, linkedinUrlVerified: false },
      [{ id: 2, confidenceScore: 90, linkedinUrlVerified: true }],
      ["confidenceScore", "linkedinUrlVerified"],
    );
    expect(patch).toEqual({});
    expect(filled).toEqual([]);
  });

  it("a field no loser carries is simply left alone", () => {
    const { patch } = unionPersonFields({ id: 1, phone: null }, [{ id: 2, phone: null }], ["phone"]);
    expect(patch).toEqual({});
    expect("phone" in patch).toBe(false);
  });

  /* ── The NOT-NULL-default hole (2026-09-20 review, defect 9) ────────────── */

  it("an inherited profile photo brings its STATUS with it, or it does not render", () => {
    // profileImageStatus is `.default("unknown").notNull()`, so isBlankValue
    // calls the survivor's default an answer and never fills it. The URL (a
    // nullable text column) WAS filled — and resolveProspectProfileImage
    // returns url:null unless the status is "available", so the merge copied a
    // photo that could never be shown and then deleted the only row that held
    // a coherent (url, status) pair.
    const { patch, filled } = unionPersonFields(
      { id: 3492, profileImageUrl: null, profileImageSource: null, profileImageSourceUrl: null, profileImageStatus: "unknown", profileImageLastVerifiedAt: null },
      [{ id: 3491, profileImageUrl: "https://cdn/x.jpg", profileImageSource: "enrichment_provider", profileImageSourceUrl: "https://li/x", profileImageStatus: "available", profileImageLastVerifiedAt: null }],
    );
    expect(patch.profileImageUrl).toBe("https://cdn/x.jpg");
    expect(patch.profileImageStatus).toBe("available");
    expect(patch.profileImageSource).toBe("enrichment_provider");
    // …reported once, not twice, or the preview lists the field twice over.
    expect(filled.filter((f) => f.field === "profileImageStatus").length).toBe(1);
  });

  it("a verified LinkedIn URL does not arrive marked unverified", () => {
    const { patch } = unionPersonFields(
      { id: 2, linkedinUrl: null, linkedinUrlVerified: false },
      [{ id: 1, linkedinUrl: "https://linkedin.com/in/x", linkedinUrlVerified: true }],
    );
    expect(patch.linkedinUrl).toBe("https://linkedin.com/in/x");
    expect(patch.linkedinUrlVerified).toBe(true);
  });

  it("the survivor's OWN photo keeps the survivor's own status", () => {
    // The carry only fires when the lead column was actually taken from a
    // loser. A survivor that already has a URL keeps everything describing it.
    const { patch } = unionPersonFields(
      { id: 2, profileImageUrl: "https://cdn/mine.jpg", profileImageStatus: "available" },
      [{ id: 1, profileImageUrl: "https://cdn/theirs.jpg", profileImageStatus: "blocked" }],
    );
    expect(patch).toEqual({});
  });

  it("every atomic group's columns are all mergeable, or the carry is a no-op", () => {
    const mergeable = Array.from(MERGEABLE_FIELDS) as string[];
    ATOMIC_FIELD_GROUPS.forEach((g) => {
      expect(mergeable, g.lead).toContain(g.lead);
      g.carry.forEach((c) => expect(mergeable, c).toContain(c));
    });
  });
});

/* ── The identity guard ───────────────────────────────────────────────────── */

describe("identity guard refuses rather than guesses", () => {
  it("different lastName → skipped with a reason", () => {
    const reason = identityConflict([
      { id: 1, lastName: "Bell", companyDomain: "svpworldwide.com" },
      { id: 2, lastName: "Fitzgerald", companyDomain: "svpworldwide.com" },
    ]);
    expect(reason).toContain("lastName");
    expect(reason).toContain("bell");
    expect(reason).toContain("fitzgerald");
  });

  it("different companyDomain → skipped", () => {
    expect(identityConflict([
      { id: 1, lastName: "Bell", companyDomain: "acme.com" },
      { id: 2, lastName: "Bell", companyDomain: "globex.com" },
    ])).toContain("companyDomain");
  });

  it("a blank disagrees with nobody", () => {
    // A row that simply does not know its companyDomain is not a second human.
    expect(identityConflict([
      { id: 1, lastName: "Bell", companyDomain: null },
      { id: 2, lastName: "Bell", companyDomain: "acme.com" },
    ])).toBeNull();
  });

  it("case and padding are not a disagreement", () => {
    expect(identityConflict([
      { id: 1, lastName: " Bell ", companyDomain: "ACME.com" },
      { id: 2, lastName: "bell", companyDomain: "acme.com" },
    ])).toBeNull();
  });

  it("the guarded fields are the identity-bearing ones", () => {
    expect(Array.from(IDENTITY_FIELDS)).toEqual(["lastName", "companyDomain"]);
  });
});

/* ── THE COMPLETENESS PIN ─────────────────────────────────────────────────── */

/** Every `export const X = mysqlTable(` block with its column lines. */
function schemaTables(): Array<{ name: string; block: string }> {
  const src = read("drizzle/schema.ts");
  const out: Array<{ name: string; block: string }> = [];
  const re = /export const (\w+) = mysqlTable\(/g;
  let m: RegExpExecArray | null;
  const starts: Array<{ name: string; at: number }> = [];
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.push({ name: s.name, block: src.slice(s.at, end) });
  });
  return out;
}

/**
 * The two shapes a People reference can take, read off drizzle/schema.ts with
 * NO allow-list of names anywhere:
 *
 *  · a column whose drizzle name ends in `prospectId`/`ProspectId` or whose db
 *    name ends in `prospect_id` — `matchedProspectId`, `promotedProspectId`
 *    and `providedProspectId` are exactly the three a name allow-list could
 *    not see, and all three were missed;
 *  · a POLYMORPHIC table: a recordType / objectType / relatedType
 *    discriminator plus the id column that goes with it. Nothing about the
 *    column NAME says it can hold a People id — `record_list_members.recordId`
 *    does, and saved lists silently lost their members because of it.
 */
const DISCRIMINATORS = ["recordType", "objectType", "relatedType"];

function derivedRefs(): { columns: string[]; poly: string[] } {
  const columns: string[] = [];
  const poly: string[] = [];
  schemaTables().forEach(({ name, block }) => {
    // Column declarations only (4-space indented) — the index block below them
    // refers to the same columns as `t.prospectId`.
    const cre = /^\s{4}(\w+):\s*(?:int|bigint)\(\s*"([^"]+)"/gm;
    let c: RegExpExecArray | null;
    while ((c = cre.exec(block)) !== null) {
      if (/[Pp]rospect(Id|_id)$/.test(c[1]) || /prospect_id$/.test(c[2])) columns.push(`${name}.${c[1]}`);
    }
    DISCRIMINATORS.forEach((d) => {
      if (!new RegExp(`^\\s{4}${d}:`, "m").test(block)) return;
      const idProp = d.replace(/Type$/, "Id");
      const hasId = new RegExp(`^\\s{4}${idProp}:\\s*(?:int|bigint)\\(`, "m").test(block);
      // A discriminator with no id column beside it still has to be ACCOUNTED
      // for, or "there is no id here" becomes an unwritten assumption.
      poly.push(hasId ? `${name}.${idProp}` : `${name}.${d}`);
    });
  });
  return { columns, poly };
}

/**
 * 🔴 THE MOST IMPORTANT TEST IN THIS FILE.
 *
 * A merge repoints references and then DELETES. Any reference it does not know
 * about is left pointing at a row that no longer exists — silently, with no
 * error, in a customer's production data. So the list of references is not
 * maintained by hand here: it is DERIVED FROM THE SCHEMA on every run and
 * compared with what personMerge.ts actually handles.
 *
 * INTENT, stated so the next person does not weaken it: if you add a column
 * that references a People (`prospects`) row, or a polymorphic table that can
 * hold one, this test MUST fail until personMerge.ts handles it. A polymorphic
 * table may go in EXCLUDED_POLY_REFS instead — but only with the reason a human
 * checked its WRITERS, and that reason is part of the diff.
 */
describe("every schema reference to a People row is handled by the merge", () => {
  const derived = derivedRefs();

  it("the scanner can see (a floor, so a broken parser cannot look clean)", () => {
    // Three separate scanners in this repo have returned ~0 hits and looked
    // like a clean codebase; all three were broken.
    expect(schemaTables().length).toBeGreaterThan(150);
    expect(derived.columns.length).toBeGreaterThanOrEqual(15);
    expect(derived.poly.length).toBeGreaterThanOrEqual(14);
    expect(derived.columns).toContain("contacts.personProspectId");
    expect(derived.columns).toContain("emailDrafts.toProspectId");
    expect(derived.columns).toContain("linkedinEnrichmentJobItems.prospectId");
    // The three a hard-coded name list could not see.
    expect(derived.columns).toContain("linkedinEnrichmentBatchRows.matchedProspectId");
    expect(derived.columns).toContain("linkedinEnrichmentBatchRows.providedProspectId");
    expect(derived.columns).toContain("prospectSearchResults.promotedProspectId");
    // …and the polymorphic one no column-name scan can see at all.
    expect(derived.poly).toContain("recordListMembers.recordId");
    expect(derived.poly).toContain("scoreResults.objectId");
  });

  it("no name allow-list: the scan is a shape, not a list of known columns", () => {
    // The first cut of this test matched three literal column names and was
    // therefore green for every reference it did not already know about. If
    // this file ever names a specific reference column to decide what counts,
    // the pin has stopped being derived.
    const src = read("server/personMerge.test.ts");
    const fn = src.slice(src.indexOf("function derivedRefs()"), src.indexOf("🔴 THE MOST IMPORTANT TEST"));
    expect(fn).not.toContain("personProspectId");
    expect(fn).not.toContain("promotedProspectId");
    expect(fn).not.toContain("objectId\"");
  });

  it("PERSON_REF_TABLES covers EXACTLY the schema's reference columns", () => {
    const handled = PERSON_REF_TABLES.map((t) => t.key).sort();
    const expected = derived.columns.slice().sort();
    expect(
      handled,
      `\n\nThe schema and personMerge.ts disagree about what references a People row.\n` +
        `  schema says: ${expected.join(", ")}\n` +
        `  merge handles: ${handled.join(", ")}\n\n` +
        `A reference the merge does not know about is left pointing at a DELETED row.\n` +
        `Add the column to PERSON_REF_TABLES in server/services/personMerge.ts so the\n` +
        `merge repoints it — do NOT relax this test.\n`,
    ).toEqual(expected);
  });

  it("every polymorphic table is handled, or excluded with a stated reason", () => {
    const handled = PERSON_POLY_REF_TABLES.map((t) => t.key);
    const excluded = Object.keys(EXCLUDED_POLY_REFS);
    const accounted = handled.concat(excluded).sort();
    const expected = derived.poly.slice().sort();
    expect(
      accounted,
      `\n\nA recordType/objectType/relatedType table is neither repointed nor excused.\n` +
        `  schema says: ${expected.join(", ")}\n` +
        `  accounted for: ${accounted.join(", ")}\n\n` +
        `record_list_members held (recordType='prospect', recordId=<a People id>) and was\n` +
        `missed exactly this way: the list simply stopped showing that person, with no\n` +
        `error and no count to notice. Add it to PERSON_POLY_REF_TABLES, or to\n` +
        `EXCLUDED_POLY_REFS with the reason its WRITERS cannot produce a People id.\n`,
    ).toEqual(expected);
    // …and nothing is in both lists, which would read as handled and excused.
    expect(handled.filter((k) => k in EXCLUDED_POLY_REFS)).toEqual([]);
    // Every exclusion carries a real sentence, not a placeholder.
    excluded.forEach((k) => expect(EXCLUDED_POLY_REFS[k].length, k).toBeGreaterThan(40));
  });

  it("the polymorphic handlers name a type value the schema or its writers use", () => {
    // A repoint scoped to the wrong discriminator value moves nothing and
    // reports success. "person" for the scored tables (their enum literally
    // says so), "prospect" for everything else.
    PERSON_POLY_REF_TABLES.forEach((t) => {
      expect(["person", "prospect"], t.key).toContain(t.typeValue);
    });
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('objectType: mysqlEnum("object_type", ["person", "company"])');
    expect(schema).toContain('recordType: varchar("record_type", { length: 16 }).notNull(), // prospect | contact | account');
  });

  it("every handled table is repointed AND counted through the one list", () => {
    // One list, used by both the planner's counts and the executor's updates,
    // so a preview can never describe a repoint the merge does not perform.
    const src = read("server/services/personMerge.ts");
    PERSON_REF_TABLES.concat([]).forEach((t) => {
      expect(src, t.key).toContain(t.key);
      expect(t.field.length, t.key).toBeGreaterThan(0);
    });
    PERSON_POLY_REF_TABLES.forEach((t) => {
      expect(src, t.key).toContain(t.key);
      expect(t.field.length, t.key).toBeGreaterThan(0);
    });
    const loops = src.match(/PERSON_REF_TABLES\[/g) ?? [];
    expect(loops.length).toBeGreaterThanOrEqual(2);
    const polyLoops = src.match(/PERSON_POLY_REF_TABLES\[/g) ?? [];
    expect(polyLoops.length).toBeGreaterThanOrEqual(2);
  });

  it("the JSON array of People ids is handled too, not just the columns", () => {
    // campaign_proposals.prospectIds is a json ARRAY of People ids — no UPDATE
    // can repoint one element of it, so it is rewritten in JS. A merge that
    // ignored it would leave a pending proposal absorbing a ghost.
    const jsonRefs: string[] = [];
    schemaTables().forEach(({ name, block }) => {
      if (/^\s{4}prospectIds:\s*json\(/m.test(block)) jsonRefs.push(`${name}.prospectIds`);
    });
    expect(jsonRefs).toEqual([PROPOSAL_JSON_REF]);
    const src = read("server/services/personMerge.ts");
    expect(src).toContain("campaignProposals");
    expect(src).toContain("prospectIds: next");
  });

  it("every table with no workspaceId column says how it is scoped instead", () => {
    const schema = read("drizzle/schema.ts");
    const unscopable: string[] = [];
    PERSON_REF_TABLES.forEach((t) => {
      const name = t.key.split(".")[0];
      const block = (schemaTables().filter((s) => s.name === name)[0] ?? { block: "" }).block;
      expect(block.length, name).toBeGreaterThan(120);
      const hasWs = /^\s{4}workspaceId:/m.test(block);
      expect(!!t.wsColumn, `${name}: wsColumn must match the schema`).toBe(hasWs);
      if (!hasWs) unscopable.push(name);
    });
    // Exactly one today: contact_import_rows, a child of contact_imports.
    expect(unscopable).toEqual(["contactImportRows"]);
    expect(schema).toContain("export const contactImports = mysqlTable");
    const src = read("server/services/personMerge.ts");
    // The parent scope is written out at every statement that touches it.
    const parentScoped = src.match(/inArray\(contactImportRows\.importId, db\.select\(\{ id: contactImports\.id \}\)/g) ?? [];
    expect(parentScoped.length).toBeGreaterThanOrEqual(3);
  });

  it("every polymorphic table carries its own workspaceId", () => {
    // There is no parent-scoped exception among them, so any future one has to
    // be argued for rather than assumed.
    PERSON_POLY_REF_TABLES.forEach((t) => {
      const name = t.key.split(".")[0];
      const block = (schemaTables().filter((s) => s.name === name)[0] ?? { block: "" }).block;
      expect(/^\s{4}workspaceId:/m.test(block), name).toBe(true);
    });
  });

  it("the enrichment row's own children follow it when two rows collapse", () => {
    // prospect_linkedin_field_snapshots / _changes / linkedin_enrichment_batch_rows
    // all carry `enrichment_id`. Repointing the snapshots to the survivor while
    // deleting the enrichment row they name leaves a change feed whose parent
    // cannot be loaded (2026-09-20 review, defect 5).
    const schema = read("drizzle/schema.ts");
    const holders: string[] = [];
    schemaTables().forEach(({ name, block }) => {
      if (/^\s{4}enrichmentId:\s*int\(/m.test(block)) holders.push(name);
    });
    expect(holders.length).toBeGreaterThanOrEqual(3);
    const unique = PERSON_REF_TABLES.filter((t) => t.uniquePerPerson);
    expect(unique.length).toBe(1);
    const dependents = (unique[0].dependents ?? []).map((d) => d.key.split(".")[0]).sort();
    expect(dependents).toEqual(holders.slice().sort());
    expect(schema).toContain('uniqueIndex("uq_ple_ws_prospect")');
  });
});

/* ── The union's own completeness ─────────────────────────────────────────── */

describe("no prospects column falls between the two lists", () => {
  it("every column is either mergeable or excluded with a stated reason", () => {
    const src = read("drizzle/schema.ts");
    const start = src.indexOf("export const prospects = mysqlTable(");
    const end = src.indexOf("export type Prospect = ", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const cols: string[] = [];
    const re = /^\s{4}(\w+):\s*(int|varchar|text|json|timestamp|boolean|mysqlEnum)\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) cols.push(m[1]);
    expect(cols.length).toBeGreaterThan(40);

    const mergeable = Array.from(MERGEABLE_FIELDS) as string[];
    const orphans = cols.filter((c) => mergeable.indexOf(c) === -1 && !(c in NON_MERGEABLE_FIELDS));
    expect(
      orphans,
      orphans.length
        ? `\n\nprospects column(s) the merge neither fills nor excuses:\n  ${orphans.join("\n  ")}\n\n` +
            `Add it to MERGEABLE_FIELDS so a survivor's blank can be filled from a row\n` +
            `about to be DELETED, or to NON_MERGEABLE_FIELDS with the reason it must not.\n` +
            `A column in neither list loses its value on every merge.\n`
        : undefined,
    ).toEqual([]);
    // …and nothing is in both.
    expect(mergeable.filter((f) => f in NON_MERGEABLE_FIELDS)).toEqual([]);
  });

  it("the excluded columns are the identity, the timestamps and the UNIQUE one", () => {
    expect(Object.keys(NON_MERGEABLE_FIELDS).sort()).toEqual(
      ["cloduraPersonId", "createdAt", "id", "updatedAt", "workspaceId"],
    );
    // cloduraPersonId is `.unique()`: the losers still exist when the union
    // UPDATE runs (they are deleted last), so copying their value is a
    // duplicate-key error halfway through a destructive path.
    expect(read("drizzle/schema.ts")).toContain('cloduraPersonId: varchar("clodura_person_id", { length: 64 }).unique()');
    expect(NON_MERGEABLE_FIELDS.cloduraPersonId).toContain("UNIQUE");
  });
});

/* ── The audit payload ────────────────────────────────────────────────────── */

describe("the audit payload is trimmed deliberately, not discovered mid-delete", () => {
  it("a payload inside the budget is passed through untouched", () => {
    const payload = { email: "a@b.com", losers: [{ id: 1, enrichmentData: { a: 1 } }], deleted: [] };
    const out = trimAuditPayload(payload);
    expect(out.trimmed).toEqual([]);
    expect((out.payload.losers as Array<{ enrichmentData: unknown }>)[0].enrichmentData).toEqual({ a: 1 });
  });

  it("an oversized blob becomes a hash and a byte count, and SAYS it did", () => {
    // max_allowed_packet is not a thing to find out about after db.delete has
    // committed: the audit row is the only surviving copy of the loser rows.
    const big = "x".repeat(5000);
    const payload = {
      email: "a@b.com",
      losers: [{ id: 3491, phone: "555", enrichmentData: big }],
      deleted: [{ key: "prospectLinkedinEnrichments.prospectId", rows: [{ id: 901, summaryAbout: big }] }],
    };
    const out = trimAuditPayload(payload, 4000);
    expect(out.trimmed).toContain("losers#3491.enrichmentData");
    const loser = (out.payload.losers as Array<Record<string, unknown>>)[0];
    expect((loser.enrichmentData as { auditTrimmed: boolean }).auditTrimmed).toBe(true);
    expect((loser.enrichmentData as { bytes: number }).bytes).toBeGreaterThan(4000);
    expect(String((loser.enrichmentData as { sha256: string }).sha256).length).toBe(64);
    // The small columns are left alone — a phone number is not the problem.
    expect(loser.phone).toBe("555");
  });
});

/* ── Source-shape pins ────────────────────────────────────────────────────── */

describe("the planner reads and the executor writes, in that order", () => {
  const src = read("server/services/personMerge.ts");
  const planner = src.slice(
    src.indexOf("export async function planPersonMerge"),
    src.indexOf("async function readProposalRefs"),
  );
  const executor = src.slice(src.indexOf("export async function executePersonMerge"));

  it("planPersonMerge's body contains no write of any kind", () => {
    expect(planner.length).toBeGreaterThan(1000); // floor: the slice is real
    [".insert(", ".update(", ".delete("].forEach((w) => {
      expect(planner, `planPersonMerge must not ${w}`).not.toContain(w);
    });
  });

  it("the helper the planner calls is read-only too", () => {
    const helper = src.slice(src.indexOf("async function readProposalRefs"), src.indexOf("/* ── Execute"));
    expect(helper.length).toBeGreaterThan(200);
    [".insert(", ".update(", ".delete("].forEach((w) => expect(helper).not.toContain(w));
  });

  it("the proposal scan drains rather than truncating, and says when it cannot", () => {
    // 2026-09-20: this was a bare `.limit(500)` with no `+1` and no flag, so
    // proposal 501 kept the id of a person the merge had just deleted and
    // nothing anywhere reported it (review defects 13/14).
    const helper = src.slice(src.indexOf("async function readProposalRefs"), src.indexOf("/* ── Execute"));
    expect(helper).toContain("PROPOSAL_SCAN_PAGES");
    expect(helper).toContain("gt(campaignProposals.id, after)");
    expect(helper).toContain("capped: true");
    // The executor refuses the cluster instead of rewriting a prefix.
    expect(executor).toContain("plan.proposalsCapped");
  });

  it("the People delete is scoped by workspaceId AND by an explicit id list", () => {
    const at = executor.indexOf(".delete(prospects)");
    expect(at).toBeGreaterThan(-1);
    const stmt = executor.slice(at, at + 220);
    expect(stmt).toContain("prospects.workspaceId");
    expect(stmt).toContain("inArray(prospects.id, loserIds)");
    // Never by email: a row inserted between the plan and the delete would go
    // with the rest, and nobody approved it.
    expect(stmt).not.toContain("prospects.email");
  });

  it("the delete runs AFTER every repoint", () => {
    const lastRepoint = Math.max(
      executor.lastIndexOf(".update(ref.table)"),
      executor.lastIndexOf(".update(campaignProposals)"),
    );
    const del = executor.indexOf(".delete(prospects)");
    expect(lastRepoint).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(lastRepoint);
  });

  it("execute refuses a bare 'merge everything' and holds the caller to the ids", () => {
    expect(executor).toContain("if (!opts.clusters || opts.clusters.length === 0)");
    // …and it re-plans server-side rather than trusting a plan from a caller…
    expect(executor).toContain("await planPersonMerge(db, workspaceId,");
    // …and then checks the re-plan against what the human actually approved.
    expect(executor).toContain("!sameIdSet(want.loserIds, cluster.loserIds)");
    expect(executor).toContain("want.survivorId !== cluster.survivorId");
  });

  it("the record is written BEFORE the first destructive statement", () => {
    // 2026-09-20 (review defects 3/11): the audit row went through
    // `recordAudit`, whose entire body is `try { … } catch { console.warn }`
    // and which opens its own connection — so the only surviving copy of the
    // destroyed rows could fail to be written with the rows already gone and
    // the caller still told it succeeded.
    const svc = read("server/services/personMerge.ts");
    expect(svc, "the error-swallowing helper must not be imported here").not.toContain('from "../audit"');
    expect(executor, "…nor called").not.toContain("recordAudit(");
    const audit = executor.indexOf("db.insert(auditLog)");
    expect(audit).toBeGreaterThan(-1);
    expect(executor.indexOf(".delete(prospects)")).toBeGreaterThan(audit);
    expect(executor.indexOf(".update(prospects)")).toBeGreaterThan(audit);
    // Every queued repoint/drop runs after it too — the writes are collected in
    // phase A and executed in phase C.
    expect(executor.indexOf("for (let w = 0; w < writes.length; w++)")).toBeGreaterThan(audit);
    // A failure abandons the cluster and is REPORTED, not warned about.
    expect(executor).toContain("unrecorded.push(");
  });

  it("an irreversible operation records what it destroyed", () => {
    const at = executor.indexOf("db.insert(auditLog)");
    expect(at).toBeGreaterThan(-1);
    const call = executor.slice(at, at + 800);
    expect(call).toContain('entityType: "person_merge"');
    expect(call).toContain("survivorId");
    expect(call).toContain("losedIds");
    expect(call).toContain("fieldsFilled");
    expect(call).toContain("repoints");
    // The whole loser rows AND every row the merge deletes outright, because
    // the audit log is the only surviving copy of both.
    const payload = executor.slice(executor.indexOf("trimAuditPayload({"), at);
    expect(payload).toContain("losers: loserRows");
    expect(payload).toContain("deleted: destroyed");
  });

  it("the LinkedIn dossier is COMBINED, never simply dropped", () => {
    // The old unique-per-person path deleted every loser row whenever the
    // survivor held one, destroying the full Unipile profile (experience,
    // education, skills, about) in favour of an empty `created_new` stub —
    // while the preview called it a repoint (review defects 2/5).
    const branch = executor.slice(executor.indexOf("if (ref.uniquePerPerson)"), executor.indexOf("contacts.personProspectId is NOT"));
    expect(branch).toContain("density");
    expect(branch).toContain("unionPersonFields(keeper, others, fields)");
    expect(branch).toContain("record(ref.key, others)");
    expect(branch).toContain("dep.field");
  });

  it("contacts are NOT de-duplicated by this merge", () => {
    // After a merge several contacts can point at the survivor. That is
    // correct — 13 of LSI's 50 clusters already have two linked contacts —
    // and collapsing them is dataHealth.mergeContacts, a different problem.
    expect(executor).not.toContain(".delete(contacts)");
    expect(src).toContain("de-duplicating contacts is `dataHealth.mergeContacts`");
  });

  it("the cluster definition is the detector's, through the same two helpers", () => {
    // A merge that disagreed with the detector about what a duplicate IS would
    // be a second matcher, and two matchers disagree.
    expect(src).toContain('from "@shared/fieldHygiene"');
    expect(src).toContain('from "@shared/genericEmail"');
    expect(src).toContain("isGenericInboxEmail(key)");
    // Raw column in the GROUP BY, so ix_pro_email stays probeable. Comments
    // are stripped first: the one right above the scan NAMES `LOWER(TRIM(...))`
    // as the thing it is avoiding, and a scanner that reads its own warning as
    // a violation is a scanner nobody can keep green.
    const code = planner
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .toLowerCase();
    expect(code).not.toContain("lower(");
    expect(code).not.toContain("trim(");
  });
});

/* ── Executed: the real functions against a recording fake db ─────────────── */

interface Op { kind: "select" | "update" | "delete" | "insert"; table: string; where?: unknown; set?: unknown }
interface State { sel?: Record<string, unknown>; table?: string; where?: unknown; grouped: boolean }

const tableName = (t: unknown) => String((t as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] ?? "?");

function makeDb(handler: (st: State) => unknown[], log: Op[]) {
  const selectBuilder = (sel?: Record<string, unknown>) => {
    const st: State = { sel, grouped: false };
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      from(t: unknown) { st.table = tableName(t); return b; },
      where(c: unknown) { st.where = c; return b; },
      groupBy() { st.grouped = true; return b; },
      having() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        log.push({ kind: "select", table: st.table ?? "?", where: st.where });
        try { res(handler(st)); } catch (e) { rej(e); }
      },
    });
    return b;
  };
  return {
    select: (sel?: Record<string, unknown>) => selectBuilder(sel),
    update: (t: unknown) => ({
      set: (payload: unknown) => ({
        where: (c: unknown) => {
          log.push({ kind: "update", table: tableName(t), where: c, set: payload });
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: (c: unknown) => {
        log.push({ kind: "delete", table: tableName(t), where: c });
        return Promise.resolve([]);
      },
    }),
    insert: (t: unknown) => ({
      values: (payload: unknown) => {
        log.push({ kind: "insert", table: tableName(t), set: payload });
        return Promise.resolve([]);
      },
    }),
  };
}

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

const WS = 7;

/** A prospects row with just the fields these cases care about. */
const P = (id: number, over: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, firstName: "Ryan", lastName: "Frye", email: "rfrye@displayitinc.com",
  phone: null, city: null, company: "Display It", companyDomain: "displayitinc.com",
  title: null, confidenceScore: null, linkedinUrlVerified: false, ...over,
});

/** A prospect_linkedin_enrichments row: `full` is the real dossier. */
const E = (id: number, prospectId: number, full: boolean) => ({
  id, workspaceId: WS, prospectId,
  linkedinProfileUrl: "https://linkedin.com/in/rfrye",
  linkedinHeadline: full ? "VP Sales at Display It" : null,
  linkedinLocation: full ? "Dallas, TX" : null,
  currentTitle: full ? "VP Sales" : null,
  experienceHistoryJson: full ? [{ company: "Display It" }] : null,
  educationHistoryJson: full ? [{ school: "UT" }] : null,
  skillsJson: full ? ["Sales"] : null,
  summaryAbout: full ? "Twenty years in display." : null,
  linkedinDataStatus: full ? "enriched" : "pending",
  createdAt: null, updatedAt: null,
});

/**
 * The fixture, taken from the shape of the live data:
 *  · rfrye@displayitinc.com — 3491 has the phone, 3492 has the city and the
 *    only linked contact, so 3492 survives and inherits the phone;
 *  · the survivor carries an EMPTY enrichment stub and the loser the full
 *    dossier — the case that used to delete the dossier outright;
 *  · the loser sits on two saved lists, one of which the survivor is already
 *    on, so one membership moves and one is a duplicate;
 *  · shared@acme.com — two different surnames behind one mailbox, skipped;
 *  · info@lsi.com — a shared inbox, dropped before it is ever fetched.
 */
function scriptedHandler(st: State): unknown[] {
  const keys = st.sel ? Object.keys(st.sel).sort().join(",") : "*";
  const sql = render(st.where).sql;
  if (st.table === "prospects") {
    if (keys === "email,n") {
      return [
        { email: "rfrye@displayitinc.com", n: 2 },
        { email: "info@lsi.com", n: 2 },
        { email: "shared@acme.com", n: 2 },
      ];
    }
    if (sql.includes("`email` in")) {
      return [
        P(3491, { phone: "9496006300" }),
        P(3492, { city: "Dallas" }),
        P(100, { email: "shared@acme.com", lastName: "Smith", companyDomain: "acme.com" }),
        P(101, { email: "shared@acme.com", lastName: "Jones", companyDomain: "acme.com" }),
      ];
    }
    if (sql.includes("`id` = ")) return [P(3492, { city: "Dallas" })];
    if (sql.includes("`id` in")) return [P(3491, { phone: "9496006300" })];
    return [];
  }
  if (st.table === "contacts") {
    if (keys === "personId") return [{ personId: 3492 }];        // the survivor rule's input
    if (keys === "n,personId") return [];                         // plan's repoint count
    return [{ n: 0 }];                                            // execute's repoint count
  }
  if (st.table === "campaign_proposals") return [{ id: 9, prospectIds: [3491, 77] }];
  if (st.table === "enrollments") {
    if (keys === "n,personId") return [{ personId: 3491, n: 2 }];
    return [{ n: 2 }];
  }
  if (st.table === "prospect_linkedin_enrichments") {
    if (keys === "n,personId") return [{ personId: 3491, n: 1 }];
    // The executor reads the whole rows: survivor's stub AND loser's dossier.
    if (keys === "*") return [E(900, 3492, false), E(901, 3491, true)];
    return [{ n: 0 }];
  }
  if (st.table === "tasks") {
    // An open "Follow up with Ryan" task, pointed at the loser polymorphically.
    if (keys === "n,personId") return [{ personId: 3491, n: 3 }];
    return [{ n: 3 }];
  }
  if (st.table === "record_list_members") {
    if (keys === "n,personId") return [{ personId: 3491, n: 2 }];
    if (keys === "*") {
      return [
        { id: 700, workspaceId: WS, listId: 7, recordType: "prospect", recordId: 3492 },
        { id: 701, workspaceId: WS, listId: 7, recordType: "prospect", recordId: 3491 },
        { id: 702, workspaceId: WS, listId: 9, recordType: "prospect", recordId: 3491 },
      ];
    }
    return [{ n: 0 }];
  }
  if (keys === "n,personId") return [];
  if (keys === "*") return [];
  return [{ n: 0 }];
}

describe("planPersonMerge, run for real", () => {
  const log: Op[] = [];
  const out = (async () => {
    h.db = makeDb(scriptedHandler, log);
    const { planPersonMerge } = await import("./services/personMerge");
    return planPersonMerge(h.db as never, WS, {});
  })();

  it("picks the contact-linked survivor even though it is the higher id", async () => {
    const plan = await out;
    expect(plan.merge.length).toBe(1);
    expect(plan.merge[0].survivorId).toBe(3492);
    expect(plan.merge[0].survivorReason).toBe("contact-linked");
    expect(plan.merge[0].loserIds).toEqual([3491]);
    expect(plan.peopleDeleted).toBe(1);
  });

  it("reports the field the survivor would inherit", async () => {
    const plan = await out;
    expect(plan.merge[0].fieldsFilled).toEqual([{ field: "phone", fromPersonId: 3491 }]);
  });

  it("counts the references that would move, per table AND per cluster", async () => {
    const plan = await out;
    const byKey: Record<string, number> = {};
    plan.merge[0].repoints.forEach((r) => { byKey[r.key] = r.rows; });
    expect(byKey["enrollments.prospectId"]).toBe(2);
    expect(byKey[PROPOSAL_JSON_REF]).toBe(1);
    // The saved-list membership the first cut never saw at all.
    expect(byKey["recordListMembers.recordId"]).toBe(2);
    expect(byKey["prospectLinkedinEnrichments.prospectId"]).toBe(1);
    // …and the open tasks, which a column-name scan cannot see either.
    expect(byKey["tasks.relatedId"]).toBe(3);
    expect(plan.merge[0].repointTotal).toBe(9);
  });

  it("tells the truth about WHAT happens to each table, not just how many", async () => {
    // The preview said "References repointed: prospectLinkedinEnrichments — 1
    // row" for an operation that deleted the row. The mode is planned from the
    // one descriptor list, so the preview and the execution cannot disagree.
    const plan = await out;
    const mode = (key: string) => plan.merge[0].repoints.filter((r) => r.key === key)[0]?.mode;
    expect(mode("enrollments.prospectId")).toBe("repoint");
    expect(mode("prospectLinkedinEnrichments.prospectId")).toBe("combine");
    expect(mode("recordListMembers.recordId")).toBe("dedupe");
  });

  it("skips the two-humans-one-mailbox cluster and the shared inbox", async () => {
    const plan = await out;
    expect(plan.skipped.map((s) => s.email)).toEqual(["shared@acme.com"]);
    expect(plan.skipped[0].reason).toContain("lastName");
    expect(plan.skippedGeneric).toBe(1);
    // …and the generic address is never even fetched.
    expect(render(log.filter((o) => o.kind === "select")[1]?.where).params).not.toContain("info@lsi.com");
  });

  it("writes NOTHING — not one update, insert or delete", async () => {
    await out;
    expect(log.filter((o) => o.kind !== "select")).toEqual([]);
  });

  it("scopes every read it makes to the workspace", async () => {
    await out;
    const unscoped = log
      .filter((o) => o.kind === "select" && o.table !== "contact_import_rows")
      .filter((o) => !render(o.where).params.includes(WS));
    expect(unscoped.map((o) => o.table)).toEqual([]);
  });

  it("the proposal scan is not capped on a workspace with one proposal", async () => {
    const plan = await out;
    expect(plan.proposalsCapped).toBe(false);
  });
});

const APPROVED = { email: "rfrye@displayitinc.com", survivorId: 3492, loserIds: [3491] };

describe("executePersonMerge, run for real", () => {
  const log: Op[] = [];
  const out = (async () => {
    h.db = makeDb(scriptedHandler, log);
    const { executePersonMerge } = await import("./services/personMerge");
    return executePersonMerge(h.db as never, WS, { clusters: [APPROVED], actorUserId: 42 });
  })();

  it("fills the survivor, repoints, and reports what it destroyed", async () => {
    const r = await out;
    expect(r.merged.length).toBe(1);
    expect(r.merged[0].survivorId).toBe(3492);
    expect(r.merged[0].loserIds).toEqual([3491]);
    expect(r.merged[0].fieldsFilled).toEqual([{ field: "phone", fromPersonId: 3491 }]);
    expect(r.peopleDeleted).toBe(1);
    expect(r.stale).toEqual([]);
    expect(r.unrecorded).toEqual([]);
    const fill = log.filter((o) => o.kind === "update" && o.table === "prospects")[0];
    expect(fill.set).toEqual({ phone: "9496006300" });
  });

  it("DELETES THE LOSERS LAST — after every repoint", async () => {
    await out;
    const del = log.findIndex((o) => o.kind === "delete" && o.table === "prospects");
    expect(del).toBeGreaterThan(-1);
    const repoints = log
      .map((o, i) => ({ o, i }))
      .filter((x) => x.o.kind === "update" && x.o.table !== "prospects");
    expect(repoints.length).toBeGreaterThan(0);
    repoints.forEach((x) => {
      expect(x.i, `${x.o.table} repointed AFTER the delete — that orphans the row`).toBeLessThan(del);
    });
  });

  it("the delete carries workspaceId and the explicit loser ids", async () => {
    await out;
    const del = log.filter((o) => o.kind === "delete" && o.table === "prospects")[0];
    const q = render(del.where);
    expect(q.sql).toContain("`workspaceId` = ?");
    expect(q.sql).toContain("`id` in");
    expect(q.params).toContain(WS);
    expect(q.params).toContain(3491);
    // The survivor is not in the id list.
    expect(q.params).not.toContain(3492);
  });

  it("repoints the JSON proposal array element-wise, de-duplicated", async () => {
    await out;
    const up = log.filter((o) => o.kind === "update" && o.table === "campaign_proposals")[0];
    expect(up.set).toEqual({ prospectIds: [3492, 77], size: 2 });
  });

  it("every write is workspace-scoped", async () => {
    await out;
    const writes = log.filter((o) => o.kind === "update" || o.kind === "delete");
    expect(writes.length).toBeGreaterThan(1);
    writes.forEach((w) => {
      const q = render(w.where);
      const scoped = q.params.includes(WS) || w.table === "contact_import_rows";
      expect(scoped, `${w.table} write is not workspace-scoped`).toBe(true);
    });
  });

  /* ── The LinkedIn dossier (review defects 2/5) ──────────────────────────── */

  it("keeps the RICHEST enrichment row and folds the stub into it", async () => {
    await out;
    const ups = log.filter((o) => o.kind === "update" && o.table === "prospect_linkedin_enrichments");
    expect(ups.length).toBe(1);
    const set = ups[0].set as Record<string, unknown>;
    // Row 901 (the dossier) is the one kept, moved onto the survivor.
    expect(set.prospectId).toBe(3492);
    // …and it keeps its own content: nothing here blanks it out.
    expect(set.linkedinHeadline).toBeUndefined();
    expect(set.summaryAbout).toBeUndefined();
    const del = log.filter((o) => o.kind === "delete" && o.table === "prospect_linkedin_enrichments")[0];
    expect(render(del.where).params).toContain(900);
    expect(render(del.where).params).not.toContain(901);
  });

  it("the enrichment_id children follow the row that survives the collapse", async () => {
    await out;
    ["prospect_linkedin_field_snapshots", "prospect_linkedin_field_changes", "linkedin_enrichment_batch_rows"]
      .forEach((table) => {
        const up = log.filter((o) => o.kind === "update" && o.table === table && (o.set as Record<string, unknown>).enrichmentId !== undefined)[0];
        expect(up, `${table}.enrichmentId must follow the kept enrichment row`).toBeTruthy();
        expect((up.set as Record<string, unknown>).enrichmentId).toBe(901);
        expect(render(up.where).params).toContain(900);
      });
  });

  it("the row it deletes is in the audit payload BEFORE it is deleted", async () => {
    await out;
    const auditAt = log.findIndex((o) => o.kind === "insert" && o.table === "audit_log");
    const delAt = log.findIndex((o) => o.kind === "delete" && o.table === "prospect_linkedin_enrichments");
    expect(auditAt).toBeGreaterThan(-1);
    expect(delAt).toBeGreaterThan(auditAt);
    const before = (log[auditAt].set as Record<string, unknown>).before as { deleted: Array<{ key: string; rows: Array<{ id: number }> }> };
    const group = before.deleted.filter((d) => d.key === "prospectLinkedinEnrichments.prospectId")[0];
    expect(group.rows[0].id).toBe(900);
  });

  /* ── Saved lists (review defect 1) ──────────────────────────────────────── */

  it("moves the loser's list membership and drops only the true duplicate", async () => {
    await out;
    const up = log.filter((o) => o.kind === "update" && o.table === "record_list_members")[0];
    expect(up.set).toEqual({ recordId: 3492 });
    // List 9: the survivor was not on it, so the membership MOVES.
    expect(render(up.where).params).toContain(702);
    // List 7: the survivor is already a member, so the second row is a
    // duplicate — deleted, and recorded first.
    const del = log.filter((o) => o.kind === "delete" && o.table === "record_list_members")[0];
    expect(render(del.where).params).toContain(701);
    const audit = log.filter((o) => o.kind === "insert" && o.table === "audit_log")[0];
    const before = (audit.set as Record<string, unknown>).before as { deleted: Array<{ key: string; rows: Array<{ id: number }> }> };
    expect(before.deleted.filter((d) => d.key === "recordListMembers.recordId")[0].rows[0].id).toBe(701);
  });

  it("an unconstrained polymorphic repoint still carries its discriminator", async () => {
    // tasks.relatedId is a bare int. Repointing on the id list alone would take
    // the CONTACT whose id happens to be 3491 with it — a different human's
    // open task silently reassigned to this person.
    await out;
    const up = log.filter((o) => o.kind === "update" && o.table === "tasks")[0];
    expect(up, "tasks.relatedId must be repointed").toBeTruthy();
    expect(up.set).toEqual({ relatedId: 3492 });
    const q = render(up.where);
    expect(q.params).toContain("prospect");
    expect(q.params).toContain(3491);
    expect(q.params).toContain(WS);
  });

  /* ── The record (review defects 3/11) ───────────────────────────────────── */

  it("writes the audit row BEFORE anything is destroyed", async () => {
    await out;
    const auditAt = log.findIndex((o) => o.kind === "insert" && o.table === "audit_log");
    expect(auditAt).toBeGreaterThan(-1);
    const destructive = log
      .map((o, i) => ({ o, i }))
      .filter((x) => x.o.kind === "delete" || (x.o.kind === "update" && x.o.table === "prospects"));
    expect(destructive.length).toBeGreaterThan(0);
    destructive.forEach((x) => {
      expect(x.i, `${x.o.kind} on ${x.o.table} ran before the audit row was written`).toBeGreaterThan(auditAt);
    });
  });

  it("writes one audit row naming the survivor, the losers and the repoints", async () => {
    await out;
    const audit = log.filter((o) => o.kind === "insert" && o.table === "audit_log")[0];
    expect(audit).toBeTruthy();
    const row = audit.set as Record<string, unknown>;
    expect(row.workspaceId).toBe(WS);
    expect(row.actorUserId).toBe(42);
    expect(row.entityType).toBe("person_merge");
    expect(row.entityId).toBe(3492);
    const after = row.after as Record<string, unknown>;
    expect(after.survivorId).toBe(3492);
    expect(after.losedIds).toEqual([3491]);
    expect(after.fieldsFilled).toEqual([{ field: "phone", fromPersonId: 3491 }]);
    // The only surviving copy of what was deleted.
    const before = row.before as Record<string, unknown>;
    expect((before.losers as Array<{ id: number }>)[0].id).toBe(3491);
  });

  it("refuses to run with no cluster named", async () => {
    await out;
    const { executePersonMerge } = await import("./services/personMerge");
    await expect(executePersonMerge(h.db as never, WS, { clusters: [], actorUserId: 1 }))
      .rejects.toThrow(/named explicitly/);
  });
});

/* ── The confirm must be the plan the human saw (review defects 8/12) ─────── */

describe("a cluster whose rows moved since the preview is refused, not merged", () => {
  it("a different survivor means nothing is touched", async () => {
    const log: Op[] = [];
    h.db = makeDb(scriptedHandler, log);
    const { executePersonMerge } = await import("./services/personMerge");
    // The operator approved "#3491 survives, #3492 dies" — e.g. because the
    // Link repair above wrote contacts.personProspectId while the dialog was
    // open. The server now re-plans to the opposite and must NOT proceed.
    const r = await executePersonMerge(h.db as never, WS, {
      clusters: [{ email: "rfrye@displayitinc.com", survivorId: 3491, loserIds: [3492] }],
      actorUserId: 42,
    });
    expect(r.merged).toEqual([]);
    expect(r.peopleDeleted).toBe(0);
    expect(r.stale.length).toBe(1);
    expect(r.stale[0].reason).toContain("changed since the preview");
    expect(log.filter((o) => o.kind !== "select")).toEqual([]);
  });

  it("an extra row that appeared in the cluster is refused too", async () => {
    // The nightly CSV import writes a THIRD row with that address while the
    // dialog is open. The old code re-resolved by email and deleted a row the
    // operator never saw.
    const log: Op[] = [];
    h.db = makeDb(scriptedHandler, log);
    const { executePersonMerge } = await import("./services/personMerge");
    const r = await executePersonMerge(h.db as never, WS, {
      clusters: [{ email: "rfrye@displayitinc.com", survivorId: 3492, loserIds: [3491, 3600] }],
      actorUserId: 42,
    });
    expect(r.merged).toEqual([]);
    expect(r.stale.length).toBe(1);
    expect(log.filter((o) => o.kind === "delete")).toEqual([]);
  });

  it("an address that is no longer a cluster is reported, not silently ignored", async () => {
    const log: Op[] = [];
    h.db = makeDb(scriptedHandler, log);
    const { executePersonMerge } = await import("./services/personMerge");
    const r = await executePersonMerge(h.db as never, WS, {
      clusters: [{ email: "gone@example.com", survivorId: 1, loserIds: [2] }],
      actorUserId: 42,
    });
    expect(r.merged).toEqual([]);
    expect(r.stale.map((s) => s.email)).toEqual(["gone@example.com"]);
  });
});

/* ── The proposal bound (review defects 13/14) ────────────────────────────── */

describe("a proposal scan that hits its ceiling refuses the merge", () => {
  /** Every page comes back full, so the drain never terminates naturally. */
  function cappedHandler(st: State): unknown[] {
    if (st.table === "campaign_proposals") {
      const rows: Array<{ id: number; prospectIds: number[] }> = [];
      for (let i = 0; i < PROPOSAL_SCAN_CAP; i++) rows.push({ id: i + 1, prospectIds: [3491] });
      return rows;
    }
    return scriptedHandler(st);
  }

  it("the plan says so rather than reporting a bounded count as the whole truth", async () => {
    const log: Op[] = [];
    h.db = makeDb(cappedHandler, log);
    const { planPersonMerge } = await import("./services/personMerge");
    const plan = await planPersonMerge(h.db as never, WS, {});
    expect(plan.proposalsCapped).toBe(true);
  });

  it("and the executor destroys nothing", async () => {
    // Rewriting the first N proposals and leaving the rest naming a deleted
    // People id is worse than not merging: the proposal absorbs a ghost and
    // its `size` overstates the cohort.
    const log: Op[] = [];
    h.db = makeDb(cappedHandler, log);
    const { executePersonMerge } = await import("./services/personMerge");
    const r = await executePersonMerge(h.db as never, WS, { clusters: [APPROVED], actorUserId: 42 });
    expect(r.merged).toEqual([]);
    expect(r.peopleDeleted).toBe(0);
    expect(r.stale[0].reason).toContain("campaign proposals");
    expect(log.filter((o) => o.kind !== "select")).toEqual([]);
  });
});

/* ── The seam: router and page ────────────────────────────────────────────── */

describe("a merge nobody can reach is not a merge", () => {
  const router = read("server/routers/dataHealth.ts");
  const page = read("client/src/pages/usip/DataHealth.tsx");

  it("both procedures exist and sit ABOVE the provider-effectiveness slice", () => {
    // roadmapPhase345.test.ts slices from the FIRST occurrence of that symbol
    // to end-of-file and forbids `.insert(` / `.update(` inside it.
    const anchor = router.indexOf("providerEffectiveness");
    expect(router.indexOf("planPeopleMerge:")).toBeGreaterThan(-1);
    expect(router.indexOf("planPeopleMerge:")).toBeLessThan(anchor);
    expect(router.indexOf("executePeopleMerge:")).toBeLessThan(anchor);
  });

  it("both are admin-gated, and the missing feature key is explained", () => {
    const slice = router.slice(router.indexOf("planPeopleMerge:"), router.indexOf("providerEffectiveness"));
    expect(slice).toContain("planPeopleMerge: adminWsProcedure");
    expect(slice).toContain("executePeopleMerge: adminWsProcedure");
    // Not export_data: that key is about data LEAVING the workspace, and
    // gating a permanent delete on it would lie to every admin reading the
    // Permissions tab.
    expect(slice).not.toContain('checkPermission(ctx, "export_data")');
    const why = router.slice(router.indexOf("WHY adminWsProcedure"), router.indexOf("planPeopleMerge:"));
    expect(why).toContain("export_data");
    expect(why.length).toBeGreaterThan(300);
  });

  it("the plan is a query and the execute is a mutation taking the APPROVED ids", () => {
    const plan = router.slice(router.indexOf("planPeopleMerge:"), router.indexOf("executePeopleMerge:"));
    expect(plan).toContain(".query(");
    const exec = router.slice(router.indexOf("executePeopleMerge:"), router.indexOf("providerEffectiveness"));
    expect(exec).toContain(".mutation(");
    // min(1): there is deliberately no "merge every duplicate" call. And the
    // survivor/loser ids travel with the address, so the server can refuse a
    // cluster whose rows moved since the preview.
    expect(exec).toMatch(/clusters: z\.array\(/);
    expect(exec).toContain("survivorId: z.number().int().positive()");
    expect(exec).toContain("loserIds: z.array(z.number().int().positive()).min(1)");
    expect(exec).toMatch(/\)\.min\(1\)\.max\(50\)/);
  });

  it("Data Health previews before it destroys, and confirms with the ids", () => {
    expect(page).toContain("planPeopleMerge.useQuery");
    expect(page).toContain("executePeopleMerge.useMutation");
    expect(page).toContain("<PeopleMergeSection />");
    expect(page).toContain("Preview merge");
    expect(page).toContain("<ConfirmButton");
    expect(page).toContain("clusters: [{ email: open.email, survivorId: open.survivorId, loserIds: open.loserIds }]");
  });

  it("the page says the merge is permanent, in those words", () => {
    expect(page).toContain("permanently deletes");
    expect(page).toContain("cannot be undone");
  });

  it("the page no longer promises that everything is merely repointed", () => {
    // It said "…enrichment history — is repointed at the survivor first" for an
    // operation that deleted the losers' enrichment rows outright. Where a row
    // cannot move, the copy now says what actually happens to it.
    expect(page).toContain("combined into that one");
    expect(page).toContain("saved lists");
    expect(page).toContain("written before anything is destroyed");
  });

  it("linking invalidates the merge plan it can invalidate", () => {
    // Both live on this one screen, and the Link repair writes the exact column
    // pickSurvivor reads. Without this the card shows one survivor and the
    // server resolves another.
    const split = page.slice(page.indexOf("function SplitPeopleSection"), page.indexOf("function PeopleMergeSection"));
    expect(split).toContain("utils.dataHealth.planPeopleMerge.invalidate()");
  });

  it("the split-people copy no longer claims People cannot be merged", () => {
    // That paragraph told the owner the duplicate "stays until you edit it by
    // hand" and the count "will not drop". Both were true until 2026-09-20.
    expect(page).not.toContain("Velocity merges contacts and companies, not People");
    expect(page).not.toContain("this count will not drop");
    // The LINK repair still never merges, and that sentence stays true.
    expect(page).toMatch(/never deletes a row and never merges two People\s+rows/);
  });

  it("the detector's header no longer states that no People merge exists", () => {
    const svc = read("server/services/personContactDuplicates.ts");
    expect(svc).not.toContain("There is no People merge");
    expect(svc).toContain("services/personMerge.ts");
    expect(svc).toContain("IRREVERSIBLE");
    // …and it is still read-only itself.
    [".insert(", ".update(", ".delete("].forEach((w) => expect(svc).not.toContain(w));
  });

  it("the operator manual and the data-model reference record it", () => {
    const manual = read("server/seedHelpOperatorManual.ts");
    expect(manual).toContain("People merge");
    expect(manual).toContain("irreversible");
    const dataModel = read(".claude/skills/velocity-operator/references/data-model.md");
    expect(dataModel).toContain("People merge");
    expect(dataModel).toContain("lowest id");
  });
});
