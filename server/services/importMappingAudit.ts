/**
 * Import mapping audit — how much data the old CSV column matcher mis-filed.
 *
 * READ-ONLY. Nothing here writes, and nothing here should ever learn to: the
 * point is to size the damage before anyone decides whether to repair it, and a
 * repair that runs before the count is understood is how a bad import becomes a
 * bad import plus a bad correction.
 *
 * ─── WHAT WENT WRONG (fixed in 8c967cc) ──────────────────────────────────────
 * `ImportContacts.tsx` auto-mapped CSV headers to fields by bidirectional
 * substring — `normalized.includes(kNorm) || kNorm.includes(normalized)`. So:
 *
 *   Email Status         → email        (values are "valid"/"unknown")
 *   Company Website      → company      (a URL stored as a company NAME)
 *   Company Domain       → company
 *   Company City         → company      (a city stored as a company name)
 *   Company Industry     → company
 *   Company Linkedin Url → company      (a LinkedIn page as a company name)
 *   Company Phone        → phone        (a switchboard as the person's number)
 *   Corporate Phone      → phone
 *
 * Note which field each landed in: the old matcher took the FIRST field whose
 * key was a substring, so `company` (6th in the list) beat `linkedinUrl` (7th)
 * and `phone` (4th) beat `company`. Field ORDER decided where the damage went,
 * exactly as importFields.ts's header warns — so a repair driven by intuition
 * rather than by this replay would look in the wrong column.
 *
 * And because `mapRowToContact` has no merge step, when several columns claimed
 * one field the LAST in file order won and the others were dropped silently.
 * On an Apollo-shaped export that is five columns fighting over `company`.
 *
 * ─── WHY TWO LAYERS ──────────────────────────────────────────────────────────
 * A. **Mapping replay** — every import's exact column→field mapping is stored on
 *    `contact_imports.fieldMapping`. Replaying it is deterministic: it says what
 *    each import actually did, not what it probably did. This is the layer to
 *    trust.
 * B. **Row residue** — what still looks wrong in the tables today. Necessary
 *    because layer A counts rows an import CREATED, and those rows may since
 *    have been edited, enriched, deleted or overwritten.
 *
 * Neither layer alone answers "how much is broken": A can over-count (a row was
 * fixed later), B can under-count (a mis-filed value that looks plausible, like
 * a city in the company field, is invisible to a heuristic) and B can also
 * over-count (a company genuinely named "Booking.com"). They are reported
 * separately and never summed.
 */
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { contactImportRows, contactImports, contacts, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  CONTACT_IMPORT_FIELDS,
  findDuplicateFieldMappings,
  matchHeaderToField,
  normalizeHeader,
} from "@shared/importFields";

/* ─── Layer A: replaying a stored mapping ────────────────────────────────── */

/**
 * The matcher as it was until 8c967cc, preserved verbatim.
 *
 * Kept ONLY so the audit can tell "the old auto-mapper chose this" from "a
 * person chose this" — a stored mapping that the old matcher would have
 * produced and the new one rejects is almost certainly automatic. Without this
 * the audit would have to report every disagreement, including deliberate user
 * choices, and an audit that cries wolf gets ignored.
 *
 * ⚠️ Never call this from import code. It is history, not behaviour.
 */
export function legacyMatchHeaderToField(header: string): string | null {
  const normalized = normalizeHeader(header);
  const match = CONTACT_IMPORT_FIELDS.find((f) => {
    const fNorm = normalizeHeader(f.label);
    const kNorm = f.key.toLowerCase();
    return normalized === fNorm || normalized === kNorm ||
      normalized.includes(kNorm) || kNorm.includes(normalized);
  });
  return match?.key ?? null;
}

export interface MappingFinding {
  /** Fields more than one column claimed — one column's data was discarded. */
  duplicateClaims: Array<{ field: string; label: string; headers: string[]; keptHeader: string }>;
  /** Columns the OLD matcher mis-assigned and the new one would not. */
  suspectAssignments: Array<{ header: string; storedField: string; correctField: string | null }>;
}

/**
 * Audit one stored `fieldMapping`.
 *
 * `keptHeader` is the LAST claiming column, because that is the one
 * `mapRowToContact` kept — the others are what was lost. Getting this backwards
 * would name the surviving data as the casualty.
 */
export function auditFieldMapping(mapping: Record<string, string | null>): MappingFinding {
  const duplicateClaims = findDuplicateFieldMappings(mapping).map((d) => ({
    ...d,
    keptHeader: d.headers[d.headers.length - 1],
  }));

  const suspectAssignments: MappingFinding["suspectAssignments"] = [];
  for (const [header, storedField] of Object.entries(mapping)) {
    if (!storedField) continue;
    const correct = matchHeaderToField(header);
    if (correct === storedField) continue;
    // Only flag what the OLD matcher would have produced on its own. A mapping
    // no automatic matcher would have made is a human decision, and this audit
    // has no business second-guessing it.
    if (legacyMatchHeaderToField(header) !== storedField) continue;
    suspectAssignments.push({ header, storedField, correctField: correct });
  }
  return { duplicateClaims, suspectAssignments };
}

export const hasMappingDefect = (f: MappingFinding): boolean =>
  f.duplicateClaims.length > 0 || f.suspectAssignments.length > 0;

/* ─── Layer B: what a wrong value looks like in a row ─────────────────────── */

/**
 * A company NAME that is really a URL.
 *
 * Split into certain and possible on purpose. `https://acme.io`, `www.acme.io`
 * and `acme.io/about` cannot be company names. A bare `acme.io` might be:
 * Booking.com and Salesforce.com are real names, and reporting those as damage
 * would make the total untrustworthy — so they are counted apart and the
 * caller shows both numbers.
 */
export function companyNameLooksLikeUrl(value: string | null | undefined): "certain" | "possible" | null {
  const s = (value ?? "").trim();
  if (!s) return null;
  // No separate scheme test: "https://…" necessarily contains a slash, so the
  // slash test below already covers it. A mutation proved that line could never
  // fail — and an unkillable line in a detector reads as coverage it does not
  // provide. (Same finding as the BOM strip in shared/importFields.ts.)
  if (/^www\./i.test(s)) return "certain";
  if (/\//.test(s)) return "certain"; // a path or a scheme's "//"
  // Bare host-like token: no spaces, a dot, and a plausible TLD.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && /\.[a-z]{2,}$/i.test(s)) return "possible";
  return null;
}

/**
 * A LinkedIn URL that points at a COMPANY page rather than a person.
 *
 * The crispest signal in the audit: `/company/` and `/in/` are different kinds
 * of object and no legitimate contact record has the former in this column.
 */
export function isCompanyLinkedInUrl(value: string | null | undefined): boolean {
  const s = (value ?? "").trim().toLowerCase();
  if (!s) return false;
  return /linkedin\.com\/(company|school|showcase)\//.test(s);
}

/**
 * An email column holding a verification verdict.
 *
 * Expected to be ZERO: `classifyImportRow` rejects a row whose email fails the
 * format check, which is exactly why the reported import produced 200 errors
 * and imported nothing. It is audited anyway — if this is ever non-zero the
 * validation was bypassed and that matters more than everything else here.
 */
const VERDICTS = new Set([
  "valid", "invalid", "unknown", "catchall", "catch_all", "acceptall", "accept_all",
  "risky", "disposable", "spamtrap", "abuse", "deliverable", "undeliverable",
  "verified", "unavailable", "guessed", "notunlocked",
]);
export function looksLikeVerificationVerdict(value: string | null | undefined): boolean {
  // Membership of the closed set above is the whole test. An extra
  // `s.includes("@")` guard was here and was unkillable: every address contains
  // an @ and no entry in VERDICTS does, so it could never change an answer.
  const s = (value ?? "").trim().toLowerCase().replace(/[\s-]/g, "");
  return VERDICTS.has(s);
}

/* ─── The audit ──────────────────────────────────────────────────────────── */

export interface ImportMappingAudit {
  /** True when no past import stored a mapping with the defect. */
  clean: boolean;
  importsChecked: number;
  /** Imports whose stored mapping shows the defect, newest first. */
  affectedImports: Array<{
    importId: number;
    filename: string;
    completedAt: string | null;
    rowsImported: number;
    contactsStillPresent: number;
    prospectsStillPresent: number;
    duplicateClaims: MappingFinding["duplicateClaims"];
    suspectAssignments: MappingFinding["suspectAssignments"];
  }>;
  /** What still looks wrong in the tables right now, workspace-wide. */
  residue: {
    contactsCompanyNameIsUrl: number;
    contactsCompanyNameMaybeUrl: number;
    contactsLinkedInIsCompanyPage: number;
    contactsEmailIsVerdict: number;
    prospectsCompanyIsUrl: number;
    prospectsCompanyMaybeUrl: number;
    prospectsLinkedInIsCompanyPage: number;
    prospectsEmailIsVerdict: number;
  };
  /** Stated so a zero is never mistaken for "nothing to find". */
  notes: string[];
}

/**
 * Sample size for the residue scan.
 *
 * The heuristics are string predicates, so they run in JS rather than SQL. A
 * workspace can hold tens of thousands of rows; only the columns needed are
 * selected and the scan is capped. If the cap is reached the caller is TOLD, so
 * a partial count is never read as a total — the failure mode this repo has
 * repeatedly produced by reporting a bounded number as if it were complete.
 */
const RESIDUE_SCAN_CAP = 50000;

export async function auditImportMappings(workspaceId: number): Promise<ImportMappingAudit> {
  const db = await getDb();
  const empty: ImportMappingAudit = {
    clean: true, importsChecked: 0, affectedImports: [],
    residue: {
      contactsCompanyNameIsUrl: 0, contactsCompanyNameMaybeUrl: 0,
      contactsLinkedInIsCompanyPage: 0, contactsEmailIsVerdict: 0,
      prospectsCompanyIsUrl: 0, prospectsCompanyMaybeUrl: 0,
      prospectsLinkedInIsCompanyPage: 0, prospectsEmailIsVerdict: 0,
    },
    notes: [],
  };
  if (!db) return { ...empty, notes: ["Database unavailable — nothing was checked."] };

  const notes: string[] = [];

  /* ── Layer A ── */
  const imports = await db
    .select({
      id: contactImports.id,
      filename: contactImports.filename,
      completedAt: contactImports.completedAt,
      fieldMapping: contactImports.fieldMapping,
      importedRows: contactImports.importedRows,
    })
    .from(contactImports)
    .where(eq(contactImports.workspaceId, workspaceId))
    .orderBy(sql`${contactImports.id} DESC`);

  const affected: ImportMappingAudit["affectedImports"] = [];
  let unreadableMappings = 0;
  for (const imp of imports) {
    const raw = imp.fieldMapping as Record<string, string | null> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      unreadableMappings++;
      continue;
    }
    const finding = auditFieldMapping(raw);
    if (!hasMappingDefect(finding)) continue;
    affected.push({
      importId: imp.id,
      filename: imp.filename,
      completedAt: imp.completedAt ? new Date(imp.completedAt).toISOString() : null,
      rowsImported: Number(imp.importedRows ?? 0),
      contactsStillPresent: 0,
      prospectsStillPresent: 0,
      ...finding,
    });
  }
  if (unreadableMappings > 0) {
    notes.push(
      `${unreadableMappings} import${unreadableMappings === 1 ? "" : "s"} stored no readable ` +
      `column mapping and could not be replayed — they are not counted either way.`,
    );
  }

  /**
   * How many rows each affected import created that STILL EXIST. `importedRows`
   * is what it wrote at the time; a row deleted since is not damage anyone can
   * still act on, and reporting the historical figure as current would inflate
   * every number on the page.
   */
  if (affected.length > 0) {
    const ids = affected.map((a) => a.importId);
    const alive = await db
      .select({
        importId: contactImportRows.importId,
        contactsAlive: sql<number>`SUM(CASE WHEN ${contacts.id} IS NOT NULL THEN 1 ELSE 0 END)`,
        prospectsAlive: sql<number>`SUM(CASE WHEN ${prospects.id} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(contactImportRows)
      .leftJoin(contacts, and(
        eq(contacts.id, contactImportRows.contactId),
        eq(contacts.workspaceId, workspaceId),
      ))
      .leftJoin(prospects, and(
        eq(prospects.id, contactImportRows.prospectId),
        eq(prospects.workspaceId, workspaceId),
      ))
      .where(inArray(contactImportRows.importId, ids))
      .groupBy(contactImportRows.importId);

    const byImport = new Map(alive.map((r) => [r.importId, r]));
    for (const a of affected) {
      const row = byImport.get(a.importId);
      a.contactsStillPresent = Number(row?.contactsAlive ?? 0);
      a.prospectsStillPresent = Number(row?.prospectsAlive ?? 0);
    }
  }

  /* ── Layer B ── */
  const residue = { ...empty.residue };

  const contactRows = await db
    .select({
      companyName: contacts.companyName,
      linkedinUrl: contacts.linkedinUrl,
      email: contacts.email,
    })
    .from(contacts)
    .where(and(
      eq(contacts.workspaceId, workspaceId),
      or(
        and(isNotNull(contacts.companyName), ne(contacts.companyName, "")),
        and(isNotNull(contacts.linkedinUrl), ne(contacts.linkedinUrl, "")),
        and(isNotNull(contacts.email), ne(contacts.email, "")),
      ),
    ))
    .limit(RESIDUE_SCAN_CAP);

  for (const r of contactRows) {
    const url = companyNameLooksLikeUrl(r.companyName);
    if (url === "certain") residue.contactsCompanyNameIsUrl++;
    else if (url === "possible") residue.contactsCompanyNameMaybeUrl++;
    if (isCompanyLinkedInUrl(r.linkedinUrl)) residue.contactsLinkedInIsCompanyPage++;
    if (looksLikeVerificationVerdict(r.email)) residue.contactsEmailIsVerdict++;
  }

  const prospectRows = await db
    .select({
      company: prospects.company,
      linkedinUrl: prospects.linkedinUrl,
      email: prospects.email,
    })
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      or(
        and(isNotNull(prospects.company), ne(prospects.company, "")),
        and(isNotNull(prospects.linkedinUrl), ne(prospects.linkedinUrl, "")),
        and(isNotNull(prospects.email), ne(prospects.email, "")),
      ),
    ))
    .limit(RESIDUE_SCAN_CAP);

  for (const r of prospectRows) {
    const url = companyNameLooksLikeUrl(r.company);
    if (url === "certain") residue.prospectsCompanyIsUrl++;
    else if (url === "possible") residue.prospectsCompanyMaybeUrl++;
    if (isCompanyLinkedInUrl(r.linkedinUrl)) residue.prospectsLinkedInIsCompanyPage++;
    if (looksLikeVerificationVerdict(r.email)) residue.prospectsEmailIsVerdict++;
  }

  if (contactRows.length >= RESIDUE_SCAN_CAP || prospectRows.length >= RESIDUE_SCAN_CAP) {
    notes.push(
      `The row scan stopped at ${RESIDUE_SCAN_CAP.toLocaleString()} rows per table, so the ` +
      `"still looks wrong" counts are a floor, not a total.`,
    );
  }
  if (residue.contactsEmailIsVerdict > 0 || residue.prospectsEmailIsVerdict > 0) {
    notes.push(
      `An email field holds a verification verdict. The importer rejects those, so these ` +
      `rows did not come from a CSV import — find the other writer before repairing them.`,
    );
  }
  notes.push(
    `Mis-filed values that still look plausible — a city or an industry sitting in the ` +
    `company field — cannot be detected by inspection and are NOT in the row counts. ` +
    `Use the affected-import list for those.`,
  );

  return {
    clean: affected.length === 0,
    importsChecked: imports.length,
    affectedImports: affected,
    residue,
    notes,
  };
}
