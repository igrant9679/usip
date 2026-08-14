/**
 * Mailbox provider branding (owner asks 2026-08-14: real logos for Google,
 * Outlook and SendGrid, shown beside an imported inbox instead of the bare
 * "S"; plus "why does the Type tooltip say Amazon SES?").
 *
 * Both symptoms had ONE cause: `sendgrid` was missing from PROVIDER_META, so a
 * SendGrid mailbox fell through to the generic_smtp tile (letter "S"), and the
 * Type column's hand-written chain ended in a hardcoded "Amazon SES" that
 * caught every provider it did not name.
 *
 * The lesson worth pinning is not the logo — it is that a provider vocabulary
 * with a silent catch-all mislabels the next provider anyone adds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const wizard = readFileSync("client/src/components/usip/settings/GuidedMailboxSetup.tsx", "utf8");
const section = readFileSync("client/src/components/usip/settings/MailboxesSection.tsx", "utf8");
const logo = readFileSync("client/src/components/usip/settings/ProviderLogo.tsx", "utf8");
const accountsRouter = readFileSync("server/routers/sendingAccounts.ts", "utf8");

/** The providers the backend actually accepts — the source of truth. */
function acceptedProviders(): string[] {
  const m = /provider: z\.enum\(\[([^\]]+)\]\)/.exec(accountsRouter);
  expect(m, "AccountCreateInput.provider enum not found").toBeTruthy();
  return Array.from(m![1].matchAll(/"([a-z_]+)"/g)).map((x) => x[1]);
}

describe("every provider the backend accepts has branding", () => {
  it("PROVIDER_META covers the whole enum — no silent fallthrough", () => {
    const meta = wizard.slice(wizard.indexOf("export const PROVIDER_META"));
    const block = meta.slice(0, meta.indexOf("};"));
    for (const p of acceptedProviders()) {
      expect(block, `PROVIDER_META is missing "${p}" — it will render as another provider`).toContain(`${p}:`);
    }
  });

  it("the Type tooltip reads the vocabulary instead of guessing", () => {
    // The old chain ended `: "Amazon SES"`, which is how four SendGrid
    // mailboxes came to describe themselves as Amazon SES.
    expect(section).toContain("PROVIDER_META[a.provider]?.label");
    expect(section).not.toMatch(/:\s*"Amazon SES"\s*}/);
  });
});

describe("logos come from Brandfetch, with a fallback", () => {
  it("maps each brand provider to the domain its logo lives at", () => {
    for (const [provider, domain] of [
      ["google_oauth", "google.com"],
      ["outlook_oauth", "outlook.com"],
      ["sendgrid", "sendgrid.com"],
    ] as const) {
      const entry = new RegExp(`${provider}:\\s*\\{\\s*domain:\\s*"${domain.replace(".", "\\.")}"`);
      expect(logo).toMatch(entry);
    }
  });

  it("hotlinks the CDN rather than storing anything (Brandfetch's terms)", () => {
    expect(logo).toContain("brandfetchLogoUrl(");
    expect(logo).not.toContain("fetch(");
  });

  it("renders the fallback itself when there is no logo to show", () => {
    // Returning null and asking callers to detect emptiness does not work — a
    // JSX element is always truthy, so the caller's fallback never fires.
    expect(logo).toContain("if (!src || failed) return <>{fallback}</>;");
  });

  it("the mailbox row and the provider cards both go through it", () => {
    const tile = wizard.slice(wizard.indexOf("export function ProviderTile"));
    expect(tile.slice(0, 400)).toContain("<ProviderLogo");
    expect(tile.slice(0, 400)).toContain("fallback={<ProviderGlyph");
    expect(section).toContain("<ProviderTile provider={a.provider}");
    for (const p of ["google_oauth", "outlook_oauth", "sendgrid"]) {
      expect(wizard).toContain(`<ProviderLogo provider="${p}"`);
    }
  });
});
