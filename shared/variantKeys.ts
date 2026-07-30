/**
 * variantKeys.ts — the ONE definition of an ARE message variant key.
 *
 * `are_execution_queue.messageContent.variantKey` is the group-by key behind the
 * ARE A/B tab (`performanceMetrics.getAbVariantStats`). It is produced by the
 * per-prospect LLM writer: `personalizeForProspect`'s JSON schema requires a
 * `variantKey` string, and **neither of that call's prompts ever mentions it**
 * — no A/B instruction, and the campaign skeleton it is shown carries no
 * variantKey field either. So the value was whatever the model felt like
 * emitting ("A", "v1", "variant-a", "opener"), flowing straight into the queue
 * row and becoming a chart axis.
 *
 * Two consequences, both silent:
 *   • identical copy under two different model-invented keys renders as two
 *     "variants" with split sample sizes — a comparison of nothing against
 *     nothing, with sampleSufficient never reached;
 *   • `are_ab_variants.variantKey` is varchar(8), so a longer key cannot even
 *     be stored alongside the send it describes.
 *
 * Rule going forward: a variant key is a label THIS SYSTEM assigns, never
 * free text that arrives from a model or a stored row. Anything that is not a
 * single A–Z letter collapses to "A" deliberately — a stray string is not
 * evidence that an experiment ran, and inventing a variant from model noise is
 * how the tab came to claim two variants it never had.
 *
 * If real ARE A/B is ever built, the assignment mechanism belongs HERE (a pure
 * split by prospect id, say), not in a prompt: a variant the model chooses is
 * not a randomised trial.
 */

/** The only variant keys anything in ARE currently produces. */
export const ARE_VARIANT_KEYS = ["A", "B"] as const;
export type AreVariantKey = (typeof ARE_VARIANT_KEYS)[number];

/** The bucket every unassigned or unrecognised send belongs to. */
export const DEFAULT_VARIANT_KEY = "A";

/**
 * Coerce anything into a usable variant key.
 *
 * Applied at BOTH ends on purpose: at the write, so nothing dirty is stored,
 * and at the read, so the rows already written before this existed still fold
 * into the right cell instead of minting phantom variants forever.
 */
export function normalizeVariantKey(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_VARIANT_KEY;
  const key = raw.trim().toUpperCase();
  return /^[A-Z]$/.test(key) ? key : DEFAULT_VARIANT_KEY;
}
