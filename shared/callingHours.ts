/**
 * callingHours.ts — when, and which numbers, an AI call may dial.
 *
 * Outbound AI calls (owner ask 2026-10-04: "gated and not autonomous …
 * approved, in batches and/or 1 by 1"). Approval says WHO may be called;
 * this says WHEN: weekdays, 9 AM to 5 PM in the PERSON's time zone. Not the
 * workspace's: a 9 AM Eastern dial is 6 AM in California. US rules allow
 * 8 AM–9 PM local; these hours sit well inside that.
 *
 * Only North American (+1) numbers for now: calling rules elsewhere differ
 * country by country, and nothing here models them.
 */

export const CALL_FIRST_HOUR = 9;
/** The first hour a call may NOT start in. */
export const CALL_END_HOUR = 17;
export const CALL_DAYS = [1, 2, 3, 4, 5] as const;

/** E.164 for a North American number, or null when it is not one we may dial. */
export function callableNumber(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let d = s.replace(/\D/g, "");
  if (s.startsWith("+") && !d.startsWith("1")) return null; // another country code
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  // NANP: area code and exchange both start 2–9.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  return `+1${d}`;
}

const US: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};
const US_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC", "washington d.c.": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
  nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};
const CA: Record<string, string> = {
  AB: "America/Edmonton", BC: "America/Vancouver", MB: "America/Winnipeg", NB: "America/Moncton",
  NL: "America/St_Johns", NS: "America/Halifax", NT: "America/Yellowknife", NU: "America/Iqaluit",
  ON: "America/Toronto", PE: "America/Halifax", QC: "America/Toronto", SK: "America/Regina", YT: "America/Whitehorse",
};
const CA_NAMES: Record<string, string> = {
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", newfoundland: "NL", "nova scotia": "NS", "northwest territories": "NT",
  nunavut: "NU", ontario: "ON", "prince edward island": "PE", quebec: "QC", "québec": "QC",
  saskatchewan: "SK", yukon: "YT",
};

/**
 * The person's time zone from their state/province, or null when it cannot
 * be told (no state, or a country other than the US/Canada). A state that
 * spans two zones gets the zone most of its people live in.
 */
export function timezoneForRegion(state: string | null | undefined, country: string | null | undefined): string | null {
  const st = String(state ?? "").trim();
  if (!st) return null;
  const c = String(country ?? "").trim().toLowerCase();
  const isCa = ["ca", "can", "canada"].includes(c);
  const isUs = !c || ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"].includes(c);
  const upper = st.toUpperCase();
  const key = st.toLowerCase();
  const caCode = CA[upper] ? upper : CA_NAMES[key];
  const usCode = US[upper] ? upper : US_NAMES[key];
  if (isCa) return caCode ? CA[caCode] : null;
  if (isUs && usCode) return US[usCode];
  // No country given: a Canadian province ("ON") still tells us the zone.
  // "CA" alone stays California, above.
  if (!c && caCode) return CA[caCode];
  return null;
}

/** Weekday and hour of an instant in `timezone`. */
function localParts(nowMs: number, timezone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date(nowMs));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), hour };
}

/** True inside weekday calling hours in `timezone`. An unknown zone is never open. */
export function isWithinCallingHours(nowMs: number, timezone: string): boolean {
  try {
    const { day, hour } = localParts(nowMs, timezone);
    return (CALL_DAYS as readonly number[]).includes(day) && hour >= CALL_FIRST_HOUR && hour < CALL_END_HOUR;
  } catch {
    return false;
  }
}

/** "9 AM–5 PM weekdays (America/Chicago)" — for the approval list. */
export function describeCallingHours(timezone: string): string {
  return `9 AM–5 PM weekdays (${timezone})`;
}
