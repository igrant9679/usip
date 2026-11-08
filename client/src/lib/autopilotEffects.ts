/**
 * The Autonomy Center's dials, grouped by what each one does when it acts
 * (audit 2026-10-20, U20): it SENDS to people, it SPENDS vendor credits, or
 * it CHANGES records. The dials were one flat list, so "which of these can
 * email a prospect?" meant reading every blurb.
 *
 * Pure: a test holds every dial on the page to a group, so a new autopilot
 * cannot appear without saying which kind it is.
 */
export type AutopilotEffect = "sends" | "spends" | "records";

export const EFFECT_GROUPS: ReadonlyArray<{ effect: AutopilotEffect; title: string; blurb: string }> = [
  { effect: "sends", title: "Sends to people", blurb: "In Autonomous these email, invite or message prospects and visitors on their own; in Approve they draft and wait for you. All of them stop while outbound is paused." },
  { effect: "spends", title: "Spends credits", blurb: "These run lookups that use vendor credits (Reoon, QuickEnrich, LinkedIn lookups), within each source's daily allowance." },
  { effect: "records", title: "Changes records", blurb: "These create tasks, move deals, tune sequences or place people in campaigns. Nothing leaves the building from these alone." },
];

/** Each dial on the Autonomy Center, by key, to what it does when it acts. */
export const AUTOPILOT_EFFECT: Record<string, AutopilotEffect> = {
  meetings: "sends",        // proposes times; Autonomous sends each new invite
  conversations: "sends",   // classifies replies and acts on them, replies included
  social: "sends",          // LinkedIn invites, then an opener on accept
  jobChange: "sends",       // re-engages a person who changed jobs
  chat: "sends",            // the inbound chat agent talks to visitors and books
  chatFollowUp: "sends",    // emails visitors who left without booking
  enrichSweep: "spends",    // Reoon and QuickEnrich credits to find emails
  companyBackfill: "spends", // LinkedIn lookups to read employers
  tasks: "records",         // next-best-action tasks
  deals: "records",         // advances deal stages
  optimization: "records",  // edits sequences, reverted if worse
  routing: "records",       // puts people into campaigns, proposes new ones
};

/** The dials in their groups, in the groups' order; a dial nobody classified lands under "Changes records" and is reported. */
export function groupByEffect<T extends { key: string }>(rows: readonly T[]): Array<{ effect: AutopilotEffect; title: string; blurb: string; rows: T[] }> {
  return EFFECT_GROUPS
    .map((g) => ({ ...g, rows: rows.filter((r) => (AUTOPILOT_EFFECT[r.key] ?? "records") === g.effect) }))
    .filter((g) => g.rows.length > 0);
}
