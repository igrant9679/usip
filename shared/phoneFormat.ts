/**
 * phoneFormat.ts — phone numbers as people read them (owner ask 2026-10-05:
 * "fix the phone formatting"). Plivo hands over a caller as "15714798700";
 * the call log and the notification showed exactly that.
 *
 *   toE164("15714798700")     → "+15714798700"   (how numbers are stored)
 *   formatPhone("+15714798700") → "+1 571-479-8700" (how they are shown)
 *
 * North American numbers get the familiar grouping; anything else is shown
 * as +digits. Something that is not a number at all ("anonymous", a SIP
 * address) is shown as it came.
 */

const digitsOf = (raw: string) => raw.replace(/\D/g, "");

/** E.164 for storage, or the trimmed input when it is not a phone number. */
export function toE164(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // A SIP address: the user part is the number ("sip:+1555...@host").
  const sip = /^sips?:([^@;]+)/i.exec(s);
  const core = sip ? sip[1] : s;
  if (/[a-z]/i.test(core)) return s;
  const d = digitsOf(core);
  if (d.length < 7) return s;
  if (d.length === 10 && /^[2-9]/.test(d)) return `+1${d}`;
  return `+${d}`;
}

/** "+1 571-479-8700" for North America, "+44 2079460958" elsewhere, as-is when not a number. */
export function formatPhone(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const e = toE164(s);
  if (!e || !e.startsWith("+")) return s;
  const d = e.slice(1);
  if (d.length === 11 && d.startsWith("1")) return `+1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return e;
}
