/**
 * The MX pre-check, and above all its asymmetry.
 *
 * The check exists to stop the finder spending 3 Reoon quick credits per
 * prospect on a domain that cannot receive mail. That saving is worth nothing
 * next to the risk it introduces if it gets the ambiguous cases wrong:
 *
 *   the sweeper stamps `enrichedAt` on EVERY attempt, hit or miss, so a
 *   prospect skipped because of a DNS timeout is skipped PERMANENTLY.
 *
 * So `acceptsMail: false` must be reachable ONLY from a definitive answer, and
 * every failure mode — timeout, SERVFAIL, refused, an error shape we have never
 * seen — must fall through and verify as before. Most of this file is that one
 * property, tested from as many directions as it can fail from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

/**
 * The module builds ONE resolver at import time, so the mock has to be in place
 * before the import and the methods are stubbed on the instance it holds.
 */
const mocks = vi.hoisted(() => ({
  resolveMx: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveMx = mocks.resolveMx;
    resolve4 = mocks.resolve4;
    resolve6 = mocks.resolve6;
  },
}));

import { domainAcceptsMail, __clearMxCache } from "./services/scraper/mxCheck";

/** A DNS error as Node actually throws it: the `code` property is the signal. */
function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`queryMx ${code}`), { code });
}

const mx = (exchange: string, priority = 10) => ({ exchange, priority });

beforeEach(() => {
  vi.resetAllMocks();
  __clearMxCache();
  // Default: nothing resolves definitively, so each test opts in to a shape.
  mocks.resolve4.mockRejectedValue(dnsError("ENODATA"));
  mocks.resolve6.mockRejectedValue(dnsError("ENODATA"));
});

afterEach(() => __clearMxCache());

describe("definitive NO — the only way to skip a domain", () => {
  it("refuses a domain that does not resolve at all", async () => {
    mocks.resolveMx.mockRejectedValue(dnsError("ENOTFOUND"));
    mocks.resolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    mocks.resolve6.mockRejectedValue(dnsError("ENOTFOUND"));
    const v = await domainAcceptsMail("nope.invalid");
    expect(v.acceptsMail).toBe(false);
    expect(v.reason).toBe("no_such_domain");
  });

  it("refuses a domain that resolves but publishes no MX and no address", async () => {
    mocks.resolveMx.mockRejectedValue(dnsError("ENODATA"));
    const v = await domainAcceptsMail("parked.example");
    expect(v.acceptsMail).toBe(false);
    expect(v.reason).toBe("no_records");
  });

  it("honours RFC 7505 null MX as an explicit refusal", async () => {
    // A single MX pointing at the root is the domain owner SAYING it takes no
    // mail — an explicit statement, not an absence of one.
    mocks.resolveMx.mockResolvedValue([mx(".", 0)]);
    expect((await domainAcceptsMail("nomail.example")).acceptsMail).toBe(false);
    __clearMxCache();
    // Node has been seen to report the root exchange as "" rather than ".".
    mocks.resolveMx.mockResolvedValue([mx("", 0)]);
    expect((await domainAcceptsMail("nomail2.example")).acceptsMail).toBe(false);
  });

  it("treats an empty MX array exactly as ENODATA", async () => {
    mocks.resolveMx.mockResolvedValue([]);
    const v = await domainAcceptsMail("empty.example");
    expect(v.acceptsMail).toBe(false);
    expect(v.reason).toBe("no_records");
  });
});

describe("FAIL OPEN — every ambiguous answer must let verification proceed", () => {
  /**
   * The failure that would matter. A skipped prospect is skipped forever, so
   * "I could not ask" must never be recorded as "the answer is no".
   */
  it.each(["ETIMEOUT", "ESERVFAIL", "EREFUSED", "ECONNREFUSED", "EAI_AGAIN", "SOMETHING_NEW"])(
    "proceeds when the MX lookup fails with %s",
    async (code) => {
      mocks.resolveMx.mockRejectedValue(dnsError(code));
      const v = await domainAcceptsMail("acme.io");
      expect(v.acceptsMail).toBe(true);
      expect(v.reason).toBe("dns_error");
    },
  );

  it("proceeds when the error carries no code at all", async () => {
    mocks.resolveMx.mockRejectedValue(new Error("boom"));
    expect((await domainAcceptsMail("acme.io")).acceptsMail).toBe(true);
  });

  it("proceeds when a non-Error is thrown", async () => {
    mocks.resolveMx.mockRejectedValue("just a string");
    expect((await domainAcceptsMail("acme.io")).acceptsMail).toBe(true);
  });

  it("proceeds when MX is definitively absent but the A lookup is ambiguous", async () => {
    // Half an answer is not an answer: without a usable A result we do not know
    // whether the implicit-MX fallback applies.
    mocks.resolveMx.mockRejectedValue(dnsError("ENODATA"));
    mocks.resolve4.mockRejectedValue(dnsError("ETIMEOUT"));
    const v = await domainAcceptsMail("acme.io");
    expect(v.acceptsMail).toBe(true);
    expect(v.reason).toBe("dns_error");
  });

  it("proceeds on an empty domain rather than disabling enrichment", async () => {
    const v = await domainAcceptsMail("");
    expect(v.acceptsMail).toBe(true);
    expect(mocks.resolveMx).not.toHaveBeenCalled();
  });
});

describe("definitive YES", () => {
  it("accepts a domain with MX records, best priority first", async () => {
    mocks.resolveMx.mockResolvedValue([mx("alt2.aspmx.l.google.com", 20), mx("aspmx.l.google.com", 1)]);
    const v = await domainAcceptsMail("acme.io");
    expect(v.acceptsMail).toBe(true);
    expect(v.reason).toBe("mx");
    expect(v.hosts).toEqual(["aspmx.l.google.com", "alt2.aspmx.l.google.com"]);
  });

  it("accepts an A-record-only domain — RFC 5321 implicit mail exchanger", async () => {
    /**
     * The false-positive that would cost real contacts. Small businesses
     * routinely run mail on the A record with no MX published, so "no MX"
     * alone must never be a refusal.
     */
    mocks.resolveMx.mockRejectedValue(dnsError("ENODATA"));
    mocks.resolve4.mockResolvedValue(["203.0.113.10"]);
    const v = await domainAcceptsMail("smallbiz.example");
    expect(v.acceptsMail).toBe(true);
    expect(v.reason).toBe("a_fallback");
  });

  it("falls back to AAAA when there is no A record", async () => {
    mocks.resolveMx.mockRejectedValue(dnsError("ENODATA"));
    mocks.resolve4.mockRejectedValue(dnsError("ENODATA"));
    mocks.resolve6.mockResolvedValue(["2001:db8::1"]);
    expect((await domainAcceptsMail("v6.example")).reason).toBe("a_fallback");
  });

  it("does not treat an empty address array as an address", async () => {
    mocks.resolveMx.mockRejectedValue(dnsError("ENODATA"));
    mocks.resolve4.mockResolvedValue([]);
    mocks.resolve6.mockResolvedValue([]);
    expect((await domainAcceptsMail("hollow.example")).acceptsMail).toBe(false);
  });
});

describe("caching", () => {
  it("asks DNS once per domain", async () => {
    mocks.resolveMx.mockResolvedValue([mx("mail.acme.io")]);
    await domainAcceptsMail("acme.io");
    await domainAcceptsMail("acme.io");
    await domainAcceptsMail("acme.io");
    expect(mocks.resolveMx).toHaveBeenCalledTimes(1);
  });

  it("keeps domains apart", async () => {
    mocks.resolveMx.mockResolvedValue([mx("mail.acme.io")]);
    await domainAcceptsMail("acme.io");
    await domainAcceptsMail("other.io");
    expect(mocks.resolveMx).toHaveBeenCalledTimes(2);
  });

  it("is case-insensitive, so one employer is not looked up twice", async () => {
    mocks.resolveMx.mockResolvedValue([mx("mail.acme.io")]);
    await domainAcceptsMail("acme.io");
    await domainAcceptsMail("ACME.IO");
    await domainAcceptsMail("  Acme.Io  ");
    expect(mocks.resolveMx).toHaveBeenCalledTimes(1);
  });

  it("caches the negative too — that is the case worth not repeating", async () => {
    mocks.resolveMx.mockRejectedValue(dnsError("ENOTFOUND"));
    mocks.resolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    mocks.resolve6.mockRejectedValue(dnsError("ENOTFOUND"));
    await domainAcceptsMail("dead.example");
    await domainAcceptsMail("dead.example");
    expect(mocks.resolveMx).toHaveBeenCalledTimes(1);
  });
});

describe("where the check sits in each caller", () => {
  const src = read("server/services/scraper/index.ts");

  function windowBetween(startAnchor: string, endAnchor: string): string {
    const at = src.indexOf(startAnchor);
    expect(at, `start anchor not found — re-anchor: ${startAnchor}`).toBeGreaterThan(-1);
    const end = src.indexOf(endAnchor, at + startAnchor.length);
    expect(end, `end anchor not found — re-anchor: ${endAnchor}`).toBeGreaterThan(at);
    return src.slice(at, end);
  }

  it("runs before any Reoon call in BOTH entry points", () => {
    // The entire point is that it precedes spend. Two call sites, both gated.
    const calls = src.match(/domainAcceptsMail\(domain\)/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("resolveVerifiedEmail checks before it scrapes", () => {
    // That function returns no phone, so a scrape on a mail-less domain buys
    // nothing — the check belongs above it.
    const fn = windowBetween("export async function resolveVerifiedEmail", "const patterns = generatePatterns(first");
    const checkAt = fn.indexOf("domainAcceptsMail(domain)");
    const scrapeAt = fn.indexOf("scrapeCompanySite(domain)");
    expect(checkAt, "check missing").toBeGreaterThan(-1);
    expect(scrapeAt, "scrape missing — re-anchor").toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(scrapeAt);
  });

  it("lookupContactInfo checks AFTER the scrape, so a phone is never lost", () => {
    /**
     * The asymmetry between the two callers, pinned. lookupContactInfo persists
     * phones and social URLs; those are worth having on a domain that takes no
     * mail. Only the Reoon spend is pointless, so only it is skipped — moving
     * this check to the top of the function would silently start discarding
     * phone numbers to save credits that were never going to be spent.
     */
    const fn = windowBetween("export async function lookupContactInfo", "// 4. Two-stage verification");
    const scrapeAt = fn.indexOf("scrapeCompanySite(domain)");
    const checkAt = fn.indexOf("domainAcceptsMail(domain)");
    const patternsAt = fn.indexOf("generatePatterns(input.firstName");
    expect(scrapeAt, "scrape missing — re-anchor").toBeGreaterThan(-1);
    expect(checkAt, "check missing").toBeGreaterThan(-1);
    expect(patternsAt, "pattern generation missing — re-anchor").toBeGreaterThan(-1);
    expect(scrapeAt).toBeLessThan(checkAt);
    expect(checkAt).toBeLessThan(patternsAt);
  });

  it("the skip path still writes the scraped enrichment", () => {
    /**
     * Anchored on the skipReason, NOT on `domainAcceptsMail(domain)`.
     *
     * That call appears in both entry points and `indexOf` returns the first —
     * resolveVerifiedEmail's — so the window ran from there through
     * lookupContactInfo's pattern generation and swallowed the synthetic_name
     * and skipIfHasEmail blocks, which carry these same two lines. The
     * assertion passed against code it was not testing, and a mutation gutting
     * the no-MX persist survived it. Ambiguous anchor, same lesson as the
     * batteries: require the window to be the block you mean.
     */
    const fn = windowBetween("enrichment.skipReason = `no_mx", "// 3. Generate patterns");
    // The no-MX block measures ~970 chars; the ambiguous window it replaced was
    // ~8900. 2000 separates them with room for ordinary edits, and fails loudly
    // if the anchor ever goes ambiguous again.
    expect(fn.length, "window is not the no-MX block — re-anchor").toBeLessThan(2000);
    expect(fn).toMatch(/enrichmentData: enrichment/);
    expect(fn).toMatch(/update\.phone = phone/);
  });

  it("reports zero credits on the skip, in both callers", () => {
    // A skip that reported spend would corrupt the sweep's credit accounting
    // and the owner notification built on it.
    for (const anchor of ["reason: `no_mx (${mx.reason})`", "enrichment.skipReason = `no_mx (${mx.reason})`"]) {
      const at = src.indexOf(anchor);
      expect(at, `skip path not found — re-anchor: ${anchor}`).toBeGreaterThan(-1);
      // Wide enough to clear lookupContactInfo's persist block, which sits
      // between the skipReason and the return. A window that stopped short
      // would fail for the wrong reason and read as a missing assertion.
      const block = src.slice(at, at + 1500);
      expect(block, `window does not reach the return: ${anchor}`).toMatch(/return \{/);
      expect(block).toMatch(/creditsQuick: 0|reoonCreditsQuick: 0/);
      expect(block).toMatch(/creditsPower: 0|reoonCreditsPower: 0/);
    }
  });
});

describe("it is a DNS check and nothing more", () => {
  const raw = read("server/services/scraper/mxCheck.ts");
  /**
   * Comments stripped, because the file's own header EXPLAINS that it opens no
   * SMTP connection and names RCPT to do so — the first version of this scan
   * failed on the prose promising the very thing it was checking for. A guard a
   * comment can trip is not a guard (`8ec606b`, `fcaa531`).
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the comment strip actually ran", () => {
    // Floor: if this stopped stripping, the scan below would go back to
    // reading prose and could fail — or pass — for reasons unrelated to code.
    expect(raw).toMatch(/RCPT/);
    expect(src).not.toMatch(/RCPT/);
    expect(src.length).toBeGreaterThan(600);
  });

  it("opens no SMTP connection", () => {
    // Railway blocks port 25, the big providers accept at RCPT and reject
    // later, and probing from our own address space damages the sending
    // reputation the product depends on. Reoon does that part.
    for (const token of ["net.connect", "createConnection", "RCPT", "smtp", "Socket", "node:net"]) {
      expect(src.includes(token), `mxCheck reaches for ${token}`).toBe(false);
    }
  });

  it("adds no dependency beyond stdlib DNS", () => {
    const imports = [...src.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:dns/promises"]);
  });

  it("treats only ENOTFOUND and ENODATA as definitive", () => {
    // Widening this set is how a timeout would start permanently skipping
    // prospects, so the set itself is pinned.
    const at = src.indexOf("const DEFINITIVE_DNS_ERRORS");
    expect(at).toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf(";", at));
    expect(decl).toMatch(/"ENOTFOUND"/);
    expect(decl).toMatch(/"ENODATA"/);
    expect(decl).not.toMatch(/ETIMEOUT|ESERVFAIL|EREFUSED/);
  });
});
