/**
 * importFields.ts — the ONE definition of the contact-importer's field list.
 *
 * There were two, and they disagreed. `server/routers/imports.ts` declared 14
 * fields; `client/src/pages/usip/ImportContacts.tsx` declared 13 under a comment
 * reading "mirrors backend SYSTEM_FIELDS". It did not:
 *
 *   • the server had a 14th field, `tags` ("Tags (comma-separated)"), that the
 *     client never offered — and that NOTHING writes. `contacts` has no tags
 *     column (only `leads` and `help_articles` do), `buildContactValues` ignores
 *     `mapped.tags`, and since business fields were moved out of the
 *     `customFields` blob it is not even preserved there. A mapping to it is
 *     accepted and silently dropped.
 *   • the two lists were in a different ORDER, and order is load-bearing: the
 *     client's auto-mapper takes the FIRST fuzzy match, so which field a header
 *     like "Company Website" lands on depends on the list it happens to read.
 *   • `parseCSV` returns `systemFields` to the client, which ignores it in favour
 *     of its own copy — so the server's list was doing nothing except being
 *     wrong in a second place.
 *
 * Worse than cosmetic: the client builds the mapping dropdown from ITS list
 * while the server validates required fields against ITS list. They agree on
 * firstName/lastName today, so no live bug — but a `required` flag added to one
 * side would reject a mapping the UI never allowed the user to make.
 *
 * Rule going forward, same as areSources.ts: a field may appear here ONLY if the
 * importer writes it to a real column. If you add one, add its line in
 * `buildContactValues` in the same commit — a mapping option that discards the
 * column is worse than no option, because the import still reports success.
 */

/** Where an import lands. Mirrors the `destination` input on both procedures. */
export type ImportDestination = "contacts" | "prospects";

export interface ContactImportField {
  key: string;
  label: string;
  /**
   * Destinations where this column must be mapped AND carry a value on every
   * row. Empty means optional everywhere.
   */
  requiredFor: ImportDestination[];
}

const BOTH: ImportDestination[] = ["contacts", "prospects"];

/**
 * ⚠️ **`email` IS REQUIRED FOR `contacts` AND DELIBERATELY NOT FOR
 * `prospects`.** A CRM contact with no address cannot be sequenced, so
 * requiring one there is what was asked for and what the product means. The
 * `prospects` backlog is the opposite case BY DESIGN: it exists to hold people
 * whose address is not known yet, and the enrichment sweeper's whole job is to
 * find one and promote them. Requiring an email there would reject exactly the
 * rows the destination was built for and make the sweeper unreachable from an
 * import.
 *
 * `company` is required for BOTH, and for prospects it is load-bearing rather
 * than tidiness: the free domain pass resolves a company NAME to a domain, and
 * the email finder needs that domain. A prospect with no company is not
 * workable by any pass in the pipeline.
 */
export const CONTACT_IMPORT_FIELDS: ContactImportField[] = [
  { key: "firstName", label: "First Name", requiredFor: BOTH },
  { key: "lastName", label: "Last Name", requiredFor: BOTH },
  { key: "email", label: "Email", requiredFor: ["contacts"] },
  { key: "phone", label: "Phone", requiredFor: [] },
  { key: "title", label: "Job Title", requiredFor: [] },
  { key: "company", label: "Company", requiredFor: BOTH },
  { key: "linkedinUrl", label: "LinkedIn URL", requiredFor: [] },
  { key: "website", label: "Website", requiredFor: [] },
  { key: "industry", label: "Industry", requiredFor: [] },
  { key: "city", label: "City", requiredFor: [] },
  { key: "state", label: "State / Region", requiredFor: [] },
  { key: "country", label: "Country", requiredFor: [] },
  { key: "seniority", label: "Seniority", requiredFor: [] },
];

export const CONTACT_IMPORT_FIELD_KEYS: string[] = CONTACT_IMPORT_FIELDS.map((f) => f.key);

export function isFieldRequiredFor(field: ContactImportField, destination: ImportDestination): boolean {
  return field.requiredFor.includes(destination);
}

/** The fields a given destination insists on, in display order. */
export function requiredFieldsFor(destination: ImportDestination): ContactImportField[] {
  return CONTACT_IMPORT_FIELDS.filter((f) => isFieldRequiredFor(f, destination));
}

export function requiredFieldKeysFor(destination: ImportDestination): string[] {
  return requiredFieldsFor(destination).map((f) => f.key);
}

/**
 * Required fields with no column mapped to them.
 *
 * The mapping-level half of the rule — the row-level half lives in
 * `classifyImportRow`. Both halves are needed and neither implies the other: a
 * mapped column can still be empty on a given row, and an unmapped required
 * field would otherwise fail every row one at a time instead of saying once
 * that the mapping is incomplete.
 */
export function missingRequiredMappings(
  mapping: Record<string, string | null>,
  destination: ImportDestination,
): ContactImportField[] {
  // `filter(Boolean)` is type narrowing, not a rule: no field key is null, so
  // letting nulls into the set could never change an answer. Recorded because a
  // mutation removing it survives, and an unexplained equivalent mutant looks
  // like a coverage hole to whoever audits this next.
  const mapped = new Set(Object.values(mapping).filter(Boolean) as string[]);
  return requiredFieldsFor(destination).filter((f) => !mapped.has(f.key));
}

/* ─── Header → field matching ────────────────────────────────────────────── */

/**
 * Strip a CSV header down to its comparable form. Case, spaces, punctuation and
 * a leading BOM all vary between exporters and mean nothing.
 */
export function normalizeHeader(header: string): string {
  // No explicit BOM strip: U+FEFF is not [a-z0-9], so the class below already
  // removes it. An earlier version stripped it separately and a mutation test
  // proved that line could never fail — dead code in a guard's path is worse
  // than absent, because it reads as protection. (`uniqueHeaders` in
  // services/csv.ts DOES need its own strip: it preserves the header verbatim
  // as an object key rather than normalising it.)
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Extra spellings a header may use for a field, beyond its own label and key.
 *
 * ⚠️ THIS IS AN ALLOWLIST, AND THAT IS THE WHOLE POINT. It replaced a
 * bidirectional substring matcher:
 *
 *   normalized.includes(kNorm) || kNorm.includes(normalized)
 *
 * which mapped **`Email Status` onto `email`**, because "emailstatus" contains
 * "email". On a verified-email export — where that column holds `valid` /
 * `unknown` / `catch-all`, not an address — every row then failed validation
 * with "Invalid email format: valid". Worse, when the file ALSO had a real
 * `Email` column both headers mapped to `email` and `mapRowToContact` kept
 * whichever came LAST in the file, so the verdict silently overwrote the
 * address. Reported from a live 200-row import, 2026-08-06; reproduced exactly.
 *
 * It mis-mapped plenty besides: `Company Website` and `Company Domain` → the
 * `company` NAME field, `Company Phone` → the contact's `phone`, `Company City`
 * → `company`. Substring similarity is not evidence that two columns mean the
 * same thing.
 *
 * RULE FOR ADDING ONE: an alias must be a spelling of *this contact's* value.
 * `Company Linkedin Url`, `Company Phone` and `Company City` are deliberately
 * ABSENT — they describe the employer, not the person, and there is nowhere
 * correct to put them. An unmatched header maps to nothing and is shown as
 * "Skip this column", which is visible and harmless; a wrong match is neither.
 */
export const HEADER_ALIASES: Record<string, string> = {
  // firstName — "firstname" itself is the normalised LABEL, matched directly
  first: "firstName", fname: "firstName", givenname: "firstName", forename: "firstName",
  // lastName
  last: "lastName", lname: "lastName", surname: "lastName", familyname: "lastName",
  // email — note NOTHING here is a verification-status column
  emailaddress: "email", workemail: "email", businessemail: "email", personalemail: "email",
  primaryemail: "email", emailaddresses: "email",
  // phone — the person's, never the switchboard
  phonenumber: "phone", mobile: "phone", mobilephone: "phone", mobilenumber: "phone",
  workphone: "phone", workdirectphone: "phone", directphone: "phone", telephone: "phone",
  cell: "phone", cellphone: "phone",
  // title — "jobtitle" is the normalised label, matched directly
  position: "title", role: "title", currenttitle: "title", jobrole: "title",
  // company
  companyname: "company", organization: "company", organisation: "company",
  employer: "company", accountname: "company", currentcompany: "company",
  // linkedinUrl — the PERSON's profile
  linkedin: "linkedinUrl", linkedinprofile: "linkedinUrl", linkedinprofileurl: "linkedinUrl",
  personlinkedinurl: "linkedinUrl", linkedinlink: "linkedinUrl",
  // website — the employer's site is the right home for these
  companywebsite: "website", companydomain: "website", domain: "website",
  websiteurl: "website", companyurl: "website", web: "website",
  // industry
  companyindustry: "industry", sector: "industry", vertical: "industry",
  // city / state / country — the CONTACT's location
  town: "city", locationcity: "city",
  region: "state", province: "state", locationstate: "state", stateprovince: "state",
  locationcountry: "country",
  // seniority
  senioritylevel: "seniority", level: "seniority",
};

/**
 * Which field a header maps to, or null.
 *
 * Exact matches only: the field's own label, its key, or an explicit alias.
 * There is no fuzzy fallback on purpose — see HEADER_ALIASES.
 */
export function matchHeaderToField(header: string): string | null {
  const n = normalizeHeader(header);
  if (!n) return null;
  const direct = CONTACT_IMPORT_FIELDS.find(
    (f) => n === normalizeHeader(f.label) || n === f.key.toLowerCase(),
  );
  if (direct) return direct.key;
  return HEADER_ALIASES[n] ?? null;
}

/**
 * Auto-map a whole header row.
 *
 * **At most one column per field**, first occurrence in file order winning.
 * A file carrying both `Work Email` and `Personal Email` maps the first and
 * leaves the second unmapped rather than quietly letting the later column
 * overwrite the earlier one inside `mapRowToContact` — which is the same
 * last-write-wins hazard the substring matcher turned into a live bug. The
 * skipped column is still listed in the mapping table, so the user can see it
 * and choose it instead.
 */
export function autoMapHeaders(headers: string[]): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const taken = new Set<string>();
  for (const h of headers) {
    const field = matchHeaderToField(h);
    if (field && !taken.has(field)) {
      taken.add(field);
      mapping[h] = field;
    } else {
      mapping[h] = null;
    }
  }
  return mapping;
}

/**
 * Fields that more than one column claims.
 *
 * `mapRowToContact` assigns in mapping order with no merge step, so a field
 * claimed twice keeps ONE column's value and discards the other with no error
 * — invisible in every summary the importer produces. Both the mapping UI and
 * the server refuse a mapping in this state rather than picking for the user.
 *
 * `uniqueHeaders` already solved the neighbouring problem (two columns sharing
 * a *header*); this is two different headers claiming the same *field*.
 */
export function findDuplicateFieldMappings(
  mapping: Record<string, string | null>,
): Array<{ field: string; label: string; headers: string[] }> {
  // A plain record rather than a Map: this file is consumed by both the server
  // and the browser bundle, and the project's tsc target rejects iterating a
  // Map without --downlevelIteration.
  const byField: Record<string, string[]> = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (!field) continue;
    byField[field] = [...(byField[field] ?? []), header];
  }
  const out: Array<{ field: string; label: string; headers: string[] }> = [];
  for (const [field, headers] of Object.entries(byField)) {
    if (headers.length < 2) continue;
    out.push({
      field,
      label: CONTACT_IMPORT_FIELDS.find((f) => f.key === field)?.label ?? field,
      headers,
    });
  }
  return out;
}

/** Shared wording, so the UI and the server's error say the same thing. */
export function describeDuplicateMappings(
  dupes: Array<{ label: string; headers: string[] }>,
): string {
  return dupes
    .map((d) => `${d.label} ← ${d.headers.map((h) => `"${h}"`).join(", ")}`)
    .join("; ");
}
