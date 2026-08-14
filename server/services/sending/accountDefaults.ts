/**
 * Inbox-level defaults applied to every outreach email sent through a mailbox
 * (owner ask 2026-08-14: signature, sending limits and the opt-out link should
 * be true global defaults for that specific inbox — Sequences, ARE campaigns,
 * automated sends, everything).
 *
 * These columns have existed since the guided setup wizard shipped
 * (`sending_accounts.signature`, `.optOutEnabled`, `.optOutMessage`) and the
 * wizard has been faithfully writing them. NOTHING read them. The only opt-out
 * any send path applied came from workspace_settings, so a signature typed
 * into a mailbox's own setup never appeared on a single email. This is the
 * read side that was missing — see the inert-settings bug class.
 *
 * Two rules the owner set, and they are what the tests pin:
 *
 *  1. A configured value applies to EVERYTHING sent through that inbox.
 *  2. A blank or disabled value forces NOTHING — the sending feature keeps
 *     whatever local behaviour it already had. So every decision here is
 *     "append when present", never "replace with a default".
 *
 * Idempotence matters as much as either rule: several callers already append
 * their own signature or opt-out (the sequence blast in smtpConfig.ts injects
 * a workspace opt-out with a real tracking link). Appending a second copy
 * would be worse than doing nothing, so anything already present wins.
 */
import { htmlBodyToText, isHtmlBody, plainTextToHtml } from "@shared/emailBody";
import { renderSequenceOptOut } from "../../mergeVars";

export interface AccountSendDefaults {
  signature?: string | null;
  optOutEnabled?: boolean | null;
  optOutMessage?: string | null;
  fromEmail?: string | null;
}

export interface DecorableBody {
  bodyHtml: string;
  bodyText?: string;
}

/** Marker left on bodies we decorate, so a second pass is a no-op. */
const SIGNATURE_MARKER = "data-velocity-signature";
const OPTOUT_MARKER = "data-velocity-optout";

/** Does this body already carry an unsubscribe/opt-out of any origin? */
export function hasOptOut(html: string, text: string): boolean {
  if (html.includes(OPTOUT_MARKER)) return true;
  const probe = `${html}\n${text}`.toLowerCase();
  return probe.includes("/api/track/unsubscribe/")
    || probe.includes("unsubscribe")
    || probe.includes("opt out")
    || probe.includes("opt-out");
}

/** Does this body already end with this signature? */
export function hasSignature(html: string, text: string, signature: string): boolean {
  if (html.includes(SIGNATURE_MARKER)) return true;
  const needle = htmlBodyToText(isHtmlBody(signature) ? signature : plainTextToHtml(signature))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!needle) return true; // nothing to add
  const hay = `${htmlBodyToText(html)}\n${text}`.replace(/\s+/g, " ").toLowerCase();
  return hay.includes(needle);
}

function appendHtml(html: string, fragment: string): string {
  return html.includes("</body>") ? html.replace("</body>", `${fragment}</body>`) : html + fragment;
}

/**
 * Apply the inbox's configured signature and opt-out to one outbound body.
 * Pure: takes the account's settings and the body, returns the new body.
 */
export function applyAccountSendDefaults<T extends DecorableBody>(
  account: AccountSendDefaults,
  input: T,
): T {
  let bodyHtml = input.bodyHtml ?? "";
  let bodyText = input.bodyText ?? (isHtmlBody(bodyHtml) ? htmlBodyToText(bodyHtml) : bodyHtml);

  // ── signature ──
  const signature = (account.signature ?? "").trim();
  if (signature && !hasSignature(bodyHtml, bodyText, signature)) {
    const sigHtml = isHtmlBody(signature) ? signature : plainTextToHtml(signature);
    const sigText = isHtmlBody(signature) ? htmlBodyToText(signature) : signature;
    bodyHtml = appendHtml(bodyHtml, `<div ${SIGNATURE_MARKER}="1" style="margin-top:16px">${sigHtml}</div>`);
    bodyText = `${bodyText}\n\n${sigText}`;
  }

  // ── opt-out ──
  // No tracking token exists this deep in the send, so the link is a mailto to
  // the sending inbox — a real, working unsubscribe route. A caller that
  // already injected a tokenised one (the sequence path does) is left alone by
  // the hasOptOut check above, so the better link always wins.
  const optOutEnabled = account.optOutEnabled === true;
  const optOutMessage = (account.optOutMessage ?? "").trim();
  if (optOutEnabled && optOutMessage && !hasOptOut(bodyHtml, bodyText)) {
    const rendered = renderSequenceOptOut(optOutMessage, {
      senderEmail: account.fromEmail ?? undefined,
    });
    if (rendered) {
      bodyHtml = appendHtml(bodyHtml, `<div ${OPTOUT_MARKER}="1">${rendered.html}</div>`);
      bodyText = `${bodyText}\n\n${rendered.text}`;
    }
  }

  if (bodyHtml === (input.bodyHtml ?? "") && bodyText === (input.bodyText ?? bodyText)) return input;
  return { ...input, bodyHtml, bodyText };
}
