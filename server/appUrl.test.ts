import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appBaseUrl, appUrl } from "./appUrl";

const VARS = ["PUBLIC_APP_URL", "MANUS_APP_URL", "RAILWAY_PUBLIC_DOMAIN", "VITE_OAUTH_PORTAL_URL", "NODE_ENV"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("appBaseUrl", () => {
  it("prefers PUBLIC_APP_URL", () => {
    process.env.PUBLIC_APP_URL = "https://custom.example.com";
    process.env.MANUS_APP_URL = "https://ignored.example.com";
    expect(appBaseUrl()).toBe("https://custom.example.com");
  });

  it("falls back to MANUS_APP_URL, then Railway's domain", () => {
    process.env.MANUS_APP_URL = "https://manus-set.example.com";
    expect(appBaseUrl()).toBe("https://manus-set.example.com");
    delete process.env.MANUS_APP_URL;
    process.env.RAILWAY_PUBLIC_DOMAIN = "my-service.up.railway.app";
    expect(appBaseUrl()).toBe("https://my-service.up.railway.app");
  });

  /**
   * The actual bug. VITE_OAUTH_PORTAL_URL is the identity provider, and in
   * production it is a manus.im address — every booking link, tracking pixel
   * and unsubscribe URL built from it returned 404 to the recipient.
   */
  it("NEVER derives the origin from VITE_OAUTH_PORTAL_URL", () => {
    process.env.VITE_OAUTH_PORTAL_URL = "https://manus.im/oauth/authorize";
    expect(appBaseUrl()).not.toContain("manus.im");
    expect(appBaseUrl()).toBe("https://getvelocityai.app");
  });

  it("uses localhost only in development", () => {
    process.env.NODE_ENV = "development";
    expect(appBaseUrl()).toBe("http://localhost:3000");
    process.env.NODE_ENV = "production";
    expect(appBaseUrl()).toBe("https://getvelocityai.app");
  });

  it("normalises to an origin, dropping any path or trailing slash", () => {
    process.env.PUBLIC_APP_URL = "https://app.example.com/some/path/";
    expect(appBaseUrl()).toBe("https://app.example.com");
  });

  it("ignores an unparseable value rather than emitting a broken link", () => {
    process.env.PUBLIC_APP_URL = "not a url";
    process.env.MANUS_APP_URL = "https://good.example.com";
    expect(appBaseUrl()).toBe("https://good.example.com");
  });

  it("joins paths without doubling or dropping the slash", () => {
    process.env.PUBLIC_APP_URL = "https://app.example.com";
    expect(appUrl("/b/rep-1")).toBe("https://app.example.com/b/rep-1");
    expect(appUrl("b/rep-1")).toBe("https://app.example.com/b/rep-1");
  });
});

/**
 * Source-level guard against the manus.im bug returning a THIRD time.
 *
 * History: half the codebase built public URLs from a raw `MANUS_APP_URL` read.
 * The consolidation onto appUrl() fixed the sequence, tracking, unsubscribe and
 * invite paths — and missed the two proposal share links, which sat in email
 * bodies sent to customers. With the env var unset those rendered
 * `href="/p/<token>"`: a relative URL inside an email, unresolvable by any mail
 * client. Nothing failed loudly; the links simply went nowhere.
 *
 * Unit-testing appBaseUrl() could never have caught that, because the broken
 * code never called it. So this asserts over the SOURCE instead: no file may
 * interpolate a bare app-URL env var straight into a string. Webhook callback
 * URLs handed to vendors are exempt — they are machine-to-machine and carry
 * their own fallback chain.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function serverFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...serverFiles(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("no public URL is built outside appUrl()", () => {
  /** Vendor webhook targets, not links a human ever clicks. */
  const EXEMPT = ["unipile.ts", "voiceWebhook.ts", "appUrl.ts"];

  it("never interpolates a bare app-URL env var into a string", () => {
    const offenders: string[] = [];
    for (const file of serverFiles("server")) {
      if (EXEMPT.some((e) => file.endsWith(e))) continue;
      const src = readFileSync(file, "utf8");
      // `${process.env.MANUS_APP_URL ...}` inside a template literal is the
      // exact shape that shipped broken links twice.
      const re = /\$\{\s*process\.env\.(MANUS_APP_URL|PUBLIC_APP_URL|VITE_OAUTH_PORTAL_URL)/g;
      for (const m of src.matchAll(re)) offenders.push(`${file}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never hardcodes the production domain in server source", () => {
    const offenders: string[] = [];
    for (const file of serverFiles("server")) {
      if (file.endsWith("appUrl.ts")) continue; // the one legitimate home
      const src = readFileSync(file, "utf8");
      if (src.includes("https://getvelocityai.app")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
