/**
 * CRM contacts → People (migration 0160, owner-approved 2026-08-12).
 *
 * The People tab lists only `prospects`; contacts lived in a disjoint table
 * with a page nothing links to, so "why are my contacts not in People?" was
 * the honest question. The fold-in mirrors 0153's queue work: link column,
 * tiered upsert through the merge, ingest seams, daily+boot backfill.
 *
 * The dead-wiring rule, both directions: the column exists AND every
 * creation seam writes it AND the backfill heals history.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { contacts, prospects } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { CONTACT_PROVENANCE, upsertPersonForContact } from "./services/personLink";
import { CONFIDENCE } from "./services/enrichment/fieldMerge";

const read = (p: string) => readFileSync(p, "utf8");

describe("migration 0160 is declared in both places", () => {
  it("rawMigrations + schema agree on column and index", () => {
    const mig = read("server/_core/rawMigrations.ts");
    expect(mig).toContain("0160_contacts_person_link.sql");
    expect(mig).toContain("ALTER TABLE `contacts` ADD COLUMN `person_prospect_id` int NULL");
    expect(mig).toContain("CREATE INDEX `ix_contacts_person` ON `contacts` (`person_prospect_id`)");
    const schema = read("drizzle/schema.ts");
    expect(schema).toMatch(/personProspectId: int\("person_prospect_id"\)/);
    expect(schema).toContain('index("ix_contacts_person")');
  });
});

describe("every contact-creation seam links its person", () => {
  /**
   * Enumerated from `git grep insert(contacts)` at build time of this
   * feature; a NEW creation seam must join this list (and wire the link) or
   * its contacts silently vanish from People again. seed.ts is exempt —
   * demo data is deleted by Remove Sample Data, not folded into People.
   */
  it("promotion writes the direct link — the person IS the promoted prospect", () => {
    const src = read("server/services/prospectPromotion.ts");
    expect(src).toContain("personProspectId: prospectId");
  });

  it("contacts.create and lead conversion run the tiered upsert", () => {
    const src = read("server/routers/crm.ts");
    const calls = src.match(/upsertPersonForContact\(/g) ?? [];
    expect(calls.length, "crm.ts should link at BOTH create and convert").toBeGreaterThanOrEqual(2);
  });

  it("the ARE signal-contact seam prefers the queue row's known person", () => {
    const src = read("server/routers/are/execution.ts");
    expect(src).toContain("prospect.personProspectId");
    expect(src).toContain("upsertPersonForContact(");
  });

  it("the contact import fires the batch link after completion", () => {
    const src = read("server/routers/imports.ts");
    expect(src).toContain("linkUnlinkedContacts({ workspaceId: wsId");
  });

  it("the boot/daily backfill heals whatever the seams missed", () => {
    const src = read("server/_core/index.ts");
    expect(src).toContain("linkUnlinkedContacts({ limit: 500 })");
  });
});

describe("provenance tier", () => {
  it("contact values enter the merge as crm_contact at the preexisting tier", () => {
    // Curated CRM records: above scraped finds (55), below verified emails.
    expect(CONTACT_PROVENANCE).toEqual({ source: "crm_contact", confidence: CONFIDENCE.preexisting });
    expect(CONFIDENCE.preexisting).toBeGreaterThan(CONFIDENCE.scrapeFound);
    expect(CONFIDENCE.preexisting).toBeLessThan(CONFIDENCE.patternReoonValid);
  });
});

describe("upsertPersonForContact fast path", () => {
  it("a person already claiming the contact via linkedContactId wins without matching", async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const builder = () => {
      const st: { table?: unknown } = {};
      const b: any = {
        from(t: unknown) { st.table = t; return b; },
        where() { return b; },
        limit() { return b; },
        then(res: (v: unknown) => void) {
          // The ONLY select this path may run is the claimed-person lookup.
          res(st.table === prospects ? [{ id: 777 }] : []);
        },
      };
      return b;
    };
    h.db = {
      select: () => builder(),
      update(table: unknown) {
        return { set(values: Record<string, unknown>) { updates.push({ table, values }); return { where: () => Promise.resolve([]) }; } };
      },
    };

    const r = await upsertPersonForContact(1, {
      id: 42, firstName: "Jane", lastName: "Doe",
      email: null, linkedinUrl: null, phone: null, title: null,
      companyName: null, companyDomain: null,
    });
    expect(r).toEqual({ personId: 777, created: false, tier: "promoted_pair" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ table: contacts, values: { personProspectId: 777 } });
  });

  it("never steals a person already paired with a different contact", () => {
    // The pair-completion update is guarded by isNull(linkedContactId) —
    // structural, because the guard lives in the WHERE a fake cannot read.
    const src = read("server/services/personLink.ts");
    const at = src.indexOf("set({ linkedContactId: c.id }");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain("isNull(prospects.linkedContactId)");
  });
});

describe("name-only contacts still fold in — the owner's 900 had no keys", () => {
  /**
   * The historic contact base has email = null across the board (the
   * dataCleanup finding), no LinkedIn, and often no company column. The
   * queue rows' key requirement would have skipped every one of them,
   * FOREVER — "not appearing in People" with extra steps. Curated CRM
   * contacts qualify on a real name alone; placeholder names do not.
   */
  function makeDb(rec: { inserts: unknown[]; updates: Array<{ table: unknown; values: Record<string, unknown> }> }) {
    const builder = () => {
      const st: { table?: unknown } = {};
      const b: any = {
        from(t: unknown) { st.table = t; return b; },
        where() { return b; },
        orderBy() { return b; },
        limit() { return b; },
        then(res: (v: unknown) => void) { res([]); }, // no claimed person, no matches
      };
      return b;
    };
    return {
      select: () => builder(),
      insert(table: unknown) {
        return {
          values(v: unknown) {
            rec.inserts.push({ table, values: v });
            return { $returningId: async () => [{ id: 901 }] };
          },
        };
      },
      update(table: unknown) {
        return { set(values: Record<string, unknown>) { rec.updates.push({ table, values }); return { where: () => Promise.resolve([]) }; } };
      },
    };
  }

  it("a real name with zero identity keys creates a People record and links it", async () => {
    const rec = { inserts: [] as any[], updates: [] as any[] };
    h.db = makeDb(rec);
    const r = await upsertPersonForContact(1, {
      id: 42, firstName: "Dana", lastName: "Whitfield",
      email: null, linkedinUrl: null, phone: null, title: "Grants Director",
      companyName: null, companyDomain: null,
    });
    expect(r).toMatchObject({ personId: 901, created: true });
    expect(rec.inserts.some((i) => i.table === prospects)).toBe(true);
    expect(rec.updates.some((u) => u.table === contacts && u.values.personProspectId === 901)).toBe(true);
  });

  it("a placeholder-named contact is skipped — an 'Unknown Prospect' card is noise, not a person", async () => {
    const rec = { inserts: [] as any[], updates: [] as any[] };
    h.db = makeDb(rec);
    const r = await upsertPersonForContact(1, {
      id: 43, firstName: "Unknown", lastName: "Unknown",
      email: null, linkedinUrl: null, phone: null, title: null,
      companyName: null, companyDomain: null,
    });
    expect(r).toBeNull();
    expect(rec.inserts).toHaveLength(0);
  });

  it("the backfill drains by keyset pages, so 900 imports do not wait two daily ticks", () => {
    const src = read("server/services/personLink.ts");
    const fn = src.slice(src.indexOf("export async function linkUnlinkedContacts"));
    // Keyset, not OFFSET: skipped rows stay NULL and would repeat a page.
    expect(fn).toContain("gt(contacts.id, lastId)");
    expect(fn).toContain("if (rows.length < pageSize) break;");
    expect(fn).toMatch(/maxPages/);
  });
});
