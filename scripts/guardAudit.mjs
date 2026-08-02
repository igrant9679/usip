/**
 * Guard auditor — find test assertions that CANNOT FAIL, then prove it.
 *
 *   node scripts/guardAudit.mjs scan
 *   node scripts/guardAudit.mjs mutate <battery.json>
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * This repo's guards are mostly source scanners, and a scanner asserts what it
 * can SEE, which is not the same as what RUNS. Five mutations passed against
 * freshly-written tests in a single session (see SESSION_STATUS.md), and the
 * 2026-08-01 re-audit found two more that the whole 1601-test suite missed:
 * a disabled enrollment dedupe and a bypassed custom-field allowlist.
 *
 * A guard that cannot fail is worse than no guard: it manufactures confidence.
 *
 * ─── SCAN: four shapes with a track record ───────────────────────────────────
 *  A. one-arg `slice(x.indexOf(TOK))` with no found-check.
 *     indexOf returns -1 and slice(-1) is the LAST CHARACTER, so every
 *     assertion on that slice passes vacuously — lethal with `.not.toMatch`.
 *     (The two-arg form `slice(-1, N)` yields "" and is SAFE.)
 *  B. `expect(a.indexOf(X)).toBeLessThan(b.indexOf(Y))` with no found-check.
 *     -1 < anything: the ordering guard goes GREEN when X is deleted outright.
 *  C. `toContain` against a WHOLE FILE. One occurrence satisfies it forever, no
 *     matter how many ungated siblings join it. (b15490d, dca9672, replyScope.)
 *  D. a scan asserted with no floor — an empty scan reports clean. (a278a39.)
 *
 * FLAGGED IS NOT GUILTY. A vacuous assertion is harmless if a sibling in the
 * same file still goes red on the real bug. The scan produces suspects; only
 * `mutate` returns a verdict.
 *
 * ─── MUTATE: the verdict ─────────────────────────────────────────────────────
 * Battery JSON is a list of {id, file, find | re, repl, guard, what}. Rules the
 * runner enforces, each one learned by getting it wrong:
 *   · `find` must match EXACTLY ONCE — a mutation that silently applied
 *     nowhere reports the guard as healthy;
 *   · the mutation must leave the file PARSING, or vitest prints "no tests"
 *     and a green-looking summary means nothing;
 *   · the mutation must disable the EFFECT, not rename a token — otherwise it
 *     tests the assertion's spelling, not the protection;
 *   · the original is restored in a `finally`, and git status is printed at the
 *     end so a half-applied battery cannot be mistaken for a clean tree.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function testFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

function scan() {
  const files = testFiles();
  // Floor: the scanner has to have found source, or it reports a clean repo.
  if (files.length < 90) {
    console.error(`FLOOR FAILED: ${files.length} test files found, expected >= 90`);
    process.exit(1);
  }

  const findings = [];
  const add = (shape, file, line, text, note) =>
    findings.push({ shape, file: relative(ROOT, file).replace(/\\/g, "/"), line, text: text.trim(), note });

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/readFileSync/.test(src)) continue; // shapes A-D only apply to scanners
    const lines = src.split("\n");

    lines.forEach((ln, i) => {
      const win = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
      const proven = /toBeGreaterThan|toBeGreaterThanOrEqual|not\.toBe\(-1\)/.test(win);

      // A — one-arg slice only; the two-arg form degrades to "" and is safe.
      const m = ln.match(/\.slice\(\s*([A-Za-z_$][\w$]*)\.indexOf\(([^)]*)\)\s*\)/);
      if (m && !proven) add("A", f, i + 1, ln, `slice from indexOf(${m[2]}) — -1 slices to the last char`);

      // B
      if (/expect\(.*indexOf\(/.test(ln) && /toBeLessThan/.test(ln) && !proven)
        add("B", f, i + 1, ln, "-1 < N passes when the token is DELETED");
    });

    // C — identifiers bound directly to a whole-file read
    const whole = new Set(
      [...src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\()?readFileSync\(/g)].map((x) => x[1]),
    );
    lines.forEach((ln, i) => {
      const e = ln.match(/expect\(\s*([A-Za-z_$][\w$]*)\s*[,)]/);
      if (!e || !whole.has(e[1])) return;
      const c = lines.slice(i, i + 6).join("\n").match(/\.toContain\(\s*(["'`][^"'`]*["'`])/);
      if (c) add("C", f, i + 1, ln, `whole-file toContain(${c[1]}) — one hit anywhere satisfies it`);
    });

    // D — a scan result asserted with no floor on what it found
    for (const g of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[\s\S]{0,200}?\.(?:filter|matchAll)\(/g)) {
      const v = g[1];
      const at = src.indexOf(v, g.index + g[0].length);
      if (at === -1) continue;
      const rest = src.slice(at, at + 900);
      const asserted = new RegExp(`expect\\(\\s*${escapeRe(v)}`).test(rest);
      const floored = new RegExp(
        `expect\\(\\s*${escapeRe(v)}(?:\\.length)?\\s*[,)][\\s\\S]{0,200}?(?:toBeGreaterThan|toHaveLength|toBe\\(\\s*[1-9])`,
      ).test(rest);
      if (asserted && !floored)
        add("D", f, src.slice(0, g.index).split("\n").length, g[0].split("\n")[0], `'${v}' has no floor — an empty scan reports clean`);
    }
  }

  const titles = {
    A: "slice(indexOf(..)) with no found-check   [-1 slices to the last char]",
    B: "ordering on an unproven indexOf         [-1 < N passes on DELETION]",
    C: "toContain against a WHOLE FILE          [one hit anywhere satisfies]",
    D: "scan asserted with no floor             [an empty scan reports clean]",
  };
  console.log(`Scanned ${files.length} test files.`);
  for (const shape of ["A", "B", "C", "D"]) {
    const list = findings.filter((x) => x.shape === shape);
    console.log(`\n===== ${shape}. ${titles[shape]} — ${list.length} =====`);
    for (const x of list) console.log(`  ${x.file}:${x.line}\n      ${x.text}\n      ^ ${x.note}`);
  }
  console.log(`\nTOTAL FLAGGED: ${findings.length}`);
  console.log("\nFlagged is NOT guilty — a vacuous assertion is harmless if a sibling");
  console.log("in the same file still goes red. Confirm with:  guardAudit.mjs mutate");
}

function mutate(batteryPath) {
  const battery = JSON.parse(readFileSync(batteryPath, "utf8"));
  const results = [];

  for (const m of battery) {
    const path = join(ROOT, m.file);
    const original = readFileSync(path, "utf8");
    const pattern = m.re ? new RegExp(m.re, m.reFlags ?? "") : null;
    // Flags are de-duplicated: a battery entry that already passes "g" used to
    // build "gg" here and crash the whole run with an unhelpful RegExp error,
    // mid-battery. A harness that dies is worse than one that reports a
    // failure, because the run is left half-done.
    const countFlags = [...new Set(((pattern?.flags ?? "") + "g").split(""))].join("");
    const hits = pattern
      ? (original.match(new RegExp(pattern.source, countFlags)) ?? []).length
      : original.split(m.find).length - 1;

    if (hits !== 1) {
      console.log(`⚠️  ${m.id}: pattern matched ${hits}x, expected exactly 1 — MUTATION NOT APPLIED`);
      results.push({ ...m, verdict: "HARNESS-FAILURE" });
      continue;
    }

    try {
      writeFileSync(path, original.replace(pattern ?? m.find, m.repl), "utf8");
      let out = "";
      try {
        out = execSync(`npx vitest run ${m.guard} --reporter=basic 2>&1`, {
          cwd: ROOT, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024,
        });
      } catch (e) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; }

      // ANSI must be stripped before parsing, or every summary reads as absent.
      const clean = out.replace(/\[[0-9;]*m/g, "");
      const summary = /Test Files\s+(.+)/.exec(clean)?.[1]?.trim() ?? "(no summary)";
      const ran = /Test Files/.test(clean) && !/No test files found/.test(clean);
      const broke = /Failed to parse|Transform failed|SyntaxError/.test(clean);
      const verdict = !ran || broke ? "HARNESS-FAILURE" : /failed/.test(summary) ? "KILLED" : "SURVIVED";
      results.push({ ...m, verdict, summary });
      console.log(
        `${verdict === "KILLED" ? "✅ killed  " : verdict === "SURVIVED" ? "🔴 SURVIVED" : "⚠️  HARNESS "} ` +
        `${m.id.padEnd(30)} ${summary}${broke ? "  (mutation broke the parse — proves nothing)" : ""}`,
      );
    } finally {
      writeFileSync(path, original, "utf8"); // always, even on throw
    }
  }

  const bad = results.filter((r) => r.verdict !== "KILLED");
  console.log("\n================ SUMMARY ================");
  for (const r of bad) console.log(`${r.verdict}  ${r.id}\n    → ${r.what ?? ""}`);
  console.log(bad.length ? `\n${bad.length} of ${results.length} NOT killed.` : `\nAll ${results.length} mutations killed.`);
  console.log("\n--- git status (every mutation must be reverted) ---");
  console.log(execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" }) || "(clean)");
  process.exitCode = bad.length ? 1 : 0;
}

const [mode, arg] = process.argv.slice(2);
if (mode === "scan") scan();
else if (mode === "mutate" && arg) mutate(arg);
else {
  console.error("usage:\n  node scripts/guardAudit.mjs scan\n  node scripts/guardAudit.mjs mutate <battery.json>");
  process.exit(2);
}
