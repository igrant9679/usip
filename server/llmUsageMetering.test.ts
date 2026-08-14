/**
 * usage_counters — both figures behind Settings → Billing are now measured.
 *
 * `llmTokens` AND `emailsSent` were both READ by `usage.currentMonth` and
 * rendered on that panel, and NEITHER WAS EVER WRITTEN. There was no
 * `insert(usageCounters)` anywhere in the server, so both tiles reported 0 for
 * every workspace forever — measurements never taken, presented as ones that
 * were (the 96b161d shape).
 *
 * `llmTokens` was wired first (a1c1f99), with the increment inline in
 * _core/llm.ts. `emailsSent` needed the identical upsert, so the increment
 * moved to server/usageCounters.ts and both callers share it. A second copy
 * would have been the drift this repo keeps sweeping out.
 *
 * The LLM ceilings (burst + monthly budget) are asserted at the bottom.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const strip = (s: string) =>
  s.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

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

const counters = strip(read("server/usageCounters.ts"));
const llm = strip(read("server/_core/llm.ts"));
const admin = strip(read("server/routers/admin.ts"));
const adapter = strip(read("server/emailAdapter.ts"));

describe("one increment, shared by both counters", () => {
  it("usage_counters is written from exactly one module", () => {
    /**
     * The whole bug in one assertion — before a1c1f99 the answer was zero
     * files. Exactly one now: a second copy of this upsert is how the two
     * counters drift, one getting a fix the other does not.
     */
    const writers = sourceFiles(join(ROOT, "server"))
      .filter((f) => /\.insert\(usageCounters\)/.test(strip(readFileSync(f, "utf8"))))
      .map(rel);
    expect(writers).toEqual(["server/usageCounters.ts"]);
  });

  it("increments ATOMICALLY rather than read-modify-write", () => {
    // Concurrent LLM calls and concurrent sends are both normal here, and a
    // lost update on a usage counter is a bill nobody can reconcile.
    expect(counters).toMatch(/onDuplicateKeyUpdate\(\{ set: \{ \[column\]: sql`\$\{col\} \+ \$\{amount\}`/);
    expect(counters).not.toMatch(/\.select\(\)[\s\S]{0,200}?from\(usageCounters\)/);
  });

  it("never fails the thing it is measuring", () => {
    // A broken counter is a reporting problem; a thrown counter is an outage.
    const bump = counters.slice(counters.indexOf("async function bump"), counters.indexOf("export async function recordLlmTokens"));
    expect(bump).toMatch(/\} catch \(e\) \{/);
    expect(bump.slice(bump.indexOf("} catch (e) {"))).not.toMatch(/throw/);
    expect(bump).toMatch(/if \(!workspaceId \|\| !Number\.isFinite\(n\) \|\| n <= 0\) return;/);
  });

  it("the writer and the reader agree on the month key", () => {
    /**
     * A counter keyed one way and read another reports zero forever while
     * looking wired — normalising a write without the read that pairs with it
     * (bounceFeedback). One definition, used by both.
     */
    expect(counters).toMatch(/export function usageMonthKey/);
    expect(counters).toMatch(/return now\.toISOString\(\)\.slice\(0, 7\)/);
    expect(admin, "reader month key").toMatch(/const month = new Date\(\)\.toISOString\(\)\.slice\(0, 7\)/);
    // The LLM cap check reads the counter too, and must use the same key.
    expect(llm).toMatch(/const month = usageMonthKey\(\)/);
  });
});

describe("llmTokens", () => {
  it("meters at the invokeLLM funnel, not at call sites", () => {
    // Dozens of callers; metering each one means the next is not counted.
    const fn = llm.slice(llm.indexOf("export async function invokeLLM"));
    expect(fn).toMatch(/await recordLlmTokens\(workspaceId, result\.usage\?\.total_tokens \?\? 0\)/);
    /**
     * ⚠️ `-1 < N` IS TRUE. An ordering assertion on a bare `indexOf` goes GREEN
     * when the left-hand token is DELETED, which is the one change it exists to
     * notice. Both ends are proven present before they are compared.
     */
    const switchAt = fn.indexOf("switch (provider)");
    const meterAt = fn.indexOf("recordLlmTokens(");
    expect(switchAt, "`switch (provider)` not found — re-anchor this test").toBeGreaterThan(-1);
    expect(meterAt, "`recordLlmTokens(` not found inside invokeLLM").toBeGreaterThan(-1);
    expect(switchAt).toBeLessThan(meterAt);
    expect(llm).toMatch(/import \{ recordLlmTokens, usageMonthKey \} from "\.\.\/usageCounters"/);
  });

  it("counts every provider — none returns early past the meter", () => {
    const fn = llm.slice(llm.indexOf("export async function invokeLLM"), llm.indexOf("export async function invokeLLM") + 1400);
    for (const p of ["anthropic", "openai", "gemini"]) expect(fn).toContain(`case "${p}":`);
    expect((fn.match(/result = await invokeVia/g) ?? []).length).toBe(3);
  });
});

describe("emailsSent", () => {
  /**
   * THREE transmission points, and only three. Counting at an orchestration
   * layer as well would double-count every send that reaches transmission
   * through it — `sendSystemEmail` and `sendCampaignEmailViaPool` each reach
   * exactly one of these, so they count once while knowing nothing about
   * counting.
   */
  it("the adapter factory meters every send it makes", () => {
    // 11 createEmailAdapter call sites, 3 adapter implementations, one wrapper.
    // Window widened 400 → 1400 on 2026-08-14: the wrapper also applies the
    // inbox's signature/opt-out defaults now, which is a legitimate ~600 chars
    // between the factory opening and the meter. Widened again 1400 → 2600
    // later the same day, when the wrapper also became the sitewide email
    // log's write point (migration 0163) — another legitimate ~1000 chars,
    // there for the same reason the meter is: every adapter is built here, so
    // one record here covers every caller. The property under test is that the
    // meter is INSIDE this factory, not how tightly it is packed.
    expect(adapter).toMatch(/export function createEmailAdapter\(account: SendingAccount\): EmailAdapter \{[\s\S]{0,2600}?await recordEmailsSent\(account\.workspaceId, 1\)/);
    // Wrapped, not replaced: the other adapter methods must still be the
    // adapter's own, and the factory must still build all three kinds.
    expect(adapter).toMatch(/function buildEmailAdapter/);
    expect(adapter).toMatch(/const send = adapter\.sendEmail\.bind\(adapter\)/);
  });

  it("counts only what actually went out", () => {
    /**
     * The increment must sit AFTER the awaited send, so a throw skips it.
     *
     * Written first as `indexOf(send) < indexOf(record)` — which the mutation
     * that moves the increment ABOVE the send walked straight through, because
     * deleting the first anchor makes indexOf return -1 and -1 is less than
     * anything. The `-1 <` trap, in a test written during the very session
     * that catalogued it. Anchors are proven found before they are compared.
     */
    const factory = adapter.slice(adapter.indexOf("export function createEmailAdapter"));
    // `send(decorated)` since 2026-08-14 — the body is decorated with the
    // inbox's defaults first, then sent. Still the awaited send. Since the
    // email-log wiring (0163) it sits inside a try/catch that logs the failure
    // and rethrows, so the anchor lost its `const` — the ordering property is
    // unchanged, and the rethrow is what still skips the increment.
    const sent = factory.indexOf("await send(decorated)");
    const recorded = factory.indexOf("recordEmailsSent(");
    const rethrown = factory.indexOf("throw err");
    expect(sent, "the awaited send is gone — the ordering below would be vacuous").toBeGreaterThan(0);
    expect(recorded, "the increment is gone").toBeGreaterThan(0);
    expect(rethrown, "the catch no longer rethrows — a failed send would be counted").toBeGreaterThan(0);
    expect(sent).toBeLessThan(recorded);
    expect(rethrown).toBeLessThan(recorded);
  });

  it("the two raw-transporter paths record their own", () => {
    // Neither goes through createEmailAdapter, so the factory cannot see them.
    expect(strip(read("server/emailDelivery.ts"))).toMatch(/await recordEmailsSent\(workspaceId, 1\)/);
    expect(strip(read("server/routers/operations.ts"))).toMatch(/await recordEmailsSent\(ctx\.workspace\.id, 1\)/);
  });

  /**
   * Every raw `transporter.sendMail(` outside the metered factory, and what
   * was decided about it. This scan FOUND TWO I HAD MISSED — smtpConfig's
   * sendDraft and sendBulkApproved — which is exactly why the counting is
   * enumerated rather than assumed.
   */
  const COUNTED_RAW: Record<string, { why: string; sends: number }> = {
    "server/emailDelivery.ts": {
      why: "sendWorkspaceEmail's SMTP-config branch — real transactional mail.",
      sends: 1,
    },
    "server/routers/operations.ts": {
      why: "sendScheduleNow — a dashboard report mailed to recipients.",
      sends: 1,
    },
    "server/routers/smtpConfig.ts": {
      // TWO, and the count matters: this file has two distinct send paths and
      // asserting only that the FILE records lets one of them be deleted while
      // the other keeps the test green — the whole-file `toContain` weakness,
      // caught here by a mutation that removed the sendDraft increment.
      why: "sendDraft + sendBulkApproved — the primary outbound sales path.",
      sends: 2,
    },
  };

  const NOT_COUNTED_RAW: Record<string, string> = {
    "server/services/warmupEngine.ts":
      "Warmup traffic: the workspace mailing its OWN mailboxes to build sender reputation. " +
      "Counting it would make the Billing tile mostly self-sends and tell the owner nothing " +
      "about customer volume. sendingAccountDailyStats already tracks it per account.",
  };

  it("every raw send is either counted or excluded ON PURPOSE", () => {
    const raw = sourceFiles(join(ROOT, "server"))
      .filter((f) => rel(f) !== "server/emailAdapter.ts")
      .filter((f) => /transporter\.sendMail\(/.test(strip(readFileSync(f, "utf8"))))
      .map(rel)
      .sort();
    const known = [...Object.keys(COUNTED_RAW), ...Object.keys(NOT_COUNTED_RAW)].sort();
    expect(
      raw,
      "\n\nA raw transporter.sendMail() outside the metered adapter factory.\n" +
        "It bypasses the meter, so either record for itself with\n" +
        "`await recordEmailsSent(workspaceId, 1)` after a successful send and add\n" +
        "it to COUNTED_RAW, or add it to NOT_COUNTED_RAW with the reason.\n",
    ).toEqual(known);
  });

  it("the counted ones actually record, once per send path", () => {
    for (const [f, { sends }] of Object.entries(COUNTED_RAW)) {
      const calls = (strip(read(f)).match(/await recordEmailsSent\(/g) ?? []).length;
      expect(
        calls,
        `\n\n${f} should record ${sends} time(s) — one per transmission point.\n` +
          `Fewer means a send path stopped counting; more means one is counted twice.\n`,
      ).toBe(sends);
    }
  });

  it("the excluded ones really do not record", () => {
    // Otherwise an entry drifts into being counted while the note still says
    // it is exempt — the two halves disagreeing is the bug, either way round.
    for (const f of Object.keys(NOT_COUNTED_RAW)) {
      expect(strip(read(f)), `${f} is listed as excluded but records`).not.toMatch(/recordEmailsSent\(/);
    }
  });

  it("does not double-count the orchestrators", () => {
    /**
     * sendSystemEmail and sendCampaignEmailViaPool both reach transmission
     * through the adapter OR by delegating to sendWorkspaceEmail. Exactly ONE
     * increment in emailDelivery.ts — on the raw branch — keeps that honest;
     * a second would double every pooled send.
     */
    const delivery = strip(read("server/emailDelivery.ts"));
    expect((delivery.match(/recordEmailsSent\(/g) ?? []).length, "expected exactly one call").toBe(1);
  });
});

describe("the burst ceiling", () => {
  const fn = llm.slice(llm.indexOf("function checkLlmBurst"), llm.indexOf("async function checkMonthlyCap"));

  it("was isolated", () => expect(fn.length).toBeGreaterThan(200));

  it("is checked BEFORE the provider call and before a concurrency slot", () => {
    const invoke = llm.slice(llm.indexOf("export async function invokeLLM"));
    const check = invoke.indexOf("checkLlmBurst(");
    const cap = invoke.indexOf("checkMonthlyCap(");
    const slot = invoke.indexOf("acquireLlmSlot()");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(slot);
    expect(cap).toBeLessThan(slot);
    expect(slot).toBeLessThan(invoke.indexOf("switch (provider)"));
  });

  /**
   * ⚠️ THIS ASSERTION USED TO READ `checkLlmBurst(getRequestUserId(), now)` and
   * `if (!userId) return;` — and it was RIGHT about the code and WRONG about
   * the product. That early return exempted background jobs as intended, and
   * also every UNAUTHENTICATED caller, because `getRequestUserId()` is only set
   * for a signed-in request. The public chat agent reached `invokeLLM` with the
   * ceiling doing nothing.
   *
   * A structural guard can only ever pin the shape it was given. The real
   * behaviour now lives in `server/llmRateLimit.test.ts`, which executes the
   * ceiling; this stays as the cheap wiring check.
   */
  it("keys on the user when there is one, and on the client IP when there is not", () => {
    expect(llm).toMatch(/checkLlmBurst\(getRequestUserId\(\), getRequestClientIp\(\), now\)/);
    expect(fn, "both keys, namespaced so they cannot collide").toMatch(
      /const key = userId \? `u:\$\{userId\}` : clientIp \? `ip:\$\{clientIp\}` : null;/,
    );
    // The exemption survives — for genuine background jobs, which have neither.
    expect(fn).toMatch(/if \(!key\) return;/);
  });

  it("prunes its window rather than counting forever", () => {
    expect(fn).toMatch(/filter\(\(t\) => now - t < LLM_BURST_WINDOW_MS\)/);
  });
});

describe("the monthly budget", () => {
  const fn = llm.slice(llm.indexOf("async function checkMonthlyCap"), llm.indexOf("export async function invokeLLM"));

  it("was isolated", () => expect(fn.length).toBeGreaterThan(400));

  it("defaults to UNLIMITED — no invented number ships", () => {
    expect(fn).toMatch(/if \(cap !== null && cap > 0 && used >= cap\)/);
    const schema = read("drizzle/schema.ts");
    expect(schema).toMatch(/llmMonthlyTokenCap: int\("llmMonthlyTokenCap"\)(?!\.default)/);
    expect(schema).not.toMatch(/llmMonthlyTokenCap: int\("llmMonthlyTokenCap"\)\s*\.\s*(?:notNull|default)/);
  });

  it("applies to background engines too", () => {
    expect(fn).not.toMatch(/getRequestUserId/);
    expect(llm).toMatch(/await checkMonthlyCap\(workspaceId, now\)/);
  });

  it("fails OPEN on a database error", () => {
    expect(fn).toMatch(/catch \(e\) \{[\s\S]{0,220}?return; \/\/ fail open/);
  });
});

describe("the cap is reachable and persistable", () => {
  it("settings.save accepts it, nullable so it can be turned back off", () => {
    expect(admin).toMatch(/llmMonthlyTokenCap: z\.number\(\)\.int\(\)\.min\(0\)\.nullable\(\)\.optional\(\)/);
  });

  it("migration 0143 adds the column", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    expect(migrations).toMatch(/name: "0143_llm_monthly_token_cap\.sql"/);
    // The STATEMENT, not just the column name appearing somewhere: dca9672's
    // guard passed while the ADD COLUMN was deleted, because the name still
    // appeared in a CREATE INDEX line.
    expect(migrations).toMatch(/ALTER TABLE `workspace_settings` ADD COLUMN `llmMonthlyTokenCap` int NULL/);
  });
});
