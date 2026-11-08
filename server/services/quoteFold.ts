/**
 * Quotes folded into proposals (audit 2026-10-20, F34, and F36's versioned
 * quotes).
 *
 * A deal had two documents that could disagree: a quote priced from the
 * catalogue and a proposal with its own budget, each on its own page. Now a
 * quote is a proposal's pricing section:
 *
 *   - savePricing writes a NEW quote version for the proposal each time the
 *     pricing changes; the version it replaces keeps its row, stamped
 *     supersededAt, so every earlier price stays viewable;
 *   - the proposal's price (budget) is the current version's total, and the
 *     deal's value follows only when the person confirms that change;
 *   - accepting the proposal records its current pricing as accepted.
 *
 * foldQuotesIntoProposals attaches the quotes made before this: each to its
 * deal's newest proposal, or to a new DRAFT proposal for a deal that has none,
 * numbering their versions by age. Idempotent — it reads only quotes with no
 * proposal yet — and run once per boot. A draft is never sent by anything.
 */
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { accounts, opportunities, proposals, quoteLineItems, quotes } from "../../drizzle/schema";
import type { getDb } from "../db";
import { centsToDecimal, computeQuoteTotals } from "@shared/quoteTotals";
import { insertIdOf } from "../_core/insertId";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Number a proposal's quotes by age; all but the newest are superseded. */
export async function renumberProposalQuotes(db: Db, workspaceId: number, proposalId: number): Promise<void> {
  const qs = await db.select({ id: quotes.id, version: quotes.version, supersededAt: quotes.supersededAt, createdAt: quotes.createdAt })
    .from(quotes).where(and(eq(quotes.workspaceId, workspaceId), eq(quotes.proposalId, proposalId)))
    .orderBy(asc(quotes.createdAt), asc(quotes.id));
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const next = qs[i + 1];
    const version = i + 1;
    const supersededAt = next ? (q.supersededAt ?? next.createdAt ?? new Date()) : null;
    const same = q.version === version && ((q.supersededAt == null) === (supersededAt == null));
    if (same) continue;
    await db.update(quotes).set({ version, supersededAt } as never).where(and(eq(quotes.id, q.id), eq(quotes.workspaceId, workspaceId)));
  }
}

export async function foldQuotesIntoProposals(db: Db, opts: { workspaceId?: number } = {}): Promise<{ attached: number; draftsCreated: number; skipped: number }> {
  const loose = await db.select({
    id: quotes.id, workspaceId: quotes.workspaceId, opportunityId: quotes.opportunityId, total: quotes.total,
    createdByUserId: quotes.createdByUserId, createdAt: quotes.createdAt,
  }).from(quotes)
    .where(opts.workspaceId != null ? and(isNull(quotes.proposalId), eq(quotes.workspaceId, opts.workspaceId)) : isNull(quotes.proposalId))
    .orderBy(asc(quotes.createdAt), asc(quotes.id));
  const groups = new Map<string, typeof loose>();
  for (const q of loose) {
    const k = `${q.workspaceId}:${q.opportunityId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(q);
  }
  let attached = 0, draftsCreated = 0, skipped = 0;
  for (const group of Array.from(groups.values())) {
    const { workspaceId, opportunityId } = group[0];
    const [existing] = await db.select({ id: proposals.id }).from(proposals)
      .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.linkedOpportunityId, opportunityId)))
      .orderBy(desc(proposals.id)).limit(1);
    let proposalId = existing?.id ?? null;
    if (!proposalId) {
      const [opp] = await db.select({ id: opportunities.id, name: opportunities.name, accountId: opportunities.accountId, ownerUserId: opportunities.ownerUserId })
        .from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, workspaceId))).limit(1);
      // A quote on a deal that is gone (or not this workspace's) has nothing
      // to attach to; it is left as it is, and said.
      if (!opp) { skipped += group.length; continue; }
      const [acct] = opp.accountId
        ? await db.select({ name: accounts.name }).from(accounts).where(and(eq(accounts.id, opp.accountId), eq(accounts.workspaceId, workspaceId))).limit(1)
        : [];
      const newest = group[group.length - 1];
      // The author is whoever priced it, else the deal's owner. (Never the
      // workspace's raw owner: an unattended path does not read that.)
      const author = newest.createdByUserId ?? group.find((q) => q.createdByUserId != null)?.createdByUserId ?? opp.ownerUserId ?? 0;
      const res = await db.insert(proposals).values({
        workspaceId,
        createdBy: author,
        title: `${opp.name} — pricing`.slice(0, 255),
        clientName: (acct?.name ?? opp.name).slice(0, 255),
        accountId: opp.accountId ?? null,
        linkedOpportunityId: opp.id,
        budget: String(newest.total ?? "0"),
        status: "draft",
        requirements: [],
      } as never);
      proposalId = insertIdOf(res);
      if (!proposalId) { skipped += group.length; continue; }
      draftsCreated++;
    }
    await db.update(quotes).set({ proposalId } as never)
      .where(and(eq(quotes.workspaceId, workspaceId), inArray(quotes.id, group.map((q) => q.id)), isNull(quotes.proposalId)));
    attached += group.length;
    await renumberProposalQuotes(db, workspaceId, proposalId);
  }
  return { attached, draftsCreated, skipped };
}

export type PricingLine = { productId?: number; name: string; description?: string; quantity: number; unitPrice: number; discountPct: number };

/**
 * A new pricing version for a proposal: a quote on its linked deal, numbered
 * after the last, which becomes the current one; the one it replaces is
 * stamped superseded and kept. Returns the new quote and its total. The
 * caller checks the proposal is this workspace's and editable.
 */
export async function writePricingVersion(db: Db, input: {
  workspaceId: number;
  proposalId: number;
  opportunityId: number;
  actorUserId: number;
  lineItems: PricingLine[];
  notes?: string | null;
  terms?: string | null;
  expiresInDays: number;
}): Promise<{ quoteId: number; version: number; totalCents: number; total: string }> {
  const totals = computeQuoteTotals(input.lineItems);
  const prior = await db.select({ id: quotes.id, version: quotes.version }).from(quotes)
    .where(and(eq(quotes.workspaceId, input.workspaceId), eq(quotes.proposalId, input.proposalId)));
  const version = prior.reduce((m, q) => Math.max(m, Number(q.version ?? 0)), 0) + 1;
  const now = new Date();
  const res = await db.insert(quotes).values({
    workspaceId: input.workspaceId,
    opportunityId: input.opportunityId,
    proposalId: input.proposalId,
    version,
    quoteNumber: `Q-${now.getTime()}-${input.proposalId}-v${version}`.slice(0, 40),
    status: "draft",
    expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000),
    subtotal: centsToDecimal(totals.subtotalCents),
    discountTotal: centsToDecimal(totals.discountTotalCents),
    taxTotal: centsToDecimal(totals.taxTotalCents),
    total: centsToDecimal(totals.totalCents),
    notes: input.notes ?? null,
    terms: input.terms ?? null,
    createdByUserId: input.actorUserId,
  } as never);
  const quoteId = insertIdOf(res);
  for (let i = 0; i < input.lineItems.length; i++) {
    const li = input.lineItems[i];
    const line = totals.lines[i];
    await db.insert(quoteLineItems).values({
      workspaceId: input.workspaceId,
      quoteId,
      productId: li.productId ?? null,
      name: li.name,
      description: li.description ?? null,
      quantity: line.quantity,
      unitPrice: centsToDecimal(line.unitPriceCents),
      discountPct: String(li.discountPct),
      lineTotal: centsToDecimal(line.lineTotalCents),
    } as never);
  }
  // Every earlier version is kept, and says it was replaced.
  await db.update(quotes).set({ supersededAt: now } as never).where(and(
    eq(quotes.workspaceId, input.workspaceId), eq(quotes.proposalId, input.proposalId), ne(quotes.id, quoteId), isNull(quotes.supersededAt),
  ));
  return { quoteId, version, totalCents: totals.totalCents, total: centsToDecimal(totals.totalCents) };
}

/** The current pricing version of a proposal, with its lines; null when it has none. */
export async function currentPricing(db: Db, workspaceId: number, proposalId: number) {
  const [q] = await db.select().from(quotes)
    .where(and(eq(quotes.workspaceId, workspaceId), eq(quotes.proposalId, proposalId), isNull(quotes.supersededAt)))
    .orderBy(desc(quotes.version), desc(quotes.id)).limit(1);
  if (!q) return null;
  const lines = await db.select().from(quoteLineItems)
    .where(and(eq(quoteLineItems.quoteId, q.id), eq(quoteLineItems.workspaceId, workspaceId)))
    .orderBy(asc(quoteLineItems.id));
  return { ...q, lineItems: lines };
}
