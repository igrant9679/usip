import { describe, it, expect } from "vitest";
import { findSecretWarnings } from "./secretHealth";

/**
 * The value of this check is entirely in its false-positive rate. A warning
 * that fires on a correctly configured deployment is noise, and noise at boot
 * is how a real warning gets scrolled past.
 *
 * SCHEDULED_TASK_SECRET joined the list when the /api/scheduled cron endpoints
 * were gated: that gate FAILS OPEN when the variable is unset, so "unset" is a
 * live exposure rather than a preference. Every case below now names it
 * explicitly instead of leaving it implied — an assertion that says "these two"
 * about a three-element list is the kind that quietly stops covering things.
 */
describe("findSecretWarnings", () => {
  const ALL_SET = { JWT_SECRET: "x", ENCRYPTION_KEY: "y", SCHEDULED_TASK_SECRET: "z" };

  it("stays silent when everything is set", () => {
    expect(findSecretWarnings(ALL_SET as never)).toEqual([]);
  });

  /** ENCRYPTION_KEY legitimately falls back to JWT_SECRET — not a problem. */
  it("does not complain about ENCRYPTION_KEY when JWT_SECRET covers it", () => {
    const w = findSecretWarnings({ JWT_SECRET: "x", SCHEDULED_TASK_SECRET: "z" } as never);
    expect(w.map((x) => x.env)).toEqual([]);
  });

  it("flags JWT_SECRET, which three files silently replace with a literal", () => {
    const w = findSecretWarnings({ ENCRYPTION_KEY: "y", SCHEDULED_TASK_SECRET: "z" } as never);
    expect(w.map((x) => x.env)).toEqual(["JWT_SECRET"]);
    expect(w[0].protects.join(" ")).toMatch(/IMAP|SMTP|unsubscribe/);
  });

  it("flags an unset SCHEDULED_TASK_SECRET on its own", () => {
    const w = findSecretWarnings({ JWT_SECRET: "x", ENCRYPTION_KEY: "y" } as never);
    expect(w.map((x) => x.env)).toEqual(["SCHEDULED_TASK_SECRET"]);
    // It must say what stays open, not just that something is missing.
    expect(w[0].protects.join(" ")).toMatch(/scheduled/i);
  });

  it("flags all three when nothing is configured", () => {
    expect(findSecretWarnings({} as never).map((x) => x.env)).toEqual([
      "JWT_SECRET",
      "ENCRYPTION_KEY",
      "SCHEDULED_TASK_SECRET",
    ]);
  });
});
