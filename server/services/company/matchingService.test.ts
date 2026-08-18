/**
 * Company matcher — the three rules layered on the spec after the 2026-08-13
 * association run split one org into six accounts (owner directive: "you
 * must fall back on the person's LinkedIn for their attached company record").
 *
 *  1. A mailbox domain recognises (+35) but never conflicts and never stands
 *     in for a missing company domain.
 *  2. Exact normalized name with nothing contradicting it is at least a
 *     possible match — the alternative is a second account with that name.
 *  3. Archived accounts are never candidates. The association undo ARCHIVES
 *     the accounts a bad run created, and they keep their wrong domains; a
 *     matcher that saw them would re-link people to exactly what was undone.
 *
 * Scoring is exercised through the real `scoreCompanyMatch`/`bucket`. The
 * archived filter is proved from the SQL text of every accounts query the
 * finder issues, captured through a fake db and rendered by MySqlDialect —
 * the same approach as companyDuplicates.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { accounts, accountDomains } from "../../../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../../db", async (importActual) => ({
  ...(await importActual<typeof import("../../db")>()),
  getDb: async () => h.db,
}));

import { scoreCompanyMatch, bucket, findWorkspaceAccountMatch } from "./matchingService";
import { normalizeCompanyName } from "./normalize";

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

// An account row carries whatever the normalizer produced at insert time.
const takoma = { normalizedName: normalizeCompanyName("Takoma Children's School"), normalizedDomain: "takomachildren.org", domain: "takomachildren.org" };

describe("a mailbox domain recognises but never conflicts", () => {
  it("scores +35 when it matches the candidate's domain, on top of the name", () => {
    const s = scoreCompanyMatch({ name: "Takoma Children's School", emailDomain: "takomachildren.org" }, takoma);
    expect(s.reasons).toContain("email domain (+35)");
    expect(s.reasons).toContain("exact name (+50)");
    expect(s.score).toBe(85);
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("high_confidence");
  });

  it("is silent when it differs — a parent's dc.gov mailbox does not veto the school", () => {
    const s = scoreCompanyMatch({ name: "Takoma Children's School", emailDomain: "dc.gov" }, takoma);
    expect(s.conflict).toBe(false);
    expect(s.reasons.join(" ")).not.toContain("conflicting domain");
    expect(s.reasons.join(" ")).not.toContain("exact domain");
    expect(s.score).toBe(50);
  });

  it("does not stand in for a missing company domain (no +100 from the mailbox alone)", () => {
    // Name differs, mailbox matches: recognition is worth 35, not an auto-link.
    const s = scoreCompanyMatch({ name: "DC Public Schools", emailDomain: "takomachildren.org" }, takoma);
    expect(s.score).toBe(35);
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("no_match");
  });

  it("a COMPANY domain that differs is still a real conflict", () => {
    const s = scoreCompanyMatch({ name: "Takoma Children's School", domain: "takoma.edu" }, takoma);
    expect(s.conflict).toBe(true);
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("conflict");
  });
});

describe("an unverified account domain cannot veto a name match (owner decision 2026-08-18)", () => {
  // Triumph Academy: people at triumphyouthservices.com, account holding an
  // unverified Brandfetch name-adopt guess triumphacademy.com.au.
  const triumph = { normalizedName: "triumph academy", normalizedDomain: "triumphacademy.com.au", domain: "triumphacademy.com.au" };

  it("differing domain vs an UNVERIFIED, un-pinned account domain: no conflict, name links (needs_review)", () => {
    const s = scoreCompanyMatch({ name: "Triumph Academy", domain: "triumphyouthservices.com" }, { ...triumph, brandVerifiedAt: null, brandOverride: null });
    expect(s.conflict).toBe(false);
    expect(s.score).toBe(50);
    expect(s.reasons.join(" ")).toContain("unverified account domain triumphacademy.com.au (no veto)");
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("possible_match");
  });

  it("differing domain vs a brand-VERIFIED account domain still conflicts", () => {
    const s = scoreCompanyMatch({ name: "Triumph Academy", domain: "triumphyouthservices.com" }, { ...triumph, brandVerifiedAt: new Date("2026-08-01"), brandOverride: null });
    expect(s.conflict).toBe(true);
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("conflict");
  });

  it("differing domain vs a human-pinned (override) domain still conflicts", () => {
    const s = scoreCompanyMatch({ name: "Triumph Academy", domain: "triumphyouthservices.com" }, { ...triumph, brandVerifiedAt: null, brandOverride: { domain: "triumphacademy.com.au" } });
    expect(s.conflict).toBe(true);
  });

  it("a candidate that does not carry the verification field at all keeps the strict rule (global orgs)", () => {
    const s = scoreCompanyMatch({ name: "Triumph Academy", domain: "triumphyouthservices.com" }, triumph);
    expect(s.conflict).toBe(true);
  });
});

describe("exact name with nothing against it is a possible match, not a duplicate", () => {
  it("floors an exact-name-only score into possible_match", () => {
    const s = scoreCompanyMatch({ name: "Fiserv" }, { normalizedName: "fiserv", normalizedDomain: "fiserv.com" });
    expect(s.score).toBe(50);
    expect(s.exactName).toBe(true);
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("possible_match");
  });

  it("does not floor a fuzzy-only match — those may be different companies", () => {
    const s = scoreCompanyMatch({ name: "Community Foundation of Boston" }, { normalizedName: "community foundation of austin" });
    expect(s.exactName).toBe(false);
    expect(s.score).toBe(35);
    expect(bucket(s.score, s.conflict, s.exactName)).toBe("no_match");
  });

  it("does not floor past a conflict", () => {
    expect(bucket(0, true, true)).toBe("conflict");
  });

  it("leaves the spec bands alone above the floor", () => {
    expect(bucket(150, false, true)).toBe("exact_match");
    expect(bucket(85, false, false)).toBe("high_confidence");
    expect(bucket(70, false, false)).toBe("possible_match");
    expect(bucket(64, false, false)).toBe("no_match");
  });
});

describe("findWorkspaceAccountMatch never sees archived accounts", () => {
  function fakeDb(rows: unknown[], wheres: string[]) {
    const builder = () => {
      const st: { table?: unknown } = {};
      const b: any = {
        from(t: unknown) { st.table = t; return b; },
        where(cond: unknown) {
          if (st.table === accounts) wheres.push(render(cond).sql);
          return b;
        },
        limit() { return b; },
        then(res: (v: unknown) => void) {
          if (st.table === accounts) res(rows);
          else if (st.table === accountDomains) res([]);
          else res([]);
        },
      };
      return b;
    };
    return { select: () => builder() };
  }

  it("filters archived_at IS NULL on every accounts lookup (domain, mailbox, name)", async () => {
    const wheres: string[] = [];
    h.db = fakeDb([], wheres);
    await findWorkspaceAccountMatch(7, { name: "Takoma Children's School", domain: "takomachildren.org", emailDomain: "dc.gov" });
    // Company domain, mailbox domain and name each issue an accounts query.
    expect(wheres.length).toBeGreaterThanOrEqual(3);
    for (const sql of wheres) {
      expect(sql).toContain("`accounts`.`workspaceId` = ?");
      expect(sql).toContain("`accounts`.`archived_at` is null");
    }
  });

  it("still finds the account that owns the mailbox domain (recognition), scored as such", async () => {
    const wheres: string[] = [];
    // The only account in the workspace owns dc.gov. Name differs.
    h.db = fakeDb([{ id: 9, normalizedName: "dc government", normalizedDomain: "dc.gov", domain: "dc.gov", globalOrganizationId: null }], wheres);
    const m = await findWorkspaceAccountMatch(7, { name: "Takoma Children's School", emailDomain: "dc.gov" });
    expect(m.accountId).toBe(9);
    expect(m.score).toBe(35);
    expect(m.confidence).toBe("no_match"); // recognised, not linked
    expect(m.conflict).toBe(false);
  });
});
