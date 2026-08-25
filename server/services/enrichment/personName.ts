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

/**
 * Capitalization repair for ONE name token — applied only when the token
 * arrived shapeless: ALL-CAPS ("SMITH") or all-lowercase ("smith"). A
 * mixed-case token is already human-shaped ("McDonald", "DiCaprio", "van")
 * and is never touched — we cannot out-guess a human's own casing.
 * Hyphen/apostrophe segments re-case independently ("o'brien-SMITH" →
 * "O'Brien-Smith"); a "Mc" prefix gets its inner capital back. "Mac" is
 * deliberately NOT special-cased — "Macias" and "Mack" are real surnames.
 */
/** Surname particles that conventionally stay lowercase ("van der Berg",
 *  "de la Cruz"). Applied only to NON-FINAL tokens: "Le" and "Van" standing
 *  as the surname itself (common Vietnamese surnames) must capitalize, while
 *  a particle before the main surname stays down. */
const SURNAME_PARTICLES = new Set([
  "van", "der", "de", "la", "von", "di", "da", "del", "den", "ter", "ten",
  "bin", "al", "le", "du", "dos", "das", "el", "los", "las",
]);

function capitalizeNameToken(tok: string, isFinalToken: boolean): string {
  if (!/[a-zA-Z]/.test(tok)) return tok;
  // Initials ("W.B.", "j.r.", and the half-healed "W.b.") are ALWAYS
  // upper — checked before the shapeless gate, because a botched mixed-case
  // initial must heal on a re-run rather than hide behind "deliberate casing".
  if (/^([a-zA-Z]\.){1,3}[a-zA-Z]?\.?$/.test(tok)) return tok.toUpperCase();
  // Dotless ALL-CAPS of one or two letters ("LJ", "TJ", "A") is usually an
  // initialism, sometimes a name ("AL") — undecidable, so untouched.
  // (Prod 2026-08-25: "LJ" briefly became "Lj".)
  if (/^[A-Z]{1,2}$/.test(tok)) return tok;
  const shapeless = tok === tok.toUpperCase() || tok === tok.toLowerCase();
  if (!shapeless) return tok;
  if (!isFinalToken && SURNAME_PARTICLES.has(tok.toLowerCase())) return tok.toLowerCase();
  return tok
    .toLowerCase()
    .split(/([-'’])/)
    .map((seg) =>
      /[-'’]/.test(seg) || seg === ""
        ? seg
        : (seg[0].toUpperCase() + seg.slice(1)).replace(/^Mc([a-z])/, (_, c: string) => "Mc" + c.toUpperCase()),
    )
    .join("");
}

/**
 * The People "Name" rule (owner directive 2026-08-25): the stored pair holds
 * ONLY a first name and a last name, capitalization normalized.
 *
 * Built ON TOP of repairNamePair (credentials + wrong-split repair), then:
 *  - lastName empty + multi-word firstName → first token / last token
 *    (the middle drops — that is the instruction, not an accident);
 *  - firstName keeps its FIRST token only ("John A." → "John",
 *    "Mary Ann" → "Mary");
 *  - lastName is kept WHOLE — "van der Berg" and "Smith Jr" ARE the last
 *    name (multi-token surnames and generational suffixes survive);
 *  - every kept token goes through capitalizeNameToken.
 * Never returns empty when the input was not.
 */
export function normalizePersonNamePair(
  first: string | null | undefined,
  last: string | null | undefined,
): { firstName: string | null; lastName: string | null } {
  // Placeholder sentinels ("<UNKNOWN>", "(unknown)", "N/A") are not names —
  // pass them through untouched rather than "normalizing" garbage. (Prod
  // 2026-08-25: "<UNKNOWN>" was case-mangled to "<unknown>".)
  const isPlaceholder = (s: string | null | undefined) =>
    !!s && /^[<(\[]?\s*(unknown|n\/?a|none|null|not available|not found)\s*[>)\]]?$/i.test(s.trim());
  if (isPlaceholder(first) || isPlaceholder(last)) {
    return { firstName: first ?? null, lastName: last ?? null };
  }

  const repaired = repairNamePair(first, last);
  let f = (repaired.firstName ?? "").trim();
  let l = (repaired.lastName ?? "").trim();

  if (!l && f) {
    // A whole name stored in firstName splits first-token / last-token —
    // but ONLY within the FIRST comma segment. The tail segments are the
    // junk the credential strip could not prove ("…, CFtP, GFI Chartered
    // Fellow"), and taking the blob's last token minted "Michael Fellow"
    // out of Michael Conn on prod 2026-08-25.
    const toks = f.split(",")[0].trim().split(/\s+/).filter(Boolean);
    if (toks.length >= 2) {
      f = toks[0];
      l = toks[toks.length - 1];
    }
  }
  if (f) f = (f.split(/\s+/).filter(Boolean)[0] ?? f).replace(/,+$/, "");

  const cap = (s: string) => {
    const toks = s.split(/\s+/).filter(Boolean);
    return toks.map((t, i) => capitalizeNameToken(t, i === toks.length - 1)).join(" ");
  };
  return {
    firstName: f ? cap(f) : repaired.firstName,
    lastName: l ? cap(l) : repaired.lastName,
  };
}

/**
 * Repair a stored first/last pair AS A PAIR.
 *
 * Historic imports split "Ron Flournoy, PSP" at the LAST SPACE, landing the
 * whole name in firstName and the credential alone in lastName — where the
 * single-field stripper rightly refuses to touch it (never strip to empty).
 * When lastName is nothing but KNOWN credentials (list only — an all-caps
 * heuristic would eat real surnames like "LEE") and firstName carries at
 * least two words, the real name is in firstName: drop the credential and
 * re-split. Otherwise both fields just get the single-field strip.
 */
export function repairNamePair(
  first: string | null | undefined,
  last: string | null | undefined,
): { firstName: string | null; lastName: string | null } {
  const cf = stripNameCredentials(first);
  const cl = stripNameCredentials(last);
  const lastToks = (cl ?? "").split(/\s+/).filter(Boolean);
  const lastIsCredentialOnly =
    lastToks.length > 0 && lastToks.every((t) => KNOWN_CREDENTIALS.has(norm(t).replace(/-/g, "")));
  const firstToks = (cf ?? "").split(/\s+/).filter(Boolean);
  if (lastIsCredentialOnly && firstToks.length >= 2) {
    return {
      firstName: firstToks.slice(0, -1).join(" "),
      lastName: firstToks[firstToks.length - 1],
    };
  }
  return { firstName: cf, lastName: cl };
}
