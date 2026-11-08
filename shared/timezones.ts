/**
 * Every IANA time zone, for pickers (audit 2026-10-20, U15). The sequence
 * settings offered twelve hand-picked zones, so a sequence for Phoenix,
 * Mumbai or São Paulo could not be given its own; this is the full list the
 * runtime knows, grouped by region, each with its current UTC offset.
 */

/** A short list the runtime always knows, for an environment without Intl.supportedValuesOf. */
const FALLBACK_ZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "America/Mexico_City",
  "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Dublin", "Europe/Lisbon",
  "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm",
  "Europe/Warsaw", "Europe/Athens", "Europe/Istanbul", "Europe/Moscow", "Africa/Lagos", "Africa/Cairo",
  "Africa/Johannesburg", "Africa/Nairobi", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu",
  "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Australia/Perth", "Australia/Adelaide", "Australia/Sydney", "Pacific/Auckland",
];

/**
 * ICU lists some zones by their old names (Asia/Calcutta, Europe/Kiev); people
 * and other systems use the current ones, and a sequence may already store
 * one. The current name is listed instead wherever this runtime knows it.
 */
const CURRENT_NAME: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
};

function known(z: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; }
}

/** Every zone name, sorted, UTC first. */
export function allTimezones(): string[] {
  let zones: string[] = [];
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    zones = typeof fn === "function" ? fn("timeZone") : [];
  } catch {
    zones = [];
  }
  const named = zones.map((z) => (CURRENT_NAME[z] && known(CURRENT_NAME[z]!) ? CURRENT_NAME[z]! : z));
  const all = [...named, ...FALLBACK_ZONES.filter(known)];
  const rest = Array.from(new Set(all.filter((z) => z !== "UTC"))).sort();
  return ["UTC", ...rest];
}

/** "UTC−05:00" for a zone at an instant (DST-aware). */
export function utcOffsetLabel(tz: string, atMs: number = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(atMs));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
    const mins = Math.round((wall - Math.floor(atMs / 60_000) * 60_000) / 60_000);
    const sign = mins < 0 ? "−" : "+";
    const abs = Math.abs(mins);
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  } catch {
    return "UTC+00:00";
  }
}

/** The zones grouped by region ("America", "Europe", …), each group sorted. */
export function timezoneGroups(): Array<{ region: string; zones: string[] }> {
  const by = new Map<string, string[]>();
  for (const z of allTimezones()) {
    const region = z.includes("/") ? z.split("/")[0]! : "Other";
    if (!by.has(region)) by.set(region, []);
    by.get(region)!.push(z);
  }
  return Array.from(by, ([region, zones]) => ({ region, zones }));
}
