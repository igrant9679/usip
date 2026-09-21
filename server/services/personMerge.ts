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
 * 🔵 THE SECOND CLUSTER KEY (2026-09-20, same day, after the email pass ran).
 * The email pass merged 169 clusters in production. LSI Media still showed ~90
 * "duplicate people" it could not see, because the two rows carry DIFFERENT
 * addresses — the enrichment providers guessed two PATTERNS for one human:
 *
 *     bprestridge@allianceanimal.com  vs  blake.prestridge@allianceanimal.com
 *     tyler@richeymay.com             vs  tyler.house@richeymay.com
 *
 * All 90 groups share the SAME linkedinUrl and none disagrees on title. A
 * LinkedIn profile is a unique person identifier, so `by: "linkedin"` groups on
 * the normalised `/in/<slug>` instead of the address. Everything else — the
 * identity guard, the field union, the approved-ids assertion, the audit row,
 * the repoint-then-delete order — is the SAME code path. There is one merge.
 *
 * ⚠️ WHAT THE LINKEDIN PASS RISKS THAT THE EMAIL PASS DID NOT: merging two rows
 * with different addresses DISCARDS one of them, and the field union keeps the
 * SURVIVOR's address (a non-blank survivor value is never overwritten — though
 * an unmailable placeholder is not a value, see `FIELD_IS_BLANK`). So the
 * survivor rule takes email quality into account (see `pickSurvivor`), and every
 * address the merge drops is recorded — `discardedEmails` on the plan, on the
 * result and on the audit row.
 *
 * AND EVERY RULE ABOUT THE ADDRESS IS A RULE ABOUT ONE ADDRESS. The email pass
 * could treat `email`, `emailStatus`, `emailVerifiedAt` and `emailRevealedAt` as
 * four independent columns because every row in one of its clusters holds the
 * SAME address; here they differ by design, so the verdict columns travel with
 * the address they describe and never on their own (ATOMIC_FIELD_GROUPS' tied
 * group), a verdict with no address ranks below `invalid` rather than above
 * everything (`emailQualityRank`), and a slug that names nobody is not a cluster
 * key (`linkedinProfileKey`). Each of those was a way to lose a real address or
 * fuse real strangers, found by review before this pass ran. `prospects.catchAllEmail` is NOT a home for it:
 * that column means "the GENERIC inbox this person's address replaced" and the
 * People UI labels it "Catch-all (generic inbox)", so parking a personal
 * pattern-guess there would be a lie rendered in the product. No column is
 * invented either; the audit row is where the discarded address lives, and the
 * preview says so in those words.
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
import { isPlaceholderToken, usableEmailOrNull } from "@shared/fieldHygiene";
import { isGenericInboxEmail } from "@shared/genericEmail";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Row = Record<string, unknown> & { id: number };

/** How many duplicate EMAIL CLUSTERS one plan will reason about. Not a page
 *  size: past this the answer stops being "here is every duplicate" and starts
 *  being "here is what fitted", which is what `capped` reports. */
export const CLUSTER_CAP = 200;

/**
 * WHAT THE ROWS ARE GROUPED ON. "email" is the pass that ran in production on
 * 2026-09-20 and is the DEFAULT everywhere, so every caller written before the
 * LinkedIn key existed keeps its exact behaviour.
 */
export type PersonMergeBy = "email" | "linkedin";

/** Page size and page ceiling for the LinkedIn scan. Unlike the email pass the
 *  grouping CANNOT be a GROUP BY — the key is a normalised slug, and a
 *  `LOWER(...)`-shaped expression over a `text` column indexes nothing — so the
 *  candidate rows are keyset-drained (id + url only) and grouped in JS. Draining
 *  the whole ceiling sets `capped`, exactly like the cluster scan. */
export const LINKEDIN_SCAN_CAP = 2000;
export const LINKEDIN_SCAN_PAGES = 25;

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
export interface AtomicFieldGroup {
  lead: string;
  carry: string[];
  /**
   * 🔴 A TIED GROUP: the carry columns are a VERDICT ABOUT THE LEAD'S VALUE, so
   * they may only ever be filled from a row holding that same value, and the
   * inherited lead is chosen by `rank` rather than by age.
   *
   * 2026-09-20 review, defects 1/5: without this, `email` and the three columns
   * that describe it (`emailStatus`, `emailVerifiedAt`, `emailRevealedAt`) fill
   * INDEPENDENTLY. A LinkedIn-keyed survivor that keeps its OWN address — the
   * rows in that pass hold different ones by design — inherited the DELETED
   * row's verdict: an enrichment pattern guess stamped `valid` with a
   * verification timestamp (so comprehensivePass calls it proven and finalCheck
   * stops flagging it, and the address that was really verified is gone), or a
   * never-checked address stamped `invalid` (so it is unmailable and counted in
   * the Data Health tile). In EMAIL mode every row in the cluster holds the same
   * address, so `same` is true of every loser and that pass is unchanged.
   */
  tied?: {
    /** Is the loser's lead value the value the survivor will hold? */
    same: (kept: unknown, candidate: unknown) => boolean;
    /** Lower is better; which loser an inheriting survivor takes the lead from. */
    rank: (row: Record<string, unknown>) => number;
  };
}

export const ATOMIC_FIELD_GROUPS: AtomicFieldGroup[] = [
  { lead: "profileImageUrl", carry: ["profileImageSource", "profileImageSourceUrl", "profileImageStatus", "profileImageLastVerifiedAt"] },
  { lead: "linkedinUrl", carry: ["linkedinUrlVerified"] },
  {
    lead: "email",
    carry: ["emailStatus", "emailVerifiedAt", "emailRevealedAt"],
    tied: {
      same: (kept, candidate) => {
        const k = usableEmailOrNull(kept);
        return k !== null && k === usableEmailOrNull(candidate);
      },
      // A blank survivor address inherits the BEST-VERDICT loser's, not the
      // oldest one's — inheriting `bad@x.com` from #20 while `good@x.com` on
      // #30 is deleted is the outcome the quality tier exists to prevent.
      rank: (row) => emailQualityRank(row),
    },
  },
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

/**
 * 🔴 COLUMNS WHERE "PRESENT" IS NOT "USABLE" (2026-09-20 review, defect 3).
 *
 * `isBlankValue("<UNKNOWN>")` is false, so a survivor holding an unmailable
 * placeholder counted as "already has an address": it never inherited, and the
 * cluster's one real address was deleted with its row. That person is then
 * permanently unmailable AND unrepairable — `if (!prospect.email)` gates every
 * acquisition path and "<UNKNOWN>" is truthy, and the repair sweeper selects on
 * `email IS NULL OR email = ''`. The union uses the SAME definition of a real
 * address as `discardedEmailsFor` and the rest of the product: shared/fieldHygiene.
 *
 * In email mode nothing changes — a cluster key IS a usable address, so every
 * row in one holds one by construction.
 */
export const FIELD_IS_BLANK: Record<string, (value: unknown) => boolean> = {
  email: (value) => usableEmailOrNull(value) === null,
};

/** `isBlankValue`, except where a column has a stricter idea of "absent". */
export function isBlankField(field: string, value: unknown): boolean {
  const stricter = FIELD_IS_BLANK[field];
  return stricter ? stricter(value) : isBlankValue(value);
}

/**
 * 🔵 THE LINKEDIN CLUSTER KEY — the `/in/<slug>` a URL names, or null.
 *
 * Two rows whose urls differ only by protocol, `www.`/`uk.`, case, a trailing
 * slash or a tracking query (`?trk=`, `?originalSubdomain=`, `#experience`) are
 * ONE profile, so all of that is stripped before anything is grouped.
 *
 * ⚠️ NULL IS NOT A KEY. Most People rows have no LinkedIn url at all, and
 * grouping on "" would fuse every one of them into a single cluster and then
 * delete all but one — the worst outcome this file can produce, and the reason
 * `personMerge.test.ts` asserts a blank url never forms a cluster. A value that
 * is not a linkedin.com `/in/` profile (a company page, a Sales Navigator lead
 * url, "<UNKNOWN>", a bare word) is unusable in exactly the same way: it is not
 * evidence that two rows are one human, so it returns null too.
 *
 * 🔴 AND NEITHER IS A PLACEHOLDER SLUG (2026-09-20 review, defect 4). A /in/ url
 * is only evidence of ONE human if its slug names one. quickenrich.ts templates
 * whatever a provider returned into `https://www.linkedin.com/in/<value>` with
 * no hygiene at all, so a field holding "N/A", "unknown" or "null" is stored as
 * a profile url on EVERY row that provider touched — and `/in/N%2FA` normalises
 * to one key. Every one of those People rows would land in a single cluster of
 * unrelated humans, held back from a delete only by the identity guard, which
 * compares two fields that are routinely blank. This is the email pass's
 * generic-inbox guard (`isGenericInboxEmail` -> `skippedGeneric`) applied to the
 * slug, and it is reported the same way: `skippedPlaceholderProfiles`.
 */
export const LINKEDIN_SLUG = /^[a-z0-9][a-z0-9\-_%]{1,98}[a-z0-9]$/;

/** The `/in/` slug a url names, before the identity guard below. */
function linkedinProfileSlug(value: unknown): string | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  // The hash and the query are tracking, not identity — dropped first so a
  // slug is never read out of `?trk=public_profile`.
  const bare = s.split("#")[0].split("?")[0];
  const m = bare.match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*linkedin\.com\/in\/([^/]+)/);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* an invalid escape: keep the raw slug */ }
  slug = slug.trim().replace(/\/+$/, "");
  return slug || null;
}

/**
 * A slug that cannot identify one human: a placeholder token ("unknown", "n/a",
 * "null", "none", dashes — shared/fieldHygiene's one vocabulary), or a shape no
 * real public identifier has (too short, a dot, a space, a stray host).
 */
function isUnusableProfileSlug(slug: string): boolean {
  return isPlaceholderToken(slug) || !LINKEDIN_SLUG.test(slug);
}

export function linkedinProfileKey(value: unknown): string | null {
  const slug = linkedinProfileSlug(value);
  if (!slug || isUnusableProfileSlug(slug)) return null;
  return `linkedin.com/in/${slug}`;
}

/** True where a url DOES name a `/in/` profile but its slug names nobody — the
 *  rows the scan drops for the reason above, counted so the operator is told
 *  they exist rather than left wondering where they went. */
export function isPlaceholderProfileUrl(value: unknown): boolean {
  const slug = linkedinProfileSlug(value);
  return slug !== null && isUnusableProfileSlug(slug);
}

/**
 * Reoon's verdicts, worst LAST. Checked against production: `valid`,
 * `accept_all`, `risky`, `unknown` and `invalid` are what `prospects.email_status`
 * actually holds (the schema comment's verified/unverified/unavailable wording
 * is stale and empty in both workspaces; `verified` is mapped anyway rather than
 * silently ranked as "no verdict").
 *
 * ANYTHING UNRECOGNISED — including NULL, which is most rows — ranks with
 * `unknown`, NOT with `invalid`: never verified is not the same as verified bad,
 * and a merge that treated it as bad would start preferring the row whose
 * address someone had bothered to check as broken.
 */
export const EMAIL_STATUS_RANK: Record<string, number> = {
  valid: 0,
  verified: 0,
  accept_all: 1,
  "accept-all": 1,
  catch_all: 1,
  risky: 2,
  unknown: 2,
  invalid: 3,
};
/** Rank of one verdict; 2 ("no usable verdict") for anything unrecognised. */
export function emailStatusRank(status: unknown): number {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return 2;
  const known = EMAIL_STATUS_RANK[s];
  return known === undefined ? 2 : known;
}

/**
 * 🔴 A VERDICT WITH NO ADDRESS RANKS LAST (2026-09-20 review, defect 2).
 *
 * `emailStatus` and `email` are written independently (prospectImports.ts:246
 * writes both from a CSV), so a row can hold a stale or imported `valid` with a
 * NULL address. Ranking that row on its verdict alone let it WIN the quality
 * tier and be reported to the operator as "its address is the verified one" —
 * for a row with no address — while the row actually holding the cluster's
 * verified address was deleted. Nothing is worse here than having no address at
 * all, so `NO_ADDRESS_RANK` sorts below `invalid`.
 */
export const NO_ADDRESS_RANK = 4;

/** The quality tier's real comparator: a row's verdict, or NO_ADDRESS_RANK when
 *  the verdict describes nothing this product could send mail to. */
export function emailQualityRank(row: { email?: unknown; emailStatus?: unknown }): number {
  return usableEmailOrNull(row.email) === null ? NO_ADDRESS_RANK : emailStatusRank(row.emailStatus);
}

export interface SurvivorCandidate {
  id: number;
  /** How many `contacts.personProspectId` rows point at this People row. */
  contactLinkCount: number;
  /** Reoon's verdict on THIS row's address. Only consulted when the caller asks
   *  for it — see `useEmailQuality` below. */
  emailStatus?: string | null;
  /** The address that verdict is ABOUT. Required for the quality tier to mean
   *  anything: a verdict without one is not a better address, it is no address. */
  email?: string | null;
}

export interface SurvivorChoice {
  survivorId: number;
  reason: "contact-linked" | "email-quality" | "lowest-id";
  loserIds: number[];
}

/**
 * SURVIVOR RULE, in full and in order:
 *
 *   (a) a row a contact already points at (`contacts.personProspectId`);
 *   (b) then — only when `useEmailQuality` is on — a row whose `emailStatus` is
 *       `valid`;
 *   (c) then `accept_all`, then `risky` / `unknown` / no verdict at all, then
 *       `invalid`, and LAST of everything a row holding no usable address at
 *       all — a verdict is a fact about an address, and a row without one has
 *       nothing for the tier to prefer;
 *   (d) then the LOWEST id.
 *
 * 🔴 (a) BEATS (b), DELIBERATELY. A contact-linked row holding an INVALID
 * address survives over a non-linked row holding a valid one. The link is a
 * statement a human made about which record this person IS — the CRM, promotion
 * and the "Add existing" wizard all resolve through it — and breaking it
 * silently re-points a salesperson's account at a different row. The address is
 * the recoverable half: the valid one is listed in `discardedEmails`, shown in
 * the preview before the operator confirms, and written to the audit row. An
 * operator who wants it can paste it back in one edit; nobody can reconstruct
 * a broken contact link from a count.
 *
 * WHY (b) AND (c) ARE OPT-IN. In email mode every row in the cluster holds the
 * SAME address, so the verdicts are two opinions about one string: re-ordering
 * there could only churn which row dies, and that pass has already run against
 * production. In linkedin mode the rows hold DIFFERENT addresses and the merge
 * discards one, so which row survives decides which address the product keeps.
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
export function pickSurvivor(rows: SurvivorCandidate[], useEmailQuality = false): SurvivorChoice {
  const ordered = rows.slice().sort((a, b) => a.id - b.id);
  const linked = ordered.filter((r) => r.contactLinkCount > 0);
  const pool = linked.length > 0 ? linked : ordered;
  // Already ascending by id, so a STABLE sort on the verdict alone leaves the
  // lowest id winning every tie — step (d) with no second comparator to drift.
  let survivor = pool[0];
  if (useEmailQuality) {
    pool.forEach((r) => {
      if (emailQualityRank(r) < emailQualityRank(survivor)) survivor = r;
    });
  }
  // NO_ADDRESS_RANK is the worst rank there is, so a survivor holding no usable
  // address can never be "outranked" and never claims `email-quality` — which
  // the preview renders as "its address is the verified one".
  const outranked = useEmailQuality
    && pool.filter((r) => emailQualityRank(r) > emailQualityRank(survivor)).length > 0;
  return {
    survivorId: survivor.id,
    reason: linked.length > 0 ? "contact-linked" : outranked ? "email-quality" : "lowest-id",
    loserIds: ordered.filter((r) => r.id !== survivor.id).map((r) => r.id),
  };
}

/**
 * THE ADDRESSES THIS MERGE WILL DROP.
 *
 * The union keeps the survivor's own non-blank email and fills a blank one from
 * the oldest loser that has one — so in a LinkedIn-keyed cluster every OTHER
 * address in the cluster ceases to exist when the losers are deleted. Naming
 * them is the difference between "merged 90 duplicates" and "deleted 88
 * addresses nobody was shown".
 *
 * `keptEmail` is the address the survivor will HOLD AFTER the union, not the one
 * it holds now: a survivor whose email is blank inherits one, and that inherited
 * address is kept, not discarded. Empty in email mode, where every row in the
 * cluster holds the same address by construction.
 */
export function discardedEmailsFor(
  keptEmail: unknown,
  losers: Array<Record<string, unknown> & { id: number }>,
): string[] {
  const kept = usableEmailOrNull(keptEmail);
  const out: string[] = [];
  losers.slice().sort((a, b) => a.id - b.id).forEach((row) => {
    const addr = usableEmailOrNull(row.email);
    if (!addr || addr === kept) return;
    if (out.indexOf(addr) === -1) out.push(addr);
  });
  return out;
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
 * column travels with it — and for a TIED group it may travel ONLY with it,
 * never on its own from a row describing some other value.
 */
export function unionPersonFields(
  survivor: Record<string, unknown>,
  losers: Array<Record<string, unknown> & { id: number }>,
  fields: readonly string[] = MERGEABLE_FIELDS,
): { patch: Record<string, unknown>; filled: PersonMergeFill[] } {
  const ordered = losers.slice().sort((a, b) => a.id - b.id);
  const patch: Record<string, unknown> = {};
  const filled: PersonMergeFill[] = [];

  /**
   * The value the survivor will HOLD for one field after the union: its own
   * where it has one, otherwise the best candidate among the losers it is
   * allowed to take from. `from` is null when the value is the survivor's own.
   */
  const resolve = (
    field: string,
    allow?: (row: Record<string, unknown>) => boolean,
    rank?: (row: Record<string, unknown>) => number,
  ): { value: unknown; from: number | null } | null => {
    if (!isBlankField(field, survivor[field])) return { value: survivor[field], from: null };
    let best: { value: unknown; from: number } | null = null;
    let bestRank = Infinity;
    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      if (allow && !allow(row)) continue;
      const candidate = row[field];
      if (isBlankField(field, candidate)) continue;
      // Unranked fields take the OLDEST loser that has one, unchanged.
      if (!rank) return { value: candidate, from: row.id };
      const r = rank(row);
      // Strictly better only, and `ordered` is ascending, so an equal rank
      // leaves the lowest id holding it — the same tie-break as everywhere else.
      if (r < bestRank) { bestRank = r; best = { value: candidate, from: row.id }; }
    }
    return best;
  };

  /**
   * Which losers may describe the survivor's kept LEAD value, per carry column.
   * A verdict is a fact about ONE value: a row holding a different address has
   * nothing to say about the address this merge keeps, in either direction —
   * whether the survivor kept its own or inherited one.
   */
  const describes = new Map<string, (row: Record<string, unknown>) => boolean>();
  const leadRank = new Map<string, (row: Record<string, unknown>) => number>();
  ATOMIC_FIELD_GROUPS.forEach((group) => {
    const tied = group.tied;
    if (!tied || fields.indexOf(group.lead) === -1) return;
    leadRank.set(group.lead, tied.rank);
    const kept = resolve(group.lead, undefined, tied.rank);
    group.carry.forEach((field) => {
      describes.set(field, (row) => kept !== null && tied.same(kept.value, row[group.lead]));
    });
  });

  fields.forEach((field) => {
    if (!isBlankField(field, survivor[field])) return;
    const hit = resolve(field, describes.get(field), leadRank.get(field));
    if (!hit || hit.from === null) return;
    patch[field] = hit.value;
    filled.push({ field, fromPersonId: hit.from });
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
      if (isBlankField(field, value)) {
        /*
         * A TIED carry column is a verdict about the value the survivor now
         * HOLDS, so a source row with no verdict leaves it with none: keeping
         * the survivor's own `valid` would stamp it on the address it just
         * inherited — a verdict about the address it used to hold, or about no
         * address at all (2026-09-20 review, defects 1/5, same class).
         *
         * Tied groups ONLY: `profileImageStatus` is NOT NULL with a default, so
         * clearing a carry column is not a legal write for every group.
         */
        if (!group.tied) return;
        // Blank already, or filled just now from a row holding the SAME value —
        // which is a verdict about the right address, so it stays.
        if (isBlankField(field, survivor[field]) || field in patch) return;
        patch[field] = null;
        filled.push({ field, fromPersonId: source.id });
        return;
      }
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
  /** Reoon's verdict on this row's address — the preview shows it, because in
   *  linkedin mode it is half the reason one row survives and the other dies. */
  emailStatus: string | null;
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
  /** WHAT THESE ROWS SHARE: the address in email mode, the normalised
   *  `linkedin.com/in/<slug>` in linkedin mode. The cluster's identity, and the
   *  string the confirm echoes back. */
  key: string;
  by: PersonMergeBy;
  /** The shared address, or NULL in linkedin mode — where the whole point is
   *  that the rows carry DIFFERENT addresses, so there is no one address to
   *  name and pretending otherwise would name an arbitrary row's. */
  email: string | null;
  survivorId: number;
  survivorReason: SurvivorChoice["reason"];
  loserIds: number[];
  rows: PersonMergeRowSummary[];
  fieldsFilled: PersonMergeFill[];
  /** Addresses that exist today and will not after this merge. Empty in email
   *  mode; the reason the preview can say "also holds <addr>, which the merge
   *  will drop" in linkedin mode. */
  discardedEmails: string[];
  repoints: PersonMergeRepoint[];
  repointTotal: number;
}

export interface PersonMergeSkippedCluster {
  key: string;
  by: PersonMergeBy;
  email: string | null;
  ids: number[];
  reason: string;
}

export interface PersonMergePlan {
  workspaceId: number;
  /** What this plan grouped on. Echoed back so a UI showing two passes cannot
   *  render one pass's clusters under the other's explanation. */
  by: PersonMergeBy;
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
  /** ROWS (not clusters) dropped because their `/in/` slug is a placeholder or
   *  a shape no real profile has — `/in/N%2FA`, `/in/unknown`. The LinkedIn
   *  pass's answer to `skippedGeneric`: one such slug can be held by dozens of
   *  unrelated People rows, so it is named rather than silently absent. */
  skippedPlaceholderProfiles: number;
  merge: PersonMergeClusterPlan[];
  skipped: PersonMergeSkippedCluster[];
  /** How many People rows executing this plan would DELETE. */
  peopleDeleted: number;
}

export interface PersonMergeOptions {
  /** What to group on. DEFAULTS TO "email" — the pass that ran in production —
   *  so a caller written before the LinkedIn key existed is unchanged. */
  by?: PersonMergeBy;
  /** Restrict to these cluster emails. Omitted = plan every cluster found. */
  emails?: string[];
  /** Restrict to these cluster KEYS, in whichever mode is running. The general
   *  spelling of `emails`; in email mode the two mean the same thing. */
  keys?: string[];
  /** Cap on clusters RETURNED in `merge`; the scan is always CLUSTER_CAP wide. */
  limit?: number;
}

const EMPTY_PLAN = (workspaceId: number, by: PersonMergeBy = "email"): PersonMergePlan => ({
  workspaceId, by, clustersFound: 0, capped: false, proposalsCapped: false, skippedGeneric: 0,
  skippedPlaceholderProfiles: 0, merge: [], skipped: [], peopleDeleted: 0,
});

function nameOf(first: unknown, last: unknown): string {
  return `${String(first ?? "")} ${String(last ?? "")}`.trim();
}

/**
 * What a merge WOULD do. Writes nothing — `personMerge.test.ts` pins that this
 * function's body window contains no `.insert(` / `.update(` / `.delete(`.
 *
 * A cluster in EMAIL mode is two or more People rows in ONE workspace sharing a
 * usable, non-generic email. Same definition as the detector in
 * personContactDuplicates.ts, through the same two helpers, so a pair reported
 * as `needs_merge` there is a cluster here — a merge that disagreed with the
 * detector about what a duplicate is would be a second matcher.
 *
 * A cluster in LINKEDIN mode is two or more rows in ONE workspace whose
 * `linkedinUrl` normalises to the same `/in/<slug>`. Rows with no usable
 * profile url are not clustered at ALL — they are not "a cluster with an empty
 * key", they are simply absent.
 */
export async function planPersonMerge(
  db: Db,
  workspaceId: number,
  opts: PersonMergeOptions = {},
): Promise<PersonMergePlan> {
  const by: PersonMergeBy = opts.by ?? "email";
  const normalizeKey = by === "linkedin" ? linkedinProfileKey : usableEmailOrNull;

  // `keys` is the general spelling, `emails` the one every caller written
  // before 2026-09-20 uses. In email mode they mean the same thing.
  const restrictTo = opts.keys ?? opts.emails;
  const wanted: string[] = [];
  (restrictTo ?? []).forEach((e) => {
    const key = normalizeKey(e);
    if (key && wanted.indexOf(key) === -1) wanted.push(key);
  });
  if (restrictTo && wanted.length === 0) return EMPTY_PLAN(workspaceId, by);

  let capped = false;
  let skippedGeneric = 0;
  let skippedPlaceholderProfiles = 0;
  /** Cluster keys to plan, and the rows behind each. */
  const keys: string[] = [];
  const byKey = new Map<string, Row[]>();
  let personRows: Row[] = [];

  if (by === "linkedin") {
    /*
     * PROFILE SCAN. Not a GROUP BY: the key is a normalised slug, so two rows
     * that differ by `www.`, by case or by a `?trk=` tracking parameter are one
     * profile and no expression over the raw `text` column would group them (or
     * use an index if it tried). The candidates are keyset-drained id + url
     * only, grouped here, and `capped` says when the ceiling was reached.
     */
    const scan = await readLinkedinProfileKeys(db, workspaceId);
    capped = scan.capped;
    skippedPlaceholderProfiles = scan.placeholders;

    const idsByKey = new Map<string, number[]>();
    scan.rows.forEach((r) => {
      if (wanted.length > 0 && wanted.indexOf(r.key) === -1) return;
      const bucket = idsByKey.get(r.key);
      if (bucket) bucket.push(r.id);
      else idsByKey.set(r.key, [r.id]);
    });
    const multi = Array.from(idsByKey.keys())
      .filter((k) => (idsByKey.get(k) ?? []).length > 1)
      .sort();
    if (multi.length > CLUSTER_CAP) capped = true;
    multi.slice(0, CLUSTER_CAP).forEach((k) => keys.push(k));

    const clusterIds: number[] = [];
    keys.forEach((k) => (idsByKey.get(k) ?? []).forEach((id) => clusterIds.push(id)));
    if (clusterIds.length === 0) return { ...EMPTY_PLAN(workspaceId, by), capped, skippedPlaceholderProfiles };

    personRows = (await db
      .select()
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, clusterIds)))
      .orderBy(prospects.id)) as Row[];
    personRows.forEach((row) => {
      const key = linkedinProfileKey(row.linkedinUrl);
      // A null key never reaches a bucket: see linkedinProfileKey's header.
      if (!key || keys.indexOf(key) === -1) return;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    });
  } else {
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

  capped = clusterRows.length > CLUSTER_CAP;
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
  if (emails.length === 0) return { ...EMPTY_PLAN(workspaceId, by), capped, skippedGeneric };
  emails.forEach((e) => keys.push(e));

  personRows = (await db
    .select()
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.email, emails)))
    .orderBy(prospects.id)) as Row[];

  personRows.forEach((row) => {
    const key = usableEmailOrNull((row as Record<string, unknown>).email);
    if (!key) return;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row as Row);
    else byKey.set(key, [row as Row]);
  });
  }

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

  keys.forEach((key) => {
    const rows = byKey.get(key) ?? [];
    if (rows.length < 2) return;
    clustersFound++;
    const ids = rows.map((r) => r.id);
    // A shared LinkedIn profile is strong evidence, but the guard is cheap and
    // the posture is refuse-rather-than-guess: it applies in BOTH modes.
    const conflict = identityConflict(rows);
    if (conflict) { skipped.push({ key, by, email: by === "email" ? key : null, ids, reason: conflict }); return; }

    const choice = pickSurvivor(
      rows.map((r) => ({
        id: r.id,
        contactLinkCount: linkCount.get(r.id) ?? 0,
        emailStatus: (r.emailStatus as string | null) ?? null,
        // The address the verdict is about travels with it: a `valid` on a row
        // with no address is not a better address (review defect 2).
        email: (r.email as string | null) ?? null,
      })),
      // Email quality only orders rows that hold DIFFERENT addresses — see
      // pickSurvivor's header for why the email pass must not use it.
      by === "linkedin",
    );
    const survivor = rows.filter((r) => r.id === choice.survivorId)[0];
    const losers = rows.filter((r) => r.id !== choice.survivorId);
    const { patch, filled } = unionPersonFields(survivor, losers);
    // isBlankField, not isBlankValue: a survivor holding "<UNKNOWN>" inherits a
    // real address, so the address it KEEPS is the inherited one.
    const keptEmail = isBlankField("email", survivor.email) ? patch.email : survivor.email;

    merge.push({
      key,
      by,
      email: by === "email" ? key : null,
      survivorId: choice.survivorId,
      survivorReason: choice.reason,
      loserIds: choice.loserIds,
      rows: rows.map((r) => ({
        id: r.id,
        name: nameOf(r.firstName, r.lastName),
        email: (r.email as string | null) ?? null,
        emailStatus: (r.emailStatus as string | null) ?? null,
        contactLinkCount: linkCount.get(r.id) ?? 0,
      })),
      fieldsFilled: filled,
      discardedEmails: discardedEmailsFor(keptEmail, losers),
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
  return { workspaceId, by, clustersFound, capped, proposalsCapped, skippedGeneric, skippedPlaceholderProfiles, merge: limited, skipped, peopleDeleted };
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

/**
 * Every People row in this workspace that names a usable LinkedIn profile, as
 * (id, normalised key). Read-only, keyset-drained by id exactly like the
 * proposal scan, and it selects TWO COLUMNS — a workspace with 6,004 People
 * rows is not a reason to pull 6,004 full prospects rows through node to group
 * them.
 *
 * ⚠️ A ROW WITH NO USABLE KEY IS DROPPED HERE, not carried with an empty key:
 * grouping on "" would put every person without a LinkedIn url in one cluster.
 * The SQL prefilter is deliberately conservative — it never excludes a url
 * `linkedinProfileKey` would accept, and the JS is what actually decides.
 *
 * `placeholders` counts the rows dropped for holding a /in/ url whose SLUG is a
 * placeholder — the rows that would otherwise have fused into one cluster of
 * strangers. Reported to the operator the way `skippedGeneric` is.
 */
async function readLinkedinProfileKeys(
  db: Db,
  workspaceId: number,
): Promise<{ rows: Array<{ id: number; key: string }>; capped: boolean; placeholders: number }> {
  const out: Array<{ id: number; key: string }> = [];
  let placeholders = 0;
  let after = 0;
  for (let page = 0; page < LINKEDIN_SCAN_PAGES; page++) {
    const rows = await db
      .select({ id: prospects.id, linkedinUrl: prospects.linkedinUrl })
      .from(prospects)
      .where(and(
        eq(prospects.workspaceId, workspaceId),
        sql`${prospects.linkedinUrl} IS NOT NULL AND ${prospects.linkedinUrl} <> ''`,
        // Only a /in/ profile url can produce a key, so nothing else is read.
        sql`${prospects.linkedinUrl} LIKE '%/in/%'`,
        gt(prospects.id, after),
      ))
      .orderBy(prospects.id)
      .limit(LINKEDIN_SCAN_CAP);
    rows.forEach((r) => {
      after = Math.max(after, Number(r.id) || 0);
      const key = linkedinProfileKey(r.linkedinUrl);
      if (key) { out.push({ id: Number(r.id), key }); return; }
      if (isPlaceholderProfileUrl(r.linkedinUrl)) placeholders++;
    });
    if (rows.length < LINKEDIN_SCAN_CAP) return { rows: out, capped: false, placeholders };
  }
  return { rows: out, capped: true, placeholders };
}

/* ── Execute ──────────────────────────────────────────────────────────────── */

/** One cluster exactly as the plan described it and a human approved it. */
export interface PersonMergeApprovedCluster {
  /** The cluster key the plan showed. `email` is the spelling every caller
   *  written before the LinkedIn key existed uses, and in email mode the two
   *  are the same string; `key` is the general one and is what a linkedin-mode
   *  caller sends. Exactly one of them has to be there. */
  key?: string;
  email?: string;
  survivorId: number;
  loserIds: number[];
}

export interface PersonMergeExecuteOptions {
  /** What the approved clusters were grouped on. DEFAULTS TO "email". */
  by?: PersonMergeBy;
  /** The clusters to act on, echoed back from the plan. Required — see below. */
  clusters: PersonMergeApprovedCluster[];
  actorUserId: number | null;
}

export interface PersonMergeOutcome {
  key: string;
  by: PersonMergeBy;
  /** The shared address, or null in linkedin mode. */
  email: string | null;
  survivorId: number;
  loserIds: number[];
  fieldsFilled: PersonMergeFill[];
  /** Addresses that existed on the deleted rows and do not survive this merge.
   *  They live on in the audit row and nowhere else — see the file header. */
  discardedEmails: string[];
  repoints: PersonMergeRepoint[];
  peopleDeleted: number;
  /** Columns the audit row could not carry in full, hashed instead. */
  auditTrimmed: string[];
}

export interface PersonMergeRefusal {
  key: string;
  email: string | null;
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

  const by: PersonMergeBy = opts.by ?? "email";
  const normalizeKey = by === "linkedin" ? linkedinProfileKey : usableEmailOrNull;

  const stale: PersonMergeRefusal[] = [];
  const unrecorded: PersonMergeRefusal[] = [];
  const approved = new Map<string, PersonMergeApprovedCluster>();
  opts.clusters.forEach((c) => {
    const given = c.key ?? c.email ?? "";
    const key = normalizeKey(given);
    if (!key) {
      stale.push({
        key: given,
        email: by === "email" ? (c.email ?? null) : null,
        reason: by === "linkedin" ? "not a usable LinkedIn profile url." : "not a usable email address.",
      });
      return;
    }
    approved.set(key, { key, email: by === "email" ? key : undefined, survivorId: c.survivorId, loserIds: c.loserIds.slice() });
  });
  const wantedKeys = Array.from(approved.keys());
  if (wantedKeys.length === 0) return { merged: [], skipped: [], stale, unrecorded, peopleDeleted: 0 };

  const plan = await planPersonMerge(db, workspaceId, { by, keys: wantedKeys, limit: CLUSTER_CAP });
  const planned = new Map<string, PersonMergeClusterPlan>();
  plan.merge.forEach((c) => planned.set(c.key, c));

  wantedKeys.forEach((key) => {
    if (planned.has(key)) return;
    // Already reported with its own reason in `plan.skipped`; not a second entry.
    if (plan.skipped.filter((s) => s.key === key).length > 0) return;
    stale.push({
      key,
      email: by === "email" ? key : null,
      reason: by === "linkedin"
        ? "no longer a cluster — the duplicate rows are gone or the LinkedIn url changed."
        : "no longer a cluster — the duplicate rows are gone or the address changed.",
    });
  });

  const merged: PersonMergeOutcome[] = [];
  let peopleDeleted = 0;

  for (let i = 0; i < plan.merge.length; i++) {
    const cluster = plan.merge[i];
    const want = approved.get(cluster.key);
    if (!want) continue;

    /* 0. THE APPROVED PLAN IS THE ONLY PLAN. */
    if (want.survivorId !== cluster.survivorId || !sameIdSet(want.loserIds, cluster.loserIds)) {
      stale.push({
        key: cluster.key,
        email: cluster.email,
        reason: `the rows changed since the preview — #${cluster.survivorId} now survives and ${cluster.loserIds.map((id) => `#${id}`).join(", ")} would be deleted; you approved #${want.survivorId} surviving and ${want.loserIds.map((id) => `#${id}`).join(", ")} deleted.`,
      });
      continue;
    }
    if (plan.proposalsCapped) {
      // Rewriting the first N proposals and leaving the rest naming deleted ids
      // is worse than not merging: the preview counted a bounded set too.
      stale.push({ key: cluster.key, email: cluster.email, reason: `more than ${PROPOSAL_SCAN_CAP * PROPOSAL_SCAN_PAGES} campaign proposals carry a People-id list, so the ids inside them cannot all be rewritten. Nothing was merged.` });
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
      stale.push({ key: cluster.key, email: cluster.email, reason: "the rows disappeared between the plan and the merge." });
      continue;
    }

    const union = unionPersonFields(
      survivorRows[0] as Record<string, unknown>,
      loserRows as Row[],
    );

    /*
     * THE ADDRESSES THIS MERGE DESTROYS, computed from the rows as they are NOW
     * rather than copied from the preview — the preview is a claim, these rows
     * are the fact. Empty in email mode. In linkedin mode this is the only
     * record that `bprestridge@allianceanimal.com` ever existed once its row is
     * gone, so it is written into the audit payload below, BEFORE the delete.
     */
    const survivorEmailAfter = isBlankField("email", (survivorRows[0] as Record<string, unknown>).email)
      ? union.patch.email
      : (survivorRows[0] as Record<string, unknown>).email;
    const discardedEmails = discardedEmailsFor(survivorEmailAfter, loserRows as Row[]);

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
      key: cluster.key,
      by: cluster.by,
      email: cluster.email,
      losers: loserRows,
      deleted: destroyed,
      // The addresses that cease to exist with these rows. The whole loser rows
      // are above this line too, but only if they fit the payload budget — this
      // list is small, never trimmed, and is what an operator greps for.
      discardedEmails,
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
          discardedEmails,
          repoints,
          auditTrimmed: trimmedPayload.trimmed,
        } as never,
        ip: null,
        userAgent: null,
      });
    } catch (e) {
      unrecorded.push({
        key: cluster.key,
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
      key: cluster.key,
      by: cluster.by,
      email: cluster.email,
      survivorId,
      loserIds,
      fieldsFilled: union.filled,
      discardedEmails,
      repoints,
      peopleDeleted: loserIds.length,
      auditTrimmed: trimmedPayload.trimmed,
    });
  }

  return { merged, skipped: plan.skipped, stale, unrecorded, peopleDeleted };
}
