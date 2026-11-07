/**
 * A quota period key as people read it (audit 2026-10-20, R102): the picker
 * and the empty state showed the stored key, "2026-10". "2026-10" → "October
 * 2026", "2026-Q4" → "Q4 2026", "2026-FY" → "FY 2026"; anything else as given.
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function quotaPeriodLabel(period: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2]|Q[1-4]|FY)$/.exec(period);
  if (!m) return period;
  const [, year, part] = m;
  if (part === "FY") return `FY ${year}`;
  if (part.startsWith("Q")) return `${part} ${year}`;
  return `${MONTHS[Number(part) - 1]} ${year}`;
}
