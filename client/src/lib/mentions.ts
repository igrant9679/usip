/**
 * @mentions in notes, without typing the token by hand (audit 2026-10-20,
 * R105).
 *
 * crmNotes.create notifies everyone written as `@[Name](user:ID)`, and the
 * drawer told people to type exactly that — an id nobody can see. Now typing
 * "@" and a few letters offers the workspace's members, and picking one writes
 * the token; a saved note shows it as "@Name".
 */

/** The "@abc" being typed just before the caret, or null. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@[\]()]{0,30})$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

/** Replace the "@abc" at `start`..`caret` with the member's token and a space. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  member: { userId: number; name: string },
): { text: string; caret: number } {
  // The token's name may not hold the characters that end it.
  const name = member.name.replace(/[[\]()]/g, "").trim() || `User ${member.userId}`;
  const token = `@[${name}](user:${member.userId}) `;
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}

/** A note as it reads: each token shown as "@Name". */
export function mentionsAsText(body: string): string {
  return body.replace(/@\[([^\]]+)\]\(user:\d+\)/g, "@$1");
}

/** Members whose name starts a word with the query, first six. */
export function mentionCandidates<T extends { name: string | null }>(members: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  return members
    .filter((m) => !!m.name && (q === "" || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))))
    .slice(0, 6);
}
