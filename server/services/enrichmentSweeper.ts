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
 * Cost: every candidate costs Reoon credits (quick pre-filter, then power
 * verification on plausible patterns only). Nothing here touches Apollo.
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { prospects, workspaceSettings, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { lookupContactInfo } from "./scraper";
import { getReoonKey, reoonCheckBalance } from "./reoon";

export type SweepMode = "off" | "approval" | "auto";

export interface SweepResult {
  attempted: number;
  emailsFound: number;
  creditsQuick: number;
  creditsPower: number;
  /** Why the run ended: finished the candidates, hit the cap, or ran dry. */
  stoppedBecause: "done" | "cap" | "no_credits" | "no_key" | "no_candidates";
}

/** A run that did nothing, shaped so callers never special-case null. */
const emptyResult = (stoppedBecause: SweepResult["stoppedBecause"]): SweepResult => ({
  attempted: 0, emailsFound: 0, creditsQuick: 0, creditsPower: 0, stoppedBecause,
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

/** How many candidates are waiting, for the UI to show before anyone spends. */
export async function countCandidates(workspaceId: number, retryFailed = false): Promise<number> {
  const rows = await candidatesFor(workspaceId, 10000, retryFailed);
  return rows.length;
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

  const key = await getReoonKey(workspaceId);
  if (!key) return emptyResult("no_key");

  const cap = Math.max(1, Math.min(500, opts.limit ?? 50));
  const rows = await candidatesFor(workspaceId, cap, opts.retryFailed ?? false);
  if (rows.length === 0) return emptyResult("no_candidates");

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

  const result: SweepResult = { ...emptyResult("done") };
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
      result.creditsQuick += r.reoonCreditsQuick ?? 0;
      result.creditsPower += r.reoonCreditsPower ?? 0;
      dailyCreditsLeft -= r.reoonCreditsPower ?? 0;
      if (r.email) result.emailsFound++;
    } catch (e) {
      // Count the attempt anyway: a prospect that reliably throws must not be
      // retried forever inside the same run.
      result.attempted++;
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
