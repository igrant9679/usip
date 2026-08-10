/**
 * Person-name credential stripping (pure — no imports).
 *
 * LinkedIn display names routinely carry credential suffixes ("Ron Flournoy,
 * PSP", "Rachele Thomas, BSN, RN, CDAL", "Jane Doe, MBA, PMP") and sometimes
 * honorific prefixes ("Dr. Jane Doe"). Those tokens belong to the profile,
 * not the person's name: they leak into {{first_name}} merge tags, email
 * pattern guesses (jane.doe.mba@…), dedupe keys, and the People list.
 *
 * The owner's rule (2026-08-10): never include prefixes or suffixes from
 * LinkedIn — CPTM, PMP, MBA, FACHE, etc.
 *
 * Deliberately conservative, because this rewrites names:
 *  - A comma segment is dropped only when EVERY token in it reads as a
 *    credential (known list, or ALL-CAPS 2–8 chars). "Doe, Jane" keeps its
 *    second segment; "Thomas, BSN, RN, CDAL" loses all three.
 *  - Generational suffixes (Jr, Sr, II–V) are kept — they are the name.
 *  - Space-form credentials ("John Smith MBA") are stripped only for known
 *    tokens that don't have normal capitalized-word shape, so the surnames
 *    "Ma" and "Ba" survive while "MA", "MBA", and "PhD" strip.
 *  - Never strips to empty: if nothing but credentials remains, the input
 *    comes back trimmed rather than blank.
 */

const KNOWN_CREDENTIALS = new Set([
  // Degrees
  "mba", "phd", "edd", "psyd", "dba", "jd", "md", "do", "dnp", "pharmd", "edm",
  "mph", "mha", "mpa", "msw", "ma", "ms", "msc", "med", "ba", "bs", "bsc", "bba",
  "bsn", "msn", "aa", "aas", "llm",
  // Licenses / clinical
  "rn", "np", "pa", "pac", "aprn", "crna", "lcsw", "lpc", "lmft", "cdal", "lnha",
  "fache", "facp", "facs", "faan", "fnp", "fnpbc", "cphq", "chc", "cno",
  // Business / PM / ops / supply chain
  "pmp", "capm", "cptm", "psp", "pgmp", "prince2", "csm", "cspo", "safe", "itil",
  "cscp", "cpim", "cltd", "cpsm", "cips", "lssbb", "lssgb", "cssbb", "cssgb", "mbb",
  // Finance / audit / fraud
  "cpa", "cfa", "cfp", "cfe", "cia", "cma", "cgma", "cva", "cams",
  // HR / L&D / fundraising / associations
  "shrmcp", "shrmscp", "sphr", "phr", "gphr", "cebs", "cplp", "cpl", "cae",
  "cfre", "cnp", "acc", "pcc", "mcc",
  // Security / IT
  "cissp", "cisa", "cism", "crisc", "ccsp", "ceh", "ccna", "ccnp", "togaf",
  // Engineering / real estate / legal
  "pe", "eit", "aia", "leed", "ccim", "crs", "gri", "esq", "esquire",
]);

const GENERATIONAL = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "prof", "rev", "hon"]);

/** Lowercase, dots/commas removed — "Ph.D." and "PhD" are one token. */
const norm = (t: string) => t.toLowerCase().replace(/[.,]/g, "");

/** Does this token read as a credential in a comma segment? */
function isCredentialToken(tok: string): boolean {
  const n = norm(tok);
  if (!n) return true; // stray punctuation
  if (GENERATIONAL.has(n)) return false;
  if (KNOWN_CREDENTIALS.has(n.replace(/-/g, ""))) return true;
  // ALL-CAPS 2–8 chars (hyphens/digits allowed): "CDAL", "SHRM-CP", "CDL-A".
  const bare = tok.replace(/[.,]/g, "");
  return /^[A-Z][A-Z0-9-]{1,7}$/.test(bare);
}

/** Space-form strip is stricter: known tokens only, and never a token shaped
 *  like a normal capitalized word — that shape is a name ("Ma", "Ba"). */
function isSpaceFormCredential(tok: string): boolean {
  const bare = tok.replace(/[.,]/g, "");
  if (/^[A-Z][a-z]+$/.test(bare)) return false;
  return KNOWN_CREDENTIALS.has(norm(tok).replace(/-/g, ""));
}

/**
 * Strip credential prefixes/suffixes from a person's name (or name part).
 * Safe on first names, last names, and full names. Null-in, null-out.
 */
export function stripNameCredentials(raw: string | null | undefined): string | null {
  const input = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!input) return null;

  // Comma segments: the name leads; later segments survive only if they are
  // generational ("Smith, Jr.") or contain any non-credential token
  // ("Doe, Jane" — a Last, First import must pass through untouched).
  const segs = input.split(",").map((s) => s.trim()).filter(Boolean);
  const kept: string[] = segs.length ? [segs[0]] : [];
  for (const seg of segs.slice(1)) {
    const toks = seg.split(/\s+/);
    const generational = toks.length <= 2 && toks.every((t) => GENERATIONAL.has(norm(t)));
    if (generational || !toks.every(isCredentialToken)) kept.push(seg);
  }

  // Leading honorific — only when a name remains after it.
  let head = kept[0]?.split(/\s+/) ?? [];
  if (head.length > 1 && HONORIFICS.has(norm(head[0]))) head = head.slice(1);

  // Trailing space-form credentials on the name segment ("John Smith MBA PMP").
  while (head.length > 1 && isSpaceFormCredential(head[head.length - 1])) head.pop();

  kept[0] = head.join(" ");
  const out = kept.filter(Boolean).join(", ").trim();
  return out || input;
}
