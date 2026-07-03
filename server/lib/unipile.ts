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

/** A pending sent invitation as returned by GET /users/invite/sent. */
export interface UnipileSentInvitation {
  id: string; // invitation_id (used to cancel)
  invited_user?: string; // provider_id of the invitee
  invited_user_name?: string;
  invited_user_public_identifier?: string;
  invited_user_profile_url?: string;
  message?: string;
  date?: string; // ISO — when the invite was sent
}

/**
 * List pending sent LinkedIn invitations for an account.
 * Compliant read via the authorized Unipile layer. LinkedIn caps pending
 * invitations (~a few hundred); Social Autopilot uses this to withdraw stale
 * ones and to detect which have been accepted (they drop off this list).
 */
export async function listSentInvitations(params: {
  accountId: string;
  limit?: number;
  cursor?: string;
}): Promise<{ items: UnipileSentInvitation[]; cursor?: string }> {
  const qs = new URLSearchParams();
  qs.set("account_id", params.accountId);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  return unipileFetch<{ items: UnipileSentInvitation[]; cursor?: string }>(
    `/users/invite/sent?${qs}`,
  );
}

/**
 * Withdraw/cancel a previously sent (still-pending) LinkedIn invitation.
 * Frees a slot against LinkedIn's pending-invite ceiling.
 */
export async function cancelSentInvitation(params: {
  accountId: string;
  invitationId: string;
}): Promise<{ object?: string }> {
  return unipileFetch<{ object?: string }>(
    `/users/invite/sent/${encodeURIComponent(params.invitationId)}?account_id=${encodeURIComponent(params.accountId)}`,
    { method: "DELETE" },
  );
}

/** A 1st-degree connection as returned by GET /users/relations. */
export interface UnipileRelation {
  member_id?: string; // LinkedIn provider_id
  provider_id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  public_identifier?: string;
  public_profile_url?: string;
  headline?: string;
  connection_degree?: string;
  created_at?: string;
}

/** List an account's 1st-degree connections (relations). Compliant read. */
export async function listRelations(params: {
  accountId: string;
  limit?: number;
  cursor?: string;
}): Promise<{ items: UnipileRelation[]; cursor?: string }> {
  const qs = new URLSearchParams();
  qs.set("account_id", params.accountId);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  return unipileFetch<{ items: UnipileRelation[]; cursor?: string }>(
    `/users/relations?${qs}`,
  );
}

// ─── LinkedIn User / Profile ──────────────────────────────────────────────────

/**
 * LinkedIn profile as returned by Unipile's GET /users/{identifier}.
 *
 * Unipile's response shape varies across providers/API versions, so every
 * field beyond id/provider_id is optional and read defensively by callers
 * (see server/services/linkedinEnrichment/mapper.ts). Only fields the
 * authorized account is permitted to see are populated — Velocity never
 * scrapes; it stores whatever the vendor returns.
 */
export interface UnipileUserProfile {
  id: string;
  provider_id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  occupation?: string;
  summary?: string;
  location?: string;
  industry?: string;
  profile_picture_url?: string;
  public_profile_url?: string;
  public_identifier?: string;
  member_urn?: string;
  network_distance?: string | number;
  connections_count?: number;
  follower_count?: number;
  /** Current/last company convenience field (string or object on some versions). */
  current_company?: string | { name?: string; linkedin_url?: string; domain?: string };
  /** Structured work history — field names vary; mapper reads defensively. */
  work_experience?: Array<{
    company?: string;
    company_name?: string;
    title?: string;
    position?: string;
    location?: string;
    description?: string;
    start?: string;
    end?: string;
    current?: boolean;
    company_linkedin_url?: string;
    company_domain?: string;
  }>;
  education?: Array<{
    school?: string;
    degree?: string;
    field_of_study?: string;
    start?: string;
    end?: string;
  }>;
  skills?: Array<string | { name?: string }>;
  languages?: Array<string | { name?: string; proficiency?: string }>;
}

export async function getLinkedInProfile(
  accountId: string,
  providerId: string,
): Promise<UnipileUserProfile> {
  return unipileFetch<UnipileUserProfile>(
    `/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(accountId)}`,
  );
}

/**
 * Raw LinkedIn people-search hit. Unipile's search response field names vary
 * across API versions, so every field here is optional and callers read it
 * defensively.
 */
export interface UnipileLinkedInSearchHit {
  id?: string;
  provider_id?: string;
  public_identifier?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  title?: string;
  occupation?: string;
  location?: string;
  industry?: string;
  current_company?: string | { name?: string };
  company?: string | { name?: string };
  public_profile_url?: string;
  profile_url?: string;
  profile_picture_url?: string;
  network_distance?: string | number;
}

/**
 * Generalized LinkedIn search (POST /api/v1/linkedin/search). Supports both
 * the "classic" (keyword) API and "sales_navigator" (structured B2B filters).
 *
 * Sales Navigator filters like location/industry/company are LinkedIn entity
 * IDs, NOT plain strings — resolve them first via resolveLinkedInSearchParameter
 * and pass the numeric IDs in `filters` (e.g. { location: [102277331],
 * tenure: [{ min: 3 }], seniority: ["senior"] }). Classic search folds
 * everything into `keywords`.
 */
export async function searchLinkedIn(
  accountId: string,
  params: {
    api?: "classic" | "sales_navigator";
    category?: "people" | "companies";
    keywords?: string;
    filters?: Record<string, unknown>;
    limit?: number;
    cursor?: string;
  },
): Promise<{ items: UnipileLinkedInSearchHit[]; cursor?: string }> {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 25);
  const qs = new URLSearchParams({ account_id: accountId, limit: String(limit) });
  if (params.cursor) qs.set("cursor", params.cursor);
  const body: Record<string, unknown> = {
    api: params.api ?? "classic",
    category: params.category ?? "people",
    ...(params.keywords ? { keywords: params.keywords } : {}),
    ...(params.filters ?? {}),
  };
  const res = await unipileFetch<{ items?: UnipileLinkedInSearchHit[]; cursor?: string }>(
    `/linkedin/search?${qs}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { items: Array.isArray(res?.items) ? res.items : [], cursor: res?.cursor };
}

/**
 * Classic keyword people search. Thin wrapper over searchLinkedIn kept for the
 * autonomous prospecting engine + linkedinLookup, which pass folded keywords.
 */
export async function searchLinkedInPeople(
  accountId: string,
  params: { keywords: string; limit?: number },
): Promise<{ items: UnipileLinkedInSearchHit[] }> {
  const { items } = await searchLinkedIn(accountId, {
    api: "classic",
    category: "people",
    keywords: params.keywords,
    limit: params.limit,
  });
  return { items };
}

/** One resolved Sales-Navigator filter value (text → LinkedIn entity ID). */
export interface UnipileSearchParameter {
  id: string;
  title: string;
  object?: string;
}

/**
 * Resolve a Sales-Navigator filter term (a location/industry/company/etc.
 * name) into the LinkedIn entity ID the search endpoint requires.
 * GET /api/v1/linkedin/search/parameters?account_id=…&type=…&keywords=…
 */
export async function resolveLinkedInSearchParameter(
  accountId: string,
  type: string,
  keywords: string,
  limit = 10,
): Promise<{ items: UnipileSearchParameter[] }> {
  const qs = new URLSearchParams({
    account_id: accountId,
    type: type.toUpperCase(),
    keywords,
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  const res = await unipileFetch<{ items?: UnipileSearchParameter[] }>(
    `/linkedin/search/parameters?${qs}`,
  );
  return { items: Array.isArray(res?.items) ? res.items : [] };
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Source values accepted by POST /api/v1/webhooks. Verified against
 * Unipile's OpenAPI spec; older "relation" was renamed to "users".
 * Email tracking is a separate source from email — different payloads.
 */
export type UnipileWebhookSource =
  | "messaging"
  | "email"
  | "email_tracking"
  | "account_status"
  | "users"
  | "calendar_event";

export async function registerWebhook(params: {
  requestUrl: string;
  source: UnipileWebhookSource;
  secretKey?: string;
  /**
   * Optional event filter (only some sources accept this — email_tracking
   * uses it to subscribe to "mail_opened" and/or "mail_link_clicked").
   */
  events?: string[];
  /**
   * Optional field mapping (only some sources accept this — email_tracking
   * uses it to declare which fields show up in the push payload).
   */
  data?: Array<{ name: string; key: string }>;
}): Promise<{ id: string | null; raw: unknown }> {
  const headers: Array<{ key: string; value: string }> = [
    { key: "Content-Type", value: "application/json" },
  ];
  if (params.secretKey) {
    headers.push({ key: "Unipile-Auth", value: params.secretKey });
  }
  // Unipile's POST /webhooks response shape isn't documented consistently:
  // we've seen { id }, { webhook_id }, { object: "Webhook", id }, and even
  // a bare 201 with no body in different SDK versions. Capture the raw
  // response and return the id with a best-effort lookup.
  const body: Record<string, unknown> = {
    request_url: params.requestUrl,
    source: params.source,
    headers,
  };
  if (params.events) body.events = params.events;
  if (params.data) body.data = params.data;
  const raw = await unipileFetch<Record<string, unknown>>("/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(
    `[Unipile] registerWebhook raw response: ${JSON.stringify(raw).slice(0, 500)}`,
  );
  const id =
    (typeof raw?.id === "string" ? raw.id : null) ??
    (typeof raw?.webhook_id === "string" ? (raw.webhook_id as string) : null) ??
    (typeof (raw as { data?: { id?: string } })?.data?.id === "string"
      ? ((raw as { data: { id: string } }).data.id)
      : null);
  return { id, raw };
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

// ─── Calendar API ─────────────────────────────────────────────────────────────
// Verified against Unipile's OpenAPI spec (fetched 2026-05-10):
//   GET    /api/v1/calendars
//   GET    /api/v1/calendars/{calendar_id}
//   GET    /api/v1/calendars/{calendar_id}/events
//   POST   /api/v1/calendars/{calendar_id}/events
//   GET    /api/v1/calendars/{calendar_id}/events/{event_id}
//   PATCH  /api/v1/calendars/{calendar_id}/events/{event_id}
//   DELETE /api/v1/calendars/{calendar_id}/events/{event_id}
//
// Note: list responses use `data` (NOT `items` like the email API) and
// `next_cursor` (NOT `cursor`). Don't mix the two.

export interface UnipileCalendar {
  object?: string;
  id: string;
  version?: string;
  name: string;
  description?: string;
  is_read_only?: boolean;
  is_owned_by_user?: boolean;
  is_default?: boolean;
  is_primary?: boolean;
  access_role?: string;
  etag?: string;
  background_color?: string;
  foreground_color?: string;
  sync_activated?: boolean;
  sync_token?: string;
  timezone?: string;
}

export interface UnipileCalendarListResponse {
  data: UnipileCalendar[];
  next_cursor?: string | null;
}

/**
 * Event start/end are an anyOf: timed events use { date_time, time_zone };
 * all-day events use { date } where date is "YYYY-MM-DD" in the calendar's
 * timezone (Unipile doesn't include the time zone for all-day events).
 */
export type UnipileEventTimestamp =
  | { date_time: string; time_zone?: string }
  | { date: string };

export interface UnipileEventAttendee {
  email: string;
  display_name?: string;
  comment?: string;
  is_organizer?: boolean;
  is_optional?: boolean;
  is_resource?: boolean;
  type?: string;
  response_status?: string;
}

export type UnipileConferenceProvider = "google_meet" | "zoom" | "teams" | "unknown";

export interface UnipileEvent {
  object?: string;
  id: string;
  master_event_id?: string;
  calendar_id?: string;
  created_at?: string;
  updated_at?: string;
  title: string;
  body?: string;
  location?: string;
  is_cancelled?: boolean;
  is_all_day?: boolean;
  is_attendees_list_hidden?: boolean;
  attendees?: UnipileEventAttendee[];
  start: UnipileEventTimestamp;
  end: UnipileEventTimestamp;
  recurrence?: string[];
  organizer?: { email?: string; display_name?: string };
  conference?: { provider?: UnipileConferenceProvider; url?: string };
  visibility?: string;
  transparency?: string;
  event_type?: string;
  guests_can_modify?: boolean;
}

export interface UnipileEventListResponse {
  data: UnipileEvent[];
  next_cursor?: string | null;
}

/** GET /api/v1/calendars?account_id=... */
export async function listCalendars(
  accountId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<UnipileCalendarListResponse> {
  const qs = new URLSearchParams({ account_id: accountId });
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit) qs.set("limit", String(opts.limit));
  return unipileFetch<UnipileCalendarListResponse>(`/calendars?${qs.toString()}`);
}

/** GET /api/v1/calendars/{calendar_id}?account_id=... */
export async function getCalendar(
  calendarId: string,
  accountId: string,
): Promise<UnipileCalendar> {
  const qs = new URLSearchParams({ account_id: accountId });
  return unipileFetch<UnipileCalendar>(
    `/calendars/${encodeURIComponent(calendarId)}?${qs.toString()}`,
  );
}

/**
 * GET /api/v1/calendars/{calendar_id}/events?account_id=...&start=...&end=...
 * Both `start` and `end` are ISO datetime strings — anything overlapping the
 * window comes back. Recurring events are expanded by default unless you
 * pass expand_recurring=false.
 */
export async function listCalendarEvents(params: {
  accountId: string;
  calendarId: string;
  start?: string;
  end?: string;
  cursor?: string;
  limit?: number;
  expandRecurring?: boolean;
}): Promise<UnipileEventListResponse> {
  const qs = new URLSearchParams({ account_id: params.accountId });
  if (params.start) qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.expandRecurring === false) qs.set("expand_recurring", "false");
  return unipileFetch<UnipileEventListResponse>(
    `/calendars/${encodeURIComponent(params.calendarId)}/events?${qs.toString()}`,
  );
}

/** GET /api/v1/calendars/{calendar_id}/events/{event_id}?account_id=... */
export async function getCalendarEvent(
  calendarId: string,
  eventId: string,
  accountId: string,
): Promise<UnipileEvent> {
  const qs = new URLSearchParams({ account_id: accountId });
  return unipileFetch<UnipileEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${qs.toString()}`,
  );
}

/**
 * POST /api/v1/calendars/{calendar_id}/events?account_id=...
 * Returns { object: "EventCreated", event_id }.
 */
export async function createCalendarEvent(params: {
  accountId: string;
  calendarId: string;
  title: string;
  body?: string;
  location?: string;
  start: UnipileEventTimestamp;
  end: UnipileEventTimestamp;
  attendees?: Array<{ email: string }>;
  conference?: { provider: UnipileConferenceProvider; url?: string };
  notify?: boolean;
  guestsCanModify?: boolean;
  visibility?: string;
  transparency?: string;
  recurrence?: string[];
}): Promise<{ object: string; event_id: string }> {
  const qs = new URLSearchParams({ account_id: params.accountId });
  const body: Record<string, unknown> = {
    title: params.title,
    start: params.start,
    end: params.end,
    attendees: params.attendees ?? [],
  };
  if (params.body !== undefined) body.body = params.body;
  if (params.location !== undefined) body.location = params.location;
  if (params.conference) body.conference = params.conference;
  if (params.notify !== undefined) body.notify = params.notify;
  if (params.guestsCanModify !== undefined) body.guests_can_modify = params.guestsCanModify;
  if (params.visibility) body.visibility = params.visibility;
  if (params.transparency) body.transparency = params.transparency;
  if (params.recurrence) body.recurrence = params.recurrence;
  return unipileFetch<{ object: string; event_id: string }>(
    `/calendars/${encodeURIComponent(params.calendarId)}/events?${qs.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** PATCH /api/v1/calendars/{calendar_id}/events/{event_id}?account_id=... */
export async function updateCalendarEvent(params: {
  accountId: string;
  calendarId: string;
  eventId: string;
  title?: string;
  body?: string;
  location?: string;
  start?: UnipileEventTimestamp;
  end?: UnipileEventTimestamp;
  attendees?: Array<{ email: string }>;
  conference?: { provider: UnipileConferenceProvider; url?: string };
  notify?: boolean;
  guestsCanModify?: boolean;
  visibility?: string;
  transparency?: string;
  recurrence?: string[];
}): Promise<{ object: string }> {
  const qs = new URLSearchParams({ account_id: params.accountId });
  const body: Record<string, unknown> = {};
  if (params.title !== undefined) body.title = params.title;
  if (params.body !== undefined) body.body = params.body;
  if (params.location !== undefined) body.location = params.location;
  if (params.start !== undefined) body.start = params.start;
  if (params.end !== undefined) body.end = params.end;
  if (params.attendees !== undefined) body.attendees = params.attendees;
  if (params.conference) body.conference = params.conference;
  if (params.notify !== undefined) body.notify = params.notify;
  if (params.guestsCanModify !== undefined) body.guests_can_modify = params.guestsCanModify;
  if (params.visibility) body.visibility = params.visibility;
  if (params.transparency) body.transparency = params.transparency;
  if (params.recurrence) body.recurrence = params.recurrence;
  return unipileFetch<{ object: string }>(
    `/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}?${qs.toString()}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Push payload from Unipile's "Email Tracking" webhook (source=email_tracking).
 *
 * The webhook configuration's `data` array controls which fields show up
 * in the body. registerEmailTrackingWebhook below requests:
 *   type, tracking_id, date, email_id, account_id, url, label, ip, user_agent
 *
 * `type` is the event name — observed values: "mail_opened" /
 * "mail_link_clicked". `tracking_id` is what we stored on
 * emailDrafts.trackingToken at send time.
 */
export interface EmailTrackingWebhookPayload {
  /**
   * Event type. Unipile's runtime field is `event` ("mail_opened" /
   * "mail_link_clicked"). When we register via our tRPC helper we also
   * request a `type` alias in the data config, so handlers should accept
   * either — dashboard-registered webhooks only provide `event`.
   */
  event?: string;
  type?: string;
  tracking_id?: string;
  date?: string;
  email_id?: string;
  event_id?: string;
  account_id?: string;
  url?: string | null;
  label?: string;
  ip?: string;
  user_agent?: string;
  /** Webhook name configured on registration — handy for log triage. */
  webhook_name?: string;
}

/**
 * Push payload from Unipile's "Calendar Events" webhook (source=calendar_event).
 * Fires for calendar_event_created / calendar_event_updated / calendar_event_deleted.
 * Created/updated carry the full event body; deleted carries only id + calendar_id.
 */
export type CalendarWebhookPayload =
  | (UnipileEvent & {
      event: "calendar_event_created" | "calendar_event_updated";
      webhook_name?: string;
      account_id: string;
      color?: string;
    })
  | {
      event: "calendar_event_deleted";
      webhook_name?: string;
      account_id: string;
      id: string;
      calendar_id: string;
    };

/** DELETE /api/v1/calendars/{calendar_id}/events/{event_id}?account_id=... */
export async function deleteCalendarEvent(params: {
  accountId: string;
  calendarId: string;
  eventId: string;
}): Promise<{ object: string }> {
  const qs = new URLSearchParams({ account_id: params.accountId });
  return unipileFetch<{ object: string }>(
    `/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}?${qs.toString()}`,
    { method: "DELETE" },
  );
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
