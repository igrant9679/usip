/**
 * Mapping presets for the one importer (audit 2026-10-20, F32).
 *
 * LeadRocks exports had their own importer (routers/prospectImports.ts) with
 * its own parse, dedupe and insert, and no error report, history or undo. It
 * is a preset of the CSV importer now: a LeadRocks file is read into the
 * importer's own columns (the best of its fourteen email slots by LeadRocks'
 * confidence, the first phone, the location split into city, state and
 * country, the website as the company's domain), and from there it is the
 * same validation, duplicate check, error report, history and undo as any
 * other file. One row out for every row in, so row numbers in the error
 * report are the file's.
 *
 * LeadRocks' own verdict on the address it picked is kept in the person's
 * field provenance and NOT stored as the email status: an address arrives
 * unverified, and Velocity's own verification decides it before anything can
 * promote or send to it (outbound safety, 2026-11-07).
 */
import { looksLikeLeadRocks, mapLeadRocksRow } from "./leadrocks";
import type { ImportPreset } from "./importFiles";

/** The importer columns a LeadRocks file is read into, named as the mapping step shows them. */
export const LEADROCKS_COLUMNS = {
  firstName: "First Name",
  lastName: "Last Name",
  linkedinUrl: "LinkedIn URL",
  title: "Job Title",
  company: "Company",
  website: "Website",
  industry: "Industry",
  city: "City",
  state: "State / Region",
  country: "Country",
  email: "Email",
  phone: "Phone",
} as const;

export type PresetExtra = { emailRawStatus: string | null; emailSource: "work" | "direct" | null } | null;

export type PresetResult = {
  headers: string[];
  rows: Record<string, string>[];
  /** Per row, what the preset knows that no column holds. */
  extras: PresetExtra[];
  /** The mapping the preset implies: every column to its own field. */
  mapping: Record<string, string>;
  /** Fields the preset insists on, beyond the destination's. */
  requiredFields: string[];
};

export function detectPreset(headers: string[]): ImportPreset | null {
  return looksLikeLeadRocks(headers) ? "leadrocks" : null;
}

const findHeader = (headers: string[], label: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "").replace(/#/g, "");
  return headers.find((h) => norm(h) === norm(label)) ?? null;
};

export function applyPreset(preset: ImportPreset, headers: string[], rows: Record<string, string>[]): PresetResult {
  if (preset !== "leadrocks") throw new Error(`Unknown import preset ${preset}`);
  const C = LEADROCKS_COLUMNS;
  const firstCol = findHeader(headers, "First Name");
  const lastCol = findHeader(headers, "Last Name");
  const companyCol = findHeader(headers, "Company");
  const outRows: Record<string, string>[] = [];
  const extras: PresetExtra[] = [];
  for (const r of rows) {
    const m = mapLeadRocksRow(r, headers);
    if (!m) {
      // Not importable as LeadRocks reads it (no name or no profile URL): the
      // row goes through as far as it can, so the report names what is missing.
      outRows.push({
        [C.firstName]: firstCol ? (r[firstCol] ?? "").trim() : "",
        [C.lastName]: lastCol ? (r[lastCol] ?? "").trim() : "",
        [C.linkedinUrl]: (r[findHeader(headers, "Linked Url") ?? ""] ?? r[findHeader(headers, "LinkedIn URL") ?? ""] ?? "").trim(),
        [C.title]: "", [C.company]: companyCol ? (r[companyCol] ?? "").trim() : "", [C.website]: "", [C.industry]: "",
        [C.city]: "", [C.state]: "", [C.country]: "", [C.email]: "", [C.phone]: "",
      });
      extras.push(null);
      continue;
    }
    outRows.push({
      [C.firstName]: m.firstName,
      [C.lastName]: m.lastName,
      [C.linkedinUrl]: m.linkedinUrl,
      [C.title]: m.title ?? "",
      [C.company]: m.company ?? "",
      [C.website]: m.companyDomain ?? "",
      [C.industry]: m.industry ?? "",
      [C.city]: m.city ?? "",
      [C.state]: m.state ?? "",
      [C.country]: m.country ?? "",
      [C.email]: m.email ?? "",
      [C.phone]: m.phone ?? "",
    });
    extras.push({ emailRawStatus: m.emailRawStatus, emailSource: m.emailSource });
  }
  const mapping: Record<string, string> = {};
  for (const [field, header] of Object.entries(C)) mapping[header] = field;
  return { headers: Object.values(C), rows: outRows, extras, mapping, requiredFields: ["linkedinUrl"] };
}
