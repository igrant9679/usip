/**
 * Elsie Assist: the rules that pick what she suggests (shared/elsieAssist.ts
 * has the why). Pure: each takes what a page's own endpoint already returned
 * and gives back candidates, so the pane can never disagree with the page it
 * sits beside, and every line here can be tested with plain data.
 *
 * A candidate's title says what to do, its reason says what the records show,
 * and its action is either a page to open or a request put to Elsie in her
 * chat (where a change still shows its confirm card).
 */
import { plural, type AssistCandidate } from "@shared/elsieAssist";

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};

/** The attention summary's fields this file reads (routers/attention.ts returns more). */
export type AttentionFacts = {
  unhandledReplies?: { count?: number };
  socialReplies?: { count?: number };
  awaitingDrafts?: { count?: number };
  proposedMeetings?: { count?: number };
  areApprovals?: { count?: number; byCampaign?: Array<{ campaignId: number; name: string; count: number }> };
  routingSuggestions?: { count?: number };
  campaignProposals?: { count?: number };
  pausedCampaigns?: Array<{ id: number; name: string }>;
  digest24h?: { repliesReceived?: number };
};

/* ─── Home ──────────────────────────────────────────────────────────────── */

export function homeCandidates(s: AttentionFacts, extra: { activeCampaigns: number }): AssistCandidate[] {
  const out: AssistCandidate[] = [];
  const replies = n(s.unhandledReplies?.count);
  const social = n(s.socialReplies?.count);
  const drafts = n(s.awaitingDrafts?.count);
  const meetings = n(s.proposedMeetings?.count);
  const approvals = n(s.areApprovals?.count);
  const routing = n(s.routingSuggestions?.count);
  const proposals = n(s.campaignProposals?.count);
  const paused = (s.pausedCampaigns ?? []).length;

  if (replies > 0) {
    const today = n(s.digest24h?.repliesReceived);
    out.push({
      id: `replies_waiting:${replies}`,
      kind: "replies_waiting",
      weight: 100,
      title: `Answer ${replies} ${plural(replies, "reply", "replies")} waiting in Inbox`,
      why: `${replies} ${plural(replies, "reply", "replies")} to your outreach ${plural(replies, "has", "have")} not been handled` + (today > 0 ? `; ${today} arrived in the last 24 hours.` : "."),
      action: { type: "navigate", label: "Open Inbox", href: "/v2/inbox" },
      facts: { unhandledReplies: replies, repliesLast24Hours: today },
    });
  }
  if (meetings > 0) {
    out.push({
      id: `meetings_to_confirm:${meetings}`,
      kind: "meetings_to_confirm",
      weight: 90,
      title: `Check ${meetings} proposed ${plural(meetings, "meeting", "meetings")}`,
      why: `${meetings} ${plural(meetings, "meeting has", "meetings have")} been proposed and ${plural(meetings, "is", "are")} not on the calendar until the prospect confirms.`,
      action: { type: "navigate", label: "Open Meetings", href: "/v2/meetings" },
      facts: { proposedMeetings: meetings },
    });
  }
  if (approvals > 0) {
    const top = [...(s.areApprovals?.byCampaign ?? [])].sort((a, b) => b.count - a.count)[0];
    out.push({
      id: `prospects_to_approve:${approvals}`,
      kind: "prospects_to_approve",
      weight: 80,
      title: `Approve ${approvals} ${plural(approvals, "prospect", "prospects")} waiting in the Revenue Engine`,
      why: top
        ? `Nothing is sent to them until they are approved. ${top.count} of them ${plural(top.count, "is", "are")} in ${top.name}.`
        : "Nothing is sent to them until they are approved.",
      action: { type: "navigate", label: "Open approvals", href: "/are/approvals" },
      facts: { prospectsAwaitingApproval: approvals, ...(top ? { largestQueueCampaign: top.name, largestQueueCount: top.count } : {}) },
    });
  }
  if (drafts > 0) {
    out.push({
      id: `drafts_to_review:${drafts}`,
      kind: "drafts_to_review",
      weight: 70,
      title: `Review ${drafts} ${plural(drafts, "draft", "drafts")} before ${plural(drafts, "it", "they")} can send`,
      why: `${drafts} ${plural(drafts, "email is", "emails are")} written and waiting for a person to approve ${plural(drafts, "it", "them")}.`,
      action: { type: "navigate", label: "Open drafts", href: "/v2/emails?status=awaiting" },
      facts: { draftsAwaitingReview: drafts },
    });
  }
  if (social > 0) {
    out.push({
      id: `social_replies:${social}`,
      kind: "social_replies",
      weight: 65,
      title: `Answer ${social} LinkedIn ${plural(social, "reply", "replies")}`,
      why: `${social} ${plural(social, "reply", "replies")} to your LinkedIn outreach ${plural(social, "has", "have")} not been handled.`,
      action: { type: "navigate", label: "Open social replies", href: "/v2/inbox?tab=social" },
      facts: { unhandledSocialReplies: social },
    });
  }
  if (routing > 0) {
    out.push({
      id: `routing_suggestions:${routing}`,
      kind: "routing_suggestions",
      weight: 50,
      title: `Decide ${routing} best-fit campaign ${plural(routing, "suggestion", "suggestions")}`,
      why: `${routing} ${plural(routing, "person has", "people have")} a suggested campaign waiting for you to accept or dismiss.`,
      action: { type: "navigate", label: "Open the Revenue Engine", href: "/are" },
      facts: { routingSuggestions: routing },
    });
  }
  if (proposals > 0) {
    out.push({
      id: `campaign_proposals:${proposals}`,
      kind: "campaign_proposals",
      weight: 45,
      title: `Look at ${proposals} proposed ${plural(proposals, "campaign", "campaigns")}`,
      why: `${proposals} new ${plural(proposals, "campaign has", "campaigns have")} been proposed from groups of people already in the workspace.`,
      action: { type: "navigate", label: "Open the Revenue Engine", href: "/are" },
      facts: { proposedCampaigns: proposals },
    });
  }
  // Paused campaigns are somebody's decision, so they are not a to-do. The one
  // case worth saying is when that leaves NOTHING running.
  if (extra.activeCampaigns === 0 && paused > 0) {
    out.push({
      id: `campaigns_all_paused:${paused}`,
      kind: "campaigns_all_paused",
      weight: 20,
      title: "No campaign is running",
      why: `${paused} ${plural(paused, "campaign is", "campaigns are")} paused and none is active, so the Revenue Engine is sending nothing.`,
      action: { type: "navigate", label: "Open campaigns", href: "/are/campaigns" },
      facts: { pausedCampaigns: paused, activeCampaigns: 0 },
    });
  }
  return out;
}

/* ─── A campaign's page ─────────────────────────────────────────────────── */

export type StallFacts = {
  topReason: string | null;
  sending?: { dueNow?: number; windowDescription?: string };
  gates?: {
    noEmail?: number;
    noDossier?: number;
    unusableSequence?: number;
    enrichmentFailed?: { count?: number };
    copyHeld?: { count?: number };
    cap?: { cap?: number; sentToday?: number; remaining?: number };
    paused?: { prospects?: number };
    queue?: { working?: number; target?: number };
  };
};

export function campaignCandidates(
  campaign: { id: number; name: string; status: string },
  stall: StallFacts | null,
  approvalsHere: number,
): AssistCandidate[] {
  const out: AssistCandidate[] = [];
  const { id, name } = campaign;
  const g = stall?.gates ?? {};
  const ask = (label: string, prompt: string) => ({ type: "ask" as const, label, prompt });
  const about = `the campaign "${name}" (id ${id})`;

  const blocked = (title: string, why: string, action: AssistCandidate["action"], facts: AssistCandidate["facts"]) =>
    out.push({ id: `campaign_blocked:${id}:${stall?.topReason}`, kind: "campaign_blocked", weight: 100, title, why, action, facts: { campaign: name, ...facts } });

  switch (stall?.topReason) {
    case "workspacePaused":
      blocked(
        "Outbound is paused for the whole workspace",
        "Nothing sends from any campaign while Pause all outbound is on, whatever this campaign's own status.",
        { type: "navigate", label: "Open Workspace overview", href: "/v2/settings/workspace" },
        { reason: "workspace outbound pause is on" },
      );
      break;
    case "campaignNotActive": {
      const draft = campaign.status === "draft";
      blocked(
        draft ? "This campaign is a draft and has not been launched" : `This campaign is ${campaign.status}, so it is sending nothing`,
        draft ? "A draft finds and sends to nobody until it is activated." : "Its steps are held where they are until it is activated again.",
        ask(draft ? "Ask Elsie to launch it" : "Ask Elsie to resume it", `${draft ? "Launch" : "Resume"} ${about}.`),
        { status: campaign.status },
      );
      break;
    }
    case "windowClosed": {
      const due = n(stall.sending?.dueNow);
      blocked(
        `${due} ${plural(due, "step is", "steps are")} due and waiting for the send window`,
        `The workspace only sends inside its send window${stall.sending?.windowDescription ? ` (${stall.sending.windowDescription})` : ""}.`,
        { type: "navigate", label: "Open the send window", href: "/v2/settings/workspace" },
        { stepsDue: due, sendWindow: stall.sending?.windowDescription ?? "" },
      );
      break;
    }
    case "capUsed": {
      const cap = n(g.cap?.cap);
      blocked(
        "Today's send cap for this campaign is used up",
        `It has sent ${n(g.cap?.sentToday)} of its ${cap} for today; sending picks up again tomorrow.`,
        ask("Ask Elsie about the cap", `Should I raise the daily send cap for ${about}? It is ${cap} and is used up today.`),
        { dailySendCap: cap, sentToday: n(g.cap?.sentToday) },
      );
      break;
    }
    case "copyHeld": {
      const c = n(g.copyHeld?.count);
      blocked(
        `${c} ${plural(c, "prospect's sequence is", "prospects' sequences are")} held for a copy check`,
        "Their emails were written but did not pass the checks, so nothing goes to them until the copy is fixed or released.",
        ask("Ask Elsie what is held", `Why is the copy held for ${c} ${plural(c, "prospect", "prospects")} in ${about}, and what should I do about it?`),
        { prospectsWithCopyHeld: c },
      );
      break;
    }
    case "noEmail": {
      const c = n(g.noEmail);
      blocked(
        `${c} approved ${plural(c, "prospect has", "prospects have")} no email address`,
        "They are approved, and an email step cannot go to someone with no address.",
        ask("Ask Elsie what to do", `${c} approved ${plural(c, "prospect has", "prospects have")} no email address in ${about}. What are my options?`),
        { approvedWithoutEmail: c },
      );
      break;
    }
    case "unusableSequence": {
      const c = n(g.unusableSequence);
      blocked(
        `${c} ${plural(c, "prospect has", "prospects have")} a sequence that cannot be sent`,
        "Their sequence is missing steps or copy, so the engine skips them.",
        ask("Ask Elsie what to do", `${c} ${plural(c, "prospect has", "prospects have")} an unusable sequence in ${about}. How do I fix that?`),
        { prospectsWithUnusableSequence: c },
      );
      break;
    }
    case "noDossier": {
      const c = n(g.noDossier);
      blocked(
        `${c} ${plural(c, "prospect is", "prospects are")} waiting on research before copy can be written`,
        "The engine writes to a prospect only after their research is in.",
        ask("Ask Elsie what to do", `${c} ${plural(c, "prospect has", "prospects have")} no research yet in ${about}. What is holding that up?`),
        { prospectsWithoutResearch: c },
      );
      break;
    }
    case "enrichmentFailed": {
      const c = n(g.enrichmentFailed?.count);
      blocked(
        `Enrichment failed for ${c} ${plural(c, "prospect", "prospects")}`,
        "They cannot move forward until enrichment succeeds or they are removed.",
        ask("Ask Elsie why", `Enrichment failed for ${c} ${plural(c, "prospect", "prospects")} in ${about}. Why, and what should I do?`),
        { enrichmentFailures: c },
      );
      break;
    }
    case "prospectsPaused": {
      const c = n(g.paused?.prospects);
      blocked(
        `${c} ${plural(c, "prospect is", "prospects are")} paused in this campaign`,
        "A paused prospect keeps their place and gets nothing until resumed.",
        ask("Ask Elsie who is paused", `Which prospects are paused in ${about}, and why?`),
        { pausedProspects: c },
      );
      break;
    }
    case "queueFull": {
      const target = n(g.queue?.target);
      blocked(
        "This campaign has reached its prospect target",
        `It is working ${n(g.queue?.working)} against a target of ${target}, so it has stopped looking for new people.`,
        ask("Ask Elsie about the target", `${about} has reached its prospect target of ${target}. Should I raise it?`),
        { prospectTarget: target, prospectsInQueue: n(g.queue?.working) },
      );
      break;
    }
    default:
      break;
  }

  if (approvalsHere > 0) {
    out.push({
      id: `campaign_approvals:${id}:${approvalsHere}`,
      kind: "campaign_approvals",
      weight: 80,
      title: `Approve ${approvalsHere} ${plural(approvalsHere, "prospect", "prospects")} waiting in this campaign`,
      why: `${approvalsHere} ${plural(approvalsHere, "is", "are")} enriched and waiting for approval; nothing is sent to them before that.`,
      action: { type: "navigate", label: "Open approvals", href: "/are/approvals" },
      facts: { campaign: name, prospectsAwaitingApproval: approvalsHere },
    });
  }
  return out;
}

/* ─── Inbox ─────────────────────────────────────────────────────────────── */

export function inboxCandidates(s: AttentionFacts, byClass: Record<string, number>): AssistCandidate[] {
  const out: AssistCandidate[] = [];
  const total = n(s.unhandledReplies?.count);
  const meet = n(byClass.willing_to_meet);
  const question = n(byClass.follow_up_question);
  const referral = n(byClass.person_referral);
  const social = n(s.socialReplies?.count);

  if (meet > 0) {
    out.push({
      id: `interested_replies:${meet}`,
      kind: "interested_replies",
      weight: 110,
      title: `Start with the ${meet} ${plural(meet, "reply", "replies")} willing to meet`,
      why: `${meet} unanswered ${plural(meet, "reply was", "replies were")} classified as willing to meet, out of ${total} waiting.`,
      action: { type: "ask", label: "Ask Elsie which first", prompt: "Which unanswered replies are willing to meet? List them, newest first, and tell me which to answer first." },
      facts: { willingToMeet: meet, unhandledReplies: total },
    });
  }
  if (question > 0 || referral > 0) {
    const parts = [
      question > 0 ? `${question} ${plural(question, "asks", "ask")} a question` : "",
      referral > 0 ? `${referral} ${plural(referral, "points", "point")} you to someone else` : "",
    ].filter(Boolean);
    out.push({
      id: `replies_waiting:classes:${question}:${referral}`,
      kind: "replies_waiting",
      weight: 95,
      title: "Answer the replies that asked for something",
      why: `Of the unanswered replies, ${parts.join(" and ")}.`,
      action: { type: "ask", label: "Ask Elsie to list them", prompt: "List the unanswered replies that ask a question or refer me to someone else, newest first." },
      facts: { askingAQuestion: question, referrals: referral },
    });
  }
  if (total > 0 && meet === 0 && question === 0 && referral === 0) {
    out.push({
      id: `replies_waiting:${total}`,
      kind: "replies_waiting",
      weight: 90,
      title: `${total} ${plural(total, "reply is", "replies are")} waiting for an answer`,
      why: `${total} ${plural(total, "reply", "replies")} to your outreach ${plural(total, "has", "have")} not been handled.`,
      action: { type: "ask", label: "Ask Elsie which first", prompt: "Which unanswered replies should I answer first, and why?" },
      facts: { unhandledReplies: total },
    });
  }
  if (social > 0) {
    out.push({
      id: `social_replies:${social}`,
      kind: "social_replies",
      weight: 65,
      title: `Answer ${social} LinkedIn ${plural(social, "reply", "replies")}`,
      why: `${social} ${plural(social, "reply", "replies")} to your LinkedIn outreach ${plural(social, "has", "have")} not been handled.`,
      action: { type: "navigate", label: "Open social replies", href: "/v2/inbox?tab=social" },
      facts: { unhandledSocialReplies: social },
    });
  }
  return out;
}

/* ─── A person's record ─────────────────────────────────────────────────── */

const REPLY_CLASS_WORDS: Record<string, string> = {
  willing_to_meet: "willing to meet",
  follow_up_question: "a question",
  person_referral: "a referral to someone else",
  out_of_office: "an out-of-office note",
  already_left_company_or_not_right_person: "not the right person",
  not_interested: "not interested",
  unsubscribe: "an unsubscribe request",
};

export type PersonFacts = {
  id: number;
  hasEmail: boolean;
  repliesWaiting: number;
  latestReplyClass: string | null;
  overdueTasks: number;
  /** Campaign rows for this person's email address. */
  campaigns: Array<{ name: string; status: string }>;
};

export function personCandidates(p: PersonFacts): AssistCandidate[] {
  const out: AssistCandidate[] = [];
  const replies = n(p.repliesWaiting);
  const overdue = n(p.overdueTasks);

  if (replies > 0) {
    const cls = p.latestReplyClass ? REPLY_CLASS_WORDS[p.latestReplyClass] : undefined;
    out.push({
      id: `person_reply:${p.id}:${replies}`,
      kind: "person_reply",
      weight: 110,
      title: "This person replied and is waiting for an answer",
      why: `${replies} ${plural(replies, "reply", "replies")} from them ${plural(replies, "has", "have")} not been handled` + (cls ? `; the latest was classified as ${cls}.` : "."),
      action: { type: "navigate", label: "Open Inbox", href: "/v2/inbox" },
      facts: { unhandledRepliesFromThisPerson: replies, latestReplyClassifiedAs: cls ?? "not classified" },
    });
  }
  if (overdue > 0) {
    out.push({
      id: `person_tasks:${p.id}:${overdue}`,
      kind: "person_tasks",
      weight: 85,
      title: `${overdue} ${plural(overdue, "task", "tasks")} for this person ${plural(overdue, "is", "are")} overdue`,
      why: `${overdue} open ${plural(overdue, "task", "tasks")} linked to this person ${plural(overdue, "is", "are")} past ${plural(overdue, "its", "their")} due date.`,
      action: { type: "navigate", label: "Open overdue tasks", href: "/v2/tasks?view=overdue" },
      facts: { overdueTasks: overdue },
    });
  }
  const waiting = p.campaigns.filter((c) => c.status === "pending");
  if (waiting.length > 0) {
    out.push({
      id: `person_campaigns:${p.id}:pending:${waiting.length}`,
      kind: "person_campaigns",
      weight: 75,
      title: "This person is waiting for approval in a campaign",
      why: `They are in the approval queue of ${waiting[0].name}${waiting.length > 1 ? ` and ${waiting.length - 1} more` : ""}; nothing is sent before approval.`,
      action: { type: "navigate", label: "Open approvals", href: "/are/approvals" },
      facts: { campaignsAwaitingApproval: waiting.length, firstCampaign: waiting[0].name },
    });
  } else if (p.campaigns.length === 0 && p.hasEmail && replies === 0) {
    out.push({
      id: `person_campaigns:${p.id}:none`,
      kind: "person_campaigns",
      weight: 40,
      title: "This person is not in any campaign",
      why: "They have an email address and no campaign has them in its queue.",
      action: { type: "ask", label: "Ask Elsie where they fit", prompt: `Which campaign or sequence fits the person with id ${p.id} best? Look them up first, and do not add them to anything yet.` },
      facts: { campaignsContainingThisPerson: 0 },
    });
  }
  return out;
}
