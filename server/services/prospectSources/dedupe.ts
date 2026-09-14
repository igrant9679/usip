/**
 * Dedupe for the waterfall — runs BEFORE any billable acquisition.
 *
 * Keys, strongest first (one vocabulary with services/are/queueIdentity, so
 * a person the campaign queue already knows is the same person here):
 *   e:<email>         — only when the email is real; a masked preview
 *                       ("j***@acme.com") is never an identity
 *   u:<linkedin slug> — URL-shape tolerant
 *   n:<name@domain>   — canonical name + company domain
 *   n:<name@company>  — canonical name + company name (exact after
 *                       normalisation; never edit-distance — two different
 *                       people at one company must not merge)
 *
 * With masked previews keys 2–4 are all there is, which is why the LinkedIn
 * URL and name+domain keys matter: they are what stops paying twice for a
 * person QuickEnrich already found.
 *
 * The index covers the workspace's People (`prospects`) AND its campaign
 * queue (`prospect_queue`), plus everything collected earlier in the same
 * run.
 */
import { eq } from "drizzle-orm";
import { prospects } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { queueIdentityKeys, workspaceQueueIdentityIndex } from "../are/queueIdentity";
import type { ProspectRecord } from "./types";

export function dedupeKeysFor(r: ProspectRecord): string[] {
  return queueIdentityKeys({
    email: r.emailIsMasked ? null : r.email,
    linkedinUrl: r.linkedinUrl,
    firstName: r.firstName,
    lastName: r.lastName,
    companyName: r.companyName,
    companyDomain: r.companyDomain,
  });
}

export class Deduper {
  private readonly known: Set<string>;
  constructor(seed?: Iterable<string>) {
    this.known = new Set<string>();
    if (seed) {
      const it = Array.from(seed);
      for (let i = 0; i < it.length; i++) this.known.add(it[i]);
    }
  }
  /** Is this record new to the workspace AND to this run? Returns the key that matched, if any. */
  check(r: ProspectRecord): { netNew: boolean; key: string | null; keys: string[] } {
    const keys = dedupeKeysFor(r);
    for (let i = 0; i < keys.length; i++) if (this.known.has(keys[i])) return { netNew: false, key: keys[i], keys };
    return { netNew: true, key: keys[0] ?? null, keys };
  }
  claim(keys: string[]): void {
    for (let i = 0; i < keys.length; i++) this.known.add(keys[i]);
  }
  size(): number { return this.known.size; }
}

/** Seed a Deduper with every identity the workspace already holds. */
export async function workspaceDeduper(workspaceId: number): Promise<Deduper> {
  const d = new Deduper();
  const queue = await workspaceQueueIdentityIndex(workspaceId);
  d.claim(Array.from(queue.keys()));
  const db = await getDb();
  if (!db) return d;
  const people = await db
    .select({
      email: prospects.email, linkedinUrl: prospects.linkedinUrl, firstName: prospects.firstName,
      lastName: prospects.lastName, companyName: prospects.company, companyDomain: prospects.companyDomain,
    })
    .from(prospects)
    .where(eq(prospects.workspaceId, workspaceId));
  for (let i = 0; i < people.length; i++) d.claim(queueIdentityKeys(people[i]));
  return d;
}
