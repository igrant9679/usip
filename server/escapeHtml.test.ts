/**
 * One escaper, because the weakest copy was the one used in attributes.
 *
 * Five HTML escapers existed. Three escaped `"`, two did not — and one of the
 * two that did not is `proposalExports/buildPrintHTML.ts`, which builds the
 * printable proposal a CUSTOMER receives and renders:
 *
 *     <img src="${esc(sender.logo)}" alt="${esc(sender.org)}" onerror="…"/>
 *
 * A workspace's branding org-name or logo URL containing a double quote closes
 * the attribute early, and everything after it parses as MORE ATTRIBUTES. The
 * identical helper two directories away had always escaped the quote. Nothing
 * bound them together, so the copies drifted and the weaker one happened to land
 * in the riskier place.
 *
 * (`reportScheduler.ts` had the same weak copy but interpolates only into
 * element text, so it was latent rather than live — verified rather than
 * assumed, and fixed anyway because the next line someone adds there is a
 * `title="…"`.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { escapeHtml } from "../shared/escapeHtml";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("escapeHtml", () => {
  it("escapes both quote styles, not just the angle brackets", () => {
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("closes the attribute-injection this was written for", () => {
    // The real shape: an org name that ends the alt attribute and opens an
    // event handler. After escaping there is no quote left to break out with.
    const evil = '" onerror="alert(1)';
    const attr = `<img alt="${escapeHtml(evil)}">`;
    expect(attr).not.toMatch(/alt="[^"]*"\s+onerror/);
    expect(escapeHtml(evil)).toBe("&quot; onerror=&quot;alert(1)");
    // Single-quoted attributes too — a helper safe in one style and not the
    // other is the same trap one level down.
    expect(escapeHtml("' onload='x")).toBe("&#39; onload=&#39;x");
  });

  it("escapes the ampersand FIRST so nothing is double-escaped", () => {
    // Wrong order turns "<" into "&amp;lt;" and the page shows the entity.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("takes anything, since the callers pass unknown fields", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(0)).toBe("0");
    expect(escapeHtml(false)).toBe("false");
  });
});

describe("only one escaper", () => {
  function sourceFiles(...dirs: string[]): string[] {
    const out: string[] = [];
    for (const dir of dirs) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...sourceFiles(p));
        else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
      }
    }
    return out;
  }

  const files = sourceFiles(join(ROOT, "server"), join(ROOT, "client", "src"), join(ROOT, "shared"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("nothing hand-rolls an HTML escape chain", () => {
    // The fingerprint every copy shared: replacing `<` with &lt;. Comments are
    // stripped first — this file and shared/escapeHtml.ts both discuss them.
    const offenders = files
      .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }))
      .filter((f) => f.rel !== "shared/escapeHtml.ts")
      // The DIRECTION is the fingerprint, not the characters. Matching `<` and
      // `&lt;` separately flagged four files that go the other way — urlScraper
      // and unipileMailAdapter DECODE entities out of scraped/received HTML, and
      // two components render a literal `&lt;{email}&gt;` in JSX. An escaper is
      // specifically `<` → `&lt;`.
      .filter((f) => /replace\(\s*\/<\/g\s*,\s*["'`]&lt;/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      offenders.length
        ? `\n\nA hand-rolled HTML escaper in:\n  ${offenders.join("\n  ")}\n\n` +
            `Import escapeHtml from @shared/escapeHtml. Five copies existed and the\n` +
            `two that forgot the quote were not the ones anyone checked — one of them\n` +
            `escaped straight into an HTML attribute.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the customer-facing proposal builder uses it in its attributes", () => {
    const src = stripComments(read("client/src/pages/usip/proposalExports/buildPrintHTML.ts"));
    expect(src).toMatch(/from\s*"@shared\/escapeHtml"/);
    // Every attribute interpolation in that file must run through the escaper.
    const attrs = [...src.matchAll(/(?:src|alt|href|title)="\$\{([^}]*)\}"/g)].map((m) => m[1]);
    expect(attrs.length).toBeGreaterThan(0); // floor: the scan found the attributes
    for (const a of attrs) {
      expect(a, `attribute interpolation without an escaper: ${a}`).toMatch(/esc\(|escapeHtml\(/);
    }
  });

  it("every former copy now imports the shared module", () => {
    for (const rel of [
      "server/routers/crm.ts",
      "server/mergeVars.ts",
      "server/services/meetingReminders.ts",
      "server/services/reportScheduler.ts",
      "client/src/pages/usip/proposalExports/buildPrintHTML.ts",
    ]) {
      expect(stripComments(read(rel)), rel).toMatch(/from\s*"@shared\/escapeHtml"/);
    }
  });
});
