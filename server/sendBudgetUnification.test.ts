/**
 * ONE per-account send budget (audit 2026-09-20).
 *
 * A mailbox's `dailySendLimit` was measured by three counters that each read a
 * table only one engine wrote:
 *
 *   - `email_drafts`               — sequences, CRM, the SMTP blast. Campaign
 *                                    mail writes no draft row at all.
 *   - `sending_account_daily_stats`— written ONLY by emailDelivery's pool.
 *   - `sendingAccounts.warmupSentToday` — warmup, seen by nobody.
 *
 * So the campaign pool and the sequence picker could each spend the same
 * mailbox's full daily limit on the same day, and warmup added its ramp on top
 * of both. The fix is one function — `sendLimits.accountsSentToday` over
 * `email_log`, the only table every account-attributed transmission writes,
 * plus warmup's own column — and every sender reading it.
 *
 * These are source pins because the failure is structural: a budget function
 * nothing calls, or a second copy of the count, is exactly the shape that let
 * this happen the first time. The map-shaping itself is pure, so it gets a
 * real unit test below.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { mergeWarmupUsage } from "./sendLimits";

const ROOT = join(__dirname, "..");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => strip(readFileSync(join(ROOT, p), "utf8"));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");

/** Slice between two anchors, both proven present — `-1 <` is always true. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  expect(b, `anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

const limits = read("server/sendLimits.ts");
const delivery = read("server/emailDelivery.ts");
const seqRouter = read("server/routers/sequences.ts");
const warmup = read("server/services/warmupEngine.ts");
const smtp = read("server/routers/smtpConfig.ts");
const engine = read("server/areEngine.ts");

describe("the per-account counter counts the right rows", () => {
  it("reads email_log, sent rows only, from the UTC day start", () => {
    expect(limits).toContain("export async function accountsSentToday");
    const fn = between(
      limits,
      "export async function accountsSentToday",
      "export async function getAccountSentToday",
    );
    expect(fn).toContain("emailLog");
    // Counting FAILED rows would charge a mailbox for mail that never left.
    expect(fn).toContain('eq(emailLog.status, "sent")');
    expect(fn).toContain("todayStart()");
    // Warmup leaves the same mailbox, so it spends the same budget — it just
    // arrives from its own column rather than from a log row.
    expect(fn).toContain("warmupSentToday");
    // The table this counter exists to stop trusting.
    expect(fn).not.toContain("sendingAccountDailyStats");
  });

  it("the workspace-wide cap did NOT move to email_log", () => {
    // areDefaultDailySendCap defaults to 50 and a breach THROWS. email_log
    // also carries campaign and transactional mail, so counting it there
    // would let one live campaign lock every rep out of Send by mid-morning.
    const fn = between(
      limits,
      "export async function getWorkspaceSentToday",
      "export async function assertSendAllowed",
    );
    expect(fn).toContain("emailDrafts");
    expect(fn).not.toContain("emailLog");
  });

  it("exactly one definition, and every sender reads it", () => {
    const defs = sourceFiles(join(ROOT, "server")).filter((f) =>
      /export async function accountsSentToday/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(defs.map(rel)).toEqual(["server/sendLimits.ts"]);

    // A count, not a toContain: a sender dropping back to its own private
    // tally is precisely the regression this file exists to catch.
    const users = sourceFiles(join(ROOT, "server"))
      .filter((f) => /accountsSentToday\(/.test(strip(readFileSync(f, "utf8"))))
      .map(rel)
      .sort();
    expect(users).toEqual([
      "server/emailDelivery.ts",
      "server/routers/sendingAccounts.ts",
      "server/routers/sequences.ts",
      "server/sendLimits.ts",
      "server/services/warmupEngine.ts",
    ]);
  });
});

describe("mergeWarmupUsage — the two silent mis-measurements", () => {
  it("an account with no rows is 0, not absent", () => {
    // Every caller compares `used < dailySendLimit`; `undefined < 500` is
    // false, so an absent key reads as "exhausted" and the mailbox is skipped.
    const m = mergeWarmupUsage([7, 9], [], [], "2026-09-20");
    expect(m.get(7)).toBe(0);
    expect(m.get(9)).toBe(0);
  });

  it("adds warmup volume for today and ignores a stale day", () => {
    const m = mergeWarmupUsage(
      [7, 9],
      [{ accountId: 7, cnt: 12 }, { accountId: 9, cnt: 3 }],
      [
        { id: 7, warmupSentToday: 6, warmupTodayDate: "2026-09-20" },
        // warmupTodayDate is overwritten on the next send, never reset at
        // midnight — yesterday's count must contribute nothing.
        { id: 9, warmupSentToday: 40, warmupTodayDate: "2026-09-19" },
      ],
      "2026-09-20",
    );
    expect(m.get(7)).toBe(18);
    expect(m.get(9)).toBe(3);
  });

  it("ignores a row whose sendingAccountId is NULL", () => {
    // migration 0163's backfill left campaign rows with a NULL account.
    const m = mergeWarmupUsage([7], [{ accountId: null, cnt: 99 }], [], "2026-09-20");
    expect(m.get(7)).toBe(0);
  });
});

describe("every sender gates on the shared counter", () => {
  it("the campaign pool no longer reads its own stats table to decide", () => {
    const fn = between(
      delivery,
      "export async function choosePoolAccount",
      "export async function sendWorkspaceEmail",
    );
    expect(fn).toContain("accountsSentToday(workspaceId, ids)");
    expect(fn).not.toContain("sendingAccountDailyStats");
  });

  it("the sequence picker no longer counts drafts", () => {
    const fn = between(seqRouter, 'camp.senderType === "pool"', "const strat =");
    expect(fn).toContain("accountsSentToday(");
    expect(fn).not.toContain("emailDrafts.sendingAccountId");
  });

  it("warmup is clamped by the mailbox's cap, and stays out of the log", () => {
    expect(warmup).toContain("accountsSentToday(");
    expect(warmup).toContain("remainingDaily");
    // Self-sends must not reach the Emails page, the Home "emails sent" tile,
    // the email_log report source or the billing meter.
    expect(warmup).not.toContain("logEmailSend(");
    expect(warmup).not.toContain("createEmailAdapter(");
    expect(warmup).not.toContain("recordEmailsSent(");
  });

  it("the raw SMTP send paths write the log row the counter reads", () => {
    // Without this the bulk blast — the primary outbound sales path — is
    // account-attributed, uncapped, and invisible everywhere.
    expect((smtp.match(/logEmailSend\(/g) ?? []).length).toBe(2);
    expect((smtp.match(/recordEmailsSent\(/g) ?? []).length).toBe(2);
    expect((smtp.match(/sendingAccountId: draft\.sendingAccountId/g) ?? []).length).toBe(2);
  });

  it("the stats table stays a report, and nothing gates on it", () => {
    expect(delivery).toContain(".insert(sendingAccountDailyStats)");
    expect(delivery).toContain("sql`${sendingAccountDailyStats.sentCount} + 1`");
    const gates = sourceFiles(join(ROOT, "server"))
      .filter((f) => {
        const s = strip(readFileSync(f, "utf8"));
        if (!/sendingAccountDailyStats/.test(s)) return false;
        // A stats value compared against the cap is the old bug by definition.
        return /sentCount[^\n]*dailySendLimit|dailySendLimit[^\n]*sentCount/.test(s);
      })
      .map(rel);
    expect(gates).toEqual([]);
  });
});

describe("a capped pool DEFERS an ARE step, it does not kill it", () => {
  it("the blocked reason is a typed discriminant, not matched prose", () => {
    expect(delivery).toContain('blocked: "daily"');
    expect(delivery).toContain('blocked: "hourly"');
    const pick = between(delivery, "export type PoolPick", "export async function choosePoolAccount");
    expect(pick).toContain('kind: "blocked"');
    expect(pick).toContain("blocked:");
    // The engine must not recover the reason by reading the message.
    expect(engine).not.toContain("hit their daily limit");
  });

  it("the blocked arm re-schedules, and comes BEFORE the surviving failure write", () => {
    const tail = engine.slice(engine.indexOf("if (sendRes.ok) {"));
    expect(engine.indexOf("if (sendRes.ok) {")).toBeGreaterThan(-1);
    const blockedAt = tail.indexOf("} else if (sendRes.blocked) {");
    const failedAt = tail.indexOf('failureReason: sendRes.reason ?? "send failed"');
    expect(blockedAt).toBeGreaterThan(-1);
    expect(failedAt).toBeGreaterThan(blockedAt);
    const arm = tail.slice(blockedAt, failedAt);
    // The repo's revive idiom — the `due` query picks a scheduled row up again.
    expect(arm).toContain('status: "scheduled"');
    expect(arm).toContain("failureReason: null");
    expect(arm).toContain("executedAt: null");
    // And the rest of the tick is held rather than burned one row at a time.
    expect(arm).toContain("poolHeld =");
    expect(engine).toContain("if (poolHeld) continue;");
  });

  it("the pre-mark that makes an interrupted send visible is untouched", () => {
    // Reverting the pre-mark is only safe because the pool refuses BEFORE
    // adapter.sendEmail; the pre-mark itself still has to exist.
    expect(engine).toContain("Dispatch interrupted — send state unknown");
  });
});

describe("the index ships with the code", () => {
  it("schema.ts and rawMigrations.ts agree on ix_elog_acct_sent", () => {
    // Without it every send range-scans the workspace's whole email_log day.
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('index("ix_elog_acct_sent")');
    const migrations = readFileSync(join(ROOT, "server/_core/rawMigrations.ts"), "utf8");
    expect(migrations).toMatch(/ADD INDEX `ix_elog_acct_sent`/);
  });
});
