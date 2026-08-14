/**
 * areSignals.ts — the ONE definition of what an ARE signal MEANS.
 *
 * `are_signal_log` stores a machine vocabulary: `signalType` ("email_open"),
 * an `actionTaken` slug ("added_suppression") and a free-form `rawPayload`
 * JSON blob whose shape differs per producer. The Signals tab rendered those
 * slugs directly, so the feed read "Email open · neutral" with a timestamp —
 * WHO opened it and WHAT they opened were both in the row's neighbours
 * (prospect_queue, are_execution_queue) and in rawPayload, and neither was
 * shown.
 *
 * This module turns a row into the three things a human wants from an activity
 * feed — who, what, when — without the UI having to know each producer's
 * payload keys:
 *
 *   • ARE_SIGNALS       — per type: label, plain-English predicate, channel,
 *                         default tone, and whether the PROSPECT or the ENGINE
 *                         performed it (a feed that attributes an engine action
 *                         to the prospect is lying about who did it).
 *   • describeSignal    — the payload facts worth showing, per type, plus a
 *                         generic sweep so a producer that adds a key gets it
 *                         surfaced instead of swallowed.
 *   • ARE_SIGNAL_ACTIONS — the `actionTaken` slugs, in the same plain English.
 *
 * Rule going forward: a signalType may appear here only if it also exists in
 * the `are_signal_log.signalType` enum (drizzle/schema.ts) and in
 * `execution.ingestSignal`'s input. Keep all three in step — a type missing
 * here still renders, but as its bare slug.
 */

export type AreSignalId =
  | "email_open"
  | "email_click"
  | "email_reply"
  | "email_bounce"
  | "email_unsubscribe"
  | "linkedin_accepted"
  | "linkedin_reply"
  | "sms_reply"
  | "sms_unsubscribe"
  | "voice_connected_interested"
  | "voice_connected_not_interested"
  | "voice_voicemail"
  | "voice_no_answer"
  | "meeting_booked"
  | "opportunity_created";

export type AreSignalChannel = "email" | "linkedin" | "sms" | "voice" | "meeting" | "crm";

export interface AreSignalMeta {
  id: AreSignalId;
  /** Short noun phrase — filter chips, badges, column headers. */
  label: string;
  /**
   * Predicate completing "<who> …". The feed reads as a sentence:
   * "Dana Reyes opened your email".
   */
  verb: string;
  channel: AreSignalChannel;
  /** Fallback colouring when the row carries no AI-classified sentiment. */
  tone: "positive" | "neutral" | "negative";
  /**
   * Who performed the act. `prospect` = the person did it; `system` = Velocity
   * did it on their behalf (a booking that arrived through the engine, a deal
   * the automation opened). Drives the "who" side of who-did-what.
   */
  actor: "prospect" | "system";
}

export const ARE_SIGNALS: readonly AreSignalMeta[] = [
  { id: "email_open", label: "Email open", verb: "opened your email", channel: "email", tone: "positive", actor: "prospect" },
  { id: "email_click", label: "Link click", verb: "clicked a link in your email", channel: "email", tone: "positive", actor: "prospect" },
  { id: "email_reply", label: "Email reply", verb: "replied to your email", channel: "email", tone: "positive", actor: "prospect" },
  { id: "email_bounce", label: "Bounce", verb: "could not be reached — the email bounced", channel: "email", tone: "negative", actor: "system" },
  { id: "email_unsubscribe", label: "Unsubscribe", verb: "unsubscribed from your emails", channel: "email", tone: "negative", actor: "prospect" },
  { id: "linkedin_accepted", label: "Invite accepted", verb: "accepted your LinkedIn invitation", channel: "linkedin", tone: "positive", actor: "prospect" },
  { id: "linkedin_reply", label: "LinkedIn reply", verb: "replied on LinkedIn", channel: "linkedin", tone: "positive", actor: "prospect" },
  { id: "sms_reply", label: "SMS reply", verb: "replied by text message", channel: "sms", tone: "positive", actor: "prospect" },
  { id: "sms_unsubscribe", label: "SMS opt-out", verb: "opted out of text messages", channel: "sms", tone: "negative", actor: "prospect" },
  { id: "voice_connected_interested", label: "Call — interested", verb: "took your call and was interested", channel: "voice", tone: "positive", actor: "prospect" },
  { id: "voice_connected_not_interested", label: "Call — not interested", verb: "took your call and was not interested", channel: "voice", tone: "negative", actor: "prospect" },
  { id: "voice_voicemail", label: "Voicemail", verb: "did not pick up — voicemail was left", channel: "voice", tone: "neutral", actor: "system" },
  { id: "voice_no_answer", label: "No answer", verb: "did not answer the call", channel: "voice", tone: "neutral", actor: "prospect" },
  { id: "meeting_booked", label: "Meeting booked", verb: "booked a meeting", channel: "meeting", tone: "positive", actor: "prospect" },
  { id: "opportunity_created", label: "Opportunity created", verb: "was opened as an opportunity", channel: "crm", tone: "positive", actor: "system" },
] as const;

const SIGNAL_BY_ID = new Map<string, AreSignalMeta>(ARE_SIGNALS.map((s) => [s.id, s]));

/**
 * Title-cased fallback for a slug this module has not been taught yet.
 *
 * Handles both vocabularies it meets: signal types and actionTaken are
 * snake_case, while rawPayload keys come from whatever producer wrote them and
 * are camelCase ("deviceType" → "Device type").
 */
export function humanizeSlug(slug: string): string {
  const spaced = String(slug ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!spaced) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Metadata for a signal type. Never throws and never returns undefined: an
 * unknown type (a producer added one and forgot this file) degrades to its
 * humanized slug rather than blanking the row.
 */
export function signalMeta(signalType: string): AreSignalMeta {
  const known = SIGNAL_BY_ID.get(signalType);
  if (known) return known;
  return {
    id: signalType as AreSignalId,
    label: humanizeSlug(signalType) || "Signal",
    verb: humanizeSlug(signalType).toLowerCase() || "produced a signal",
    channel: signalType.startsWith("linkedin")
      ? "linkedin"
      : signalType.startsWith("sms")
        ? "sms"
        : signalType.startsWith("voice")
          ? "voice"
          : "email",
    tone: "neutral",
    actor: "prospect",
  };
}

/* ─── actionTaken vocabulary ─────────────────────────────────────────────── */

/**
 * The `actionTaken` slugs processSignal writes. Every one of these is done BY
 * VELOCITY, not by the prospect — the feed labels them accordingly, because
 * "added suppression" sitting under a person's name reads as though they did
 * it.
 */
export const ARE_SIGNAL_ACTIONS: Record<string, string> = {
  no_action: "No action taken",
  paused_sequence: "Paused their sequence",
  flagged_for_opportunity: "Flagged for an opportunity",
  promoted_to_crm: "Added them to Contacts and Companies",
  added_suppression: "Added them to the suppression list",
  meeting_booked: "Recorded the meeting against this campaign",
  opportunity_created: "Opened an opportunity in the pipeline",
};

export function actionLabel(actionTaken?: string | null): string | null {
  const slug = (actionTaken ?? "").trim();
  if (!slug || slug === "no_action") return null;
  return ARE_SIGNAL_ACTIONS[slug] ?? humanizeSlug(slug);
}

/* ─── rawPayload → the facts worth showing ───────────────────────────────── */

export interface SignalDetail {
  label: string;
  value: string;
  /** Set when the value is a URL the UI should render as a link. */
  href?: string;
}

/** Keys handled explicitly below, or too internal to show as a generic fact. */
const CLAIMED_KEYS = new Set([
  "url", "link", "clickedUrl", "clicked_url",
  "body", "text", "message", "snippet",
  "subject",
  "reason", "error", "bounceReason", "bounce_reason", "diagnostic", "diagnosticCode",
  "meetingId", "meeting_id",
  "stepIndex", "step_index",
  "source",
  "fromEmail", "from_email", "from",
  "durationSeconds", "duration_seconds", "duration",
  "opportunityId", "opportunity_id",
]);

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function firstString(payload: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(payload[k]);
    if (v) return v;
  }
  return "";
}

/** Collapse whitespace and cut to a readable excerpt. */
export function excerpt(text: string, max = 220): string {
  const flat = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The per-type specifics behind a signal: the URL that was clicked, what the
 * reply said, why it bounced, which step it answers.
 *
 * The tail is deliberately generic — any scalar key a producer adds that this
 * file does not claim is surfaced as its own fact. A signal feed that hides
 * payload keys until someone teaches it each one is how "we recorded it" and
 * "you can see it" drift apart.
 */
export function describeSignal(
  signalType: string,
  rawPayload: unknown,
): SignalDetail[] {
  const payload: Record<string, unknown> =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const details: SignalDetail[] = [];

  const url = firstString(payload, ["url", "link", "clickedUrl", "clicked_url"]);
  if (url) details.push({ label: "Link", value: url, href: url });

  const body = firstString(payload, ["body", "text", "message", "snippet"]);
  if (body) {
    details.push({
      label: signalType.endsWith("_reply") ? "What they said" : "Message",
      value: excerpt(body),
    });
  }

  const subject = str(payload.subject);
  if (subject) details.push({ label: "Subject", value: subject });

  const reason = firstString(payload, [
    "reason", "error", "bounceReason", "bounce_reason", "diagnostic", "diagnosticCode",
  ]);
  if (reason) details.push({ label: "Reason", value: excerpt(reason, 160) });

  const from = firstString(payload, ["fromEmail", "from_email", "from"]);
  if (from) details.push({ label: "From", value: from });

  const duration = firstString(payload, ["durationSeconds", "duration_seconds", "duration"]);
  if (duration) details.push({ label: "Call length", value: `${duration}s` });

  const meetingId = firstString(payload, ["meetingId", "meeting_id"]);
  if (meetingId) details.push({ label: "Meeting", value: `#${meetingId}` });

  const opportunityId = firstString(payload, ["opportunityId", "opportunity_id"]);
  if (opportunityId) details.push({ label: "Opportunity", value: `#${opportunityId}` });

  // Anything else scalar the producer recorded. Sorted so the order is stable
  // between renders regardless of JSON key order.
  for (const key of Object.keys(payload).sort()) {
    if (CLAIMED_KEYS.has(key)) continue;
    const value = str(payload[key]);
    if (!value) continue;
    details.push({ label: humanizeSlug(key), value: excerpt(value, 120) });
  }

  return details;
}

/**
 * How the signal reached us, in words. `stepIndex` is zero-based on the wire
 * and one-based to humans — the Prospects and Step-performance tabs already
 * count steps from 1, and a feed that says "step 0" disagrees with both.
 */
export function signalSourceLabel(rawPayload: unknown): string | null {
  const payload: Record<string, unknown> =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const source = str(payload.source);
  const SOURCES: Record<string, string> = {
    tracking_pixel: "Detected by the open-tracking pixel",
    autonomous_booking: "Booked through Velocity",
  };
  if (!source) return null;
  return SOURCES[source] ?? humanizeSlug(source);
}

/** Zero-based step index → "Step 3". Null when the payload carries none. */
export function stepLabelFromPayload(rawPayload: unknown): string | null {
  const payload: Record<string, unknown> =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const raw = payload.stepIndex ?? payload.step_index;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return `Step ${n + 1}`;
}
