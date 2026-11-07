/**
 * mailboxCache.ts — a short-lived cache of what My Mailbox reads from the
 * provider (audit 2026-10-20, L8).
 *
 * Mailbox took 10.8 s to open live, 8.9 s of it in mailbox.listThreads: every
 * open, folder switch, back-navigation and refetch went to the provider again
 * (Unipile or IMAP), with nothing kept. The thread list and the folder list
 * are now kept for MAILBOX_CACHE_TTL_MS per mailbox, and dropped the moment
 * anything changes them: a send, reply or forward from the mailbox, a message
 * marked read, trashed or moved, new mail announced by the provider's
 * webhook, or the page's Refresh button.
 *
 * In memory, per process: what it saves is a provider round-trip, and a
 * restart only costs one fresh read. Only successful reads are kept; a failed
 * read is retried on the next ask. The caller authorises the read BEFORE
 * asking here, so a cached list is only ever handed to someone allowed to
 * read that mailbox.
 */

export const MAILBOX_CACHE_TTL_MS = 45_000;
/** Entries kept at most; the oldest go first. */
const MAX_ENTRIES = 500;

type Entry = { at: number; accountId: number; unipileAccountId: string | null; value: unknown };
const entries = new Map<string, Entry>();

export type MailboxCacheAccount = { id: number; unipileAccountId?: string | null };

function key(account: MailboxCacheAccount, kind: string, parts: unknown[]): string {
  return `${account.id}|${kind}|${JSON.stringify(parts)}`;
}

/**
 * The cached value for this mailbox read, or a fresh one from `load`, kept
 * when `keep(value)` says it is a good read.
 */
export async function cachedMailboxRead<T>(
  account: MailboxCacheAccount,
  kind: "threads" | "folders",
  parts: unknown[],
  load: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
  now: () => number = Date.now,
): Promise<T> {
  const k = key(account, kind, parts);
  const hit = entries.get(k);
  if (hit && now() - hit.at < MAILBOX_CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  if (keep(value)) {
    entries.delete(k);
    entries.set(k, { at: now(), accountId: account.id, unipileAccountId: account.unipileAccountId ?? null, value });
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
  return value;
}

/** Forget what was read for a mailbox (by its sending-account id or its Unipile account id), or for all. */
export function invalidateMailboxCache(target?: { accountId?: number | null; unipileAccountId?: string | null }): number {
  if (!target) {
    const n = entries.size;
    entries.clear();
    return n;
  }
  let n = 0;
  for (const [k, e] of Array.from(entries.entries())) {
    if ((target.accountId != null && e.accountId === target.accountId) ||
        (target.unipileAccountId && e.unipileAccountId === target.unipileAccountId)) {
      entries.delete(k);
      n++;
    }
  }
  return n;
}

/** For tests. */
export function mailboxCacheSize(): number {
  return entries.size;
}
