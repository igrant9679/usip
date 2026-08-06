/**
 * MX pre-check — "can this domain receive mail at all?"
 *
 * WHY: the finder builds 3 candidate addresses per prospect and sends each one
 * to Reoon separately, so a dead, parked or mail-less domain costs 3 quick
 * credits *per prospect* before anything says "invalid". Reoon's quick mode
 * does check MX (see the two-stage comment in ./index.ts) — we were simply
 * paying for that same answer once per pattern, per person, forever.
 *
 * One DNS lookup answers it once for the whole domain, for free, with no
 * external service and no API key: `node:dns` is stdlib. On a backlog full of
 * domains Apollo resolved from company names — some of which never existed —
 * that is the difference between spending credits to learn nothing and
 * spending none.
 *
 * ─── THE ONE RULE THAT MATTERS ───────────────────────────────────────────────
 * This returns `acceptsMail: false` ONLY on a definitive DNS answer. Every
 * ambiguous outcome — timeout, SERVFAIL, refused, a resolver hiccup — returns
 * TRUE and lets verification proceed exactly as before.
 *
 * That asymmetry is deliberate and is the whole safety story. A false negative
 * here is not "one wasted lookup": the sweeper stamps `enrichedAt` on every
 * attempt, so a prospect skipped on a transient DNS failure is skipped
 * PERMANENTLY and never re-tried. Failing open costs 3 credits; failing closed
 * costs the contact. This is `96b161d`'s rule in a new place — absent is not
 * zero, and "I could not tell" is not "no".
 *
 * ─── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * No SMTP connection, no RCPT-TO probe. Railway blocks outbound port 25, the
 * big providers accept at RCPT time and reject later, and probing from our own
 * address space is what damages the sending reputation this product depends on.
 * Reoon does that part, from infrastructure built for it. This is DNS only.
 */
import { Resolver } from "node:dns/promises";

/** Why we believe what we believe. Surfaced in logs and stored reasons. */
export type MxReason =
  /** MX records present. */
  | "mx"
  /** No MX, but an A/AAAA record — RFC 5321 §5.1 implicit mail exchanger. */
  | "a_fallback"
  /** RFC 7505 "null MX": the domain explicitly announces it accepts no mail. */
  | "null_mx"
  /** The domain does not resolve at all. */
  | "no_such_domain"
  /** The domain resolves but publishes neither MX nor A/AAAA. */
  | "no_records"
  /** We could not get an answer. Always paired with acceptsMail: true. */
  | "dns_error";

export type MxVerdict = {
  /** FALSE only on a definitive answer. See the header — ambiguity means true. */
  acceptsMail: boolean;
  reason: MxReason;
  /** Mail exchangers, best-priority first. Empty unless reason is "mx". */
  hosts: string[];
};

/**
 * DNS errors that mean "the answer is no", as opposed to "I could not ask".
 * Everything not in this set is treated as unknown and fails open.
 *
 * ENOTFOUND — NXDOMAIN, the name does not exist.
 * ENODATA   — the name exists but has no record of this type.
 */
const DEFINITIVE_DNS_ERRORS = new Set(["ENOTFOUND", "ENODATA"]);

const dnsErrorCode = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";

/**
 * A short timeout and one retry.
 *
 * The sweeper runs this in a loop over up to 1000 prospects, so a resolver that
 * hangs must not stall the run. Two tries at 3s bounds the worst case at ~6s
 * per domain, and a timeout is an ambiguous answer, so the cost of giving up is
 * only that we verify as we did before.
 */
const resolver = new Resolver({ timeout: 3_000, tries: 2 });

/* ─── Cache ──────────────────────────────────────────────────────────────── */

/**
 * In-process, not in the database.
 *
 * A sweep works many prospects at the same employer back to back, which is
 * where nearly all the repetition is, and that is all within one process. A
 * table would survive restarts but needs a migration to buy very little.
 *
 * Bounded because this process is long-lived (the cron runs in it) and an
 * unbounded Map keyed by attacker-influenceable domains is a slow leak.
 */
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { verdict: MxVerdict; expires: number }>();

function cacheGet(domain: string): MxVerdict | null {
  const hit = cache.get(domain);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(domain);
    return null;
  }
  return hit.verdict;
}

function cacheSet(domain: string, verdict: MxVerdict): void {
  // Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(domain, { verdict, expires: Date.now() + TTL_MS });
}

/** Test seam: batteries and suites must not inherit another case's answers. */
export function __clearMxCache(): void {
  cache.clear();
}

/* ─── The check ──────────────────────────────────────────────────────────── */

/**
 * RFC 7505: a single MX whose exchange is the root ("." — Node reports it as
 * "" or ".") means the domain accepts no mail, deliberately. Treated as
 * definitive because it is an explicit statement by the domain owner, not an
 * absence of one.
 */
function isNullMx(records: Array<{ exchange: string; priority: number }>): boolean {
  if (records.length !== 1) return false;
  const ex = (records[0].exchange ?? "").trim();
  return ex === "" || ex === ".";
}

/**
 * Does this domain accept mail? Never throws.
 *
 * @param domain a normalized bare domain ("acme.io"), as produced by
 *               normalizeDomain() — this does not parse URLs.
 */
export async function domainAcceptsMail(domain: string): Promise<MxVerdict> {
  const d = (domain ?? "").trim().toLowerCase();
  // Nothing to ask about. Fail OPEN so an unexpected shape can never silently
  // disable enrichment for a whole workspace — the callers already reject an
  // empty domain earlier, with a clearer reason than this could give.
  if (!d) return { acceptsMail: true, reason: "dns_error", hosts: [] };

  const cached = cacheGet(d);
  if (cached) return cached;

  const verdict = await computeVerdict(d);
  cacheSet(d, verdict);
  return verdict;
}

async function computeVerdict(d: string): Promise<MxVerdict> {
  let mxWasDefinitivelyEmpty = false;
  let mxSaidNoSuchDomain = false;

  try {
    const records = await resolver.resolveMx(d);
    if (isNullMx(records)) return { acceptsMail: false, reason: "null_mx", hosts: [] };
    if (records.length > 0) {
      return {
        acceptsMail: true,
        reason: "mx",
        hosts: [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange),
      };
    }
    // An empty array is the same statement as ENODATA: no MX here.
    mxWasDefinitivelyEmpty = true;
  } catch (e) {
    const code = dnsErrorCode(e);
    if (!DEFINITIVE_DNS_ERRORS.has(code)) {
      // Timeout, SERVFAIL, REFUSED, anything unrecognised — we did not learn
      // that the domain is dead, only that we could not ask. Proceed.
      return { acceptsMail: true, reason: "dns_error", hosts: [] };
    }
    mxWasDefinitivelyEmpty = true;
    mxSaidNoSuchDomain = code === "ENOTFOUND";
  }

  /**
   * No MX is not the end of it. RFC 5321 §5.1 makes the A record an implicit
   * mail exchanger, and small business domains routinely rely on that — so
   * rejecting on "no MX" alone would discard real, mailable companies.
   */
  if (!mxWasDefinitivelyEmpty) {
    return { acceptsMail: true, reason: "dns_error", hosts: [] };
  }

  for (const lookup of [() => resolver.resolve4(d), () => resolver.resolve6(d)]) {
    try {
      const addrs = await lookup();
      if (addrs.length > 0) return { acceptsMail: true, reason: "a_fallback", hosts: [] };
    } catch (e) {
      const code = dnsErrorCode(e);
      // Same asymmetry: only a definitive "no such record" lets us continue
      // toward a negative verdict. Anything else and we stop guessing.
      if (!DEFINITIVE_DNS_ERRORS.has(code)) {
        return { acceptsMail: true, reason: "dns_error", hosts: [] };
      }
    }
  }

  return {
    acceptsMail: false,
    reason: mxSaidNoSuchDomain ? "no_such_domain" : "no_records",
    hosts: [],
  };
}
