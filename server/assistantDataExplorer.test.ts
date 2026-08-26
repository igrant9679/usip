/**
 * The data explorer's safety model is structural — these tests pin the
 * structure, not a mirror of the query logic:
 *
 *  - REGISTRY INTEGRITY: every whitelisted column really belongs to its
 *    entity's table (a copy-paste of the wrong table's column would silently
 *    query the wrong data), no credential/secret-shaped column is exposed,
 *    and no excluded table snuck in.
 *  - WORKSPACE SCOPING: the compiled WHERE of every entity, with and without
 *    model-supplied filters, contains the workspace guard with the caller's
 *    workspace id as its first parameter. This is asserted on the REAL
 *    compiled SQL (drizzle's own dialect), not on source text.
 *  - GATES: unknown entities/columns throw with a helpful message instead of
 *    querying; LIKE values are escaped; dates coerce; caps hold.
 */
import { describe, it, expect } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  EXPLORER_ENTITIES,
  EXPLORER_SPEC,
  buildEntityCatalog,
  compileExplorerQuery,
} from "./services/assistantDataExplorer";

const dialect = new MySqlDialect();
const whereSql = (workspaceId: number, spec: unknown) =>
  dialect.sqlToQuery(compileExplorerQuery(workspaceId, spec).where);

describe("registry integrity", () => {
  it("every whitelisted column belongs to its entity's own table", () => {
    for (const [name, def] of Object.entries(EXPLORER_ENTITIES)) {
      const tableCols = new Set(Object.values(getTableColumns(def.table)));
      for (const [key, col] of Object.entries(def.columns)) {
        expect(tableCols.has(col), `${name}.${key} is not a column of ${getTableName(def.table)}`).toBe(true);
      }
      expect(tableCols.has(def.workspaceCol), `${name}'s workspace column is foreign`).toBe(true);
    }
  });

  it("exposes no secret-shaped columns and no credential tables", () => {
    for (const e of buildEntityCatalog()) {
      for (const c of e.columns) {
        expect(c).not.toMatch(/password|token|secret|apikey|api_key|credential/i);
      }
    }
    const tables = Object.values(EXPLORER_ENTITIES).map((d) => getTableName(d.table));
    for (const forbidden of ["users", "workspace_settings", "sending_accounts", "calendar_accounts", "unipile_accounts", "smtp_configs", "workspace_integrations", "scim_providers"]) {
      expect(tables).not.toContain(forbidden);
    }
  });

  it("audit_log exposes neither ip/userAgent nor the full row payloads", () => {
    const cols = Object.keys(EXPLORER_ENTITIES.audit_log.columns);
    expect(cols).not.toContain("ip");
    expect(cols).not.toContain("userAgent");
    expect(cols).not.toContain("before");
    expect(cols).not.toContain("after");
  });

  it("workspaceId is never itself a queryable column — the guard is the frame, not a filter", () => {
    for (const [name, def] of Object.entries(EXPLORER_ENTITIES)) {
      expect(Object.keys(def.columns), `${name} exposes workspaceId`).not.toContain("workspaceId");
    }
  });
});

describe("workspace scoping — on the compiled SQL", () => {
  it("every entity's bare query is guarded by workspaceId as the first param", () => {
    for (const name of Object.keys(EXPLORER_ENTITIES)) {
      const q = whereSql(7, { entity: name });
      expect(q.sql, name).toContain("`workspaceId` = ?");
      expect(q.params[0], name).toBe(7);
    }
  });

  it("model-supplied filters are ANDed inside the guard, never instead of it", () => {
    const q = whereSql(4, {
      entity: "companies",
      filters: [{ column: "domain", op: "is_null" }, { column: "name", op: "contains", value: "univ" }],
    });
    expect(q.sql).toMatch(/`workspaceId` = \?.*and.*`domain` is null.*and.*`name` like \?/s);
    expect(q.params).toEqual([4, "%univ%"]);
  });

  it("a filter naming another workspace's id cannot widen the query — it only narrows", () => {
    // There is no way to reference workspaceId at all; the nearest imitation
    // (filtering an exposed id column) still sits inside the AND.
    const q = whereSql(4, { entity: "companies", filters: [{ column: "id", op: "eq", value: 999 }] });
    expect(q.sql).toContain("`workspaceId` = ?");
    expect(q.params[0]).toBe(4);
  });
});

describe("gates", () => {
  it("unknown entity throws and names the valid ones", () => {
    expect(() => compileExplorerQuery(1, { entity: "workspace_settings" })).toThrow(/Unknown entity .*Valid entities: /);
    expect(() => compileExplorerQuery(1, { entity: "users" })).toThrow(/Unknown entity/);
  });

  it("unknown column throws — in filters, select, groupBy, and sort alike", () => {
    expect(() => compileExplorerQuery(1, { entity: "people", filters: [{ column: "passwordHash", op: "not_null" }] })).toThrow(/Unknown column/);
    expect(() => compileExplorerQuery(1, { entity: "people", select: ["enrichmentData"] })).toThrow(/Unknown column/);
    expect(() => compileExplorerQuery(1, { entity: "people", groupBy: ["nope"] })).toThrow(/Unknown column/);
    expect(() => compileExplorerQuery(1, { entity: "people", sort: [{ by: "nope" }] })).toThrow(/Cannot sort by/);
  });

  it("LIKE wildcards in user values are escaped — a '%' is data, not a wildcard", () => {
    const q = whereSql(1, { entity: "companies", filters: [{ column: "name", op: "contains", value: "50%_off\\x" }] });
    expect(q.params[1]).toBe("%50\\%\\_off\\\\x%");
  });

  it("contains/starts_with refuse non-text columns", () => {
    expect(() => compileExplorerQuery(1, { entity: "companies", filters: [{ column: "employeeCount", op: "contains", value: "5" }] })).toThrow(/only works on text/);
  });

  it("date columns coerce ISO strings to real dates; garbage throws", () => {
    // The dialect renders the coerced Date in MySQL form — an uncoerced string
    // would pass through verbatim ("2026-08-01T00:00:00Z"), so the reformat IS
    // the evidence of coercion.
    const q = whereSql(1, { entity: "email_log", filters: [{ column: "sentAt", op: "gte", value: "2026-08-01T00:00:00Z" }] });
    expect(q.params[1]).toMatch(/^2026-08-01 \d{2}:00:00/);
    expect(() => compileExplorerQuery(1, { entity: "email_log", filters: [{ column: "sentAt", op: "gte", value: "not a date" }] })).toThrow(/not a valid date/);
  });

  it("value-needing ops without a value throw; in needs an array", () => {
    expect(() => compileExplorerQuery(1, { entity: "people", filters: [{ column: "email", op: "eq" }] })).toThrow(/needs a value/);
    expect(() => compileExplorerQuery(1, { entity: "people", filters: [{ column: "id", op: "in", value: 3 }] })).toThrow(/needs an array/);
  });

  it("limit defaults to 25 and is capped at 100 by the spec", () => {
    expect(compileExplorerQuery(1, { entity: "tasks" }).limit).toBe(25);
    expect(() => EXPLORER_SPEC.parse({ entity: "tasks", limit: 101 })).toThrow();
  });

  it("aggregates: count needs no column, sum does; groupBy without aggregate defaults to count", () => {
    const g = compileExplorerQuery(1, { entity: "email_log", groupBy: ["status"], aggregate: [{ fn: "count" }] });
    expect(g.isAggregate).toBe(true);
    expect(Object.keys(g.fields)).toEqual(["status", "count"]);
    expect(() => compileExplorerQuery(1, { entity: "deals", aggregate: [{ fn: "sum" }] })).toThrow(/needs a column/);
    const d = compileExplorerQuery(1, { entity: "email_log", groupBy: ["status"] });
    expect(Object.keys(d.fields)).toEqual(["status", "count"]);
  });

  it("sorting by an aggregate alias works; duplicate output names throw", () => {
    const q = compileExplorerQuery(1, {
      entity: "email_log", groupBy: ["campaignId"],
      aggregate: [{ fn: "count", as: "sends" }], sort: [{ by: "sends", direction: "desc" }],
    });
    expect(q.orderBy.length).toBe(1);
    expect(() => compileExplorerQuery(1, {
      entity: "email_log", groupBy: ["status"], aggregate: [{ fn: "count", as: "status" }],
    })).toThrow(/Duplicate output name/);
  });
});

describe("catalog", () => {
  it("describes every entity with typed columns, ready for the LLM", () => {
    const cat = buildEntityCatalog();
    expect(cat.length).toBe(Object.keys(EXPLORER_ENTITIES).length);
    const companies = cat.find((e) => e.entity === "companies")!;
    expect(companies.columns).toContain("domain:string");
    expect(companies.description.length).toBeGreaterThan(10);
  });
});
