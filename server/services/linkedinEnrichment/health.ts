/**
 * LinkedIn-enrichment integration health.
 *
 * Pre-flight gate the import page + batch runner consult before doing any
 * work: confirms the Unipile client is configured and at least one connected,
 * LinkedIn-capable account exists. Reuses the existing bridged-account pool
 * (server/services/linkedinLookup) — no duplicate account store.
 */
import { listUsableAccounts } from "../linkedinLookup";

export type IntegrationHealthStatus =
  | "connected"
  | "missing_api_key"
  | "no_linkedin_account"
  | "account_disconnected"
  | "insufficient_capability"
  | "vendor_error"
  | "rate_limited"
  | "disabled_by_admin";

export interface IntegrationHealth {
  status: IntegrationHealthStatus;
  has_unipile_client: boolean;
  connected_accounts: Array<{ unipileAccountId: string; displayName: string | null; status: string; remainingToday: number }>;
  linkedin_capable_account_count: number;
  missing_requirements: string[];
}

/** "Healthy enough to enrich" account statuses (Unipile uses uppercase codes). */
const OK_STATUSES = new Set(["CONNECTED", "OK", "CREATION_SUCCESS", "RECONNECTED", "active"]);

export async function checkLinkedInEnrichmentHealth(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
}): Promise<IntegrationHealth> {
  const hasClient = !!process.env.UNIPILE_API_KEY && !!process.env.UNIPILE_DSN;
  if (!hasClient) {
    return {
      status: "missing_api_key",
      has_unipile_client: false,
      connected_accounts: [],
      linkedin_capable_account_count: 0,
      missing_requirements: ["UNIPILE_API_KEY / UNIPILE_DSN not configured"],
    };
  }

  let accounts: Awaited<ReturnType<typeof listUsableAccounts>> = [];
  try {
    accounts = await listUsableAccounts(opts);
  } catch (e) {
    return {
      status: "vendor_error",
      has_unipile_client: true,
      connected_accounts: [],
      linkedin_capable_account_count: 0,
      missing_requirements: [`Unipile error: ${(e as Error).message.slice(0, 120)}`],
    };
  }

  const connected = accounts.map((a) => ({
    unipileAccountId: a.unipileAccountId,
    displayName: a.displayName,
    status: a.status,
    remainingToday: a.remainingToday,
  }));

  if (accounts.length === 0) {
    return {
      status: "no_linkedin_account",
      has_unipile_client: true,
      connected_accounts: [],
      linkedin_capable_account_count: 0,
      missing_requirements: [
        opts.isAdmin
          ? "No LinkedIn account is connected in this workspace. Connect one from Connected Accounts."
          : "You haven't connected a LinkedIn account. Connect yours from Connected Accounts.",
      ],
    };
  }

  const healthy = accounts.filter((a) => OK_STATUSES.has(a.status));
  if (healthy.length === 0) {
    return {
      status: "account_disconnected",
      has_unipile_client: true,
      connected_accounts: connected,
      linkedin_capable_account_count: 0,
      missing_requirements: ["Connected LinkedIn account(s) need reconnection (credentials expired or stopped)."],
    };
  }

  return {
    status: "connected",
    has_unipile_client: true,
    connected_accounts: connected,
    linkedin_capable_account_count: healthy.length,
    missing_requirements: [],
  };
}
