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
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { getDb } from "../db";
import { contacts, prospects, prospectQueue, prospectLinkedinEnrichments } from "../../drizzle/schema";
import { CONFIDENCE, mergeAll, type Candidate, type ProvenanceMap } from "./enrichment/fieldMerge";
import { stripNameCredentials } from "./enrichment/personName";
import { cleanPlaceholder, normalizeJobTitle } from "./enrichment/recordNormalize";
import { isPlaceholderToken, usableEmailOrNull } from "@shared/fieldHygiene";
import { normalizeCompanyName, normalizeDomain } from "./company/normalize";
import { extractLinkedInIdentifier } from "./linkedinLookup";

/** How many same-name people the name tiers will reason about. Past this the
 *  tiers refuse rather than decide — see the ORDER BY / cap + 1 read in
 *  `findPersonForRow`. Not a page size: it is the point at which "is this the
 *  only one?" stops being answerable within a bounded read. */
export const NAME_TIER_CAP = 25;

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
    // Ordered, and one row wider than the cap ON PURPOSE.
    //
    // These tiers do not return "a match" — they return a match only when it
    // is the ONLY one, and `ambiguous` otherwise. That verdict is worthless if
    // it is computed over a truncated set: with a bare LIMIT 25 and no ORDER
    // BY, thirty people sharing a name yield an arbitrary 25, and if the
    // window happens to contain one of the two candidates at a domain, the
    // uniqueness test below passes and this returns a CONFIDENT link to a
    // person it never compared against the row that would have disqualified
    // it. Truncation cannot be allowed to manufacture uniqueness.
    //
    // So: ask for cap + 1. If the extra row comes back, the name is too
    // common to decide on and the honest answer is `ambiguous` — the same
    // answer this gives when it finds two candidates, for the same reason.
    // The ORDER BY makes the window itself reproducible; without it the same
    // row could resolve differently on two runs.
    const named = await db.select().from(prospects)
      .where(and(
        eq(prospects.workspaceId, workspaceId),
        sql`LOWER(${prospects.firstName}) = ${first}`,
        sql`LOWER(${prospects.lastName}) = ${last}`,
      ))
      .orderBy(prospects.id)
      .limit(NAME_TIER_CAP + 1);
    if (named.length > NAME_TIER_CAP) return { person: null, tier: "ambiguous" };
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
function candidatesFromRow(
  row: QueuePersonShape,
  at: string,
  provenance?: { source: string; confidence: number },
): Candidate[] {
  const source = provenance?.source ?? `are_${row.sourceType}`;
  const confidence = provenance?.confidence ?? CONFIDENCE.scrapeFound;
  const out: Candidate[] = [];
  const add = (field: Candidate["field"], value: string | null | undefined) => {
    if (value?.trim()) out.push({ field, value: value.trim(), source, confidence, at });
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
  provenance?: { source: string; confidence: number },
  opts?: {
    /**
     * Curated CRM contacts qualify on a real name alone (owner intent:
     * "my contacts belong on the People tab"), while scraped queue rows
     * keep the key requirement — a keyless scraped row is more likely
     * garbage than a person. The caller vouches for name quality.
     */
    allowNameOnly?: boolean;
  },
): Promise<{ personId: number; created: boolean; tier: string } | null> {
  if (!hasPersonIdentity(row) && !opts?.allowNameOnly) return null;
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
      candidatesFromRow(row, now, provenance),
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
  const merged = mergeAll({}, {}, candidatesFromRow(row, now, provenance));
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
    void mirrorPersonFieldsToContacts(workspaceId, personId, merged.fields);
  } catch (e) {
    console.error(`[personLink] mergeIntoPerson(${personId}) failed:`, (e as Error)?.message ?? e);
  }
}

/**
 * Mirror enrichment wins on a People row down to its linked contact rows.
 *
 * Owner directive 2026-08-17: People is THE person record, sitewide. The 0160
 * fold-in gave every contact a People row and pointed `personProspectId` at
 * it — but the flow was one-directional: enrichment wrote to People and never
 * came back. Live on 2026-08-16, LSI held 1,520 contacts with ZERO emails and
 * 1,505 People rows WITH them, for the same humans. Anything still reading
 * `contacts` (deal roles, briefs, the sequences audience picker) saw a person
 * with no email that People knew the email of.
 *
 * FILL-ONLY. A contact field is written only when it is currently empty. A
 * contact is a curated CRM record and its non-empty values outrank a scraped
 * candidate — mergeAll already encodes that ordering on the People side, and
 * this must not undo it from below. So: People wins on People; on contacts,
 * the existing value wins and enrichment fills the gaps.
 *
 * Best-effort and fire-and-forget: a mirror failure never fails the People
 * write that matters. Only the four columns contacts shares with the merge
 * vocabulary; nothing else on the row is touched.
 */
async function mirrorPersonFieldsToContacts(
  workspaceId: number,
  personId: number,
  fields: Record<string, string>,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    // contacts column names differ from People's for company.
    const map: Record<string, keyof typeof contacts.$inferInsert> = {
      email: "email", phone: "phone", title: "title", linkedinUrl: "linkedinUrl",
      company: "companyName", companyDomain: "companyDomain",
    };
    const entries = Object.entries(fields).filter(([f]) => f in map);
    if (entries.length === 0) return;
    const linked = await db.select().from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.personProspectId, personId)));
    for (const c of linked) {
      const patch: Record<string, unknown> = {};
      for (const [field, value] of entries) {
        const col = map[field]!;
        const current = (c as Record<string, unknown>)[col];
        if (current === null || current === undefined || String(current).trim() === "") {
          patch[col] = value.slice(0, field === "email" ? 320 : 200);
        }
      }
      if (Object.keys(patch).length === 0) continue;
      await db.update(contacts).set(patch as never)
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, c.id)));
    }
  } catch (e) {
    console.error(`[personLink] mirror to contacts (${personId}) failed:`, (e as Error)?.message ?? e);
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

  // A row with no identity can never be linked — and, crucially, nothing
  // about it ever changes, so it stays inside `personProspectId IS NULL`
  // forever. Filtered in JS (as `skippedNoIdentity`) against an unordered
  // LIMIT 200, those permanent refusals accumulate at the front of the page
  // and the backfill re-reads the same dead rows every run while linkable
  // ones behind them are never reached. This is the day-9 brand sweep
  // starving on its own negative cache, in a different table.
  //
  // A deliberately CONSERVATIVE translation of hasPersonIdentity(): it may
  // admit a row the JS check then refuses (usableEmailOrNull also rejects
  // placeholder emails, which SQL does not attempt), but it must never
  // exclude one the JS check would accept. 0159 purged the stored "<UNKNOWN>"
  // values and ingest cleans new ones, so that residue is small and bounded —
  // whereas the rows this now excludes are the unbounded population.
  const nonEmpty = (col: AnyMySqlColumn) => sql`(${col} IS NOT NULL AND ${col} <> '')`;
  conds.push(or(nonEmpty(prospectQueue.firstName), nonEmpty(prospectQueue.lastName))!);
  conds.push(or(
    nonEmpty(prospectQueue.email),
    nonEmpty(prospectQueue.linkedinUrl),
    and(
      nonEmpty(prospectQueue.firstName),
      nonEmpty(prospectQueue.lastName),
      nonEmpty(prospectQueue.companyName),
    ),
  )!);

  const rows = await db.select({
    id: prospectQueue.id, workspaceId: prospectQueue.workspaceId, campaignId: prospectQueue.campaignId,
    firstName: prospectQueue.firstName, lastName: prospectQueue.lastName,
    email: prospectQueue.email, linkedinUrl: prospectQueue.linkedinUrl,
    phone: prospectQueue.phone, title: prospectQueue.title,
    companyName: prospectQueue.companyName, companyDomain: prospectQueue.companyDomain,
    sourceType: prospectQueue.sourceType,
  }).from(prospectQueue).where(and(...conds))
    .orderBy(prospectQueue.id)
    .limit(opts.limit ?? 200);

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

/* ─── CRM contacts → People (migration 0160, owner-approved 2026-08-12) ────
   The People tab lists only `prospects`; contacts lived in a disjoint table
   and never appeared there. Same fold-in as the 0153 queue work: every
   contact gets a canonical People record via the tiered match, through the
   merge, with a link column pointing home. */

export interface ContactPersonShape {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
}

/** CRM contacts are curated records, so their values enter the merge at the
 *  `preexisting` tier (70) under one named source — above scraped finds,
 *  below anything verified. */
export const CONTACT_PROVENANCE = { source: "crm_contact", confidence: CONFIDENCE.preexisting } as const;

/**
 * Find-or-create the canonical person for a CRM contact and write the link
 * column. Fast path first: a person that already claims this contact via
 * `prospects.linkedContactId` (the promotion pair) IS its person — no
 * matching, no merge, no risk of a near-duplicate. Otherwise the same
 * tiered upsert the queue rows use. Also completes the bidirectional pair
 * (person.linkedContactId) when the person is unclaimed — and never steals
 * a person already paired with a different contact.
 */
export async function upsertPersonForContact(
  workspaceId: number,
  c: ContactPersonShape,
): Promise<{ personId: number; created: boolean; tier: string } | null> {
  const db = await getDb();
  if (!db) return null;

  const [claimed] = await db.select({ id: prospects.id }).from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.linkedContactId, c.id)))
    .limit(1);
  if (claimed) {
    await db.update(contacts).set({ personProspectId: claimed.id } as never)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, c.id)));
    return { personId: claimed.id, created: false, tier: "promoted_pair" };
  }

  // A curated contact with a REAL name belongs on People even with no
  // email/LinkedIn/company key — the exact shape of the owner's historic
  // import (emails all null). Placeholder names ("Unknown Prospect", the
  // execution-seam default) stay out: a person card that says Unknown
  // Prospect is noise, not a person.
  const hasRealName = !isPlaceholderToken(c.firstName) || !isPlaceholderToken(c.lastName);
  const result = await upsertPersonForRow(workspaceId, {
    id: c.id, campaignId: 0, sourceType: "contact",
    firstName: c.firstName, lastName: c.lastName,
    email: c.email, linkedinUrl: c.linkedinUrl, phone: c.phone,
    title: c.title, companyName: c.companyName, companyDomain: c.companyDomain,
  }, CONTACT_PROVENANCE, { allowNameOnly: hasRealName });
  if (!result) return null;

  await db.update(contacts).set({ personProspectId: result.personId } as never)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, c.id)));
  // Deliberately ONE-directional (owner call, 2026-08-12): the People tab
  // defines "Saved" as linkedLeadId/linkedContactId being set, and that
  // status must mean a DELIBERATE save (promotion), not fold-in
  // bookkeeping — freshly folded contacts belong in the Net-new triage
  // pool. Promotion stays duplicate-safe without the back-pointer:
  // promoteProspectRow also reuses a contact that points at the person
  // via personProspectId.
  return result;
}

/**
 * Backfill: heal contacts that predate the 0160 seams. Unlike the queue
 * backfill's single daily slice, this DRAINS — keyset-paginated pages until
 * a pass comes back short (or the page cap, a runaway backstop). An owner
 * who just imported 900 contacts must not wait two days to see them; the
 * work is pure DB matching, no credits, no rate limits.
 */
export async function linkUnlinkedContacts(opts: {
  workspaceId?: number;
  /** Page size per pass, not a total cap. */
  limit?: number;
  maxPages?: number;
} = {}): Promise<LinkSummary> {
  const summary: LinkSummary = { scanned: 0, linked: 0, created: 0, skippedNoIdentity: 0, failed: 0 };
  const db = await getDb();
  if (!db) return summary;

  const pageSize = opts.limit ?? 500;
  const maxPages = opts.maxPages ?? 20;
  // Keyset pagination, not OFFSET: skipped rows keep personProspectId NULL,
  // so a plain re-select would return the same page forever.
  let lastId = 0;

  for (let page = 0; page < maxPages; page++) {
    const conds = [isNull(contacts.personProspectId), gt(contacts.id, lastId)];
    if (opts.workspaceId) conds.push(eq(contacts.workspaceId, opts.workspaceId));

    const rows = await db.select({
      id: contacts.id, workspaceId: contacts.workspaceId,
      firstName: contacts.firstName, lastName: contacts.lastName,
      email: contacts.email, linkedinUrl: contacts.linkedinUrl, phone: contacts.phone,
      title: contacts.title, companyName: contacts.companyName, companyDomain: contacts.companyDomain,
    }).from(contacts).where(and(...conds)).orderBy(contacts.id).limit(pageSize);

    summary.scanned += rows.length;
    for (const row of rows) {
      lastId = row.id;
      try {
        const result = await upsertPersonForContact(row.workspaceId, row);
        if (!result) { summary.skippedNoIdentity++; continue; }
        summary.linked++;
        if (result.created) summary.created++;
      } catch (e) {
        summary.failed++;
        console.error(`[personLink] contact ${row.id} failed:`, (e as Error)?.message ?? e);
      }
    }
    if (rows.length < pageSize) break;
  }
  return summary;
}
