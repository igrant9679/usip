/**
 * A partial update must never rewrite a field the caller did not send.
 *
 * Owner report 2026-08-14: "every time I configure the sending limit to 50 it
 * keeps resetting to 500." 500 is the schema default, and the cause is a Zod
 * behaviour that reads as safe and is not:
 *
 *   AccountCreateInput.partial().parse({ id: 1, name: "x" })
 *     → { id: 1, name: "x", dailySendLimit: 500 }
 *
 * `.partial()` makes the key optional but does NOT strip `.default()`, so the
 * default materialises for a key nobody sent, and the update writes it. Set
 * the limit to 50 in the wizard, then save the signature step — or toggle
 * warmup, or save anything else on that account — and the limit silently went
 * back to 500. Nothing about the write looked wrong; the value arrived already
 * populated.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { AccountCreateInput } from "./routers/sendingAccounts";

describe("the Zod trap itself", () => {
  it("demonstrates that .partial() does NOT strip a .default()", () => {
    // Kept as a live demonstration rather than a comment: if a future Zod
    // upgrade changes this, the note above stops being true and someone
    // should find out from a failing test, not from a support report.
    const withDefault = z.object({ a: z.string(), n: z.number().default(500) });
    const parsed = withDefault.partial().parse({ a: "x" }) as Record<string, unknown>;
    expect(parsed.n).toBe(500);
    expect("n" in parsed).toBe(true);
  });
});

describe("AccountCreateInput carries no defaults", () => {
  it("a partial parse yields ONLY what was sent", () => {
    const Partial = AccountCreateInput.partial().extend({ id: z.number().int() });
    const parsed = Partial.parse({ id: 7, name: "Mailbox" }) as Record<string, unknown>;
    expect(parsed).toEqual({ id: 7, name: "Mailbox" });
    expect("dailySendLimit" in parsed).toBe(false);
    expect("warmupStatus" in parsed).toBe(false);
  });

  it("an explicit limit still round-trips", () => {
    const Partial = AccountCreateInput.partial().extend({ id: z.number().int() });
    const parsed = Partial.parse({ id: 7, dailySendLimit: 50 }) as Record<string, unknown>;
    expect(parsed.dailySendLimit).toBe(50);
  });

  it("no field in the schema declares a default", () => {
    // The whole class of bug, not just the two fields that had it. Comments
    // are stripped first — the note explaining the trap necessarily says
    // ".default(", and a guard that trips over its own documentation is the
    // kind of false positive that gets tests deleted.
    const src = readFileSync("server/routers/sendingAccounts.ts", "utf8");
    const schema = src.slice(src.indexOf("export const AccountCreateInput"), src.indexOf("export const sendingAccountsRouter"));
    const body = schema
      .slice(0, schema.indexOf("});"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join(" ");
    expect(body).not.toMatch(/\.default\(/);
  });
});

describe("create still applies the defaults it always did", () => {
  const src = readFileSync("server/routers/sendingAccounts.ts", "utf8");
  const create = src.slice(src.indexOf("create: adminWsProcedure"), src.indexOf("update: adminWsProcedure"));

  it("defaults moved to the create site, unchanged in value", () => {
    expect(create).toContain("dailySendLimit: cols.dailySendLimit ?? 500");
    expect(create).toContain('warmupStatus: cols.warmupStatus ?? "not_started"');
  });
});

describe("update writes only what it was given", () => {
  const src = readFileSync("server/routers/sendingAccounts.ts", "utf8");
  const update = src.slice(src.indexOf("update: adminWsProcedure"), src.indexOf("delete: adminWsProcedure"));

  it("filters undefined out of the patch rather than spreading it", () => {
    expect(update).toContain("for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;");
    // The old `{ ...rest }` spread is what let a materialised default through.
    expect(update).not.toContain("const patch: Record<string, unknown> = { ...rest };");
  });

  it("still keeps a blank SendGrid key from wiping the stored one", () => {
    expect(update).toContain("if (sendgridApiKey?.trim()) patch.sendgridApiKeyEnc = encryptSecret(sendgridApiKey.trim());");
  });
});
