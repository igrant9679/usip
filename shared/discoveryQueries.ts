/**
 * The searches a person discovery search makes (audit 2026-10-20, A56).
 *
 * The Scraper tab's launcher searched only the campaign's first title,
 * industry and place. A campaign launch now passes every one: Apollo and
 * QuickEnrich take the lists in their one search each; LinkedIn, a text
 * search, takes them paired in step (personQueries), so every value is in at
 * least one search and the count is the longest list's, capped. The launcher
 * counts the searches with the same functions before it asks to run.
 */

type PersonLists = {
  jobTitle?: string; industry?: string; location?: string;
  jobTitles?: string[]; industries?: string[]; locations?: string[];
  seniority?: string; department?: string; companyName?: string; keywords?: string[];
};

/** Searches one campaign launch makes on LinkedIn at most; the rest of its pairs wait for the next launch (A56). */
export const CAMPAIGN_RUN_MAX_QUERIES = 10;

/** The titles, industries and places a person search names, single fields and lists together, each once. */
export function personLists(p: PersonLists): { titles: string[]; industries: string[]; locations: string[] } {
  const uniq = (xs: Array<string | undefined>) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of xs) {
      const v = String(x ?? "").trim();
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      out.push(v);
    }
    return out;
  };
  return {
    titles: uniq([p.jobTitle, ...(p.jobTitles ?? [])]),
    industries: uniq([p.industry, ...(p.industries ?? [])]),
    locations: uniq([p.location, ...(p.locations ?? [])]),
  };
}

/**
 * The text searches a person search makes (LinkedIn), so that every title,
 * industry and place it names is in at least one (A56). The lists are paired
 * in step — search i takes the i-th title, industry and place, the shorter
 * lists going round again — so it takes as many searches as the longest list,
 * not their product, and at most CAMPAIGN_RUN_MAX_QUERIES. `total` is how many
 * it would take without the cap.
 */
export function personQueries(p: PersonLists): { queries: string[]; total: number } {
  // A plain search (no lists) is the one query it always was, word for word.
  if (!p.jobTitles?.length && !p.industries?.length && !p.locations?.length) {
    const q = [p.jobTitle, p.seniority, p.department, p.companyName, p.industry, p.location, ...(p.keywords ?? [])].filter(Boolean).join(" ").trim();
    return { queries: q ? [q] : [], total: 1 };
  }
  const { titles, industries, locations } = personLists(p);
  const n = Math.max(titles.length, industries.length, locations.length, 1);
  const tail = [p.seniority, p.department, p.companyName, ...(p.keywords ?? [])].filter((x): x is string => !!x && !!String(x).trim());
  const queries: string[] = [];
  for (let i = 0; i < Math.min(n, CAMPAIGN_RUN_MAX_QUERIES); i++) {
    const q = [titles.length ? titles[i % titles.length] : undefined, industries.length ? industries[i % industries.length] : undefined, locations.length ? locations[i % locations.length] : undefined, ...tail]
      .filter(Boolean).join(" ").trim();
    if (q && !queries.includes(q)) queries.push(q);
  }
  return { queries, total: n };
}

/** LinkedIn searches a launch with these lists makes: the longest list, at most the cap. */
export function campaignLaunchSearches(lists: { titles: string[]; industries: string[]; places: string[] }): { searches: number; total: number } {
  const total = Math.max(lists.titles.length, lists.industries.length, lists.places.length, 1);
  return { searches: Math.min(total, CAMPAIGN_RUN_MAX_QUERIES), total };
}
