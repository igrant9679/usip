/**
 * Domain scrape cache — 30-day TTL.
 *
 * When 100 prospects share the same company domain, scraping acme.com 100
 * times is wasteful and rude. This cache memoizes the parsed result keyed
 * by domain. TTL is 30 days; refresh happens lazily on the next miss.
 *
 * Cache shape mirrors `ScrapedSite` exactly so caller code is identical
 * whether the data is hot or cold.
 */
import { eq, and, gt, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { domainScrapeCache } from "../../../drizzle/schema";
import type { ScrapedSite } from "./companySite";

const TTL_DAYS = 30;

export async function readDomainCache(domain: string): Promise<ScrapedSite | null> {
  const db = await getDb();
  if (!db) return null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TTL_DAYS);
  const [row] = await db
    .select()
    .from(domainScrapeCache)
    .where(
      and(
        eq(domainScrapeCache.domain, domain),
        gt(domainScrapeCache.scrapedAt, cutoff),
      ),
    )
    .limit(1);
  if (!row) return null;
  return row.result as ScrapedSite;
}

export async function writeDomainCache(
  domain: string,
  result: ScrapedSite,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // Upsert: domain is the primary key
  await db
    .insert(domainScrapeCache)
    .values({ domain, result, scrapedAt: new Date() })
    .onDuplicateKeyUpdate({
      set: { result, scrapedAt: sql`now()` },
    });
}
