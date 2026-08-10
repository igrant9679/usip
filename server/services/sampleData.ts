/**
 * Sample-data removal — deletes the demo rows the two seeders created.
 *
 * The seeders (server/seed.ts CRM demo, server/seedAreDemo.ts ARE demo) wrote
 * no marker column, so removal recognizes rows by the seed's own identity:
 * SEED_FINGERPRINT for the CRM data (fictional account domains, seeded names/
 * SKUs — the seeder consumes the SAME constants, one vocabulary) and the
 * "[demo]" campaign-name prefix for ARE (the same predicate the sweeper's
 * isEnrichableCampaign uses to refuse to work demo campaigns).
 *
 * Everything cascades from those anchors by FK, workspace-scoped throughout:
 * demo accounts pull their contacts / opportunities / customers and each of
 * THOSE pulls roles, tickets, amendments, QBRs, tasks, enrollments, drafts.
 * Leads are matched by their email's domain (the seeder minted them from the
 * fictional company domains). Territories are the one shared surface — real
 * members/accounts may point at them — so references are nulled first.
 *
 * Re-seed protection lives in seed.ts (isWorkspaceSeeded consults the removal
 * audit row), NOT here: without it, deleting every demo account flips the
 * "seeded" count check back to false and the next login resurrects the data.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  accounts,
  areAbVariants,
  areCampaigns,
  areScrapeJobs,
  areSignalLog,
  campaigns,
  contacts,
  contractAmendments,
  crmTerritoryRules,
  customers,
  dashboards,
  dashboardWidgets,
  emailDrafts,
  enrollments,
  leads,
  opportunities,
  opportunityContactRoles,
  products,
  prospectIntelligence,
  prospectQueue,
  qbrs,
  sequences,
  supportTickets,
  tasks,
  territories,
  workflowRules,
  workspaceMembers,
} from "../../drizzle/schema";
import { SEED_FINGERPRINT } from "../seed";

export interface SampleDataCounts {
  accounts: number;
  contacts: number;
  leads: number;
  opportunities: number;
  customers: number;
  tasks: number;
  sequences: number;
  enrollments: number;
  emailDrafts: number;
  workflowRules: number;
  campaigns: number;
  products: number;
  territories: number;
  dashboards: number;
  areCampaigns: number;
  areQueueRows: number;
}

const affected = (r: unknown): number => Number((r as { affectedRows?: number }[])[0]?.affectedRows ?? 0);

/** Demo-account ids for a workspace — the anchor everything CRM cascades from. */
async function demoAccountIds(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, ws: number): Promise<number[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, ws), inArray(accounts.domain, SEED_FINGERPRINT.accountDomains as unknown as string[])));
  return rows.map((r) => r.id);
}

/** Seeded-lead ids: the seeder minted lead emails from the fictional domains. */
async function demoLeadIds(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, ws: number): Promise<number[]> {
  const rows = await db.select({ id: leads.id, email: leads.email }).from(leads).where(eq(leads.workspaceId, ws));
  const domains = new Set(SEED_FINGERPRINT.accountDomains.map((d) => d.toLowerCase()));
  return rows
    .filter((r) => {
      const dom = (r.email ?? "").toLowerCase().split("@")[1] ?? "";
      return domains.has(dom) || dom === "example.com";
    })
    .map((r) => r.id);
}

/** "[demo]"-prefixed ARE campaign ids (same predicate the sweeper excludes by). */
async function demoAreCampaignIds(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, ws: number): Promise<number[]> {
  const rows = await db
    .select({ id: areCampaigns.id })
    .from(areCampaigns)
    .where(and(eq(areCampaigns.workspaceId, ws), like(areCampaigns.name, "[demo]%")));
  return rows.map((r) => r.id);
}

/** Counts only — powers the Danger-zone card so the button says what it will do. */
export async function sampleDataStatus(workspaceId: number): Promise<SampleDataCounts> {
  const db = await getDb();
  const zero: SampleDataCounts = {
    accounts: 0, contacts: 0, leads: 0, opportunities: 0, customers: 0, tasks: 0,
    sequences: 0, enrollments: 0, emailDrafts: 0, workflowRules: 0, campaigns: 0,
    products: 0, territories: 0, dashboards: 0, areCampaigns: 0, areQueueRows: 0,
  };
  if (!db) return zero;
  const ws = workspaceId;
  const count = async (q: Promise<Array<{ c: number }>>) => Number((await q)[0]?.c ?? 0);
  const c = { ...zero };

  const accIds = await demoAccountIds(db, ws);
  c.accounts = accIds.length;
  if (accIds.length) {
    c.contacts = await count(db.select({ c: sql<number>`count(*)` }).from(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.accountId, accIds))));
    c.opportunities = await count(db.select({ c: sql<number>`count(*)` }).from(opportunities).where(and(eq(opportunities.workspaceId, ws), inArray(opportunities.accountId, accIds))));
    c.customers = await count(db.select({ c: sql<number>`count(*)` }).from(customers).where(and(eq(customers.workspaceId, ws), inArray(customers.accountId, accIds))));
  }
  c.leads = (await demoLeadIds(db, ws)).length;
  c.sequences = await count(db.select({ c: sql<number>`count(*)` }).from(sequences).where(and(eq(sequences.workspaceId, ws), inArray(sequences.name, SEED_FINGERPRINT.sequenceNames as unknown as string[]))));
  c.workflowRules = await count(db.select({ c: sql<number>`count(*)` }).from(workflowRules).where(and(eq(workflowRules.workspaceId, ws), inArray(workflowRules.name, SEED_FINGERPRINT.workflowNames as unknown as string[]))));
  c.campaigns = await count(db.select({ c: sql<number>`count(*)` }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.name, SEED_FINGERPRINT.campaignNames as unknown as string[]))));
  c.products = await count(db.select({ c: sql<number>`count(*)` }).from(products).where(and(eq(products.workspaceId, ws), inArray(products.sku, SEED_FINGERPRINT.productSkus as unknown as string[]))));
  c.territories = await count(db.select({ c: sql<number>`count(*)` }).from(territories).where(and(eq(territories.workspaceId, ws), inArray(territories.name, SEED_FINGERPRINT.territoryNames as unknown as string[]))));
  c.dashboards = await count(db.select({ c: sql<number>`count(*)` }).from(dashboards).where(and(eq(dashboards.workspaceId, ws), eq(dashboards.name, SEED_FINGERPRINT.dashboardName))));
  const areIds = await demoAreCampaignIds(db, ws);
  c.areCampaigns = areIds.length;
  if (areIds.length) {
    c.areQueueRows = await count(db.select({ c: sql<number>`count(*)` }).from(prospectQueue).where(and(eq(prospectQueue.workspaceId, ws), inArray(prospectQueue.campaignId, areIds))));
  }
  return c;
}

/** Delete every seeded row for the workspace. Returns per-entity counts. */
export async function removeSampleData(workspaceId: number): Promise<SampleDataCounts> {
  const db = await getDb();
  const counts: SampleDataCounts = {
    accounts: 0, contacts: 0, leads: 0, opportunities: 0, customers: 0, tasks: 0,
    sequences: 0, enrollments: 0, emailDrafts: 0, workflowRules: 0, campaigns: 0,
    products: 0, territories: 0, dashboards: 0, areCampaigns: 0, areQueueRows: 0,
  };
  if (!db) return counts;
  const ws = workspaceId;

  /* ── ARE demo campaign + its tab data ─────────────────────────────── */
  const areIds = await demoAreCampaignIds(db, ws);
  if (areIds.length) {
    await db.delete(areSignalLog).where(and(eq(areSignalLog.workspaceId, ws), inArray(areSignalLog.campaignId, areIds)));
    await db.delete(areAbVariants).where(and(eq(areAbVariants.workspaceId, ws), inArray(areAbVariants.campaignId, areIds)));
    await db.delete(areScrapeJobs).where(and(eq(areScrapeJobs.workspaceId, ws), inArray(areScrapeJobs.campaignId, areIds)));
    // prospect_intelligence is queue-keyed, not campaign-keyed.
    const queueRows = await db.select({ id: prospectQueue.id }).from(prospectQueue)
      .where(and(eq(prospectQueue.workspaceId, ws), inArray(prospectQueue.campaignId, areIds)));
    const queueIds = queueRows.map((r) => r.id);
    if (queueIds.length) {
      await db.delete(prospectIntelligence).where(and(eq(prospectIntelligence.workspaceId, ws), inArray(prospectIntelligence.prospectQueueId, queueIds)));
    }
    counts.areQueueRows = affected(await db.delete(prospectQueue).where(and(eq(prospectQueue.workspaceId, ws), inArray(prospectQueue.campaignId, areIds))));
    counts.areCampaigns = affected(await db.delete(areCampaigns).where(and(eq(areCampaigns.workspaceId, ws), inArray(areCampaigns.id, areIds))));
  }

  /* ── CRM demo, cascading from the fictional accounts ──────────────── */
  const accIds = await demoAccountIds(db, ws);

  if (accIds.length) {
    // Customers (and their tickets / amendments / QBRs)
    const custRows = await db.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.workspaceId, ws), inArray(customers.accountId, accIds)));
    const custIds = custRows.map((r) => r.id);
    if (custIds.length) {
      await db.delete(supportTickets).where(and(eq(supportTickets.workspaceId, ws), inArray(supportTickets.customerId, custIds)));
      await db.delete(contractAmendments).where(and(eq(contractAmendments.workspaceId, ws), inArray(contractAmendments.customerId, custIds)));
      await db.delete(qbrs).where(and(eq(qbrs.workspaceId, ws), inArray(qbrs.customerId, custIds)));
      await db.delete(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.relatedType, "customer"), inArray(tasks.relatedId, custIds)));
      counts.customers = affected(await db.delete(customers).where(and(eq(customers.workspaceId, ws), inArray(customers.id, custIds))));
    }

    // Opportunities (and their roles / tasks)
    const oppRows = await db.select({ id: opportunities.id }).from(opportunities)
      .where(and(eq(opportunities.workspaceId, ws), inArray(opportunities.accountId, accIds)));
    const oppIds = oppRows.map((r) => r.id);
    if (oppIds.length) {
      await db.delete(opportunityContactRoles).where(and(eq(opportunityContactRoles.workspaceId, ws), inArray(opportunityContactRoles.opportunityId, oppIds)));
      counts.tasks += affected(await db.delete(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.relatedType, "opportunity"), inArray(tasks.relatedId, oppIds))));
      counts.opportunities = affected(await db.delete(opportunities).where(and(eq(opportunities.workspaceId, ws), inArray(opportunities.id, oppIds))));
    }

    // Contacts (and their enrollments / drafts / tasks)
    const conRows = await db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.workspaceId, ws), inArray(contacts.accountId, accIds)));
    const conIds = conRows.map((r) => r.id);
    if (conIds.length) {
      counts.enrollments += affected(await db.delete(enrollments).where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.contactId, conIds))));
      counts.emailDrafts += affected(await db.delete(emailDrafts).where(and(eq(emailDrafts.workspaceId, ws), inArray(emailDrafts.toContactId, conIds))));
      await db.delete(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.relatedType, "contact"), inArray(tasks.relatedId, conIds)));
      counts.contacts = affected(await db.delete(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, conIds))));
    }

    await db.delete(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.relatedType, "account"), inArray(tasks.relatedId, accIds)));
    counts.accounts = affected(await db.delete(accounts).where(and(eq(accounts.workspaceId, ws), inArray(accounts.id, accIds))));
  }

  /* ── Leads minted from the fictional domains ──────────────────────── */
  const leadIds = await demoLeadIds(db, ws);
  if (leadIds.length) {
    counts.enrollments += affected(await db.delete(enrollments).where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.leadId, leadIds))));
    counts.leads = affected(await db.delete(leads).where(and(eq(leads.workspaceId, ws), inArray(leads.id, leadIds))));
  }

  /* ── Seed-named singletons ────────────────────────────────────────── */
  const seqRows = await db.select({ id: sequences.id }).from(sequences)
    .where(and(eq(sequences.workspaceId, ws), inArray(sequences.name, SEED_FINGERPRINT.sequenceNames as unknown as string[])));
  const seqIds = seqRows.map((r) => r.id);
  if (seqIds.length) {
    counts.enrollments += affected(await db.delete(enrollments).where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.sequenceId, seqIds))));
    counts.sequences = affected(await db.delete(sequences).where(and(eq(sequences.workspaceId, ws), inArray(sequences.id, seqIds))));
  }
  counts.workflowRules = affected(await db.delete(workflowRules).where(and(eq(workflowRules.workspaceId, ws), inArray(workflowRules.name, SEED_FINGERPRINT.workflowNames as unknown as string[]))));
  counts.campaigns = affected(await db.delete(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.name, SEED_FINGERPRINT.campaignNames as unknown as string[]))));
  counts.products = affected(await db.delete(products).where(and(eq(products.workspaceId, ws), inArray(products.sku, SEED_FINGERPRINT.productSkus as unknown as string[]))));

  // Dashboards (widgets first)
  const dashRows = await db.select({ id: dashboards.id }).from(dashboards)
    .where(and(eq(dashboards.workspaceId, ws), eq(dashboards.name, SEED_FINGERPRINT.dashboardName)));
  const dashIds = dashRows.map((r) => r.id);
  if (dashIds.length) {
    await db.delete(dashboardWidgets).where(and(eq(dashboardWidgets.workspaceId, ws), inArray(dashboardWidgets.dashboardId, dashIds)));
    counts.dashboards = affected(await db.delete(dashboards).where(and(eq(dashboards.workspaceId, ws), inArray(dashboards.id, dashIds))));
  }

  // Territories: real members/accounts may point at the seeded four — null the
  // references before deleting so nothing dangles.
  const terrRows = await db.select({ id: territories.id }).from(territories)
    .where(and(eq(territories.workspaceId, ws), inArray(territories.name, SEED_FINGERPRINT.territoryNames as unknown as string[])));
  const terrIds = terrRows.map((r) => r.id);
  if (terrIds.length) {
    await db.update(workspaceMembers).set({ territoryId: null }).where(and(eq(workspaceMembers.workspaceId, ws), inArray(workspaceMembers.territoryId, terrIds)));
    await db.update(accounts).set({ territoryId: null }).where(and(eq(accounts.workspaceId, ws), inArray(accounts.territoryId, terrIds)));
    await db.delete(crmTerritoryRules).where(and(eq(crmTerritoryRules.workspaceId, ws), inArray(crmTerritoryRules.territoryId, terrIds)));
    counts.territories = affected(await db.delete(territories).where(and(eq(territories.workspaceId, ws), inArray(territories.id, terrIds))));
  }

  return counts;
}
