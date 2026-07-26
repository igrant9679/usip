/**
 * apolloEnrich.ts — Apollo People Enrichment (/people/match). THIS SPENDS MONEY.
 *
 * Deliberately a SEPARATE module from services/apollo.ts. That file documents
 * itself as search-only with "no code path here that hits /people/match — credit
 * spend is structurally impossible, not merely toggled off". Adding a paid call
 * into it would quietly falsify that guarantee for every future reader. The
 * paid surface lives here, alone, where it is obvious.
 *
 * COST MODEL (from Apollo's docs and apollo.ts's header):
 *   • 1 credit per person WHEN AN EMAIL IS FOUND. No match = no charge.
 *   • +8 credits if a phone number is returned. `reveal_phone_number` is
 *     therefore hard-coded false and is not a parameter — a caller cannot
 *     accidentally make a request 9× more expensive.
 *
 * Targeting rationale: matching is by LinkedIn URL, Apollo's strongest key.
 * The alternative target — 1,520 contacts with no email, no LinkedIn URL and a
 * lowercase company slug — would cost ~10× more for a far worse hit rate.
 *
 * Every entry point is dry-run-by-default and reports the credits a real run
 * would consume before a single one is spent.
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { prospectQueue } from "../../drizzle/schema";
import { getDb } from "../db";
import { getApolloKey } from "./apollo";

/** Apollo's locked-email sentinel — must never be stored as an address. */
const LOCKED_EMAIL = /email_not_unlocked|not_unlocked@/i;

/** Accept only something that actually looks like a deliverable address. */
export function usableEmail(raw?: string | null): string | null {
  const s = (raw ?? "").trim();
  if (!s || LOCKED_EMAIL.test(s)) return null;
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) ? s.toLowerCase() : null;
}

export interface EnrichCandidate {
  id: number;
  firstName: string | null;
  lastName: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
}

export interface EnrichResult {
  dryRun: boolean;
  /** Prospects with a LinkedIn URL and no email — the addressable set. */
  eligible: number;
  /** How many this run would actually attempt (after the cap). */
  wouldAttempt: number;
  /** Credits a real run could consume at worst (1 per successful match). */
  maxCredits: number;
  attempted: number;
  emailsFound: number;
  noMatch: number;
  errors: string[];
  creditsSpent: number;
  sample: Array<{ id: number; name: string; outcome: string }>;
}

/**
 * Prospects that can be enriched: have a LinkedIn URL, lack a usable email.
 * Ordered by id so repeated capped runs march through the list predictably
 * rather than re-attempting the same rows.
 */
export async function findEnrichCandidates(workspaceId: number): Promise<EnrichCandidate[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: prospectQueue.id,
      firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName,
      linkedinUrl: prospectQueue.linkedinUrl,
      companyName: prospectQueue.companyName,
    })
    .from(prospectQueue)
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      isNotNull(prospectQueue.linkedinUrl),
      ne(prospectQueue.linkedinUrl, ""),
      or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
    ))
    .orderBy(prospectQueue.id);
  return rows.filter((r) => !!(r.linkedinUrl ?? "").trim());
}

/**
 * Enrich prospects' emails via Apollo.
 *
 * `dryRun` defaults TRUE: it counts the addressable set and the worst-case
 * credit spend and makes NO network call, so the cost is always knowable before
 * it is incurred.
 */
export async function enrichProspectEmails(
  workspaceId: number,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<EnrichResult> {
  const dryRun = opts.dryRun !== false;
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));

  const candidates = await findEnrichCandidates(workspaceId);
  const batch = candidates.slice(0, limit);
  const result: EnrichResult = {
    dryRun,
    eligible: candidates.length,
    wouldAttempt: batch.length,
    maxCredits: batch.length, // worst case: every one matches, 1 credit each
    attempted: 0,
    emailsFound: 0,
    noMatch: 0,
    errors: [],
    creditsSpent: 0,
    sample: [],
  };
  if (dryRun) return result;

  const key = await getApolloKey(workspaceId);
  if (!key) {
    result.errors.push("No Apollo API key configured for this workspace.");
    return result;
  }
  const db = await getDb();
  if (!db) {
    result.errors.push("database unavailable");
    return result;
  }

  for (const c of batch) {
    const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || `prospect ${c.id}`;
    try {
      const res = await fetch(`${"https://api.apollo.io/api/v1"}/people/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": key },
        body: JSON.stringify({
          linkedin_url: c.linkedinUrl,
          // Ask for the work email only. reveal_phone_number is intentionally
          // absent: it would add 8 credits per person.
          reveal_personal_emails: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      result.attempted++;

      if (!res.ok) {
        // 402/429 mean out of credits or rate-limited — stop rather than
        // hammering a failing paid endpoint for the rest of the batch.
        const body = await res.text().catch(() => "");
        result.errors.push(`${name}: HTTP ${res.status} ${body.slice(0, 120)}`);
        if (res.status === 402 || res.status === 429) {
          result.errors.push("Stopping early — Apollo returned a credit/rate limit.");
          break;
        }
        continue;
      }

      const json: any = await res.json().catch(() => null);
      const email = usableEmail(json?.person?.email);
      if (!email) {
        result.noMatch++;
        result.sample.push({ id: c.id, name, outcome: "no email found (no credit charged)" });
        continue;
      }

      await db
        .update(prospectQueue)
        .set({ email } as never)
        .where(and(eq(prospectQueue.id, c.id), eq(prospectQueue.workspaceId, workspaceId)));
      result.emailsFound++;
      result.creditsSpent++; // Apollo charges only when it returns an email
      result.sample.push({ id: c.id, name, outcome: `email found (${email.replace(/^(.).*(@.*)$/, "$1***$2")})` });
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
    }
  }

  result.sample = result.sample.slice(0, 15);
  return result;
}
