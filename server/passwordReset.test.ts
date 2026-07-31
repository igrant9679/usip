/**
 * Forgot-password: the rules that make a reset link safe to email.
 *
 * Before migration 0142 there was NO self-service reset. A user who had
 * forgotten a password could only be recovered by another admin sending a
 * password-setup email, or by profile.changeMyPassword while already signed in
 * — so a sole owner locking themselves out had no route back in.
 *
 * A reset token is a full account takeover, which makes this the most
 * dangerous thing in the auth surface. The properties asserted here are the
 * ones that keep it honest.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESET_TOKEN_TTL_MS,
  hashResetToken,
  isResetTokenLive,
  isStrongEnoughPassword,
  newResetToken,
  resetTokenExpiry,
} from "./services/passwordReset";

const ROOT = join(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("newResetToken", () => {
  it("is 32 bytes of hex", () => {
    expect(newResetToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newResetToken()));
    expect(seen.size).toBe(200);
  });
});

describe("hashResetToken", () => {
  it("is what gets stored — never the token itself", () => {
    const token = newResetToken();
    const hash = hashResetToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The point of the exercise: a database dump must not contain a usable
    // reset link.
    expect(hash).not.toBe(token);
  });

  it("is deterministic, so the lookup can find the row", () => {
    const token = newResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("separates different tokens", () => {
    expect(hashResetToken("a")).not.toBe(hashResetToken("b"));
  });

  it("does not throw on rubbish", () => {
    expect(hashResetToken("")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetToken(undefined as unknown as string)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isResetTokenLive", () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);

  it("accepts a token inside its window", () => {
    expect(isResetTokenLive(new Date(now + 60_000), now)).toBe(true);
  });

  it("rejects an expired token", () => {
    expect(isResetTokenLive(new Date(now - 1), now)).toBe(false);
  });

  it("rejects a NULL expiry rather than treating it as forever", () => {
    // An invite reads a null expiry as "never expires" on purpose. For a
    // takeover token an absent expiry means the row is malformed, and the safe
    // answer to a malformed credential is no.
    expect(isResetTokenLive(null, now)).toBe(false);
    expect(isResetTokenLive(undefined, now)).toBe(false);
  });

  it("rejects an unparseable expiry", () => {
    expect(isResetTokenLive("not-a-date", now)).toBe(false);
  });

  it("expires in an hour, not a week", () => {
    expect(RESET_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
    expect(resetTokenExpiry(now).getTime()).toBe(now + RESET_TOKEN_TTL_MS);
  });
});

describe("isStrongEnoughPassword", () => {
  it("matches the rule registration already applies", () => {
    expect(isStrongEnoughPassword("1234567")).toBe(false);
    expect(isStrongEnoughPassword("12345678")).toBe(true);
    expect(isStrongEnoughPassword(undefined)).toBe(false);
    expect(isStrongEnoughPassword(12345678)).toBe(false);
  });
});

describe("the routes keep their guarantees", () => {
  const src = strip(readFileSync(join(ROOT, "server/passwordAuth.ts"), "utf8"));

  /**
   * Each handler, bounded at the NEXT route registration.
   *
   * The first version sliced from the route path to end-of-file, which swallowed
   * password-login and register — both of which legitimately call res.cookie(),
   * so the "no session" assertion failed against the wrong handler. An unbounded
   * slice tests whatever happens to follow.
   */
  function handler(routePath: string): string {
    const start = src.indexOf(`"${routePath}"`);
    expect(start, `${routePath} not found`).toBeGreaterThan(0);
    const next = src.indexOf("app.post(", start + 1);
    return next > start ? src.slice(start, next) : src.slice(start);
  }

  const forgot = handler("/api/auth/forgot-password");
  const reset = handler("/api/auth/reset-password");

  it("isolated both handlers, and did not run past them", () => {
    expect(forgot.length).toBeGreaterThan(500);
    expect(reset.length).toBeGreaterThan(500);
    // Each slice must contain its OWN route and not the next one.
    expect(forgot).not.toContain("/api/auth/reset-password");
    expect(reset).not.toContain("/api/auth/password-login");
  });

  it("forgot-password NEVER says whether the address exists", () => {
    // Login refuses to leak this (a constant-time dummy compare guards it); a
    // reset form replying "no such account" gives the same fact away through
    // the back door. Every early return must be the generic ok().
    expect(forgot).not.toMatch(/No account|not found|NOT_FOUND|doesn't exist|no such/i);
    expect(forgot).toContain("ok()");
  });

  it("stores only the HASH of the token", () => {
    expect(forgot).toContain("hashResetToken(token)");
    // The raw token may only be used to build the emailed link.
    expect(forgot).not.toMatch(/passwordResetTokenHash:\s*token\b/);
  });

  it("sets an expiry when minting", () => {
    expect(forgot).toContain("resetTokenExpiry(");
  });

  it("reset-password checks the expiry", () => {
    expect(reset).toContain("isResetTokenLive(");
  });

  it("reset-password spends the token — single use", () => {
    expect(reset).toMatch(/passwordResetTokenHash:\s*null/);
    expect(reset).toMatch(/passwordResetExpiresAt:\s*null/);
  });

  it("reset-password does NOT hand out a session (no MFA bypass)", () => {
    // An account with an authenticator app must still pass it afterwards.
    expect(reset).not.toContain("res.cookie(");
    expect(reset).not.toContain("COOKIE_NAME");
  });

  it("both routes are rate limited — one of them sends mail", () => {
    expect(src).toContain("forgotPasswordLimiter");
    expect(forgot).toContain("forgotPasswordLimiter");
    expect(reset).toContain("forgotPasswordLimiter");
  });

  it("escapes the name it drops into the email body", () => {
    expect(forgot).toContain("escapeHtml(");
  });

  it("builds the link through appUrl, not a raw env read", () => {
    // The public-URL bug class: a relative or stale link in an email is a link
    // no mail client can follow.
    expect(forgot).toContain("appUrl(");
  });
});

/**
 * The migration bug class: schema.ts and rawMigrations.ts drifting apart, so
 * the column exists in the ORM's head and not in the database. Drizzle then
 * selects a column that isn't there and every query on the table dies.
 */
describe("migration 0142 matches the schema", () => {
  const schema = readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8");
  const migrations = readFileSync(join(ROOT, "server/_core/rawMigrations.ts"), "utf8");

  it("the migration exists", () => {
    expect(migrations).toContain("0142_password_reset_tokens.sql");
  });

  it("every column the schema declares has an ADD COLUMN in the migration", () => {
    /**
     * Assert the STATEMENT, not the column name.
     *
     * The first version checked `migrations.toContain(col)` and a mutation that
     * deleted the whole `ALTER TABLE … ADD COLUMN` passed clean — because the
     * name still appeared in the CREATE INDEX line. Same weakness as the
     * file-level toContain that let two cron endpoints sit ungated (b15490d):
     * a string being present somewhere in a file says nothing about the
     * statement that has to exist.
     */
    for (const col of ["password_reset_token_hash", "password_reset_expires_at"]) {
      expect(schema, `schema.ts is missing ${col}`).toContain(col);
      expect(
        migrations,
        `\n\nmigration has no ADD COLUMN for ${col} — schema.ts declares it, so\n` +
          `Drizzle will SELECT a column prod does not have and every query on\n` +
          `users will fail.\n`,
      ).toMatch(new RegExp(`ALTER TABLE \`+users\`+ ADD COLUMN \`+${col}\`+`));
    }
  });

  it("the token-hash lookup is indexed", () => {
    // The reset lookup is BY TOKEN HASH on a public, unauthenticated endpoint —
    // without an index that is a full scan of the users table per request.
    expect(migrations).toMatch(/CREATE INDEX .*ix_users_pw_reset.* ON .users./);
  });
});
