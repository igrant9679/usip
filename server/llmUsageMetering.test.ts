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
