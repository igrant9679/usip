/**
 * Raw-SQL migration runner.
 *
 * Why this exists:
 *   The Drizzle journal (`drizzle/meta/_journal.json`) was frozen at migration
 *   0047, but several newer SQL files (0048..0053) were committed without
 *   matching journal/snapshot entries. As a result, `drizzle-kit migrate`
 *   silently skipped them on production and the corresponding schema changes
 *   never landed. That broke Tour Builder (`tours.pageKey` missing), Guided
 *   Tours, and parts of the Help Center.
 *
 * What it does:
 *   1. Connects to MySQL via `DATABASE_URL`.
 *   2. Ensures a `__manus_migrations__` tracking table exists.
 *   3. Reads every `*.sql` file in the `drizzle/` directory (sorted by name).
 *   4. Skips any file already recorded as applied.
 *   5. Executes the SQL, tolerating "already exists" errors so that prod
 *      databases that have been partially migrated by hand are healed
 *      idempotently rather than erroring out.
 *   6. Records each file as applied on success.
 *
 * Safe to run on every startup. Designed to never crash the server: if any
 * unexpected failure occurs the error is logged and execution continues.
 */
import fs from "fs";
import path from "path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
const TRACKING_TABLE = "__manus_migrations__";
// MySQL error codes we treat as "already-applied" and silently skip.
// 1050: ER_TABLE_EXISTS_ERROR
// 1060: ER_DUP_FIELDNAME (column already exists)
// 1061: ER_DUP_KEYNAME    (index already exists)
// 1091: ER_CANT_DROP_FIELD_OR_KEY (drop missing thing)
// 1146: ER_NO_SUCH_TABLE  (table missing on a DROP)
// 1826: ER_FK_DUP_NAME    (foreign key already exists)
const TOLERATED_ERRNOS = new Set([1050, 1060, 1061, 1091, 1146, 1826]);
function findDrizzleDir(): string | null {
  // Try a few resolutions because the runtime CWD may vary
  // (Railway: /app, local dev: repo root, esbuild output: dist/).
  const candidates = [
    path.resolve(process.cwd(), "drizzle"),
    path.resolve(process.cwd(), "..", "drizzle"),
    path.resolve(__dirname, "..", "..", "drizzle"),
    path.resolve(__dirname, "..", "..", "..", "drizzle"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {
      // ignore
    }
  }
  return null;
}
function splitStatements(sql: string): string[] {
  // Drizzle migration files use `--> statement-breakpoint` markers. Split on
  // those first; if absent, fall back to splitting on `;` at end of line.
  if (sql.includes("--> statement-breakpoint")) {
    return sql
      .split(/-->\s*statement-breakpoint/gi)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // Strip line comments, then split on `;` (naïve but adequate for our
  // hand-written migration files which contain no `;` inside string literals).
  const noLineComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return noLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
async function ensureTrackingTable(conn: Connection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS \`${TRACKING_TABLE}\` (
       \`name\` VARCHAR(255) NOT NULL PRIMARY KEY,
       \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
}
/**
 * If our tracking table is empty but Drizzle's own `__drizzle_migrations`
 * table exists with N entries, seed our tracking table by recording the
 * first N `*.sql` files (sorted) as already applied. This prevents the raw
 * runner from re-executing migrations that Drizzle already ran successfully.
 */
async function seedFromDrizzleJournalIfNeeded(
  conn: Connection,
  allFiles: string[],
): Promise<void> {
  type CountRow = RowDataPacket & { c: number };
  // Only seed when our tracking table is empty.
  const [countRows] = await conn.query<CountRow[]>(
    `SELECT COUNT(*) AS c FROM \`${TRACKING_TABLE}\``,
  );
  const ourCount = Number(countRows[0]?.c ?? 0);
  if (ourCount > 0) return;
  // Look for Drizzle's tracking table. Drizzle MySQL uses
  // `__drizzle_migrations` in the same database by default.
  let drizzleCount = 0;
  try {
    const [drows] = await conn.query<CountRow[]>(
      "SELECT COUNT(*) AS c FROM `__drizzle_migrations`",
    );
    drizzleCount = Number(drows[0]?.c ?? 0);
  } catch {
    // Drizzle table not present; nothing to seed from.
    return;
  }
  if (drizzleCount <= 0) return;
  // Mark the first `drizzleCount` SQL files (in numeric/lexicographic order)
  // as already applied. This matches how Drizzle tracks migrations by index.
  const toSeed = allFiles.slice(0, drizzleCount);
  for (const name of toSeed) {
    await markApplied(conn, name);
  }
  console.log(
    `[RawMigrations] seeded ${toSeed.length} previously-applied migrations from __drizzle_migrations`,
  );
}
async function getAppliedSet(conn: Connection): Promise<Set<string>> {
  type Row = RowDataPacket & { name: string };
  const [rows] = await conn.query<Row[]>(
    `SELECT \`name\` FROM \`${TRACKING_TABLE}\``,
  );
  const applied = new Set<string>();
  for (const r of rows) applied.add(r.name);
  return applied;
}
async function markApplied(conn: Connection, name: string): Promise<void> {
  await conn.query(
    `INSERT IGNORE INTO \`${TRACKING_TABLE}\` (\`name\`) VALUES (?)`,
    [name],
  );
}
async function applyOneFile(conn: Connection, file: string, sql: string): Promise<void> {
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    try {
      await conn.query(stmt);
    } catch (err: unknown) {
      const code = (err as { errno?: number }).errno;
      if (code !== undefined && TOLERATED_ERRNOS.has(code)) {
        // Already-applied piece (e.g., column already added) — skip silently.
        continue;
      }
      // Re-throw with context so the caller can decide what to do.
      const msg = (err as Error)?.message ?? String(err);
      throw new Error(`[${file}] ${msg} (errno=${code ?? "n/a"})`);
    }
  }
}
/**
 * Public entry point. Call this once at server startup.
 * Always returns; never throws (errors are logged).
 */
export async function runRawMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("[RawMigrations] DATABASE_URL not set — skipping");
    return;
  }
  const dir = findDrizzleDir();
  if (!dir) {
    console.warn("[RawMigrations] drizzle/ directory not found — skipping");
    return;
  }
  let conn: Connection | null = null;
  try {
    // multipleStatements:true is intentionally NOT enabled. We split into
    // single statements ourselves so error handling is granular.
    conn = await mysql.createConnection({
      uri: process.env.DATABASE_URL,
      multipleStatements: false,
    });
    await ensureTrackingTable(conn);
    const allFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // lexicographic = numeric prefix order
    // First-run: import Drizzle's existing journal so we don't re-execute
    // migrations that Drizzle already applied successfully (0000-0047).
    await seedFromDrizzleJournalIfNeeded(conn, allFiles);
    const applied = await getAppliedSet(conn);
    let newlyApplied = 0;
    let skipped = 0;
    for (const file of allFiles) {
      if (applied.has(file)) {
        skipped++;
        continue;
      }
      const full = path.join(dir, file);
      const sql = fs.readFileSync(full, "utf8");
      try {
        await applyOneFile(conn, file, sql);
        await markApplied(conn, file);
        newlyApplied++;
        console.log(`[RawMigrations] applied ${file}`);
      } catch (err) {
        // Log but continue — one bad migration shouldn't block subsequent
        // ones, and shouldn't crash the server.
        console.error(`[RawMigrations] FAILED ${file}:`, (err as Error)?.message ?? err);
      }
    }
    console.log(
      `[RawMigrations] done: ${newlyApplied} newly applied, ${skipped} already applied, ${allFiles.length} total`,
    );
  } catch (err) {
    console.error("[RawMigrations] runner crashed:", (err as Error)?.message ?? err);
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        // ignore
      }
    }
  }
}
