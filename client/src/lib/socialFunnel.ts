/**
 * The LinkedIn / Social funnel's bands, and where a conversion rate is honest
 * (audit 2026-10-20, G57).
 *
 * unipile.socialFunnelStats answers all six from one call, but not about one
 * population: invites are people, the rest are messages, and the last counts
 * any message that made a meeting. A "% conversion" between bands that aren't
 * a part of the band before printed over 100% whenever a thread ran long. A
 * rate is shown only where the band IS part of the one before it: accepted
 * invites of invites sent, interested replies of replies.
 */
export type SocialFunnelStats = {
  invitesSent?: number; invitesAccepted?: number; openersSent?: number;
  inboundReplies?: number; willingToMeet?: number; meetingsFromSocial?: number;
};

export type SocialStep = { key: string; label: string; value: number; partOfPrev: boolean };

export function socialFunnelSteps(sf: SocialFunnelStats): SocialStep[] {
  return [
    { key: "invited", label: "Invites sent", value: sf.invitesSent ?? 0, partOfPrev: false },
    { key: "accepted", label: "Invites accepted", value: sf.invitesAccepted ?? 0, partOfPrev: true },
    // Every OUTBOUND DM, not just a thread's first, and not only to people
    // invited here; the last band counts messages that produced a meetings row,
    // created `proposed`, a candidate the attendee hasn't agreed to (2026-09-20).
    { key: "openers", label: "Outbound messages", value: sf.openersSent ?? 0, partOfPrev: false },
    { key: "replies", label: "Replies", value: sf.inboundReplies ?? 0, partOfPrev: false },
    { key: "interested", label: "Interested (willing to meet)", value: sf.willingToMeet ?? 0, partOfPrev: true },
    { key: "meetings", label: "Meetings proposed from social", value: sf.meetingsFromSocial ?? 0, partOfPrev: false },
  ];
}

/** "62% conversion", a note saying why there is no rate, or "" for the first band. */
export function socialStepNote(steps: SocialStep[], i: number): string {
  if (i === 0) return "";
  const prev = steps[i - 1];
  const step = steps[i];
  if (!step.partOfPrev) return "a different count — no rate";
  if (prev.value === 0) return "";
  return `${Math.round((step.value / prev.value) * 100)}% conversion`;
}
