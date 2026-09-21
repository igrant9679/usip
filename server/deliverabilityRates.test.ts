/**
 * Bounce and spam rates are DERIVED, and an unmeasured mailbox says so.
 *
 * `sending_accounts.bounceRate` / `.spamRate` had no writer anywhere in the
 * product and `reputationTier` had exactly one — a testConnection line that fed
 * it a hardcoded 0. Every mailbox on /v2/deliverability, /sending-accounts and
 * Settings → Mailboxes therefore reported "0% bounce · Excellent" from the day
 * Feature 64 shipped, which is the single most reassuring thing those three
 * surfaces can say and the one they had no evidence for (audit 2026-09-20).
 *
 * Two failure modes are pinned here, because both LOOK like a working feature:
 *
 *   • Returning 0 for a mailbox with no sample. `pct()` on the Deliverability
 *     page turns null into "0%", so an honest null handed to the wrong branch
 *     reproduces the exact lie with no crash to catch it in QA. The rate is
 *     null below the floor, and every surface branches on that explicitly.
 *   • Counting MESSAGES instead of RECIPIENTS. `ix_sup_uniq` is a PLAIN index,
 *     so one address can hold several 'bounce' rows, and a sequence writes to
 *     the same address four to six times before it dies. COUNT(DISTINCT el.id)
 *     charges that single bounce event to every earlier send and over-reports
 *     by up to the sequence length — the same shape as the denominator bug at
 *     smtpConfig.ts:750-754, and just as unquestionable on screen.
 *
 * The helper is pure, so it gets real unit tests. The query is a source pin,
 * because its failure is structural: a tenancy predicate that leaves the ON
 * clause, or a denominator that drifts back to email_drafts, is not something
 * a unit test over a fake db would notice.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELIVERABILITY_WINDOW_DAYS,
  MIN_DELIVERABILITY_RECIPIENTS,
  ratesFromCounts,
  reputationTierFromRate,
} from "./services/deliverabilityRates";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Comments necessarily quote the shapes they warn against — strip them, or the
 *  documentation of a trap trips the guard against it. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const service = read("server/services/deliverabilityRates.ts");
const serviceCode = strip(service);
const router = read("server/routers/sendingAccounts.ts");
const routerCode = strip(router);

/** Slice between two anchors, both proven present. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  expect(b, `anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("ratesFromCounts — no sample means no number", () => {
  it("under the floor returns null, not zero", () => {
    // THE regression pin for the whole bug. A 0 here is indistinguishable on
    // screen from a mailbox with a perfect record.
    const r = ratesFromCounts(1, MIN_DELIVERABILITY_RECIPIENTS - 1, 0, 0);
    expect(r.bounceRate).toBeNull();
    expect(r.spamRate).toBeNull();
    expect(r.tier).toBeNull();
  });

  it("zero recipients does not divide by zero", () => {
    const r = ratesFromCounts(1, 0, 0, 0);
    expect(r).toMatchObject({ bounceRate: null, spamRate: null, tier: null, recipients: 0 });
  });

  it("rates at exactly the floor", () => {
    expect(ratesFromCounts(1, MIN_DELIVERABILITY_RECIPIENTS, 1, 0).bounceRate).toBe(
      1 / MIN_DELIVERABILITY_RECIPIENTS,
    );
  });

  it("rates are FRACTIONS and the tier agrees with them", () => {
    // 0-1, never a percent: reputationTierFromRate's thresholds (0.02/0.05/0.10)
    // are what make the convention load-bearing, and the UI's pct() multiplies
    // anything <= 1 by 100. Feeding it a percent would read 300%.
    const r = ratesFromCounts(1, 100, 3, 1);
    expect(r.bounceRate).toBeCloseTo(0.03, 10);
    expect(r.spamRate).toBeCloseTo(0.01, 10);
    expect(r.tier).toBe("good");
    expect(reputationTierFromRate(0.03)).toBe("good");
    expect(reputationTierFromRate(0.019)).toBe("excellent");
    expect(reputationTierFromRate(0.05)).toBe("fair");
    expect(reputationTierFromRate(0.10)).toBe("poor");
  });

  it("confidence comes from the shared ladder, not a private one", () => {
    // The same boundaries optimization.test.ts pins, so the two cannot drift
    // into disagreeing about what "high confidence" means.
    expect(ratesFromCounts(1, 74, 0, 0).confidence).toBe("low");
    expect(ratesFromCounts(1, 75, 0, 0).confidence).toBe("medium");
    expect(ratesFromCounts(1, 199, 0, 0).confidence).toBe("medium");
    expect(ratesFromCounts(1, 200, 0, 0).confidence).toBe("high");
  });

  it("an unrated account still reports its sample", () => {
    // The em-dash tooltip says "N recipients — M needed to rate"; without the
    // raw counts it can only say "no data", which is what an operator already
    // suspects and cannot act on.
    const r = ratesFromCounts(1, 10, 10, 0);
    expect(r.recipients).toBe(10);
    expect(r.bouncedRecipients).toBe(10);
    expect(r.windowDays).toBe(DELIVERABILITY_WINDOW_DAYS);
  });
});

describe("the query counts the right rows", () => {
  it("reuses the shared confidence ladder rather than re-deriving it", () => {
    expect(serviceCode).toContain('from "./optimization/types"');
    expect(serviceCode).toContain("confidenceFromSample(");
    expect(serviceCode).not.toMatch(/n >= 200/);
  });

  it("counts RECIPIENTS on both sides, never messages", () => {
    // ix_sup_uniq is a plain index and a sequence mails the same address several
    // times, so COUNT(*) or COUNT(DISTINCT el.id) charges one bounce event to
    // every earlier send and reports up to the sequence length times the truth.
    expect(serviceCode).toContain("COUNT(DISTINCT el.toEmail)");
    expect(serviceCode).toMatch(/COUNT\(DISTINCT CASE WHEN s\.reason = 'bounce'\s+THEN el\.toEmail END\)/);
    expect(serviceCode).toMatch(/COUNT\(DISTINCT CASE WHEN s\.reason = 'spam_complaint' THEN el\.toEmail END\)/);
    expect(serviceCode).not.toMatch(/COUNT\(\*\)/);
    expect(serviceCode).not.toContain("COUNT(DISTINCT el.id)");
  });

  it("carries the tenant boundary INSIDE the join", () => {
    // An ON clause without it reads every other workspace's suppression list —
    // the only way this read becomes a security bug.
    expect(serviceCode).toContain("s.workspaceId = el.workspaceId");
    expect(serviceCode).toMatch(/WHERE el\.workspaceId\s+= \$\{workspaceId\}/);
  });

  it("charges a message only with suppressions recorded at or after it went out", () => {
    expect(serviceCode).toMatch(/s\.createdAt\s+>= el\.sentAt/);
  });

  it("normalises the LOG side only, so the suppression index stays usable", () => {
    expect(serviceCode).toMatch(/s\.email\s+= LOWER\(TRIM\(el\.toEmail\)\)/);
  });

  it("excludes sends that never left", () => {
    // logSend writes failed rows too; counting them puts mail that was never
    // transmitted in the denominator.
    expect(serviceCode).toMatch(/el\.status\s+= 'sent'/);
  });

  it("the denominator is email_log, not the two tables that miss half the volume", () => {
    // sending_account_daily_stats is incremented only on emailDelivery's pool
    // path; email_drafts has no row for an ARE campaign send at all. Dividing by
    // drafts understates a campaign-heavy workspace by most of its volume —
    // the same class as the denominator bug at smtpConfig.ts:750-754.
    expect(serviceCode).toMatch(/FROM\s+\\`email_log\\` el/);
    expect(serviceCode).not.toContain("sending_account_daily_stats");
    expect(serviceCode).not.toContain("email_drafts");
  });

  it("is ES5-safe and has no module-scope database call", () => {
    // tsconfig declares no `target`, so for-of over a Map/Set is TS2802. And
    // sendingInfrastructure.test.ts imports the router that imports this file,
    // so a getDb() at module scope would run on every load of that suite.
    expect(serviceCode).not.toMatch(/for \(const .* of .*\.(keys|values|entries)\(\)/);
    expect(serviceCode).not.toMatch(/\.\.\.(new )?(Map|Set)\b/);
    expect(serviceCode).not.toContain("getDb(");
  });
});

describe("the router stops serving the columns nothing writes", () => {
  const list = between(routerCode, "list: workspaceProcedure", "get: workspaceProcedure");
  const get = between(routerCode, "get: workspaceProcedure", "sendgridSenders:");

  it("`list` drops bounceRate / spamRate / reputationTier", () => {
    // Dropped rather than nulled: a null would still print "0%" through pct(),
    // and would narrow the emitted type to `null`, breaking the casts that
    // consume it. Dropping makes a missed surface a compile error.
    expect(list).toContain("bounceRate, spamRate, reputationTier, ...a");
    expect(list).not.toContain("bounceRate: a.bounceRate");
  });

  it("`list` still reports a USABLE SendGrid key", () => {
    // Re-asserted here so a reflow of this return fails with a message about
    // the thing it broke, rather than in sendgridIntegration.test.ts.
    expect(list).toContain("hasSendgridKey: !!sendgridApiKeyEnc || workspaceHasKey");
  });

  it("`get` drops the same three — the detail view cannot disagree with the row", () => {
    expect(get).toContain("bounceRate, spamRate, reputationTier, ...safe");
  });

  it("testConnection no longer re-stamps a tier from a column nothing writes", () => {
    const conn = between(routerCode, "testConnection: workspaceProcedure", "getDailyStats:");
    expect(conn).not.toContain("reputationTier: reputationTierFromRate");
    // …and the SendGrid key resolution that shipped beside it survives intact.
    expect(conn).toContain("resolveSendgridKey(db, ctx.workspace.id, undefined, account.id)");
    expect(conn).not.toContain("tryDecryptSecret(account.sendgridApiKeyEnc)");
  });

  it("senderPools.get does not serve the stored tier by a side door", () => {
    expect(routerCode).not.toContain("reputationTier: sendingAccounts.reputationTier");
  });

  it("the derived rates have their own workspace-scoped procedure", () => {
    // Its own procedure on purpose: `list` is called from eleven places, eight
    // of which never render a rate and must not pay for a scan of email_log.
    expect(routerCode).toContain("deliverability: workspaceProcedure");
    expect(routerCode).toContain("deliverabilityRatesByAccount(");
    expect(routerCode).toContain("isNull(sendingAccounts.unipileAccountId)");
  });
});

describe("no surface trades one lie for another", () => {
  it("SendingAccounts.tsx names the unrated case before the tier map", () => {
    // `map[tier] ?? map.fair` would paint an unmeasured mailbox amber "Fair".
    const src = strip(read("client/src/pages/usip/SendingAccounts.tsx"));
    const badge = src.slice(src.search(/function ReputationBadge/));
    expect(badge.slice(0, badge.indexOf("function WarmupBadge"))).toContain("!tier");
    expect(src).toContain("trpc.sendingAccounts.deliverability.useQuery()");
  });

  it("MailboxesSection.tsx no longer defaults an unmeasured mailbox to Good", () => {
    const src = strip(read("client/src/components/usip/settings/MailboxesSection.tsx"));
    expect(src).toContain("tier == null");
    expect(src).not.toContain('?? "good"');
    expect(src).toContain("trpc.sendingAccounts.deliverability.useQuery()");
  });

  it("Deliverability.tsx averages only rated mailboxes and shows the sample", () => {
    // This page was pinned by NOTHING, which is part of why the bug survived.
    const src = strip(read("client/src/pages/usip/Deliverability.tsx"));
    expect(src).toContain("trpc.sendingAccounts.deliverability.useQuery()");
    expect(src).toContain("r.bounceRate != null");
    expect(src).toContain("recipients");
    expect(src).not.toContain("pct(a.bounceRate)");
    expect(src).not.toContain("pct(a.spamRate)");
  });
});
