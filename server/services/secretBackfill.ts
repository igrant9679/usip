/**
 * Mailbox secrets saved before they were encrypted, encrypted where they lie
 * (audit 2026-10-20, C4).
 *
 * Mailbox passwords have been encrypted on write since 2026-10-24, and OAuth
 * tokens since 2026-11-06, but rows saved before that kept their plaintext
 * until someone re-saved them; readStoredSecret reads both, so nothing ever
 * forced the issue. This pass runs once at boot and encrypts what is left.
 *
 * Why it is safe to run against the live database, unattended:
 *   · Only plaintext is touched. A value already in encryptField's shape
 *     (iv:tag:ciphertext, all hex) is skipped, so a second run does nothing,
 *     and so does a run after the key has changed: a value that no longer
 *     decrypts is still ciphertext, and encrypting it again would lose it.
 *   · Every new value is decrypted back and compared before it is written.
 *   · The write is compare-and-set on the old value, so a save that lands
 *     between the read and the write wins, and this pass leaves that row.
 *   · updatedAt is written back as read (it is ON UPDATE CURRENT_TIMESTAMP),
 *     so housekeeping does not reorder lists sorted by it.
 *   · Readers are unchanged: readStoredSecret already decrypts.
 *
 * caldavPassword is not on the list: it has been encrypted on write since it
 * was added (routers/calendar.ts).
 */
import { and, eq, isNotNull, or } from "drizzle-orm";
import { calendarAccounts, sendingAccounts } from "../../drizzle/schema";
import { getDb } from "../db";
import { decryptField, encryptField } from "../emailAdapter";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** encryptField's output: a 12-byte IV, a 16-byte tag, the ciphertext, in hex. */
export function looksEncrypted(value: string): boolean {
  return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/.test(value);
}

/** The encrypted form of a plaintext secret, proven to read back, or null to leave it. */
export function encryptedReplacement(value: string | null | undefined): string | null {
  if (!value || looksEncrypted(value)) return null;
  const enc = encryptField(value);
  return decryptField(enc) === value ? enc : null;
}

const TABLES = [
  { name: "sending_accounts", table: sendingAccounts, cols: ["smtpPassword", "imapPassword", "oauthAccessToken", "oauthRefreshToken"] as const },
  { name: "calendar_accounts", table: calendarAccounts, cols: ["oauthAccessToken", "oauthRefreshToken"] as const },
];

export async function encryptLegacyMailboxSecrets(dbArg?: Db): Promise<{ encrypted: number }> {
  const db = dbArg ?? (await getDb());
  if (!db) return { encrypted: 0 };
  let encrypted = 0;
  for (const { table, cols } of TABLES) {
    const t = table as any;
    const rows: Array<Record<string, any>> = await db
      .select({ id: t.id, updatedAt: t.updatedAt, ...Object.fromEntries(cols.map((c) => [c, t[c]])) })
      .from(t)
      .where(or(...cols.map((c) => isNotNull(t[c]))));
    for (const row of rows) {
      for (const col of cols) {
        const enc = encryptedReplacement(row[col]);
        if (!enc) continue;
        const [res] = (await db
          .update(t)
          .set({ [col]: enc, updatedAt: row.updatedAt })
          .where(and(eq(t.id, row.id), eq(t[col], row[col])))) as any;
        if (Number(res?.affectedRows ?? 1) > 0) encrypted++;
      }
    }
  }
  if (encrypted > 0) console.log(`[secretBackfill] encrypted ${encrypted} stored mailbox secret(s)`);
  return { encrypted };
}
