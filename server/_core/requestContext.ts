/**
 * Per-request async-context store. Lets deeply nested code (e.g. `invokeLLM`
 * inside helper functions) read the active workspaceId without threading it
 * through every function signature.
 *
 * Set by `workspaceProcedure` middleware. For background jobs (cron, workers)
 * that have no request context, callers should pass `workspaceId` explicitly.
 */
import { AsyncLocalStorage } from "async_hooks";

type RequestStore = {
  workspaceId?: number;
  userId?: number;
};

const als = new AsyncLocalStorage<RequestStore>();

export function runWithRequestContext<T>(
  store: RequestStore,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return als.run(store, fn);
}

export function getRequestWorkspaceId(): number | undefined {
  return als.getStore()?.workspaceId;
}

export function getRequestUserId(): number | undefined {
  return als.getStore()?.userId;
}
