/**
 * onedrive — the two OneDrive verbs Velocity needs.
 *
 * Browse (for attaching an existing file to a CRM record) and upload (for
 * saving a file into the member's OneDrive under /Velocity CRM/...). Both
 * operate on the CONNECTED MEMBER'S drive — this is per-user personal
 * storage reached through their own OAuth, not a shared workspace drive.
 */
import type { GraphConnection } from "../../drizzle/schema";
import { graphFetch, getAccessToken, GRAPH_BASE } from "./msgraph";

export interface DriveItemLite {
  id: string;
  name: string;
  isFolder: boolean;
  webUrl: string | null;
  size: number | null;
  modifiedAt: string | null;
}

interface DriveItemRaw {
  id: string;
  name: string;
  folder?: unknown;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
}

function lite(i: DriveItemRaw): DriveItemLite {
  return {
    id: i.id,
    name: i.name,
    isFolder: !!i.folder,
    webUrl: i.webUrl ?? null,
    size: typeof i.size === "number" ? i.size : null,
    modifiedAt: i.lastModifiedDateTime ?? null,
  };
}

/** List a folder's children — root when no itemId. Folders first. */
export async function listFolder(conn: GraphConnection, itemId?: string): Promise<DriveItemLite[]> {
  const path = itemId
    ? `/me/drive/items/${encodeURIComponent(itemId)}/children`
    : "/me/drive/root/children";
  const res = await graphFetch<{ value?: DriveItemRaw[] }>(
    conn,
    `${path}?$top=100&$select=id,name,folder,webUrl,size,lastModifiedDateTime&$orderby=name`,
  );
  return (res.value ?? [])
    .map(lite)
    .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
}

/**
 * Upload into /Velocity CRM/<subfolder>/<filename>. Graph's simple PUT
 * covers files to 4MB; larger ones go through an upload session in 5MB
 * chunks. The path-based addressing auto-creates nothing — the session
 * endpoint does — so simple uploads use the same session path for
 * consistency: one code path, no folder-precreation dance.
 */
export async function uploadToVelocityFolder(
  conn: GraphConnection,
  subfolder: string,
  filename: string,
  data: Buffer,
): Promise<DriveItemLite> {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").trim() || "file";
  const fullPath = `/Velocity CRM/${clean(subfolder)}/${clean(filename)}`;
  const sessionRes = await graphFetch<{ uploadUrl?: string }>(
    conn,
    `/me/drive/root:${encodeURI(fullPath)}:/createUploadSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      rawBody: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
    },
  );
  if (!sessionRes.uploadUrl) throw new Error("OneDrive did not open an upload session");

  const CHUNK = 5 * 1024 * 1024;
  let item: DriveItemRaw | null = null;
  for (let start = 0; start < data.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, data.length);
    const res = await fetch(sessionRes.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(end - start),
        "Content-Range": `bytes ${start}-${end - 1}/${data.length}`,
      },
      body: data.subarray(start, end) as unknown as BodyInit,
    });
    if (!res.ok && res.status !== 202) {
      const body = await res.json().catch(() => null);
      throw new Error(
        (body as { error?: { message?: string } } | null)?.error?.message ?? `OneDrive upload failed (HTTP ${res.status})`,
      );
    }
    if (res.status === 200 || res.status === 201) {
      item = (await res.json()) as DriveItemRaw;
    }
  }
  if (!item) throw new Error("OneDrive upload finished without returning the item");
  return lite(item);
}

/** Fetch a small file's bytes (used nowhere yet — kept deliberately absent
 *  until a consumer exists; see the dead-wiring rule). */

/** Resolve an item by id — used to validate an attach request. */
export async function getItem(conn: GraphConnection, itemId: string): Promise<DriveItemLite> {
  const raw = await graphFetch<DriveItemRaw>(
    conn,
    `/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,folder,webUrl,size,lastModifiedDateTime`,
  );
  return lite(raw);
}

/** Direct download URL helper for the UI (302 target, short-lived). */
export async function getDownloadUrl(conn: GraphConnection, itemId: string): Promise<string | null> {
  const token = await getAccessToken(conn);
  const res = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}?$select=id,@microsoft.graph.downloadUrl`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const url = body?.["@microsoft.graph.downloadUrl"];
  return typeof url === "string" ? url : null;
}
