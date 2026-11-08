/**
 * Claims: a conditional UPDATE that takes a row, and the side effects only
 * when it did (audit 2026-10-20, X1.5).
 *
 * The shape that repeated a side effect on a double click or a retry was
 * check-then-write: read the row, see it is still `pending`, then write
 * `approved` with a WHERE on the id alone and do the work. Two requests both
 * read `pending`, both write, and both do the work. A claim puts the state it
 * expects in the WHERE (`... AND status = 'pending'`) and goes on only when
 * the database says a row changed, so exactly one request wins.
 *
 * Rows changed are read the way insertIdOf (./insertId.ts) reads ids:
 * `db.update(...)` and `db.execute(...)` on drizzle's mysql2 driver resolve to
 * `[ResultSetHeader, FieldPacket[]]`, so the count is on the first element; a
 * bare ResultSetHeader, what `const [res] = await db.update(...)` leaves, is
 * read as it is. Reading `.affectedRows` anywhere else is refused by
 * server/claimHelper.test.ts, as `.insertId` is by insertIdShape.test.ts.
 */

/** How many rows an UPDATE, DELETE or conditional INSERT changed. 0 when unknown. */
export function affectedRowsOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const h = header as { affectedRows?: unknown; rowsAffected?: unknown } | null | undefined;
  const n = Number(h?.affectedRows ?? h?.rowsAffected ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Run a conditional update and say whether it took the row: true only when
 * exactly `expected` rows changed (one, for a claim on a single row).
 *
 *   const won = await claimRow(db.update(t).set({ status: "approved" })
 *     .where(and(eq(t.id, id), eq(t.workspaceId, ws), eq(t.status, "pending"))));
 *   if (!won) throw new TRPCError({ code: "CONFLICT", message: "Already reviewed" });
 */
export async function claimRow(update: PromiseLike<unknown>, expected = 1): Promise<boolean> {
  return affectedRowsOf(await update) === expected;
}
