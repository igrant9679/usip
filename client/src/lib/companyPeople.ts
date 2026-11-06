/**
 * Who "Add N people to…" on a company profile puts into outreach.
 *
 * The People section lists two kinds of row (services/company/profileService
 * getCompanyContacts): People rows (`prospect`) and legacy CRM contacts
 * (`contact`). Their ids are separate sequences, so the same integer names two
 * different people. The menu sent every id as a contact id, and People row 42
 * enrolled whichever contact was 42 (audit 2026-10-20, R3).
 *
 * Each kind goes in its own list, each id once, and a contact that is a listed
 * People row's own linked contact is left out: that is the same person, and
 * the People row is the one outreach works.
 */
export type CompanyPersonRow = {
  kind: "prospect" | "contact" | string;
  id: number;
  linkedContactId?: number | null;
};

export function companyOutreachTargets(rows: readonly CompanyPersonRow[]): {
  prospectIds: number[];
  contactIds: number[];
  count: number;
} {
  const prospects = rows.filter((r) => r.kind === "prospect");
  const prospectIds = Array.from(new Set(prospects.map((r) => r.id)));
  const covered = new Set(prospects.map((r) => r.linkedContactId).filter((id): id is number => id != null));
  const contactIds = Array.from(new Set(rows.filter((r) => r.kind === "contact" && !covered.has(r.id)).map((r) => r.id)));
  return { prospectIds, contactIds, count: prospectIds.length + contactIds.length };
}
