/**
 * What a segment → sequence auto-enrol rule is doing, and what turning one on
 * would do, in words (audit 2026-10-20, P57, P131, P138).
 *
 * Segments are on People since migration 0363 (P21, F42); a segment not
 * moved still reads CRM contacts, so the words follow the segment.
 */

/**
 * segmentRules.preview. On a People segment (`exact`) the counts are the
 * enrolment's own screen: `wouldEnrol` is who would be enrolled now and
 * `blocked` says why the rest would not. On a contacts segment `wouldEnrol`
 * is at most: the run also leaves out invalid, suppressed and in-campaign
 * contacts.
 */
export type RulePreview = {
  refused: string | null;
  matched: number;
  alreadyEnrolled: number;
  wouldEnrol: number;
  contactsInWorkspace: number;
  sequenceStatus: string | null;
  subject?: "people" | "contacts";
  exact?: boolean;
  blocked?: { invalidEmail: number; inCampaign: number; suppressed: number };
  sample?: Array<{ id: number; name: string }>;
};

/** "12 people" on a People segment, "12 contacts" on one still on contacts (P21). */
const whoWord = (p: RulePreview, n: number) => p.subject === "people"
  ? `${n.toLocaleString()} ${n === 1 ? "person" : "people"}`
  : `${n.toLocaleString()} contact${n === 1 ? "" : "s"}`;
const everyoneWord = (p: RulePreview) => (p.subject === "people" ? "every person in People" : "every contact in this workspace");
const isEveryone = (p: RulePreview) => p.matched > 0 && p.matched >= p.contactsInWorkspace;
const blockedTotal = (p: RulePreview) => (p.blocked ? p.blocked.invalidEmail + p.blocked.inCampaign + p.blocked.suppressed : 0);

/** "3 blocked: 1 with no usable address, 2 in a campaign", or "". */
export function blockedLine(p: RulePreview): string {
  const b = p.blocked;
  const total = blockedTotal(p);
  if (!b || total === 0) return "";
  const parts = [
    b.invalidEmail ? `${b.invalidEmail} with no usable address` : null,
    b.inCampaign ? `${b.inCampaign} in a campaign` : null,
    b.suppressed ? `${b.suppressed} suppressed` : null,
  ].filter(Boolean);
  return `${total.toLocaleString()} blocked: ${parts.join(", ")}`;
}

/**
 * The auto-enrol dry run (audit 2026-10-20, F42): "Would enrol 12 people ·
 * 3 already enrolled · 2 blocked: …". Nothing is enrolled by asking.
 */
export function dryRunLine(p: RulePreview): string {
  if (p.refused) return `Would enrol no one: ${p.refused}`;
  const parts = [
    `${p.exact ? "Would enrol" : "Would enrol up to"} ${whoWord(p, p.wouldEnrol)}`,
    `${p.alreadyEnrolled.toLocaleString()} already enrolled`,
  ];
  const blocked = blockedLine(p);
  if (blocked) parts.push(blocked);
  else if (p.exact) parts.push("0 blocked");
  return parts.join(" · ");
}

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
    `${whoWord(p, p.matched)} match the segment now${isEveryone(p) ? `, which is ${everyoneWord(p)}` : ""}.`,
    p.exact
      ? `${whoWord(p, p.wouldEnrol)} would be enrolled on the next hourly run; ${p.alreadyEnrolled.toLocaleString()} are already in the sequence${blockedLine(p) ? `, ${blockedLine(p)}` : ""}.`
      : `Up to ${whoWord(p, p.wouldEnrol)} would be enrolled on the next hourly run${p.alreadyEnrolled ? `; ${p.alreadyEnrolled.toLocaleString()} are already in the sequence` : ""}.`,
    p.exact ? "" : "Invalid, suppressed and in-campaign contacts are left out then.",
  ].filter(Boolean);
  if (p.sequenceStatus !== "active") lines.push(`The sequence is ${p.sequenceStatus ?? "missing"}, so no one is enrolled until it is active.`);
  lines.push(`${p.subject === "people" ? "People" : "Contacts"} who match later are enrolled too, every hour, until the rule is paused.`);
  return { title: `Enrol ${p.exact ? "" : "up to "}${whoWord(p, p.wouldEnrol)}?`, description: lines.join(" ") };
}

/** "N would enrol" under the Add form, before anyone presses Add. */
export function wouldEnrolLine(p: RulePreview): string {
  if (p.refused) return `Would enrol no one: ${p.refused}`;
  return `${p.exact ? "" : "Up to "}${whoWord(p, p.wouldEnrol)} would be enrolled · ${p.matched.toLocaleString()} match${isEveryone(p) ? ` (${everyoneWord(p)})` : ""}${p.exact ? ` · ${p.alreadyEnrolled.toLocaleString()} already enrolled${blockedLine(p) ? ` · ${blockedLine(p)}` : ""}` : ""}`;
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
  if (r.peopleSkipped) parts.push(`${r.peopleSkipped} skipped`);
  if (r.rulesRefused) parts.push(`${r.rulesRefused} rule${r.rulesRefused === 1 ? "" : "s"} refused (see ${r.rulesRefused === 1 ? "its row" : "their rows"})`);
  return `Enrollment complete — ${parts.join(" · ")}`;
}
