/**
 * The next thing a classified reply needs, in the words of what "Apply action"
 * does for its class (server/services/replyClassifier.ts applyReplyAction, run
 * by a person). Shown on every row of the one reply workspace (audit
 * 2026-10-20, F25), so a list of replies reads as a list of things to do.
 */
export type ReplyLike = {
  replyClass?: string | null;
  classifiedAt?: string | Date | null;
  handledAt?: string | Date | null;
  autoActionTaken?: string | null;
};

const NEXT: Record<string, string> = {
  willing_to_meet: "Propose a meeting",
  follow_up_question: "Answer their question",
  person_referral: "Contact who they referred",
  out_of_office: "Resume when they're back",
  already_left_company_or_not_right_person: "Flag them as departed",
  not_interested: "Mark not interested",
  unsubscribe: "Suppress their address",
  none_of_the_above: "Read and decide",
};

export function nextActionFor(r: ReplyLike): string {
  if (r.handledAt) return "Handled";
  if (r.autoActionTaken && r.autoActionTaken !== "none") return `Done: ${r.autoActionTaken.replace(/_/g, " ")}`;
  if (!r.classifiedAt || !r.replyClass) return "Classify it";
  return NEXT[r.replyClass] ?? "Read and decide";
}
