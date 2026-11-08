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

/**
 * The same in a workspace's fiscal calendar (audit 2026-10-20, F29): a fiscal
 * year that does not start in January is named by the year it ends in, so
 * "2027-Q1" reads "Q1 FY2027" and "2027-FY" reads "FY2027". With a January
 * start it is quotaPeriodLabel. A separate function, not a second parameter,
 * so `.map(quotaPeriodLabel)` never passes an index as the start month.
 */
export function fiscalQuotaPeriodLabel(period: string, fyStart: number): string {
  if (fyStart === 1) return quotaPeriodLabel(period);
  const m = /^(\d{4})-(Q[1-4]|FY)$/.exec(period);
  if (!m) return quotaPeriodLabel(period);
  return m[2] === "FY" ? `FY${m[1]}` : `${m[2]} FY${m[1]}`;
}
