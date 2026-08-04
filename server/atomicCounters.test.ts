/**
 * A counter bumped in JS is a LOST UPDATE.
 *
 * `set({ submitCount: (row.submitCount ?? 0) + 1 })` computes the new value from
 * a row read earlier in the handler. Two people submitting the same public form
 * or landing page at the same moment both read N and both write N+1, so two
 * submissions are recorded as one. It never errors and never logs — the number
 * is just quietly too low.
 *
 * THIS IS THE THIRD TIME. `bookingLinks.bookingCount` was fixed in 72aa576 and
 * `sendingAccountDailyStats` before it; the two `submitCount` bumps survived
 * because nothing looked for the SHAPE. What made this pair visible at all is
 * that `landingPages.viewCount` — forty lines above its own submitCount — was
 * already atomic, so one page had both spellings side by side and the
 * conversion rate an admin judges it by is computed from the two together.
 *
 * The guard scans for the shape rather than the names, because the next one
 * will be called something else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      out.push(rel);
    }
  };
  walk("server");
  return out;
}

/**
 * `<name>: (<expr>) + 1` or `<name>: <expr> + 1` inside a `.set({...})`.
 *
 * Deliberately narrow: it matches a counter being incremented from a JS value,
 * not arithmetic in general. `sql\`${col} + 1\`` does not match, because there
 * the addition happens in the database.
 */
const JS_INCREMENT = /(\w+):\s*\(?[\w.?\s]*\?\?\s*0\)?\s*\+\s*1|(\w+):\s*\(?\w+\.\w+\s*\?\?\s*0\)?\s*\+\s*1/;

/**
 * 🔴 THE SHAPE THIS GUARD COULD NOT SEE (found 2026-08-04 by mutation).
 *
 * The scan matched `.set({` only. A drizzle UPSERT spells it
 * `onDuplicateKeyUpdate({ set: { … } })` — no dot, no paren — and there are 20
 * such sites across 17 server files. `server/usageCounters.ts`, which is where
 * this repo's actual counters live and the file most likely to grow the next
 * lost update, contains **zero** `.set({`. A planted JS increment in its upsert
 * was reported clean by a guard whose whole purpose is to find exactly that.
 *
 * Both payload spellings are scanned now, and `SCANNED_PAYLOAD_FLOOR` below
 * keeps the count honest: a rename that makes the pattern stop matching must
 * fail loudly rather than report a clean repo.
 */
const SET_PAYLOAD = /(?:\.set\(\{|set:\s*\{)[\s\S]{0,300}?\}/g;

/** Returns one line per offending payload. Exported shape so the synthetic
 *  positives below can prove the scanner still sees. */
function jsIncrementOffenders(src: string, label: string): { offenders: string[]; scanned: number } {
  const offenders: string[] = [];
  let scanned = 0;
  for (const m of src.matchAll(SET_PAYLOAD)) {
    scanned++;
    if (JS_INCREMENT.test(m[0])) offenders.push(`${label}  ${m[0].replace(/\s+/g, " ").slice(0, 100)}`);
  }
  return { offenders, scanned };
}

/**
 * 📏 A NUMBER, NOT A CLAIM. "0 findings" means nothing unless the scanner is
 * still looking at something. Measured 2026-08-04: **443** payloads across 230
 * server files, all clean.
 *
 * ⚠️ THE WIDENING ADDED ONLY 10 PAYLOADS (433 → 443) — which is the point, and
 * the reason a volume metric would have hidden this. The old scan was already
 * looking at 433 places and still could not see `usageCounters.ts` at all. A
 * blind spot is about WHICH idiom is matched, not how much is matched, so do
 * not read a healthy total here as coverage of any particular file.
 */
const SCANNED_PAYLOAD_FLOOR = 150;

describe("counters are incremented in SQL, not in JavaScript", () => {
  const files = serverFiles();

  it("scans real source (floor)", () => {
    // Without this an empty walk would report a clean repo.
    expect(files.length).toBeGreaterThan(150);
  });

  /**
   * 🧪 SYNTHETIC POSITIVES — the checker is proven IN CI, every run, rather
   * than by a scratchpad battery nobody re-runs. Each fabricated snippet
   * carries the defect in one of the two payload spellings and the scanner is
   * required to report it; the atomic versions are required NOT to be reported,
   * so a scanner loosened into flagging everything fails here too.
   */
  it("the scanner still SEES — both payload spellings, and neither false-positives", () => {
    const bad = [
      ['.set({ dotted', 'await db.update(t).set({ submitCount: (row.submitCount ?? 0) + 1 });'],
      ['upsert set:', 'await db.insert(t).values(v).onDuplicateKeyUpdate({ set: { llmTokens: (existing?.llmTokens ?? 0) + 1 } });'],
      ['bare expr', 'await db.update(t).set({ viewCount: row.viewCount ?? 0 + 1 });'],
    ] as const;
    for (const [name, snippet] of bad) {
      expect(jsIncrementOffenders(snippet, name).offenders, `MISSED: ${name}`).toHaveLength(1);
    }

    const good = [
      ['.set({ atomic', 'await db.update(t).set({ submitCount: sql`${t.submitCount} + 1` });'],
      ['upsert atomic', 'await db.insert(t).values(v).onDuplicateKeyUpdate({ set: { llmTokens: sql`${col} + ${amount}` } });'],
      ['ordinary arithmetic', 'const next = (page ?? 0) + 1;'],
    ] as const;
    for (const [name, snippet] of good) {
      expect(jsIncrementOffenders(snippet, name).offenders, `FALSE POSITIVE: ${name}`).toEqual([]);
    }
  });

  it("no counter payload increments from a value read earlier", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of files) {
      // Only look inside update/upsert payloads — arithmetic elsewhere is
      // ordinary code, and flagging it would make this guard noise.
      const r = jsIncrementOffenders(strip(read(f)), f);
      offenders.push(...r.offenders);
      scanned += r.scanned;
    }
    expect(
      scanned,
      `only ${scanned} update payloads matched — the scan has gone blind, so "0 findings" is meaningless`,
    ).toBeGreaterThan(SCANNED_PAYLOAD_FLOOR);
    expect(
      offenders,
      offenders.length
        ? `\n\nCounter incremented in JS:\n  ${offenders.join("\n  ")}\n\n` +
          `Two concurrent writers both read N and both write N+1, so one of the\n` +
          `two events is silently lost. Use sql\`\${table.col} + 1\` so the\n` +
          `database does the addition. Third occurrence of this shape — see\n` +
          `72aa576 (bookingCount) and the sendingAccountDailyStats fix.\n`
        : undefined,
    ).toEqual([]);
  });
});

describe("the two counters this commit fixed", () => {
  /**
   * Named explicitly as well as scanned, so that deleting the bump altogether —
   * which the shape scan above would happily call clean — still fails.
   */
  it("landing-page submitCount is atomic", () => {
    const src = strip(read("server/routers/landingPages.ts"));
    expect(src).toMatch(/submitCount: sql`\$\{landingPages\.submitCount\} \+ 1`/);
  });

  it("form submitCount is atomic", () => {
    const src = strip(read("server/routers/forms.ts"));
    expect(src).toMatch(/submitCount: sql`\$\{forms\.submitCount\} \+ 1`/);
  });

  it("landing-page viewCount stayed atomic", () => {
    // It was already correct, and it is the reason the pair was noticed.
    const src = strip(read("server/routers/landingPages.ts"));
    expect(src).toMatch(/viewCount: sql`\$\{landingPages\.viewCount\} \+ 1`/);
  });
});

describe("a public landing page keeps a bookable host", () => {
  const src = strip(read("server/routers/landingPages.ts"));

  it("resolves the booking host through the membership gate, then falls back", () => {
    /**
     * `createdByUserId` is stamped once at create and is NOT part of
     * `contentInput`, so no admin can change a page's booking host through the
     * UI. Without the fallback, an author leaving kills the CTA on a live
     * published page permanently — the client hides the button when bookingUrl
     * is null, so it fails silently and unfixably.
     */
    expect(src).toMatch(
      /const host =\s*\(await activeOwnerOrNull\(p\.workspaceId, p\.createdByUserId\)\) \?\?\s*\(await workspaceNotifyUserId\(p\.workspaceId\)\);/,
    );
    expect(src).toMatch(/bookingUrl = host \? await resolveBookingUrl\(p\.workspaceId, host\) : "";/);
  });

  it("the host is still not taken raw from the page row", () => {
    // The bug this replaced: resolveBookingUrl(p.workspaceId, p.createdByUserId).
    expect(src).not.toMatch(/resolveBookingUrl\(p\.workspaceId, p\.createdByUserId\)/);
  });

  it("createdByUserId is still NOT editable, which is why the fallback exists", () => {
    /**
     * If this ever becomes settable, the fallback stops being the only repair
     * and this whole justification should be revisited — so the assumption is
     * pinned rather than left in a comment.
     */
    const input = src.slice(src.indexOf("const contentInput"), src.indexOf("export const landingPagesRouter"));
    expect(input.length, "contentInput was not found — re-anchor this test").toBeGreaterThan(100);
    expect(input).not.toMatch(/createdByUserId/);
  });
});
