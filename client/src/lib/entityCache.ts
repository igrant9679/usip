/**
 * One refresh per entity family (audit 2026-10-20, X1.7: "mutations that
 * don't refresh sibling screens").
 *
 * Every cached read stays fresh for 30 seconds (client/src/main.tsx). A
 * writer used to invalidate what its own screen showed, by hand, in its own
 * onSuccess — about 590 sites, each a different subset — so the screen next
 * door kept the old rows until the 30 seconds ran out: a person archived on
 * People still sat in an open list's members, a task completed in a drawer
 * still counted on the attention panel, a campaign prospect approved in the
 * dossier still waited in the approvals queue.
 *
 * The rule now, the shape `invalidateEnrollmentReads` (PR #33) and
 * `invalidateDealReads` (R31) set: one function per family names every read
 * that shows that family, and every writer of the family calls it instead of
 * listing reads itself. A subset is the failure mode, so the guard
 * (server/entityCacheInvalidation.test.ts) fails on a hand-written
 * invalidation of a family's reads outside this folder, and on a writer of a
 * family that refreshes nothing without a reviewed reason.
 *
 * Each returns the promise of its refetches, so a caller that awaited its
 * own invalidations (to close a dialog after the list is fresh) still can.
 * Invalidating marks every matching query stale and refetches the ones on
 * screen; nothing off screen is fetched until it is shown again.
 *
 * These do not wrap `onError`: every writer keeps its own, where
 * `clientMutationErrors` can see it.
 */
import { trpc } from "@/lib/trpc";
import { invalidateCustomerReads, invalidateDealReads } from "@/lib/crmCache";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";

export { invalidateCustomerReads, invalidateDealReads, invalidateEnrollmentReads };

type Utils = ReturnType<typeof trpc.useUtils>;

const all = (ps: Array<Promise<unknown> | void>): Promise<void> => Promise.all(ps).then(() => undefined);

/**
 * People: the People table and drawer (`prospects`), CRM contacts
 * (`contacts`), and everything that lists or counts them — list members and
 * counts, a company's people and contact count, duplicate checks, segment
 * members, a person's score, and the attention panel.
 */
export function invalidatePeopleReads(utils: Utils): Promise<void> {
  return all([
    utils.prospects.invalidate(),
    utils.contacts.invalidate(),
    utils.recordLists.invalidate(),
    utils.companies.contacts.invalidate(),
    utils.companies.get.invalidate(),
    utils.accounts.getWithContacts.invalidate(),
    utils.dataHealth.invalidate(),
    utils.segments.getContacts.invalidate(),
    utils.scoring.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}

/**
 * Companies (`companies`, and the CRM `accounts` they are stored as): the
 * Companies page and profile, a contact's company, the customer view of an
 * account, and People rows, which show and filter by company.
 */
export function invalidateCompanyReads(utils: Utils): Promise<void> {
  return all([
    utils.companies.invalidate(),
    utils.accounts.invalidate(),
    utils.accountBriefs.invalidate(),
    utils.contacts.getWithAccount.invalidate(),
    utils.cs.forAccount.invalidate(),
    utils.prospects.list.invalidate(),
    utils.prospects.get.invalidate(),
  ]);
}

/** Leads: the Leads page and drawer, the score breakdown, lead sources, attention. */
export function invalidateLeadReads(utils: Utils): Promise<void> {
  return all([
    utils.leads.invalidate(),
    utils.leadScoring.breakdown.invalidate(),
    utils.dashboards.leadSources.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}

/** Tasks: every task list, the counts, the approval queue, and the attention panel. */
export function invalidateTaskReads(utils: Utils): Promise<void> {
  return all([
    utils.tasks.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}

/**
 * Sequences: the lists and the editor (`sequences`, which includes every
 * enrolment read), A/B variants, the timeline preview, a person's sequences
 * and the drafts each sequence has waiting.
 */
export function invalidateSequenceReads(utils: Utils): Promise<void> {
  return all([
    utils.sequences.invalidate(),
    utils.sequenceAb.invalidate(),
    utils.sequenceTimeline.invalidate(),
    utils.prospects.enrollmentsFor.invalidate(),
    utils.emailActivity.sequenceDraftsWaiting.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}

/**
 * Revenue Engine campaigns: everything under `are` (campaigns, their
 * prospects, sequences, dispatches, signals, metrics, logs, the approvals
 * queue and the ICP), and the attention panel. A campaign write moves many of
 * these at once, which is why the campaign page refreshed its whole set
 * together (useCampaignSync); this is that set, for every screen.
 */
export function invalidateCampaignReads(utils: Utils): Promise<void> {
  return all([
    utils.are.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}

/** Proposals: the list, a proposal and its history, and the deal that shows them. */
export function invalidateProposalReads(utils: Utils): Promise<void> {
  return all([
    utils.proposals.invalidate(),
    utils.opportunities.getWithRelated.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}

/** Lists and segments: lists and members, segments and their rules, and People filtered by them. */
export function invalidateListReads(utils: Utils): Promise<void> {
  return all([
    utils.recordLists.invalidate(),
    utils.segments.invalidate(),
    utils.segmentRules.invalidate(),
    utils.prospects.list.invalidate(),
  ]);
}

/** Meetings: proposals, booked meetings and their counts, the calendar, attention. */
export function invalidateMeetingReads(utils: Utils): Promise<void> {
  return all([
    utils.meetings.invalidate(),
    utils.calendar.invalidate(),
    utils.attention.summary.invalidate(),
  ]);
}
