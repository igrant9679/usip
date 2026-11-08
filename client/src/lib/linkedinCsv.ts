/**
 * Reading a CSV of LinkedIn profiles for the LinkedIn enrichment import
 * (audit 2026-10-20, P91).
 *
 * The page split the text on newlines and guessed columns from a short alias
 * list, so a quoted cell holding a line break broke its row in two, a header
 * spelled "Profile URL" or "Person Linkedin Url" read as no header at all, and
 * a LinkedIn connections export, which opens with a "Notes:" preamble, lost
 * every row. Now: one RFC 4180 reader (quotes, doubled quotes, line breaks
 * inside quotes, CRLF, a byte-order mark, and a comma, semicolon or tab
 * delimiter), the header found among the first rows, a guessed mapping the
 * person can change, and the rows built from that mapping.
 *
 * Pure and dependency-free, so a server test imports it directly.
 */

/** The most rows one batch takes (createBatch's input limit). */
export const MAX_BATCH_ROWS = 1000;

export type LinkedInImportField =
  "linkedinUrl" | "fullName" | "firstName" | "lastName" | "company" | "title" | "email" | "prospectId";

export type LinkedInImportRow = {
  linkedinUrl: string;
  fullName?: string; firstName?: string; lastName?: string;
  company?: string; title?: string; email?: string; prospectId?: number;
};

export const LINKEDIN_IMPORT_FIELDS: Array<{ key: LinkedInImportField; label: string; required?: boolean; aliases: string[] }> = [
  { key: "linkedinUrl", label: "LinkedIn profile URL", required: true, aliases: ["linkedin_url", "linkedinurl", "linkedin", "linkedin_profile", "linkedin_profile_url", "person_linkedin_url", "profile_url", "profile", "url"] },
  { key: "fullName", label: "Full name", aliases: ["full_name", "fullname", "name", "contact_name", "person_name"] },
  { key: "firstName", label: "First name", aliases: ["first_name", "firstname", "first", "given_name"] },
  { key: "lastName", label: "Last name", aliases: ["last_name", "lastname", "last", "surname", "family_name"] },
  { key: "company", label: "Company", aliases: ["company", "company_name", "account_name", "organization", "organisation", "employer"] },
  { key: "title", label: "Title", aliases: ["title", "job_title", "position", "headline", "role"] },
  { key: "email", label: "Email", aliases: ["email", "email_address", "work_email", "e_mail"] },
  { key: "prospectId", label: "Velocity prospect id", aliases: ["prospect_id", "prospectid", "velocity_id"] },
];

/** "Person Linkedin Url" → "person_linkedin_url". */
export function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The delimiter of the first line, counted outside quotes: comma, semicolon or tab. */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === "\n" || c === "\r")) break;
    else if (!inQ && c in counts) counts[c]++;
  }
  return counts[";"] > counts[","] && counts[";"] >= counts["\t"] ? ";" : counts["\t"] > counts[","] ? "\t" : ",";
}

/** Every record in the text, as trimmed cells. Records with no content are dropped. */
export function parseCsvRecords(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = detectDelimiter(text);
  const out: string[][] = [];
  let rec: string[] = [];
  let cell = "";
  let inQ = false;
  const endCell = () => { rec.push(cell.trim()); cell = ""; };
  const endRecord = () => {
    endCell();
    if (rec.some((c) => c !== "")) out.push(rec);
    rec = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) endCell();
    else if (c === "\r") { if (text[i + 1] === "\n") i++; endRecord(); }
    else if (c === "\n") endRecord();
    else cell += c;
  }
  if (cell !== "" || rec.length > 0) endRecord();
  return out;
}

const isLinkedInUrl = (v: string) => /linkedin\.com\/in\//i.test(v);
const urlAliases = LINKEDIN_IMPORT_FIELDS[0].aliases;

/**
 * Which record is the header: the first of the first ten that names a
 * LinkedIn column, or null when the file has none (bare URLs).
 */
export function findHeaderRow(records: string[][]): number | null {
  for (let i = 0; i < Math.min(records.length, 10); i++) {
    if (records[i].some((c) => urlAliases.includes(headerKey(c)))) return i;
  }
  return null;
}

/** Field → column, guessed from the headers; for a headerless file, the column holding the URLs. */
export function guessMapping(records: string[][], headerRow: number | null): Partial<Record<LinkedInImportField, number>> {
  const map: Partial<Record<LinkedInImportField, number>> = {};
  if (headerRow === null) {
    const first = records.find((r) => r.some(isLinkedInUrl));
    const col = first ? first.findIndex(isLinkedInUrl) : 0;
    map.linkedinUrl = col < 0 ? 0 : col;
    return map;
  }
  const keys = records[headerRow].map(headerKey);
  const taken = new Set<number>();
  for (const f of LINKEDIN_IMPORT_FIELDS) {
    // Alias order is preference order: "linkedin_url" before a bare "url".
    for (const a of f.aliases) {
      const i = keys.findIndex((k, idx) => k === a && !taken.has(idx));
      if (i >= 0) { map[f.key] = i; taken.add(i); break; }
    }
  }
  return map;
}

/** The columns a mapping can choose from, named as the file names them. */
export function columnNames(records: string[][], headerRow: number | null): string[] {
  const width = records.reduce((n, r) => Math.max(n, r.length), 0);
  return Array.from({ length: width }, (_, i) =>
    (headerRow !== null && records[headerRow][i]) || `Column ${i + 1}`);
}

/** The import rows: every record after the header with a value in the URL column. */
export function rowsFromMapping(
  records: string[][],
  headerRow: number | null,
  map: Partial<Record<LinkedInImportField, number>>,
): LinkedInImportRow[] {
  if (map.linkedinUrl === undefined) return [];
  const out: LinkedInImportRow[] = [];
  for (let i = headerRow === null ? 0 : headerRow + 1; i < records.length; i++) {
    const cells = records[i];
    const get = (k: LinkedInImportField) => (map[k] !== undefined ? cells[map[k]!] || undefined : undefined);
    const url = get("linkedinUrl");
    if (!url) continue;
    const pid = get("prospectId");
    out.push({
      linkedinUrl: url,
      fullName: get("fullName"), firstName: get("firstName"), lastName: get("lastName"),
      company: get("company"), title: get("title"), email: get("email"),
      prospectId: pid && /^\d+$/.test(pid) ? Number(pid) : undefined,
    });
  }
  return out;
}

/**
 * Up to two distinct values from each column, for the mapping step's choices
 * (audit 2026-10-20, U31): a column is picked by what it holds, not only by
 * what its header says.
 */
export function columnSamples(records: string[][], headerRow: number | null, max = 2): string[][] {
  const width = records.reduce((n, r) => Math.max(n, r.length), 0);
  const out: string[][] = Array.from({ length: width }, () => []);
  for (let i = headerRow === null ? 0 : headerRow + 1; i < records.length; i++) {
    records[i].forEach((v, c) => {
      const s = (v ?? "").trim();
      if (s && out[c].length < max && !out[c].includes(s)) out[c].push(s.length > 40 ? `${s.slice(0, 37)}…` : s);
    });
    if (out.every((x) => x.length >= max)) break;
  }
  return out;
}

/**
 * The first rows as the mapping reads them, before anything is sent (U31):
 * each data row with the value every mapped field takes, and whether it will
 * be imported (a row with no URL in the mapped column is left out, as
 * rowsFromMapping leaves it out) or looks wrong (a URL that is not a LinkedIn
 * profile, which the server will mark invalid).
 */
export function mappingPreview(
  records: string[][],
  headerRow: number | null,
  map: Partial<Record<LinkedInImportField, number>>,
  max = 5,
): { fields: LinkedInImportField[]; rows: Array<{ line: number; values: Partial<Record<LinkedInImportField, string>>; status: "ok" | "no_url" | "not_profile" }>; noUrl: number; notProfile: number } {
  const fields = LINKEDIN_IMPORT_FIELDS.map((f) => f.key).filter((k) => map[k] !== undefined);
  const rows: Array<{ line: number; values: Partial<Record<LinkedInImportField, string>>; status: "ok" | "no_url" | "not_profile" }> = [];
  let noUrl = 0;
  let notProfile = 0;
  for (let i = headerRow === null ? 0 : headerRow + 1; i < records.length; i++) {
    const cells = records[i];
    if (cells.every((c) => !(c ?? "").trim())) continue;
    const values: Partial<Record<LinkedInImportField, string>> = {};
    for (const k of fields) values[k] = (cells[map[k]!] ?? "").trim();
    const url = values.linkedinUrl ?? "";
    const status = !url ? "no_url" as const : isLinkedInUrl(url) ? "ok" as const : "not_profile" as const;
    if (status === "no_url") noUrl++;
    if (status === "not_profile") notProfile++;
    if (rows.length < max) rows.push({ line: i + 1, values, status });
  }
  return { fields, rows, noUrl, notProfile };
}
