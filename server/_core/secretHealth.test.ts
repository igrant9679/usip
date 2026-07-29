import { describe, it, expect } from "vitest";
import { findSecretWarnings } from "./secretHealth";

/**
 * The value of this check is entirely in its false-positive rate. A warning
 * that fires on a correctly configured deployment is noise, and noise at boot
 * is how a real warning gets scrolled past.
 */
describe("findSecretWarnings", () => {
  it("stays silent when both secrets are set", () => {
    expect(findSecretWarnings({ JWT_SECRET: "x", ENCRYPTION_KEY: "y" } as never)).toEqual([]);
  });

  /** ENCRYPTION_KEY legitimately falls back to JWT_SECRET — not a problem. */
  it("does not complain about ENCRYPTION_KEY when JWT_SECRET covers it", () => {
    const w = findSecretWarnings({ JWT_SECRET: "x" } as never);
    expect(w.map((x) => x.env)).toEqual([]);
  });

  it("flags JWT_SECRET, which three files silently replace with a literal", () => {
    const w = findSecretWarnings({ ENCRYPTION_KEY: "y" } as never);
    expect(w.map((x) => x.env)).toEqual(["JWT_SECRET"]);
    expect(w[0].protects.join(" ")).toMatch(/IMAP|SMTP|unsubscribe/);
  });

  it("flags both when nothing is configured", () => {
    expect(findSecretWarnings({} as never).map((x) => x.env)).toEqual([
      "JWT_SECRET",
      "ENCRYPTION_KEY",
    ]);
  });
});
