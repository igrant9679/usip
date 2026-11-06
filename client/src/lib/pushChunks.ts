/**
 * People split into batches a campaign push accepts.
 *
 * `are.prospects.pushExisting` takes at most 100 ids of each kind, and a
 * list's "Add all N to…" sent every id in one call, so a list over 100 failed
 * as a whole (audit 2026-10-20, P48). Each batch here holds at most `size`
 * people across all three kinds, people first.
 */
export const PUSH_BATCH = 100;

export type PeopleIds = { prospectIds: number[]; contactIds: number[]; leadIds: number[] };

export function pushChunks(ids: PeopleIds, size = PUSH_BATCH): PeopleIds[] {
  const all = [
    ...ids.prospectIds.map((id) => ["prospectIds", id] as const),
    ...ids.contactIds.map((id) => ["contactIds", id] as const),
    ...ids.leadIds.map((id) => ["leadIds", id] as const),
  ];
  const out: PeopleIds[] = [];
  for (let i = 0; i < all.length; i += size) {
    const batch: PeopleIds = { prospectIds: [], contactIds: [], leadIds: [] };
    for (const [kind, id] of all.slice(i, i + size)) batch[kind].push(id);
    out.push(batch);
  }
  return out;
}
