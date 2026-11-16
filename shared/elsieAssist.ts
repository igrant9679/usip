/**
 * Elsie Assist: the pane where Elsie suggests the next thing to do (owner
 * 2026-11-16: "a pane … where she can be advising, recommending … as the user
 * is navigating and using the system … and asking if the user wants her to do
 * those actions").
 *
 * How a suggestion is made, and why it is made this way:
 *
 *   1. RULES pick the candidates, from the same records and endpoints the
 *      pages already use (the Home attention summary, a campaign's stall
 *      reasons). Every candidate carries its own plain title, its reason and
 *      its action, so the pane works with no model at all.
 *   2. A MODEL may then order the candidates and reword them. It is given the
 *      candidates' facts and nothing else, it cannot add one, and it cannot
 *      touch an action. A reworded line that mentions a number the facts do
 *      not hold is thrown away and the rule's own line is shown instead.
 *
 * The week before this was written, Elsie described a table, a toggle and a
 * drag handle that were not on the page. Advice about what to do next cannot
 * be invented the same way, so nothing here is.
 *
 * Pure and shared: the server builds with it, the pane renders it, and both
 * agree on which pages have suggestions.
 */
import { describeScreen } from "./assistantScreen";

/** The kinds of suggestion, each with the words the pane uses to offer to stop it. */
export const ASSIST_KINDS = {
  replies_waiting: "replies waiting for an answer",
  interested_replies: "replies that sound interested",
  social_replies: "LinkedIn replies waiting",
  drafts_to_review: "drafts waiting for review",
  prospects_to_approve: "prospects waiting for approval",
  meetings_to_confirm: "proposed meetings",
  routing_suggestions: "best-fit campaign suggestions",
  campaign_proposals: "proposed campaigns",
  campaigns_all_paused: "no campaign running",
  campaign_blocked: "why a campaign is not sending",
  campaign_approvals: "a campaign's approval queue",
  person_reply: "a reply from the person on screen",
  person_tasks: "overdue tasks for the person on screen",
  person_campaigns: "where the person on screen is enrolled",
} as const;

export type AssistKind = keyof typeof ASSIST_KINDS;
export const ASSIST_KIND_IDS = Object.keys(ASSIST_KINDS) as AssistKind[];
export function isAssistKind(v: unknown): v is AssistKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ASSIST_KINDS, v);
}

/**
 * What a suggestion's button does. Only these two: go to a page, or put a
 * request to Elsie in her chat, where anything that changes data still shows
 * its confirm card. A suggestion never changes anything by itself.
 */
export type AssistAction =
  | { type: "navigate"; label: string; href: string }
  | { type: "ask"; label: string; prompt: string };

export type AssistSuggestion = {
  /** Stable for the same fact about the same record, so a dismissal sticks while the fact stands. */
  id: string;
  kind: AssistKind;
  title: string;
  /** The evidence, from records. */
  why: string;
  action: AssistAction;
  /** True when a model reworded the rule's own title and reason. */
  worded: boolean;
};

/** A suggestion as the rules make it, before any model sees it. */
export type AssistCandidate = Omit<AssistSuggestion, "worded"> & {
  /** Higher first. What blocks more, or is owed to someone outside, outranks housekeeping. */
  weight: number;
  /** The facts the reason rests on. The only thing a model is shown besides the title and reason. */
  facts: Record<string, string | number>;
};

export const ASSIST_MAX_SHOWN = 3;
/** Model passes a workspace gets per day (UTC) when its admin has set no number. */
export const ASSIST_DEFAULT_DAILY_CAP = 200;
export const ASSIST_DAILY_CAP_MAX = 5000;

export type AssistPlace = "home" | "campaign" | "inbox" | "person";
export const ASSIST_PLACE_LABEL: Record<AssistPlace, string> = {
  home: "Home",
  campaign: "a campaign's page",
  inbox: "Inbox",
  person: "a person's record",
};

/** The page an address is, for the pane: one of the four it knows, with the record's id where there is one. */
export function assistPlaceFor(pagePath: unknown): { place: AssistPlace; id: number | null } | null {
  const screen = describeScreen(pagePath);
  if (!screen) return null;
  if (screen.record?.kind === "campaign") return { place: "campaign", id: screen.record.id };
  if (screen.record?.kind === "person") return { place: "person", id: screen.record.id };
  if (screen.path === "/" || screen.path === "/v2/home") return { place: "home", id: null };
  if (screen.path === "/v2/inbox") return { place: "inbox", id: null };
  return null;
}

/** Highest weight first; ties keep the rules' order. Muted kinds and dismissed ids are left out. */
export function rankCandidates<T extends { id: string; kind: AssistKind; weight: number }>(
  candidates: T[],
  opts: { muted?: readonly string[]; max?: number } = {},
): T[] {
  const muted = new Set(opts.muted ?? []);
  return candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !muted.has(c.kind))
    .sort((a, b) => b.c.weight - a.c.weight || a.i - b.i)
    .slice(0, opts.max ?? ASSIST_MAX_SHOWN)
    .map(({ c }) => c);
}

/** Every run of digits in a text, as numbers ("1,204" is 1204). */
export function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*/g) ?? []).map((m) => Number(m.replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

/**
 * Whether a reworded line may be shown: every number in it is one the
 * candidate's own facts, title or reason holds. A model that says "12 replies"
 * about a candidate whose facts say 7 is not rewording, it is inventing.
 */
export function wordingIsGrounded(text: string, candidate: Pick<AssistCandidate, "title" | "why" | "facts">): boolean {
  const allowed = new Set<number>([
    ...numbersIn(candidate.title),
    ...numbersIn(candidate.why),
    ...Object.values(candidate.facts).flatMap((v) => (typeof v === "number" ? [v] : numbersIn(String(v)))),
  ]);
  return numbersIn(text).every((n) => allowed.has(n));
}

export type AssistWording = { id: string; title: string; why: string };

/**
 * Apply a model's ordering and rewording to the candidates it was shown.
 * Only ids it was shown count, each once; a line that is empty, too long or
 * not grounded falls back to the rule's own; anything the model left out
 * keeps its place after the ones it ordered.
 */
export function applyWording(candidates: AssistCandidate[], wording: AssistWording[]): AssistSuggestion[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: AssistSuggestion[] = [];
  const seen = new Set<string>();
  const strip = ({ weight: _w, facts: _f, ...rest }: AssistCandidate) => rest;
  for (const w of wording) {
    const c = w && typeof w.id === "string" ? byId.get(w.id) : undefined;
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    const title = typeof w.title === "string" ? w.title.trim() : "";
    const why = typeof w.why === "string" ? w.why.trim() : "";
    const ok = title.length >= 8 && title.length <= 110 && why.length >= 8 && why.length <= 220
      && wordingIsGrounded(title, c) && wordingIsGrounded(why, c);
    out.push(ok ? { ...strip(c), title, why, worded: true } : { ...strip(c), worded: false });
  }
  for (const c of candidates) if (!seen.has(c.id)) out.push({ ...strip(c), worded: false });
  return out;
}

export type AssistPrefs = { open: boolean; muted: AssistKind[] };
export const ASSIST_DEFAULT_PREFS: AssistPrefs = { open: false, muted: [] };

/** Whatever is stored for a user, read back as only its well-formed parts. Off unless it says on. */
export function cleanAssistPrefs(raw: unknown): AssistPrefs {
  if (!raw || typeof raw !== "object") return { ...ASSIST_DEFAULT_PREFS };
  const r = raw as { open?: unknown; muted?: unknown };
  const muted = Array.isArray(r.muted) ? Array.from(new Set(r.muted.filter(isAssistKind))) : [];
  return { open: r.open === true, muted };
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
