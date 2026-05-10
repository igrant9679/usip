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
  const method = options.method ?? "GET";
  const startedAt = Date.now();
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  const elapsedMs = Date.now() - startedAt;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[Unipile] ${method} ${path} → ${res.status} in ${elapsedMs}ms: ${body.slice(0, 300)}`);
    throw new Error(`Unipile ${method} ${path} → ${res.status}: ${body}`);
  }
  // Diagnostic logging — successful calls. Cheap and only fires per request.
  // For list responses, peek at the items count to surface "0 results" cases
  // that would otherwise be invisible (the empty-mailbox failure mode).
  const responseText = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(responseText) as T;
  } catch (e) {
    console.error(`[Unipile] ${method} ${path} → 200 but unparseable JSON (${responseText.length} bytes)`);
    throw e;
  }
  const p = parsed as unknown as { items?: unknown[]; object?: string };
  const summary =
    Array.isArray(p?.items)
      ? `items=${p.items.length}${p.object ? ` (${p.object})` : ""}`
      : p?.object
        ? p.object
        : "ok";
  console.log(`[Unipile] ${method} ${path} → ${res.status} ${summary} in ${elapsedMs}ms`);
  return parsed;
}

// ─── Hosted Auth Wizard ───────────────────────────────────────────────────────

export interface HostedAuthLinkResponse {
  object: "HostedAuthURL";
  url: string;
}

export async function generateHostedAuthLink(params: {
  type: "create" | "reconnect";
  /**
   * Either a single provider name (e.g. "MICROSOFT", "LINKEDIN") or "*" for
   * all providers. Per Unipile's documented hosted-auth-link API the field
   * is a string, NOT an array — sending `["MICROSOFT"]` triggers
   * "Expected union value" because their schema rejects arrays here.
   *
   * Multi-select callers should either fan out one call per provider, or
   * pass "*" and let the user pick inside the wizard.
   */
  providers: string;
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

// ─── Email API ────────────────────────────────────────────────────────────────
// All endpoints documented in Unipile's OpenAPI spec under /api/v1/emails*
// and /api/v1/folders*. Verified against the spec fetched 2026-05-10.

export interface UnipileAttendee {
  display_name?: string;
  identifier: string; // email address
  identifier_type?: string;
}

export type UnipileEmailRole =
  | "inbox"
  | "sent"
  | "archive"
  | "drafts"
  | "trash"
  | "spam"
  | "all"
  | "important"
  | "starred"
  | "unknown";

export interface UnipileEmail {
  object: "Email";
  id: string;
  deprecated_id?: string;
  account_id: string;
  /** Provider type: MAIL / GOOGLE / OUTLOOK / EXCHANGE / GOOGLE_OAUTH / ICLOUD */
  type: string;
  date: string;
  role: UnipileEmailRole;
  folders: string[];
  folderIds: string[];
  /** ISO datetime of first API read; null = unread. */
  read_date: string | null;
  message_id: string;
  provider_id: string;
  /** Present on "full" kind responses (meta_only=false). */
  subject?: string;
  body?: string;
  body_plain?: string;
  from_attendee?: UnipileAttendee;
  to_attendees?: UnipileAttendee[];
  cc_attendees?: UnipileAttendee[];
  bcc_attendees?: UnipileAttendee[];
  reply_to_attendees?: UnipileAttendee[];
  has_attachments?: boolean;
  attachments?: Array<{
    id: string;
    name: string;
    extension?: string;
    size?: number;
    mime?: string;
  }>;
  /** Server-assigned thread id used by GET /emails?thread_id=… */
  thread_id?: string;
  headers?: Array<{ name: string; value: string }>;
}

export interface UnipileEmailListResponse {
  object: "EmailList";
  items: UnipileEmail[];
  cursor?: string | null;
}

/**
 * Push payload from Unipile's "New email" webhook (source=email).
 * Documented at https://developer.unipile.com/docs/webhook-new-email
 * Fires for mail_received / mail_sent / mail_moved.
 *
 * Note: there is no top-level thread_id field on this payload — Unipile
 * exposes thread_id only on the GET /emails endpoint. If we need threading
 * for cache-served reads we'll need to fetch the canonical email afterward.
 */
export interface MailWebhookPayload {
  email_id: string;
  account_id: string;
  event: "mail_received" | "mail_sent" | "mail_moved";
  webhook_name?: string;
  date: string;
  from_attendee?: UnipileAttendee;
  to_attendees?: UnipileAttendee[];
  cc_attendees?: UnipileAttendee[];
  bcc_attendees?: UnipileAttendee[];
  reply_to_attendees?: UnipileAttendee[];
  provider_id?: string;
  message_id?: string;
  has_attachments?: boolean;
  subject?: string;
  body?: string;
  body_plain?: string;
  attachments?: Array<{
    id?: string;
    name?: string;
    extension?: string;
    size?: number;
    mime?: string;
  }>;
  folders?: string[];
  role?: UnipileEmailRole;
  read_date?: string | null;
  is_complete?: boolean;
  in_reply_to?: { message_id?: string; id?: string };
  tracking_id?: string;
  origin?: "unipile" | "external";
}

export interface UnipileFolder {
  object: "Folder";
  id: string;
  name: string;
  account_id: string;
  /** inbox / sent / archive / drafts / trash / spam etc., or custom label. */
  role?: string;
  /** Per-folder counts when included. */
  status?: { total?: number; unread?: number };
  /** Provider-specific id. */
  provider_id?: string;
}

export interface UnipileFolderListResponse {
  object: "FolderList";
  items: UnipileFolder[];
}

/** GET /api/v1/emails — list emails for an account. Cursor-paginated. */
export async function listEmails(params: {
  accountId: string;
  folder?: string;
  threadId?: string;
  cursor?: string;
  limit?: number;
  before?: string;
  after?: string;
  /** When true, body fields are omitted (kind=1_meta) — faster for thread lists. */
  metaOnly?: boolean;
  includeHeaders?: boolean;
  excludeFolders?: string[];
  any_email?: string;
  to?: string;
  from?: string;
}): Promise<UnipileEmailListResponse> {
  const qs = new URLSearchParams();
  qs.set("account_id", params.accountId);
  if (params.folder) qs.set("folder", params.folder);
  if (params.threadId) qs.set("thread_id", params.threadId);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.before) qs.set("before", params.before);
  if (params.after) qs.set("after", params.after);
  if (params.metaOnly !== undefined) qs.set("meta_only", String(params.metaOnly));
  if (params.includeHeaders !== undefined) qs.set("include_headers", String(params.includeHeaders));
  if (params.any_email) qs.set("any_email", params.any_email);
  if (params.to) qs.set("to", params.to);
  if (params.from) qs.set("from", params.from);
  for (const f of params.excludeFolders ?? []) qs.append("exclude_folders", f);
  return unipileFetch<UnipileEmailListResponse>(`/emails?${qs.toString()}`);
}

/** GET /api/v1/emails/{email_id} — full email by id (accepts Unipile id or provider id). */
export async function getEmail(
  emailId: string,
  accountId?: string,
): Promise<UnipileEmail> {
  const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  return unipileFetch<UnipileEmail>(`/emails/${encodeURIComponent(emailId)}${qs}`);
}

/**
 * POST /api/v1/emails — send a new email.
 *
 * Critical: this endpoint uses multipart/form-data, NOT JSON.
 * `to` / `cc` / `bcc` / `from` / `tracking_options` are JSON-stringified
 * into form fields per Unipile's convention. Attachments are uploaded as
 * file parts named `attachments`.
 *
 * `reply_to` (when set) wires the new email into the same thread as the
 * email being replied to — server-side threading, we just pass the id.
 */
export async function sendEmail(params: {
  accountId: string;
  to: UnipileAttendee[];
  body: string;
  subject?: string;
  cc?: UnipileAttendee[];
  bcc?: UnipileAttendee[];
  from?: UnipileAttendee;
  replyTo?: string;
  customHeaders?: Array<{ name: string; value: string }>;
  trackingOptions?: { opens?: boolean; links?: boolean; label?: string; custom_domain?: string };
  attachments?: Array<{ filename: string; contentType: string; content: string /* base64 */ }>;
}): Promise<{ object: "EmailSent"; tracking_id: string; provider_id: string | null }> {
  const form = new FormData();
  form.append("account_id", params.accountId);
  form.append("to", JSON.stringify(params.to));
  form.append("body", params.body);
  if (params.subject !== undefined) form.append("subject", params.subject);
  if (params.cc) form.append("cc", JSON.stringify(params.cc));
  if (params.bcc) form.append("bcc", JSON.stringify(params.bcc));
  if (params.from) form.append("from", JSON.stringify(params.from));
  if (params.replyTo) form.append("reply_to", params.replyTo);
  if (params.customHeaders) form.append("custom_headers", JSON.stringify(params.customHeaders));
  if (params.trackingOptions) {
    form.append("tracking_options", JSON.stringify(params.trackingOptions));
  }
  for (const att of params.attachments ?? []) {
    const bytes = Buffer.from(att.content, "base64");
    const blob = new Blob([bytes], { type: att.contentType });
    form.append("attachments", blob, att.filename);
  }
  return unipileFetchMultipart<{ object: "EmailSent"; tracking_id: string; provider_id: string | null }>(
    "/emails",
    "POST",
    form,
  );
}

/** PUT /api/v1/emails/{email_id} — mark unread, move folders, set Outlook categories. */
export async function updateEmail(
  emailId: string,
  params: { unread?: boolean; folders?: string[]; categories?: string[] },
  accountId?: string,
): Promise<{ object: "EmailUpdated" }> {
  const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  return unipileFetch<{ object: "EmailUpdated" }>(`/emails/${encodeURIComponent(emailId)}${qs}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/** DELETE /api/v1/emails/{email_id} — moves the email to Trash. */
export async function deleteEmail(
  emailId: string,
  accountId?: string,
): Promise<{ object: "EmailDeleted" }> {
  const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  return unipileFetch<{ object: "EmailDeleted" }>(`/emails/${encodeURIComponent(emailId)}${qs}`, {
    method: "DELETE",
  });
}

/**
 * GET /api/v1/emails/{email_id}/attachments/{attachment_id} — binary download.
 *
 * Returns the raw bytes plus the resolved Content-Type / filename via
 * Content-Disposition (if the provider sent one).
 */
export async function getEmailAttachment(
  emailId: string,
  attachmentId: string,
): Promise<{ data: Buffer; contentType: string; filename: string }> {
  const { apiKey, dsn } = getConfig();
  const url = `${dsn}/api/v1/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const res = await fetch(url, {
    headers: { "X-API-KEY": apiKey, Accept: "application/octet-stream" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Unipile GET attachment → ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const disp = res.headers.get("content-disposition") ?? "";
  const filenameMatch = disp.match(/filename="?([^";]+)"?/i);
  const filename = filenameMatch?.[1] ?? "attachment";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf, contentType: ct, filename };
}

/** GET /api/v1/folders — list folders for an account. */
export async function listFolders(accountId: string): Promise<UnipileFolderListResponse> {
  const qs = new URLSearchParams({ account_id: accountId });
  return unipileFetch<UnipileFolderListResponse>(`/folders?${qs.toString()}`);
}

// ─── Multipart helper (POST /emails uses form-data, not JSON) ────────────────
async function unipileFetchMultipart<T>(
  path: string,
  method: string,
  form: FormData,
): Promise<T> {
  const { apiKey, dsn } = getConfig();
  const res = await fetch(`${dsn}/api/v1${path}`, {
    method,
    headers: {
      // Don't set Content-Type — node's fetch sets it with the
      // multipart boundary automatically based on the FormData body.
      "X-API-KEY": apiKey,
      Accept: "application/json",
    },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Unipile ${method} ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}
