/**
 * One-time 2FA recovery codes (audit 2026-10-20, G15).
 *
 * The 2FA lock-out screen said there were no backup codes, and there were
 * none: a lost or wiped phone meant waiting for an admin to press Reset 2FA,
 * and with the workspace requiring 2FA that member was locked out of the
 * product until then.
 *
 * Ten codes per account, made when 2FA is set up and on demand (a new set
 * replaces the old one), shown once and stored only as hashes. Each signs in
 * once, at the same prompt that asks for the authenticator code, and a wrong
 * one counts against the account's sign-in lock exactly as a wrong code does.
 *
 * SHA-256 rather than bcrypt: a code is 10 random characters (about 49 bits),
 * not a person's password, and it is salted with the account id so the same
 * code on two accounts hashes differently. The sign-in lock caps guesses at
 * ten a quarter-hour, which is what makes 49 bits plenty.
 */
import crypto from "crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { mfaBackupCodes } from "../../drizzle/schema";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const BACKUP_CODE_COUNT = 10;
/** No 0/o, 1/l/i: a code is copied off paper by hand. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 10;

/** `abcde-fghjk`: ten characters, shown in two halves so it can be read aloud. */
export function newBackupCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Lower-cased, without spaces or dashes; null when it cannot be a backup code. */
export function normalizeBackupCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.toLowerCase().replace(/[\s-]+/g, "");
  if (clean.length !== CODE_LENGTH) return null;
  for (let i = 0; i < clean.length; i++) if (ALPHABET.indexOf(clean[i]) === -1) return null;
  return clean;
}

/** Whether what was typed into the code box is a backup code rather than six digits. */
export function looksLikeBackupCode(raw: unknown): boolean {
  return normalizeBackupCode(raw) !== null;
}

export function hashBackupCode(userId: number, normalized: string): string {
  return crypto.createHash("sha256").update(`mfa-backup:${userId}:${normalized}`).digest("hex");
}

/**
 * A fresh set for this account, replacing any it had: the old codes stop
 * working at once. Returns the codes in plain text, the only time they exist
 * outside the person's own copy.
 */
export async function replaceBackupCodes(db: Db, userId: number): Promise<string[]> {
  const codes: string[] = [];
  while (codes.length < BACKUP_CODE_COUNT) {
    const c = newBackupCode();
    if (codes.indexOf(c) === -1) codes.push(c);
  }
  await db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
  await db.insert(mfaBackupCodes).values(
    codes.map((c) => ({ userId, codeHash: hashBackupCode(userId, normalizeBackupCode(c)!) })),
  );
  return codes;
}

/**
 * Spend a code: true only the first time this account's unused code is
 * presented. A conditional UPDATE, so two sign-ins racing with one code
 * cannot both win.
 */
export async function useBackupCode(db: Db, userId: number, raw: unknown): Promise<boolean> {
  const clean = normalizeBackupCode(raw);
  if (!clean) return false;
  const res = await db
    .update(mfaBackupCodes)
    .set({ usedAt: new Date() })
    .where(and(
      eq(mfaBackupCodes.userId, userId),
      eq(mfaBackupCodes.codeHash, hashBackupCode(userId, clean)),
      isNull(mfaBackupCodes.usedAt),
    ));
  const affected = Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0);
  return affected > 0;
}

/** How many unused codes the account has left. */
export async function backupCodesLeft(db: Db, userId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(mfaBackupCodes)
    .where(and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)));
  return Number(row?.n ?? 0);
}

/** Turning 2FA off, or an admin's reset, takes the codes with it. */
export async function clearBackupCodes(db: Db, userId: number): Promise<void> {
  await db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
}
