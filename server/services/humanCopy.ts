/**
 * humanCopy — makes AI-written outreach read like a person wrote it.
 *
 * Two layers, and every email-copy generator uses BOTH:
 *
 *  1. HUMAN_COPY_RULES — appended to the generator's system prompt. This is
 *     where tone lives (vocabulary, rhythm, no corporate-speak); a scrub
 *     can't fix tone after the fact.
 *  2. humanizeAiCopy() — a deterministic scrub over the OUTPUT, because
 *     models ignore instructions just often enough that "no em dashes"
 *     cannot be left to the prompt. The scrub is the guarantee; the prompt
 *     is the quality.
 *
 * The scrub runs ONLY on AI-generated text at generation time — never at
 * the send boundary — because rewriting a human's own typed punctuation
 * would be vandalism. If you add a new copy generator, wire both layers or
 * its output ships with the tells the owner explicitly asked to remove.
 */

export const HUMAN_COPY_RULES = `
STYLE — the reader must never suspect this was AI-written:
- NEVER use em dashes (—) or en dashes (–). Use a comma, a period, or parentheses instead.
- No AI vocabulary: never "delve", "leverage", "seamless", "robust", "elevate", "unlock", "supercharge", "streamline", "game-changer", "cutting-edge", "furthermore", "moreover", "in today's fast-paced world", "I hope this email finds you well", "I trust this finds you well".
- Write like a busy salesperson: short sentences mixed with the occasional longer one. Contractions ("I'm", "we've", "don't"). Plain words over impressive ones.
- No bullet lists, no headings, no bold/italic markdown, no emoji in email bodies.
- At most one exclamation mark in the entire message, and usually zero.
- Don't open with a compliment template ("Impressive work at..."). Open with the specific reason you're writing.
- No "As an AI" or any reference to being generated.
- It's fine to be slightly imperfect: starting a sentence with "And" or "But" is human.`.trim();

/** Words the prompt bans — exported so the test and the scrub agree. */
const BANNED_OPENERS: Array<[RegExp, string]> = [
  [/^\s*I hope this (email )?finds you well[.!,]?\s*/i, ""],
  [/^\s*I trust this (email )?finds you well[.!,]?\s*/i, ""],
];

/**
 * Deterministic scrub of AI tells. Format-preserving: works on plain text
 * and on HTML fragments alike (it only touches characters and inline
 * markdown artifacts, never tags), and leaves {{merge tags}} untouched.
 */
export function humanizeAiCopy(text: string): string {
  if (!text) return text;
  let s = text;

  // Em dashes: the #1 tell. Spaced or unspaced parenthetical dashes become
  // a comma; a leading/trailing orphan just disappears.
  s = s.replace(/\s*—\s*/g, ", ");
  // En dash between digits is a range: make it a plain hyphen ("5-10").
  s = s.replace(/(\d)\s*–\s*(\d)/g, "$1-$2");
  // Any other en dash behaves like an em dash.
  s = s.replace(/\s*–\s*/g, ", ");
  // The comma substitution can double up against existing punctuation.
  s = s.replace(/,\s*,/g, ", ").replace(/([.!?;:]),\s/g, "$1 ");

  // Unicode ellipsis → three dots (and cap runs of dots).
  s = s.replace(/…/g, "...").replace(/\.{4,}/g, "...");

  // Curly quotes/apostrophes → straight. Not strictly an AI tell, but the
  // MIX of curly (AI) and straight (human edits) inside one email is.
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

  // Markdown artifacts models leak into "plain" emails.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1"); // **bold**
  s = s.replace(/(^|\s)#{1,4}\s+/gm, "$1"); // # headings
  s = s.replace(/`([^`]+)`/g, "$1"); // `code`

  // Cliché openers, if the model used one anyway.
  for (const [re, rep] of BANNED_OPENERS) s = s.replace(re, rep);

  // Collapse doubled spaces the substitutions may leave (NOT newlines).
  s = s.replace(/[ \t]{2,}/g, " ");

  return s.trim();
}

/** Convenience for the common {subject, body} shape. */
export function humanizeSubjectBody<T extends { subject?: string | null; body?: string | null }>(x: T): T {
  return {
    ...x,
    subject: typeof x.subject === "string" ? humanizeAiCopy(x.subject) : x.subject,
    body: typeof x.body === "string" ? humanizeAiCopy(x.body) : x.body,
  };
}
