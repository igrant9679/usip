/**
 * Learning from results (Research phase 6; owner plan 2026-10-14: "each
 * sector and persona shows prospects contacted, reply rate, meetings,
 * brief-check pass rate, and the openers that worked best and worst").
 *
 * When the Revenue Engine writes a prospect's sequence it records which
 * research the copy used: the sector and persona, the pains and lead-with
 * points the brief check found in it, the kind of hook it opened on, its
 * opening line, and whether it passed the brief check. Results then join that
 * record to what happened: sends, replies (an out-of-office alone is not a
 * reply) and meetings.
 */

export type BriefCheckResult = "passed" | "held" | "error" | "none";

/** What a prospect's copy took from the research, stored with the prospect. */
export type ResearchUseRecord = {
  pains: string[];
  leads: string[];
  check: BriefCheckResult;
  hookType: string;
  opener: string;
  matchedBy: string | null;
  at: string;
};

const CHECKS: BriefCheckResult[] = ["passed", "held", "error", "none"];

const strList = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean).map((x) => x.slice(0, 600)).slice(0, max);

export function cleanResearchUse(raw: unknown): ResearchUseRecord {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    pains: strList(o.pains, 30),
    leads: strList(o.leads, 30),
    check: CHECKS.includes(o.check as BriefCheckResult) ? (o.check as BriefCheckResult) : "none",
    hookType: hookTypeKey(o.hookType),
    opener: String(o.opener ?? "").slice(0, 300),
    matchedBy: typeof o.matchedBy === "string" ? o.matchedBy : null,
    at: typeof o.at === "string" ? o.at : "",
  };
}

/* ── Openers ────────────────────────────────────────────────────────────── */

/** The hook a sequence opened on, as a stable key (the enrich model writes it freely). */
export function hookTypeKey(v: unknown): string {
  const k = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!k) return "generic";
  if (k === "personalization") return "personalisation";
  return k;
}

const HOOK_LABEL: Record<string, string> = {
  award: "A public award",
  trigger_event: "A recent event",
  pain_signal: "A pain they show",
  personalisation: "Something personal to them",
  generic: "Nothing specific",
};

export function hookLabel(key: string): string {
  if (HOOK_LABEL[key]) return HOOK_LABEL[key];
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b/i;

/**
 * The opening line of a message: the first sentence after the greeting.
 * "Hi {{firstName}},\n\nSaw the county's new ADA plan. Curious…" → "Saw the
 * county's new ADA plan."
 */
export function openingLineOf(body: unknown): string {
  const text = String(body ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let i = 0;
  // A greeting line ("Hi Jane," / "Hello there!") is not the opener.
  if (lines[0] && GREETING.test(lines[0]) && lines[0].length <= 60 && (/[,!:]$/.test(lines[0]) || lines[0].split(" ").length <= 3)) i = 1;
  let line = lines[i] ?? "";
  // "Hi Jane, saw the county's new plan." — a greeting run into the opener.
  if (i === 0 && GREETING.test(line)) line = line.replace(/^[^,!:]{0,40}[,!:]\s*/, "");
  const first = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  return first.trim().slice(0, 240);
}

/* ── Tallies ────────────────────────────────────────────────────────────── */

/** Below this many contacted prospects a rate is noise: show the counts, not a ranking. */
export const MIN_SAMPLE = 10;

export type Tally = { written: number; contacted: number; replied: number; positive: number; meetings: number };

export const emptyTally = (): Tally => ({ written: 0, contacted: 0, replied: 0, positive: 0, meetings: 0 });

export function pct(n: number, of: number): number {
  return of > 0 ? Math.round((n / of) * 1000) / 10 : 0;
}

/** "3 of 12 replied (25%)", or "3 of 7 replied" while the sample is too small for a rate. */
export function replyLabel(t: Pick<Tally, "contacted" | "replied">): string {
  if (!t.contacted) return "not contacted yet";
  const base = `${t.replied} of ${t.contacted} replied`;
  return t.contacted >= MIN_SAMPLE ? `${base} (${pct(t.replied, t.contacted)}%)` : base;
}

/**
 * Best first, by reply rate, for rows with enough contacted prospects to say;
 * rows below MIN_SAMPLE follow, by how many were contacted.
 */
export function rankByReplies<T extends Tally>(rows: T[]): T[] {
  const enough = rows.filter((r) => r.contacted >= MIN_SAMPLE);
  const few = rows.filter((r) => r.contacted < MIN_SAMPLE);
  enough.sort((a, b) => pct(b.replied, b.contacted) - pct(a.replied, a.contacted) || pct(b.meetings, b.contacted) - pct(a.meetings, a.contacted) || b.contacted - a.contacted);
  few.sort((a, b) => b.contacted - a.contacted || b.replied - a.replied || b.written - a.written);
  return [...enough, ...few];
}
