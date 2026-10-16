/**
 * A tiny in-memory database for router tests, shared by the Research tests.
 *
 * It renders each drizzle condition with MySqlDialect and evaluates the SQL
 * that produced, so a missing `workspaceId = ?` is a row that leaks, not a
 * condition object that merely looks right. It understands only what the
 * routers under test write: ANDs (and one level of OR) of =, <>, <, >,
 * IS NULL and IN, column-to-column equality in joins, ORDER BY a column,
 * LIMIT, GROUP BY with count(*), and `col + n` in an UPDATE. Anything else
 * throws, naming the clause, so a test never passes on SQL it did not read.
 *
 * Test-only: nothing in the app imports it.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Column, getTableColumns, getTableName, is, SQL } from "drizzle-orm";
import { workspaceMembers } from "../../drizzle/schema";

type Row = Record<string, any>;
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as SQL);

export type SqlFakeDb = ReturnType<typeof makeSqlFakeDb>;

export function makeSqlFakeDb(opts: {
  /** Workspace id → the caller's role there. */
  roles: Record<number, string>;
  /** The workspace the current request is for. */
  wsId: () => number;
  /** Runs before every UPDATE is applied, to simulate a racing write. */
  beforeUpdate?: (table: string) => void;
}) {
  const tables = new Map<string, Row[]>();
  const seq = new Map<string, number>();
  const rowsOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const qualify = (table: any, row: Row): Row => {
    const n = getTableName(table);
    const out: Row = {};
    for (const [k, col] of Object.entries(getTableColumns(table))) out[`${n}.${(col as Column).name}`] = row[k];
    return out;
  };
  const lookup = (ctx: Row, ref: string) => {
    const q = ref.match(/^`(\w+)`\.`(\w+)`$/);
    if (q) return ctx[`${q[1]}.${q[2]}`];
    const u = ref.match(/^`(\w+)`$/);
    if (u) {
      const key = Object.keys(ctx).find((k) => k.endsWith(`.${u[1]}`));
      if (key) return ctx[key];
    }
    throw new Error(`fake db: cannot read ${ref}`);
  };
  /** Dates (objects or "YYYY-MM-DD hh:mm:ss" strings) compare as times; numeric strings as numbers. */
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) return new Date(v.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z")).getTime();
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    return v;
  };
  const same = (a: unknown, b: unknown) => {
    const x = norm(a), y = norm(b);
    return x === y || (x != null && y != null && String(x) === String(y));
  };
  const cmp = (a: unknown, b: unknown) => {
    const x = norm(a) as any, y = norm(b) as any;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const REF = "(`\\w+`(?:\\.`\\w+`)?)";
  const evalClause = (clause: string, ctx: Row, params: unknown[], pi: { i: number }): boolean => {
    let m: RegExpMatchArray | null;
    if (clause.startsWith("(") && clause.endsWith(")") && clause.includes(" or ")) {
      const parts = clause.slice(1, -1).split(" or ").map((c) => c.trim());
      let any = false;
      for (const p of parts) if (evalClause(p, ctx, params, pi)) any = true; // every part consumes its params
      return any;
    }
    if ((m = clause.match(new RegExp(`^${REF} = \\?$`)))) return same(lookup(ctx, m[1]), params[pi.i++]);
    if ((m = clause.match(new RegExp(`^${REF} <> \\?$`)))) return !same(lookup(ctx, m[1]), params[pi.i++]);
    if ((m = clause.match(new RegExp(`^${REF} = ${REF}$`)))) return same(lookup(ctx, m[1]), lookup(ctx, m[2]));
    if ((m = clause.match(new RegExp(`^${REF} < \\?$`)))) return cmp(lookup(ctx, m[1]), params[pi.i++]) < 0;
    if ((m = clause.match(new RegExp(`^${REF} > \\?$`)))) return cmp(lookup(ctx, m[1]), params[pi.i++]) > 0;
    if ((m = clause.match(new RegExp(`^${REF} is null$`)))) return lookup(ctx, m[1]) == null;
    if ((m = clause.match(new RegExp(`^${REF} is not null$`)))) return lookup(ctx, m[1]) != null;
    if ((m = clause.match(new RegExp(`^${REF} in \\(([?, ]+)\\)$`)))) {
      const n = (m[2].match(/\?/g) ?? []).length;
      const set = params.slice(pi.i, pi.i + n);
      pi.i += n;
      return set.some((p) => same(p, lookup(ctx, m![1])));
    }
    throw new Error(`fake db: unsupported clause "${clause}"`);
  };
  const matches = (cond: unknown, ctx: Row): boolean => {
    if (!cond) return true;
    const { sql, params } = render(cond);
    let s = sql.trim();
    // Strip the outer AND group's parentheses only (not an OR group's).
    if (s.startsWith("(") && s.endsWith(")") && !/^\([^()]* or [^()]*\)$/.test(s)) s = s.slice(1, -1).trim();
    const pi = { i: 0 };
    // Split on top-level " and " only.
    const clauses: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (depth === 0 && s.startsWith(" and ", i)) { clauses.push(s.slice(start, i).trim()); start = i + 5; }
    }
    clauses.push(s.slice(start).trim());
    let ok = true;
    for (const c of clauses) if (!evalClause(c, ctx, params, pi)) ok = false; // keep consuming params
    return ok;
  };

  const select = (projection?: Record<string, unknown>) => {
    const st: { table?: any; join?: { table: any; on: unknown }; where?: unknown; group?: Column[]; order: unknown[]; limit?: number; offset?: number } = { order: [] };
    const run = (): Row[] => {
      const name = getTableName(st.table);
      if (st.table === workspaceMembers) {
        const ws = opts.wsId();
        const role = opts.roles[ws];
        if (!role) return [];
        if (projection && "ws" in projection) {
          return [{
            ws: { id: ws, name: `WS ${ws}`, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: ws, role, deactivatedAt: null, lastActiveAt: new Date() },
          }];
        }
        return [{ id: 1 }];
      }
      let ctxs = rowsOf(name).map((r) => ({ row: r, q: qualify(st.table, r) }));
      if (st.join) {
        const other = rowsOf(getTableName(st.join.table));
        ctxs = ctxs.flatMap((c) => other.map((o) => ({ row: c.row, q: { ...c.q, ...qualify(st.join!.table, o) } })).filter((x) => matches(st.join!.on, x.q)));
      }
      ctxs = ctxs.filter((c) => matches(st.where, c.q));
      for (const o of st.order.slice().reverse()) {
        const m = render(o).sql.match(/^(`\w+`\.`\w+`) (asc|desc)$/);
        if (!m) continue;
        ctxs.sort((a, b) => {
          const d = cmp(lookup(a.q, m[1]), lookup(b.q, m[1]));
          return m[2] === "desc" ? -d : d;
        });
      }
      const pick = (q: Row, v: unknown) => (is(v, Column) ? q[`${getTableName((v as any).table)}.${(v as Column).name}`] : undefined);
      let out: Row[];
      if (st.group) {
        const groups = new Map<string, Row[]>();
        for (const c of ctxs) {
          const key = JSON.stringify(st.group.map((g) => pick(c.q, g)));
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(c.q);
        }
        out = Array.from(groups.values()).map((qs) => {
          const r: Row = {};
          for (const [k, v] of Object.entries(projection ?? {})) r[k] = is(v, SQL) ? qs.length : pick(qs[0], v);
          return r;
        });
      } else if (projection) {
        out = ctxs.map((c) => {
          const r: Row = {};
          for (const [k, v] of Object.entries(projection)) r[k] = pick(c.q, v);
          return r;
        });
      } else {
        out = ctxs.map((c) => ({ ...c.row }));
      }
      const from = st.offset ?? 0;
      return st.limit != null ? out.slice(from, from + st.limit) : out.slice(from);
    };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown, on: unknown) { st.join = { table: t, on }; return b; },
      where(c: unknown) { st.where = c; return b; },
      groupBy(...cols: Column[]) { st.group = cols; return b; },
      orderBy(...o: unknown[]) { st.order = o; return b; },
      limit(n: number) { st.limit = n; return b; },
      offset(n: number) { st.offset = n; return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) { try { res(run()); } catch (e) { rej(e); } },
      catch(rej: (e: unknown) => void) { return Promise.resolve().then(run).catch(rej); },
    };
    return b;
  };

  const insert = (table: any) => {
    const name = getTableName(table);
    let inserted: Row[] = [];
    const doInsert = (values: Row | Row[]) => {
      inserted = (Array.isArray(values) ? values : [values]).map((v) => {
        const id = (seq.get(name) ?? 0) + 1;
        seq.set(name, id);
        const row: Row = {};
        for (const k of Object.keys(getTableColumns(table))) row[k] = null;
        Object.assign(row, { createdAt: new Date(), updatedAt: new Date(), savedAt: new Date() }, v, { id });
        rowsOf(name).push(row);
        return row;
      });
    };
    const chain: any = {
      values(v: Row | Row[]) { doInsert(v); return chain; },
      $returningId() { return Promise.resolve(inserted.map((r) => ({ id: r.id }))); },
      then(res: (v: unknown) => void) { res([{ affectedRows: inserted.length, insertId: inserted[0]?.id }]); },
    };
    return chain;
  };

  const update = (table: any) => {
    const name = getTableName(table);
    let values: Row = {};
    const chain: any = {
      set(v: Row) { values = v; return chain; },
      where(cond: unknown) {
        const out = {
          catch(rej: (e: unknown) => void) { return new Promise((res) => out.then(res, rej)).catch(rej); },
          then(res: (v: unknown) => void, rej: (e: unknown) => void) {
            try {
              opts.beforeUpdate?.(name);
              let n = 0;
              for (const r of rowsOf(name)) {
                if (!matches(cond, qualify(table, r))) continue;
                for (const [k, v] of Object.entries(values)) {
                  if (is(v, SQL)) {
                    const m = render(v).sql.match(/`(\w+)` \+ (\d+)$/);
                    if (!m) throw new Error(`fake db: unsupported SET ${render(v).sql}`);
                    r[k] = Number(r[m[1]]) + Number(m[2]);
                  } else r[k] = v;
                }
                r.updatedAt = new Date();
                n++;
              }
              res([{ affectedRows: n }]);
            } catch (e) { rej(e); }
          },
        };
        return out;
      },
    };
    return chain;
  };

  const del = (table: any) => ({
    where(cond: unknown) {
      return {
        then(res: (v: unknown) => void) {
          const name = getTableName(table);
          const before = rowsOf(name);
          const keep = before.filter((r) => !matches(cond, qualify(table, r)));
          tables.set(name, keep);
          res([{ affectedRows: before.length - keep.length }]);
        },
      };
    },
  });

  return { select, insert, update, delete: del, tables, rowsOf };
}
