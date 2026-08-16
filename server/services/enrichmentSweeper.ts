/**
 * Backlog enrichment sweeper.
 *
 * The first-party email finder (`services/scraper`) only ever ran at SOURCING
 * time, inside the ARE engine, or one prospect at a time from the UI. Nothing
 * ever went back over prospects that predate that path — so a workspace ends up
 * holding hundreds of sourced people who have a real name and a real company
 * domain and no email, which is exactly the input the finder needs.
 *
 * This is that missing loop. It is deliberately boring: pick candidates, run
 * the existing pipeline over them, stop when the cap or the credits run out.
 * There is no new enrichment logic here and there must never be — a second
 * implementation of "find this person's address" would drift from the one the
 * ARE engine uses.
 *
 * TWO passes, each feeding the next (a third — Apollo name→domain via
 * resolveMissingDomains — sat between them until 2026-08-12, when the owner
 * removed Apollo from the prospect waterfall; LinkedIn+QuickEnrich are the
 * single source of truth for company identity):
 *
 *   LinkedIn → company name   (backfillQueueCompanies — most sourced rows have
 *                              a LinkedIn URL and nothing else usable)
 *   name + domain → email     (the scraper + Reoon finder)
 *
 * Cost differs per pass, which is why they are separately controlled. The
 * email pass spends Reoon credits. The LinkedIn pass spends from a separate
 * hard daily cap on the user's own connected account, so it is NOT folded
 * into sweepWorkspace: quietly draining that inside a run the user thinks is
 * about email would be a surprise.
 */
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { and, eq, isNotNull, isNull, ne, notLike, or, sql } from "drizzle-orm";
import { areCampaigns, notifications, prospectQueue, prospects, workspaceSettings, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { workspaceNotifyUserId } from "../_core/activeMembers";
import { resolveVerifiedEmail } from "./scraper";
import { runComprehensiveEnrichment } from "./enrichment/comprehensivePass";
import { getReoonKey, reoonCheckBalance, reoonStatusToUsip, reoonVerifySingle } from "./reoon";
import { getQuickEnrichKey, quickenrichFindEmailByLinkedIn } from "./quickenrich";
import { promoteProspectRow } from "./prospectPromotion";
import { clampSweepCap, SWEEP_DAILY_CAP_DEFAULT } from "@shared/enrichmentLimits";

export type SweepMode = "off" | "approval" | "auto";

/**
 * QuickEnrich outcomes that describe the REQUEST rather than the person.
 *
 * quickenrichFindEmailByLinkedIn already discriminates its misses —
 * `found | no_match | http_error | network_error | unrecognised_shape` — and
 * only `no_match` is a statement about the prospect. The other three mean we
 * never got an answer, which must not be recorded as one. Measured on prod
 * 2026-08-16: 3 of 61 failed rows were `http_error`, retired permanently for
 * a transport blip.
 */
const QUICKENRICH_TRANSPORT_FAILURES = new Set(["http_error", "network_error", "unrecognised_shape"]);

/**
 * The one definition of "this campaign is a demo, don't work it". Lived in
 * apolloEnrich.ts until that module (the only paid-Apollo surface) was removed
 * with the dataCleanup router; the sweeper was its sole remaining caller.
 *
 * Learned the hard way: the first paid pilot spent 17 credits on prospects
 * that belong to NO listed campaign (prospect_queue held 559 rows; the live
 * campaigns accounted for 177). Seeded demo campaigns are worse than useless
 * to work — their people are invented.
 */
export function isEnrichableCampaign(name?: string | null): boolean {
  const n = (name ?? "").trim();
  if (!n) return false; // orphaned prospect: no campaign, no reason to work it
  return !/^\[demo\]/i.test(n);
}

/**
 * Enrichability, expressed in SQL for the LIMITed candidate queries.
 *
 * isEnrichableCampaign (the one JS definition) kept being applied AFTER the
 * SQL `LIMIT`, which lets excluded rows eclipse the whole window: the sweep
 * fetches the N lowest-id SQL matches, the JS filter strips the demo rows, and
 * the page comes back EMPTY while an unlimited count of the same predicate
 * honestly reports dozens. Observed live 2026-08-08 — the card said
 * "46 reachable via QuickEnrich" while the run said "nothing was waiting",
 * from the same workspace in the same minute.
 *
 * These two conditions mirror isEnrichableCampaign exactly: a non-empty
 * campaign name that does not start with "[demo]" (MySQL LIKE is
 * case-insensitive under this schema's *_ci collation, and `[` is literal in
 * LIKE). The JS filter stays on every query as the belt — if the two ever
 * disagree, the JS side wins and the structural test that pins both fails.
 */
function enrichableCampaignSql() {
  return [ne(areCampaigns.name, ""), notLike(areCampaigns.name, "[demo]%")];
}

/**
 * A rejected prospect is not work.
 *
 * reject/bulkReject set `sequenceStatus = "skipped"`, and are.prospects.list
 * excludes those by default — they live in the Rejections tab, deliberately
 * disjoint from the review queue. Every pass here must honour the same rule or
 * it spends real budget on people the user already threw out: measured on this
 * workspace, 163 of 252 queue rows are rejected, and 95 of them look exactly
 * like backfill candidates.
 *
 * NULL is not rejected — an unset status means the prospect was never triaged,
 * so it must not be filtered out by a bare `ne()`.
 */
function notRejected() {
  return or(isNull(prospectQueue.sequenceStatus), ne(prospectQueue.sequenceStatus, "skipped"));
}

export interface SweepResult {
  attempted: number;
  /** Where the attempts landed. The backlog lives in prospect_queue, not prospects. */
  fromQueue: number;
  fromProspects: number;
  emailsFound: number;
  /**
   * QuickEnrich pass: lookups by LinkedIn URL for rows the pattern path can
   * never reach (no company domain). Found emails ALSO count in emailsFound —
   * these are the per-source detail, not a separate total.
   */
  quickenrichAttempted: number;
  quickenrichFound: number;
  /** QuickEnrich credits spent — their billing charges only on delivery, so this equals quickenrichFound. */
  quickenrichCredits: number;
  /** Prospects whose new address verified and were promoted into the CRM. */
  promoted: number;
  creditsQuick: number;
  creditsPower: number;
  /**
   * Diagnostics, persisted with the result so a surprising verdict explains
   * itself. Added after a live run said "nothing was waiting" while the card
   * said "46 reachable" — with these, that contradiction names its own cause
   * from the Last-sweep record instead of needing a debugging session.
   */
  qeKeyPresent: boolean;
  patternCandidates: number;
  qeCandidates: number;
  /** Why the run ended: finished the candidates, hit the cap, or ran dry. */
  stoppedBecause: "done" | "cap" | "no_credits" | "no_key" | "no_candidates";
}

/** A run that did nothing, shaped so callers never special-case null. */
const emptyResult = (stoppedBecause: SweepResult["stoppedBecause"]): SweepResult => ({
  attempted: 0, fromQueue: 0, fromProspects: 0,
  emailsFound: 0,
  quickenrichAttempted: 0, quickenrichFound: 0, quickenrichCredits: 0,
  qeKeyPresent: false, patternCandidates: 0, qeCandidates: 0,
  promoted: 0, creditsQuick: 0, creditsPower: 0, stoppedBecause,
});

/**
 * Reserve a floor of verification credits rather than draining the account.
 * A sweep is bulk backfill; the interactive "Find contact info" button and the
 * ARE engine's own at-sourcing enrichment are worth more per credit, and both
 * fail silently once the balance is gone.
 */
export const CREDIT_FLOOR = 25;

/**
 * Should the sweep keep going? Pure so the stopping rules are testable without
 * a database or a Reoon account.
 */
export function shouldContinue(opts: {
  attempted: number;
  cap: number;
  dailyCreditsLeft: number;
}): boolean {
  if (opts.attempted >= opts.cap) return false;
  if (opts.dailyCreditsLeft <= CREDIT_FLOOR) return false;
  return true;
}

/**
 * Prospects worth attempting: no email yet, a company domain to work from, a
 * real human name, not already rejected by verification, and not attempted
 * before. `prospects` has no free-form website column — companyDomain is the
 * only domain source, and it is exactly what Apollo search supplies for free.
 *
 * `enrichmentData IS NULL` is the "not attempted" marker — the finder writes
 * that column on every run that reaches a company, so it doubles as an attempt
 * log without a dedicated column. `retryFailed` drops that condition for the
 * case where a key was missing the first time round.
 */
async function candidatesFor(workspaceId: number, limit: number, retryFailed: boolean) {
  const db = await getDb();
  if (!db) return [];
  const conds = [
    eq(prospects.workspaceId, workspaceId),
    isNull(prospects.email),
    isNotNull(prospects.companyDomain),
    isNotNull(prospects.firstName),
    isNotNull(prospects.lastName),
    // Never spend credits on a prospect verification already rejected.
    or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected")),
  ];
  // P5.1: lastEnrichedAt finally gates something. Rows attempted long ago
  // and STILL email-less become candidates again after 60 days — providers'
  // coverage grows and people change jobs, so a year-old miss is not a
  // verdict. Bounded by the same cap + credit floor as everything else.
  const STALE_RETRY_MS = 60 * 86_400_000;
  if (!retryFailed) {
    conds.push(or(
      isNull(prospects.enrichmentData),
      and(
        isNotNull(prospects.lastEnrichedAt),
        sql`${prospects.lastEnrichedAt} < ${new Date(Date.now() - STALE_RETRY_MS)}`,
      ),
    )!);
  }
  return db
    .select({
      id: prospects.id,
      firstName: prospects.firstName,
      lastName: prospects.lastName,
      companyDomain: prospects.companyDomain,
      phone: prospects.phone,
    })
    .from(prospects)
    .where(and(...conds))
    .limit(limit);
}

/**
 * ARE campaign prospects worth attempting — and this, NOT `prospects`, is where
 * the backlog actually lives. `prospect_queue` holds everything the autonomous
 * engine sourced; the `prospects` table is the separate People/CRM list, which
 * on a workspace sourcing purely through ARE is empty.
 *
 * Mirrors findEnrichCandidates' guards, for the same reasons: INNER JOIN
 * are_campaigns so an orphaned row whose campaign is gone is never worked, and
 * `[Demo]` campaigns excluded so credits are never spent on invented people.
 *
 * Differs in ONE way: that query requires a linkedinUrl because Apollo matches
 * on it. The free finder needs a company DOMAIN instead, which is exactly what
 * Apollo search supplies at zero credits.
 */
async function queueCandidatesFor(workspaceId: number, limit: number, retryFailed: boolean) {
  const db = await getDb();
  if (!db) return [];
  const conds = [
    eq(prospectQueue.workspaceId, workspaceId),
    or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
    isNotNull(prospectQueue.companyDomain),
    ne(prospectQueue.companyDomain, ""),
    isNotNull(prospectQueue.firstName),
    isNotNull(prospectQueue.lastName),
    notRejected(),
    ...enrichableCampaignSql(),
  ];
  // enrichedAt is the attempt marker here — prospect_queue has a real one, so
  // unlike the prospects table there is nothing to infer from a json column.
  if (!retryFailed) conds.push(isNull(prospectQueue.enrichedAt));

  const rows = await db
    .select({
      id: prospectQueue.id,
      firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName,
      companyDomain: prospectQueue.companyDomain,
      campaignName: areCampaigns.name,
    })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(prospectQueue.campaignId, areCampaigns.id))
    .where(and(...conds))
    .orderBy(prospectQueue.id)
    .limit(limit);

  return rows.filter((r) => isEnrichableCampaign(r.campaignName));
}

/**
 * Queue rows only QuickEnrich can work: a LinkedIn URL and NO company domain.
 *
 * The predicate is the exact complement of queueCandidatesFor's domain
 * requirement, so no row is ever eligible for both passes in one run — the
 * pattern path stays the cheaper choice wherever a domain exists. Measured
 * 2026-08-07: 59 of these rows, 0 pattern candidates — this set IS the
 * stuck backlog. (Since the Apollo domain pre-pass was removed 2026-08-12,
 * QuickEnrich is also the main way a stuck row ever gains an email at all.)
 */
async function quickenrichCandidatesFor(workspaceId: number, limit: number, retryFailed: boolean) {
  const db = await getDb();
  if (!db) return [];
  const conds = [
    eq(prospectQueue.workspaceId, workspaceId),
    or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
    or(isNull(prospectQueue.companyDomain), eq(prospectQueue.companyDomain, "")),
    isNotNull(prospectQueue.linkedinUrl),
    ne(prospectQueue.linkedinUrl, ""),
    notRejected(),
    ...enrichableCampaignSql(),
  ];
  /**
   * Skip only rows QUICKENRICH ITSELF has attempted — identified by the
   * `quickenrich…` prefix this pass writes on every miss — never rows some
   * other pass stamped. This is `76e5f74`'s lesson recurring for a new pass:
   * ~183 rows carry `enrichedAt` from sourcing-time PATTERN attempts that
   * failed precisely because the row had no domain, and a pattern failure on a
   * domain-less row says nothing about whether a LinkedIn lookup succeeds —
   * QuickEnrich doesn't use the domain at all. A bare `isNull(enrichedAt)`
   * here reduced the first production run to 1 candidate out of a measured 59.
   * (A QE hit needs no marker: the row gains an email and exits on that
   * predicate; a QE throw writes nothing and retries next run, same as the
   * pattern loop.)
   */
  if (!retryFailed) {
    conds.push(
      or(
        isNull(prospectQueue.enrichmentError),
        notLike(prospectQueue.enrichmentError, "quickenrich%"),
      ),
    );
  }

  const rows = await db
    .select({
      id: prospectQueue.id,
      linkedinUrl: prospectQueue.linkedinUrl,
      campaignName: areCampaigns.name,
    })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(prospectQueue.campaignId, areCampaigns.id))
    .where(and(...conds))
    .orderBy(prospectQueue.id)
    .limit(limit);

  return rows.filter((r) => isEnrichableCampaign(r.campaignName));
}

/* The Apollo name→domain pre-pass (resolveMissingDomains) lived here until
   2026-08-12 — owner removed Apollo from the prospect waterfall entirely
   (LinkedIn+QuickEnrich are the single source of truth). Queue rows with a
   company name but no domain now gain one only through the comprehensive
   pass's LinkedIn-profile and email-domain paths. */

/**
 * Tell the owner what an unattended run actually did.
 *
 * These engines spend a real budget on a schedule with nobody watching. An
 * engine that reports only to the server log is accountable to whoever reads
 * logs, which is nobody — the first sign of trouble would be a drained
 * allowance and no explanation. Best-effort: a failed notification must never
 * fail the run it is describing.
 */
async function notifyOwner(workspaceId: number, userId: number | null, title: string, body: string): Promise<void> {
  if (!userId) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(notifications).values({
      workspaceId, userId, kind: "system", title, body: body.slice(0, 1000),
    } as never);
  } catch (e) {
    console.error("[EnrichmentSweep] notify failed:", (e as Error).message);
  }
}

// Headline → employer extraction moved to its own pure module so the mapper,
// the comprehensive pass, and the People read-repair can consume it without
// this file's DB-heavy import graph. Re-exported here for existing callers.
import { companyFromHeadline } from "./enrichment/headlineCompany";
export { companyFromHeadline };

/**
 * Fill missing company names on ARE queue rows from their LinkedIn profile.
 *
 * This is the pass that unblocks everything else. Measured on the live
 * workspace, most sourced prospects carry a LinkedIn URL and NOTHING else
 * usable — no company name, so no domain can be resolved, so no address can be
 * derived. Every other pass is downstream of this one.
 *
 * The existing linkedinEnrichment router cannot do this: it takes `prospects`
 * ids and writes to the `prospects` table, while the ARE backlog lives in
 * `prospect_queue`. Same table split that made the first sweeper find nothing.
 *
 * Deliberately NOT folded into sweepWorkspace. LinkedIn lookups draw on a
 * separate, hard daily cap (~100/day on the connected account) and go out
 * through the user's own LinkedIn session; quietly spending that inside a run
 * the user thinks is about email verification would be a surprise. It is its
 * own explicit operation.
 *
 * Stops immediately on rate_limited rather than grinding through the cap.
 * Never throws.
 *
 * Returns a per-status breakdown, not just a filled count. The first live run
 * attempted 25, filled 0, and consumed 25 of a 100/day LinkedIn allowance while
 * saying nothing about why — "we called and got nothing" and "we never really
 * called" are completely different problems, and a bare counter cannot tell
 * them apart. `noCompanyOnProfile` in particular separates a vendor/lookup
 * failure from a profile that genuinely carries no current employer.
 */
export async function backfillQueueCompanies(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  limit?: number;
}): Promise<{
  attempted: number;
  filled: number;
  withDomain: number;
  /** Outcome status → count, straight from RetrieveOutcome. */
  byStatus: Record<string, number>;
  /** Lookup succeeded but the profile carried no current employer. */
  noCompanyOnProfile: number;
  /** Company recovered from the headline because LinkedIn hid the structured fields. */
  fromHeadline: number;
  /** A few real vendor messages, for when the counts alone are not enough. */
  samples: string[];
  stoppedBecause: "done" | "cap" | "rate_limited" | "no_candidates";
}> {
  const db = await getDb();
  const empty = { attempted: 0, filled: 0, withDomain: 0, byStatus: {} as Record<string, number>, noCompanyOnProfile: 0, fromHeadline: 0, samples: [] as string[] };
  if (!db) return { ...empty, stoppedBecause: "no_candidates" as const };
  const cap = Math.max(1, Math.min(100, opts.limit ?? 25));

  const rows = await db
    .select({ id: prospectQueue.id, linkedinUrl: prospectQueue.linkedinUrl, campaignName: areCampaigns.name })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(prospectQueue.campaignId, areCampaigns.id))
    .where(and(
      eq(prospectQueue.workspaceId, opts.workspaceId),
      isNotNull(prospectQueue.linkedinUrl),
      ne(prospectQueue.linkedinUrl, ""),
      or(isNull(prospectQueue.companyName), eq(prospectQueue.companyName, "")),
      or(isNull(prospectQueue.companyDomain), eq(prospectQueue.companyDomain, "")),
      notRejected(),
    ))
    .orderBy(prospectQueue.id)
    .limit(cap);

  const live = rows.filter((r) => isEnrichableCampaign(r.campaignName));
  if (live.length === 0) return { ...empty, stoppedBecause: "no_candidates" as const };

  const { retrieveLinkedInProfileByUrl } = await import("./linkedinEnrichment/unipileProfile");
  let attempted = 0, filled = 0, withDomain = 0, noCompanyOnProfile = 0, fromHeadline = 0;
  const byStatus: Record<string, number> = {};
  const samples: string[] = [];
  let stoppedBecause: "done" | "cap" | "rate_limited" | "no_candidates" = "done";

  for (const r of live) {
    if (attempted >= cap) { stoppedBecause = "cap"; break; }
    attempted++;
    try {
      const out = await retrieveLinkedInProfileByUrl({
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        isAdmin: opts.isAdmin,
        linkedinUrl: r.linkedinUrl ?? "",
      });
      byStatus[out.status] = (byStatus[out.status] ?? 0) + 1;
      if (samples.length < 3 && out.status !== "enriched" && out.message) samples.push(`${out.status}: ${out.message}`.slice(0, 200));
      if (out.status === "rate_limited") { stoppedBecause = "rate_limited"; break; }
      // `headline`, not `currentTitle`. Since 2026-08-14 currentTitle is the
      // structured Experience job title ("VP of Sales"), which names no
      // employer — reading it here would silently end headline-derived
      // company recovery.
      const headlineCompany = companyFromHeadline((out.profile as unknown as { headline?: string | null })?.headline);
      const company = out.profile?.currentCompanyName ?? headlineCompany;
      const domain = out.profile?.currentCompanyDomain ?? null;
      if (!out.profile?.currentCompanyName && headlineCompany) fromHeadline++;
      if (!company && !domain) {
        if (out.profile) {
          noCompanyOnProfile++;
          // Include the headline and how much of the profile came back. A
          // headline like "Executive Director at Acme Foundation" carries the
          // employer even when current_company and work_experience are empty,
          // which is the difference between "LinkedIn will not show us this"
          // and "we are not reading what it did show us".
          if (samples.length < 3) {
            const pr = out.profile as unknown as { fullName?: string | null; headline?: string | null; title?: string | null; experience?: unknown[]; connectionDegree?: string | null };
            samples.push(JSON.stringify({
              name: pr.fullName ?? null,
              headline: pr.headline ?? null,
              experienceEntries: Array.isArray(pr.experience) ? pr.experience.length : 0,
              degree: pr.connectionDegree ?? null,
            }).slice(0, 300));
          }
        }
        continue;
      }
      // Clear enrichedAt for the same reason the domain pass does: the earlier
      // failure happened because these fields were missing, so it says nothing
      // about whether the finder can succeed now that they are not.
      const patch: Record<string, unknown> = { enrichedAt: null, enrichmentStatus: "pending" };
      if (company) patch.companyName = company.slice(0, 200);
      if (domain) { patch.companyDomain = domain.slice(0, 200); withDomain++; }
      await db.update(prospectQueue).set(patch as never).where(eq(prospectQueue.id, r.id));
      filled++;
    } catch (e) {
      console.error(`[EnrichmentSweep] LinkedIn backfill for queue ${r.id} failed:`, (e as Error).message);
    }
  }
  return { attempted, filled, withDomain, byStatus, noCompanyOnProfile, fromHeadline, samples, stoppedBecause };
}

/**
 * Why the candidate count is what it is.
 *
 * "0 waiting" has several very different causes — nothing left to do, everything
 * already attempted, or (the one that actually bites) prospects sourced without
 * a company domain, which the free finder cannot work from. Reporting the bare
 * count hides that distinction and invites the wrong conclusion, which is how
 * this feature shipped pointed at an empty table in the first place.
 */
export async function queueDiagnostics(workspaceId: number): Promise<{
  noEmailTotal: number;
  withDomain: number;
  /** No email AND no domain — needs domain resolution before it can be worked. */
  needsDomain: number;
  /**
   * No company name AND no domain, but a LinkedIn URL to read one from — the
   * backfill's actual candidate set. Distinct from needsDomain: a row can have
   * a company and still lack a domain, and reporting one as the other
   * misstates how much work is left by a wide margin.
   */
  needsCompanyWithLinkedIn: number;
  alreadyAttempted: number;
}> {
  const db = await getDb();
  if (!db) return { noEmailTotal: 0, withDomain: 0, needsDomain: 0, needsCompanyWithLinkedIn: 0, alreadyAttempted: 0 };
  const rows = await db
    .select({
      domain: prospectQueue.companyDomain,
      companyName: prospectQueue.companyName,
      linkedinUrl: prospectQueue.linkedinUrl,
      enrichedAt: prospectQueue.enrichedAt,
      campaignName: areCampaigns.name,
    })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(prospectQueue.campaignId, areCampaigns.id))
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
      notRejected(),
    ));
  const live = rows.filter((r) => isEnrichableCampaign(r.campaignName));
  const has = (v: string | null) => !!(v ?? "").trim();
  return {
    noEmailTotal: live.length,
    withDomain: live.filter((r) => has(r.domain)).length,
    needsDomain: live.filter((r) => !has(r.domain)).length,
    needsCompanyWithLinkedIn: live.filter((r) => !has(r.companyName) && !has(r.domain) && has(r.linkedinUrl)).length,
    alreadyAttempted: live.filter((r) => !!r.enrichedAt).length,
  };
}

/**
 * How many candidates are waiting, for the UI to show before anyone spends.
 * Counts BOTH tables — reporting only `prospects` is what made the first
 * version of this report a confident zero on a workspace with a real backlog.
 */
export async function countCandidates(workspaceId: number, retryFailed = false): Promise<number> {
  const [p, q] = await Promise.all([
    candidatesFor(workspaceId, 10000, retryFailed),
    queueCandidatesFor(workspaceId, 10000, retryFailed),
  ]);
  return p.length + q.length;
}

/**
 * How many rows the QuickEnrich pass could work, for the card. Counted
 * separately from countCandidates because the two sets are disjoint by
 * construction and the card labels them differently — folding them into one
 * number would hide which pipeline can move, which is the exact ambiguity
 * queueDiagnostics exists to prevent.
 */
export async function countQuickenrichCandidates(workspaceId: number, retryFailed = false): Promise<number> {
  return (await quickenrichCandidatesFor(workspaceId, 10000, retryFailed)).length;
}

/**
 * Sweep one workspace. Never throws — a single bad domain must not abort a
 * 50-prospect run, and the caller (a cron) has nowhere useful to report to.
 */
export async function sweepWorkspace(
  workspaceId: number,
  opts: { limit?: number; retryFailed?: boolean } = {},
): Promise<SweepResult> {
  const db = await getDb();
  if (!db) return emptyResult("no_key");

  const cap = clampSweepCap(opts.limit ?? SWEEP_DAILY_CAP_DEFAULT);
  const retry = opts.retryFailed ?? false;

  // Every exit from here on stamps the run (the `finally` below), or the
  // cron's 20-hour gate never engages for exactly the runs that end early —
  // no key, no candidates, or a failed balance check would quietly repeat the
  // domain pass on every 6-hour tick, and "daily means daily" would hold only
  // on the happy path.
  //
  // `outcome` mirrors whatever each exit returns, so the finally can PERSIST
  // the result next to the stamp. Before 0147 the result lived only in the
  // caller's toast (gone in ~4s) or the cron's owner notification — a user who
  // blinked had no way to see what their own run just did. Null only if the
  // body threw, which "never throws" makes unexpected — nothing is persisted
  // then, because a fabricated result row would be worse than an absent one.
  let outcome: SweepResult | null = null;
  try {
    const key = await getReoonKey(workspaceId);
    if (!key) {
      // The key gates the email pass only; report what the free pass did so
      // the caller can tell "did nothing" from "did the unpaid half".
      return (outcome = emptyResult("no_key"));
    }

    // Queue first: it is where the ARE backlog lives, and those rows are the ones
    // a campaign will actually mail once they have an address. QuickEnrich
    // candidates are queried only when a key exists, so a workspace without one
    // keeps the exact pre-integration behaviour, including its no_candidates
    // verdict.
    const qeKey = await getQuickEnrichKey(workspaceId);
    const [queueRows, rows, qeRows] = await Promise.all([
      queueCandidatesFor(workspaceId, cap, retry),
      candidatesFor(workspaceId, cap, retry),
      qeKey ? quickenrichCandidatesFor(workspaceId, cap, retry) : Promise.resolve([]),
    ]);
    const counts = {
      qeKeyPresent: qeKey.length > 0,
      patternCandidates: rows.length + queueRows.length,
      qeCandidates: qeRows.length,
    };
    if (rows.length === 0 && queueRows.length === 0 && qeRows.length === 0) {
      return (outcome = { ...emptyResult("no_candidates"), ...counts });
    }

    // One balance read up front, then decremented locally. Re-reading per
    // prospect would add a network round trip to every single lookup.
    let dailyCreditsLeft = 0;
    try {
      const balance = await reoonCheckBalance(key);
      dailyCreditsLeft = balance.remaining_daily_credits ?? 0;
    } catch (e) {
      console.error("[EnrichmentSweep] balance check failed:", (e as Error).message);
      return (outcome = { ...emptyResult("no_credits"), ...counts });
    }

    const result: SweepResult = {
      ...emptyResult("done"),
      ...counts,
    };

    // ── QuickEnrich rows (LinkedIn URL, no domain) ──
    // These are the rows every other pass is structurally blind to: patterns
    // need a domain, the domain pass needs a company name, and these rows have
    // neither — only a LinkedIn URL, which is exactly QuickEnrich's lookup key.
    // Runs FIRST so the stuck majority of the backlog is not starved by the
    // shared cap; rides the same shouldContinue budget as the other passes.
    for (const q of qeRows) {
      if (!shouldContinue({ attempted: result.attempted, cap, dailyCreditsLeft })) {
        result.stoppedBecause = result.attempted >= cap ? "cap" : "no_credits";
        break;
      }
      try {
        const found = await quickenrichFindEmailByLinkedIn(qeKey, q.linkedinUrl ?? "");
        result.attempted++;
        result.fromQueue++;
        result.quickenrichAttempted++;
        // Stamp enrichedAt on EVERY attempt, hit or miss — same contract as the
        // pattern pass: the marker that stops the next run paying to re-check.
        const patch: Record<string, unknown> = { enrichedAt: new Date() };
        if (found.email) {
          result.quickenrichCredits++; // their billing charges only on delivery
          // Their word is never send-safe: Reoon power-verifies every hit. An
          // invalid verdict means the address is NOT written — unlike a pattern
          // guess, a wrong database entry looks exactly like a right one.
          let status = "unknown";
          try {
            const v = await reoonVerifySingle(found.email, key, "power");
            result.creditsPower++;
            dailyCreditsLeft--;
            status = reoonStatusToUsip(v.status);
          } catch {
            /* verification unavailable → keep the address, flagged by status "unknown" */
          }
          if (status === "invalid") {
            patch.enrichmentStatus = "failed";
            patch.enrichmentError = "quickenrich hit failed Reoon verification (invalid)";
          } else {
            patch.email = found.email;
            patch.enrichmentStatus = "complete";
            result.emailsFound++;
            result.quickenrichFound++;
          }
        } else if (QUICKENRICH_TRANSPORT_FAILURES.has(found.reason)) {
          /**
           * A request that did not complete says nothing about the prospect.
           *
           * This marked EVERY empty result `failed`, and `failed` is terminal
           * — the ARE's enrichment selector reads only pending/enriching, so a
           * sweeper verdict permanently removed the row from both engines. A
           * 500 from the vendor, a socket reset, or a response shape we did
           * not recognise thereby retired a prospect forever. Same failure as
           * the day-9 brand search returning [] for a dead key and a genuine
           * miss alike: the reason vocabulary already told us which was which,
           * and the caller threw it away.
           *
           * Left `pending` so the next pass retries, with the reason recorded
           * for anyone reading the row. Deliberately NOT stamping enrichedAt:
           * that marker means "we have looked", and we have not.
           */
          patch.enrichmentError = `quickenrich: ${found.reason} — transport failure, will retry`.slice(0, 500);
          delete patch.enrichedAt;
        } else {
          // A genuine miss: the vendor answered, and this person is not in it.
          patch.enrichmentStatus = "failed";
          patch.enrichmentError = `quickenrich: ${found.reason}`.slice(0, 500);
        }
        await db.update(prospectQueue).set(patch as never).where(eq(prospectQueue.id, q.id));
      } catch (e) {
        result.attempted++;
        result.fromQueue++;
        result.quickenrichAttempted++;
        console.error(`[EnrichmentSweep] quickenrich prospect ${q.id} failed:`, (e as Error).message);
      }
    }

    // ── ARE queue rows ──
    // resolveVerifiedEmail is the SAME resolver the ARE engine calls at sourcing
    // time; only the write-back differs, because lookupContactInfo persists to the
    // prospects table and these rows live in prospect_queue.
    for (const q of queueRows) {
      if (!shouldContinue({ attempted: result.attempted, cap, dailyCreditsLeft })) {
        result.stoppedBecause = result.attempted >= cap ? "cap" : "no_credits";
        break;
      }
      try {
        const found = await resolveVerifiedEmail({
          firstName: q.firstName,
          lastName: q.lastName,
          companyDomain: q.companyDomain,
          companyWebsite: q.companyDomain,
          workspaceId,
        });
        result.attempted++;
        result.fromQueue++;
        result.creditsQuick += found.creditsQuick ?? 0;
        result.creditsPower += found.creditsPower ?? 0;
        dailyCreditsLeft -= found.creditsPower ?? 0;
        // Stamp enrichedAt on EVERY attempt, hit or miss — it is the marker that
        // stops the next sweep paying to re-check the same miss forever.
        const patch: Record<string, unknown> = {
          enrichedAt: new Date(),
          enrichmentStatus: found.email ? "complete" : "failed",
        };
        if (found.email) {
          patch.email = found.email;
          result.emailsFound++;
        } else if (found.reason) {
          patch.enrichmentError = found.reason.slice(0, 500);
        }
        await db.update(prospectQueue).set(patch as never).where(eq(prospectQueue.id, q.id));
      } catch (e) {
        result.attempted++;
        result.fromQueue++;
        console.error(`[EnrichmentSweep] queue prospect ${q.id} failed:`, (e as Error).message);
      }
    }

    // ── prospects (People/CRM) rows ──
    for (const p of rows) {
      if (!shouldContinue({ attempted: result.attempted, cap, dailyCreditsLeft })) {
        result.stoppedBecause = result.attempted >= cap ? "cap" : "no_credits";
        break;
      }
      try {
        // The comprehensive pass — the sweep is just another trigger now.
        // Runs the whole funnel (LinkedIn data on file, Apollo domain,
        // QuickEnrich, pattern+Reoon, scrape) with provenance-aware merge.
        // queueLinkedInJob false: a 25-row sweep must not spawn 25 async
        // profile jobs; profile lookups stay on their own triggers/caps.
        const r = await runComprehensiveEnrichment({
          workspaceId,
          prospectId: p.id,
          userId: 0, // system sweep — no acting user; no LinkedIn job queued
          trigger: "sweep",
          queueLinkedInJob: false,
        });
        result.attempted++;
        result.fromProspects++;
        result.creditsQuick += r.credits.quick;
        result.creditsPower += r.credits.power;
        dailyCreditsLeft -= r.credits.power;
        if (r.email) {
          result.emailsFound++;
          /**
           * The last link in import → clean → enrol.
           *
           * A found address is only useful once the person is a CONTACT: the
           * sweeper works `prospects`, and segment→sequence rules only ever read
           * `contacts`. promoteVerifiedProspect applies the product rule — it
           * promotes on a `valid` verdict and refuses accept_all / risky — so an
           * unverified row can never reach a campaign.
           *
           * Best-effort and per row: a promotion that fails must not abort a
           * sweep that has already spent credits on the rest of the batch, and
           * the row keeps its found address either way, so the next run retries
           * the promotion without paying again.
           */
          try {
            const outcome = await promoteProspectRow(workspaceId, p.id);
            if (outcome.promoted && !outcome.alreadyLinked) result.promoted++;
          } catch (e) {
            console.error(`[EnrichmentSweep] promotion failed for prospect ${p.id}:`, (e as Error).message);
          }
        }
      } catch (e) {
        // Count the attempt anyway: a prospect that reliably throws must not be
        // retried forever inside the same run.
        result.attempted++;
        result.fromProspects++;
        console.error(`[EnrichmentSweep] prospect ${p.id} failed:`, (e as Error).message);
      }
    }

    return (outcome = result);
  } finally {
    try {
      await db
        .update(workspaceSettings)
        .set({
          enrichmentSweepLastRunAt: new Date(),
          // The full result, with its own timestamp: the sweep card renders
          // this, so a run's numbers outlive the toast. Written for cron and
          // manual runs alike because it happens HERE and not in a caller.
          ...(outcome
            ? { enrichmentSweepLastResult: { ...outcome, at: new Date().toISOString() } }
            : {}),
        } as never)
        .where(eq(workspaceSettings.workspaceId, workspaceId));
    } catch { /* stamp only */ }
  }
}

/**
 * Cron entry point for the LinkedIn company backfill.
 *
 * Runs `auto` workspaces only — `approval` means attended, i.e. the
 * prospects.backfillCompanies button, exactly as with the sweep.
 *
 * Why a schedule at all: measured yield is ~30% (only some LinkedIn headlines
 * name an employer), so a couple of hundred rows is several days of a ~100/day
 * allowance. That is a cadence, not a task, and a capped daily run is the
 * honest shape for it.
 *
 * Attributed to the workspace owner with admin rights, so the lookup may use
 * any bridged LinkedIn account in the workspace pool rather than depending on
 * whoever happened to trigger it.
 */
export async function runCompanyBackfillAllWorkspaces(): Promise<{ workspaces: number; filled: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, filled: 0 };

  const rows = await db
    .select({
      id: workspaces.id,
      mode: workspaceSettings.companyBackfillMode,
      cap: workspaceSettings.companyBackfillDailyCap,
      lastRunAt: workspaceSettings.companyBackfillLastRunAt,
    })
    .from(workspaces)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id));

  let touched = 0, filled = 0;
    const archivedWs = await archivedWorkspaceIds();
  for (const ws of rows) {
    if (archivedWs.has(ws.id)) continue; // archived workspaces are frozen (2026-08-12)
    if (ws.mode !== "auto") continue;
    /**
     * Resolved once and used for all three: the run gate, the acting user, and
     * the report at the end. The raw column gated only on being NON-NULL, so a
     * workspace whose owner had been deleted still ran the whole backfill —
     * spending the LinkedIn daily allowance — and then reported it to a user id
     * that cannot sign in. A run nobody hears about is worse than no run: the
     * allowance is gone either way.
     */
    const recipient = await workspaceNotifyUserId(ws.id);
    if (!recipient) continue;
    // Daily means daily. The cron ticks more often so a restart cannot turn
    // the cap into a per-boot allowance.
    if (ws.lastRunAt && Date.now() - new Date(ws.lastRunAt).getTime() < 20 * 60 * 60 * 1000) continue;
    try {
      const r = await backfillQueueCompanies({
        workspaceId: ws.id,
        userId: recipient,
        isAdmin: true,
        limit: ws.cap ?? 50,
      });
      // Stamp even on a zero-fill run: without it a workspace with nothing left
      // to do would retry every tick and burn the allowance discovering that.
      await db.update(workspaceSettings)
        .set({ companyBackfillLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.id))
        .catch(() => {});
      if (r.attempted > 0 || r.stoppedBecause === "rate_limited") {
        touched++;
        filled += r.filled;
        console.log(`[CompanyBackfill] ws=${ws.id} attempted=${r.attempted} filled=${r.filled} fromHeadline=${r.fromHeadline} stopped=${r.stoppedBecause}`);
        const left = await queueDiagnostics(ws.id).then((q) => q.needsCompanyWithLinkedIn).catch(() => null);
        const why = r.stoppedBecause === "rate_limited"
          ? " Stopped early — the LinkedIn daily lookup limit was reached."
          : r.stoppedBecause === "cap" ? " Stopped at the daily cap." : "";
        await notifyOwner(
          ws.id, recipient,
          `Company Backfill: filled ${r.filled} of ${r.attempted}`,
          `Read ${r.attempted} LinkedIn profile${r.attempted === 1 ? "" : "s"} and found an employer for ${r.filled}.`
          + (r.noCompanyOnProfile > 0 ? ` ${r.noCompanyOnProfile} had no employer to read — most LinkedIn headlines are slogans rather than "Title at Company".` : "")
          + (left !== null ? ` ${left} prospect${left === 1 ? "" : "s"} still need a company name.` : "")
          + why,
        );
      }
    } catch (e) {
      console.error(`[CompanyBackfill] workspace ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { workspaces: touched, filled };
}

/**
 * Cron entry point: sweep every workspace in `auto`, up to its own daily cap.
 * Workspaces in `off` or `approval` are skipped — `approval` runs only from the
 * button, which is the whole distinction between the two.
 */
export async function runEnrichmentSweepAllWorkspaces(): Promise<{ swept: number; emailsFound: number }> {
  const db = await getDb();
  if (!db) return { swept: 0, emailsFound: 0 };

  const rows = await db
    .select({ id: workspaces.id, mode: workspaceSettings.enrichmentSweepMode, cap: workspaceSettings.enrichmentSweepDailyCap, lastRunAt: workspaceSettings.enrichmentSweepLastRunAt })
    .from(workspaces)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id));

  let swept = 0;
  let emailsFound = 0;
    const archivedWs = await archivedWorkspaceIds();
  for (const ws of rows) {
    if (archivedWs.has(ws.id)) continue; // archived workspaces are frozen (2026-08-12)
    if (ws.mode !== "auto") continue;
    // Daily means daily: the cron ticks more often than that so a restart
    // cannot turn the cap into "cap per boot".
    if (ws.lastRunAt && Date.now() - new Date(ws.lastRunAt).getTime() < 20 * 60 * 60 * 1000) continue;
    try {
      const r = await sweepWorkspace(ws.id, { limit: ws.cap ?? 50 });
      if (r.attempted > 0) {
        swept++;
        emailsFound += r.emailsFound;
        console.log(`[EnrichmentSweep] ws=${ws.id} attempted=${r.attempted} found=${r.emailsFound} stopped=${r.stoppedBecause}`);
        const title = `Enrichment Sweep: ${r.emailsFound} email${r.emailsFound === 1 ? "" : "s"} found`;
        await notifyOwner(
          ws.id, await workspaceNotifyUserId(ws.id), title,
          [
            r.attempted > 0 ? `Checked ${r.attempted} prospect${r.attempted === 1 ? "" : "s"} and resolved ${r.emailsFound} address${r.emailsFound === 1 ? "" : "es"}.` : "",
            r.creditsPower > 0 ? `Spent ${r.creditsPower} verification credit${r.creditsPower === 1 ? "" : "s"}.` : "",
            r.stoppedBecause === "no_credits" ? "Stopped early — verification credits ran low." : "",
            r.stoppedBecause === "no_key" ? "Email lookups were skipped — add a Reoon API key in Settings → Data enrichment to verify found addresses." : "",
          ].filter(Boolean).join(" "),
        );
      }
    } catch (e) {
      console.error(`[EnrichmentSweep] workspace ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { swept, emailsFound };
}
