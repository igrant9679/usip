/**
 * Client error reporting (audit 2026-10-20, F49).
 *
 * A screen that broke in the browser was known only when a customer said so.
 * The page now reports window errors, unhandled rejections and error-boundary
 * catches here (client/src/lib/clientErrors.ts), and the admin engine status
 * page lists them for the workspace.
 *
 * What is kept, and what never is:
 *  - the error's message (500 characters) and stack (4,000), each scrubbed of
 *    email addresses, URL query strings and fragments, and long tokens;
 *  - the page's path, without its query string or fragment;
 *  - the build, the kind, the workspace and the person.
 *  Never a form value, a cookie, a header, a URL's query string or the
 *  request body beyond those fields: the client sends nothing else, and
 *  anything else in the body is ignored.
 *
 * Only a signed-in member's report is stored, against their workspace; any
 * other report is a single scrubbed console line. Rate limits: per address
 * (30 a minute, express-rate-limit) and per person (20 in ten minutes, here).
 * Rows older than 30 days are pruned as new ones arrive.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { lt } from "drizzle-orm";
import { clientErrors } from "../drizzle/schema";
import { rateLimitKey } from "./_core/clientIp";
import { sdk } from "./_core/sdk";
import { workspaceDoorRefusal } from "./_core/workspace";
import { getDb } from "./db";
import { deployedCommit } from "./health";

export const CLIENT_ERROR_KINDS = ["error", "rejection", "boundary"] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

const MESSAGE_MAX = 500;
const STACK_MAX = 4000;
const PATH_MAX = 255;
const PER_USER_MAX = 20;
const PER_USER_WINDOW_MS = 10 * 60_000;
const RETENTION_DAYS = 30;

/** Emails, query strings and fragments, and long opaque tokens, out of a message or a stack. */
export function scrubClientText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    // A URL keeps its path and loses its query string and fragment.
    .replace(/(https?:\/\/[^\s?#)"']*)[?#][^\s)"']*/g, "$1")
    .replace(/(\/[\w./-]*)\?[^\s)"':]*/g, "$1")
    // Bearer tokens, JWTs, hex and base64 runs.
    .replace(/\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9_-]{32,}|[a-f0-9]{24,})\b/g, "<token>");
}

/** The page's path only: no origin, query string or fragment. */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let p = raw;
  try { if (/^https?:\/\//.test(p)) p = new URL(p).pathname; } catch { return null; }
  p = p.split(/[?#]/)[0];
  if (!p.startsWith("/")) return null;
  return scrubClientText(p).slice(0, PATH_MAX);
}

export interface CleanReport {
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  path: string | null;
  release: string | null;
}

/** The fields kept from a report body, cleaned; null when there is nothing to keep. */
export function cleanReport(body: unknown): CleanReport | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const kind = (CLIENT_ERROR_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as ClientErrorKind) : "error";
  const message = typeof b.message === "string" ? scrubClientText(b.message).trim().slice(0, MESSAGE_MAX) : "";
  if (!message) return null;
  const stack = typeof b.stack === "string" && b.stack.trim() ? scrubClientText(b.stack).slice(0, STACK_MAX) : null;
  const release = typeof b.release === "string" && /^[\w.-]{1,40}$/.test(b.release) ? b.release : null;
  return { kind, message, stack, path: cleanPath(b.path), release };
}

/** Per person: at most PER_USER_MAX reports in any PER_USER_WINDOW_MS. */
const perUser = new Map<number, number[]>();
export function allowForUser(userId: number, now: number = Date.now()): boolean {
  const recent = (perUser.get(userId) ?? []).filter((t) => now - t < PER_USER_WINDOW_MS);
  if (recent.length >= PER_USER_MAX) { perUser.set(userId, recent); return false; }
  recent.push(now);
  perUser.set(userId, recent);
  if (perUser.size > 5000) perUser.clear(); // a bound on memory, not a policy
  return true;
}
export function resetClientErrorLimits(): void { perUser.clear(); }

export const clientErrorIpLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => rateLimitKey(req),
  handler: (_req: Request, res: Response) => { res.status(429).json({ ok: false }); },
  skip: () => process.env.NODE_ENV === "test",
});

export async function handleClientError(req: Request, res: Response): Promise<void> {
  const report = cleanReport(req.body);
  if (!report) { res.status(204).end(); return; }

  let user: { id: number; mfaTotpEnabledAt?: unknown } | null = null;
  try { user = await sdk.authenticateRequest(req); } catch { user = null; }
  const headerVal = req.headers["x-workspace-id"];
  const workspaceId = Number(Array.isArray(headerVal) ? headerVal[0] : headerVal);
  const db = await getDb();

  if (!user || !Number.isInteger(workspaceId) || workspaceId <= 0 || !db || (await workspaceDoorRefusal(db, user, workspaceId))) {
    // Not stored: nothing ties it to a workspace that may read it.
    console.warn(`[ClientError] ${report.kind} on ${report.path ?? "?"}: ${report.message}`);
    res.status(204).end();
    return;
  }
  if (!allowForUser(user.id)) { res.status(429).json({ ok: false }); return; }

  // The build that served the report when the page did not say which it runs.
  await db.insert(clientErrors).values({ workspaceId, userId: user.id, ...report, release: report.release ?? deployedCommit().slice(0, 40) });
  if (Math.random() < 0.02) await pruneOldClientErrors(db);
  res.status(204).end();
}

/** Rows older than RETENTION_DAYS go; run now and then as reports arrive. Never throws. */
export async function pruneOldClientErrors(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, now: number = Date.now()): Promise<void> {
  try {
    await db.delete(clientErrors).where(lt(clientErrors.createdAt, new Date(now - RETENTION_DAYS * 86_400_000)));
  } catch (e) {
    console.warn("[ClientError] prune failed:", (e as Error).message);
  }
}

export function registerClientErrorRoute(app: Express): void {
  app.post("/api/client-errors", clientErrorIpLimiter, (req, res) => {
    handleClientError(req, res).catch((e) => {
      console.warn("[ClientError] could not record:", (e as Error).message);
      if (!res.headersSent) res.status(204).end();
    });
  });
}
