/**
 * Unipile API helper
 * All calls are made server-side only. UNIPILE_API_KEY and UNIPILE_DSN are
 * injected via environment variables and never exposed to the client.
 */

const getConfig = () => {
  const apiKey = process.env.UNIPILE_API_KEY;
  const rawDsn = process.env.UNIPILE_DSN;
  if (!apiKey || !rawDsn) {
    throw new Error("UNIPILE_API_KEY and UNIPILE_DSN must be set");
  }
  // DSN may be a full URL (e.g. https://api26.unipile.com:15619/api/v1/accounts)
  // or just the origin (https://api26.unipile.com:15619). Extract only the origin.
  const parsed = new URL(rawDsn);
  const dsn = `${parsed.protocol}//${parsed.host}`;
  return { apiKey, dsn };
};

async function unipileFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { apiKey, dsn } = getConfig();
  const url = `${dsn}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Unipile ${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Hosted Auth Wizard ───────────────────────────────────────────────────────

export interface HostedAuthLinkResponse {
  object: "HostedAuthURL";
  url: string;
}

export async function generateHostedAuthLink(params: {
  type: "create" | "reconnect";
  providers: string[] | "*";
  expiresOn: string; // ISO 8601
  notifyUrl: string;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
  name?: string; // internal user ID for callback matching
  reconnectAccount?: string; // required when type = "reconnect"
}): Promise<HostedAuthLinkResponse> {
  const { dsn } = getConfig();
  return unipileFetch<HostedAuthLinkResponse>("/hosted/accounts/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: params.type,
      providers: params.providers,
      api_url: dsn,
      expiresOn: params.expiresOn,
      notify_url: params.notifyUrl,
      success_redirect_url: params.successRedirectUrl,
      failure_redirect_url: params.failureRedirectUrl,
      name: params.name,
      reconnect_account: params.reconnectAccount,
    }),
  });
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export interface UnipileAccountInfo {
  id: string;
  name: string;
  type: string;
  connection_params?: Record<string, unknown>;
  sources?: string[];
}

export async function listUnipileAccounts(): Promise<{ items: UnipileAccountInfo[] }> {
  return unipileFetch<{ items: UnipileAccountInfo[] }>("/accounts");
}

export async function getUnipileAccount(accountId: string): Promise<UnipileAccountInfo> {
  return unipileFetch<UnipileAccountInfo>(`/accounts/${accountId}`);
}

export async function deleteUnipileAccount(accountId: string): Promise<void> {
  await unipileFetch(`/accounts/${accountId}`, { method: "DELETE" });
}

// ─── Chats & Messages ────────────────────────────────────────────────────────

export interface UnipileChat {
  id: string;
  account_id: string;
  provider: string;
  name?: string;
  unread_count?: number;
  last_message?: {
    text?: string;
    created_at?: string;
    sender_id?: string;
  };
  attendees?: Array<{ id: string; name?: string; profile_picture_url?: string }>;
}

export interface UnipileMessageItem {
  id: string;
  chat_id: string;
  account_id: string;
  provider: string;
  text?: string;
  sender_id?: string;
  sender_name?: string;
  is_sender: boolean;
  created_at: string;
  attachments?: Array<{ url?: string; mime_type?: string }>;
}

export async function listChats(params: {
  accountId?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ items: UnipileChat[]; cursor?: string }> {
  const qs = new URLSearchParams();
  if (params.accountId) qs.set("account_id", params.accountId);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  return unipileFetch<{ items: UnipileChat[]; cursor?: string }>(`/chats?${qs}`);
}

export async function getChatMessages(
  chatId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<{ items: UnipileMessageItem[]; cursor?: string }> {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  return unipileFetch<{ items: UnipileMessageItem[]; cursor?: string }>(
    `/chats/${encodeURIComponent(chatId)}/messages?${qs}`,
  );
}

export async function sendMessage(params: {
  chatId?: string; // existing chat
  accountId?: string; // required when chatId not provided
  attendeesIds?: string[]; // required when chatId not provided
  text: string;
  linkedinInmail?: boolean;
}): Promise<{ id: string }> {
  const form = new FormData();
  form.append("text", params.text);

  if (params.chatId) {
    return unipileFetch<{ id: string }>(
      `/chats/${encodeURIComponent(params.chatId)}/messages`,
      { method: "POST", body: form },
    );
  }

  // New chat
  if (!params.accountId || !params.attendeesIds?.length) {
    throw new Error("accountId and attendeesIds are required when chatId is not provided");
  }
  form.append("account_id", params.accountId);
  for (const id of params.attendeesIds) form.append("attendees_ids", id);
  if (params.linkedinInmail) {
    form.append("linkedin[api]", "classic");
    form.append("linkedin[inmail]", "true");
  }
  return unipileFetch<{ id: string }>("/chats", { method: "POST", body: form });
}

// ─── LinkedIn Invitations ─────────────────────────────────────────────────────

export async function sendLinkedInInvitation(params: {
  accountId: string;
  providerId: string; // LinkedIn member URN or profile ID
  message?: string;
}): Promise<{ id?: string }> {
  return unipileFetch<{ id?: string }>(
    `/users/${encodeURIComponent(params.providerId)}/invite`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: params.accountId,
        message: params.message ?? "",
      }),
    },
  );
}

// ─── LinkedIn User / Profile ──────────────────────────────────────────────────

export interface UnipileUserProfile {
  id: string;
  provider_id: string;
  name?: string;
  headline?: string;
  profile_picture_url?: string;
  public_profile_url?: string;
}

export async function getLinkedInProfile(
  accountId: string,
  providerId: string,
): Promise<UnipileUserProfile> {
  return unipileFetch<UnipileUserProfile>(
    `/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(accountId)}`,
  );
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export async function registerWebhook(params: {
  requestUrl: string;
  source: "messaging" | "email" | "account_status" | "relation";
  secretKey?: string;
}): Promise<{ id: string }> {
  const headers: Array<{ key: string; value: string }> = [
    { key: "Content-Type", value: "application/json" },
  ];
  if (params.secretKey) {
    headers.push({ key: "Unipile-Auth", value: params.secretKey });
  }
  return unipileFetch<{ id: string }>("/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_url: params.requestUrl,
      source: params.source,
      headers,
    }),
  });
}
