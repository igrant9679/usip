/**
 * Bridge between the registry's vocabulary and the two consumers that
 * predate it: ARE campaign targeting (titles/industries/geos/keywords) and
 * the prospect_queue / raw-find row shape the engine and Find Prospects
 * persist. Pure functions.
 */
import { emptyCriteria, type SearchCriteria } from "@shared/prospectSources";
import { icpLabels } from "@shared/icpShape";
import type { ProspectRecord } from "./types";

/** Country names → ISO codes the vendors filter on. Unmapped geos stay as
 *  state/city text — never guessed into a country. */
/** Exported for @see services/placeFit, which needs the same vocabulary.
 *  NOTE: services/quickenrich.ts holds a byte-identical private copy of this
 *  table (noted 2026-10-30, not merged here: that file is a live vendor path
 *  and this was not the change to destabilise it). */
export const COUNTRY_CODES: Record<string, string> = {
  "united states": "US", usa: "US", us: "US", america: "US", "united states of america": "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB",
  canada: "CA", australia: "AU", ireland: "IE", "new zealand": "NZ",
  germany: "DE", france: "FR", netherlands: "NL", spain: "ES", italy: "IT",
  sweden: "SE", norway: "NO", denmark: "DK", switzerland: "CH", belgium: "BE",
  india: "IN", singapore: "SG",
};

const US_STATE_NAMES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia","hawaii","idaho",
  "illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi",
  "missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio",
  "oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","utah","vermont","virginia",
  "washington","west virginia","wisconsin","wyoming","district of columbia",
];
const CA_PROVINCE_NAMES = [
  "ontario","quebec","british columbia","alberta","manitoba","saskatchewan","nova scotia","new brunswick","newfoundland and labrador",
  "prince edward island",
];
const US_STATES = new Set(US_STATE_NAMES.concat(CA_PROVINCE_NAMES));

/** The country a bare state or province name lies in ("Virginia" → US, "Ontario" → CA), else null. */
export function regionCountry(name: string): "US" | "CA" | null {
  const n = name.trim().toLowerCase();
  if (US_STATE_NAMES.indexOf(n) !== -1) return "US";
  if (CA_PROVINCE_NAMES.indexOf(n) !== -1) return "CA";
  return null;
}

export function criteriaFromTargeting(t: { titles?: unknown; industries?: unknown; geos?: unknown; keywords?: unknown }): SearchCriteria {
  const c = emptyCriteria();
  // Labels through the shared ICP reader: campaign strings and the inferred
  // ICP's weighted objects alike (2026-10-14: `String(x)` sent vendors
  // "[object Object]" as a job title).
  c.jobTitles = icpLabels(t.titles, "title");
  c.industries = icpLabels(t.industries, "industry");
  c.keywords = icpLabels(t.keywords, "signal");
  const addCountry = (code: string) => { if (c.countries.indexOf(code) === -1) c.countries.push(code); };
  const addPlace = (g: string) => {
    if (US_STATES.has(g.toLowerCase())) { c.stateProvinces.push(g); return; }
    c.cities.push(g);
  };
  const geos = icpLabels(t.geos, "geography");
  for (let i = 0; i < geos.length; i++) {
    const g = geos[i];
    const code = COUNTRY_CODES[g.toLowerCase()];
    if (code) { addCountry(code); continue; }
    if (/^[A-Za-z]{2}$/.test(g)) { addCountry(g.toUpperCase()); continue; }
    // "Kentucky, United States": the inferred ICP's {region, country}. Only a
    // country NAME after the comma counts ("Austin, TX" stays a city).
    const comma = g.lastIndexOf(",");
    const tailCode = comma > 0 ? COUNTRY_CODES[g.slice(comma + 1).trim().toLowerCase()] : undefined;
    if (tailCode) {
      addCountry(tailCode);
      const region = g.slice(0, comma).trim();
      if (region) addPlace(region);
      continue;
    }
    addPlace(g);
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
