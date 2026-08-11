/**
 * Generic organizational inbox detection — ONE definition shared by server
 * (enrichment upgrade ladder, scrape fallback ranking) and client (the
 * "Catch-all (generic inbox)" label).
 *
 * NOT the same concept as Reoon's `accept_all` verdict: that says "this
 * DOMAIN accepts any address"; this says "this LOCAL PART is a shared
 * organizational inbox, not a person". The two must never be conflated —
 * a generic inbox can be Reoon-valid and still not be a person.
 */
export const GENERIC_INBOX_RE =
  /^(info|contact|hello|help|support|sales|admin|admissions|enrollment|enrolment|reception|team|office|mail|enquiries|inquiries|marketing|hr|jobs|careers|press|media|billing|accounts|noreply|no-reply)@/i;

export function isGenericInboxEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim();
  return !!e && GENERIC_INBOX_RE.test(e);
}
