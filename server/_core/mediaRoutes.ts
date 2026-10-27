/**
 * `/api/media/account-logo/:id` — an account's stored logo as an image
 * (audit 2026-10-20, Phase 4, L6).
 *
 * Processed logos are kept inline in accounts.logo_url as data: URIs, and list
 * responses carried them: 83 MB for one workspace's account list. Lists now
 * send this URL (services/company/logoService.ts accountLogoPath) and the
 * browser fetches each logo once, from here.
 *
 * Same rules as the storage proxy: a session, and membership of the account's
 * workspace; anything else is a 404, so ids are not confirmed to outsiders.
 * The URL carries a version, so the response is cached for a year. An SVG is
 * served with a sandboxing CSP: opened directly, as a page of this origin, it
 * cannot run script.
 */
import type { Express, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { accounts, workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import { resolveCompanyLogo } from "../services/company/logoService";
import { sdk } from "./sdk";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/avif"]);

/** A data: URI's bytes and type, when it is an image this route will serve. */
export function decodeImageDataUri(uri: string): { type: string; body: Buffer } | null {
  const m = /^data:([a-z0-9.+/-]+)((?:;[^,;]*)*),/i.exec(uri);
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!IMAGE_TYPES.has(type)) return null;
  const payload = uri.slice(m[0].length);
  const body = /;base64/i.test(m[2]) ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return body.length ? { type, body } : null;
}

export async function serveAccountLogo(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).end();
    return;
  }
  let userId: number;
  try {
    userId = (await sdk.authenticateRequest(req)).id;
  } catch {
    res.status(401).end();
    return;
  }
  const db = await getDb();
  if (!db) {
    res.status(503).end();
    return;
  }
  const [row] = await db
    .select({
      id: accounts.id, workspaceId: accounts.workspaceId, logoUrl: accounts.logoUrl,
      logoSourceType: accounts.logoSourceType, logoStatus: accounts.logoStatus,
    })
    .from(accounts)
    .where(eq(accounts.id, id))
    .limit(1);
  if (!row) {
    res.status(404).end();
    return;
  }
  const [member] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, row.workspaceId), isNull(workspaceMembers.deactivatedAt)))
    .limit(1);
  if (!member) {
    res.status(404).end();
    return;
  }
  // Only a logo the account is allowed to show (permitted source, available).
  const stored = resolveCompanyLogo({ ...row, id: undefined }).url;
  const image = stored ? decodeImageDataUri(stored) : null;
  if (!image) {
    res.status(404).end();
    return;
  }
  res.set({
    "Content-Type": image.type,
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.send(image.body);
}

export function registerMediaRoutes(app: Express) {
  app.get("/api/media/account-logo/:id", (req, res) => {
    serveAccountLogo(req, res).catch((err) => {
      console.error("[media] account logo failed:", err);
      if (!res.headersSent) res.status(500).end();
    });
  });
}
