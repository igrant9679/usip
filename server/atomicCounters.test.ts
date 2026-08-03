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

describe("counters are incremented in SQL, not in JavaScript", () => {
  const files = serverFiles();

  it("scans real source (floor)", () => {
    // Without this an empty walk would report a clean repo.
    expect(files.length).toBeGreaterThan(150);
  });

  it("no .set() increments a counter from a value read earlier", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = strip(read(f));
      // Only look inside `.set({ ... })` payloads — arithmetic elsewhere is
      // ordinary code, and flagging it would make this guard noise.
      for (const m of src.matchAll(/\.set\(\{[\s\S]{0,300}?\}/g)) {
        if (JS_INCREMENT.test(m[0])) offenders.push(`${f}  ${m[0].replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
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
