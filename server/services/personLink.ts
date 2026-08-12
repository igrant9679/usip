/**
 * personLink — People-as-master for campaign prospects.
 *
 * Every retained campaign prospect (`prospect_queue` row) references ONE
 * canonical People record (`prospects` row) via `person_prospect_id`. One
 * person, many campaigns, zero duplicate person records.
 *
 * The matcher is a strict tier ladder — first hit wins, and a weaker key
 * never merges against a conflicting stronger key:
 *
 *   (a) verified-key email, exact (lowercased);
 *   (b) LinkedIn identity — the enrichment table's indexed profile
 *       identifier, then the prospect's own URL by slug;
 *   (d) full name + company DOMAIN — unique match only, rejected when the
 *       candidate holds a conflicting email or LinkedIn slug;
 *   (e) full name + normalized company NAME — same constraints.
 *
 * Ambiguity (2+ candidates at d/e) NEVER silently merges — a new person is
 * created and the ambiguity is recorded in its verificationNotes.
 *
 * Rows without a person identity (no name, or name with neither email nor
 * LinkedIn nor company) are left unlinked — they are not people yet.
 *
 * `linkUnlinkedQueueRows` is BOTH the ingest seam (fired after every queue
 * insert) and the backfill (boot cron) — the associateUnlinkedProspects
 * pattern. It never mutates queue person columns: emails a sequence already
 * used stay byte-identical (owner risk-reconciliation, 2026-08-11).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { prospects, prospectQueue, prospectLinkedinEnrichments } from "../../drizzle/schema";
import { CONFIDENCE, mergeAll, type Candidate, type ProvenanceMap } from "./enrichment/fieldMerge";
import { stripNameCredentials } from "./enrichment/personName";
import { cleanPlaceholder, normalizeJobTitle } from "./enrichment/recordNormalize";
import { usableEmailOrNull } from "@shared/fieldHygiene";
import { normalizeCompanyName, normalizeDomain } from "./company/normalize";
import { extractLinkedInIdentifier } from "./linkedinLookup";

export interface QueuePersonShape {
  id: number;
  campaignId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  sourceType: string;
}

/** A queue row qualifies for a People record only when it names a person
 *  AND carries at least one resolvable identity key. */
export function hasPersonIdentity(row: {
  firstName?: string | null; lastName?: string | null;
  email?: string | null; linkedinUrl?: string | null; companyName?: string | null;
}): boolean {
  const named = !!(row.firstName?.trim() || row.lastName?.trim());
  if (!named) return false;
  // A placeholder "email" is not identity — shape-gate it like the tiers do.
  return !!(usableEmailOrNull(row.email) || row.linkedinUrl?.trim() || (row.firstName?.trim() && row.lastName?.trim() && row.companyName?.trim()));
}

type PersonRow = typeof prospects.$inferSelect;

/** True when two identity keys CONFLICT (both present and different) —
 *  the guard that keeps tier d/e from merging across a stronger key. */
export function keysConflict(
  row: { email?: string | null; linkedinUrl?: string | null },
  person: { email: string | null; linkedinUrl: string | null },
): boolean {
  // Shape-gated like tier (a): a placeholder "email" must neither conflict
  // nor corroborate.
  const rowEmail = usableEmailOrNull(row.email);
  const personEmail = usableEmailOrNull(person.email);
  if (rowEmail && personEmail && rowEmail !== personEmail) return true;
  const rowSlug = row.linkedinUrl ? extractLinkedInIdentifier(row.linkedinUrl) : null;
  const personSlug = person.linkedinUrl ? extractLinkedInIdentifier(person.linkedinUrl) : null;
  if (rowSlug && personSlug && rowSlug !== personSlug) return true;
  return false;
}

export type PersonMatch =
  | { person: PersonRow; tier: "email" | "linkedin" | "name_domain" | "name_company" }
  | { person: null; tier: "ambiguous" | "none" };

export async function findPersonForRow(
  workspaceId: number,
  row: QueuePersonShape,
): Promise<PersonMatch> {
  const db = await getDb();
  if (!db) return { person: null, tier: "none" };

  // (a) email — the strongest key; accept outright. Shape-gated: the key is
  // only as strong as it is REAL. Before 2026-08-12 any non-empty string
  // qualified, so two scraped rows both carrying the literal "<UNKNOWN>"
  // matched each other here and linked to the same person. The ingest seam
  // now cleans placeholders and 0159 repaired stored rows, but a key tier
  // must not depend on every producer staying clean.
  const email = usableEmailOrNull(row.email);
  if (email) {
    const [hit] = await db.select().from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), sql`LOWER(${prospects.email}) = ${email}`))
      .limit(1);
    if (hit) return { person: hit, tier: "email" };
  }

  // (b) LinkedIn identity — indexed enrichment identifier first, then slug.
  const slug = row.linkedinUrl ? extractLinkedInIdentifier(row.linkedinUrl) : null;
  if (slug) {
    const [enr] = await db
      .select({ prospectId: prospectLinkedinEnrichments.prospectId })
      .from(prospectLinkedinEnrichments)
      .where(and(
        eq(prospectLinkedinEnrichments.workspaceId, workspaceId),
        eq(prospectLinkedinEnrichments.linkedinProfileIdentifier, slug),
      ))
      .limit(1);
    if (enr) {
      const [person] = await db.select().from(prospects)
        .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, enr.prospectId)))
        .limit(1);
      if (person) return { person, tier: "linkedin" };
    }
    const [byUrl] = await db.select().from(prospects)
      .where(and(
        eq(prospects.workspaceId, workspaceId),
        sql`${prospects.linkedinUrl} LIKE ${`%/in/${slug}%`}`,
      ))
      .limit(1);
    if (byUrl) return { person: byUrl, tier: "linkedin" };
  }

  // (d)/(e) name-based — unique match only, stronger-key conflicts reject.
  const first = stripNameCredentials(row.firstName ?? "")?.trim().toLowerCase();
  const last = stripNameCredentials(row.lastName ?? "")?.trim().toLowerCase();
  if (first && last) {
    const named = await db.select().from(prospects)
      .where(and(
        eq(prospects.workspaceId, workspaceId),
        sql`LOWER(${prospects.firstName}) = ${first}`,
        sql`LOWER(${prospects.lastName}) = ${last}`,
      ))
      .limit(25);
    const compatible = named.filter((p) => !keysConflict(row, p));

    const domain = normalizeDomain(row.companyDomain);
    if (domain) {
      const byDomain = compatible.filter((p) => normalizeDomain(p.companyDomain) === domain);
      if (byDomain.length === 1) return { person: byDomain[0], tier: "name_domain" };
      if (byDomain.length > 1) return { person: null, tier: "ambiguous" };
    }
    const companyNorm = normalizeCompanyName(row.companyName);
    if (companyNorm) {
      const byName = compatible.filter((p) => normalizeCompanyName(p.company) === companyNorm);
      if (byName.length === 1) return { person: byName[0], tier: "name_company" };
      if (byName.length > 1) return { person: null, tier: "ambiguous" };
    }
  }
  return { person: null, tier: "none" };
}

/** Candidates a queue row contributes to its person record. Modest flat
 *  confidence: campaign scrapes are opportunistic finds — the final
 *  enrichment check is what verifies. All values pass through mergeAll,
 *  so normalization + never-downgrade rules apply exactly as everywhere. */
function candidatesFromRow(row: QueuePersonShape, at: string): Candidate[] {
  const source = `are_${row.sourceType}`;
  const out: Candidate[] = [];
  const add = (field: Candidate["field"], value: string | null | undefined) => {
    if (value?.trim()) out.push({ field, value: value.trim(), source, confidence: CONFIDENCE.scrapeFound, at });
  };
  add("email", row.email);
  add("phone", row.phone);
  add("title", row.title);
  add("company", row.companyName);
  add("companyDomain", row.companyDomain);
  add("linkedinUrl", row.linkedinUrl);
  return out;
}

/** Find-or-create the canonical person for a queue row, merging any
 *  stronger data the row carries. Returns the person id, or null when the
 *  row has no person identity. */
export async function upsertPersonForRow(
  workspaceId: number,
  row: QueuePersonShape,
): Promise<{ personId: number; created: boolean; tier: string } | null> {
  if (!hasPersonIdentity(row)) return null;
  const db = await getDb();
  if (!db) return null;
  const now = new Date().toISOString();

  const match = await findPersonForRow(workspaceId, row);
  if (match.person) {
    // Existing person: contribute the row's data through the merge — the
    // ledger decides what (if anything) improves.
    const p = match.person;
    const merged = mergeAll(
      {
        email: p.email, phone: p.phone, company: p.company,
        companyDomain: p.companyDomain, title: p.title, linkedinUrl: p.linkedinUrl,
      },
      (p.fieldProvenance ?? {}) as ProvenanceMap,
      candidatesFromRow(row, now),
    );
    if (Object.keys(merged.fields).length > 0) {
      const WIDTHS: Record<string, number> = { title: 120, email: 320 };
      const patch: Record<string, unknown> = { fieldProvenance: merged.ledger };
      for (const [field, value] of Object.entries(merged.fields)) {
        patch[field] = value.slice(0, WIDTHS[field] ?? 200);
      }
      await db.update(prospects).set(patch as never)
        .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, p.id)));
      const { recordFieldHistory } = await import("./enrichment/fieldHistory");
      void recordFieldHistory(workspaceId, p.id, merged.decisions, "person_link");
    }
    return { personId: p.id, created: false, tier: match.tier };
  }

  // New person — normalized through the same seams every import uses.
  const first = (stripNameCredentials(row.firstName ?? "") ?? row.firstName ?? "").trim().slice(0, 80);
  const last = (stripNameCredentials(row.lastName ?? "") ?? row.lastName ?? "").trim().slice(0, 80);
  const merged = mergeAll({}, {}, candidatesFromRow(row, now));
  const values: typeof prospects.$inferInsert = {
    workspaceId,
    firstName: first || "(unknown)",
    lastName: last || "(unknown)",
    title: cleanPlaceholder(normalizeJobTitle(row.title))?.slice(0, 120) ?? undefined,
    email: merged.fields.email?.slice(0, 320),
    phone: merged.fields.phone?.slice(0, 40),
    company: merged.fields.company?.slice(0, 200),
    companyDomain: merged.fields.companyDomain?.slice(0, 200),
    linkedinUrl: merged.fields.linkedinUrl,
    fieldProvenance: merged.ledger,
    ...(match.tier === "ambiguous"
      ? { verificationNotes: "Created as NEW person: 2+ existing name-based matches were ambiguous — merge manually if appropriate." }
      : {}),
  };
  const [inserted] = await db.insert(prospects).values(values).$returningId();
  return { personId: inserted.id, created: true, tier: match.tier };
}

/**
 * Contribute freshly-resolved values to a linked person through the merge —
 * used by the ARE enrich agent so its findings land on the canonical record,
 * not only on the campaign copy. Verified emails carry their verdict (and
 * the pattern+Reoon confidence tier); everything else enters at the
 * opportunistic-find tier. Best-effort: never throws.
 */
export async function mergeIntoPerson(
  workspaceId: number,
  personId: number,
  data: {
    email?: string | null;
    emailVerification?: string | null;
    companyName?: string | null;
    companyDomain?: string | null;
    title?: string | null;
    source: string;
  },
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const [p] = await db.select().from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, personId)))
      .limit(1);
    if (!p) return;
    const now = new Date().toISOString();
    const cands: Candidate[] = [];
    if (data.email?.trim()) {
      const v = data.emailVerification ?? undefined;
      const conf = v === "valid" ? CONFIDENCE.patternReoonValid
        : v === "accept_all" ? CONFIDENCE.emailAcceptAll
        : v === "risky" ? CONFIDENCE.emailRisky
        : CONFIDENCE.scrapeFound;
      cands.push({ field: "email", value: data.email.trim(), source: data.source, confidence: conf, at: now, ...(v ? { verification: v } : {}) });
    }
    const add = (field: Candidate["field"], value: string | null | undefined) => {
      if (value?.trim()) cands.push({ field, value: value.trim(), source: data.source, confidence: CONFIDENCE.scrapeFound, at: now });
    };
    add("company", data.companyName);
    add("companyDomain", data.companyDomain);
    add("title", data.title);
    if (cands.length === 0) return;

    const merged = mergeAll(
      { email: p.email, company: p.company, companyDomain: p.companyDomain, title: p.title },
      (p.fieldProvenance ?? {}) as ProvenanceMap,
      cands,
    );
    if (Object.keys(merged.fields).length === 0) return;
    const WIDTHS: Record<string, number> = { title: 120, email: 320 };
    const patch: Record<string, unknown> = { fieldProvenance: merged.ledger };
    for (const [field, value] of Object.entries(merged.fields)) {
      patch[field] = value.slice(0, WIDTHS[field] ?? 200);
    }
    const emailDecision = merged.decisions.find((d) => d.field === "email" && (d.action === "filled" || d.action === "replaced"));
    if (emailDecision?.provenance.verification) {
      patch.emailStatus = emailDecision.provenance.verification;
      patch.emailVerifiedAt = new Date();
    }
    await db.update(prospects).set(patch as never)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, personId)));
    const { recordFieldHistory } = await import("./enrichment/fieldHistory");
    void recordFieldHistory(workspaceId, personId, merged.decisions, data.source);
  } catch (e) {
    console.error(`[personLink] mergeIntoPerson(${personId}) failed:`, (e as Error)?.message ?? e);
  }
}

export interface LinkSummary {
  scanned: number;
  linked: number;
  created: number;
  skippedNoIdentity: number;
  failed: number;
}

/**
 * Link every unlinked queue row to its canonical person — the ingest seam
 * AND the backfill. Bounded; per-row failures never stop the sweep; queue
 * person columns are NEVER mutated here.
 */
export async function linkUnlinkedQueueRows(opts: {
  workspaceId?: number;
  campaignId?: number;
  limit?: number;
} = {}): Promise<LinkSummary> {
  const summary: LinkSummary = { scanned: 0, linked: 0, created: 0, skippedNoIdentity: 0, failed: 0 };
  const db = await getDb();
  if (!db) return summary;

  const conds = [isNull(prospectQueue.personProspectId)];
  if (opts.workspaceId) conds.push(eq(prospectQueue.workspaceId, opts.workspaceId));
  if (opts.campaignId) conds.push(eq(prospectQueue.campaignId, opts.campaignId));

  const rows = await db.select({
    id: prospectQueue.id, workspaceId: prospectQueue.workspaceId, campaignId: prospectQueue.campaignId,
    firstName: prospectQueue.firstName, lastName: prospectQueue.lastName,
    email: prospectQueue.email, linkedinUrl: prospectQueue.linkedinUrl,
    phone: prospectQueue.phone, title: prospectQueue.title,
    companyName: prospectQueue.companyName, companyDomain: prospectQueue.companyDomain,
    sourceType: prospectQueue.sourceType,
  }).from(prospectQueue).where(and(...conds)).limit(opts.limit ?? 200);

  summary.scanned = rows.length;
  for (const row of rows) {
    try {
      const result = await upsertPersonForRow(row.workspaceId, row as QueuePersonShape);
      if (!result) { summary.skippedNoIdentity++; continue; }
      await db.update(prospectQueue)
        .set({ personProspectId: result.personId } as never)
        .where(eq(prospectQueue.id, row.id));
      summary.linked++;
      if (result.created) summary.created++;
    } catch (e) {
      summary.failed++;
      console.error(`[personLink] queue row ${row.id} failed:`, (e as Error)?.message ?? e);
    }
  }
  return summary;
}
