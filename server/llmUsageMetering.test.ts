/**
 * LLM spend is measured.
 *
 * `usage_counters.llmTokens` was READ by `usage.currentMonth` and rendered on
 * Settings → Billing as "LLM tokens", and NOTHING ANYWHERE WROTE IT. There is
 * no `insert(usageCounters)` in the entire server outside this fix, so every
 * workspace's LLM usage read 0 forever — a measurement never taken, presented
 * as one that was. The same shape as the intent score that "was 0 for every
 * row, and counted as if we had measured it" (96b161d).
 *
 * That also made it the blocker for the open cost question: nothing bounds an
 * authenticated user hammering an LLM-backed procedure, and you cannot bound
 * spend you are not measuring. This is the measurement half; the ceiling is a
 * number only the owner can choose.
 *
 * `emailsSent` on the same table and the same Billing panel is STILL unwritten
 * — see the note at the bottom.
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

const llm = strip(read("server/_core/llm.ts"));
const admin = strip(read("server/routers/admin.ts"));

describe("the counter is actually written", () => {
  it("something inserts into usage_counters at all", () => {
    /**
     * The whole bug in one assertion. Before this, the answer was zero files.
     */
    const writers = sourceFiles(join(ROOT, "server"))
      .filter((f) => /\.insert\(usageCounters\)/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(
      writers,
      "\n\nNothing writes usage_counters, so Settings → Billing reports 0 for every\n" +
        "workspace while claiming to show this month's usage.\n",
    ).toContain("server/_core/llm.ts");
  });

  it("meters at the invokeLLM funnel, not at call sites", () => {
    /**
     * There are dozens of invokeLLM callers. Metering at each one means the
     * next caller is simply not counted — the dead-wiring class this repo
     * keeps finding. One funnel, every provider returns through it.
     */
    expect((llm.match(/recordLlmTokens\(/g) ?? []).length, "expected one definition + one call").toBe(2);
    const fn = llm.slice(llm.indexOf("export async function invokeLLM"));
    expect(fn).toMatch(/await recordLlmTokens\(workspaceId, result\.usage\?\.total_tokens \?\? 0\)/);
    // ...and after the provider call, or there is nothing to count yet.
    expect(fn.indexOf("switch (provider)")).toBeLessThan(fn.indexOf("recordLlmTokens("));
  });

  it("counts every provider, not just Anthropic", () => {
    // All three populate `usage`; metering the shared return path is what
    // makes that true in practice rather than in principle.
    const fn = llm.slice(llm.indexOf("export async function invokeLLM"), llm.indexOf("export async function invokeLLM") + 1400);
    for (const p of ["anthropic", "openai", "gemini"]) {
      expect(fn).toContain(`case "${p}":`);
    }
    // Each branch assigns the shared `result`, so none can bypass the meter.
    expect((fn.match(/result = await invokeVia/g) ?? []).length).toBe(3);
  });
});

describe("the write is safe to run on a hot path", () => {
  const fn = llm.slice(llm.indexOf("async function recordLlmTokens"), llm.indexOf("export async function invokeLLM"));

  it("was isolated", () => {
    expect(fn.length).toBeGreaterThan(300);
  });

  it("increments ATOMICALLY rather than read-modify-write", () => {
    /**
     * Concurrent LLM calls are the normal case — the engine runs them in
     * parallel — and a lost update on a spend counter is a bill nobody can
     * reconcile. The `submitCount` bumps elsewhere in this repo are still
     * read-modify-write and recorded as known-open.
     */
    expect(fn).toMatch(/onDuplicateKeyUpdate\(\{[\s\S]{0,200}?sql`\$\{usageCounters\.llmTokens\} \+ /);
    // A select-then-set would be the wrong shape entirely.
    expect(fn).not.toMatch(/\.select\(\)[\s\S]{0,200}?from\(usageCounters\)/);
  });

  it("never fails the call it is measuring", () => {
    // A broken counter is a reporting problem; a thrown counter is an outage.
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/\} catch \(e\) \{/);
    const catchBlock = fn.slice(fn.indexOf("} catch (e) {"));
    expect(catchBlock, "the catch must swallow, not rethrow").not.toMatch(/throw/);
  });

  it("ignores calls it cannot attribute, and non-positive counts", () => {
    // No workspace → env-only credentials, e.g. a script. Counting it against
    // an arbitrary workspace would be worse than not counting it.
    expect(fn).toMatch(/if \(!workspaceId \|\| !Number\.isFinite\(tokens\) \|\| tokens <= 0\) return;/);
  });
});

describe("the writer and the reader agree on the month", () => {
  it("both derive YYYY-MM the same way", () => {
    /**
     * A counter keyed one way and read another reports zero forever while
     * looking wired — the bounceFeedback lesson: normalising a write without
     * normalising the read that pairs with it is its own little bug class.
     */
    const writer = /const month = new Date\(\)\.toISOString\(\)\.slice\(0, 7\)/;
    expect(llm, "writer month key").toMatch(writer);
    expect(admin, "reader month key").toMatch(writer);
  });

  it("the reader still reads the column, so the pair stays wired", () => {
    expect(admin).toMatch(/llmTokens: Number\(row\?\.llmTokens \?\? 0\)/);
    expect(admin).toMatch(/from\(usageCounters\)/);
  });
});

describe("what is still NOT measured", () => {
  it("emailsSent remains unwritten — recorded, not silently accepted", () => {
    /**
     * Same table, same Billing panel, same bug: `emailsSent` is read by
     * usage.currentMonth and rendered as "Emails sent", and nothing increments
     * it either. Not fixed here because the send paths are several (SMTP
     * adapter, system sender, sequence engine, ARE) and picking the wrong
     * funnel would double-count — a wrong number is worse than a zero,
     * because a zero is obviously broken.
     *
     * This test PASSES while it is unwritten and FAILS once someone wires it,
     * so the note cannot rot: whoever adds the writer updates this and the
     * Billing panel stops lying about the other tile too.
     */
    const writers = sourceFiles(join(ROOT, "server")).filter((f) =>
      /emailsSent:\s*sql`|emailsSent:\s*\d|set: \{[^}]*emailsSent/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(
      writers.map((f) => relative(ROOT, f).replace(/\\/g, "/")),
      "\n\nemailsSent is now written somewhere — good. Delete this test and the\n" +
        "note above it, and confirm Settings → Billing shows a real number.\n",
    ).toEqual([]);
  });
});

/**
 * ...and bounded. Two ceilings, both at the same funnel as the meter.
 *
 * 47 invokeLLM call sites across 22 routers had no ceiling of any kind: any
 * signed-in user could drive arbitrary model spend as fast as they could send
 * requests. Enforced in invokeLLM rather than as a list of tRPC paths in the
 * rate-limit middleware — a path list must be maintained, and the 48th call
 * site would simply not be on it.
 */
describe("the burst ceiling", () => {
  const fn = llm.slice(llm.indexOf("function checkLlmBurst"), llm.indexOf("async function checkMonthlyCap"));

  it("was isolated", () => {
    expect(fn.length).toBeGreaterThan(200);
  });

  it("is checked BEFORE the provider call and before a concurrency slot", () => {
    /**
     * A limit enforced after the money is spent is not a limit — and a refused
     * call must not hold a slot that other calls are queued behind.
     */
    const invoke = llm.slice(llm.indexOf("export async function invokeLLM"));
    const check = invoke.indexOf("checkLlmBurst(");
    const cap = invoke.indexOf("checkMonthlyCap(");
    const slot = invoke.indexOf("acquireLlmSlot()");
    const call = invoke.indexOf("switch (provider)");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(slot);
    expect(cap).toBeLessThan(slot);
    expect(slot).toBeLessThan(call);
  });

  it("keys on the USER, and exempts background jobs deliberately", () => {
    /**
     * Engines pass workspaceId explicitly and run with no request context, so
     * getRequestUserId() is undefined for them. They carry their own
     * per-feature daily caps, which is the right control for a job nobody is
     * waiting on. Throttling them here would be throttling the product.
     */
    expect(llm).toMatch(/checkLlmBurst\(getRequestUserId\(\), now\)/);
    expect(fn).toMatch(/if \(!userId\) return;/);
  });

  it("prunes its window rather than counting forever", () => {
    // Without the filter the map only grows and every user is eventually
    // limited by requests they made hours ago.
    expect(fn).toMatch(/filter\(\(t\) => now - t < LLM_BURST_WINDOW_MS\)/);
  });
});

describe("the monthly budget", () => {
  const fn = llm.slice(llm.indexOf("async function checkMonthlyCap"), llm.indexOf("async function recordLlmTokens"));

  it("was isolated", () => {
    expect(fn.length).toBeGreaterThan(400);
  });

  it("defaults to UNLIMITED — no invented number ships", () => {
    /**
     * `llmMonthlyTokenCap` is NULL by default. What a month's budget should be
     * is a billing decision this codebase cannot derive, and a guessed number
     * would cut workspaces off mid-campaign on deploy — the fabrication
     * refused in 974b903 and ff9e04d.
     */
    expect(fn).toMatch(/if \(cap !== null && cap > 0 && used >= cap\)/);
    const schema = read("drizzle/schema.ts");
    expect(schema).toMatch(/llmMonthlyTokenCap: int\("llmMonthlyTokenCap"\)(?!\.default)/);
    // A .notNull() or a .default() here would be exactly the invented number.
    expect(schema).not.toMatch(/llmMonthlyTokenCap: int\("llmMonthlyTokenCap"\)\s*\.\s*(?:notNull|default)/);
  });

  it("applies to background engines too", () => {
    // Unlike the burst ceiling. A budget the autonomous engines are exempt
    // from is not a budget — they are the heaviest spenders in the system.
    expect(fn).not.toMatch(/getRequestUserId/);
    expect(llm).toMatch(/await checkMonthlyCap\(workspaceId, now\)/);
  });

  it("fails OPEN on a database error", () => {
    // At that point the app is already broken; refusing every AI feature on
    // top of it helps nobody. Matches hasActiveEnrollmentForEmail's reasoning.
    expect(fn).toMatch(/catch \(e\) \{[\s\S]{0,220}?return; \/\/ fail open/);
  });

  it("reads the same month key the meter writes", () => {
    expect(fn).toMatch(/const month = new Date\(\)\.toISOString\(\)\.slice\(0, 7\)/);
  });

  it("is cached, so a ceiling does not cost two queries per call", () => {
    expect(fn).toMatch(/capCache/);
    expect(llm).toMatch(/const CAP_CACHE_MS = /);
  });
});

describe("the cap is reachable and persistable", () => {
  it("settings.save accepts it, nullable so it can be turned back off", () => {
    expect(admin).toMatch(/llmMonthlyTokenCap: z\.number\(\)\.int\(\)\.min\(0\)\.nullable\(\)\.optional\(\)/);
  });

  it("migration 0143 adds the column", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    expect(migrations).toMatch(/name: "0143_llm_monthly_token_cap\.sql"/);
    // Asserted as the STATEMENT, not just the column name appearing somewhere:
    // dca9672's guard passed while the ADD COLUMN was deleted, because the name
    // still appeared in a CREATE INDEX line.
    expect(migrations).toMatch(
      /ALTER TABLE `workspace_settings` ADD COLUMN `llmMonthlyTokenCap` int NULL/,
    );
  });
});
