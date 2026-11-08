/**
 * What the public proposal portal (/p/:token) may see and write (audit
 * 2026-10-20, G18, G40, R67, R92). The share token is the only credential a
 * client has, and anyone holding the link holds it, so the portal gets the
 * fields it shows and nothing else.
 *
 * Kept out of routers/proposals.ts so the portal's rules sit in one place the
 * procedures that serve it all read.
 */
import { escapeHtml } from "@shared/escapeHtml";
import { appUrl } from "../appUrl";
import type { Proposal, ProposalSection } from "../../drizzle/schema";

/** One answer for an unknown link and an unsent draft, so neither is told apart. */
export const PORTAL_UNAVAILABLE = "This proposal link is not available. Ask the sender for a new one.";

/**
 * A draft is the team's work in progress (G40): a share link minted before the
 * proposal was sent must not show it. Every other status is something the
 * client has been sent, accepted, or declined.
 */
export function servedOnPortal(status: string | null | undefined): boolean {
  return !!status && status !== "draft";
}

/**
 * The proposal as the portal renders it (R67). The row itself carries the
 * owner, the linked CRM ids, the client's email, engagement timestamps, the
 * share token and the internal requirements list; none of that is the
 * client's to read. `budget` is shown on the page as the price.
 */
export function portalView(p: Proposal) {
  return {
    title: p.title,
    status: p.status,
    clientName: p.clientName,
    orgAbbr: p.orgAbbr,
    projectType: p.projectType,
    budget: p.budget,
    rfpDeadline: p.rfpDeadline,
    description: p.description,
    expiresAt: p.expiresAt,
    acceptedAt: p.acceptedAt,
  };
}

/**
 * The pricing table the portal shows (audit 2026-10-20, F34): the proposal's
 * current quote version, as its PDF prints it — lines, totals, notes and
 * terms. Not the AI pricing advice, the deal, the author or the version
 * history: those are the team's.
 */
export function portalPricing(q: {
  version: number; subtotal: unknown; discountTotal: unknown; taxTotal: unknown; total: unknown; notes: string | null; terms: string | null;
  lineItems: Array<{ name: string; description: string | null; quantity: number; unitPrice: unknown; discountPct: unknown; lineTotal: unknown }>;
} | null) {
  if (!q) return null;
  return {
    version: q.version,
    lineItems: q.lineItems.map((l) => ({ name: l.name, description: l.description, quantity: l.quantity, unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), lineTotal: String(l.lineTotal) })),
    subtotal: String(q.subtotal), discountTotal: String(q.discountTotal), taxTotal: String(q.taxTotal), total: String(q.total),
    notes: q.notes, terms: q.terms,
  };
}

export function portalSection(s: Pick<ProposalSection, "sectionKey" | "content">) {
  return { sectionKey: s.sectionKey, content: s.content };
}

export function portalMilestone(m: { id: number; name: string; milestoneDate: Date | null; description: string | null }) {
  return { id: m.id, name: m.name, milestoneDate: m.milestoneDate, description: m.description };
}

/**
 * The acceptance record (G18): who typed their name to accept, from where, in
 * which time zone, and when by the server's clock. Written to the proposal's
 * timeline, so it sits beside the rest of the proposal's history.
 */
export function acceptanceRecord(r: {
  signerName: string | null;
  signerEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  timeZone: string | null;
  at: Date;
}): string {
  return [
    `Accepted on the client portal by ${r.signerName?.trim() || "(no name given)"}${r.signerEmail ? ` <${r.signerEmail}>` : ""}.`,
    `Time: ${r.at.toISOString()} (UTC)${r.timeZone ? `, their time zone ${r.timeZone}` : ""}.`,
    `From address ${r.ip || "unknown"}${r.userAgent ? `, browser: ${r.userAgent.slice(0, 300)}` : ""}.`,
  ].join("\n");
}

/**
 * The "View proposal" email (R92). Every link is built from appUrl(), never
 * from an origin the browser sent; every value is escaped, the rep's personal
 * note included, since the client's mail program renders this as HTML.
 */
export function proposalShareEmailHtml(o: {
  token: string;
  workspaceName: string;
  senderName: string;
  clientName: string;
  orgAbbr: string | null;
  title: string;
  message?: string | null;
}): { html: string; shareUrl: string } {
  const t = encodeURIComponent(o.token);
  const shareUrl = appUrl(`/p/${t}`);
  const clickUrl = appUrl(`/api/track/proposal-click/${t}`);
  const pixelUrl = appUrl(`/api/track/proposal-open/${t}`);
  const ws = escapeHtml(o.workspaceName);
  const sender = escapeHtml(o.senderName);
  const who = `${escapeHtml(o.clientName)}${o.orgAbbr ? ` (${escapeHtml(o.orgAbbr)})` : ""}`;
  const note = o.message
    ? `<p style="margin:16px 0;padding:12px 16px;background:#f9fafb;border-left:3px solid #14b8a6;border-radius:4px;font-style:italic;color:#374151">${escapeHtml(o.message).replace(/\n/g, "<br>")}</p>`
    : "";
  const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
  <div style="margin-bottom:24px">
    <span style="font-size:13px;font-weight:600;letter-spacing:0.05em;color:#14b8a6;text-transform:uppercase">${ws}</span>
  </div>
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:700">You have a new proposal to review</h2>
  <p style="margin:0 0 16px;color:#6b7280">Hi ${who},</p>
  <p style="margin:0 0 16px;color:#374151">
    <strong>${sender}</strong> from <strong>${ws}</strong> has shared a proposal with you:
    <strong>${escapeHtml(o.title)}</strong>.
  </p>
  ${note}
  <p style="margin:24px 0">
    <a href="${clickUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
      View Proposal →
    </a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link into your browser:</p>
  <p style="color:#14b8a6;font-size:12px;word-break:break-all"><a href="${shareUrl}" style="color:#14b8a6">${shareUrl}</a></p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="color:#9ca3af;font-size:12px">
    You can view the proposal and leave feedback without creating an account.
    If you did not expect this email, you can safely ignore it.
  </p>
  <!-- Tracking pixel: 1x1 transparent GIF, logs open event server-side -->
  <img src="${pixelUrl}" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0" alt="" />
</div>`;
  return { html, shareUrl };
}
