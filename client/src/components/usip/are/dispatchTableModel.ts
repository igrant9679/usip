/**
 * dispatchTableModel — the pure half of the Step performance dispatch table
 * (owner ask 2026-09-03: "filter and sort table buttons"). Filtering,
 * sorting and step grouping live here, imported by the page and tested as
 * functions, so the table's behaviour is checked rather than its markup.
 *
 * Rows are `DispatchStat` from services/performanceMetrics — one per message
 * actually sent. The outcome vocabulary is the same last-touch one the cards
 * used (meeting > replied > opened > no open / opens not tracked).
 */

export interface DispatchRowLike {
  executionId: number;
  stepIndex: number;
  prospectName: string;
  prospectTitle: string | null;
  companyName: string | null;
  subject: string | null;
  bodyPreview: string | null;
  sentAt: Date | string | null;
  opensTracked: boolean;
  opened: boolean;
  openedAt: Date | string | null;
  replied: boolean;
  meeting: boolean;
}

export type DispatchOutcome = "meeting" | "replied" | "opened" | "no_open" | "untracked";

/** Best outcome first — the order the Outcome column sorts in. */
export const OUTCOME_ORDER: DispatchOutcome[] = ["meeting", "replied", "opened", "no_open", "untracked"];

export const OUTCOME_LABEL: Record<DispatchOutcome, string> = {
  meeting: "Meeting",
  replied: "Replied",
  opened: "Opened",
  no_open: "No open yet",
  untracked: "Opens not tracked",
};

export function outcomeOf(d: Pick<DispatchRowLike, "meeting" | "replied" | "opened" | "opensTracked">): DispatchOutcome {
  if (d.meeting) return "meeting";
  if (d.replied) return "replied";
  if (d.opened) return "opened";
  return d.opensTracked ? "no_open" : "untracked";
}

export type DispatchSortKey = "sent" | "prospect" | "subject" | "opened" | "outcome";
export type SortDir = "asc" | "desc";

export interface DispatchTableState {
  /** Case-insensitive contains over prospect name, title, company, subject. */
  query: string;
  /** A single step (zero-based) or every step. */
  step: number | null;
  outcome: DispatchOutcome | "all";
  sort: { key: DispatchSortKey; dir: SortDir };
}

export const DEFAULT_DISPATCH_TABLE_STATE: DispatchTableState = {
  query: "",
  step: null,
  outcome: "all",
  sort: { key: "sent", dir: "asc" },
};

/** The direction a column starts in when first clicked — newest/best first
 *  for time and outcome, A→Z for text. */
export const DEFAULT_DIR: Record<DispatchSortKey, SortDir> = {
  sent: "desc",
  opened: "desc",
  outcome: "asc",
  prospect: "asc",
  subject: "asc",
};

/** Click a column header: same column flips direction, a new one starts at its default. */
export function nextSort(cur: DispatchTableState["sort"], key: DispatchSortKey): DispatchTableState["sort"] {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: DEFAULT_DIR[key] };
}

export function isFiltered(s: DispatchTableState): boolean {
  return s.query.trim() !== "" || s.step !== null || s.outcome !== "all";
}

export function filterDispatches<T extends DispatchRowLike>(rows: T[], s: DispatchTableState): T[] {
  const q = s.query.trim().toLowerCase();
  return rows.filter((d) => {
    if (s.step !== null && d.stepIndex !== s.step) return false;
    if (s.outcome !== "all" && outcomeOf(d) !== s.outcome) return false;
    if (q) {
      const hay = [d.prospectName, d.prospectTitle, d.companyName, d.subject].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const ts = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const n = new Date(v).getTime();
  return Number.isNaN(n) ? null : n;
};

/**
 * Stable sort. A missing value (no subject, never opened) sorts LAST in
 * both directions — "opened, newest first" must not start with the people
 * who never opened.
 */
export function sortDispatches<T extends DispatchRowLike>(rows: T[], sort: DispatchTableState["sort"]): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const keyed = rows.map((d, i) => ({ d, i }));
  const cmpText = (a: string | null, b: string | null) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" }) * sign;
  };
  const cmpNum = (a: number | null, b: number | null) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  };
  keyed.sort((x, y) => {
    const a = x.d, b = y.d;
    let c = 0;
    switch (sort.key) {
      case "prospect": c = cmpText(a.prospectName, b.prospectName); break;
      case "subject": c = cmpText(a.subject, b.subject); break;
      case "sent": c = cmpNum(ts(a.sentAt), ts(b.sentAt)); break;
      case "opened": c = cmpNum(a.opened ? ts(a.openedAt) : null, b.opened ? ts(b.openedAt) : null); break;
      case "outcome": c = (OUTCOME_ORDER.indexOf(outcomeOf(a)) - OUTCOME_ORDER.indexOf(outcomeOf(b))) * sign; break;
    }
    return c || x.i - y.i;
  });
  return keyed.map((k) => k.d);
}

/** Rows grouped under their step, steps ascending; the sort applies WITHIN each step. */
export function groupDispatchesByStep<T extends DispatchRowLike>(rows: T[]): Array<[number, T[]]> {
  const by = new Map<number, T[]>();
  for (const d of rows) { const arr = by.get(d.stepIndex) ?? []; arr.push(d); by.set(d.stepIndex, arr); }
  return Array.from(by.entries()).sort((x, y) => x[0] - y[0]);
}

/** Per-outcome counts over the UNFILTERED list — what the filter chips show. */
export function outcomeCounts(rows: DispatchRowLike[]): Record<DispatchOutcome, number> {
  const out: Record<DispatchOutcome, number> = { meeting: 0, replied: 0, opened: 0, no_open: 0, untracked: 0 };
  for (const d of rows) out[outcomeOf(d)] += 1;
  return out;
}
