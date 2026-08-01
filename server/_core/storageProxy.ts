/**
 * `/manus-storage/<key>` — redirects to a presigned URL for a stored object.
 *
 * WHAT THIS SERVES: generated quote PDFs (`ws-<id>/quotes/…`), account-brief
 * PDFs, and activity attachments — customer documents, in other words.
 *
 * ✅ NOT an SSRF, checked rather than assumed: the upstream host comes from
 * `ENV.forgeApiUrl` and the caller's key only ever reaches a QUERY PARAMETER
 * via `searchParams.set`, which encodes it. There is no way to steer the fetch
 * at another host.
 *
 * 🔴 WHAT WAS WRONG: it was completely UNAUTHENTICATED. Anyone who could name a
 * key got a presigned URL for it. The only thing standing in the way was the
 * 8-hex suffix `storagePut` appends — 32 bits — and the rest of the key is
 * guessable by construction: `ws-3/quotes/Q-1042.pdf`. Workspace ids are small
 * integers and quote numbers are sequential. That is a capability URL, and a
 * PERMANENT one: unlike the presigned URL it redirects to, this path never
 * expires, so anywhere it leaks (a referer header, a shared link, a log) it
 * keeps working.
 *
 * Now: authenticated, and a key naming a workspace may only be fetched by a
 * MEMBER of that workspace — which closes cross-tenant document reads outright
 * rather than resting on the suffix being hard to guess.
 *
 * Safe to require a session because nothing consumes these URLs outside the
 * app: no email HTML references `/manus-storage`, no public page renders a
 * pdfUrl, and the session cookie is `sameSite: "none"`, so the top-level
 * `window.open(pdfUrl)` in Quotes.tsx still carries it.
 */
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import { ENV } from "./env";
import { sdk } from "./sdk";

/** `ws-<id>/…` — the prefix every real writer uses. */
const WORKSPACE_KEY = /^ws-(\d+)\//;

/**
 * A key must be a plain relative path.
 *
 * `..` was forwarded verbatim to the storage backend, which is a traversal
 * attempt we should refuse ourselves rather than hope the far side rejects.
 * Browsers normalise `..` away, but `curl --path-as-is` does not.
 */
export function isSafeStorageKey(key: string): boolean {
  if (!key) return false;
  if (key.startsWith("/") || key.includes("\\")) return false;
  return !key.split("/").includes("..");
}

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as unknown as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!isSafeStorageKey(key)) {
      res.status(400).send("Invalid storage key");
      return;
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    let userId: number;
    try {
      userId = (await sdk.authenticateRequest(req)).id;
    } catch {
      res.status(401).send("Unauthorized");
      return;
    }

    /**
     * Keys are written as `ws-<id>/…` by every real caller, so the object says
     * which tenant it belongs to. Enforce it.
     *
     * A key WITHOUT that prefix falls back to authenticated-only: there is
     * nothing in it to scope by, and the sole writer of such keys
     * (`_core/imageGeneration.ts`, `generated/<ts>.png`) has no callers at all.
     * Failing those closed would break nothing today and is the safer default
     * if that ever changes — but silently 403ing an object nobody can attribute
     * is worse than saying so here.
     */
    const owner = WORKSPACE_KEY.exec(key);
    if (owner) {
      const workspaceId = Number(owner[1]);
      const db = await getDb();
      if (!db) {
        res.status(500).send("Storage proxy unavailable");
        return;
      }
      const [member] = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!member) {
        console.warn(
          `[StorageProxy] REFUSED ${key}: user ${userId} is not a member of workspace ${workspaceId}`,
        );
        res.status(403).send("Forbidden");
        return;
      }
    }

    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
