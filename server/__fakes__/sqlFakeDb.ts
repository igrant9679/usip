/**
 * A tiny in-memory database for router tests, shared by the Research tests.
 *
 * It renders each drizzle condition with MySqlDialect and evaluates the SQL
 * that produced, so a missing `workspaceId = ?` is a row that leaks, not a
 * condition object that merely looks right. It understands only what the
 * routers under test write: ANDs (and one level of OR) of =, <>, <, >, <=, >=,
 * IS NULL, IN and NOT IN, column-to-column equality in (inner and left) joins, ORDER BY a column,
 * LIMIT, GROUP BY with count(*), and `col + n` or `COALESCE(col, NOW() | ?)` in an UPDATE. Anything else
 * throws, naming the clause, so a test never passes on SQL it did not read.
 *
 * Membership: by default the caller's role comes from `roles` and every
 * workspace_members read answers for "the caller". With `realMembers`,
 * workspace_members is an ordinary table — seed it (and `workspaces`) and
 * the real resolveWorkspace runs against the rows, invite tokens and all.
 * Raw `db.execute` statements are recorded in `executed`, not run.
 *
 * Test-only: nothing in the app imports it.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Column, getTableColumns, getTableName, is, SQL, Table } from "drizzle-orm";
import { workspaceMembers } from "../../drizzle/schema";

type Row = Record<string, any>;
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as SQL);

export type SqlFakeDb = ReturnType<typeof makeSqlFakeDb>;

export function makeSqlFakeDb(opts: {
  /** Workspace id → the caller's role there. Ignored with `realMembers`. */
  roles?: Record<number, string>;
  /** The workspace the current request is for. Ignored with `realMembers`. */
  wsId?: () => number;
  /** Treat workspace_members as a seeded table instead of answering for the caller. */
  realMembers?: boolean;
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
    if ((m = clause.match(new RegExp(`^${REF} <= \\?$`)))) { const v = lookup(ctx, m[1]); const p = params[pi.i++]; return v != null && cmp(v, p) <= 0; }
    if ((m = clause.match(new RegExp(`^${REF} >= \\?$`)))) { const v = lookup(ctx, m[1]); const p = params[pi.i++]; return v != null && cmp(v, p) >= 0; }
    if ((m = clause.match(new RegExp(`^${REF} is null$`)))) return lookup(ctx, m[1]) == null;
    if ((m = clause.match(new RegExp(`^${REF} is not null$`)))) return lookup(ctx, m[1]) != null;
    if ((m = clause.match(new RegExp(`^${REF} in \\(([?, ]+)\\)$`)))) {
      const n = (m[2].match(/\?/g) ?? []).length;
      const set = params.slice(pi.i, pi.i + n);
      pi.i += n;
      return set.some((p) => same(p, lookup(ctx, m![1])));
    }
    if ((m = clause.match(new RegExp(`^${REF} not in \\(([?, ]+)\\)$`)))) {
      const n = (m[2].match(/\?/g) ?? []).length;
      const set = params.slice(pi.i, pi.i + n);
      pi.i += n;
      const v = lookup(ctx, m[1]);
      return v != null && !set.some((p) => same(p, v));
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
    const st: { table?: any; joins: { table: any; on: unknown; left?: boolean }[]; where?: unknown; group?: Column[]; order: unknown[]; limit?: number; offset?: number } = { order: [], joins: [] };
    const run = (): Row[] => {
      const name = getTableName(st.table);
      if (st.table === workspaceMembers && !opts.realMembers) {
        const ws = opts.wsId!();
        const role = opts.roles![ws];
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
      for (const join of st.joins) {
        const other = rowsOf(getTableName(join.table));
        ctxs = ctxs.flatMap((c) => {
          const hits = other.map((o) => ({ row: c.row, q: { ...c.q, ...qualify(join.table, o) } })).filter((x) => matches(join.on, x.q));
          // LEFT JOIN keeps the row, with the joined table's columns NULL.
          return hits.length || !join.left ? hits : [{ row: c.row, q: { ...c.q, ...qualify(join.table, {}) } }];
        });
      }
      ctxs = ctxs.filter((c) => matches(st.where, c.q));
      for (const o of st.order.slice().reverse()) {
        // A bare column orders ascending, as in SQL.
        const m = is(o, Column)
          ? ([, `\`${getTableName((o as any).table)}\`.\`${(o as Column).name}\``, "asc"] as const)
          : render(o).sql.match(/^(`\w+`\.`\w+`) (asc|desc)$/);
        if (!m) continue;
        ctxs.sort((a, b) => {
          const d = cmp(lookup(a.q, m[1]), lookup(b.q, m[1]));
          return m[2] === "desc" ? -d : d;
        });
      }
      const pick = (q: Row, v: unknown): unknown => {
        if (is(v, Column)) return q[`${getTableName((v as any).table)}.${(v as Column).name}`];
        // A whole table as a projection value, e.g. `{ ws: workspaces, mb: workspaceMembers }`.
        if (is(v, Table)) {
          const n = getTableName(v as any);
          const out: Row = {};
          for (const [k, col] of Object.entries(getTableColumns(v as any))) out[k] = q[`${n}.${(col as Column).name}`];
          return out;
        }
        return undefined;
      };
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
      } else if (projection && Object.values(projection).some((v) => is(v, SQL))) {
        // An aggregate with no GROUP BY (`select({ c: count() })`): one row.
        const r: Row = {};
        for (const [k, v] of Object.entries(projection)) r[k] = is(v, SQL) ? ctxs.length : pick(ctxs[0]?.q ?? {}, v);
        out = [r];
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
      innerJoin(t: unknown, on: unknown) { st.joins.push({ table: t, on }); return b; },
      leftJoin(t: unknown, on: unknown) { st.joins.push({ table: t, on, left: true }); return b; },
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
        // Past every seeded id too, so an insert never collides with a row a test put there.
        const id = Math.max(seq.get(name) ?? 0, ...rowsOf(name).map((r) => Number(r.id) || 0)) + 1;
        seq.set(name, id);
        const row: Row = {};
        for (const k of Object.keys(getTableColumns(table))) row[k] = null;
        Object.assign(row, { createdAt: new Date(), updatedAt: new Date(), savedAt: new Date() }, v, { id });
        rowsOf(name).push(row);
        return row;
      });
    };
    const chain: any = {
      // INSERT IGNORE: a duplicate is the caller's concern here; the fake keeps every row.
      ignore() { return chain; },
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
                    // COALESCE(col, NOW()) / COALESCE(col, ?): keep a value that is there.
                    const q = render(v);
                    const co = q.sql.match(/^COALESCE\((`\w+`\.`\w+`), (NOW\(\)|\?)\)$/i);
                    if (co) {
                      const cur = lookup(qualify(table, r), co[1]);
                      r[k] = cur ?? (co[2] === "?" ? q.params[0] : new Date());
                      continue;
                    }
                    const m = q.sql.match(/`(\w+)` \+ (\d+)$/);
                    if (!m) throw new Error(`fake db: unsupported SET ${render(v).sql}`);
                    // The SQL names the DB column (session_version); the row is
                    // keyed by the JS name (sessionVersion).
                    const src = Object.entries(getTableColumns(table)).find(([, c]) => (c as Column).name === m[1])?.[0] ?? m[1];
                    r[k] = Number(r[src] ?? 0) + Number(m[2]);
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

  const executed: string[] = [];
  const execute = (q: unknown) => {
    executed.push(render(q).sql);
    return Promise.resolve([[]]);
  };

  return { select, insert, update, delete: del, execute, executed, tables, rowsOf };
}
