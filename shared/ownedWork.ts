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

/**
 * ⚠️ `campaigns` AND `are_campaigns` ARE DIFFERENT TABLES, and only the first
 * was here. `are_campaigns` is the AUTONOMOUS engine — the one that sources
 * strangers, writes to them and promotes the ones who reply — and its
 * `ownerUserId` is stamped onto every account, contact and opportunity it
 * creates. Two columns with the same name on two tables with almost the same
 * name is precisely the shape that gets half-covered.
 */

/**
 * ⚠️ A SEQUENCE HAS TWO OWNERS, not one. `ownerUserId` is who created or forked
 * it; `assignedToUserId` is the rep a manager handed it to, and either can name
 * somebody who has left independently of the other. Both are PERMISSION
 * columns rather than actors — nothing on the send path reads them — so the
 * damage is bounded and worth stating precisely: a `private` sequence whose
 * owner has gone is invisible to every REP (managers and above see all rows
 * unfiltered), it cannot be edited by a rep because the edit gates compare
 * against `ownerUserId`, and the assignment renders in the UI as the literal
 * string "User 47". Meanwhile the sequence keeps sending, because sends are
 * driven by campaigns and enrolments, not by either column.
 *
 * Not dramatic, and it is listed here anyway because `sequences.fork` creates
 * every fork as `visibility: "private"` owned by the forking rep — so this is
 * the common shape of a rep's work, not an edge case.
 */

/**
 * ⚠️ A MEETING IS NOT LIKE THE OTHERS, and the difference is recorded here
 * because it constrains what reassignment can honestly claim. A lead has no
 * existence outside this database; a meeting has a provider calendar event on
 * the LEAVER'S calendar and an invite already sitting in the attendee's inbox
 * with the leaver's name on it. Moving `ownerUserId` moves neither. So the
 * server clears the row's calendar linkage and its `inviteSent` flag when it
 * reassigns one — the new host genuinely does not have it on their calendar,
 * and saying otherwise would be the more comfortable lie.
 */

/**
 * Which rows of a table move.
 *
 * `all` is the default and the common case — a lead or an account belongs to
 * somebody whatever state it is in. The other two exist because reassigning a
 * row that is already in the PAST rewrites history rather than transferring
 * responsibility: nobody takes over a meeting that happened last week, and
 * changing who "did" a completed task is a lie about the record.
 */
export type OwnableScope =
  /** Every row this member owns. */
  | "all"
  /** Tasks that still exist as work — see `@shared/taskStatus`. */
  | "live_tasks"
  /** Meetings still ahead of us — see `@shared/meetingStatus`. */
  | "future_meetings";

export interface OwnableTable {
  /** Key in the counts object the API returns. Unique across this list. */
  key: string;
  /** Physical table name. */
  table: string;
  /**
   * The column holding the member's id. Almost always `ownerUserId`, but
   * `sequences` carries TWO independent ones — it can be owned by one rep and
   * assigned to another — so a table may appear more than once here, with a
   * different column each time. `key` is what stays unique.
   */
  column: string;
  scope: OwnableScope;
  singular: string;
  plural: string;
}

export const OWNABLE_TABLES: readonly OwnableTable[] = [
  { key: "leads", table: "leads", column: "ownerUserId", scope: "all", singular: "lead", plural: "leads" },
  { key: "opportunities", table: "opportunities", column: "ownerUserId", scope: "all", singular: "opportunity", plural: "opportunities" },
  { key: "accounts", table: "accounts", column: "ownerUserId", scope: "all", singular: "account", plural: "accounts" },
  { key: "contacts", table: "contacts", column: "ownerUserId", scope: "all", singular: "contact", plural: "contacts" },
  { key: "campaigns", table: "campaigns", column: "ownerUserId", scope: "all", singular: "campaign", plural: "campaigns" },
  { key: "areCampaigns", table: "are_campaigns", column: "ownerUserId", scope: "all", singular: "autonomous campaign", plural: "autonomous campaigns" },
  { key: "sequences", table: "sequences", column: "ownerUserId", scope: "all", singular: "sequence", plural: "sequences" },
  { key: "assignedSequences", table: "sequences", column: "assignedToUserId", scope: "all", singular: "assigned sequence", plural: "assigned sequences" },
  { key: "meetings", table: "meetings", column: "ownerUserId", scope: "future_meetings", singular: "upcoming meeting", plural: "upcoming meetings" },
  { key: "tasks", table: "tasks", column: "ownerUserId", scope: "live_tasks", singular: "unfinished task", plural: "unfinished tasks" },
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
