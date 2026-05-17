import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import {
  contactImports,
  contactImportRows,
  contacts,
} from "../../drizzle/schema";
import { parseCSVText } from "../services/csv";

/* ─── Field definitions ─────────────────────────────────────────────────── */

export const SYSTEM_FIELDS = [
  { key: "firstName", label: "First Name", required: true },
  { key: "lastName", label: "Last Name", required: true },
  { key: "email", label: "Email", required: false },
  { key: "phone", label: "Phone", required: false },
  { key: "title", label: "Job Title", required: false },
  { key: "company", label: "Company", required: false },
  { key: "city", label: "City", required: false },
  { key: "seniority", label: "Seniority", required: false },
  { key: "linkedinUrl", label: "LinkedIn URL", required: false },
  { key: "website", label: "Website", required: false },
  { key: "industry", label: "Industry", required: false },
  { key: "country", label: "Country", required: false },
  { key: "state", label: "State / Region", required: false },
  { key: "tags", label: "Tags (comma-separated)", required: false },
] as const;

export type SystemFieldKey = (typeof SYSTEM_FIELDS)[number]["key"];

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
  return result;
}

/* ─── Router ────────────────────────────────────────────────────────────── */

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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { headers, rows } = parseCSVText(input.csvText);
      const wsId = ctx.workspace.id;

      // Validate mapping has required fields
      const mappedSystemFields = Object.values(input.fieldMapping).filter(Boolean) as string[];
      const missingRequired = SYSTEM_FIELDS.filter(
        (f) => f.required && !mappedSystemFields.includes(f.key),
      );
      if (missingRequired.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Required fields not mapped: ${missingRequired.map((f) => f.label).join(", ")}`,
        });
      }

      // Fetch existing emails in this workspace for duplicate detection
      const existingContacts = await db
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.workspaceId, wsId));
      const existingEmails = new Set(
        existingContacts.map((c: { email: string | null }) => c.email?.toLowerCase() ?? "").filter((e: string) => e.length > 0),
      );

      // Validate each row
      const validRows: number[] = [];
      const duplicateRows: number[] = [];
      const errorRows: Array<{ rowIndex: number; reason: string }> = [];
      const seenEmails = new Set<string>();

      rows.forEach((row, idx) => {
        const mapped = mapRowToContact(row, input.fieldMapping as Record<string, string | null>);
        const rowIndex = idx + 1;
        const errors: string[] = [];

        // Required field checks
        if (!mapped.firstName?.trim()) errors.push("Missing First Name");
        if (!mapped.lastName?.trim()) errors.push("Missing Last Name");

        // Email validation
        if (mapped.email) {
          if (!isValidEmail(mapped.email)) {
            errors.push(`Invalid email format: ${mapped.email}`);
          } else {
            const emailLower = mapped.email.toLowerCase();
            if (existingEmails.has(emailLower)) {
              duplicateRows.push(rowIndex);
              return;
            }
            if (seenEmails.has(emailLower)) {
              duplicateRows.push(rowIndex);
              return;
            }
            seenEmails.add(emailLower);
          }
        }

        // Phone validation
        if (mapped.phone && !isValidPhone(mapped.phone)) {
          errors.push(`Invalid phone format: ${mapped.phone}`);
        }

        if (errors.length > 0) {
          errorRows.push({ rowIndex, reason: errors.join("; ") });
        } else {
          validRows.push(rowIndex);
        }
      });

      return {
        totalRows: rows.length,
        validCount: validRows.length,
        duplicateCount: duplicateRows.length,
        errorCount: errorRows.length,
        errorRows: errorRows.slice(0, 200), // return first 200 errors
        canImport: validRows.length > 0,
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
        postImportActions: z
          .object({
            tag: z.string().optional(),
            ownerUserId: z.number().optional(),
            sequenceId: z.number().optional(),
            segmentId: z.number().optional(),
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

      // Fetch existing emails
      const existingContacts = await db
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.workspaceId, wsId));
      const existingEmails = new Set(
        existingContacts.map((c: { email: string | null }) => c.email?.toLowerCase() ?? "").filter((e: string) => e.length > 0),
      );

      let importedRows = 0;
      let skippedRows = 0;
      let errorRows = 0;
      const seenEmails = new Set<string>();

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

      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const rowIndex = idx + 1;
        const mapped = mapRowToContact(row, input.fieldMapping as Record<string, string | null>);

        const errors: string[] = [];
        if (!mapped.firstName?.trim()) errors.push("Missing First Name");
        if (!mapped.lastName?.trim()) errors.push("Missing Last Name");
        if (mapped.email && !isValidEmail(mapped.email)) errors.push("Invalid email");

        if (errors.length > 0) {
          importRowValues.push({ importId, rowIndex, rowData: row, mappedData: mapped, status: "error", errorReason: errors.join("; ") });
          errorRows++;
          continue;
        }

        if (mapped.email) {
          const emailLower = mapped.email.toLowerCase();
          if ((existingEmails.has(emailLower) || seenEmails.has(emailLower)) && input.skipDuplicates) {
            importRowValues.push({ importId, rowIndex, rowData: row, mappedData: mapped, status: "duplicate", errorReason: "Duplicate email" });
            skippedRows++;
            continue;
          }
          seenEmails.add(emailLower);
          existingEmails.add(emailLower);
        }
        toInsert.push({ rowIndex, row, mapped });
      }

      // ── Phase 2: chunked batch insert of contacts, then import-rows ──
      const CHUNK = 500;
      const buildContactValues = (p: Pending) => ({
        workspaceId: wsId,
        firstName: p.mapped.firstName?.trim() ?? "",
        lastName: p.mapped.lastName?.trim() ?? "",
        email: p.mapped.email?.trim() || null,
        phone: p.mapped.phone?.trim() || null,
        title: p.mapped.title?.trim() || null,
        linkedinUrl: p.mapped.linkedinUrl?.trim() || null,
        city: p.mapped.city?.trim() || null,
        seniority: p.mapped.seniority?.trim() || null,
        ownerUserId: input.postImportActions?.ownerUserId ?? userId,
        customFields: {
          importTag: input.postImportActions?.tag ?? null,
          importSource: "csv_import",
          importId,
          ...(p.mapped.company ? { company: p.mapped.company } : {}),
          ...(p.mapped.industry ? { industry: p.mapped.industry } : {}),
          ...(p.mapped.country ? { country: p.mapped.country } : {}),
          ...(p.mapped.state ? { state: p.mapped.state } : {}),
          ...(p.mapped.website ? { website: p.mapped.website } : {}),
        },
      });

      for (let i = 0; i < toInsert.length; i += CHUNK) {
        const chunk = toInsert.slice(i, i + CHUNK);
        try {
          const ids = await db
            .insert(contacts)
            .values(chunk.map(buildContactValues) as never)
            .$returningId(); // ordered ids for the batch
          for (let j = 0; j < chunk.length; j++) {
            importRowValues.push({
              importId,
              rowIndex: chunk[j].rowIndex,
              rowData: chunk[j].row,
              mappedData: chunk[j].mapped,
              status: "imported",
              contactId: (ids as Array<{ id: number }>)[j]?.id,
            });
            importedRows++;
          }
        } catch {
          // Chunk failed — fall back to per-row so one bad row doesn't
          // lose the other 499. Preserves prior error-capture behavior.
          for (const p of chunk) {
            try {
              const [c] = await db.insert(contacts).values(buildContactValues(p) as never).$returningId();
              importRowValues.push({ importId, rowIndex: p.rowIndex, rowData: p.row, mappedData: p.mapped, status: "imported", contactId: c.id });
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
