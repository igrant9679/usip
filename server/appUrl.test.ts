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
