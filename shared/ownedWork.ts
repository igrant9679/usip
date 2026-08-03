/**
 * What it means for a member to OWN something — one definition, shared.
 *
 * THE DRIFT THIS PREVENTS. Offboarding reassigns owned work in three places
 * (`team.deactivate`, `team.delete`, `team.bulkDeactivate`), and THREE MORE
 * places describe that work to the person clicking the button: the deactivate
 * dialog, the delete dialog's helper text, and the bulk dialog. Before this
 * file, all six spelled the list out by hand — and the two populations had
 * already diverged in the obvious direction: the reassignment moved leads,
 * opportunities and live tasks, while the copy promised "leads, opportunities,
 * and unfinished tasks" and said nothing about the accounts, contacts and
 * campaigns that were not moving at all.
 *
 * A confirm dialog is a promise (`a172d7f`). Deriving the sentence from the
 * same array the UPDATE statements iterate is what keeps it one.
 *
 * ⚠️ ADDING A TABLE HERE CHANGES BEHAVIOUR. It starts being reassigned on
 * offboarding, it starts counting toward the guard that forces an admin to name
 * a recipient before deleting somebody, and it appears in all three dialogs. It
 * belongs here only if `ownerUserId` on that table means "this person is
 * responsible for this record" — not merely "this person created it".
 */

/** `tasks` alone is filtered, because reassigning a CLOSED task rewrites history. */
export interface OwnableTable {
  /** Key in the counts object the API returns. */
  key: string;
  /** Physical table name. */
  table: string;
  /** Restrict to still-live rows (tasks only — see `activeTaskStatuses`). */
  liveOnly: boolean;
  singular: string;
  plural: string;
}

export const OWNABLE_TABLES: readonly OwnableTable[] = [
  { key: "leads", table: "leads", liveOnly: false, singular: "lead", plural: "leads" },
  { key: "opportunities", table: "opportunities", liveOnly: false, singular: "opportunity", plural: "opportunities" },
  { key: "accounts", table: "accounts", liveOnly: false, singular: "account", plural: "accounts" },
  { key: "contacts", table: "contacts", liveOnly: false, singular: "contact", plural: "contacts" },
  { key: "campaigns", table: "campaigns", liveOnly: false, singular: "campaign", plural: "campaigns" },
  { key: "tasks", table: "tasks", liveOnly: true, singular: "unfinished task", plural: "unfinished tasks" },
] as const;

export type OwnedWork = Record<string, number>;

/** A counts object with every key present at zero. */
export function zeroOwnedWork(): OwnedWork {
  const out: OwnedWork = {};
  for (const t of OWNABLE_TABLES) out[t.key] = 0;
  return out;
}

/** Total across every ownable table — what decides whether a target is required. */
export function totalOwnedWork(owned: OwnedWork | null | undefined): number {
  if (!owned) return 0;
  let n = 0;
  for (const t of OWNABLE_TABLES) n += Number(owned[t.key] ?? 0) || 0;
  return n;
}

/** Join a list into English: "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "3 leads, 1 account and 2 unfinished tasks" — only the non-zero parts.
 *
 * Used in the refusal an admin reads when they try to delete somebody who still
 * owns things, so it has to name every table that made the answer non-zero.
 */
export function describeOwnedWork(owned: OwnedWork | null | undefined): string {
  const parts = OWNABLE_TABLES
    .filter((t) => (Number(owned?.[t.key] ?? 0) || 0) > 0)
    .map((t) => {
      const n = Number(owned![t.key]);
      return `${n} ${n === 1 ? t.singular : t.plural}`;
    });
  return parts.length > 0 ? joinAnd(parts) : "no owned work";
}

/**
 * "leads, opportunities, accounts, contacts, campaigns and unfinished tasks" —
 * the sentence fragment the confirm dialogs use to promise what will move.
 *
 * The dialogs call this rather than restating the list, so a table added above
 * cannot be reassigned without the person approving it being told.
 */
export function ownedWorkNounPhrase(): string {
  return joinAnd(OWNABLE_TABLES.map((t) => t.plural));
}

/** "12 leads, 3 accounts" — a result summary for the success toast. */
export function summariseReassigned(owned: OwnedWork | null | undefined): string {
  const parts = OWNABLE_TABLES
    .filter((t) => (Number(owned?.[t.key] ?? 0) || 0) > 0)
    .map((t) => `${Number(owned![t.key])} ${t.plural}`);
  return parts.length > 0 ? parts.join(", ") : "nothing to move";
}
