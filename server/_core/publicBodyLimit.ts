/**
 * A small body limit for the routes anyone can call (audit 2026-10-20, G41).
 *
 * The app parses JSON and form bodies up to 50 MB for every route, because
 * signed-in screens upload files that way. The public routes (form and
 * landing-page submits, the chat widget, booking, the proposal portal's
 * writes, the visitor beacon, sign-in) need a few kilobytes, and each one
 * parsed 50 MB for any stranger who sent it.
 *
 * Mounted BEFORE the app-wide parsers. body-parser marks a request it has
 * read (`req._body`) and the later 50 MB parser skips it, so a public path is
 * read once, under this limit, and an oversized one is refused with 413
 * before any handler runs.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { isMeteredPublicPath, isPublicWritePath } from "../publicRateLimit";

export const PUBLIC_BODY_LIMIT = "64kb";

const keepRaw = (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; };
const json = express.json({ limit: PUBLIC_BODY_LIMIT, verify: keepRaw });
const form = express.urlencoded({ limit: PUBLIC_BODY_LIMIT, extended: true });

export function isPublicBodyPath(path: string): boolean {
  if (path === "/api/track" || path.startsWith("/api/track/")) return true;
  if (path.startsWith("/api/auth/")) return true;
  if (path.startsWith("/api/trpc/")) return isPublicWritePath(path) || isMeteredPublicPath(path);
  return false;
}

export function publicBodyLimit(req: Request, res: Response, next: NextFunction): void {
  if (!isPublicBodyPath(req.path ?? "")) return next();
  json(req, res, (err?: unknown) => (err ? next(err) : form(req, res, next)));
}
