/**
 * Words the Team page shows about a change, kept pure so they can be tested.
 */

/** A role for a sentence: "an admin", "a super admin". */
export function roleLabel(role: string): string {
  const words = role.replace(/_/g, " ");
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}

/**
 * The toast after team.invite: what happened, not what was asked for (audit
 * 2026-10-20, G47). It said "Invitation email sent" whenever an email was
 * requested, including when it failed.
 */
export function inviteResult(res: { reInvited?: boolean; emailSent?: boolean; emailError?: string | null }): { tone: "success" | "warning"; text: string } {
  if (res.emailSent) return { tone: "success", text: res.reInvited ? "Invitation re-sent" : "Invitation email sent" };
  const what = res.reInvited ? "Invitation renewed" : "Invitation created";
  if (res.emailError) {
    return { tone: "warning", text: `${what}, but the email didn't send: ${res.emailError}. Use Copy link on the team list to share it.` };
  }
  return { tone: "success", text: `${what}. No email was sent; share the activation link.` };
}
