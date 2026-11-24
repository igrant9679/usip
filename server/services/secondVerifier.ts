/**
 * secondVerifier.ts — WarmySender verification beside Reoon (owner,
 * 2026-11-24: "wire in WarmySender verification beside Reoon").
 *
 * Until now the adapter could verify an address (warmySenderVerifyEmail) and
 * nothing called it: a workspace's WarmySender plan carried a verification
 * allowance Velocity only displayed.
 *
 * Reoon stays the verifier. WarmySender is asked for a SECOND opinion only
 * when Reoon gives none:
 *   · Reoon answered "unknown" (greylisted, timed out, could not decide), or
 *   · the Reoon call failed (5xx, out of credits, network).
 * It is asked from inside reoonVerifySingle, the one function every caller
 * uses, so every place that verifies one address gets it and none can forget.
 *
 * What it never does:
 *   · run when verification is off for the workspace: with Reoon toggled off
 *     or keyless, getReoonKey returns "" and no caller reaches the verifier
 *     at all, so this is not a way round that switch;
 *   · run for a "quick" check: those are the guessed addresses the pattern
 *     finder throws away by the dozen, and they would empty the allowance;
 *   · override a verdict Reoon did give;
 *   · turn a catch-all into "valid": a catch-all domain is accept_all here
 *     whatever WarmySender calls the address.
 *
 * Every call is held against the workspace's WarmySender verification
 * allowance first (the same ledger its leads use) and counted in the spend
 * report. A refusal of any kind returns null: Reoon's own answer stands.
 */
import type { ProspectSourceSlug } from "@shared/prospectSources";
import type { ReoonVerifyResult } from "./reoon";

const SLUG: ProspectSourceSlug = "warmysender";
/** The key must be allowed to verify; a key issued for leads only is not asked. */
export const VERIFY_SCOPE = "verification:write";

export type SecondOpinionSkip =
  | "no_workspace" | "source_off" | "no_key" | "option_off" | "scope_missing"
  | "key_invalid" | "circuit_open" | "allowance_used_up" | "call_failed" | "undecided";

export type SecondOpinion =
  | { decided: true; result: ReoonVerifyResult }
  | { decided: false; why: SecondOpinionSkip; detail?: string };

/**
 * WarmySender's verdict in the shape every caller already reads (a Reoon
 * result), so reoonStatusToUsip maps it like any other:
 *   valid → "safe" (valid) · catch-all → "catch_all" (accept_all)
 *   risky → "risky" · invalid → "invalid"
 * `base` is Reoon's own undecided answer when there was one; its syntax and
 * MX facts are kept, and only what WarmySender decided is overwritten.
 */
export function asReoonResult(
  email: string,
  v: { status: "valid" | "invalid" | "risky" | "unknown"; isCatchAll: boolean },
  base: ReoonVerifyResult | null,
): ReoonVerifyResult | null {
  if (v.status === "unknown") return null;
  // A catch-all domain accepts anything: "valid" there proves nothing.
  const status = v.status === "invalid" ? "invalid" : v.isCatchAll ? "catch_all" : v.status === "valid" ? "safe" : "risky";
  const safe = status === "safe";
  return {
    email,
    status,
    overall_score: base?.overall_score ?? 0,
    is_safe_to_send: safe,
    is_valid_syntax: base?.is_valid_syntax ?? true,
    is_disposable: base?.is_disposable ?? false,
    is_role_account: base?.is_role_account ?? false,
    is_catch_all: status === "catch_all",
    is_deliverable: safe,
    mx_accepts_mail: status === "invalid" ? (base?.mx_accepts_mail ?? false) : true,
    decidedBy: "warmysender",
  };
}

/**
 * Ask WarmySender about one address Reoon could not decide. Never throws.
 * `base` is Reoon's undecided answer, or null when the Reoon call failed.
 */
export async function warmySenderSecondOpinion(
  workspaceId: number | null | undefined,
  email: string,
  feature: string,
  base: ReoonVerifyResult | null,
): Promise<SecondOpinion> {
  if (!workspaceId) return { decided: false, why: "no_workspace" };
  try {
    const { getSource, sourceSwitchedOff } = await import("./prospectSources/registry");
    const { credentialView, loadCredentials } = await import("./prospectSources/credentials");
    const { circuitState } = await import("./prospectSources/circuit");
    const { commit, release, reserve } = await import("./prospectSources/ledger");
    const { warmySenderVerifyEmail } = await import("./prospectSources/adapters/warmysender");
    const source = getSource(SLUG);

    // "Use WarmySender" off in Settings means off everywhere, verification included.
    if (await sourceSwitchedOff(workspaceId, SLUG)) return { decided: false, why: "source_off" };
    const creds = await loadCredentials(workspaceId, source);
    if (!creds?.secrets.apiKey) return { decided: false, why: "no_key" };
    const config = creds.config as { verifyUndecided?: boolean; scopes?: unknown };
    if (config.verifyUndecided === false) return { decided: false, why: "option_off" };
    // Scopes are recorded at Test connection. A key known to lack the scope is
    // not asked; one never tested is, and the vendor's own refusal answers.
    if (Array.isArray(config.scopes) && config.scopes.indexOf(VERIFY_SCOPE) === -1) return { decided: false, why: "scope_missing" };
    const view = await credentialView(workspaceId, source);
    if (view.status === "invalid") return { decided: false, why: "key_invalid" };
    const circuit = await circuitState(workspaceId, SLUG, source.credentialMode);
    if (circuit.open) return { decided: false, why: "circuit_open" };

    // Held BEFORE the call: two checks at once cannot both spend the last unit.
    const periods = source.budgetPeriods({ now: new Date(), credentials: creds });
    const hold = await reserve(workspaceId, SLUG, "verification", 1, periods);
    if (!hold) return { decided: false, why: "allowance_used_up" };

    const res = await warmySenderVerifyEmail(creds, email);
    if (!res.ok) {
      await release(workspaceId, hold);
      return { decided: false, why: "call_failed", detail: res.message };
    }
    await commit(workspaceId, hold, 1);
    const { recordSpend } = await import("./spend");
    await recordSpend({ workspaceId, vendor: "warmysender", meter: "verifications", quantity: 1, keySource: "workspace", feature });

    const result = asReoonResult(email, res, base);
    return result ? { decided: true, result } : { decided: false, why: "undecided" };
  } catch (e) {
    // The second opinion is a bonus: its failure must never fail a verification.
    console.error("[secondVerifier] WarmySender second opinion failed:", (e as Error)?.message);
    return { decided: false, why: "call_failed", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
