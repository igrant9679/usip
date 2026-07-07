/**
 * Lead → account/prospect bridge.
 *
 * Web-form submissions create bare `leads` rows (a company STRING, no
 * account/prospect linkage), while enrichment (LinkedIn, scoring, data-health)
 * is prospect/account-keyed. This bridge closes that gap:
 *
 *   1. find-or-create an `accounts` row for the lead's company — matched by
 *      corporate email domain first (strongest key), then case-insensitive
 *      company name; created from the lead when neither matches.
 *   2. find-or-create a `prospects` row for the person — matched by email,
 *      then name+company; linked back via prospects.linkedLeadId so the
 *      People surface, LinkedIn enrichment, and scoring all pick it up.
 *
 * Idempotent (safe to call repeatedly for the same lead) and best-effort:
 * failures log and return nulls without breaking the form submission.
 */
import { and, eq, like, sql } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, leads, prospects } from "../../drizzle/schema";

/** Free-mailbox domains that must never become an account's domain. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "proton.me",
  "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

export function corporateDomainOf(email?: string | null): string | null {
  const m = (email ?? "").toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  const domain = m[1];
  return FREE_MAIL.has(domain) ? null : domain;
}

export interface BridgeResult {
  accountId: number | null;
  prospectId: number | null;
  createdAccount: boolean;
  createdProspect: boolean;
}

export async function bridgeLeadToRecords(workspaceId: number, leadId: number): Promise<BridgeResult> {
  const out: BridgeResult = { accountId: null, prospectId: null, createdAccount: false, createdProspect: false };
  const db = await getDb();
  if (!db) return out;

  const [lead] = await db.select().from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)));
  if (!lead) return out;

  const domain = corporateDomainOf(lead.email);
  const company = (lead.company ?? "").trim();

  // ── 1. account find-or-create ──────────────────────────────────────────
  try {
    let account: { id: number } | undefined;
    if (domain) {
      [account] = await db.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.domain, domain)));
    }
    if (!account && company) {
      // exact case-insensitive name match (MySQL _ci collation makes eq case-insensitive)
      [account] = await db.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, company)));
    }
    if (!account && (company || domain)) {
      const r = await db.insert(accounts).values({
        workspaceId,
        name: company || domain!,
        domain,
        ownerUserId: lead.ownerUserId ?? null,
        notes: "Created automatically from a web-form lead (form-enrichment bridge).",
      } as never);
      const id = Number((r as { insertId?: number }[])[0]?.insertId ?? 0);
      if (id) { account = { id }; out.createdAccount = true; }
    }
    out.accountId = account?.id ?? null;
  } catch (e) {
    console.error("[leadBridge] account step failed:", (e as Error).message);
  }

  // ── 2. prospect find-or-create (linked back to the lead) ───────────────
  try {
    let prospect: { id: number; linkedLeadId: number | null } | undefined;
    if (lead.email) {
      [prospect] = await db.select({ id: prospects.id, linkedLeadId: prospects.linkedLeadId }).from(prospects)
        .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.email, lead.email)));
    }
    if (!prospect && lead.firstName && lead.lastName && company) {
      [prospect] = await db.select({ id: prospects.id, linkedLeadId: prospects.linkedLeadId }).from(prospects)
        .where(and(
          eq(prospects.workspaceId, workspaceId),
          eq(prospects.firstName, lead.firstName),
          eq(prospects.lastName, lead.lastName),
          eq(prospects.company, company),
        ));
    }
    if (prospect) {
      out.prospectId = prospect.id;
      if (!prospect.linkedLeadId) {
        await db.update(prospects).set({ linkedLeadId: leadId })
          .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, prospect.id)));
      }
    } else if (lead.email || (lead.firstName && lead.lastName)) {
      const r = await db.insert(prospects).values({
        workspaceId,
        firstName: lead.firstName || "Unknown",
        lastName: lead.lastName || "Lead",
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        title: lead.title ?? null,
        company: company || null,
        companyDomain: domain,
        linkedLeadId: leadId,
        enrichmentData: { source: "webform_bridge", formLeadId: leadId },
      } as never);
      const id = Number((r as { insertId?: number }[])[0]?.insertId ?? 0);
      if (id) { out.prospectId = id; out.createdProspect = true; }
    }
  } catch (e) {
    console.error("[leadBridge] prospect step failed:", (e as Error).message);
  }

  return out;
}

/**
 * Recent webform leads with their bridge state — backs the Data-enrichment
 * "Form enrichment" tab. A lead is "bridged" when a prospect links back to it.
 */
export async function webformBridgeStatus(workspaceId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      leadId: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      email: leads.email,
      company: leads.company,
      createdAt: leads.createdAt,
      prospectId: prospects.id,
    })
    .from(leads)
    .leftJoin(prospects, and(
      eq(prospects.linkedLeadId, leads.id),
      eq(prospects.workspaceId, workspaceId),
    ))
    .where(and(eq(leads.workspaceId, workspaceId), like(leads.source, "webform%")))
    .orderBy(sql`${leads.id} DESC`)
    .limit(limit);
  return rows.map((r) => ({
    leadId: r.leadId,
    name: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email,
    company: r.company,
    createdAt: r.createdAt,
    prospectId: r.prospectId ?? null,
    bridged: r.prospectId != null,
  }));
}
