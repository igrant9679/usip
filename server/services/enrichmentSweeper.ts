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
 * Two passes, because measuring the live workspace showed the second one alone
 * does nothing: of 234 sourced prospects with no email, only 4 had a company
 * domain. So a sweep first resolves missing domains, then finds emails.
 *
 * Cost: the domain pass calls Apollo's ORGANIZATION search — **zero Apollo
 * credits**, same free tier as people search, and never the paid /people/match
 * path. The email pass costs Reoon credits (quick pre-filter, then power
 * verification on plausible patterns only).
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { areCampaigns, prospectQueue, prospects, workspaceSettings, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { lookupContactInfo, resolveVerifiedEmail } from "./scraper";
import { getReoonKey, reoonCheckBalance } from "./reoon";
// Pure name predicate only — importing it does NOT reach any paid Apollo path.
// It is the one definition of "this campaign is a demo, don't work it".
import { isEnrichableCampaign } from "./apolloEnrich";

export type SweepMode = "off" | "approval" | "auto";

export interface SweepResult {
  attempted: number;
  /** Where the attempts landed. The backlog lives in prospect_queue, not prospects. */
  fromQueue: number;
  fromProspects: number;
  /** Domain pre-pass. Free (Apollo org search), and usually the pass that matters. */
  domainsAttempted: number;
  domainsResolved: number;
  emailsFound: number;
  creditsQuick: number;
  creditsPower: number;
  /** Why the run ended: finished the candidates, hit the cap, or ran dry. */
  stoppedBecause: "done" | "cap" | "no_credits" | "no_key" | "no_candidates";
}

/** A run that did nothing, shaped so callers never special-case null. */
const emptyResult = (stoppedBecause: SweepResult["stoppedBecause"]): SweepResult => ({
  attempted: 0, fromQueue: 0, fromProspects: 0, domainsAttempted: 0, domainsResolved: 0,
  emailsFound: 0, creditsQuick: 0, creditsPower: 0, stoppedBecause,
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
  if (!retryFailed) conds.push(isNull(prospects.enrichmentData));
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
 * Resolve missing company domains, so the email finder has anything to work with.
 *
 * Measured on the live workspace: of 234 sourced prospects with no email, only
 * 4 carried a company domain. The finder builds address patterns from
 * name + domain, so the other 230 were unworkable — the bottleneck was never
 * verification, it was the domain.
 *
 * Uses Apollo's ORGANIZATION search via apolloResolveDomain: name → domain, and
 * **zero Apollo credits**, the same free tier as people search. This does not
 * touch the paid /people/match path, which is permanently off the table.
 *
 * Writes the domain AND clears the stale attempt marker. Those two belong
 * together: a row attempted at sourcing time failed precisely because it had no
 * domain, so once one is found the old failure says nothing about whether the
 * finder could succeed. Leaving enrichedAt set would permanently exclude the
 * rows this pass just repaired.
 */
export async function resolveMissingDomains(
  workspaceId: number,
  limit = 100,
): Promise<{ attempted: number; resolved: number }> {
  const db = await getDb();
  if (!db) return { attempted: 0, resolved: 0 };

  const rows = await db
    .select({ id: prospectQueue.id, companyName: prospectQueue.companyName, campaignName: areCampaigns.name })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(prospectQueue.campaignId, areCampaigns.id))
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
      or(isNull(prospectQueue.companyDomain), eq(prospectQueue.companyDomain, "")),
      isNotNull(prospectQueue.companyName),
      ne(prospectQueue.companyName, ""),
    ))
    .orderBy(prospectQueue.id)
    .limit(Math.max(1, Math.min(500, limit)));

  const live = rows.filter((r) => isEnrichableCampaign(r.campaignName));
  const { apolloResolveDomain } = await import("./apollo");

  let attempted = 0;
  let resolved = 0;
  for (const r of live) {
    attempted++;
    try {
      const out = await apolloResolveDomain(workspaceId, r.companyName ?? "");
      if (out.domain) {
        // Clearing enrichedAt is the point, not a detail. These rows were
        // attempted at SOURCING time, before they had a domain, and failed for
        // exactly that reason — so the attempt marker records "we tried" while
        // saying nothing about whether it could have worked. Leaving it set
        // permanently excludes the rows this pass just repaired, which is what
        // made the first real run sweep 22 domains and verify none of them.
        await db.update(prospectQueue)
          .set({ companyDomain: out.domain, enrichedAt: null, enrichmentStatus: "pending" } as never)
          .where(eq(prospectQueue.id, r.id));
        resolved++;
      }
    } catch (e) {
      console.error(`[EnrichmentSweep] domain resolve for queue ${r.id} failed:`, (e as Error).message);
    }
  }
  return { attempted, resolved };
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
  alreadyAttempted: number;
}> {
  const db = await getDb();
  if (!db) return { noEmailTotal: 0, withDomain: 0, needsDomain: 0, alreadyAttempted: 0 };
  const rows = await db
    .select({
      domain: prospectQueue.companyDomain,
      enrichedAt: prospectQueue.enrichedAt,
      campaignName: areCampaigns.name,
    })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(prospectQueue.campaignId, areCampaigns.id))
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
    ));
  const live = rows.filter((r) => isEnrichableCampaign(r.campaignName));
  const hasDomain = (d: string | null) => !!(d ?? "").trim();
  return {
    noEmailTotal: live.length,
    withDomain: live.filter((r) => hasDomain(r.domain)).length,
    needsDomain: live.filter((r) => !hasDomain(r.domain)).length,
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
 * Sweep one workspace. Never throws — a single bad domain must not abort a
 * 50-prospect run, and the caller (a cron) has nowhere useful to report to.
 */
export async function sweepWorkspace(
  workspaceId: number,
  opts: { limit?: number; retryFailed?: boolean; resolveDomains?: boolean } = {},
): Promise<SweepResult> {
  const db = await getDb();
  if (!db) return emptyResult("no_key");

  const key = await getReoonKey(workspaceId);
  if (!key) return emptyResult("no_key");

  const cap = Math.max(1, Math.min(500, opts.limit ?? 50));
  const retry = opts.retryFailed ?? false;

  // Domain pre-pass. Costs no Apollo credits and no Reoon credits, and without
  // it almost every sourced prospect is unworkable — so it runs first, and its
  // results are visible to the candidate query immediately below.
  let domains = { attempted: 0, resolved: 0 };
  if (opts.resolveDomains !== false) {
    try {
      domains = await resolveMissingDomains(workspaceId, cap);
      if (domains.attempted > 0) {
        console.log(`[EnrichmentSweep] ws=${workspaceId} domains attempted=${domains.attempted} resolved=${domains.resolved}`);
      }
    } catch (e) {
      console.error("[EnrichmentSweep] domain pre-pass failed:", (e as Error).message);
    }
  }
  // Queue first: it is where the ARE backlog lives, and those rows are the ones
  // a campaign will actually mail once they have an address.
  const [queueRows, rows] = await Promise.all([
    queueCandidatesFor(workspaceId, cap, retry),
    candidatesFor(workspaceId, cap, retry),
  ]);
  if (rows.length === 0 && queueRows.length === 0) {
    return { ...emptyResult("no_candidates"), domainsAttempted: domains.attempted, domainsResolved: domains.resolved };
  }

  // One balance read up front, then decremented locally. Re-reading per
  // prospect would add a network round trip to every single lookup.
  let dailyCreditsLeft = 0;
  try {
    const balance = await reoonCheckBalance(key);
    dailyCreditsLeft = balance.remaining_daily_credits ?? 0;
  } catch (e) {
    console.error("[EnrichmentSweep] balance check failed:", (e as Error).message);
    return emptyResult("no_credits");
  }

  const result: SweepResult = {
    ...emptyResult("done"),
    domainsAttempted: domains.attempted,
    domainsResolved: domains.resolved,
  };

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
      const r = await lookupContactInfo({
        workspaceId,
        prospectId: p.id,
        firstName: p.firstName ?? "",
        lastName: p.lastName ?? "",
        companyDomain: p.companyDomain ?? null,
        skipIfHasEmail: true,
        existingPhone: p.phone ?? null,
      });
      result.attempted++;
      result.fromProspects++;
      result.creditsQuick += r.reoonCreditsQuick ?? 0;
      result.creditsPower += r.reoonCreditsPower ?? 0;
      dailyCreditsLeft -= r.reoonCreditsPower ?? 0;
      if (r.email) result.emailsFound++;
    } catch (e) {
      // Count the attempt anyway: a prospect that reliably throws must not be
      // retried forever inside the same run.
      result.attempted++;
      result.fromProspects++;
      console.error(`[EnrichmentSweep] prospect ${p.id} failed:`, (e as Error).message);
    }
  }

  try {
    await db
      .update(workspaceSettings)
      .set({ enrichmentSweepLastRunAt: new Date() } as never)
      .where(eq(workspaceSettings.workspaceId, workspaceId));
  } catch { /* stamp only */ }

  return result;
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
  for (const ws of rows) {
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
      }
    } catch (e) {
      console.error(`[EnrichmentSweep] workspace ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { swept, emailsFound };
}
