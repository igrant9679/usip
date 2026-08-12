/**
 * Record normalization + quality control (pure — no imports).
 *
 * The formatting layer that runs BEFORE any contact/company value is saved,
 * on every path — enrichment candidates flow through it inside fieldMerge,
 * imports call it while mapping rows. It fixes representation only:
 * spelling of suffixes, capitalization, punctuation, spacing, placeholder
 * junk. It NEVER changes what a value means — "VP Sales" stays a VP of
 * sales, "acme corp" becomes "Acme Corp." but never "Acme Corporation".
 *
 * Deliberately conservative, because it rewrites CRM data in bulk:
 *  - mixed-case input is treated as intentional and only re-spaced;
 *    case repair applies to ALL-CAPS and all-lowercase input only;
 *  - short tokens keep their caps (IBM, MSA, USA) — title-casing an
 *    acronym is worse than leaving a word capitalized;
 *  - unknown values pass through trimmed rather than guessed at.
 */

/* ─── QC: placeholder junk ───────────────────────────────────────────────── */

const JUNK = new Set([
  "n/a", "na", "n.a.", "none", "null", "nil", "unknown", "undefined", "tbd",
  "-", "--", "---", ".", "?", "x", "xx", "xxx", "test", "asdf", "no company",
  "not available", "not applicable", "self", "self employed", "self-employed",
]);

/** Null out obvious placeholder junk; trim + collapse whitespace otherwise.
 *  This is the CSV-IMPORT junk vocabulary (human-typed cells). Its sibling
 *  for scraped/LLM fields — bracket-wrapped "<UNKNOWN>" tokens, email/phone
 *  shape rules — is @shared/fieldHygiene; see the note there before adding
 *  a third. */
export function cleanPlaceholder(v: string | null | undefined): string | null {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return JUNK.has(s.toLowerCase()) ? null : s;
}

/* ─── shared casing helpers ──────────────────────────────────────────────── */

const SMALL_WORDS = new Set(["of", "and", "the", "for", "at", "in", "on", "to", "de", "da", "van", "von"]);

/** Title-case one word, preserving inner capitals (McKinsey, eBay, iRobot). */
function titleCaseWord(w: string): string {
  if (!w) return w;
  if (/[A-Z]/.test(w.slice(1))) return w; // inner caps → intentional
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

const isAllCaps = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();
const isAllLower = (s: string) => /[a-z]/.test(s) && s === s.toLowerCase();

/** Re-case a phrase whose input casing carries no information (ALL CAPS or
 *  all lowercase). Tokens in `keepCaps` (or ≤3 chars in an all-caps phrase —
 *  acronym odds beat word odds) stay uppercase; small words go lowercase
 *  except in first position. */
function recasePhrase(s: string, keepCaps: Set<string>): string {
  const allCaps = isAllCaps(s);
  return s.split(/\s+/).map((w, i) => {
    const bare = w.replace(/[^A-Za-z0-9&]/g, "");
    if (keepCaps.has(bare.toUpperCase())) {
      return w.toUpperCase();
    }
    const lower = w.toLowerCase();
    // Small words first — "BANK OF THE WEST"'s OF is a word, not an acronym.
    if (i > 0 && SMALL_WORDS.has(lower.replace(/[^a-z]/g, ""))) return lower;
    if (allCaps && bare.length <= 3 && /^[A-Z0-9&]+$/.test(bare)) return w; // IBM, MSA, R&D
    return titleCaseWord(lower);
  }).join(" ");
}

/* ─── company display names ──────────────────────────────────────────────── */

/** Legal-suffix spellings: lowercase/period variants → the standard form. */
const SUFFIX_CANON: Record<string, string> = {
  "inc": "Inc.", "inc.": "Inc.", "incorporated": "Incorporated",
  "llc": "LLC", "l.l.c": "LLC", "l.l.c.": "LLC",
  "ltd": "Ltd.", "ltd.": "Ltd.", "limited": "Limited",
  "corp": "Corp.", "corp.": "Corp.", "corporation": "Corporation",
  "co": "Co.", "co.": "Co.",
  "plc": "PLC", "llp": "LLP", "gmbh": "GmbH", "pllc": "PLLC",
};

const COMPANY_KEEP_CAPS = new Set(["LLC", "PLC", "LLP", "PLLC", "USA", "US", "UK", "AI", "IT", "HR", "IBM", "SAP", "AWS", "CRM", "B2B"]);

/**
 * Correct a company name's representation: spacing, punctuation around
 * commas, legal-suffix spelling, and casing when the input casing carries no
 * information. Mixed-case names pass through with spacing/suffix fixes only.
 */
export function canonicalizeCompanyDisplayName(raw: string | null | undefined): string | null {
  let s = cleanPlaceholder(raw);
  if (!s) return null;

  // Spacing around punctuation: "Acme ,Inc" → "Acme, Inc"; collapse doubles.
  s = s.replace(/\s+,/g, ",").replace(/,(?=\S)/g, ", ").replace(/\s+/g, " ").trim();
  // Strip wrapping quotes.
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!s) return null;

  // Casing repair only when the input casing is informationless.
  if (isAllCaps(s) || isAllLower(s)) {
    s = recasePhrase(s, COMPANY_KEEP_CAPS);
  }

  // Standardize the trailing legal suffix's spelling (never add or remove one).
  const words = s.split(" ");
  const last = words[words.length - 1];
  const lastKey = last.toLowerCase().replace(/,+$/, "");
  if (SUFFIX_CANON[lastKey]) {
    words[words.length - 1] = SUFFIX_CANON[lastKey];
    s = words.join(" ");
  }
  return s || null;
}

/* ─── job titles ─────────────────────────────────────────────────────────── */

/** Role acronyms that must render uppercase regardless of input casing. */
const TITLE_ACRONYMS = new Set([
  "VP", "SVP", "EVP", "AVP", "CEO", "CFO", "COO", "CTO", "CIO", "CMO", "CRO",
  "CHRO", "CISO", "CPO", "CDO", "GM", "MD", "HR", "IT", "PR", "QA", "R&D",
  "SDR", "BDR", "AE", "AM", "CSM", "CX", "UX", "UI", "PM", "TPM", "RN", "NP",
  "US", "USA", "UK", "EMEA", "APAC", "LATAM", "II", "III", "IV",
]);

/**
 * Standardize a job title's FORMATTING without changing meaning or
 * seniority: whitespace, trailing separator noise, casing repair for
 * ALL-CAPS/lowercase input, and acronym casing (vp → VP, Ceo → CEO) in any
 * input. Never expands or rewrites words — "VP Sales" stays "VP Sales".
 */
export function normalizeJobTitle(raw: string | null | undefined): string | null {
  let s = cleanPlaceholder(raw);
  if (!s) return null;

  // Trailing separator noise ("VP of Sales |", "Director -").
  s = s.replace(/[\s|,;:•·—–-]+$/g, "").replace(/^[\s|,;:•·—–-]+/g, "").trim();
  if (!s) return null;

  if (isAllCaps(s) || isAllLower(s)) {
    s = recasePhrase(s, TITLE_ACRONYMS);
  }

  // Acronym casing repair applies even to mixed-case input: "Vp of Sales".
  s = s.split(" ").map((w) => {
    const m = w.match(/^([A-Za-z&]+)([.,]*)$/);
    if (!m) return w;
    const upper = m[1].toUpperCase();
    return TITLE_ACRONYMS.has(upper) ? upper + m[2] : w;
  }).join(" ");

  return s || null;
}

/* ─── LinkedIn location strings ──────────────────────────────────────────── */

/**
 * Split a LinkedIn location ("Austin, Texas, United States" · "Greater
 * Boston" · "London, England, United Kingdom") into city/state/country as
 * far as its shape allows. One- and two-segment forms fill what they can;
 * anything unparseable lands in city verbatim rather than being dropped.
 */
export function parseLinkedInLocation(raw: string | null | undefined): {
  city: string | null; state: string | null; country: string | null;
} {
  const s = cleanPlaceholder(raw);
  if (!s) return { city: null, state: null, country: null };
  const parts = s.split(",").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (parts.length >= 3) return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
  if (parts.length === 2) return { city: parts[0], state: null, country: parts[1] };
  return { city: parts[0] ?? null, state: null, country: null };
}
