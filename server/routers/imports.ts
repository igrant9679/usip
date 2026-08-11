import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import {
  accounts,
  contactImports,
  contactImportRows,
  contacts,
  prospects,
} from "../../drizzle/schema";
import { parseCSVText } from "../services/csv";
import { canonicalizeCompanyDisplayName, cleanPlaceholder, normalizeJobTitle } from "../services/enrichment/recordNormalize";
import { stripNameCredentials } from "../services/enrichment/personName";
import { buildCompanyCanonicalizer } from "../services/enrichment/companyCanonical";
import { normalizedAccountFields } from "../services/company/normalize";
import {
  CONTACT_IMPORT_FIELDS,
  describeDuplicateMappings,
  findDuplicateFieldMappings,
  missingRequiredMappings,
  requiredFieldKeysFor,
} from "@shared/importFields";

/* ─── Field definitions ─────────────────────────────────────────────────── */

/**
 * One list, shared with the mapping UI — see shared/importFields.ts. This file
 * used to declare its own 14 fields while ImportContacts.tsx declared 13 under a
 * comment claiming it mirrored them. The extra one was `tags`, which nothing
 * writes: `contacts` has no tags column, so a mapping to it was accepted and
 * silently discarded.
 */
export const SYSTEM_FIELDS = CONTACT_IMPORT_FIELDS;

export type SystemFieldKey = string;

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  if (!phone) return true; // optional
  return /^[\d\s\+\-\(\)\.]{7,20}$/.test(phone);
}

function mapRowToContact(
  row: Record<string, string>,
  mapping: Record<string, string | null>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [csvCol, sysField] of Object.entries(mapping)) {
    if (sysField && row[csvCol] !== undefined) {
      result[sysField] = row[csvCol];
    }
  }
  // Normalization + QC before anything downstream sees the row — the same
  // rules every enrichment source gets in fieldMerge: placeholder junk
  // ("N/A", "-") becomes empty, names lose vendor credential suffixes,
  // titles and company names get their representation repaired. Workspace
  // company-spelling convergence happens once per import in the procedures
  // (buildCompanyCanonicalizer), not per row here.
  for (const k of Object.keys(result)) {
    result[k] = cleanPlaceholder(result[k]) ?? "";
  }
  if (result.firstName) result.firstName = stripNameCredentials(result.firstName) ?? result.firstName;
  if (result.lastName) result.lastName = stripNameCredentials(result.lastName) ?? result.lastName;
  if (result.title) result.title = normalizeJobTitle(result.title) ?? "";
  if (result.company) result.company = canonicalizeCompanyDisplayName(result.company) ?? "";
  return result;
}

/**
 * Refuse a mapping where two columns claim one field.
 *
 * The loop above has no merge step — the LAST column assigned to a field wins
 * and the other's data is discarded with no error anywhere in the summary. That
 * is not hypothetical: the client's old similarity matcher mapped both `Email`
 * and `Email Status` onto `email`, and on a verified-email export the status
 * verdict ("valid" / "unknown") overwrote every real address.
 *
 * Enforced HERE, in both procedures, rather than only in the mapping UI. The
 * client now prevents reaching this state, but `fieldMapping` is a free-form
 * record on the wire and a UI check is not a guard — the same reasoning that
 * moved the LLM ceiling to the funnel instead of a path list.
 */
export function assertNoDuplicateMappings(mapping: Record<string, string | null>): void {
  const dupes = findDuplicateFieldMappings(mapping);
  if (dupes.length === 0) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `Two columns are mapped to the same field, and only one would be imported: ` +
      `${describeDuplicateMappings(dupes)}. Map one column per field.`,
  });
}

/**
 * Every required field has a column mapped to it.
 *
 * Called by BOTH procedures against the SAME destination. Until now only
 * `validateRows` checked this at all, so an unmapped required field was a
 * preview error and a successful import — a caller skipping the preview got
 * the rows in regardless. The whole point of this pair of procedures is that
 * the preview describes the import.
 */
export function assertRequiredFieldsMapped(
  mapping: Record<string, string | null>,
  destination: ImportDestination,
): void {
  const missing = missingRequiredMappings(mapping, destination);
  if (missing.length === 0) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `Required fields not mapped: ${missing.map((f) => f.label).join(", ")}. ` +
      (destination === "prospects"
        ? `Prospects need a name and a company — the enrichment sweeper resolves the company to a domain before it can find an address.`
        : `A CRM contact needs a name, a company and an email address.`),
  });
}

/* ─── Router ────────────────────────────────────────────────────────────── */

/**
 * Identity key for a contact when NO email is available.
 *
 * Why this is opt-in and off by default: email is a true unique identifier,
 * a name is not. Two different people called "John Smith" are common, and
 * silently merging them loses a real contact — worse than importing a
 * duplicate. Requiring company narrows it a lot, but cannot eliminate it, so
 * the user chooses. A row with no company produces NO key and is never matched.
 *
 * Discovered by re-testing QA #7: dedup was 100% email-based while every one of
 * this workspace's 1,520 contacts has email = null, so `existingEmails` was an
 * empty set and no import could ever detect an already-existing contact.
 */
/**
 * Classify one mapped row exactly once, so the preview and the import cannot
 * disagree about it.
 *
 * They disagreed three ways, all of them the shape the comments in both this
 * file and ImportContacts.tsx explicitly worry about ("the preview would promise
 * one thing and the import do another"):
 *
 *   1. **Order.** `validateRows` checked duplicates BEFORE the required-name
 *      check and returned early, so a row that was both a duplicate and missing
 *      a last name counted as a duplicate in the preview and an error in the
 *      import.
 *   2. **The phone check only existed in the preview.** A row rejected on screen
 *      as "Invalid phone format" was then IMPORTED — the one divergence that
 *      wrote data the user had been told would be excluded.
 *   3. **`skipDuplicates` never reached the preview.** With the toggle off the
 *      import creates duplicate contacts, while the preview still reported them
 *      as duplicates, i.e. as rows that would not be created.
 *
 * `isDuplicate` is reported independently of `status` on purpose: with
 * skipDuplicates off a duplicate row is still going to be imported, and the
 * summary should say both things rather than pick one.
 */
export type ImportRowClass = {
  status: "ok" | "error" | "duplicate";
  reason: string;
  isDuplicate: boolean;
  /** Lowercased email, when this row has a valid one — the caller records it. */
  emailKey: string | null;
  /** name+company identity, when derivable — the caller records it. */
  nameKey: string | null;
};

export function classifyImportRow(
  mapped: Record<string, string>,
  opts: {
    existingEmails: Set<string>;
    seenEmails: Set<string>;
    existingNameKeys: Set<string>;
    seenNameKeys: Set<string>;
    matchOnNameCompany: boolean;
    skipDuplicates: boolean;
    /**
     * Which fields this row must carry, from `requiredFieldKeysFor(destination)`.
     *
     * NOT optional and NOT defaulted: preview and commit must be handed the
     * same set or they resume disagreeing about which rows import, which is the
     * exact defect this shared classifier was extracted to end. A default here
     * would let one caller quietly omit it and still compile.
     */
    requiredFields: string[];
  },
): ImportRowClass {
  const errors: string[] = [];
  /**
   * Fail LOUD on a caller that omits the set. `new Set(undefined)` is a valid
   * empty set, so the natural failure mode of forgetting this argument is
   * "nothing is required" — an import that silently accepts every row. tsc
   * catches it for the two real call sites; this catches anything else.
   */
  if (!Array.isArray(opts.requiredFields)) {
    throw new Error("classifyImportRow: requiredFields is missing — refusing to treat that as 'nothing required'");
  }
  // Iterated in CONTACT_IMPORT_FIELDS order so the message reads in the same
  // order as the mapping screen rather than in whichever order the caller
  // happened to build the list.
  const required = new Set(opts.requiredFields);
  for (const f of CONTACT_IMPORT_FIELDS) {
    if (!required.has(f.key)) continue;
    if (!mapped[f.key]?.trim()) errors.push(`Missing ${f.label}`);
  }
  if (mapped.email && !isValidEmail(mapped.email)) {
    errors.push(`Invalid email format: ${mapped.email}`);
  }
  if (mapped.phone && !isValidPhone(mapped.phone)) {
    errors.push(`Invalid phone format: ${mapped.phone}`);
  }
  if (errors.length > 0) {
    return { status: "error", reason: errors.join("; "), isDuplicate: false, emailKey: null, nameKey: null };
  }

  const emailKey = mapped.email ? mapped.email.toLowerCase() : null;
  const nameKey = nameCompanyKey(mapped.firstName, mapped.lastName, mapped.company);

  if (emailKey) {
    const dup = opts.existingEmails.has(emailKey) || opts.seenEmails.has(emailKey);
    if (dup) {
      return {
        status: opts.skipDuplicates ? "duplicate" : "ok",
        reason: "Duplicate email",
        isDuplicate: true,
        emailKey,
        nameKey,
      };
    }
    return { status: "ok", reason: "", isDuplicate: false, emailKey, nameKey };
  }

  // No email: email dedup is structurally blind to this row. Fall back to
  // name+company only when the user opted in.
  if (nameKey && opts.matchOnNameCompany) {
    const dup = opts.existingNameKeys.has(nameKey) || opts.seenNameKeys.has(nameKey);
    if (dup) {
      return {
        status: opts.skipDuplicates ? "duplicate" : "ok",
        reason: "Duplicate name + company",
        isDuplicate: true,
        emailKey,
        nameKey,
      };
    }
  }
  return { status: "ok", reason: "", isDuplicate: false, emailKey, nameKey };
}

export function nameCompanyKey(
  firstName?: string | null,
  lastName?: string | null,
  company?: string | null,
): string | null {
  const norm = (s?: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const f = norm(firstName);
  const l = norm(lastName);
  const c = norm(company).replace(/[.,]/g, "").replace(/\b(inc|llc|ltd|corp|co|company)\b/g, "").trim();
  if (!f || !l || !c) return null; // never match on name alone
  return `${f}|${l}|${c}`;
}

/**
 * Where an import lands.
 *
 * `contacts` is the CRM proper. `prospects` is the People/CRM backlog that the
 * enrichment sweeper actually reads — importing there is what makes an old
 * list cleanable, because the sweeper never looks at `contacts`. Rows arrive
 * with no email (or an unverified one), get an address found and verified, and
 * `promoteVerifiedProspect` moves the ones that come back `valid` into the CRM.
 */
const DESTINATION = z.enum(["contacts", "prospects"]).default("contacts");
export type ImportDestination = z.infer<typeof DESTINATION>;

/**
 * Rows already in the DESTINATION table, for duplicate detection.
 *
 * Shared by validateRows and commit deliberately. The preview and the import
 * must dedupe against the same population, or the preview promises one thing
 * and the import does another — the exact failure this file's header records
 * from the last time those two drifted apart.
 */
async function existingRowsForDestination(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  wsId: number,
  destination: ImportDestination,
): Promise<Array<{ email: string | null; firstName: string | null; lastName: string | null; companyName: string | null }>> {
  if (destination === "prospects") {
    return db
      .select({
        email: prospects.email,
        firstName: prospects.firstName,
        lastName: prospects.lastName,
        companyName: prospects.company,
      })
      .from(prospects)
      .where(eq(prospects.workspaceId, wsId));
  }
  return db
    .select({
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      companyName: contacts.companyName,
    })
    .from(contacts)
    .where(eq(contacts.workspaceId, wsId));
}

export const importsRouter = router({
  /** Step 1: Parse CSV text, return headers + first 5 preview rows */
  parseCSV: workspaceProcedure
    .input(
      z.object({
        csvText: z.string().max(50 * 1024 * 1024), // 50 MB max
        filename: z.string().max(255),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { headers, rows } = parseCSVText(input.csvText);
      if (headers.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "CSV file appears to be empty." });
      }
      if (rows.length > 50000) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `CSV contains ${rows.length.toLocaleString()} rows. Maximum is 50,000.`,
        });
      }
      return {
        headers,
        previewRows: rows.slice(0, 5),
        totalRows: rows.length,
        systemFields: SYSTEM_FIELDS,
      };
    }),

  /** Step 2: Validate rows with field mapping, return validation report */
  validateRows: workspaceProcedure
    .input(
      z.object({
        csvText: z.string(),
        filename: z.string().max(255),
        /** { "CSV Column Name": "systemFieldKey" | null } */
        fieldMapping: z.record(z.string(), z.string().nullable()),
        /** Opt-in name+company matching for rows with no email. Default OFF. */
        matchOnNameCompany: z.boolean().default(false),
        /** MUST match commit, or the preview dedupes against the wrong table. */
        destination: DESTINATION,
        /**
         * MUST match what commit is called with. The preview used to compute its
         * counts as though duplicates were always skipped, so with the toggle off
         * it reported rows as duplicates that the import then created.
         */
        skipDuplicates: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { headers, rows } = parseCSVText(input.csvText);
      const wsId = ctx.workspace.id;

      const mapping = input.fieldMapping as Record<string, string | null>;
      assertNoDuplicateMappings(mapping);
      assertRequiredFieldsMapped(mapping, input.destination);
      const requiredFields = requiredFieldKeysFor(input.destination);

      // Fetch existing contacts for duplicate detection. Name+company is pulled
      // too so the opt-in matcher has something to compare against.
      const existingContacts = await existingRowsForDestination(db, wsId, input.destination);
      const existingEmails = new Set(
        existingContacts.map((c: { email: string | null }) => c.email?.toLowerCase() ?? "").filter((e: string) => e.length > 0),
      );
      const existingNameKeys = new Set<string>();
      if (input.matchOnNameCompany) {
        for (const c of existingContacts) {
          const k = nameCompanyKey(c.firstName, c.lastName, c.companyName);
          if (k) existingNameKeys.add(k);
        }
      }

      // Validate each row
      const validRows: number[] = [];
      const duplicateRows: number[] = [];
      const errorRows: Array<{ rowIndex: number; reason: string }> = [];
      const seenEmails = new Set<string>();
      const seenNameKeys = new Set<string>();
      /** Rows carrying no email — these cannot be deduped by email at all. */
      let noEmailRows = 0;
      /** Of those, how many also produced no name+company key to fall back on. */
      let unmatchableRows = 0;

      // Workspace company-spelling convergence, one snapshot per run. Applied
      // in BOTH procedures so the preview's dedupe keys match the commit's.
      const canonicalCompany = await buildCompanyCanonicalizer(ctx.workspace.id);
      rows.forEach((row, idx) => {
        const mapped = mapRowToContact(row, input.fieldMapping as Record<string, string | null>);
        if (mapped.company) mapped.company = canonicalCompany(mapped.company, mapped.website ?? null);
        const rowIndex = idx + 1;
        // ONE classifier, shared with commit — see classifyImportRow for the
        // three ways these two used to disagree.
        const verdict = classifyImportRow(mapped, {
          existingEmails,
          seenEmails,
          existingNameKeys,
          seenNameKeys,
          matchOnNameCompany: input.matchOnNameCompany,
          skipDuplicates: input.skipDuplicates,
          requiredFields,
        });

        if (!mapped.email) {
          noEmailRows++;
          if (!verdict.nameKey) unmatchableRows++;
        }

        if (verdict.status === "error") {
          errorRows.push({ rowIndex, reason: verdict.reason });
          return;
        }
        if (verdict.isDuplicate) duplicateRows.push(rowIndex);
        if (verdict.status === "duplicate") return;

        // Record this row's identity so later rows in the same file dedupe
        // against it, exactly as commit does.
        if (verdict.emailKey) seenEmails.add(verdict.emailKey);
        else if (verdict.nameKey && input.matchOnNameCompany) seenNameKeys.add(verdict.nameKey);
        validRows.push(rowIndex);
      });

      return {
        totalRows: rows.length,
        validCount: validRows.length,
        duplicateCount: duplicateRows.length,
        errorCount: errorRows.length,
        errorRows: errorRows.slice(0, 200), // return first 200 errors
        canImport: validRows.length > 0,
        /** Echoed back so the summary can state which rule produced these counts. */
        skipDuplicates: input.skipDuplicates,
        /**
         * Rows with no email. Surfaced so the summary can never imply that
         * duplicate detection ran on rows it structurally cannot see.
         */
        noEmailCount: noEmailRows,
        /** No email AND no name+company — undedupable however the flags are set. */
        unmatchableCount: unmatchableRows,
        matchOnNameCompany: input.matchOnNameCompany,
      };
    }),

  /** Step 3: Commit import — create contacts from valid rows */
  commit: workspaceProcedure
    .input(
      z.object({
        csvText: z.string(),
        filename: z.string().max(255),
        fieldMapping: z.record(z.string(), z.string().nullable()),
        /** Skip duplicates (true) or abort on first duplicate (false) */
        skipDuplicates: z.boolean().default(true),
        /**
         * Opt-in name+company matching for rows with no email. MUST default to
         * false and MUST match validateRows, or the preview would promise one
         * thing and the import do another.
         */
        matchOnNameCompany: z.boolean().default(false),
        /** Where the rows land. See DESTINATION. */
        destination: DESTINATION,
        /**
         * `sequenceId` and `segmentId` used to be accepted here, stored on the
         * import record, and acted on by NOTHING — no enrolment, no segment
         * membership. The UI never sent them, so nobody was misled, but an input
         * an importer silently ignores is the next silent failure waiting for a
         * caller. Removed rather than implemented: enrolling a freshly imported
         * list into a sequence is a send decision, not an import detail.
         */
        postImportActions: z
          .object({
            tag: z.string().optional(),
            ownerUserId: z.number().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const userId = ctx.user.id;
      const { headers, rows } = parseCSVText(input.csvText);

      // BEFORE the import record is created: a rejected import must leave no
      // half-written history row claiming it ran.
      const mapping = input.fieldMapping as Record<string, string | null>;
      assertNoDuplicateMappings(mapping);
      assertRequiredFieldsMapped(mapping, input.destination);
      const requiredFields = requiredFieldKeysFor(input.destination);

      // Create import record
      const [importRecord] = await db
        .insert(contactImports)
        .values({
          workspaceId: wsId,
          filename: input.filename,
          status: "importing",
          totalRows: rows.length,
          fieldMapping: input.fieldMapping,
          postImportActions: input.postImportActions ?? null,
          ownerId: userId,
        })
        .$returningId();
      const importId = importRecord.id;

      // Fetch existing contacts (name+company too, for the opt-in matcher)
      const existingContacts = await existingRowsForDestination(db, wsId, input.destination);
      const existingEmails = new Set(
        existingContacts.map((c: { email: string | null }) => c.email?.toLowerCase() ?? "").filter((e: string) => e.length > 0),
      );
      const existingNameKeys = new Set<string>();
      if (input.matchOnNameCompany) {
        for (const c of existingContacts) {
          const k = nameCompanyKey(c.firstName, c.lastName, c.companyName);
          if (k) existingNameKeys.add(k);
        }
      }

      let importedRows = 0;
      let skippedRows = 0;
      let errorRows = 0;
      let noEmailRows = 0;
      const seenEmails = new Set<string>();
      const seenNameKeys = new Set<string>();

      // ── Phase 1: validate + dedup entirely in memory (no DB I/O) ──
      // Previously this loop did ~2 sequential awaited inserts PER ROW
      // (contact + import-row) → ~20k round-trips for a 10k file, minutes
      // long inside one tRPC request → timeout / partial import. Now we
      // classify in memory then bulk-insert in chunks.
      type Pending = {
        rowIndex: number;
        row: Record<string, string>;
        mapped: ReturnType<typeof mapRowToContact>;
      };
      const toInsert: Pending[] = [];
      const importRowValues: Array<Record<string, unknown>> = [];

      // Same convergence snapshot the preview used — the preview describes
      // the import, spelling included.
      const canonicalCompany = await buildCompanyCanonicalizer(ctx.workspace.id);
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const rowIndex = idx + 1;
        const mapped = mapRowToContact(row, input.fieldMapping as Record<string, string | null>);
        if (mapped.company) mapped.company = canonicalCompany(mapped.company, mapped.website ?? null);

        // ONE classifier, shared with validateRows. It applies the required-field,
        // email AND phone checks in the same order for both, so the preview's
        // counts describe this loop rather than approximating it.
        const verdict = classifyImportRow(mapped, {
          existingEmails,
          seenEmails,
          existingNameKeys,
          seenNameKeys,
          matchOnNameCompany: input.matchOnNameCompany,
          skipDuplicates: input.skipDuplicates,
          requiredFields,
        });

        if (!mapped.email) noEmailRows++;

        if (verdict.status === "error") {
          importRowValues.push({ importId, rowIndex, rowData: row, mappedData: mapped, status: "error", errorReason: verdict.reason });
          errorRows++;
          continue;
        }
        if (verdict.status === "duplicate") {
          importRowValues.push({ importId, rowIndex, rowData: row, mappedData: mapped, status: "duplicate", errorReason: verdict.reason });
          skippedRows++;
          continue;
        }
        // Record this row's identity so later rows in the same file dedupe
        // against it. Both sets are updated for the same reason the preview does.
        if (verdict.emailKey) {
          seenEmails.add(verdict.emailKey);
          existingEmails.add(verdict.emailKey);
        } else if (verdict.nameKey && input.matchOnNameCompany) {
          seenNameKeys.add(verdict.nameKey);
          existingNameKeys.add(verdict.nameKey);
        }
        toInsert.push({ rowIndex, row, mapped });
      }

      // ── Phase 1b: resolve companies to real Account rows ──
      //
      // The importer lets users map Company / Website / Industry / State /
      // Country, and every one of those was being stuffed into the
      // `customFields` JSON blob — which NOTHING in the app reads. So a
      // 5,000-row import with those columns mapped reported success and the
      // data was never visible again: not in the Contacts table, not on
      // ContactDetail, not searchable, not filterable.
      //
      // `contacts` has had real companyName / companyDomain / accountId
      // columns since migration 0098, and `accounts` has industry and region.
      // Resolve each distinct company ONCE here (not per row — a 10k file
      // would otherwise mean 10k lookups) and link the contacts to it.
      const normDomain = (raw?: string | null): string | null => {
        const s = (raw ?? "").trim();
        if (!s) return null;
        return s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase() || null;
      };
      const companyKey = (p: Pending): string | null => {
        const domain = normDomain(p.mapped.website);
        const name = p.mapped.company?.trim();
        return domain || (name ? `name:${name.toLowerCase()}` : null);
      };

      const accountIdByKey = new Map<string, number>();
      const distinct = new Map<string, Pending>();
      for (const p of toInsert) {
        const key = companyKey(p);
        if (key && !distinct.has(key)) distinct.set(key, p);
      }

      // Resolved with a fixed number of queries regardless of file size: two
      // batched lookups plus one bulk insert. Doing it per-company would
      // reintroduce exactly the per-row round-trip problem Phase 1 was
      // restructured to avoid (see the comment above about 10k-row files
      // timing out inside a single tRPC request).
      try {
        const wantedDomains = [...distinct.values()]
          .map((p) => normDomain(p.mapped.website))
          .filter((d): d is string => !!d);
        const wantedNames = [...distinct.values()]
          .map((p) => p.mapped.company?.trim()?.slice(0, 200))
          .filter((n): n is string => !!n);

        const existingByDomain = new Map<string, number>();
        const existingByName = new Map<string, number>();
        if (wantedDomains.length > 0) {
          const rows = await db.select({ id: accounts.id, domain: accounts.domain })
            .from(accounts)
            .where(and(eq(accounts.workspaceId, wsId), inArray(accounts.domain, wantedDomains)));
          for (const r of rows) if (r.domain) existingByDomain.set(r.domain.toLowerCase(), r.id);
        }
        if (wantedNames.length > 0) {
          const rows = await db.select({ id: accounts.id, name: accounts.name })
            .from(accounts)
            .where(and(eq(accounts.workspaceId, wsId), inArray(accounts.name, wantedNames)));
          for (const r of rows) existingByName.set(r.name.toLowerCase(), r.id);
        }

        // Domain first: it is the reliable company identity. Two "Acme" rows
        // are usually different companies; one domain is one company.
        const toCreate: Array<{ key: string; values: Record<string, unknown> }> = [];
        for (const [key, sample] of distinct) {
          const domain = normDomain(sample.mapped.website);
          const name = sample.mapped.company?.trim() || domain || "Unknown Company";
          const hit = (domain && existingByDomain.get(domain))
            || existingByName.get(name.toLowerCase());
          if (hit) { accountIdByKey.set(key, hit); continue; }
          // Region carries whatever geography the CSV had — state and country
          // are the two fields `contacts` has no column for.
          const region = [sample.mapped.state?.trim(), sample.mapped.country?.trim()]
            .filter(Boolean).join(", ").slice(0, 80) || null;
          toCreate.push({
            key,
            values: {
              workspaceId: wsId,
              name: name.slice(0, 200),
              domain: domain ? domain.slice(0, 200) : null,
              // Identity-index columns (roadmap P1.4): without these the
              // matcher and the duplicate report can never see this row.
              ...normalizedAccountFields(name, domain),
              industry: sample.mapped.industry?.trim()?.slice(0, 80) || null,
              region,
              ownerUserId: input.postImportActions?.ownerUserId ?? userId,
            },
          });
        }

        // Bulk-insert the new accounts, then read their ids back with one
        // more batched lookup. Deriving ids by offset from MySQL's single
        // returned insertId would be faster but relies on auto-increment
        // values being contiguous, which isn't guaranteed across every
        // innodb_autoinc_lock_mode / replication setup — a wrong guess would
        // silently attach contacts to the WRONG company.
        const ACC_CHUNK = 200;
        for (let i = 0; i < toCreate.length; i += ACC_CHUNK) {
          await db.insert(accounts).values(toCreate.slice(i, i + ACC_CHUNK).map((c) => c.values) as never);
        }
        if (toCreate.length > 0) {
          const newDomains = toCreate.map((c) => c.values.domain).filter((d): d is string => !!d);
          const newNames = toCreate.map((c) => c.values.name).filter((n): n is string => !!n);
          if (newDomains.length > 0) {
            const rows = await db.select({ id: accounts.id, domain: accounts.domain }).from(accounts)
              .where(and(eq(accounts.workspaceId, wsId), inArray(accounts.domain, newDomains)));
            for (const r of rows) if (r.domain) existingByDomain.set(r.domain.toLowerCase(), r.id);
          }
          if (newNames.length > 0) {
            const rows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts)
              .where(and(eq(accounts.workspaceId, wsId), inArray(accounts.name, newNames)));
            for (const r of rows) existingByName.set(r.name.toLowerCase(), r.id);
          }
          for (const c of toCreate) {
            const domain = c.values.domain as string | null;
            const name = c.values.name as string;
            const id = (domain && existingByDomain.get(domain)) || existingByName.get(name.toLowerCase());
            if (id) accountIdByKey.set(c.key, id);
          }
        }
      } catch (e) {
        // Company linking must never sink the import — contacts still land,
        // just unlinked. `.cause` carries the real DB reason; `.message` is
        // only the SQL text.
        console.error("[imports] account resolution failed:", (e as Error)?.cause ?? e);
      }

      // ── Phase 2: chunked batch insert of contacts, then import-rows ──
      const CHUNK = 500;
      const buildContactValues = (p: Pending) => {
        const key = companyKey(p);
        return {
          workspaceId: wsId,
          firstName: p.mapped.firstName?.trim() ?? "",
          lastName: p.mapped.lastName?.trim() ?? "",
          email: p.mapped.email?.trim() || null,
          phone: p.mapped.phone?.trim() || null,
          title: p.mapped.title?.trim() || null,
          linkedinUrl: p.mapped.linkedinUrl?.trim() || null,
          city: p.mapped.city?.trim() || null,
          seniority: p.mapped.seniority?.trim() || null,
          // Real columns now, not a JSON blob nobody reads. Clamped because
          // MySQL strict mode REJECTS an over-long value rather than
          // truncating, and a rejection kills the whole 500-row chunk.
          companyName: p.mapped.company?.trim()?.slice(0, 200) || null,
          companyDomain: normDomain(p.mapped.website)?.slice(0, 200) ?? null,
          accountId: key ? accountIdByKey.get(key) ?? null : null,
          ownerUserId: input.postImportActions?.ownerUserId ?? userId,
          // customFields keeps import provenance only. The business fields
          // that used to be buried here now live in real columns above.
          customFields: {
            importTag: input.postImportActions?.tag ?? null,
            importSource: "csv_import",
            importId,
          },
        };
      };

      const toProspects = input.destination === "prospects";

      /**
       * The same mapped row, shaped for the prospects backlog.
       *
       * Clamped to the column widths for the reason buildContactValues records:
       * MySQL strict mode REJECTS an over-long value rather than truncating,
       * and one rejection kills the whole 500-row chunk.
       *
       * `enrichmentData` is deliberately left unset — the sweeper treats
       * `enrichmentData IS NULL` as "not attempted yet", so writing anything
       * here would make every imported row look already-worked and it would
       * never be cleaned.
       */
      const buildProspectValues = (p: Pending) => ({
        workspaceId: wsId,
        firstName: (p.mapped.firstName?.trim() ?? "").slice(0, 80),
        lastName: (p.mapped.lastName?.trim() ?? "").slice(0, 80),
        email: p.mapped.email?.trim()?.slice(0, 320) || null,
        phone: p.mapped.phone?.trim()?.slice(0, 40) || null,
        title: p.mapped.title?.trim()?.slice(0, 120) || null,
        linkedinUrl: p.mapped.linkedinUrl?.trim() || null,
        city: p.mapped.city?.trim()?.slice(0, 80) || null,
        seniority: p.mapped.seniority?.trim()?.slice(0, 64) || null,
        company: p.mapped.company?.trim()?.slice(0, 200) || null,
        companyDomain: normDomain(p.mapped.website)?.slice(0, 200) ?? null,
      });

      for (let i = 0; i < toInsert.length; i += CHUNK) {
        const chunk = toInsert.slice(i, i + CHUNK);
        try {
          const ids = toProspects
            ? await db.insert(prospects).values(chunk.map(buildProspectValues) as never).$returningId()
            : await db.insert(contacts).values(chunk.map(buildContactValues) as never).$returningId(); // ordered ids
          for (let j = 0; j < chunk.length; j++) {
            const newId = (ids as Array<{ id: number }>)[j]?.id;
            importRowValues.push({
              importId,
              rowIndex: chunk[j].rowIndex,
              rowData: chunk[j].row,
              mappedData: chunk[j].mapped,
              status: "imported",
              // Exactly one of the two, so the audit row says what it made.
              contactId: toProspects ? null : newId,
              prospectId: toProspects ? newId : null,
            });
            importedRows++;
          }
        } catch {
          // Chunk failed — fall back to per-row so one bad row doesn't
          // lose the other 499. Preserves prior error-capture behavior.
          for (const p of chunk) {
            try {
              const [c] = toProspects
                ? await db.insert(prospects).values(buildProspectValues(p) as never).$returningId()
                : await db.insert(contacts).values(buildContactValues(p) as never).$returningId();
              importRowValues.push({
                importId, rowIndex: p.rowIndex, rowData: p.row, mappedData: p.mapped, status: "imported",
                contactId: toProspects ? null : c.id,
                prospectId: toProspects ? c.id : null,
              });
              importedRows++;
            } catch {
              importRowValues.push({ importId, rowIndex: p.rowIndex, rowData: p.row, mappedData: p.mapped, status: "error", errorReason: "Database insert failed" });
              errorRows++;
            }
          }
        }
      }

      // Bulk-insert all import-row audit records (chunked).
      for (let i = 0; i < importRowValues.length; i += CHUNK) {
        const slice = importRowValues.slice(i, i + CHUNK);
        try {
          await db.insert(contactImportRows).values(slice as never);
        } catch {
          for (const v of slice) {
            try { await db.insert(contactImportRows).values(v as never); } catch { /* audit row best-effort */ }
          }
        }
      }

      // Update import record
      await db
        .update(contactImports)
        .set({
          status: "completed",
          importedRows,
          skippedRows,
          errorRows,
          completedAt: new Date(),
        })
        .where(eq(contactImports.id, importId));

      return {
        importId,
        totalRows: rows.length,
        importedRows,
        skippedRows,
        errorRows,
        /** Imported without an email — duplicate detection could not see these. */
        noEmailCount: noEmailRows,
        matchOnNameCompany: input.matchOnNameCompany,
      };
    }),

  /** Get import history for workspace */
  getHistory: workspaceProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const records = await db
        .select()
        .from(contactImports)
        .where(eq(contactImports.workspaceId, ctx.workspace.id))
        .orderBy(desc(contactImports.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return records;
    }),

  /** Get single import detail + error rows */
  getImport: workspaceProcedure
    .input(z.object({ importId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [record] = await db
        .select()
        .from(contactImports)
        .where(
          and(
            eq(contactImports.id, input.importId),
            eq(contactImports.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!record) throw new TRPCError({ code: "NOT_FOUND" });

      const errorRowsList = await db
        .select()
        .from(contactImportRows)
        .where(
          and(
            eq(contactImportRows.importId, input.importId),
            inArray(contactImportRows.status, ["error", "duplicate"]),
          ),
        )
        .limit(500);

      return { record, errorRows: errorRowsList };
    }),
});
