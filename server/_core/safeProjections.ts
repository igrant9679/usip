/**
 * What leaves the server when a row holds secrets.
 *
 * 🔴 THE HOLES (audit 2026-10-20: C4 and two of the "also urgent" items).
 *   · `auth.me` returned `ctx.user` — the whole `users` row, `passwordHash`
 *     and, for anyone with 2FA, `mfaTotpSecret`, which is enough to generate
 *     their codes forever.
 *   · `sendingAccounts.list` / `.get` spread the row: SMTP and IMAP passwords
 *     and the OAuth tokens went to every member's browser. Live, all 30 LSI
 *     Media mailboxes carried them.
 *   · `settings.get` spread the settings row to every member: the Slack and
 *     Teams webhook URLs (each one is a posting credential), the SendGrid
 *     inbound token (which authenticates forged replies), and the ciphertext
 *     of every BYOK key.
 *
 * Each projection is an ALLOWLIST for the user row and a named DENYLIST for
 * the two settings-shaped rows, and each denylist has a test that fails when
 * a new secret-looking column appears that it does not name
 * (`server/secretProjections.test.ts`). A spread is how all three leaked; a
 * new column must not leak the same way by default.
 */
import type { User } from "../../drizzle/schema";

/* ─── auth.me ───────────────────────────────────────────────────────────── */

/** Every `users` column the browser may see. Anything not listed stays here. */
export const PUBLIC_USER_FIELDS = [
  "id", "openId", "name", "email", "avatarUrl", "loginMethod", "role",
  "createdAt", "updatedAt", "lastSignedIn", "emailSignature", "themePalette",
  "elsieEnabled", "mfaTotpEnabledAt",
] as const;

type PublicUserField = (typeof PUBLIC_USER_FIELDS)[number];
export type PublicUser = Pick<User, PublicUserField> & { hasPassword: boolean };

export function publicUser(user: User | null | undefined): PublicUser | null {
  if (!user) return null;
  const out = {} as Record<string, unknown>;
  for (const k of PUBLIC_USER_FIELDS) out[k] = (user as Record<string, unknown>)[k] ?? null;
  out.hasPassword = !!user.passwordHash;
  return out as PublicUser;
}

/* ─── sending accounts ─────────────────────────────────────────────────── */

/**
 * Columns that are credentials. The three dead reputation columns are dropped
 * alongside them for the reason `list` always gave: nothing writes them.
 */
export const SENDING_ACCOUNT_SECRET_FIELDS = [
  "smtpPassword", "imapPassword", "oauthAccessToken", "oauthRefreshToken", "sendgridApiKeyEnc",
] as const;
const SENDING_ACCOUNT_DEAD_FIELDS = ["bounceRate", "spamRate", "reputationTier"] as const;

type SendingAccountRow = Record<string, unknown> & {
  smtpPassword?: string | null;
  imapPassword?: string | null;
  oauthAccessToken?: string | null;
  oauthRefreshToken?: string | null;
  sendgridApiKeyEnc?: string | null;
};

export function safeSendingAccount<T extends SendingAccountRow>(row: T) {
  const out: Record<string, unknown> = { ...row };
  for (const k of SENDING_ACCOUNT_SECRET_FIELDS) delete out[k];
  for (const k of SENDING_ACCOUNT_DEAD_FIELDS) delete out[k];
  return {
    ...(out as Omit<T, (typeof SENDING_ACCOUNT_SECRET_FIELDS)[number] | (typeof SENDING_ACCOUNT_DEAD_FIELDS)[number]>),
    // "Leave blank to keep the current password" needs to know there is one.
    hasSmtpPassword: !!row.smtpPassword,
    hasImapPassword: !!row.imapPassword,
    hasOauthToken: !!(row.oauthAccessToken || row.oauthRefreshToken),
  };
}

/* ─── workspace settings ───────────────────────────────────────────────── */

/** Credentials no member's browser needs, admin or not: they are only ever written. */
export const SETTINGS_SECRET_FIELDS = [
  "anthropicApiKeyEnc", "openaiApiKeyEnc", "geminiApiKeyEnc", "xaiApiKeyEnc",
  "plivoAuthTokenEnc", "apolloApiKeyEnc", "reoonApiKeyEnc", "quickenrichApiKeyEnc",
  "sendgridInboundToken",
] as const;

/**
 * Credentials the Settings page shows an ADMIN so it can edit them in place.
 * A rep never sees them; they get the has-flag instead.
 */
export const SETTINGS_ADMIN_ONLY_FIELDS = ["slackWebhookUrl", "teamsWebhookUrl"] as const;

export function settingsForMember<T extends Record<string, unknown>>(row: T, opts: { isAdmin: boolean }) {
  const out: Record<string, unknown> = { ...row };
  for (const k of SETTINGS_SECRET_FIELDS) delete out[k];
  if (!opts.isAdmin) for (const k of SETTINGS_ADMIN_ONLY_FIELDS) out[k] = null;
  return {
    ...(out as Omit<T, (typeof SETTINGS_SECRET_FIELDS)[number]>),
    hasSlackWebhook: !!row.slackWebhookUrl,
    hasTeamsWebhook: !!row.teamsWebhookUrl,
    hasSendgridInboundToken: !!row.sendgridInboundToken,
  };
}
