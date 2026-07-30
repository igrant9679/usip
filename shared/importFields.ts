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

export interface ContactImportField {
  key: string;
  label: string;
  required: boolean;
}

export const CONTACT_IMPORT_FIELDS: ContactImportField[] = [
  { key: "firstName", label: "First Name", required: true },
  { key: "lastName", label: "Last Name", required: true },
  { key: "email", label: "Email", required: false },
  { key: "phone", label: "Phone", required: false },
  { key: "title", label: "Job Title", required: false },
  { key: "company", label: "Company", required: false },
  { key: "linkedinUrl", label: "LinkedIn URL", required: false },
  { key: "website", label: "Website", required: false },
  { key: "industry", label: "Industry", required: false },
  { key: "city", label: "City", required: false },
  { key: "state", label: "State / Region", required: false },
  { key: "country", label: "Country", required: false },
  { key: "seniority", label: "Seniority", required: false },
];

export const CONTACT_IMPORT_FIELD_KEYS: string[] = CONTACT_IMPORT_FIELDS.map((f) => f.key);

export const REQUIRED_CONTACT_IMPORT_FIELDS: ContactImportField[] =
  CONTACT_IMPORT_FIELDS.filter((f) => f.required);
