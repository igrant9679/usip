/**
 * Friendly copy for a FORBIDDEN mutation error.
 *
 * Every onError that wrote `e.message.includes("FORBIDDEN") ? friendly : …`
 * was a dead branch: the server's role gate throws
 * `TRPCError({ code: "FORBIDDEN", message: "Requires admin role" })`
 * (server/_core/workspace.ts roleAtLeast), so the MESSAGE never contains the
 * word FORBIDDEN — the code does. This helper checks the code (with the
 * message patterns as belt-and-braces for procs that throw their own
 * FORBIDDEN text) so the friendly line finally shows (audit 2026-09-20).
 */
export function forbiddenMessage(e: unknown, friendly: string): string {
  const err = e as { data?: { code?: string } | null; message?: string } | null;
  const msg = err?.message ?? "";
  const isForbidden =
    err?.data?.code === "FORBIDDEN" ||
    msg.includes("FORBIDDEN") ||
    /^Requires \w+ role$/.test(msg) ||
    /^Only (the )?(super )?admins?\b/.test(msg);
  return isForbidden ? friendly : msg || "Something went wrong";
}
