/**
 * `/manus-storage/<key>` serves customer documents, so it needs a session.
 *
 * The seam: the last unswept public express surface. The question was the same
 * one that found the tracker beacon and the webhook — what can an
 * unauthenticated caller reach?
 *
 * ✅ SSRF: CHECKED AND CLEAN, recorded so nobody re-chases it. The upstream host
 * comes from `ENV.forgeApiUrl`; the caller's key only reaches a query parameter
 * through `searchParams.set`, which encodes it. The fetch cannot be steered.
 *
 * 🔴 What was actually wrong: no authentication at all. Anyone who could name a
 * key got a presigned URL. The only barrier was the 8-hex suffix storagePut
 * appends — 32 bits — while the rest of the key is guessable by construction
 * (`ws-3/quotes/Q-1042.pdf`: small integer workspace ids, sequential quote
 * numbers). A capability URL, and a PERMANENT one — unlike the presigned URL it
 * redirects to, this path never expires, so anywhere it leaks it keeps working.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeStorageKey } from "./_core/storageProxy";

const ROOT = join(__dirname, "..");

/**
 * 🪤 Comment-stripping is NOT parsing, and this file proves it.
 *
 * The usual `/\*[\s\S]*?\*\//g` strip DESTROYS this source, because the route
 * string `"/manus-storage/*"` CONTAINS `/*`. The stripper read that as a
 * comment opener and deleted everything to the next `*​/` — 30 lines including
 * the entire auth block — so four assertions failed against code that was
 * plainly there.
 *
 * Only LINE-LEADING block comments are stripped here, which is what every
 * comment in this file is and what no string literal can be.
 */
const src = readFileSync(join(ROOT, "server/_core/storageProxy.ts"), "utf8")
  .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("isSafeStorageKey", () => {
  it("accepts the keys the app actually writes", () => {
    expect(isSafeStorageKey("ws-3/quotes/Q-1042_a1b2c3d4.pdf")).toBe(true);
    expect(isSafeStorageKey("ws-12/account-briefs/Acme-7_deadbeef.pdf")).toBe(true);
    expect(isSafeStorageKey("generated/1730000000000_ab12cd34.png")).toBe(true);
  });

  it("rejects traversal", () => {
    // Browsers normalise `..` away; `curl --path-as-is` does not, and the key
    // was being forwarded to the storage backend verbatim.
    expect(isSafeStorageKey("../secrets")).toBe(false);
    expect(isSafeStorageKey("ws-3/../ws-4/quotes/Q-1.pdf")).toBe(false);
    expect(isSafeStorageKey("a/b/../../../etc/passwd")).toBe(false);
  });

  it("rejects absolute and windows-style paths", () => {
    expect(isSafeStorageKey("/etc/passwd")).toBe(false);
    expect(isSafeStorageKey("ws-3\\quotes")).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isSafeStorageKey("")).toBe(false);
  });

  it("does not reject a filename that merely CONTAINS dots", () => {
    // `..` is a path SEGMENT, not a substring — `report..final.pdf` is a
    // perfectly ordinary object name and must still resolve.
    expect(isSafeStorageKey("ws-3/quotes/report..final.pdf")).toBe(true);
  });
});

describe("the proxy requires a session", () => {
  it("authenticates before doing anything", () => {
    expect(src).toContain("authenticateRequest");
    expect(src).toMatch(/res\.status\(401\)/);
  });

  it("authenticates BEFORE calling the storage backend", () => {
    // Otherwise an anonymous caller still burns a presign call on our API key.
    const auth = src.indexOf("authenticateRequest");
    const fetchAt = src.indexOf("await fetch(forgeUrl");
    expect(auth).toBeGreaterThan(0);
    expect(fetchAt).toBeGreaterThan(0);
    expect(auth).toBeLessThan(fetchAt);
  });

  it("validates the key before everything", () => {
    const guard = src.indexOf("isSafeStorageKey");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf("authenticateRequest"));
  });
});

describe("a ws-scoped key may only be read by a member of that workspace", () => {
  it("parses the workspace out of the key and checks membership", () => {
    expect(src).toContain("WORKSPACE_KEY");
    expect(src).toContain("workspaceMembers");
    expect(src).toMatch(/eq\(\s*workspaceMembers\.userId\s*,\s*userId\s*\)/);
    expect(src).toMatch(/eq\(\s*workspaceMembers\.workspaceId\s*,\s*workspaceId\s*\)/);
    expect(src).toMatch(/res\.status\(403\)/);
  });

  it("the value it gates on comes FROM that query", () => {
    // Presence and ordering are not enough — the webhook sweep had a mutation
    // pass by leaving the query in place and binding the result to a literal.
    expect(src).toMatch(/const \[member\] = await [\s\S]{0,240}?from\(workspaceMembers\)/);
  });

  it("the refusal is CONDITIONED on the lookup result", () => {
    /**
     * Presence, ordering and binding were all still true when the condition
     * itself was replaced with `if (false)` — the 403 sat there, correctly
     * placed, permanently unreachable. Tying the branch to the variable is what
     * closes that. Same weakness the webhook sweep found, reproduced here by a
     * mutation that passed.
     */
    expect(
      src,
      "\n\nThe 403 must be guarded by the membership RESULT — a branch that is\n" +
        "present and unreachable protects nothing.\n",
    ).toContain("if (!member)");
  });

  it("refuses before reaching the storage backend", () => {
    const forbid = src.indexOf("res.status(403)");
    const fetchAt = src.indexOf("await fetch(forgeUrl");
    expect(forbid).toBeGreaterThan(0);
    expect(forbid).toBeLessThan(fetchAt);
  });

  it("matches the prefix every real writer uses", () => {
    // storagePut callers write `ws-${workspaceId}/…`; if that convention
    // changes the regex has to change with it.
    expect(src).toContain("/^ws-(\\d+)\\//");
    const writers = readFileSync(join(ROOT, "server/routers/operations.ts"), "utf8");
    expect(writers).toContain("`ws-${ctx.workspace.id}/quotes/");
  });
});

describe("no SSRF — the host is ours", () => {
  it("builds the upstream URL from ENV, never from the caller", () => {
    expect(src).toContain("ENV.forgeApiUrl");
    // The key goes in as an encoded query param, not into the URL path.
    expect(src).toContain('forgeUrl.searchParams.set("path", key)');
    expect(src).not.toMatch(/new URL\(\s*key/);
  });
});
