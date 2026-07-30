/**
 * Startup check for secrets that silently degrade instead of failing.
 *
 * Two shapes of degradation are reported here. The first is a hardcoded
 * fallback KEY (below). The second is a gate that FAILS OPEN when its variable
 * is absent — `SCHEDULED_TASK_SECRET`, which leaves the /api/scheduled cron
 * endpoints reachable by anyone. Different mechanism, same symptom: the
 * deployment looks configured and is not.
 *
 * Three files predate `_core/crypto.ts` and substitute a HARDCODED LITERAL when
 * `JWT_SECRET` is unset, rather than refusing to run:
 *
 *   emailAdapter.ts    AES key for stored IMAP passwords
 *   routers/smtpConfig AES key for stored SMTP passwords
 *   unsubscribe.ts     HMAC key for one-click unsubscribe tokens
 *
 * Those literals live in the repository. With the variable unset, mailbox
 * credentials are encrypted with a key anyone reading the source already has,
 * and unsubscribe tokens can be forged for any address — which is a compliance
 * problem, not just a security one. The newer `_core/crypto.ts` gets this right
 * and throws; these three were written before it existed.
 *
 * This deliberately WARNS rather than throwing. Making a live deployment refuse
 * to boot over a variable that is probably already set would turn a latent
 * weakness into an outage, and the fix (set the variable, redeploy) is the same
 * either way. What was missing was not enforcement — it was any signal at all.
 *
 * Called once at server startup. If this ever prints in production, treat every
 * stored mailbox password as compromised: rotate JWT_SECRET, then have each
 * member reconnect their mailbox, because existing ciphertext was written with
 * the public key and re-encrypting it under a new one preserves nothing.
 */

/** Secrets that fall back to a literal, and what each one protects. */
const DEGRADING_SECRETS: Array<{ env: string; protects: string[] }> = [
  {
    env: "JWT_SECRET",
    protects: [
      "encryption of stored IMAP passwords (emailAdapter.ts)",
      "encryption of stored SMTP passwords (routers/smtpConfig.ts)",
      "signing of one-click unsubscribe tokens (unsubscribe.ts)",
    ],
  },
  {
    env: "ENCRYPTION_KEY",
    protects: [
      "encryption of BYOK API keys — Apollo, Reoon, xAI, SendGrid (_core/crypto.ts)",
    ],
  },
  /**
   * Not a hardcoded-literal fallback like the two above — this one degrades by
   * ABSENCE. `requireScheduledSecret` lets the request through when the
   * variable is unset, because the external scheduler is the only trigger for
   * two of the three /api/scheduled endpoints and demanding a secret nobody
   * configured would stop the client follow-up mail rather than protect it.
   *
   * The consequence of leaving it unset is that anyone who can spell the URL
   * can run those crons: mail to clients, tasks across every workspace, and an
   * LLM call per workspace. Same category — quietly weaker than it looks — so
   * it is reported in the same place.
   */
  {
    env: "SCHEDULED_TASK_SECRET",
    protects: [
      "the /api/scheduled/* cron endpoints — proposal-followup (mails clients, " +
        "auto-expires proposals), icp-regen (one LLM call per workspace), " +
        "rejection-digest — which stay open to anonymous callers while it is unset",
    ],
  },
];

export interface SecretWarning {
  env: string;
  protects: string[];
}

/**
 * Which configured-secret problems exist right now. Pure apart from reading
 * env, so the decision can be tested without booting a server.
 *
 * ENCRYPTION_KEY falls back to JWT_SECRET before it gives up, so it is only
 * reported when BOTH are absent — reporting it otherwise would be a false alarm
 * that teaches people to ignore this output.
 */
export function findSecretWarnings(env: NodeJS.ProcessEnv = process.env): SecretWarning[] {
  const out: SecretWarning[] = [];
  if (!env.JWT_SECRET) out.push(DEGRADING_SECRETS[0]);
  if (!env.ENCRYPTION_KEY && !env.JWT_SECRET) out.push(DEGRADING_SECRETS[1]);
  if (!env.SCHEDULED_TASK_SECRET) out.push(DEGRADING_SECRETS[2]);
  return out;
}

/** Log loudly at boot. Never throws — see the note above on outages. */
export function reportSecretHealth(env: NodeJS.ProcessEnv = process.env): void {
  const warnings = findSecretWarnings(env);
  if (warnings.length === 0) return;
  const production = env.NODE_ENV === "production";
  for (const w of warnings) {
    console.error(
      `[SecretHealth] ${production ? "PRODUCTION" : "dev"}: ${w.env} is not set. ` +
      `A hardcoded fallback from the source tree is being used instead, which weakens: ` +
      w.protects.join("; ") + ".",
    );
  }
  // The re-encryption advice applies only to the two KEY variables. Printing it
  // for a missing SCHEDULED_TASK_SECRET would tell an operator to reconnect
  // every mailbox over a cron endpoint, which is how a warning gets ignored.
  const encryptionAffected = warnings.some((w) => w.env === "JWT_SECRET" || w.env === "ENCRYPTION_KEY");
  if (production && encryptionAffected) {
    console.error(
      "[SecretHealth] Set these on the host and redeploy. Anything already encrypted " +
      "was written with the public fallback key — rotate the secret AND reconnect mailboxes.",
    );
  }
}
