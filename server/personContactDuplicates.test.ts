/**
 * dataHealth.personContactDuplicates — the cross-table duplicate nobody was
 * counting (2026-09-20): one human as a People row AND a CRM contact, with no
 * link between them.
 *
 * Run against the REAL procedure via `appRouter.createCaller`, with the same
 * fake-db + MySqlDialect SQL-text approach as companyDuplicates.test.ts (see
 * prospectFieldHistoryReader.test.ts for why object-walking a drizzle
 * condition proves nothing).
 *
 * The load-bearing assertions, in order of what they stop:
 *
 *  · scope asserted PER QUERY, on BOTH tables — a join carries no scope of its
 *    own, and an unscoped side would report another tenant's rows as this
 *    workspace's damage;
 *  · no `lower(`/`trim(` on the join columns — wrapping either one in a
 *    function makes `ix_pro_email` unprobeable, and the two duplicate checks
 *    already in dataHealth.ts group by the raw column for the same reason;
 *  · no `linked_contact_id <>` exclusion in the scan — a contact whose person
 *    already claims it is the SAFEST repair in the product, and filtering it
 *    out hides the one pair that carries no matching risk at all;
 *  · the classifier sees the contact's CURRENT person. Without it, a contact
 *    that is already linked correctly is indistinguishable from one linked to
 *    a shell, and the repair button re-points a correct link onto a duplicate.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { contacts, prospects, workspaceMembers } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { classifyPair, SCAN_CAP } from "./services/personContactDuplicates";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const WS = { id: 4, name: "Acme Corp" };
const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

interface Cap {
  scanJoinOn?: unknown;
  scanWhere?: unknown;
  contactsWhere?: unknown;
  byEmailWhere?: unknown;
  byIdWhere?: unknown;
  byClaimWhere?: unknown;
}

interface Script {
  candidates: unknown[];
  contactRows: unknown[];
  byEmail: unknown[];
  byId: unknown[];
  byClaim: unknown[];
}

function makeDb(script: Script, cap: Cap) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean; joinOn?: unknown; where?: unknown } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(_t: unknown, on: unknown) { st.joined = true; st.joinOn = on; return b; },
      where(cond: unknown) { st.where = cond; return b; },
      groupBy() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.table === workspaceMembers) {
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role: "rep", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
          return;
        }
        if (st.table === contacts) {
          if (st.joined) { cap.scanJoinOn = st.joinOn; cap.scanWhere = st.where; res(script.candidates); }
          else { cap.contactsWhere = st.where; res(script.contactRows); }
          return;
        }
        if (st.table === prospects) {
          // Discriminated by the clause itself, not by call order: two of the
          // three prospects reads are conditional on there being anything to
          // look up, so an ordinal would drift.
          const sql = render(st.where).sql;
          if (sql.includes("`linked_contact_id` in")) { cap.byClaimWhere = st.where; res(script.byClaim); }
          else if (sql.includes("`prospects`.`id` in")) { cap.byIdWhere = st.where; res(script.byId); }
          else { cap.byEmailWhere = st.where; res(script.byEmail); }
          return;
        }
        rej(new Error(`fake db: unscripted select from ${String((st.table as any)?.[Symbol.for("drizzle:Name")] ?? st.table)}`));
      },
    };
    return b;
  };
  return { select: () => builder() };
}

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

const P = (id: number, first: string, last: string, email: string | null, linkedContactId: number | null = null) =>
  ({ id, firstName: first, lastName: last, email, linkedContactId });

describe("dataHealth.personContactDuplicates", () => {
  const cap: Cap = {};

  const out = (async () => {
    h.db = makeDb({
      candidates: [1, 2, 3, 4, 5, 6].map((contactId) => ({ contactId })),
      contactRows: [
        { id: 1, firstName: "Jane", lastName: "Doe", email: "jane@acme.com", personProspectId: null },
        { id: 2, firstName: "Bob", lastName: "Roe", email: "bob@acme.com", personProspectId: 20 },
        { id: 3, firstName: "Ann", lastName: "Poe", email: "ann@acme.com", personProspectId: 30 },
        { id: 4, firstName: "Info", lastName: "Desk", email: "info@acme.com", personProspectId: null },
        { id: 5, firstName: "Placeholder", lastName: "Row", email: "<UNKNOWN>", personProspectId: null },
        { id: 6, firstName: "Kim", lastName: "Lee", email: "kim@acme.com", personProspectId: null },
      ],
      byEmail: [
        P(10, "Jane", "Doe", "jane@acme.com"),
        P(11, "Bob", "Roe", "bob@acme.com"),
        P(12, "Ann", "Poe", "ann@acme.com"),
        P(13, "Kim", "Lee", "kim@acme.com"),
        P(30, "Ann", "Poe", "ann@acme.com"),
      ],
      byId: [P(20, "Shell", "Record", null), P(30, "Ann", "Poe", "ann@acme.com")],
      byClaim: [P(40, "Kim", "Lee", null, 6)],
    }, cap);
    return appRouter.createCaller(makeCtx()).dataHealth.personContactDuplicates();
  })();

  it("scopes BOTH sides of the join, per query", async () => {
    await out;
    const joinOn = render(cap.scanJoinOn);
    const where = render(cap.scanWhere);
    expect(joinOn.sql).toContain("`prospects`.`workspaceId` = ?");
    expect(where.sql).toContain("`contacts`.`workspaceId` = ?");
    expect(joinOn.params).toContain(WS.id);
    expect(where.params).toContain(WS.id);
    for (const w of [cap.contactsWhere, cap.byEmailWhere, cap.byIdWhere, cap.byClaimWhere]) {
      expect(render(w).params).toContain(WS.id);
    }
  });

  it("matches on the raw email columns, so ix_pro_email stays probeable", async () => {
    await out;
    const sql = `${render(cap.scanJoinOn).sql} ${render(cap.scanWhere).sql}`.toLowerCase();
    expect(sql).toContain("`prospects`.`email` = `contacts`.`email`");
    expect(sql).not.toContain("lower(");
    expect(sql).not.toContain("trim(");
  });

  it("excludes the contact's own person from the scan, but NOT the person that claims it", async () => {
    await out;
    const sql = render(cap.scanWhere).sql;
    expect(sql).toContain("`person_prospect_id`");
    expect(sql).toContain("<>");
    // The fast-path pair — `prospects.linked_contact_id = contacts.id` — is the
    // one repair that needs no matching at all. Filtering it out of detection
    // would hide the safest fix in the product.
    expect(sql).not.toContain("`linked_contact_id`");
  });

  it("classifies each pair against the FULL picture", async () => {
    const r = await out;
    expect(r.scanned).toBe(6);
    expect(r.capped).toBe(false);
    expect(r.skippedGeneric).toBe(1);
    expect(r.total).toBe(4);
    expect(r.pairs.map((p) => [p.contactId, p.kind, p.personId, p.currentPersonId])).toEqual([
      // unlinked, one People row holds the address
      [1, "unlinked", 10, null],
      // linked to a shell that holds no email — the repair re-points it
      [2, "relinkable", 11, 20],
      // TWO People rows hold this address; tier (a) would pick between them
      [3, "needs_merge", 12, 30],
      // a person already claims this contact, so the fast path decides — and
      // detection must predict the SAME person or the repair reports a mismatch
      [6, "unlinked", 40, null],
    ]);
    expect(r.pairs[1].currentPersonName).toBe("Shell Record");
    expect(r.pairs[2].reason).toContain("merge them first");
  });

  it("drops shared inboxes and placeholder addresses rather than fusing humans", async () => {
    const r = await out;
    // info@ on five contacts and one People row is five false duplicates.
    expect(r.pairs.find((p) => p.email === "info@acme.com")).toBeUndefined();
    // "<UNKNOWN>" fails the same shape gate personLink's email tier applies —
    // detection and repair have to agree on what an email is, or "link these
    // two" falls through the name tiers and INSERTS a third person.
    expect(r.pairs.find((p) => p.contactId === 5)).toBeUndefined();
  });
});

describe("a zero from a bounded scan says what it could not see", () => {
  it("reports capped when the scan hits SCAN_CAP", async () => {
    const cap: Cap = {};
    const many = Array.from({ length: SCAN_CAP + 1 }, (_, i) => ({ contactId: i + 1 }));
    h.db = makeDb({
      candidates: many,
      contactRows: [{ id: 1, firstName: "Jane", lastName: "Doe", email: "jane@acme.com", personProspectId: null }],
      byEmail: [P(10, "Jane", "Doe", "jane@acme.com")],
      byId: [],
      byClaim: [],
    }, cap);
    const r = await appRouter.createCaller(makeCtx()).dataHealth.personContactDuplicates();
    expect(r.capped).toBe(true);
    expect(r.scanned).toBe(SCAN_CAP);
  });
});

describe("classifyPair (pure — the decision table with no DB)", () => {
  const shell = P(20, "Shell", "Record", null);

  it("no current person → unlinked", () => {
    const v = classifyPair({ contactId: 1, emailKey: "a@b.com", currentPerson: null, claimant: null, candidates: [P(10, "A", "B", "a@b.com")] });
    expect(v).toMatchObject({ kind: "unlinked", personId: 10 });
  });

  it("linked to a shell that holds no email → relinkable", () => {
    const v = classifyPair({ contactId: 1, emailKey: "a@b.com", currentPerson: shell, claimant: null, candidates: [P(10, "A", "B", "a@b.com")] });
    expect(v).toMatchObject({ kind: "relinkable", personId: 10 });
  });

  it("the current person holds the SAME email → needs_merge, never a re-link", () => {
    // Already linked correctly. The duplicate is People-vs-People, which
    // estimatedDuplicates already counts and no repair in the product fixes.
    const cur = P(10, "A", "B", "a@b.com");
    const v = classifyPair({ contactId: 1, emailKey: "a@b.com", currentPerson: cur, claimant: null, candidates: [cur] });
    expect(v.kind).toBe("needs_merge");
    expect(v.reason).toContain("already linked correctly");
  });

  it("the current person is this contact's promotion pair → needs_merge", () => {
    // Re-pointing would split the pair prospectPromotion writes, and promotion
    // chooses which contact to REUSE by person_prospect_id.
    const cur = P(20, "Shell", "Record", null, 1);
    const v = classifyPair({ contactId: 1, emailKey: "a@b.com", currentPerson: cur, claimant: cur, candidates: [P(10, "A", "B", "a@b.com")] });
    expect(v.kind).toBe("needs_merge");
    expect(v.reason).toContain("promotion pair");
  });

  it("two People rows hold the address → needs_merge", () => {
    const v = classifyPair({
      contactId: 1, emailKey: "a@b.com", currentPerson: null, claimant: null,
      candidates: [P(10, "A", "B", "a@b.com"), P(11, "A", "B", "a@b.com")],
    });
    expect(v.kind).toBe("needs_merge");
  });

  it("a claimant outranks the email match as the predicted person", () => {
    // upsertPersonForContact's fast path links to whoever already holds
    // linkedContactId, before any matching runs.
    const v = classifyPair({
      contactId: 7, emailKey: "a@b.com", currentPerson: null,
      claimant: P(40, "A", "B", null, 7), candidates: [P(10, "A", "B", "a@b.com")],
    });
    expect(v).toMatchObject({ kind: "unlinked", personId: 40 });
    expect(v.reason).toContain("already claims this contact");
  });
});

describe("the detector reads; the repair is the one matcher", () => {
  const svc = read("server/services/personContactDuplicates.ts");
  const router = read("server/routers/dataHealth.ts");

  it("the service writes nothing at all", () => {
    for (const w of [".insert(", ".update(", ".delete("]) expect(svc, w).not.toContain(w);
  });

  it("the service states its bound in the payload, not in a comment", () => {
    expect(svc).toContain("export const SCAN_CAP");
    expect(svc).toMatch(/capped:/);
  });

  it("the new procedures sit ABOVE the provider-effectiveness slice", () => {
    // roadmapPhase345.test.ts slices from the FIRST occurrence of that symbol
    // to end-of-file and forbids `.insert(` / `.update(` inside it. Anything
    // added below that anchor lands in the forbidden window.
    const anchor = router.indexOf("providerEffectiveness");
    expect(anchor).toBeGreaterThan(-1);
    expect(router.indexOf("personContactDuplicates:")).toBeLessThan(anchor);
    expect(router.indexOf("linkPersonContactPairs:")).toBeLessThan(anchor);
    expect(router.indexOf("relinkAllUnlinked:")).toBeLessThan(anchor);
  });

  it("the read is workspace-scoped and the repairs need at least rep", () => {
    const q = router.slice(router.indexOf("personContactDuplicates:"), router.indexOf("linkPersonContactPairs:"));
    expect(q).toContain("workspaceProcedure.query(");
    const m = router.slice(router.indexOf("linkPersonContactPairs:"), router.indexOf("relinkAllUnlinked:"));
    expect(m).toContain("repProcedure");
    expect(router.slice(router.indexOf("relinkAllUnlinked:"))).toContain("repProcedure");
  });

  it("the repair re-classifies server-side and refuses needs_merge", () => {
    const m = router.slice(router.indexOf("linkPersonContactPairs:"), router.indexOf("relinkAllUnlinked:"));
    expect(m).toContain("findPersonContactDuplicates(");
    expect(m).toContain('pair.kind === "needs_merge"');
    // A `kind` from the client is a stale opinion about a row that may have
    // changed since the page loaded.
    expect(m).not.toContain("input.kind");
  });

  it("the repair goes through upsertPersonForContact, and writes no link itself", () => {
    const m = router.slice(router.indexOf("linkPersonContactPairs:"), router.indexOf("relinkAllUnlinked:"));
    expect(m).toContain("upsertPersonForContact(");
    // Two matchers disagree. The router must not point the link column itself.
    expect(m).not.toContain(".set({ personProspectId");
    // And it must verify it landed where detection predicted rather than
    // reporting success for a link onto some third row.
    expect(m).toContain("result.personId !== pair.personId");
  });

  it("re-pointing an ALREADY-linked contact earns a manager gate", () => {
    const m = router.slice(router.indexOf("linkPersonContactPairs:"), router.indexOf("relinkAllUnlinked:"));
    expect(m).toMatch(/requireMinRole\(ctx\.member\.role, "manager"/);
    expect(m).toContain('p.kind === "relinkable"');
  });

  it("the bulk action is the EXISTING backfill, not a second batch loop", () => {
    const b = router.slice(router.indexOf("relinkAllUnlinked:"));
    expect(b).toContain("linkUnlinkedContacts({ workspaceId:");
  });

  it("the email tier is ordered, so detection can predict which person it picks", () => {
    const src = read("server/services/personLink.ts");
    const tier = src.slice(src.indexOf("const email = usableEmailOrNull(row.email);"), src.indexOf("// (b) LinkedIn identity"));
    expect(tier).toContain(".orderBy(prospects.id)");
  });
});

describe("a detector nobody renders is not a detector", () => {
  const page = read("client/src/pages/usip/DataHealth.tsx");

  it("Data Health queries the procedure and mounts the section", () => {
    expect(page).toContain("personContactDuplicates.useQuery");
    expect(page).toContain("<SplitPeopleSection />");
    expect(page).toContain("linkPersonContactPairs.useMutation");
    expect(page).toContain("relinkAllUnlinked.useMutation");
  });

  it("the duplicate card and the list under it name their tables", () => {
    // Before this, a card labelled "Duplicates" (People) sat directly above a
    // list of duplicate CONTACTS, so merging from the list never moved the
    // number and the page read as broken.
    expect(page).toContain('label="Duplicate People"');
    expect(page).toContain("Duplicate contacts");
  });

  it("deep-links land on the PERSON record", () => {
    expect(page).toContain("/prospects/${p.personId}");
  });

  it("says out loud that linking also merges values into the People row", () => {
    // upsertPersonForContact → upsertPersonForRow runs mergeAll and writes the
    // winners onto the People record with a field-history entry. Copy that
    // calls it a pure link is wrong.
    expect(page).toMatch(/merges the contact’s own values\s+into that record/);
    expect(page).toMatch(/never deletes a row and never merges two People\s+rows/);
  });
});
