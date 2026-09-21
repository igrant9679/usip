/**
 * personMerge — the People-row MERGE the product did not have (2026-09-20).
 *
 * 🔴 WHY THIS EXISTS. `personContactDuplicates` classifies a pair as
 * `needs_merge` and then has nothing to offer: its own header said "there is
 * no People merge anywhere in the product, so a `needs_merge` row here stays
 * until a human edits it". Measured against production the same day, LSI Media
 * (workspace 2) carried 99 flagged pairs across 50 distinct email clusters —
 * 32 of them byte-identical twins from one import writing twice, 5 with more
 * than two rows, 13 where BOTH People rows already had a contact pointing at
 * them. Nothing in the UI could resolve one of them.
 *
 * ⚠️ THIS DELETES PRODUCTION ROWS. Everything below is shaped by that:
 *
 *  · READ FIRST. `planPersonMerge` computes the whole outcome and writes
 *    nothing — a test pins that its body contains no insert/update/delete. The
 *    caller sees the survivor, the losers, every field that would be filled
 *    and every reference that would move BEFORE anything happens.
 *  · THE CONFIRM MUST BE THE PLAN THE HUMAN SAW. `executePersonMerge` re-plans
 *    server-side, then ASSERTS the re-planned {survivorId, loserIds} equals the
 *    set the caller approved. Resolving the delete by email alone is how a row
 *    inserted between the preview and the confirm — or a contact link written
 *    by the repair section on the same page — silently changes which row dies
 *    (2026-09-20 review, defects 8 and 12).
 *  · REPOINT, THEN DELETE. Every table holding a People id moves to the
 *    survivor before the losers go, in that order, pinned by a test. A delete
 *    that ran first would orphan enrolments, drafts and history.
 *  · READ EVERYTHING, RECORD, THEN WRITE. The audit row is written BEFORE the
 *    first destructive statement, with a direct insert on this same db handle
 *    so a failure THROWS and the cluster is abandoned untouched. It used to go
 *    through `recordAudit`, whose body is one big `catch { console.warn }` — so
 *    the only surviving copy of the destroyed rows could fail to be written and
 *    the caller would still be told the merge succeeded (review defects 3/11).
 *  · NOTHING IS DELETED THAT IS NOT FIRST COPIED INTO THAT ROW. Rows the merge
 *    cannot repoint (a duplicate list membership, a second score for the same
 *    model, an enrichment row folded into another) go into `before.deleted` in
 *    full before they go.
 *
 * THE 18 COMPLEMENTARY CLUSTERS ARE WHY THE FIELD UNION EXISTS. Measured on
 * prod: rfrye@displayitinc.com rows 3491/3492 — one holds a phone and no city,
 * the other a city and no phone. NEITHER row is wrong. A merge that picks a
 * winner and drops the other loses the customer's data permanently, so the
 * survivor's blanks are filled from the losers and a non-blank survivor value
 * is never overwritten.
 */
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import { createHash } from "crypto";
import {
  activities,
  auditLog,
  calendarEvents,
  campaignProposals,
  campaignRoutingSuggestions,
  contactImportRows,
  contactImports,
  contacts,
  emailDrafts,
  emailReplies,
  enrollments,
  linkedinEnrichmentBatchRows,
  linkedinEnrichmentJobItems,
  meetings,
  priorityScoreResults,
  prospectFieldHistory,
  prospectLinkedinEnrichments,
  prospectLinkedinFieldChanges,
  prospectLinkedinFieldSnapshots,
  prospectQueue,
  prospectSearchResults,
  prospects,
  recordListMembers,
  scoreHistory,
  scoreResults,
  tasks,
  voiceCalls,
} from "../../drizzle/schema";
import type { getDb } from "../db";
import { usableEmailOrNull } from "@shared/fieldHygiene";
import { isGenericInboxEmail } from "@shared/genericEmail";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Row = Record<string, unknown> & { id: number };

/** How many duplicate EMAIL CLUSTERS one plan will reason about. Not a page
 *  size: past this the answer stops being "here is every duplicate" and starts
 *  being "here is what fitted", which is what `capped` reports. */
export const CLUSTER_CAP = 200;

/* ── Every table that holds a People (`prospects`) id ─────────────────────── */

export interface PersonRefDependent {
  key: string;
  table: MySqlTable;
  /** The column holding the PARENT table's own primary key. */
  column: AnyMySqlColumn;
  field: string;
  wsColumn: AnyMySqlColumn;
}

export interface PersonRefTable {
  /** `<schema export>.<column>` — the key the schema-derived completeness pin
   *  in personMerge.test.ts matches against drizzle/schema.ts. */
  key: string;
  table: MySqlTable;
  /** The column holding the People id. */
  column: AnyMySqlColumn;
  /** Drizzle property name for that column, for the `.set()` payload. */
  field: string;
  /** The tenant column, or null where the table has none — `contact_import_rows`
   *  is the one such table and it is scoped through `contact_imports` instead;
   *  every statement below spells that out at the statement. */
  wsColumn: AnyMySqlColumn | null;
  /** Primary key, used only by the unique-per-person path below. */
  idColumn: AnyMySqlColumn;
  /** True where a UNIQUE index makes (workspaceId, prospectId) one row per
   *  person, so a blind repoint is a duplicate-key error mid-merge. Those rows
   *  are COMBINED, never simply dropped — see `ENRICHMENT_UNION_SKIP`. */
  uniquePerPerson?: boolean;
  /** Columns on OTHER tables holding THIS table's primary key. When two of its
   *  rows collapse into one, these have to follow the surviving row or they are
   *  left naming a row the collapse just deleted. */
  dependents?: PersonRefDependent[];
}

/**
 * The fifteen reference COLUMNS, enumerated from drizzle/schema.ts and pinned
 * by `personMerge.test.ts` — a sixteenth added later FAILS that test rather
 * than silently orphaning rows onto a deleted person.
 *
 * 2026-09-20: three of these were missed by the first cut and found by review —
 * `prospectSearchResults.promotedProspectId` (a stranded row is never
 * re-promoted, so a vendor record the customer PAID for can never become a
 * person again), and both `linkedinEnrichmentBatchRows` columns (an operator
 * resolving the batch row later writes a paid-for LinkedIn dossier against the
 * deleted id, where no UI can ever show it).
 *
 * FOURTEEN OF THE FIFTEEN CARRY `workspaceId` (checked against the schema, not
 * assumed), and those repoints are scoped on the statement itself.
 *
 * ⚠️ `contact_import_rows` IS THE EXCEPTION: it has NO workspaceId column of
 * its own — it is a child of `contact_imports`, which does. Every statement
 * touching it is scoped through that parent with an inline `importId IN
 * (SELECT id FROM contact_imports WHERE workspaceId = ?)`, written out at the
 * statement rather than hoisted, so the tenant boundary is readable where the
 * write happens. Nothing in this file moves or deletes a row on id alone.
 */
export const PERSON_REF_TABLES: PersonRefTable[] = [
  { key: "contacts.personProspectId", table: contacts, column: contacts.personProspectId, field: "personProspectId", wsColumn: contacts.workspaceId, idColumn: contacts.id },
  { key: "enrollments.prospectId", table: enrollments, column: enrollments.prospectId, field: "prospectId", wsColumn: enrollments.workspaceId, idColumn: enrollments.id },
  { key: "emailDrafts.toProspectId", table: emailDrafts, column: emailDrafts.toProspectId, field: "toProspectId", wsColumn: emailDrafts.workspaceId, idColumn: emailDrafts.id },
  { key: "campaignRoutingSuggestions.prospectId", table: campaignRoutingSuggestions, column: campaignRoutingSuggestions.prospectId, field: "prospectId", wsColumn: campaignRoutingSuggestions.workspaceId, idColumn: campaignRoutingSuggestions.id },
  // No workspaceId column — scoped through contact_imports at every statement.
  { key: "contactImportRows.prospectId", table: contactImportRows, column: contactImportRows.prospectId, field: "prospectId", wsColumn: null, idColumn: contactImportRows.id },
  { key: "emailReplies.prospectId", table: emailReplies, column: emailReplies.prospectId, field: "prospectId", wsColumn: emailReplies.workspaceId, idColumn: emailReplies.id },
  { key: "prospectQueue.personProspectId", table: prospectQueue, column: prospectQueue.personProspectId, field: "personProspectId", wsColumn: prospectQueue.workspaceId, idColumn: prospectQueue.id },
  { key: "prospectFieldHistory.prospectId", table: prospectFieldHistory, column: prospectFieldHistory.prospectId, field: "prospectId", wsColumn: prospectFieldHistory.workspaceId, idColumn: prospectFieldHistory.id },
  // uq_ple_ws_prospect is UNIQUE on (workspaceId, prospectId): the cluster's
  // rows are field-unioned into one, and the three enrichment_id children below
  // follow the row that survives.
  {
    key: "prospectLinkedinEnrichments.prospectId",
    table: prospectLinkedinEnrichments,
    column: prospectLinkedinEnrichments.prospectId,
    field: "prospectId",
    wsColumn: prospectLinkedinEnrichments.workspaceId,
    idColumn: prospectLinkedinEnrichments.id,
    uniquePerPerson: true,
    dependents: [
      { key: "prospectLinkedinFieldSnapshots.enrichmentId", table: prospectLinkedinFieldSnapshots, column: prospectLinkedinFieldSnapshots.enrichmentId, field: "enrichmentId", wsColumn: prospectLinkedinFieldSnapshots.workspaceId },
      { key: "prospectLinkedinFieldChanges.enrichmentId", table: prospectLinkedinFieldChanges, column: prospectLinkedinFieldChanges.enrichmentId, field: "enrichmentId", wsColumn: prospectLinkedinFieldChanges.workspaceId },
      { key: "linkedinEnrichmentBatchRows.enrichmentId", table: linkedinEnrichmentBatchRows, column: linkedinEnrichmentBatchRows.enrichmentId, field: "enrichmentId", wsColumn: linkedinEnrichmentBatchRows.workspaceId },
    ],
  },
  { key: "prospectLinkedinFieldSnapshots.prospectId", table: prospectLinkedinFieldSnapshots, column: prospectLinkedinFieldSnapshots.prospectId, field: "prospectId", wsColumn: prospectLinkedinFieldSnapshots.workspaceId, idColumn: prospectLinkedinFieldSnapshots.id },
  { key: "prospectLinkedinFieldChanges.prospectId", table: prospectLinkedinFieldChanges, column: prospectLinkedinFieldChanges.prospectId, field: "prospectId", wsColumn: prospectLinkedinFieldChanges.workspaceId, idColumn: prospectLinkedinFieldChanges.id },
  { key: "linkedinEnrichmentJobItems.prospectId", table: linkedinEnrichmentJobItems, column: linkedinEnrichmentJobItems.prospectId, field: "prospectId", wsColumn: linkedinEnrichmentJobItems.workspaceId, idColumn: linkedinEnrichmentJobItems.id },
  { key: "linkedinEnrichmentBatchRows.providedProspectId", table: linkedinEnrichmentBatchRows, column: linkedinEnrichmentBatchRows.providedProspectId, field: "providedProspectId", wsColumn: linkedinEnrichmentBatchRows.workspaceId, idColumn: linkedinEnrichmentBatchRows.id },
  { key: "linkedinEnrichmentBatchRows.matchedProspectId", table: linkedinEnrichmentBatchRows, column: linkedinEnrichmentBatchRows.matchedProspectId, field: "matchedProspectId", wsColumn: linkedinEnrichmentBatchRows.workspaceId, idColumn: linkedinEnrichmentBatchRows.id },
  { key: "prospectSearchResults.promotedProspectId", table: prospectSearchResults, column: prospectSearchResults.promotedProspectId, field: "promotedProspectId", wsColumn: prospectSearchResults.workspaceId, idColumn: prospectSearchResults.id },
];

/* ── The POLYMORPHIC references — a type column plus an untyped id ─────────── */

export interface PersonPolyRefTable {
  /** `<schema export>.<id column>` — same key shape as PERSON_REF_TABLES. */
  key: string;
  table: MySqlTable;
  /** The column holding the People id — NOT a foreign key, and named for
   *  nothing in particular (`recordId`, `objectId`, `relatedId`). */
  column: AnyMySqlColumn;
  field: string;
  /** The discriminator, and the one value of it that means "a People row". */
  typeColumn: AnyMySqlColumn;
  typeValue: string;
  wsColumn: AnyMySqlColumn;
  idColumn: AnyMySqlColumn;
  /**
   * Drizzle property names that, together with the People id, must stay unique.
   * `null` = nothing constrains it, so every loser row is simply repointed.
   * `[]` = one row per person, full stop.
   */
  dedupeFields: string[] | null;
}

/**
 * 🔴 POLYMORPHIC REFERENCES ARE THE ONES A COLUMN-NAME SCAN CANNOT SEE, and
 * that is exactly how `record_list_members` was missed by the first cut: a
 * curated 400-name list holding (recordType='prospect', recordId=3491) simply
 * stops rendering that person when 3491 is deleted — `recordLists.members`
 * ends with `.filter((m) => m.record)`, so the row vanishes with no error and
 * no count change anybody can attribute (2026-09-20 review, defect 1).
 *
 * The same shape carries People ids in eight more places: the three scored
 * tables (objectType='person' — and scoring's own `fieldResolver` FALLS BACK to
 * `contacts` when the person id no longer resolves, so an orphan is not merely
 * lost, it is re-scored against a different human), and the five CRM-ish
 * timelines that a person can be the subject of.
 *
 * DE-DUP IS EXPLICIT because these tables have no unique index to lean on
 * (`record_list_members` has none at all; `score_results` and
 * `priority_score_results` DO, and a blind repoint there is a duplicate-key
 * error halfway through a destructive path). Rows dropped as duplicates are
 * captured in the audit `before` in full before they go.
 */
export const PERSON_POLY_REF_TABLES: PersonPolyRefTable[] = [
  { key: "recordListMembers.recordId", table: recordListMembers, column: recordListMembers.recordId, field: "recordId", typeColumn: recordListMembers.recordType, typeValue: "prospect", wsColumn: recordListMembers.workspaceId, idColumn: recordListMembers.id, dedupeFields: ["listId"] },
  // ix_sr_uniq is UNIQUE on (scoreModelId, objectType, objectId).
  { key: "scoreResults.objectId", table: scoreResults, column: scoreResults.objectId, field: "objectId", typeColumn: scoreResults.objectType, typeValue: "person", wsColumn: scoreResults.workspaceId, idColumn: scoreResults.id, dedupeFields: ["scoreModelId"] },
  // Append-only history: two rows for one person on one model are two real
  // events, so they all move.
  { key: "scoreHistory.objectId", table: scoreHistory, column: scoreHistory.objectId, field: "objectId", typeColumn: scoreHistory.objectType, typeValue: "person", wsColumn: scoreHistory.workspaceId, idColumn: scoreHistory.id, dedupeFields: null },
  // ix_psr_uniq is UNIQUE on (objectType, objectId, workspaceId) — one row per
  // person, so the survivor's own row wins and the losers' are dropped.
  { key: "priorityScoreResults.objectId", table: priorityScoreResults, column: priorityScoreResults.objectId, field: "objectId", typeColumn: priorityScoreResults.objectType, typeValue: "person", wsColumn: priorityScoreResults.workspaceId, idColumn: priorityScoreResults.id, dedupeFields: [] },
  { key: "tasks.relatedId", table: tasks, column: tasks.relatedId, field: "relatedId", typeColumn: tasks.relatedType, typeValue: "prospect", wsColumn: tasks.workspaceId, idColumn: tasks.id, dedupeFields: null },
  { key: "meetings.relatedId", table: meetings, column: meetings.relatedId, field: "relatedId", typeColumn: meetings.relatedType, typeValue: "prospect", wsColumn: meetings.workspaceId, idColumn: meetings.id, dedupeFields: null },
  { key: "activities.relatedId", table: activities, column: activities.relatedId, field: "relatedId", typeColumn: activities.relatedType, typeValue: "prospect", wsColumn: activities.workspaceId, idColumn: activities.id, dedupeFields: null },
  { key: "calendarEvents.relatedId", table: calendarEvents, column: calendarEvents.relatedId, field: "relatedId", typeColumn: calendarEvents.relatedType, typeValue: "prospect", wsColumn: calendarEvents.workspaceId, idColumn: calendarEvents.id, dedupeFields: null },
  { key: "voiceCalls.relatedId", table: voiceCalls, column: voiceCalls.relatedId, field: "relatedId", typeColumn: voiceCalls.relatedType, typeValue: "prospect", wsColumn: voiceCalls.workspaceId, idColumn: voiceCalls.id, dedupeFields: null },
];

/**
 * The polymorphic tables the merge deliberately does NOT touch, each with the
 * check a human actually did. The completeness pin requires every
 * recordType/objectType/relatedType table in the schema to be in
 * PERSON_POLY_REF_TABLES or here — "it is not in either list" is the state that
 * let five references ship unhandled, so it is no longer reachable.
 *
 * ⚠️ These reasons are claims about WRITERS, not about the schema. If you make
 * one of these columns able to hold a People id, move it to the list above.
 */
export const EXCLUDED_POLY_REFS: Record<string, string> = {
  "scoreModels.objectType": "no object id at all — the discriminator says what KIND of row the model scores, not which row.",
  "attachments.relatedId": "CRM records only: both callers (EntityDetail, RecordDrawer) pass a CrmEntityType — account | contact | lead | opportunity | customer.",
  "workflowRuns.relatedId": "fireRecordCreated/fireRecordUpdated type the entity as lead | contact | opportunity; the rest write 'task' or null.",
  "notifications.relatedId": "every writer names a FEATURE, not a person — are_campaign, prospect_queue, icp_profile, proposal, task, voice_call, email_reply, places_budget.",
  "recordFiles.relatedId": "graph.ts gates it on RELATED_TYPES = contact | lead | account | opportunity.",
};

/**
 * The thirteenth reference, which is NOT a column and so cannot be repointed
 * by an UPDATE: `campaign_proposals.prospectIds` is a JSON ARRAY of People ids
 * — "the exact set the proposal would absorb" (migration 0178). A merge that
 * ignored it would leave a pending proposal pointed at a deleted row and the
 * proposal would absorb a ghost, so it is rewritten element-wise in JS.
 */
export const PROPOSAL_JSON_REF = "campaignProposals.prospectIds";

/** Page size for the proposal scan, and the number of pages it will drain.
 *  2026-09-20: this used to be a bare `.limit(500)` with no `+1` and no flag,
 *  so proposal 501 kept a deleted id and NOTHING said so. It is keyset-drained
 *  now, and `proposalsCapped` refuses the merge rather than rewriting a prefix. */
export const PROPOSAL_SCAN_CAP = 500;
export const PROPOSAL_SCAN_PAGES = 20;

/** Bytes of `before` JSON one audit row will carry. Well under any sane
 *  max_allowed_packet: discovering that limit AFTER the delete is how the only
 *  copy of the destroyed rows fails to be written (review defect 11). */
export const AUDIT_PAYLOAD_BUDGET = 2_000_000;

/* ── Which prospect columns the union may fill ────────────────────────────── */

/**
 * Filled from a loser when the survivor's own value is blank.
 *
 * NOT ON THIS LIST, each for a reason a test re-checks against the schema:
 *  · `id`, `workspaceId` — identity and tenant; moving either is a different
 *    (and much worse) operation.
 *  · `createdAt`, `updatedAt` — the survivor's own provenance. Taking a
 *    loser's createdAt would rewrite when this person entered the product.
 *  · `cloduraPersonId` — UNIQUE. The union UPDATE runs while the losers still
 *    exist (they are deleted last, after the repoints), so copying a loser's
 *    value onto the survivor is a duplicate-key error mid-merge.
 */
export const MERGEABLE_FIELDS = [
  "catchAllEmail", "cloduraOrgId", "cloduraSyncedAt", "firstName", "lastName",
  "title", "seniority", "functionalArea", "linkedinUrl", "email", "phone",
  "city", "state", "country", "company", "companyDomain", "industry",
  "education", "emailStatus", "emailRevealedAt", "phoneRevealedAt",
  "emailVerifiedAt", "enrichmentData", "fieldProvenance", "linkedContactId",
  "linkedLeadId", "accountId", "globalOrganizationId", "companyMatchStatus",
  "confidenceScore", "confidenceTier", "verificationStatus",
  "verificationNotes", "sourceUrls", "linkedinUrlVerified", "lastEnrichedAt",
  "lastDiscoveryRunId", "profileImageUrl", "profileImageSource",
  "profileImageSourceUrl", "profileImageLastVerifiedAt", "profileImageStatus",
] as const;

/** Excluded from MERGEABLE_FIELDS on purpose, with the reason. The completeness
 *  pin requires every prospects column to be in one list or the other. */
export const NON_MERGEABLE_FIELDS: Record<string, string> = {
  id: "identity — the survivor keeps its own id, that is what surviving means.",
  workspaceId: "tenant column; a merge never crosses a workspace.",
  createdAt: "the survivor's own provenance — when this person entered the product.",
  updatedAt: "maintained by the column's onUpdateNow(), never copied.",
  cloduraPersonId: "UNIQUE index — the losers still exist when the union UPDATE runs, so copying their value is a duplicate-key error.",
};

/**
 * 🔴 COLUMNS THAT ONLY MEAN ANYTHING TOGETHER.
 *
 * `isBlankValue` treats a NOT-NULL-with-default column as answered, so a
 * survivor whose `profileImageStatus` holds its default 'unknown' is never
 * filled — and `profileImageUrl` (nullable) IS. The merge therefore used to
 * copy the loser's photo URL and leave the status at 'unknown', and
 * `resolveProspectProfileImage` returns `url: null` unless the status is
 * 'available': the photo disappeared from the product and the only row that
 * held a coherent (url, status) pair had just been deleted (review defect 9).
 *
 * So when the LEAD column is taken from a loser, the columns that describe it
 * come from that same loser. This is not an overwrite of a value the survivor
 * chose — it is refusing to describe one row's URL with another row's status.
 */
export const ATOMIC_FIELD_GROUPS: Array<{ lead: string; carry: string[] }> = [
  { lead: "profileImageUrl", carry: ["profileImageSource", "profileImageSourceUrl", "profileImageStatus", "profileImageLastVerifiedAt"] },
  { lead: "linkedinUrl", carry: ["linkedinUrlVerified"] },
];

/** Never unioned between two `prospect_linkedin_enrichments` rows: identity,
 *  tenant, the People id the collapse itself rewrites, and the timestamps. */
export const ENRICHMENT_UNION_SKIP = ["id", "workspaceId", "prospectId", "createdAt", "updatedAt"];

/**
 * Two rows disagreeing on one of these are not one human with two records;
 * they are two humans behind one address (a shared mailbox, a role account
 * that slipped the generic-inbox filter, a family domain). The merge refuses
 * rather than guessing which name is real.
 */
export const IDENTITY_FIELDS = ["lastName", "companyDomain"] as const;

/* ── Pure decisions (no DB, so the rules are unit-testable on their own) ──── */

/**
 * Blank means ABSENT, not falsy.
 *
 * `0` is a real `confidenceScore` and `false` is a real `linkedinUrlVerified`.
 * Treating either as a gap would let a loser's `true` overwrite a survivor's
 * deliberate `false` — an overwrite, which this merge never does. Where a
 * NOT-NULL default makes that rule lose data, ATOMIC_FIELD_GROUPS answers it.
 */
export function isBlankValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" ? value.trim() === "" : false;
}

export interface SurvivorCandidate {
  id: number;
  /** How many `contacts.personProspectId` rows point at this People row. */
  contactLinkCount: number;
}

export interface SurvivorChoice {
  survivorId: number;
  reason: "contact-linked" | "lowest-id";
  loserIds: number[];
}

/**
 * SURVIVOR RULE: prefer the row a contact already points at; if several rows
 * qualify, or none does, the LOWEST id wins.
 *
 * Deterministic on purpose, and deliberately NOT "most recently updated":
 * `prospects.updatedAt` carries `onUpdateNow()`, so every enrichment sweep and
 * every field mirror churns it. A survivor chosen that way would change
 * between the preview and the confirm — the plan a human approved would not be
 * the merge that ran.
 *
 * Contact-linked first because `contacts.personProspectId` is what the CRM,
 * promotion and the "Add existing" wizard already resolve through; keeping
 * that row keeps every existing link valid without a repoint.
 *
 * Deterministic is not the same as STABLE: the Link repair one section above on
 * Data Health writes `contacts.personProspectId`, so this answer CAN change
 * between a preview and a confirm. That is why executePersonMerge asserts the
 * approved ids rather than trusting this to agree with itself.
 */
export function pickSurvivor(rows: SurvivorCandidate[]): SurvivorChoice {
  const ordered = rows.slice().sort((a, b) => a.id - b.id);
  const linked = ordered.filter((r) => r.contactLinkCount > 0);
  const survivor = linked.length > 0 ? linked[0] : ordered[0];
  return {
    survivorId: survivor.id,
    reason: linked.length > 0 ? "contact-linked" : "lowest-id",
    loserIds: ordered.filter((r) => r.id !== survivor.id).map((r) => r.id),
  };
}

export interface PersonMergeFill {
  field: string;
  fromPersonId: number;
}

/**
 * FIELD UNION: the survivor keeps every non-blank value it already has; its
 * blanks are filled from the losers in ASCENDING ID ORDER (oldest row first,
 * matching the survivor rule's own tie-break), first non-blank wins.
 *
 * A non-blank survivor value is NEVER overwritten, with the one stated
 * exception of ATOMIC_FIELD_GROUPS: a column that only describes another
 * column travels with it.
 */
export function unionPersonFields(
  survivor: Record<string, unknown>,
  losers: Array<Record<string, unknown> & { id: number }>,
  fields: readonly string[] = MERGEABLE_FIELDS,
): { patch: Record<string, unknown>; filled: PersonMergeFill[] } {
  const ordered = losers.slice().sort((a, b) => a.id - b.id);
  const patch: Record<string, unknown> = {};
  const filled: PersonMergeFill[] = [];
  fields.forEach((field) => {
    if (!isBlankValue(survivor[field])) return;
    for (let i = 0; i < ordered.length; i++) {
      const candidate = ordered[i][field];
      if (isBlankValue(candidate)) continue;
      patch[field] = candidate;
      filled.push({ field, fromPersonId: ordered[i].id });
      return;
    }
  });

  ATOMIC_FIELD_GROUPS.forEach((group) => {
    if (fields.indexOf(group.lead) === -1) return;
    const taken = filled.filter((f) => f.field === group.lead)[0];
    // Survivor kept its own URL, so its own status is the one that describes it.
    if (!taken) return;
    const source = ordered.filter((r) => r.id === taken.fromPersonId)[0];
    if (!source) return;
    group.carry.forEach((field) => {
      if (fields.indexOf(field) === -1) return;
      const value = source[field];
      if (isBlankValue(value)) return;
      if (field in patch && patch[field] === value) return;
      patch[field] = value;
      for (let i = filled.length - 1; i >= 0; i--) if (filled[i].field === field) filled.splice(i, 1);
      filled.push({ field, fromPersonId: source.id });
    });
  });

  return { patch, filled };
}

/**
 * IDENTITY GUARD — returns the refusal reason, or null when the cluster is one
 * human. Blanks never conflict: a row that simply does not know its
 * `companyDomain` disagrees with nobody.
 */
export function identityConflict(
  rows: Array<Record<string, unknown> & { id: number }>,
  fields: readonly string[] = IDENTITY_FIELDS,
): string | null {
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const seen: string[] = [];
    rows.forEach((row) => {
      const v = row[field];
      if (isBlankValue(v)) return;
      const key = String(v).trim().toLowerCase();
      if (seen.indexOf(key) === -1) seen.push(key);
    });
    if (seen.length > 1) {
      return `rows disagree on ${field} (${seen.join(" vs ")}) — two different humans can share one mailbox, so this is not merged.`;
    }
  }
  return null;
}

/** Ascending-id set equality, used to hold the confirm to the approved plan. */
export function sameIdSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.slice().sort((p, q) => p - q);
  const y = b.slice().sort((p, q) => p - q);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Keep the audit row insertable. The `before` payload carries whole prospects
 * rows, `enrichmentData` / `sourceUrls` JSON blobs and every row the merge is
 * about to delete; a 4-row cluster of heavily enriched people can exceed
 * max_allowed_packet, and the insert failing is the one failure this design
 * cannot absorb. The largest values are replaced by a hash and a byte count —
 * deliberately, before the statement runs, and named in `trimmed` — rather than
 * discovered as an exception after the rows are gone.
 */
export function trimAuditPayload(
  payload: Record<string, unknown>,
  budget: number = AUDIT_PAYLOAD_BUDGET,
): { payload: Record<string, unknown>; trimmed: string[] } {
  const size = (v: unknown) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; } };
  if (size(payload) <= budget) return { payload, trimmed: [] };

  const candidates: Array<{ holder: Record<string, unknown>; key: string; label: string; bytes: number }> = [];
  const collect = (rows: unknown, label: string) => {
    if (!Array.isArray(rows)) return;
    rows.forEach((row) => {
      if (!row || typeof row !== "object") return;
      const holder = row as Record<string, unknown>;
      const id = holder.id;
      Object.keys(holder).forEach((key) => {
        const bytes = size(holder[key]);
        if (bytes > 1000) candidates.push({ holder, key, label: `${label}#${String(id)}.${key}`, bytes });
      });
    });
  };
  collect(payload.losers, "losers");
  const deleted = payload.deleted;
  if (Array.isArray(deleted)) {
    deleted.forEach((group) => {
      const g = group as { key?: string; rows?: unknown };
      collect(g?.rows, String(g?.key ?? "deleted"));
    });
  }

  const trimmed: string[] = [];
  candidates.sort((a, b) => b.bytes - a.bytes);
  for (let i = 0; i < candidates.length; i++) {
    if (size(payload) <= budget) break;
    const c = candidates[i];
    let hash = "unhashable";
    try { hash = createHash("sha256").update(JSON.stringify(c.holder[c.key]) ?? "").digest("hex"); } catch { /* keep the placeholder */ }
    c.holder[c.key] = { auditTrimmed: true, bytes: c.bytes, sha256: hash };
    trimmed.push(c.label);
  }
  return { payload, trimmed };
}

/* ── Plan ─────────────────────────────────────────────────────────────────── */

export interface PersonMergeRowSummary {
  id: number;
  name: string;
  email: string | null;
  /** Contacts whose `personProspectId` points here today. */
  contactLinkCount: number;
}

/**
 * What happens to the rows of one table.
 *  · `repoint` — the row moves to the survivor and keeps everything it has.
 *  · `combine` — one row per person is allowed, so the cluster's rows are
 *    field-unioned into the richest one and the emptied duplicates are deleted
 *    (their full content goes into the audit row first).
 *  · `dedupe`  — the row moves unless the survivor already holds an equivalent
 *    one, in which case the duplicate is deleted (again, recorded first).
 */
export type PersonRefMode = "repoint" | "combine" | "dedupe";

export interface PersonMergeRepoint {
  key: string;
  rows: number;
  mode: PersonRefMode;
}

export interface PersonMergeClusterPlan {
  email: string;
  survivorId: number;
  survivorReason: SurvivorChoice["reason"];
  loserIds: number[];
  rows: PersonMergeRowSummary[];
  fieldsFilled: PersonMergeFill[];
  repoints: PersonMergeRepoint[];
  repointTotal: number;
}

export interface PersonMergeSkippedCluster {
  email: string;
  ids: number[];
  reason: string;
}

export interface PersonMergePlan {
  workspaceId: number;
  /** Clusters the scan saw, before the identity guard. */
  clustersFound: number;
  /** True when the cluster scan hit CLUSTER_CAP — a zero from a bounded scan
   *  reads as an all-clear unless the bound is stated. */
  capped: boolean;
  /** True when the proposal drain hit its ceiling. Executing then would rewrite
   *  a PREFIX of the proposals and leave the rest naming deleted ids, so the
   *  executor refuses instead. */
  proposalsCapped: boolean;
  /** Clusters dropped because the shared address is a shared inbox. */
  skippedGeneric: number;
  merge: PersonMergeClusterPlan[];
  skipped: PersonMergeSkippedCluster[];
  /** How many People rows executing this plan would DELETE. */
  peopleDeleted: number;
}

export interface PersonMergeOptions {
  /** Restrict to these cluster emails. Omitted = plan every cluster found. */
  emails?: string[];
  /** Cap on clusters RETURNED in `merge`; the scan is always CLUSTER_CAP wide. */
  limit?: number;
}

const EMPTY_PLAN = (workspaceId: number): PersonMergePlan => ({
  workspaceId, clustersFound: 0, capped: false, proposalsCapped: false, skippedGeneric: 0,
  merge: [], skipped: [], peopleDeleted: 0,
});

function nameOf(first: unknown, last: unknown): string {
  return `${String(first ?? "")} ${String(last ?? "")}`.trim();
}

/**
 * What a merge WOULD do. Writes nothing — `personMerge.test.ts` pins that this
 * function's body window contains no `.insert(` / `.update(` / `.delete(`.
 *
 * A cluster is two or more People rows in ONE workspace sharing a usable,
 * non-generic email. Same definition as the detector in
 * personContactDuplicates.ts, through the same two helpers, so a pair reported
 * as `needs_merge` there is a cluster here — a merge that disagreed with the
 * detector about what a duplicate is would be a second matcher.
 */
export async function planPersonMerge(
  db: Db,
  workspaceId: number,
  opts: PersonMergeOptions = {},
): Promise<PersonMergePlan> {
  const wanted: string[] = [];
  (opts.emails ?? []).forEach((e) => {
    const key = usableEmailOrNull(e);
    if (key && wanted.indexOf(key) === -1) wanted.push(key);
  });
  if (opts.emails && wanted.length === 0) return EMPTY_PLAN(workspaceId);

  /*
   * Cluster scan. Plain GROUP BY on the raw `email` column, NOT
   * `LOWER(TRIM(...))`: `prospects.email` is varchar(320) in a utf8mb4 table
   * whose default collation is already case-insensitive and PAD SPACE, and
   * wrapping the column in a function is what stops `ix_pro_email` being
   * probed at all. getMetrics and personContactDuplicates group the same way.
   *
   * cap + 1 so `capped` is a fact rather than a guess.
   */
  const clusterRows = await db
    .select({ email: prospects.email, n: count() })
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      sql`${prospects.email} IS NOT NULL AND ${prospects.email} <> ''`,
      // Conservative shape prefilter — never excludes a row usableEmailOrNull
      // would accept, and keeps "<UNKNOWN>" out of the cap.
      sql`${prospects.email} LIKE '%@%.%'`,
      wanted.length > 0 ? inArray(prospects.email, wanted) : undefined,
    ))
    .groupBy(prospects.email)
    .having(sql`COUNT(*) > 1`)
    .orderBy(prospects.email)
    .limit(CLUSTER_CAP + 1);

  const capped = clusterRows.length > CLUSTER_CAP;
  let skippedGeneric = 0;
  const emails: string[] = [];
  clusterRows.slice(0, CLUSTER_CAP).forEach((r) => {
    const key = usableEmailOrNull(r.email);
    if (!key) return;
    // info@acme.com on four People rows is four humans, not one. Fusing them
    // is the single worst outcome this file can produce.
    if (isGenericInboxEmail(key)) { skippedGeneric++; return; }
    if (wanted.length > 0 && wanted.indexOf(key) === -1) return;
    if (emails.indexOf(key) === -1) emails.push(key);
  });
  if (emails.length === 0) return { ...EMPTY_PLAN(workspaceId), capped, skippedGeneric };

  const personRows = await db
    .select()
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.email, emails)))
    .orderBy(prospects.id);

  const byEmail = new Map<string, Row[]>();
  personRows.forEach((row) => {
    const key = usableEmailOrNull((row as Record<string, unknown>).email);
    if (!key) return;
    const bucket = byEmail.get(key);
    if (bucket) bucket.push(row as Row);
    else byEmail.set(key, [row as Row]);
  });

  const allIds = personRows.map((r) => (r as { id: number }).id);

  // The survivor rule keys on this, so it is read before anything is decided.
  const linkCount = new Map<number, number>();
  const linkRows = await db
    .select({ personId: contacts.personProspectId })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.personProspectId, allIds)));
  linkRows.forEach((r) => {
    if (r.personId == null) return;
    linkCount.set(r.personId, (linkCount.get(r.personId) ?? 0) + 1);
  });

  const merge: PersonMergeClusterPlan[] = [];
  const skipped: PersonMergeSkippedCluster[] = [];
  let clustersFound = 0;

  emails.forEach((email) => {
    const rows = byEmail.get(email) ?? [];
    if (rows.length < 2) return;
    clustersFound++;
    const ids = rows.map((r) => r.id);
    const conflict = identityConflict(rows);
    if (conflict) { skipped.push({ email, ids, reason: conflict }); return; }

    const choice = pickSurvivor(rows.map((r) => ({ id: r.id, contactLinkCount: linkCount.get(r.id) ?? 0 })));
    const survivor = rows.filter((r) => r.id === choice.survivorId)[0];
    const losers = rows.filter((r) => r.id !== choice.survivorId);
    const { filled } = unionPersonFields(survivor, losers);

    merge.push({
      email,
      survivorId: choice.survivorId,
      survivorReason: choice.reason,
      loserIds: choice.loserIds,
      rows: rows.map((r) => ({
        id: r.id,
        name: nameOf(r.firstName, r.lastName),
        email: (r.email as string | null) ?? null,
        contactLinkCount: linkCount.get(r.id) ?? 0,
      })),
      fieldsFilled: filled,
      repoints: [],
      repointTotal: 0,
    });
  });

  const loserIds: number[] = [];
  merge.forEach((c) => c.loserIds.forEach((id) => loserIds.push(id)));

  let proposalsCapped = false;
  if (loserIds.length > 0) {
    const ownerOf = new Map<number, PersonMergeClusterPlan>();
    merge.forEach((c) => c.loserIds.forEach((id) => ownerOf.set(id, c)));

    const attribute = (key: string, mode: PersonRefMode, pid: number, n: number) => {
      const owner = ownerOf.get(pid);
      if (!owner || n <= 0) return;
      const existing = owner.repoints.filter((x) => x.key === key && x.mode === mode)[0];
      if (existing) existing.rows += n;
      else owner.repoints.push({ key, rows: n, mode });
      owner.repointTotal += n;
    };

    for (let i = 0; i < PERSON_REF_TABLES.length; i++) {
      const ref = PERSON_REF_TABLES[i];
      const rows = await db
        .select({ personId: ref.column, n: count() })
        .from(ref.table)
        .where(and(
          ref.wsColumn
            ? eq(ref.wsColumn, workspaceId)
            // contact_import_rows has no tenant column of its own.
            : inArray(contactImportRows.importId, db.select({ id: contactImports.id }).from(contactImports).where(eq(contactImports.workspaceId, workspaceId))),
          inArray(ref.column, loserIds),
        ))
        .groupBy(ref.column);
      rows.forEach((r) => {
        attribute(
          ref.key,
          ref.uniquePerPerson ? "combine" : "repoint",
          Number((r as { personId: unknown }).personId),
          Number((r as { n: unknown }).n) || 0,
        );
      });
    }

    // The polymorphic ones, counted through the SAME attribution so the preview
    // names a saved list or a score exactly the way it names an enrolment.
    for (let i = 0; i < PERSON_POLY_REF_TABLES.length; i++) {
      const ref = PERSON_POLY_REF_TABLES[i];
      const rows = await db
        .select({ personId: ref.column, n: count() })
        .from(ref.table)
        .where(and(
          eq(ref.wsColumn, workspaceId),
          eq(ref.typeColumn, ref.typeValue),
          inArray(ref.column, loserIds),
        ))
        .groupBy(ref.column);
      rows.forEach((r) => {
        attribute(
          ref.key,
          ref.dedupeFields === null ? "repoint" : "dedupe",
          Number((r as { personId: unknown }).personId),
          Number((r as { n: unknown }).n) || 0,
        );
      });
    }

    // The JSON array reference — counted here so the preview names it, rewritten
    // element-wise by executePersonMerge.
    const proposals = await readProposalRefs(db, workspaceId);
    proposalsCapped = proposals.capped;
    proposals.rows.forEach((p) => {
      const touched = new Map<PersonMergeClusterPlan, boolean>();
      p.ids.forEach((id) => {
        const owner = ownerOf.get(id);
        if (owner) touched.set(owner, true);
      });
      Array.from(touched.keys()).forEach((owner) => {
        const existing = owner.repoints.filter((x) => x.key === PROPOSAL_JSON_REF)[0];
        if (existing) existing.rows += 1;
        else owner.repoints.push({ key: PROPOSAL_JSON_REF, rows: 1, mode: "repoint" });
        owner.repointTotal += 1;
      });
    });
  }

  const limited = merge.slice(0, opts.limit ?? CLUSTER_CAP);
  let peopleDeleted = 0;
  limited.forEach((c) => { peopleDeleted += c.loserIds.length; });
  return { workspaceId, clustersFound, capped, proposalsCapped, skippedGeneric, merge: limited, skipped, peopleDeleted };
}

/**
 * Pending/accepted proposals carrying a People-id array. Read-only, and
 * keyset-drained rather than truncated: `capped` is true only when the whole
 * ceiling (PROPOSAL_SCAN_PAGES × PROPOSAL_SCAN_CAP) is exhausted, and the
 * executor refuses the merge outright in that case. A bounded read that
 * silently returns a prefix leaves proposals naming deleted People ids.
 */
async function readProposalRefs(
  db: Db,
  workspaceId: number,
): Promise<{ rows: Array<{ id: number; ids: number[] }>; capped: boolean }> {
  const out: Array<{ id: number; ids: number[] }> = [];
  let after = 0;
  for (let page = 0; page < PROPOSAL_SCAN_PAGES; page++) {
    const rows = await db
      .select({ id: campaignProposals.id, prospectIds: campaignProposals.prospectIds })
      .from(campaignProposals)
      .where(and(
        eq(campaignProposals.workspaceId, workspaceId),
        sql`${campaignProposals.prospectIds} IS NOT NULL`,
        gt(campaignProposals.id, after),
      ))
      .orderBy(campaignProposals.id)
      .limit(PROPOSAL_SCAN_CAP);
    rows.forEach((r) => {
      const raw = r.prospectIds;
      after = Math.max(after, Number(r.id) || 0);
      if (!Array.isArray(raw)) return;
      const ids: number[] = [];
      raw.forEach((v) => { const n = Number(v); if (Number.isFinite(n)) ids.push(n); });
      if (ids.length > 0) out.push({ id: r.id, ids });
    });
    if (rows.length < PROPOSAL_SCAN_CAP) return { rows: out, capped: false };
  }
  return { rows: out, capped: true };
}

/* ── Execute ──────────────────────────────────────────────────────────────── */

/** One cluster exactly as the plan described it and a human approved it. */
export interface PersonMergeApprovedCluster {
  email: string;
  survivorId: number;
  loserIds: number[];
}

export interface PersonMergeExecuteOptions {
  /** The clusters to act on, echoed back from the plan. Required — see below. */
  clusters: PersonMergeApprovedCluster[];
  actorUserId: number | null;
}

export interface PersonMergeOutcome {
  email: string;
  survivorId: number;
  loserIds: number[];
  fieldsFilled: PersonMergeFill[];
  repoints: PersonMergeRepoint[];
  peopleDeleted: number;
  /** Columns the audit row could not carry in full, hashed instead. */
  auditTrimmed: string[];
}

export interface PersonMergeRefusal {
  email: string;
  reason: string;
}

export interface PersonMergeResult {
  merged: PersonMergeOutcome[];
  skipped: PersonMergeSkippedCluster[];
  /** Clusters that no longer match what the caller approved. Nothing was
   *  touched for these — the point of the check is that they are NOT merged. */
  stale: PersonMergeRefusal[];
  /** Clusters abandoned because the audit row could not be written. An
   *  irreversible operation with no record does not run. */
  unrecorded: PersonMergeRefusal[];
  peopleDeleted: number;
}

/**
 * Apply a plan.
 *
 * NO BARE "MERGE EVERYTHING". `opts.clusters` is required and non-empty, and
 * each entry carries the survivor and loser ids the human was SHOWN. The caller
 * has to re-derive and NAME what it is destroying; a button that merges whatever
 * the last scan happened to find is a button nobody can audit after the fact.
 *
 * The plan is recomputed HERE and then COMPARED with the approved ids. Both
 * halves matter: re-planning catches a field filled or a row deleted since the
 * preview, and the comparison catches the case re-planning alone creates — a
 * third row imported into the cluster, or a contact linked by the repair section
 * on the same page, quietly changing which row survives. A cluster that no
 * longer matches is returned as `stale` and nothing about it is touched.
 *
 * Order, pinned by a test: read everything → WRITE THE AUDIT ROW → fill the
 * survivor → repoint every reference → delete the losers. A delete before the
 * repoints would orphan every enrolment, draft and history row the losers carry;
 * an audit row after the delete can fail with the data already gone.
 */
export async function executePersonMerge(
  db: Db,
  workspaceId: number,
  opts: PersonMergeExecuteOptions,
): Promise<PersonMergeResult> {
  if (!opts.clusters || opts.clusters.length === 0) {
    throw new Error("executePersonMerge needs the clusters to merge, named explicitly.");
  }

  const stale: PersonMergeRefusal[] = [];
  const unrecorded: PersonMergeRefusal[] = [];
  const approved = new Map<string, PersonMergeApprovedCluster>();
  opts.clusters.forEach((c) => {
    const key = usableEmailOrNull(c.email);
    if (!key) { stale.push({ email: c.email, reason: "not a usable email address." }); return; }
    approved.set(key, { email: key, survivorId: c.survivorId, loserIds: c.loserIds.slice() });
  });
  const emails = Array.from(approved.keys());
  if (emails.length === 0) return { merged: [], skipped: [], stale, unrecorded, peopleDeleted: 0 };

  const plan = await planPersonMerge(db, workspaceId, { emails, limit: CLUSTER_CAP });
  const planned = new Map<string, PersonMergeClusterPlan>();
  plan.merge.forEach((c) => planned.set(c.email, c));

  emails.forEach((key) => {
    if (planned.has(key)) return;
    // Already reported with its own reason in `plan.skipped`; not a second entry.
    if (plan.skipped.filter((s) => s.email === key).length > 0) return;
    stale.push({ email: key, reason: "no longer a cluster — the duplicate rows are gone or the address changed." });
  });

  const merged: PersonMergeOutcome[] = [];
  let peopleDeleted = 0;

  for (let i = 0; i < plan.merge.length; i++) {
    const cluster = plan.merge[i];
    const want = approved.get(cluster.email);
    if (!want) continue;

    /* 0. THE APPROVED PLAN IS THE ONLY PLAN. */
    if (want.survivorId !== cluster.survivorId || !sameIdSet(want.loserIds, cluster.loserIds)) {
      stale.push({
        email: cluster.email,
        reason: `the rows changed since the preview — #${cluster.survivorId} now survives and ${cluster.loserIds.map((id) => `#${id}`).join(", ")} would be deleted; you approved #${want.survivorId} surviving and ${want.loserIds.map((id) => `#${id}`).join(", ")} deleted.`,
      });
      continue;
    }
    if (plan.proposalsCapped) {
      // Rewriting the first N proposals and leaving the rest naming deleted ids
      // is worse than not merging: the preview counted a bounded set too.
      stale.push({ email: cluster.email, reason: `more than ${PROPOSAL_SCAN_CAP * PROPOSAL_SCAN_PAGES} campaign proposals carry a People-id list, so the ids inside them cannot all be rewritten. Nothing was merged.` });
      continue;
    }

    const survivorId = cluster.survivorId;
    const loserIds = cluster.loserIds;
    if (loserIds.length === 0) continue;

    /* ═══ PHASE A — READ. Nothing below this line writes until the audit row
     *     is on disk, so every row this merge destroys is known and recorded
     *     before the first destructive statement. */

    const survivorRows = await db
      .select()
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, survivorId)));
    const loserRows = await db
      .select()
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, loserIds)))
      .orderBy(prospects.id);
    if (survivorRows.length === 0 || loserRows.length === 0) {
      stale.push({ email: cluster.email, reason: "the rows disappeared between the plan and the merge." });
      continue;
    }

    const union = unionPersonFields(
      survivorRows[0] as Record<string, unknown>,
      loserRows as Row[],
    );

    /** Rows this merge will DELETE rather than move, captured in full. */
    const destroyed: Array<{ key: string; rows: unknown[] }> = [];
    const record = (key: string, rows: unknown[]) => { if (rows.length > 0) destroyed.push({ key, rows }); };

    const repoints: PersonMergeRepoint[] = [];
    const bump = (key: string, n: number, mode: PersonRefMode) => {
      if (n <= 0) return;
      const existing = repoints.filter((x) => x.key === key && x.mode === mode)[0];
      if (existing) existing.rows += n;
      else repoints.push({ key, rows: n, mode });
    };

    /** Statements queued by phase A and run, in order, by phase C. */
    const writes: Array<() => Promise<unknown>> = [];

    for (let t = 0; t < PERSON_REF_TABLES.length; t++) {
      const ref = PERSON_REF_TABLES[t];
      if (ref.uniquePerPerson) {
        // Every unique-per-person table carries its own tenant column; the
        // parent-scoped exception (contact_import_rows) is not one of them.
        const wsCol = ref.wsColumn;
        if (!wsCol) throw new Error(`personMerge: ${ref.key} is unique-per-person but has no workspaceId column.`);
        /*
         * uq_ple_ws_prospect makes (workspaceId, prospectId) unique, so a blind
         * repoint of a loser's row onto a survivor that already has one is a
         * duplicate-key error halfway through a destructive path.
         *
         * 2026-09-20: this used to DELETE the losers' rows whenever the survivor
         * held one — destroying the full Unipile dossier (experience, education,
         * skills, about) whenever the survivor happened to carry an empty stub
         * from a `created_new` run, while the preview called it a repoint. The
         * rows are UNIONED now: the RICHEST row is kept (a stub never wins), its
         * blanks are filled from the others oldest-first, the three
         * enrichment_id children follow it, and the emptied duplicates are
         * recorded in the audit row before they go.
         */
        const held = (await db
          .select()
          .from(ref.table)
          .where(and(eq(wsCol, workspaceId), inArray(ref.column, loserIds.concat([survivorId]))))
          .orderBy(ref.idColumn)) as Row[];
        if (held.length === 0) continue;

        const density = (r: Row) => {
          let n = 0;
          Object.keys(r).forEach((k) => {
            if (ENRICHMENT_UNION_SKIP.indexOf(k) !== -1) return;
            if (!isBlankValue(r[k])) n++;
          });
          return n;
        };
        let keeper = held[0];
        held.forEach((r) => { if (density(r) > density(keeper)) keeper = r; });
        const others = held.filter((r) => r.id !== keeper.id);

        const fields = Object.keys(keeper).filter((k) => ENRICHMENT_UNION_SKIP.indexOf(k) === -1);
        const folded = unionPersonFields(keeper, others, fields);
        const patch: Record<string, unknown> = folded.patch;
        if (Number(keeper[ref.field]) !== survivorId) patch[ref.field] = survivorId;

        if (others.length > 0) {
          record(ref.key, others);
          const dropIds = others.map((r) => r.id);
          (ref.dependents ?? []).forEach((dep) => {
            writes.push(() => db
              .update(dep.table)
              .set({ [dep.field]: keeper.id } as never)
              .where(and(eq(dep.wsColumn, workspaceId), inArray(dep.column, dropIds))));
          });
          // The delete precedes the keeper's UPDATE and only this once: the
          // unique index will not hold two rows on the survivor's id at the
          // same instant. Everything it removes is already in `destroyed`.
          writes.push(() => db
            .delete(ref.table)
            .where(and(eq(wsCol, workspaceId), inArray(ref.idColumn, dropIds))));
        }
        if (Object.keys(patch).length > 0) {
          writes.push(() => db
            .update(ref.table)
            .set(patch as never)
            .where(and(eq(wsCol, workspaceId), eq(ref.idColumn, keeper.id))));
        }
        bump(ref.key, held.length, others.length > 0 ? "combine" : "repoint");
        continue;
      }
      /*
       * contacts.personProspectId is NOT special-cased on purpose: after this
       * runs, several contacts can point at the survivor. That is correct and
       * expected — 13 of LSI's 50 clusters already have two linked contacts —
       * and de-duplicating contacts is `dataHealth.mergeContacts`, a different
       * problem and not this merge's business.
       */
      const before = await db
        .select({ n: count() })
        .from(ref.table)
        .where(and(
          ref.wsColumn
            ? eq(ref.wsColumn, workspaceId)
            : inArray(contactImportRows.importId, db.select({ id: contactImports.id }).from(contactImports).where(eq(contactImports.workspaceId, workspaceId))),
          inArray(ref.column, loserIds),
        ));
      const n = Number((before[0] as { n: unknown } | undefined)?.n ?? 0);
      if (n > 0) {
        writes.push(() => db
          .update(ref.table)
          .set({ [ref.field]: survivorId } as never)
          .where(and(
            ref.wsColumn
              ? eq(ref.wsColumn, workspaceId)
              // contact_import_rows again: the tenant boundary is its parent
              // import, and it is spelled out here rather than assumed from
              // the count above — a prior SELECT protects no later statement.
              : inArray(contactImportRows.importId, db.select({ id: contactImports.id }).from(contactImports).where(eq(contactImports.workspaceId, workspaceId))),
            inArray(ref.column, loserIds),
          )));
        bump(ref.key, n, "repoint");
      }
    }

    /*
     * The polymorphic tables.
     *
     * Where nothing constrains them (an activity timeline, a call log) the rows
     * are COUNTED and repointed by predicate — a busy person can carry thousands
     * of activities and there is no reason to pull them through node to write
     * one id. Where a de-dup decision is needed they are read in full, because
     * the decision needs the rows AND because anything this drops has to be in
     * the audit payload before it is dropped; those tables are per-person small
     * (a place on a list, one score per model).
     */
    for (let t = 0; t < PERSON_POLY_REF_TABLES.length; t++) {
      const ref = PERSON_POLY_REF_TABLES[t];
      if (ref.dedupeFields === null) {
        const before = await db
          .select({ n: count() })
          .from(ref.table)
          .where(and(
            eq(ref.wsColumn, workspaceId),
            eq(ref.typeColumn, ref.typeValue),
            inArray(ref.column, loserIds),
          ));
        const n = Number((before[0] as { n: unknown } | undefined)?.n ?? 0);
        if (n > 0) {
          writes.push(() => db
            .update(ref.table)
            .set({ [ref.field]: survivorId } as never)
            // The discriminator is repeated at the statement: an id list alone
            // would move a CONTACT's row that happens to share the number.
            .where(and(
              eq(ref.wsColumn, workspaceId),
              eq(ref.typeColumn, ref.typeValue),
              inArray(ref.column, loserIds),
            )));
          bump(ref.key, n, "repoint");
        }
        continue;
      }
      const held = (await db
        .select()
        .from(ref.table)
        .where(and(
          eq(ref.wsColumn, workspaceId),
          eq(ref.typeColumn, ref.typeValue),
          inArray(ref.column, loserIds.concat([survivorId])),
        ))
        .orderBy(ref.idColumn)) as Row[];
      if (held.length === 0) continue;

      const loserHeld = held.filter((r) => Number(r[ref.field]) !== survivorId);
      if (loserHeld.length === 0) continue;

      // One row per (person, dedupe key) survives: the survivor's own if it has
      // one, otherwise the oldest loser row, and every other is a duplicate.
      const moveIds: number[] = [];
      const dropRows: Row[] = [];
      const fields = ref.dedupeFields;
      const groupKey = (r: Row) => fields.map((f) => String(r[f])).join("|");
      const survivorGroups: string[] = [];
      held.forEach((r) => { if (Number(r[ref.field]) === survivorId) survivorGroups.push(groupKey(r)); });
      const claimed: string[] = [];
      loserHeld.forEach((r) => {
        const g = groupKey(r);
        if (survivorGroups.indexOf(g) !== -1 || claimed.indexOf(g) !== -1) { dropRows.push(r); return; }
        claimed.push(g);
        moveIds.push(r.id);
      });

      if (dropRows.length > 0) {
        record(ref.key, dropRows);
        const dropIds = dropRows.map((r) => r.id);
        writes.push(() => db
          .delete(ref.table)
          .where(and(eq(ref.wsColumn, workspaceId), inArray(ref.idColumn, dropIds))));
      }
      if (moveIds.length > 0) {
        writes.push(() => db
          .update(ref.table)
          .set({ [ref.field]: survivorId } as never)
          .where(and(eq(ref.wsColumn, workspaceId), inArray(ref.idColumn, moveIds))));
      }
      bump(ref.key, moveIds.length, "repoint");
      bump(ref.key, dropRows.length, "dedupe");
    }

    // The JSON array reference. Rewritten element-wise because an UPDATE cannot
    // repoint one id inside a JSON list; de-duplicated because two cluster
    // members in one proposal collapse to one survivor.
    const proposals = await readProposalRefs(db, workspaceId);
    proposals.rows.forEach((proposal) => {
      if (proposal.ids.filter((id) => loserIds.indexOf(id) !== -1).length === 0) return;
      const next: number[] = [];
      proposal.ids.forEach((id) => {
        const mapped = loserIds.indexOf(id) !== -1 ? survivorId : id;
        if (next.indexOf(mapped) === -1) next.push(mapped);
      });
      writes.push(() => db
        .update(campaignProposals)
        .set({ prospectIds: next, size: next.length } as never)
        .where(and(eq(campaignProposals.workspaceId, workspaceId), eq(campaignProposals.id, proposal.id))));
      bump(PROPOSAL_JSON_REF, 1, "repoint");
    });

    /* ═══ PHASE B — THE RECORD, BEFORE ANYTHING IS DESTROYED.
     *
     * Inserted directly on THIS db handle rather than through `recordAudit`,
     * whose whole body is `try { … } catch (e) { console.warn }` and which opens
     * its own connection: a failure there is invisible, and the caller is still
     * told the merge succeeded. Here a failure throws, the cluster is abandoned
     * with every row still in place, and the caller is told which one. */
    const trimmedPayload = trimAuditPayload({
      email: cluster.email,
      losers: loserRows,
      deleted: destroyed,
    });
    try {
      await db.insert(auditLog).values({
        workspaceId,
        actorUserId: opts.actorUserId ?? null,
        action: "delete",
        entityType: "person_merge",
        entityId: survivorId,
        before: trimmedPayload.payload as never,
        after: {
          survivorId,
          losedIds: loserIds,
          survivorReason: cluster.survivorReason,
          fieldsFilled: union.filled,
          repoints,
          auditTrimmed: trimmedPayload.trimmed,
        } as never,
        ip: null,
        userAgent: null,
      });
    } catch (e) {
      unrecorded.push({
        email: cluster.email,
        reason: `the audit row could not be written (${(e as Error).message}), so nothing was deleted for this cluster.`,
      });
      continue;
    }

    /* ═══ PHASE C — WRITE. */

    // 1. FILL THE SURVIVOR'S BLANKS.
    if (Object.keys(union.patch).length > 0) {
      await db
        .update(prospects)
        .set(union.patch as never)
        .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, survivorId)));
    }

    // 2. REPOINT every reference, BEFORE any delete of a People row.
    for (let w = 0; w < writes.length; w++) await writes[w]();

    // 3. DELETE THE LOSERS — last, scoped by workspaceId AND by the explicit
    //    id list the caller approved and this plan re-confirmed. Never by
    //    email, which would take a row inserted between the plan and the delete.
    await db
      .delete(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, loserIds)));
    peopleDeleted += loserIds.length;

    merged.push({
      email: cluster.email,
      survivorId,
      loserIds,
      fieldsFilled: union.filled,
      repoints,
      peopleDeleted: loserIds.length,
      auditTrimmed: trimmedPayload.trimmed,
    });
  }

  return { merged, skipped: plan.skipped, stale, unrecorded, peopleDeleted };
}
