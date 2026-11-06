/**
 * What a segment → sequence auto-enrol rule is doing, and what turning one on
 * would do, in words (audit 2026-10-20, P57, P131, P138).
 *
 * Segments read the CRM contacts table, not People (P21), so every count
 * here is of contacts.
 */

/** segmentRules.preview. `wouldEnrol` is at most: the run also leaves out invalid, suppressed and in-campaign contacts. */
export type RulePreview = {
  refused: string | null;
  matched: number;
  alreadyEnrolled: number;
  wouldEnrol: number;
  contactsInWorkspace: number;
  sequenceStatus: string | null;
};

const contactsWord = (n: number) => `${n.toLocaleString()} contact${n === 1 ? "" : "s"}`;
const isEveryone = (p: RulePreview) => p.matched > 0 && p.matched >= p.contactsInWorkspace;

/**
 * The confirm before a rule is turned on. A segment like "email is not empty"
 * matches nearly everyone, and the next hourly run enrolled them all with no
 * number on the screen first (P57).
 */
export function turnOnSummary(p: RulePreview): { title: string; description: string } {
  if (p.refused) {
    return { title: "Turn on this rule? It would enrol no one now", description: `${p.refused} Turning it on changes nothing until that is fixed.` };
  }
  const lines = [
    `${contactsWord(p.matched)} match the segment now${isEveryone(p) ? ", which is every contact in this workspace" : ""}.`,
    `Up to ${contactsWord(p.wouldEnrol)} would be enrolled on the next hourly run${p.alreadyEnrolled ? `; ${p.alreadyEnrolled.toLocaleString()} are already in the sequence` : ""}.`,
    "Invalid, suppressed and in-campaign contacts are left out then.",
  ];
  if (p.sequenceStatus !== "active") lines.push(`The sequence is ${p.sequenceStatus ?? "missing"}, so no one is enrolled until it is active.`);
  lines.push("Contacts who match later are enrolled too, every hour, until the rule is paused.");
  return { title: `Enrol up to ${contactsWord(p.wouldEnrol)}?`, description: lines.join(" ") };
}

/** "N would enrol" under the Add form, before anyone presses Add. */
export function wouldEnrolLine(p: RulePreview): string {
  if (p.refused) return `Would enrol no one: ${p.refused}`;
  return `Up to ${contactsWord(p.wouldEnrol)} would be enrolled · ${p.matched.toLocaleString()} match${isEveryone(p) ? " (every contact in this workspace)" : ""}`;
}

/**
 * The badge on a rule. It read Active from `enabled` alone, while the run
 * skips a rule whose sequence isn't active or whose segment is gone (P138).
 */
export function ruleState(r: { enabled: boolean; segmentName?: string | null; sequenceStatus?: string | null }): { label: string; enrolling: boolean; why?: string } {
  if (!r.enabled) return { label: "Paused", enrolling: false };
  if (r.segmentName == null) return { label: "Not enrolling", enrolling: false, why: "Its segment no longer exists." };
  if (r.sequenceStatus !== "active") {
    return { label: "Not enrolling", enrolling: false, why: r.sequenceStatus ? `Its sequence is ${r.sequenceStatus}.` : "Its sequence no longer exists." };
  }
  return { label: "Active", enrolling: true };
}

/** The Run now toast: people left out and rules refused are not one number (P131). */
export function runSummary(r: { enrolled: number; peopleSkipped: number; rulesRefused: number }): string {
  const parts = [`${r.enrolled} enrolled`];
  if (r.peopleSkipped) parts.push(`${r.peopleSkipped} contact${r.peopleSkipped === 1 ? "" : "s"} skipped`);
  if (r.rulesRefused) parts.push(`${r.rulesRefused} rule${r.rulesRefused === 1 ? "" : "s"} refused (see ${r.rulesRefused === 1 ? "its row" : "their rows"})`);
  return `Enrollment complete — ${parts.join(" · ")}`;
}
