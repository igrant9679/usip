/**
 * Guard for a dead-wiring shape that has now recurred three times in the merge
 * layer:
 *
 *   "a {{token}} the UI offers or a template ships, that some send path's merge
 *    map does not contain."
 *
 * It is silent in the worst possible place. `renderMergeFields` returns
 * `hit ?? match`, so an absent key is emitted VERBATIM — the recipient, a
 * prospect, reads "{{senderCompany}}" in the email. Nothing throws, no log
 * line, and the sender sees a healthy "sent".
 *
 * There are FOUR substitution implementations in this repo, each with its own
 * token set and its own policy for unresolved tokens:
 *
 *   mergeVars.resolveMergeVars   18 tokens, leaves unknown tokens as-is
 *                                (deliberate: reviewers can spot them)
 *   crm.ts renderMergeFields     own map, TWO call groups (contact + lead),
 *                                leaves unknown tokens as-is
 *   sequences.ts renderMergeFields   a duplicate of the above, own map
 *   areEngine.applyMerge         5 tokens, then STRIPS unresolved tags — the
 *                                only one that cannot leak braces
 *
 * senderTitle/senderCompany were fixed in the contact map and in sequences.ts,
 * and missed in crm.ts's lead map (sendAdHocEmail) — three maps, two fixed.
 * That is why this is a test and not a comment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Comments must come out before scanning for tokens. The first version of this
 * test scanned raw source and flagged {{unsubscribeUrl}}, {{tag}} and {{tags}} —
 * every one of them from a doc comment, including the comment written to explain
 * the bug this test exists for.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every `const mergeVars: Record<string, string> = { … }` literal in a file. */
function mergeMaps(src: string): string[][] {
  const maps: string[][] = [];
  const re = /const mergeVars: Record<string, string> = \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    const body = src.slice(open, i);
    // Indent varies by nesting depth: crm.ts's maps sit at 8 spaces inside a
    // loop, sequences.ts's at 4 inside a plain function. Requiring 6+ silently
    // read the sequences map as EMPTY and reported it as missing every key —
    // a scanner that finds nothing looks identical to a file with no bugs.
    maps.push([...body.matchAll(/^\s{2,}([a-zA-Z][a-zA-Z0-9_]*)\s*[:,]/gm)].map((x) => x[1]));
  }
  return maps;
}

/** Tokens the Email Builder offers as clickable insert chips. */
function offeredTokens(): string[] {
  const src = stripComments(read("client/src/pages/usip/EmailBuilder.tsx"));
  return [...src.matchAll(/\{\s*tag:\s*"\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}"/g)].map((m) => m[1]);
}

/** Tokens baked into any starter template that ships with the product. */
function templateTokens(): string[] {
  const files = ["client/src/pages/usip/EmailBuilder.tsx", "server/routers/emailBuilder.ts"];
  const out = new Set<string>();
  for (const f of files) {
    for (const m of stripComments(read(f)).matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)) out.add(m[1]);
  }
  return [...out];
}

const SEND_PATHS = ["server/routers/crm.ts", "server/routers/sequences.ts"];

describe("merge token coverage", () => {
  it("finds the maps and the offered tokens (guards the scanner itself)", () => {
    const maps = SEND_PATHS.flatMap((f) => mergeMaps(read(f)));
    expect(maps.length).toBeGreaterThanOrEqual(3); // contact + lead + sequence
    expect(offeredTokens().length).toBeGreaterThan(4);
  });

  it("every send path's merge map covers the same token set", () => {
    // The actual regression: three maps, two of them updated. Any token present
    // in one map but missing from another is a path that will emit it raw.
    const maps: Array<{ file: string; index: number; keys: Set<string> }> = [];
    for (const f of SEND_PATHS) {
      mergeMaps(read(f)).forEach((keys, i) => maps.push({ file: f, index: i, keys: new Set(keys) }));
    }
    const union = new Set(maps.flatMap((m) => [...m.keys]));
    const gaps: string[] = [];
    for (const m of maps) {
      for (const k of union) {
        if (!m.keys.has(k)) gaps.push(`${m.file} (map #${m.index + 1}) is missing "${k}"`);
      }
    }
    expect(
      gaps,
      gaps.length
        ? `\n\nMerge maps disagree. renderMergeFields emits an absent key VERBATIM, so\n` +
            `the recipient reads the raw braces:\n\n  ${gaps.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("every token the Email Builder offers is resolvable by the send paths", () => {
    const covered = new Set(SEND_PATHS.flatMap((f) => mergeMaps(read(f)).flat()));
    // `signature` is handled by its own dedicated branch, not the map.
    const missing = offeredTokens().filter((t) => !covered.has(t) && t !== "signature");
    expect(
      missing,
      missing.length
        ? `\n\nToken(s) offered as insert chips in the Email Builder that no send path\n` +
            `resolves: ${missing.join(", ")}. A user clicks the chip, the email goes out\n` +
            `with the literal braces in it.\n`
        : undefined,
    ).toEqual([]);
  });

  it("no starter template bakes in an unresolvable token", () => {
    const covered = new Set(SEND_PATHS.flatMap((f) => mergeMaps(read(f)).flat()));
    // unsubscribeUrl is deliberately NOT a merge token: every send path appends
    // its own opt-out footer, and the footer block has a first-class prop.
    const missing = templateTokens().filter((t) => !covered.has(t) && t !== "signature");
    expect(
      missing,
      missing.length
        ? `\n\nStarter template(s) contain token(s) no send path resolves:\n  ${missing.join(", ")}\n\n` +
            `A template is worse than a typed token — the user never chose it and has no\n` +
            `reason to look for it. Add it to every merge map or remove it from the\n` +
            `template.\n`
        : undefined,
    ).toEqual([]);
  });
});
