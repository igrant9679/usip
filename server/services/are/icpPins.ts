/**
 * The ICP fields a person set by hand (audit 2026-10-20, A20; migration 0250).
 *
 * The ICP is re-inferred on a schedule, and every run wrote a fresh version
 * from the model's answer alone, so an Override was gone by the next morning.
 * Each version now carries `manualOverrides`: for every field a person edited,
 * the value they saved, in the stored shape. A new inference keeps its own
 * answer for every other field and puts these back over it; the pins travel
 * to the new version until the person lets the AI set them again.
 */

/** The fields the Override dialog edits. */
export const ICP_PINNABLE_FIELDS = [
  "targetIndustries",
  "targetTitles",
  "targetGeographies",
  "targetTechStack",
  "antiPatterns",
  "targetCompanySizeMin",
  "targetCompanySizeMax",
  "targetRevenueMin",
  "targetRevenueMax",
] as const;
export type IcpPinnableField = (typeof ICP_PINNABLE_FIELDS)[number];
export type IcpPins = Partial<Record<IcpPinnableField, unknown>>;

/** A stored manualOverrides value, read as pins: known fields only. */
export function readIcpPins(raw: unknown): IcpPins {
  const out: IcpPins = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const f of ICP_PINNABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, f)) out[f] = (raw as Record<string, unknown>)[f];
  }
  return out;
}

/** `row` with every pinned field put back as the person set it. */
export function applyIcpPins<T extends Record<string, unknown>>(row: T, pins: IcpPins): T {
  return { ...row, ...pins } as T;
}

/** The pins as stored: null when there are none. */
export function storedIcpPins(pins: IcpPins): IcpPins | null {
  return Object.keys(pins).length > 0 ? pins : null;
}

/** Whether a field's new value differs from its stored one (JSON, so lists compare by content). */
export function icpFieldChanged(before: unknown, after: unknown): boolean {
  const norm = (v: unknown) => (v === undefined ? null : v);
  return JSON.stringify(norm(before)) !== JSON.stringify(norm(after));
}
