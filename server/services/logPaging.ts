/**
 * Paging and search for the campaign Logs tab's two feeds (audit 2026-10-20,
 * U22): the engine's lines and the discovery runs' lines. Each page is read
 * newest first by (createdAt, id); "load older" passes the last row it has,
 * and the next page is everything strictly older than it, so a page boundary
 * that falls inside one second neither repeats nor skips a line.
 */
import { and, eq, lt, or, type Column, type SQL } from "drizzle-orm";
import { z } from "zod";

/** The oldest row a page already holds. */
export const logCursor = z.object({ createdAt: z.coerce.date(), id: z.number().int() });
export type LogCursor = z.infer<typeof logCursor>;

/** Rows strictly older than `c` in (createdAt, id) order. */
export function olderThan(createdAt: Column, id: Column, c: LogCursor): SQL {
  return or(lt(createdAt, c.createdAt), and(eq(createdAt, c.createdAt), lt(id, c.id)))!;
}

/** A LIKE pattern for "contains", with the user's own % and _ taken literally. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
