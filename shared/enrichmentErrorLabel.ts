/**
 * enrichmentErrorLabel — turn a stored enrichment failure reason into what a
 * person should read.
 *
 * The enrichment sweeper writes machine strings such as "quickenrich:
 * no_match" into `enrichmentError`. That is the truth, and it stays in the
 * row's tooltip — but as the visible line it reads like a fault when it is a
 * fact: this person is simply not in QuickEnrich's database. Owner ask
 * 2026-08-19: show it as "Not in QuickEnrich", in brown (information, not
 * alarm). Genuine failures keep the red.
 *
 * Two rules added 2026-10-31, after F11's stall panel was seen live rendering
 * two 800-character MySQL INSERT statements, cut mid-token, as its explanation
 * of why a campaign was stuck:
 *
 *   1. **The label is a class, the detail is the evidence.** Whatever a line
 *      shows, the stored string survives whole in `detail`, for a tooltip or a
 *      details view. A caller that wants the raw text has it; nobody has to
 *      read it to find out what happened.
 *   2. **Nothing is ever cut mid-token.** Every clip lands on a whitespace
 *      boundary, so a shortened line ends in a word rather than half of one.
 */
export type EnrichmentErrorTone = "info" | "warn" | "error";

export interface EnrichmentErrorLabel {
  label: string;
  tone: EnrichmentErrorTone;
  /** The stored reason, whole and uncut, for a tooltip or a details view. */
  detail: string;
}

/** As much of a reason as belongs on one line of a list. */
export const ENRICHMENT_LABEL_CHARS = 120;

/**
 * Shorten to at most `limit` characters, cutting only where the string already
 * has whitespace.
 *
 * A single unbroken token longer than the limit returns "" rather than a
 * prefix of itself: there is no honest short form of one long word, and half a
 * token read as a whole one is how "…values (default, ?, ?, …, defa" ended up
 * on a panel. The caller decides what to say instead.
 */
export function clipAtWordBoundary(raw: string | null | undefined, limit: number = ENRICHMENT_LABEL_CHARS): string {
  const s = String(raw ?? "").trim();
  if (s.length <= limit) return s;
  // Greedy up to the LAST whitespace inside the window, so the clip takes as
  // many whole words as fit.
  const m = /^([\s\S]*)\s/.exec(s.slice(0, limit + 1));
  const head = (m?.[1] ?? "").replace(/[\s,;:([{<\-–—]+$/, "");
  if (!head) return "";
  return `${head}…`;
}

/**
 * Every distinct message in an error's cause chain, innermost first.
 *
 * Order matters and is the point. A Drizzle query error carries the whole SQL
 * statement in its OWN message and the driver's actual complaint — "Data too
 * long for column…", "Duplicate entry…" — in `cause`. Stored outermost-first
 * and capped, the cap lands inside the column list and the one sentence worth
 * keeping is thrown away. That is what happened to the two enrichment failures
 * on ws 2 campaign 38 (2026-10-31): 800 stored characters, no reason in them.
 */
export function enrichmentReasonFrom(err: unknown): string {
  const messages: string[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e != null; depth++) {
    const m = e instanceof Error ? String(e.message ?? "").trim() : depth === 0 ? String(e).trim() : "";
    if (m && !messages.includes(m)) messages.push(m);
    e = e instanceof Error ? (e as { cause?: unknown }).cause : null;
  }
  return messages.reverse().join(" — ");
}

/** Where a Drizzle message stops being a reason and starts being SQL. */
const QUERY_DUMP = /(?:^|\s|—\s*)failed query:/i;

export function describeEnrichmentError(raw: string | null | undefined): EnrichmentErrorLabel | null {
  const detail = (raw ?? "").trim();
  if (!detail) return null;
  const m = /^quickenrich:\s*(\S+)(.*)$/i.exec(detail);
  if (m) {
    const reason = m[1].toLowerCase();
    const rest = m[2] ?? "";
    if (reason === "no_match") return { label: "Not in QuickEnrich", tone: "info", detail };
    if (/transport failure|will retry/i.test(rest)) return { label: "QuickEnrich unavailable — will retry", tone: "warn", detail };
    return { label: `QuickEnrich: ${reason.replace(/_/g, " ")}`, tone: "warn", detail };
  }

  // One line, because a stack trace's second line is not a better explanation
  // than its first, and the whole of it is in `detail` either way.
  const line = detail.split(/[\r\n]/, 1)[0].trim();
  // The SQL is cut from the LABEL and kept in the detail. A column list has
  // never told anyone why a prospect is stuck, and at this length it is not
  // merely useless — it crowds out the sentence that would have said.
  const dump = line.search(QUERY_DUMP);
  const head = dump === -1 ? line : line.slice(0, dump).replace(/[\s—]+$/, "");
  if (dump !== -1 && !head) {
    return {
      label: "The database rejected the write — only the query was recorded, not the reason",
      tone: "error",
      detail,
    };
  }
  const clipped = clipAtWordBoundary(head);
  // One token, longer than a line. Saying so beats showing a slice of it.
  if (!clipped) return { label: "Enrichment failed — the recorded reason is not readable text", tone: "error", detail };
  return { label: clipped, tone: "error", detail };
}

// NOTE: the Tailwind classes per tone live in the client (ARECampaignDetail),
// not here — Tailwind v4's content scan is rooted at client/ and does not see
// shared/, so a class string defined here is never generated.
