/**
 * Settings search and deep links (audit 2026-10-20, U9; batch CONB,
 * 2026-11-08).
 *
 * The hub's search matched section labels only, so the words people actually
 * type — MFA, 2FA, SMTP, webhook, signature, API key — found nothing. Each
 * section now carries keywords (SettingsHub's GROUPS), and a query matches a
 * label or any keyword. A query that names one of the Profile page's tabs
 * opens that tab (/v2/settings/profile?tab=mfa).
 */

/** The Profile page's tabs, as `?tab=` names them. */
export const PROFILE_TAB_IDS = ["general", "mfa", "email-settings"] as const;
export type ProfileTabId = (typeof PROFILE_TAB_IDS)[number];

/** Old section ids that still land somewhere (a row that moved or merged). */
export const HUB_SECTION_ALIASES: Record<string, string> = {
  // "Phone numbers" opened the call queue; numbers are set on Voice agents.
  "phone-numbers": "voice-agents",
};

const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_-]+/g, " ");
/** A keyword answers a query that starts it or one of its words, or that contains all of it ("api keys" → "api key"). */
const hits = (q: string, keyword: string) => {
  const k = norm(keyword);
  return k.startsWith(q) || k.split(" ").some((w) => w.startsWith(q)) || (q.length >= 3 && q.includes(k));
};

/** Whether a query matches a section's label or one of its keywords. */
export function settingsMatches(query: string, label: string, keywords: readonly string[] = []): boolean {
  const q = norm(query);
  if (!q) return true;
  return norm(label).includes(q) || keywords.some((k) => hits(q, k));
}

/** The Profile tab a query is about, if any: "mfa" → mfa, "password" → general. */
const PROFILE_TAB_WORDS: Array<[ProfileTabId, string[]]> = [
  ["mfa", ["mfa", "2fa", "two factor", "authenticator", "backup codes", "sessions", "sign out everywhere", "security"]],
  ["email-settings", ["open tracking", "click tracking", "tracking", "opt out", "unsubscribe", "email settings"]],
  ["general", ["password", "login email", "quota", "annual quota", "linkedin", "name", "title"]],
];
export function profileTabFrom(query: string): ProfileTabId | null {
  const q = norm(query);
  if (q.length < 2) return null;
  for (const [tab, words] of PROFILE_TAB_WORDS) if (words.some((w) => hits(q, w))) return tab;
  return null;
}
