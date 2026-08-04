/**
 * Per-request async-context store. Lets deeply nested code (e.g. `invokeLLM`
 * inside helper functions) read the active workspaceId without threading it
 * through every function signature.
 *
 * Established for EVERY tRPC call by the base middleware in `_core/trpc.ts`
 * (client IP), then narrowed by `workspaceProcedure` (workspaceId + userId).
 * Background jobs (cron, workers) have no request context at all and should
 * pass `workspaceId` explicitly.
 */
import { AsyncLocalStorage } from "async_hooks";

type RequestStore = {
  workspaceId?: number;
  userId?: number;
  /**
   * First hop of x-forwarded-for, else the socket address. The key the public
   * LLM ceiling falls back to when there is no signed-in user.
   */
  clientIp?: string;
};

const als = new AsyncLocalStorage<RequestStore>();

export function runWithRequestContext<T>(
  store: RequestStore,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return als.run(store, fn);
}

/**
 * Add to the current store rather than replace it.
 *
 * ⚠️ `als.run` installs a NEW store, so a second `runWithRequestContext` deeper
 * in the stack silently DROPS whatever the outer one set. That is exactly what
 * would happen to `clientIp` when `workspaceProcedure` runs after the base
 * middleware — the ceiling would then have neither a user (not yet set at the
 * time it mattered) nor an IP, and would quietly no-op. Merge instead.
 */
export function mergeRequestContext<T>(
  patch: RequestStore,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return als.run({ ...(als.getStore() ?? {}), ...patch }, fn);
}

export function getRequestWorkspaceId(): number | undefined {
  return als.getStore()?.workspaceId;
}

export function getRequestUserId(): number | undefined {
  return als.getStore()?.userId;
}

export function getRequestClientIp(): string | undefined {
  return als.getStore()?.clientIp;
}
