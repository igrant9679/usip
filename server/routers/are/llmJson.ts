/**
 * Parse JSON out of an LLM response, tolerating the markdown code fences
 * models sometimes wrap structured output in (```json ... ```).
 *
 * Throws a descriptive Error carrying a payload snippet instead of a bare
 * SyntaxError ("Unexpected token …"), so the failure reasons persisted to
 * prospect_queue.enrichmentError / engine logs are actually diagnosable.
 */
// Default T=any: call sites destructure freely, matching the previous
// untyped JSON.parse behavior (esbuild doesn't typecheck, tsc shouldn't nag).
export function parseLlmJson<T = any>(content: unknown, label: string): T {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const cleaned = raw.trim().replace(/^```[\w]*\n?|\n?```$/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`${label}: LLM returned non-JSON output: ${cleaned.slice(0, 200)}`);
  }
}
