/**
 * prospects.fieldHistory — first reader of the 0156 audit table, against the
 * REAL procedure via `appRouter.createCaller` (if it isn't imported, it isn't
 * tested — see dangerZone.test.ts for the cautionary tale).
 *
 * The fake db doesn't interpret drizzle conditions, so instead of trusting
 * structure we render the captured `.where()` / `.orderBy()` arguments to SQL
 * text with the real MySqlDialect and assert on that. Deleting the
 * workspaceId scope, the prospectId filter, or the DESC ordering each turns a
 * test red; a deep object-walk could not promise that (a column's `.table`
 * back-reference reaches every sibling column, so "the workspaceId column is
 * somewhere in the tree" is true even for an unscoped query).
 *
 * What this file cannot see: nothing here proves migration 0156 applied on
 * prod — the proof remains the section rendering rows on a live prospect.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { prospectFieldHistory } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const WS = { id: 7, name: "Acme Corp" };

interface Captured {
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}

/**
 * Two query shapes reach this fake: the workspaceProcedure middleware's
 * membership resolution (identified by `.innerJoin()`) and the history select
 * itself (identified by the real table object). Anything else throws rather
 * than defaulting to [] — an empty result is meaningful in the assertions.
 */
function makeDb(rows: unknown[], cap: Captured) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where(cond: unknown) { if (st.table === prospectFieldHistory) cap.where = cond; return b; },
      orderBy(...args: unknown[]) { if (st.table === prospectFieldHistory) cap.orderBy = args; return b; },
      limit(n: number) { if (st.table === prospectFieldHistory) cap.limit = n; return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          // lastActiveAt is fresh so the middleware's touch-update never fires.
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role: "rep", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === prospectFieldHistory) {
          res(rows);
        } else {
          rej(new Error(`fake db: unscripted select from ${String((st.table as any)?.[Symbol.for("drizzle:Name")] ?? st.table)}`));
        }
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

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

describe("prospects.fieldHistory", () => {
  it("returns the rows, scoped to workspace + prospect, newest first, capped", async () => {
    const rows = [
      { id: 2, workspaceId: WS.id, prospectId: 42, field: "email", oldValue: "info@x.com", newValue: "jane@x.com", oldSource: "scrape_found", newSource: "quickenrich", newConfidence: 90, trigger: "comprehensive_pass", changedAt: new Date("2026-08-11T10:00:00Z") },
      { id: 1, workspaceId: WS.id, prospectId: 42, field: "company", oldValue: null, newValue: "Xco", oldSource: null, newSource: "linkedin_profile", newConfidence: 85, trigger: "manual_refresh", changedAt: new Date("2026-08-10T10:00:00Z") },
    ];
    const cap: Captured = {};
    h.db = makeDb(rows, cap);

    const out = await appRouter.createCaller(makeCtx()).prospects.fieldHistory({ prospectId: 42 });
    expect(out).toEqual(rows);

    const where = render(cap.where);
    expect(where.sql).toContain("`prospect_field_history`.`workspaceId` = ?");
    expect(where.sql).toContain("`prospect_field_history`.`prospect_id` = ?");
    // The workspace comes from the MIDDLEWARE-resolved membership, not input.
    expect(where.params).toEqual([WS.id, 42]);

    expect(cap.orderBy).toHaveLength(2);
    const primary = render(cap.orderBy![0]);
    expect(primary.sql).toContain("`changed_at`");
    expect(primary.sql.toLowerCase()).toContain("desc");
    // Same-timestamp rows (one enrichment pass writes many) tiebreak on id.
    const tiebreak = render(cap.orderBy![1]);
    expect(tiebreak.sql).toContain("`id`");
    expect(tiebreak.sql.toLowerCase()).toContain("desc");

    expect(cap.limit).toBe(100);
  });
});

describe("consumer wiring (the dead-wiring check: a reader nobody renders is not a reader)", () => {
  const people = fs.readFileSync(path.join(__dirname, "..", "client", "src", "pages", "usip", "People.tsx"), "utf8");
  it("the People drawer calls the procedure by its registered name", () => {
    // Name-match at the seam: the caller test above proves the server side of
    // this exact path exists; this proves the client dials the same number.
    expect(people).toContain("trpc.prospects.fieldHistory.useQuery");
  });
  it("…and mounts the section that renders it", () => {
    expect(people).toContain("<FieldHistorySection prospectId={p.id} />");
  });
});
