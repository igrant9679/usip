/**
 * prospectPoolSeed — the platform owner's starting figures for each pool
 * source (owner answers, 2026-11-25). A source with no
 * `prospect_pool_sources` row reads these; the first change the owner makes
 * to a source writes its row, filled from here, and from then on the row is
 * what counts (an emptied ceiling then means "not set").
 *
 *   - SHARED BY DEFAULT: the owner accepted the vendor-terms risk, so every
 *     pool source is shared with all workspaces once the pool workspace is
 *     named and holds a key for it. The per-source switch still turns one off.
 *   - CEILINGS: each vendor account's real monthly allowance. QuickEnrich is
 *     6,000 credits; LeadOcean ≈ 214,000 enrichments (50,000 a week); A-Leads
 *     100,000 credits; CluGTM 25,000 records (10,000 a week). WarmySender and
 *     Apollo are unknown: unset until the owner enters them.
 *   - DESCRIPTIONS: approved by the owner word for word; no vendor names.
 *   - NUMBERS: follow the ceilings, highest first, until the owner sets one;
 *     a source whose ceiling is entered later takes its place. Apollo is always
 *     last, because it reveals no contacts, and is never the default while
 *     another source has room.
 *
 * Server-only: members read a description, never which vendor it belongs to.
 * The A-Leads and CluGTM rows wait for their adapters; a slug with no adapter
 * in the registry is never listed.
 */

export type PoolSeed = {
  monthlyCeiling: number | null;
  description: string;
};

export const POOL_SOURCE_SEED: Readonly<Record<string, PoolSeed>> = {
  leadocean: {
    monthlyCeiling: 214_000,
    description: "Over a billion profiles at 73 million companies, with a deliverability status on every email.",
  },
  aleads: {
    monthlyCeiling: 100_000,
    description: "Verified B2B contacts, checked for catch-all domains.",
  },
  clugtm: {
    monthlyCeiling: 25_000,
    description: "Over a billion profiles drawn from more than 25 providers and refreshed every 30 days.",
  },
  quickenrich: {
    monthlyCeiling: 6_000,
    description: "Contact details matched to LinkedIn profiles, with emails and phone numbers.",
  },
  warmysender: {
    monthlyCeiling: null,
    description: "A database of over 200 million B2B contacts in the US and Canada.",
  },
  apollo: {
    monthlyCeiling: null,
    description: "People and company search by title, seniority and company size; emails are found separately.",
  },
};

/** Every pool source is shared by default (owner, 2026-11-25); the switch turns one off. */
export const SHARED_BY_DEFAULT = true;

/** Sources numbered after every other and chosen as the default only when nothing else has room. */
export const ALWAYS_LAST_SOURCES: readonly string[] = ["apollo"];

export function seedFor(slug: string): PoolSeed | null {
  return POOL_SOURCE_SEED[slug] ?? null;
}
