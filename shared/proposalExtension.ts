/**
 * Proposal extension requests are activity rows on the proposal; this is the
 * one vocabulary their writers and readers share (audit 2026-10-20, R23).
 *
 * 🔴 THE BUG. The portal wrote a request as "Client requested an extension"
 * and a decline as "Extension request declined", while every reader — the
 * pending list, the client's status, the 48h and 72h SLA nudges — looked for
 * "Extension requested" and "Extension declined". No request was ever
 * pending, no SLA fired, and a declined request still read as open. The
 * readers also asked "was there EVER a resolution", so a second request after
 * an approval never showed up.
 *
 * Now writers use EXTENSION_SUBJECT, readers classify with extensionEventOf
 * (which still recognises the old wording, and migration 0214 rewrites it),
 * and a request is open when it is the LATEST extension event.
 */

export const EXTENSION_SUBJECT = {
  requested: "Extension requested",
  approved: "Extension approved",
  declined: "Extension declined",
} as const;

export type ExtensionEvent = keyof typeof EXTENSION_SUBJECT;

const LEGACY: Record<string, ExtensionEvent> = {
  "client requested an extension": "requested",
  "extension request declined": "declined",
};

/** Which extension event an activity subject records, if any. */
export function extensionEventOf(subject: string | null | undefined): ExtensionEvent | null {
  const s = (subject ?? "").trim().toLowerCase();
  if (!s) return null;
  if (LEGACY[s]) return LEGACY[s];
  for (const k of Object.keys(EXTENSION_SUBJECT) as ExtensionEvent[]) {
    if (s.startsWith(EXTENSION_SUBJECT[k].toLowerCase())) return k;
  }
  return null;
}

/**
 * The request still waiting for an answer: the latest extension event, when
 * it is a request. `acts` in any order; each needs its subject and when.
 */
export function openExtensionRequest<T extends { subject: string | null; occurredAt: Date | string | null }>(acts: T[]): T | null {
  const ext = acts
    .filter((a) => extensionEventOf(a.subject) !== null)
    .sort((a, b) => new Date(a.occurredAt ?? 0).getTime() - new Date(b.occurredAt ?? 0).getTime());
  const latest = ext[ext.length - 1];
  return latest && extensionEventOf(latest.subject) === "requested" ? latest : null;
}
