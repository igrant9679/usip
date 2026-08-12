/**
 * The fifth-copy scanner — the cheap guard the 2026-08-06 auth-redirect fix
 * left on the table ("if open redirects come up again, a scanner for
 * startsWith('/') near a redirect sink is the cheap guard").
 *
 * History: four call sites each hand-spelled `returnPath.startsWith("/")`,
 * and every one of them passed `//evil.com` — a protocol-relative URL starts
 * with `/`. One definition now lives in @shared/returnPath (safeReturnPath,
 * which also refuses `/\evil.com` and CRLF). This file is the guard against
 * copy number five: a hand-written leading-slash check sitting next to a
 * redirect sink means someone re-derived the broken version instead of
 * importing the fixed one.
 *
 * Scanner honesty (the source-scanner traps): proximity is a heuristic, so
 * the sink patterns are exact CALL shapes (`res.redirect(`, a
 * `window.location`/`location.href` touch), never bare words — a comment
 * that merely says "redirect" must not flag its function. And the sink
 * allowlist below is effect-checked where cheap, not just named.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Tracked-file grep, immune to cmd.exe quoting (execFileSync, no shell). */
function gitGrep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", ...args], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    return []; // git grep exits 1 on zero matches
  }
}

const SINK = /res\.redirect\s*\(|window\.location|location\.href/;

describe("no fifth hand-written returnPath check", () => {
  it("every startsWith('/') near a redirect sink goes through @shared/returnPath instead", () => {
    const hits = gitGrep(["-n", "-e", 'startsWith("/")', "-e", "startsWith('/')", "--", "server", "client", "shared"])
      .filter((l) => !l.startsWith("shared/returnPath.ts"))
      .filter((l) => !/\.test\.tsx?:/.test(l));

    const flagged: string[] = [];
    for (const hit of hits) {
      const [file, lineStr] = hit.split(":");
      const line = Number(lineStr);
      const lines = readFileSync(file, "utf8").split("\n");
      const windowText = lines.slice(Math.max(0, line - 9), line + 8).join("\n");
      if (SINK.test(windowText)) flagged.push(`${file}:${line}`);
    }
    expect(flagged, "hand-written leading-slash check beside a redirect sink — use safeReturnPath from @shared/returnPath (`//evil.com` starts with `/`)").toEqual([]);
  });
});

describe("every server redirect sink is accounted for", () => {
  /**
   * A file that calls res.redirect() either launders its value through
   * @shared/returnPath or sits on this allowlist with the reason its
   * redirect is safe WITHOUT it. A new file appearing here fails the test
   * and forces that conversation.
   */
  const ALLOWED: Record<string, (src: string) => void> = {
    // External click-through by design: the target is parsed with `new URL`
    // and refused unless http(s). Assert the parse guard is still there.
    "server/emailTracking.ts": (src) => {
      expect(src.includes('parsed.protocol !== "http:"'), "emailTracking lost its protocol guard").toBe(true);
    },
    // Presigned URL from our own storage client — external by construction.
    "server/_core/storageProxy.ts": () => {},
    // Literal in-app paths only. Pin the literals: every redirect arg must
    // START as a quoted "/..." string, so request input cannot reach it.
    "server/graphOAuth.ts": (src) => {
      const total = (src.match(/res\.redirect\(/g) ?? []).length;
      const literalInApp = (src.match(/res\.redirect\(\s*\d+\s*,\s*["'`]\//g) ?? []).length;
      expect(total, "graphOAuth redirect calls not found — re-anchor").toBeGreaterThan(0);
      expect(literalInApp, "a graphOAuth redirect no longer starts with a literal in-app path").toBe(total);
    },
  };

  it("res.redirect callers import @shared/returnPath or carry a checked exemption", () => {
    const files = [...new Set(
      gitGrep(["-l", "res.redirect(", "--", "server"]).filter((f) => !f.endsWith(".test.ts")),
    )];
    expect(files.length, "no redirect sinks found — re-anchor the scan").toBeGreaterThan(0);

    const unaccounted: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (src.includes('from "@shared/returnPath"')) continue;
      const check = ALLOWED[f];
      if (!check) { unaccounted.push(f); continue; }
      check(src);
    }
    expect(unaccounted, "new redirect sink — launder through safeReturnPath or add a checked exemption here").toEqual([]);
  });
});
