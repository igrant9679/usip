/**
 * The id MySQL gave the row an insert just wrote.
 *
 * `db.insert(...)` on drizzle's mysql2 driver resolves to the driver's own
 * `[ResultSetHeader, FieldPacket[]]` (drizzle-orm/mysql2/session.d.ts,
 * `MySqlRawQueryResult`; session.js reads `res[0].insertId` itself), so the id
 * is on the first element and `.insertId` read off the array is undefined. A
 * bare ResultSetHeader, what `const [res] = await db.insert(...)` leaves, is
 * read as it is. 0 when there is no id (audit 2026-11-06, N6).
 *
 * `server/insertIdShape.test.ts` fails on any other `.insertId` read that is not
 * off a destructured header or an explicit `[0]`.
 */
export function insertIdOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const id = Number((header as { insertId?: unknown } | null | undefined)?.insertId ?? 0);
  return Number.isFinite(id) ? id : 0;
}
