/**
 * ARE queue reconciliation — the audit-and-fix the owner asked for
 * (2026-08-12): every queue prospect gets a real name where one is findable,
 * broken links are scrubbed, unreconcilable rows are FLAGGED (moved to the
 * Rejections tab via sequenceStatus='skipped' — visible and reversible,
 * never silently deleted), and campaign exclusivity is applied to history:
 * one campaign per person, the row with the most engagement wins.
 *
 * HOW FIXES FLOW. Queue person columns are never freely mutated (the 0153
 * rule: a campaign's already-used values stay byte-identical), and display
 * joins the canonical person — so "fix the name" means fix the PERSON, via
 * personLink + the existing capped, compliant enrichment machinery. What
 * this pass writes to the queue is limited to: scrubbed link fields,
 * discovered linkedinUrl (an enrichment INPUT), enrichment re-queue stamps,
 * and the skipped flag.
 *
 * NO FABRICATION. LinkedIn discovery accepts a profile only when the
 * normalized result name equals the row's normalized name AND the result
 * mentions the row's company; anything less is left missing.
 */
import { and, eq, inArray } from "drizzle-orm";
import { prospectQueue, prospects } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { isPlaceholderToken } from "@shared/fieldHygiene";
import { canonicalText, canonicalTokens } from "@shared/canonicalText";
import { queueIdentityKeys } from "./queueIdentity";
import { linkUnlinkedQueueRows } from "../personLink";
import { searchLinkedInProfiles } from "../linkedinLookup";

const LINKEDIN_URL_SHAPE = /linkedin\.com\//i;
const HTTPISH = /^https?:\/\//i;

interface QueueRow {
  id: number;
  campaignId: number | null;
  personProspectId: number | null;
  sequenceStatus: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  sourceUrl: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
}

const hasRealName = (r: { firstName: string | null; lastName: string | null }) =>
  !isPlaceholderToken(r.firstName) || !isPlaceholderToken(r.lastName);

const badLinkedin = (v: string | null) =>
  !!v && (isPlaceholderToken(v) || !LINKEDIN_URL_SHAPE.test(v));
const badSource = (v: string | null) =>
  !!v && (isPlaceholderToken(v) || !HTTPISH.test(v));

/** Engagement rank for picking the keeper of a duplicate group. */
const STATUS_RANK: Record<string, number> = {
  replied: 7, completed: 6, contacted: 5, enrolled: 4, paused: 3, approved: 2, pending: 1, canceled: 0, skipped: 0,
};

async function loadRows(workspaceId: number): Promise<QueueRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    id: prospectQueue.id,
    campaignId: prospectQueue.campaignId,
    personProspectId: prospectQueue.personProspectId,
    sequenceStatus: prospectQueue.sequenceStatus,
    firstName: prospectQueue.firstName,
    lastName: prospectQueue.lastName,
    email: prospectQueue.email,
    linkedinUrl: prospectQueue.linkedinUrl,
    sourceUrl: prospectQueue.sourceUrl,
    title: prospectQueue.title,
    companyName: prospectQueue.companyName,
    companyDomain: prospectQueue.companyDomain,
  }).from(prospectQueue).where(eq(prospectQueue.workspaceId, workspaceId)).orderBy(prospectQueue.id);
}

/** Union of rows sharing any identity key → duplicate groups. */
function duplicateGroups(rows: QueueRow[]): QueueRow[][] {
  const byKey = new Map<string, number>(); // key → group id
  const groupOf = new Map<number, number>(); // row id → group id
  const groups = new Map<number, QueueRow[]>();
  let next = 0;
  for (const r of rows) {
    const keys = queueIdentityKeys(r);
    let gid: number | undefined;
    for (const k of keys) {
      const g = byKey.get(k);
      if (g !== undefined) { gid = g; break; }
    }
    if (gid === undefined) gid = next++;
    for (const k of keys) byKey.set(k, gid);
    groupOf.set(r.id, gid);
    const list = groups.get(gid) ?? [];
    list.push(r);
    groups.set(gid, list);
  }
  return Array.from(groups.values()).filter((g) => g.length > 1);
}

export interface QueueAudit {
  scanned: number;
  missingName: number;
  /** Missing on the row but present on the linked person — display is fine. */
  nameCoveredByPerson: number;
  badLinkedinUrl: number;
  badSourceUrl: number;
  missingLinkedinUrl: number;
  unlinkedPerson: number;
  duplicateGroups: number;
  duplicateRows: number;
  crossCampaignGroups: number;
  unreconcilable: number;
  flaggedRowIds: number[];
}

export async function auditQueueProspects(workspaceId: number): Promise<QueueAudit> {
  const db = await getDb();
  const rows = await loadRows(workspaceId);
  const live = rows.filter((r) => r.sequenceStatus !== "skipped");

  // Person names, for rows whose own columns are empty.
  const personIds = Array.from(new Set(live.map((r) => r.personProspectId).filter((x): x is number => !!x)));
  const personName = new Map<number, boolean>();
  if (db && personIds.length > 0) {
    const people = await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName })
      .from(prospects).where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, personIds)));
    for (const p of people) personName.set(p.id, hasRealName(p));
  }

  const out: QueueAudit = {
    scanned: live.length, missingName: 0, nameCoveredByPerson: 0,
    badLinkedinUrl: 0, badSourceUrl: 0, missingLinkedinUrl: 0, unlinkedPerson: 0,
    duplicateGroups: 0, duplicateRows: 0, crossCampaignGroups: 0,
    unreconcilable: 0, flaggedRowIds: [],
  };
  for (const r of live) {
    const named = hasRealName(r);
    const personHasName = r.personProspectId ? personName.get(r.personProspectId) === true : false;
    if (!named && personHasName) out.nameCoveredByPerson++;
    else if (!named) out.missingName++;
    if (badLinkedin(r.linkedinUrl)) out.badLinkedinUrl++;
    if (badSource(r.sourceUrl)) out.badSourceUrl++;
    if (!r.linkedinUrl || badLinkedin(r.linkedinUrl)) out.missingLinkedinUrl++;
    if (!r.personProspectId) out.unlinkedPerson++;
    const noIdentity = !named && !personHasName
      && !String(r.email ?? "").trim()
      && (!r.linkedinUrl || badLinkedin(r.linkedinUrl));
    if (noIdentity) { out.unreconcilable++; out.flaggedRowIds.push(r.id); }
  }
  const groups = duplicateGroups(live);
  out.duplicateGroups = groups.length;
  out.duplicateRows = groups.reduce((s, g) => s + g.length - 1, 0);
  out.crossCampaignGroups = groups.filter((g) => new Set(g.map((x) => x.campaignId)).size > 1).length;
  out.flaggedRowIds = out.flaggedRowIds.slice(0, 100);
  return out;
}

export interface ReconcileResult {
  scanned: number;
  linksScrubbed: number;
  personsLinked: number;
  personsCreated: number;
  requeuedForEnrichment: number;
  linkedinFound: number;
  linkedinSearched: number;
  /** Person-level LinkedIn retrieves queued — what actually fills names and
   *  profile photos on the campaign tab (capped by the existing daily cap). */
  profileRetrievesQueued: number;
  duplicatesSkipped: number;
  flaggedUnreconcilable: number;
  /** Edge cases a human should read — the "document what couldn't be fixed" half. */
  notes: string[];
}

export async function reconcileQueueProspects(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  /** LinkedIn people-searches this run may spend (bridged-account allowance). */
  linkedinSearchBudget?: number;
}): Promise<ReconcileResult> {
  const db = await getDb();
  const result: ReconcileResult = {
    scanned: 0, linksScrubbed: 0, personsLinked: 0, personsCreated: 0,
    requeuedForEnrichment: 0, linkedinFound: 0, linkedinSearched: 0,
    profileRetrievesQueued: 0, duplicatesSkipped: 0, flaggedUnreconcilable: 0, notes: [],
  };
  if (!db) return result;
  const { workspaceId } = opts;

  // ── 1. Scrub broken link fields (shape rules, same vocabulary as 0159) ──
  let rows = await loadRows(workspaceId);
  result.scanned = rows.filter((r) => r.sequenceStatus !== "skipped").length;
  for (const r of rows) {
    const patch: Record<string, unknown> = {};
    if (badLinkedin(r.linkedinUrl)) patch.linkedinUrl = null;
    if (badSource(r.sourceUrl)) patch.sourceUrl = null;
    if (Object.keys(patch).length > 0) {
      await db.update(prospectQueue).set(patch as never).where(eq(prospectQueue.id, r.id));
      result.linksScrubbed++;
    }
  }

  // ── 2. Every row gets its canonical person (the display + fix vehicle) ──
  const linked = await linkUnlinkedQueueRows({ workspaceId, limit: 2000 });
  result.personsLinked = linked.linked;
  result.personsCreated = linked.created;

  // ── 3. Names + missing LinkedIn URLs, through the person/enrichment ──
  rows = await loadRows(workspaceId);
  const live = () => rows.filter((r) => r.sequenceStatus !== "skipped");
  const personIds = Array.from(new Set(live().map((r) => r.personProspectId).filter((x): x is number => !!x)));
  const personById = new Map<number, { named: boolean; linkedinUrl: string | null }>();
  if (personIds.length > 0) {
    const people = await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, linkedinUrl: prospects.linkedinUrl })
      .from(prospects).where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, personIds)));
    for (const p of people) personById.set(p.id, { named: hasRealName(p), linkedinUrl: p.linkedinUrl });
  }

  let searchBudget = Math.max(0, opts.linkedinSearchBudget ?? 10);
  for (const r of live()) {
    const person = r.personProspectId ? personById.get(r.personProspectId) : undefined;
    const named = hasRealName(r) || person?.named === true;
    const li = (!badLinkedin(r.linkedinUrl) && r.linkedinUrl) || person?.linkedinUrl || null;

    if (!named && li) {
      // A profile URL exists — the capped LinkedIn retrieve fills the name on
      // the person; re-open the row so the engine works it.
      await db.update(prospectQueue).set({ enrichmentStatus: "pending", enrichedAt: null } as never)
        .where(eq(prospectQueue.id, r.id));
      result.requeuedForEnrichment++;
      continue;
    }

    if (named && !li && searchBudget > 0 && (r.companyName || r.companyDomain)) {
      // Confidence-gated discovery: exact normalized-name match AND the hit
      // must mention the company. Anything less stays missing — no guesses.
      searchBudget--;
      result.linkedinSearched++;
      const first = isPlaceholderToken(r.firstName) ? "" : (r.firstName ?? "");
      const last = isPlaceholderToken(r.lastName) ? "" : (r.lastName ?? "");
      const company = r.companyName ?? r.companyDomain ?? "";
      try {
        const res = await searchLinkedInProfiles({
          workspaceId, userId: opts.userId, isAdmin: opts.isAdmin,
          keywords: `${first} ${last} ${company}`.trim(), limit: 3,
        });
        if (!res.ok && res.hits.length === 0 && /bridged/i.test(res.message)) {
          // No bridged LinkedIn account in THIS workspace — every further
          // search would fail the same way. Say so ONCE, loudly: this was
          // silently swallowed on the first run and read as "found nothing".
          result.notes.push(`LinkedIn discovery unavailable: ${res.message}`);
          searchBudget = 0;
          continue;
        }
        if (res.ok) {
          const wantName = canonicalText(`${first} ${last}`);
          const companyToks = canonicalTokens(company);
          const hit = res.hits.find((h) => {
            const hay = canonicalTokens(`${h.headline} ${h.company}`);
            const companyMentioned = Array.from(companyToks).some((t) => t.length > 2 && hay.has(t));
            return h.linkedinUrl && canonicalText(h.name) === wantName && companyMentioned;
          });
          if (hit?.linkedinUrl) {
            await db.update(prospectQueue)
              .set({ linkedinUrl: hit.linkedinUrl, enrichmentStatus: "pending", enrichedAt: null } as never)
              .where(eq(prospectQueue.id, r.id));
            result.linkedinFound++;
          }
        }
      } catch (e) {
        result.notes.push(`row ${r.id}: LinkedIn search failed (${(e as Error).message.slice(0, 80)})`);
      }
      continue;
    }

    if (!named && !li && !String(r.email ?? "").trim()) {
      // Nothing to reconcile FROM: no name, no profile, no address. Flag to
      // the Rejections tab rather than deleting — visible and reversible.
      await db.update(prospectQueue).set({ sequenceStatus: "skipped" } as never)
        .where(eq(prospectQueue.id, r.id));
      result.flaggedUnreconcilable++;
      result.notes.push(`row ${r.id}: flagged — no name, no LinkedIn, no email (source: ${r.sourceUrl ?? "unknown"})`);
    }
  }

  // ── 3b. The VISIBLE fix: queue person-level LinkedIn retrieves ──
  // Names, profile photos and the LinkedIn chip on the campaign tab all
  // come from the linked person's enrichment. A row can carry a profile URL
  // for months while the person stays unnamed and photo-less because
  // nothing ever RAN the retrieve. Queue it here for every person that has
  // a URL but no enrichment yet (or still no real name) — the orchestrator
  // enforces the daily cap and 30-day freshness itself.
  {
    rows = await loadRows(workspaceId);
    const targets = new Map<number, true>();
    const liveRows = rows.filter((r) => r.sequenceStatus !== "skipped");
    const pids = Array.from(new Set(liveRows.map((r) => r.personProspectId).filter((x): x is number => !!x)));
    if (pids.length > 0) {
      const people = await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, linkedinUrl: prospects.linkedinUrl })
        .from(prospects).where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, pids)));
      const { prospectLinkedinEnrichments } = await import("../../../drizzle/schema");
      const enrichedRows = await db.select({ prospectId: prospectLinkedinEnrichments.prospectId })
        .from(prospectLinkedinEnrichments)
        .where(and(eq(prospectLinkedinEnrichments.workspaceId, workspaceId), inArray(prospectLinkedinEnrichments.prospectId, pids)));
      const enriched = new Set(enrichedRows.map((e) => e.prospectId));
      const rowLiByPerson = new Map<number, string | null>();
      for (const r of liveRows) {
        if (r.personProspectId && r.linkedinUrl && !badLinkedin(r.linkedinUrl)) rowLiByPerson.set(r.personProspectId, r.linkedinUrl);
      }
      for (const p of people) {
        const li = (p.linkedinUrl && !badLinkedin(p.linkedinUrl) && p.linkedinUrl) || rowLiByPerson.get(p.id) || null;
        if (li && (!hasRealName(p) || !enriched.has(p.id))) targets.set(p.id, true);
        if (targets.size >= 25) break;
      }
    }
    if (targets.size > 0) {
      try {
        const { runForProspects } = await import("../linkedinEnrichment/orchestrator");
        const handle = await runForProspects({
          workspaceId, userId: opts.userId, isAdmin: opts.isAdmin,
          prospectIds: Array.from(targets.keys()),
          triggerType: "manual_admin_run",
          options: { includeProfileImage: true },
        });
        result.profileRetrievesQueued = handle.total ?? targets.size;
      } catch (e) {
        result.notes.push(`LinkedIn profile retrieve unavailable in this workspace: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }

  // ── 4. Campaign exclusivity over HISTORY: keeper = most engagement ──
  rows = await loadRows(workspaceId);
  for (const group of duplicateGroups(rows.filter((r) => r.sequenceStatus !== "skipped"))) {
    const sorted = [...group].sort((a, b) =>
      (STATUS_RANK[b.sequenceStatus] ?? 0) - (STATUS_RANK[a.sequenceStatus] ?? 0) || a.id - b.id);
    const keeper = sorted[0]!;
    for (const loser of sorted.slice(1)) {
      await db.update(prospectQueue).set({ sequenceStatus: "skipped" } as never)
        .where(eq(prospectQueue.id, loser.id));
      result.duplicatesSkipped++;
      if ((STATUS_RANK[loser.sequenceStatus] ?? 0) >= STATUS_RANK.contacted!) {
        result.notes.push(`row ${loser.id} (campaign ${loser.campaignId}) was already ${loser.sequenceStatus} before being deduped against row ${keeper.id} (campaign ${keeper.campaignId}) — both campaigns have contacted this person historically.`);
      }
    }
  }

  result.notes = result.notes.slice(0, 100);
  return result;
}
