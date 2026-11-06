/**
 * A calendar event's stored attendees, whatever shape they come back in
 * (audit 2026-10-20, O20).
 *
 * `calendar_events.attendees` is a JSON column, so the database hands back an
 * ARRAY. The Calendar's edit dialog ran `JSON.parse` on it anyway, which
 * throws on any array (even `[]`), so opening a synced event with attendees
 * crashed the page. Older rows and other writers may still hold a JSON
 * string, and an entry may be `{ email, name }` or a bare address, so this
 * accepts each of them and never throws.
 *
 * Shared by the server (pause check, meeting summary) and the client (edit dialog).
 */
export type StoredAttendee = { email: string; name: string };

export function storedAttendees(value: unknown): StoredAttendee[] {
  let list: unknown = value;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out: StoredAttendee[] = [];
  for (const a of list) {
    if (typeof a === "string") {
      if (a.trim()) out.push({ email: a.trim(), name: "" });
    } else if (a && typeof a === "object") {
      const email = String((a as { email?: unknown }).email ?? "").trim();
      const name = String((a as { name?: unknown }).name ?? "").trim();
      if (email || name) out.push({ email, name });
    }
  }
  return out;
}
