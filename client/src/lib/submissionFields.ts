/**
 * The fields of a form or landing-page submission beyond name, email and
 * company (audit 2026-10-20, G63).
 *
 * Both submissions lists showed only those three and the lead id, so a
 * visitor's message or phone number was kept in the stored `data` and shown
 * nowhere in the app. Every other field the visitor filled in is listed now,
 * with phone and title first and the message last.
 */

const SHOWN_ELSEWHERE = new Set(["name", "firstName", "lastName", "email", "company"]);
const LABELS: Record<string, string> = { phone: "Phone", title: "Title", message: "Message" };
const ORDER = ["phone", "title"];

function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key]!;
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

export type SubmissionField = { key: string; label: string; value: string };

export function submissionExtras(data: unknown): SubmissionField[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const out: SubmissionField[] = [];
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (SHOWN_ELSEWHERE.has(key) || raw == null) continue;
    const value = Array.isArray(raw)
      ? raw.map((x) => String(x)).join(", ")
      : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    if (!value.trim()) continue;
    out.push({ key, label: labelFor(key), value });
  }
  const rank = (k: string) => (ORDER.indexOf(k) >= 0 ? ORDER.indexOf(k) : k === "message" ? 1000 : 100);
  return out.sort((a, b) => rank(a.key) - rank(b.key));
}
