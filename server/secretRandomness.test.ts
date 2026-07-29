/**
 * Guard: no credential may be generated with Math.random().
 *
 * `scim_providers.bearerToken` was built as
 *   "scim_" + Math.random().toString(36).slice(2,16) + Math.random().toString(36).slice(2,8)
 * and it authenticates `/api/scim/v2` (scimHttp.ts) — a PUBLIC endpoint whose
 * POST/PUT/PATCH/DELETE handlers create, replace and delete users. So that
 * string is a directory-provisioning credential.
 *
 * Math.random() is V8's xorshift128+. The danger is not merely that the output
 * is short: the generator's internal state can be recovered from a few observed
 * outputs, after which every subsequent token is predictable. It is not a CSPRNG
 * and must never produce anything another party is expected not to guess.
 *
 * Every other secret here already used crypto.randomBytes(32) — invite tokens,
 * invite links, password-setup links, proposal share tokens. This was the single
 * exception, which is the shape of most defects in this codebase: the same job
 * done twice, one of them right.
 *
 * Math.random() remains legitimate for non-secrets (a jittered score, an iCal
 * UID, a demo-data value), so this test targets the assignment CONTEXT rather
 * than banning the call outright.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Identifiers whose value is a credential or an unguessable handle. */
const SECRET_WORDS =
  /(token|secret|password|apikey|api_key|bearer|nonce|salt|signature|sessionid|session_id|privatekey)/i;

describe("credentials use a CSPRNG", () => {
  const files = [...sourceFiles(join(ROOT, "server")), ...sourceFiles(join(ROOT, "shared"))];

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no secret-ish identifier is assigned from Math.random()", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/Math\.random\s*\(/.test(line)) return;
        // Skip comments — including the one above documenting the old bug.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!/Math\.random\s*\(/.test(code)) return;
        // Flag only when the value lands in something credential-shaped.
        const lhs = code.split("=")[0] ?? "";
        if (SECRET_WORDS.test(lhs)) offenders.push(`${rel}:${i + 1}  ${code.trim().slice(0, 110)}`);
      });
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nMath.random() is not a CSPRNG — its internal state is recoverable from a\n` +
            `few outputs, so these values are PREDICTABLE:\n\n  ${offenders.join("\n  ")}\n\n` +
            `Use crypto.randomBytes(32).toString("hex"), as the rest of the codebase does.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the SCIM bearer token specifically comes from randomBytes", () => {
    // Named explicitly because this one authenticates a public endpoint that can
    // delete users, and because a generic scan is easy to defeat by accident
    // (renaming the variable would silence the test above).
    const src = readFileSync(join(ROOT, "server", "routers", "operations.ts"), "utf8");
    expect(src).toMatch(/function newScimBearerToken\(\)/);
    expect(src).toMatch(/crypto\.randomBytes\(32\)\.toString\("hex"\)/);
    // Both the create and the rotate path must use it.
    expect((src.match(/newScimBearerToken\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
