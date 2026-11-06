/**
 * A tRPC error as a sentence a person can read (audit 2026-10-20, P121).
 *
 * When a procedure's input fails its zod check, the error's message IS the
 * issue list, JSON-encoded, so a toast showed `[{"origin":"number","code":
 * "too_big",…}]`. This turns that list into "Org type weight: Too big:
 * expected number to be <=40", naming each field by `labels` where given, and
 * passes any other message through unchanged.
 */
export function readableErrorMessage(err: { message: string }, labels: Record<string, string> = {}): string {
  const raw = err?.message ?? "";
  if (!raw.trimStart().startsWith("[")) return raw;
  try {
    const issues = JSON.parse(raw) as unknown;
    if (!Array.isArray(issues) || issues.length === 0) return raw;
    const parts = issues.map((i) => {
      if (!i || typeof i !== "object" || typeof (i as { message?: unknown }).message !== "string") return null;
      const path = (i as { path?: unknown }).path;
      const key = Array.isArray(path) && path.length ? String(path[path.length - 1]) : "";
      const name = labels[key] ?? key;
      return name ? `${name}: ${(i as { message: string }).message}` : (i as { message: string }).message;
    });
    if (parts.some((p) => p == null)) return raw;
    return parts.slice(0, 3).join(" · ") + (parts.length > 3 ? ` (and ${parts.length - 3} more)` : "");
  } catch {
    return raw;
  }
}
