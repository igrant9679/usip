/**
 * emailActivity.ts — the shape and vocabulary of the sitewide email feed.
 *
 * The Emails page (/v2/emails) shows four kinds of row that live in four
 * different tables:
 *
 *   email_log            every email actually transmitted (migration 0163)
 *   email_drafts         mail written but NOT yet sent — the review queue
 *   are_execution_queue  ARE campaign steps still scheduled, or that failed
 *                        before reaching a mailbox
 *   email_replies        inbound mail
 *
 * They are merged on read rather than copied into one table, so each keeps
 * ownership of its own live counters (a draft's openCount, an execution row's
 * openedAt) instead of the page reading a stale duplicate — the mistake that
 * left `are_ab_variants` with counters nothing ever wrote.
 *
 * `mergeFeed` is the pagination rule, kept here (and unit-tested) because
 * getting it wrong is this codebase's most expensive recurring bug: filter in
 * SQL, LIMIT in SQL, and only THEN merge. Filtering a page that has already
 * been limited is what emptied the ARE Active tab in 320072b.
 */

export type EmailFeedKind = "log" | "draft" | "queued" | "inbound";

export type EmailFeedDirection = "outbound" | "inbound";

/** Where an email came from. Mirrors `email_log.source`, plus `inbound`. */
export const EMAIL_SOURCES = [
  { id: "campaign", label: "ARE campaign", hint: "Autonomous Revenue Engine campaign steps" },
  { id: "sequence", label: "Sequence", hint: "Classic sequence steps" },
  { id: "crm", label: "CRM send", hint: "Ad-hoc emails sent from a contact, lead or prospect" },
  { id: "ai_draft", label: "AI draft", hint: "AI-written mail, approved or auto-sent" },
  { id: "mailbox", label: "Inbox", hint: "Composed or replied to by hand in the Inbox" },
  { id: "proposal", label: "Proposal", hint: "Proposal and quote delivery" },
  { id: "transactional", label: "System", hint: "Invites, alerts, scheduled reports" },
  { id: "test", label: "Test", hint: "Test sends from a settings screen" },
  { id: "other", label: "Other", hint: "Sent through a path that does not name itself yet" },
  { id: "inbound", label: "Inbound", hint: "Replies and mail received" },
] as const;

export type EmailSourceId = (typeof EMAIL_SOURCES)[number]["id"];

const SOURCE_LABELS = new Map<string, string>(EMAIL_SOURCES.map((s) => [s.id, s.label]));

export function emailSourceLabel(source: string | null | undefined): string {
  const id = (source ?? "").trim();
  if (!id) return "Other";
  return SOURCE_LABELS.get(id) ?? id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * One row of the feed, whichever table it came from.
 *
 * `key` is source-qualified because ids collide across tables — two rows both
 * numbered 7 from different tables would share a React key and one would
 * vanish from the list.
 */
export interface EmailFeedRow {
  key: string;
  kind: EmailFeedKind;
  id: number;
  direction: EmailFeedDirection;
  source: string;
  sourceLabel: string | null;
  subject: string | null;
  preview: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmail: string | null;
  /** sent | failed | pending_review | ai_pending_review | approved | rejected | scheduled | paused | skipped | received */
  status: string;
  failureReason: string | null;
  /** The instant this row is filed under — sent, scheduled, or received. */
  at: string | Date;
  openCount: number;
  clickCount: number;
  openedAt: string | Date | null;
  bouncedAt: string | Date | null;
  bounceType: string | null;
  repliedAt: string | Date | null;
  /* Records this email belongs to — each nullable, each a link on the page. */
  draftId: number | null;
  executionQueueId: number | null;
  campaignId: number | null;
  prospectQueueId: number | null;
  contactId: number | null;
  leadId: number | null;
  sequenceId: number | null;
  sendingAccountId: number | null;
  userId: number | null;
  stepIndex: number | null;
}

/** A row is "engaged" when the recipient did something with it. */
export function isEngaged(row: EmailFeedRow): boolean {
  return (row.openCount ?? 0) > 0 || (row.clickCount ?? 0) > 0 || !!row.repliedAt;
}

export const EMAIL_STATUS_GROUPS: Record<string, string[]> = {
  sent: ["sent"],
  failed: ["failed"],
  awaiting: ["pending_review", "ai_pending_review", "approved"],
  scheduled: ["scheduled", "paused"],
  received: ["received"],
};

/* ─── which sources a filter can possibly match ──────────────────────────── */

export interface EmailFeedFilters {
  direction: "all" | "outbound" | "inbound";
  /** An `email_log.source` value, `inbound`, or `all`. */
  source: string;
  /** sent | engaged | bounced | failed | awaiting | scheduled | received | all */
  status: string;
}

/**
 * Can this source contribute anything under the source filter?
 *
 * Only `email_log` has a `source` column. A draft is classified the way the log
 * will classify it at send time, and every queued row is campaign mail by
 * construction — so the same filter has to be able to reach them.
 */
export function sourceApplies(filters: EmailFeedFilters, kind: EmailFeedKind): boolean {
  if (filters.source === "all") return true;
  if (filters.source === "inbound") return kind === "inbound";
  if (kind === "inbound") return false;
  if (kind === "log") return true; // narrowed by the source column in SQL
  if (kind === "draft") return ["sequence", "ai_draft", "crm"].includes(filters.source);
  return filters.source === "campaign";
}

/** …and under the status filter? */
export function statusApplies(filters: EmailFeedFilters, kind: EmailFeedKind): boolean {
  switch (filters.status) {
    case "sent":
    case "engaged":
    case "bounced":
      return kind === "log";
    case "failed":
      // A pool failure (no eligible account, daily cap) never reaches an
      // adapter, so it exists only on the execution row.
      return kind === "log" || kind === "queued";
    case "awaiting":
      return kind === "draft";
    case "scheduled":
      return kind === "queued";
    case "received":
      return kind === "inbound";
    default:
      return true;
  }
}

/**
 * Whether a source is worth querying at all for these filters.
 *
 * The three checks COMPOSE. An earlier version returned on the source check
 * alone, so "campaign + sent" also queried the scheduled-and-failed source and
 * returned rows the user had just filtered out.
 */
export function feedSourceApplies(filters: EmailFeedFilters, kind: EmailFeedKind): boolean {
  if (filters.direction === "inbound") return kind === "inbound" && statusApplies(filters, kind);
  if (filters.direction === "outbound" && kind === "inbound") return false;
  return sourceApplies(filters, kind) && statusApplies(filters, kind);
}

function timeOf(row: { at: string | Date }): number {
  const t = new Date(row.at).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Merge the per-source pages into one ordered page.
 *
 * Every source must already be FILTERED and ORDERED in SQL and limited to
 * `offset + limit` rows — that is what makes taking the window here correct:
 * no source can contribute a row older than its own last row, so the first
 * `offset + limit` of the merged list is exactly the true first
 * `offset + limit` of the whole feed.
 *
 * The reverse — merging first and filtering after — is the shape that emptied
 * the ARE Active tab (320072b), and it is silent: the page looks fine, it is
 * simply missing rows.
 */
export function mergeFeed(
  sources: EmailFeedRow[][],
  { limit, offset }: { limit: number; offset: number },
): EmailFeedRow[] {
  const all = sources.flat();
  all.sort((a, b) => {
    const d = timeOf(b) - timeOf(a);
    if (d !== 0) return d;
    // Deterministic tiebreak: two rows sharing a timestamp must not swap
    // places between requests, or a row can be skipped across page bounds.
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
  return all.slice(offset, offset + limit);
}
