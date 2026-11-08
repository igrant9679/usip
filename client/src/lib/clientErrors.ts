/**
 * Report the browser's errors to the server (audit 2026-10-20, F49), so a
 * broken screen shows on the admin engine status page before a customer says
 * so. server/clientErrors.ts stores them, scrubbed, for the workspace.
 *
 * What is sent: the error's kind, message and stack, and the page's path, and
 * nothing else. No form values, no URL query string or fragment, no cookies
 * (the request carries the session cookie for who is signed in, as every call
 * does, and the server reads nothing else from it). Each distinct message is
 * sent once per page load, and at most ten in all, so a render loop cannot
 * flood the endpoint; the server also limits per address and per person.
 */
import { getActiveWorkspaceId } from "./activeWorkspace";

export type ClientErrorKind = "error" | "rejection" | "boundary";

const MAX_PER_LOAD = 10;
const sent = new Set<string>();

/** The message, path and stack of a report, with query strings and emails taken out before they leave. */
export function clientErrorPayload(kind: ClientErrorKind, error: unknown, pathname: string) {
  const e = error as { message?: unknown; stack?: unknown; reason?: unknown } | null | undefined;
  const raw = typeof e?.message === "string" ? e.message : typeof error === "string" ? error : String(error ?? "Unknown error");
  const strip = (s: string) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>").replace(/([^\s?#)"']*)[?#][^\s)"']*/g, "$1");
  return {
    kind,
    message: strip(raw).slice(0, 500),
    stack: typeof e?.stack === "string" ? strip(e.stack).slice(0, 4000) : undefined,
    path: pathname.split(/[?#]/)[0].slice(0, 255),
  };
}

export function reportClientError(kind: ClientErrorKind, error: unknown): void {
  try {
    if (typeof window === "undefined" || typeof fetch !== "function") return;
    const body = clientErrorPayload(kind, error, window.location.pathname);
    if (!body.message) return;
    const key = `${kind}:${body.message}`;
    if (sent.has(key) || sent.size >= MAX_PER_LOAD) return;
    sent.add(key);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const ws = getActiveWorkspaceId();
    if (ws) headers["x-workspace-id"] = ws;
    void fetch("/api/client-errors", { method: "POST", headers, body: JSON.stringify(body), credentials: "include", keepalive: true }).catch(() => {});
  } catch {
    // Reporting an error must never cause one.
  }
}

let installed = false;

/** Listen for uncaught errors and unhandled rejections, once. */
export function installClientErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    // A failed <img>/<script> load fires here with no error object: not a code error.
    if (!ev.error && !ev.message) return;
    reportClientError("error", ev.error ?? ev.message);
  });
  window.addEventListener("unhandledrejection", (ev) => reportClientError("rejection", ev.reason));
}
