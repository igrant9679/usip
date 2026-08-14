/**
 * Inbox-level settings as true global defaults (owner ask 2026-08-14).
 *
 * `sending_accounts.signature`, `.optOutEnabled`, `.optOutMessage` and
 * `.hourlySendLimit` have been written by the setup wizard since it shipped
 * and read by NOTHING — a signature typed into a mailbox's own setup never
 * reached a single email. These tests pin the read side, and the two rules
 * that keep it safe: configured values apply everywhere, blank ones force
 * nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { applyAccountSendDefaults, hasOptOut, hasSignature } from "./services/sending/accountDefaults";

const body = (html: string, text?: string) => ({ to: "a@b.com", subject: "Hi", bodyHtml: html, bodyText: text });

describe("a configured signature reaches the email", () => {
  it("appends to both the HTML and the text part", () => {
    const out = applyAccountSendDefaults({ signature: "— Dana\nVP Revenue" }, body("<p>Hello</p>", "Hello"));
    expect(out.bodyHtml).toContain("Dana");
    expect(out.bodyText).toContain("VP Revenue");
  });

  it("goes inside <body> when the body is a full document", () => {
    const out = applyAccountSendDefaults({ signature: "— Dana" }, body("<html><body><p>Hi</p></body></html>", "Hi"));
    // Placement, not markup: it must land before </body>, never after it.
    expect(out.bodyHtml.indexOf("Dana")).toBeLessThan(out.bodyHtml.indexOf("</body>"));
    expect(out.bodyHtml.endsWith("</body></html>")).toBe(true);
  });

  it("does not append twice when the body already ends with it", () => {
    const once = applyAccountSendDefaults({ signature: "— Dana" }, body("<p>Hi</p>", "Hi"));
    const twice = applyAccountSendDefaults({ signature: "— Dana" }, once);
    expect(twice.bodyHtml).toBe(once.bodyHtml);
    expect(twice.bodyText).toBe(once.bodyText);
  });

  it("respects a signature the caller already wrote in", () => {
    const out = applyAccountSendDefaults({ signature: "Best, Dana" }, body("<p>Hi</p><p>Best, Dana</p>", "Hi\n\nBest, Dana"));
    expect(out.bodyHtml).toBe("<p>Hi</p><p>Best, Dana</p>");
  });
});

describe("a blank or disabled setting forces nothing", () => {
  it("no signature → body untouched, same object", () => {
    const input = body("<p>Hi</p>", "Hi");
    expect(applyAccountSendDefaults({ signature: null }, input)).toBe(input);
    expect(applyAccountSendDefaults({ signature: "   " }, input)).toBe(input);
  });

  it("opt-out message set but toggle OFF → nothing appended", () => {
    const input = body("<p>Hi</p>", "Hi");
    expect(applyAccountSendDefaults({ optOutEnabled: false, optOutMessage: "Unsub <% here %>" }, input)).toBe(input);
  });

  it("toggle ON but message blank → nothing appended", () => {
    const input = body("<p>Hi</p>", "Hi");
    expect(applyAccountSendDefaults({ optOutEnabled: true, optOutMessage: "" }, input)).toBe(input);
  });
});

describe("the opt-out link", () => {
  it("appends with a working mailto to the sending inbox", () => {
    const out = applyAccountSendDefaults(
      { optOutEnabled: true, optOutMessage: "No more emails? <% Unsubscribe %>", fromEmail: "dana@acme.com" },
      body("<p>Hi</p>", "Hi"),
    );
    expect(out.bodyHtml).toContain("mailto:dana@acme.com");
    expect(out.bodyText).toContain("No more emails?");
  });

  it("never double-appends over a caller's tokenised unsubscribe", () => {
    // The sequence path injects a real /api/track/unsubscribe/<token> link.
    // A second, weaker mailto footer underneath it would be worse than none.
    const withToken = body(
      '<p>Hi</p><a href="https://x/api/track/unsubscribe/abc">Unsubscribe</a>',
      "Hi\n\nUnsubscribe ( https://x/api/track/unsubscribe/abc )",
    );
    const out = applyAccountSendDefaults(
      { optOutEnabled: true, optOutMessage: "Opt out <% here %>", fromEmail: "dana@acme.com" },
      withToken,
    );
    expect(out).toBe(withToken);
  });

  it("hasOptOut / hasSignature recognise what is already there", () => {
    expect(hasOptOut("<a href='/api/track/unsubscribe/x'>u</a>", "")).toBe(true);
    expect(hasOptOut("<p>Hello</p>", "Hello")).toBe(false);
    expect(hasSignature("<p>Hi</p><p>— Dana</p>", "Hi\n— Dana", "— Dana")).toBe(true);
    expect(hasSignature("<p>Hi</p>", "Hi", "— Dana")).toBe(false);
  });
});

describe("the defaults are applied where every account send passes", () => {
  const adapter = readFileSync("server/emailAdapter.ts", "utf8");

  it("createEmailAdapter decorates before handing off to the provider", () => {
    const fn = adapter.slice(adapter.indexOf("export function createEmailAdapter"));
    expect(fn).toContain("applyAccountSendDefaults(");
    // Decorate first, THEN send — the other order sends the undecorated body.
    expect(fn.indexOf("applyAccountSendDefaults(")).toBeLessThan(fn.indexOf("await send("));
    expect(fn).toContain("await send(decorated)");
  });

  it("transactional mail is deliberately NOT decorated", () => {
    // sendWorkspaceEmail / sendSystemEmail use the workspace SMTP config and
    // never construct an adapter, so invites and alerts stay clean.
    const delivery = readFileSync("server/emailDelivery.ts", "utf8");
    const transactional = delivery.slice(
      delivery.indexOf("export async function sendWorkspaceEmail"),
      delivery.indexOf("export async function sendSystemEmail"),
    );
    // The CALL form — the prose there mentions the factory to explain that it
    // deliberately does not use it, and a bare name match reads that as usage.
    expect(transactional).not.toContain("createEmailAdapter(");
  });
});

describe("the older sequence-blast path honours the inbox too", () => {
  // It predates the adapter and sends through the workspace SMTP transporter,
  // so createEmailAdapter's wrapper never sees it. The drafts still carry the
  // mailbox that owns them, which is enough.
  const blast = readFileSync("server/routers/smtpConfig.ts", "utf8");

  it("loads the sending account behind each draft", () => {
    expect(blast).toContain("draft.sendingAccountId ? acctById.get(draft.sendingAccountId)");
  });

  it("applies the inbox signature", () => {
    expect(blast).toContain("applyAccountSendDefaults(");
    expect(blast).toContain("{ signature: acct.signature }");
  });

  it("the inbox's opt-out message wins, but keeps the tokenised link", () => {
    // The setting governs the wording; the mechanism stays this path's
    // one-click /api/track/unsubscribe URL, which beats the adapter's mailto.
    expect(blast).toContain("const inboxOptOut = acct?.optOutEnabled === true");
    expect(blast).toContain("inboxOptOut || optOutEnabled");
    expect(blast).toContain("renderSequenceOptOut(effectiveOptOutMessage");
    const call = blast.slice(blast.indexOf("renderSequenceOptOut(effectiveOptOutMessage"));
    expect(call.slice(0, 220)).toContain("/api/track/unsubscribe/");
  });

  it("an inbox with nothing configured leaves the workspace behaviour alone", () => {
    // effectiveOptOutEnabled falls back to the workspace flag, not to false.
    expect(blast).toContain("const effectiveOptOutEnabled = inboxOptOut || optOutEnabled;");
    expect(blast).toContain("const effectiveOptOutMessage = inboxOptOut ? acct!.optOutMessage! : optOutMessage;");
  });
});

describe("provider logos are transparent marks", () => {
  const logo = readFileSync("client/src/components/usip/settings/ProviderLogo.tsx", "utf8");

  it("asks for the symbol before the opaque favicon square", () => {
    // Measured on the live CDN: symbol → corner alpha 0 (~45% transparent);
    // icon → corner alpha 255, 0% transparent. The white box was in the IMAGE,
    // which is why making the wrapper transparent changed nothing.
    expect(logo).toContain('const DEFAULT_TYPES: Array<"symbol" | "icon" | "logo"> = ["symbol", "icon"]');
  });

  it("falls through asset types on error rather than giving up", () => {
    expect(logo).toContain("onError={() => setTier((t) => t + 1)}");
  });

  it("Outlook skips the CDN — it has no symbol, only Microsoft's square", () => {
    expect(logo).toMatch(/outlook_oauth:\s*\{[^}]*types:\s*\[\]/);
  });

  it("the wrapper adds no background of its own", () => {
    expect(logo).toContain("bg-transparent");
    expect(logo).not.toContain("bg-background");
  });
});

describe("sending limits are enforced, not just stored", () => {
  const limits = readFileSync("server/sendLimits.ts", "utf8");

  it("the hourly cap is a ROLLING window, not a clock hour", () => {
    expect(limits).toContain("getAccountSentLastHour");
    expect(limits).toContain("Date.now() - 60 * 60 * 1000");
  });

  it("only enforced once the owner configured the step", () => {
    // The column is NOT NULL default 6; enforcing it for mailboxes whose owner
    // never opened that step would force a value nobody chose.
    const fn = limits.slice(limits.indexOf("export async function assertSendAllowed"));
    expect(fn).toContain("acct.sendingLimitsCompleted && acct.hourlySendLimit > 0");
  });

  it("the campaign pool skips an hourly-exhausted inbox instead of failing", () => {
    const delivery = readFileSync("server/emailDelivery.ts", "utf8");
    const pool = delivery.slice(delivery.indexOf("export async function sendCampaignEmailViaPool"));
    expect(pool).toContain("getAccountSentLastHour");
    expect(pool).toContain("hit its hourly limit");
  });
});

describe("the wizard persists every step", () => {
  const wizard = readFileSync("client/src/components/usip/settings/GuidedMailboxSetup.tsx", "utf8");

  /** Everything above a step component's JSX return — i.e. its save wiring.
   *  Anchored on the newline + 2-space indent, because a bare "return ("
   *  also matches the `return () => {` of the very cleanup being asserted. */
  const stepHead = (step: string) => {
    const i = step.indexOf(`${"\n"}  return (`);
    return i === -1 ? step : step.slice(0, i);
  };

  it("sending limits persist on unmount, not only via the Complete button", () => {
    // The custom event fires ONLY from Complete, so Skip, Previous, a sidebar
    // jump or closing the wizard all discarded the numbers — the reported bug.
    const step = wizard.slice(wizard.indexOf("function LimitsStep"));
    const head = stepHead(step);
    expect(head).toContain("latest.current");
    expect(head).toContain("return () => {");
  });

  it("all three steps persist without relying on a specific button", () => {
    for (const marker of ["function SignatureStep", "function LimitsStep", "function OptOutStep"]) {
      const head = stepHead(wizard.slice(wizard.indexOf(marker)));
      expect(head, `${marker} has no save path outside its Complete button`).toMatch(/save\(|commit\(/);
    }
  });

  it("the step list is clickable and every entry can jump", () => {
    expect(wizard).toContain('onClick={acct ? () => setStep("signature") : undefined}');
    expect(wizard).toContain('onClick={acct ? () => setStep("limits") : undefined}');
    expect(wizard).toContain('onClick={acct ? () => setStep("optout") : undefined}');
  });
});
