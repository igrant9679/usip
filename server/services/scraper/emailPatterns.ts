/**
 * Email pattern generator.
 *
 * From {firstName, lastName, domain}, produce the 2–3 most-likely patterns
 * to check. Based on B2B email-format frequency studies (Hunter, Apollo,
 * etc.), three patterns cover ~80% of corporate schemes:
 *
 *   first.last@domain   ~40%   (most common; default in O365, Google Workspace defaults)
 *   flast@domain        ~25%   (single-letter-first; common in finance/legal)
 *   firstlast@domain    ~15%   (smushed; common in tech/startups)
 *
 * We deliberately exclude lower-frequency patterns (first_last, lfirst,
 * f.last, last.first, etc.) to keep Reoon credit spend at 3 per prospect.
 */

export type EmailPattern = {
  /** Generated email address */
  email: string;
  /** Pattern name for debugging / display */
  pattern: "first.last" | "flast" | "firstlast";
  /** Rough corporate-frequency prior (0..1). Used to tie-break between valids. */
  prior: number;
};

/** Strip non-letter chars and lowercase. "O'Brien" → "obrien". */
function clean(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Generate the 3 patterns. Returns [] if name or domain are unusable.
 * De-duplicates (e.g. for one-letter first names "J" + "Doe" → flast=jdoe,
 * firstlast=jdoe — only emit once).
 */
export function generatePatterns(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  domain: string | null | undefined,
): EmailPattern[] {
  const first = clean(firstName ?? "");
  const last = clean(lastName ?? "");
  const d = (domain ?? "").trim().toLowerCase();

  if (!first || !last || !d) return [];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return [];

  const candidates: EmailPattern[] = [
    { email: `${first}.${last}@${d}`, pattern: "first.last", prior: 0.4 },
    { email: `${first.charAt(0)}${last}@${d}`, pattern: "flast", prior: 0.25 },
    { email: `${first}${last}@${d}`, pattern: "firstlast", prior: 0.15 },
  ];

  const seen = new Set<string>();
  const out: EmailPattern[] = [];
  for (const c of candidates) {
    if (seen.has(c.email)) continue;
    seen.add(c.email);
    out.push(c);
  }
  return out;
}
