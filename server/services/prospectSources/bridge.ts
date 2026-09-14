/**
 * Bridge between the registry's vocabulary and the two consumers that
 * predate it: ARE campaign targeting (titles/industries/geos/keywords) and
 * the prospect_queue / raw-find row shape the engine and Find Prospects
 * persist. Pure functions.
 */
import { emptyCriteria, type SearchCriteria } from "@shared/prospectSources";
import type { ProspectRecord } from "./types";

/** Country names → ISO codes the vendors filter on. Unmapped geos stay as
 *  state/city text — never guessed into a country. */
const COUNTRY_CODES: Record<string, string> = {
  "united states": "US", usa: "US", us: "US", america: "US", "united states of america": "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB",
  canada: "CA", australia: "AU", ireland: "IE", "new zealand": "NZ",
  germany: "DE", france: "FR", netherlands: "NL", spain: "ES", italy: "IT",
  sweden: "SE", norway: "NO", denmark: "DK", switzerland: "CH", belgium: "BE",
  india: "IN", singapore: "SG",
};

const US_STATES = new Set([
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia","hawaii","idaho",
  "illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi",
  "missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio",
  "oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","utah","vermont","virginia",
  "washington","west virginia","wisconsin","wyoming","district of columbia",
  "ontario","quebec","british columbia","alberta","manitoba","saskatchewan","nova scotia","new brunswick","newfoundland and labrador",
  "prince edward island",
]);

export function criteriaFromTargeting(t: { titles?: string[]; industries?: string[]; geos?: string[]; keywords?: string[] }): SearchCriteria {
  const c = emptyCriteria();
  const clean = (xs?: string[]) => (xs ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  c.jobTitles = clean(t.titles);
  c.industries = clean(t.industries);
  c.keywords = clean(t.keywords);
  const geos = clean(t.geos);
  for (let i = 0; i < geos.length; i++) {
    const g = geos[i];
    const code = COUNTRY_CODES[g.toLowerCase()];
    if (code) { if (c.countries.indexOf(code) === -1) c.countries.push(code); continue; }
    if (/^[A-Za-z]{2}$/.test(g)) { if (c.countries.indexOf(g.toUpperCase()) === -1) c.countries.push(g.toUpperCase()); continue; }
    if (US_STATES.has(g.toLowerCase())) { c.stateProvinces.push(g); continue; }
    c.cities.push(g);
  }
  // A US state or city with no country is still a US/CA query for the
  // vendors whose coverage is US/CA; leave countries empty so global
  // vendors are not restricted.
  return c;
}

/** ProspectRecord → the raw row shape saveScrapeJobAndQueue / toRawFindRow accept. */
export function recordToQueueRow(r: ProspectRecord): Record<string, unknown> {
  const geography = [r.city, r.stateProvince, r.country].filter(Boolean).join(", ");
  return {
    firstName: r.firstName,
    lastName: r.lastName,
    title: r.jobTitle,
    // A masked preview is never an email (a stored mask looks deliverable
    // to dispatch and mails the void).
    email: r.emailIsMasked ? null : r.email,
    linkedinUrl: r.linkedinUrl,
    phone: r.businessPhone ?? r.mobilePhone,
    companyName: r.companyName,
    companyDomain: r.companyDomain,
    companySize: r.headcount,
    industry: r.industry,
    geography: geography || null,
    sourceUrl: r.linkedinUrl ?? "",
    externalId: r.externalId,
  };
}
