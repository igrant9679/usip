/**
 * enrichmentErrorLabel — turn a stored enrichment failure reason into what a
 * person should read.
 *
 * The enrichment sweeper writes machine strings such as "quickenrich:
 * no_match" into `enrichmentError`. That is the truth, and it stays in the
 * row's tooltip — but as the visible line it reads like a fault when it is a
 * fact: this person is simply not in QuickEnrich's database. Owner ask
 * 2026-08-19: show it as "Not in QuickEnrich", in brown (information, not
 * alarm). Genuine failures keep the red.
 */
export type EnrichmentErrorTone = "info" | "warn" | "error";

export interface EnrichmentErrorLabel {
  label: string;
  tone: EnrichmentErrorTone;
}

export function describeEnrichmentError(raw: string | null | undefined): EnrichmentErrorLabel | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = /^quickenrich:\s*(\S+)(.*)$/i.exec(s);
  if (m) {
    const reason = m[1].toLowerCase();
    const rest = m[2] ?? "";
    if (reason === "no_match") return { label: "Not in QuickEnrich", tone: "info" };
    if (/transport failure|will retry/i.test(rest)) return { label: "QuickEnrich unavailable — will retry", tone: "warn" };
    return { label: `QuickEnrich: ${reason.replace(/_/g, " ")}`, tone: "warn" };
  }
  return { label: s, tone: "error" };
}

// NOTE: the Tailwind classes per tone live in the client (ARECampaignDetail),
// not here — Tailwind v4's content scan is rooted at client/ and does not see
// shared/, so a class string defined here is never generated.
