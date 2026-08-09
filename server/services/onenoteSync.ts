/**
 * onenoteSync — the two-way mirror between CRM note activities and a
 * "Velocity CRM" OneNote notebook.
 *
 * PUSH: every `activities.type = 'note'` row without a page (or updated
 * records? notes are immutable in this product — created once) becomes a
 * OneNote page in a section named after its record ("Contact — Jane Doe",
 * "Account — Acme"). The onenote_links row makes this idempotent.
 *
 * PULL: pages in the notebook that Velocity did NOT create (no link row)
 * become note activities — matched to a record by their section name using
 * the same "Type — Name" convention the push writes. A page whose section
 * matches nothing lands as a note on the workspace's FIRST account? No —
 * unmatchable pages are SKIPPED and counted in the sync result, because a
 * note attached to the wrong customer is worse than a note left in OneNote.
 *
 * Sync is per-CONNECTION (per member): each member's notebook lives in
 * their own OneDrive. Runs from the cron sweep and the card's "Sync now".
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  accounts,
  activities,
  contacts,
  graphConnections,
  leads,
  onenoteLinks,
  type GraphConnection,
} from "../../drizzle/schema";
import { escapeHtml } from "@shared/escapeHtml";
import { graphFetch } from "./msgraph";

const NOTEBOOK_NAME = "Velocity CRM";

export interface OneNoteSyncResult {
  pushed: number;
  pulled: number;
  skippedUnmatched: number;
  errors: string[];
  at: string;
}

/* ── Notebook / section plumbing ────────────────────────────────────────── */

async function ensureNotebook(conn: GraphConnection): Promise<string> {
  if (conn.onenoteNotebookId) return conn.onenoteNotebookId;
  const list = await graphFetch<{ value?: Array<{ id: string; displayName: string }> }>(
    conn,
    `/me/onenote/notebooks?$select=id,displayName`,
  );
  let nb = (list.value ?? []).find((n) => n.displayName === NOTEBOOK_NAME);
  if (!nb) {
    nb = await graphFetch<{ id: string; displayName: string }>(conn, "/me/onenote/notebooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      rawBody: JSON.stringify({ displayName: NOTEBOOK_NAME }),
    });
  }
  const db = await getDb();
  if (db && nb) {
    await db.update(graphConnections).set({ onenoteNotebookId: nb.id }).where(eq(graphConnections.id, conn.id));
  }
  if (!nb) throw new Error("Could not create the Velocity CRM notebook");
  return nb.id;
}

async function listSections(conn: GraphConnection, notebookId: string): Promise<Map<string, string>> {
  const res = await graphFetch<{ value?: Array<{ id: string; displayName: string }> }>(
    conn,
    `/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections?$select=id,displayName&$top=100`,
  );
  return new Map((res.value ?? []).map((s) => [s.displayName, s.id]));
}

async function ensureSection(
  conn: GraphConnection,
  notebookId: string,
  sections: Map<string, string>,
  name: string,
): Promise<string> {
  const existing = sections.get(name);
  if (existing) return existing;
  const created = await graphFetch<{ id: string }>(
    conn,
    `/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      rawBody: JSON.stringify({ displayName: name }),
    },
  );
  sections.set(name, created.id);
  return created.id;
}

/** "Contact — Jane Doe" — the naming contract both directions share.
 *  Exported for the round-trip test: a push-written section name MUST parse
 *  back by the pull matcher, or pushed records' pages become unmatchable. */
export function sectionNameFor(relatedType: string, recordName: string): string {
  const type = relatedType.charAt(0).toUpperCase() + relatedType.slice(1);
  // OneNote section names refuse ?*\/:<>|&#''%~
  const clean = recordName.replace(/[?*\\/:<>|&#'%~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return `${type} — ${clean || "Unnamed"}`;
}

/* ── The sync ───────────────────────────────────────────────────────────── */

export async function runOneNoteSync(conn: GraphConnection): Promise<OneNoteSyncResult> {
  const result: OneNoteSyncResult = { pushed: 0, pulled: 0, skippedUnmatched: 0, errors: [], at: new Date().toISOString() };
  const db = await getDb();
  if (!db) {
    result.errors.push("DB unavailable");
    return result;
  }
  const ws = conn.workspaceId;

  try {
    const notebookId = await ensureNotebook(conn);
    const sections = await listSections(conn, notebookId);

    /* ---- PUSH: unlinked note activities → pages ---- */
    const unpushed = await db
      .select({
        id: activities.id,
        subject: activities.subject,
        body: activities.body,
        relatedType: activities.relatedType,
        relatedId: activities.relatedId,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .leftJoin(onenoteLinks, eq(onenoteLinks.activityId, activities.id))
      .where(and(eq(activities.workspaceId, ws), eq(activities.type, "note"), isNull(onenoteLinks.id)))
      .orderBy(desc(activities.id))
      .limit(50); // bounded per run — the cron drains the backlog

    for (const note of unpushed) {
      try {
        const recordName = await resolveRecordName(ws, note.relatedType, note.relatedId);
        const section = sectionNameFor(note.relatedType, recordName ?? `#${note.relatedId}`);
        const sectionId = await ensureSection(conn, notebookId, sections, section);
        const title = note.subject?.trim() || `Note from Velocity (${new Date(note.occurredAt ?? Date.now()).toLocaleDateString()})`;
        const html = `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title></head><body><p>${escapeHtml(note.body ?? "").replace(/\n/g, "<br/>")}</p></body></html>`;
        const page = await graphFetch<{ id: string }>(
          conn,
          `/me/onenote/sections/${encodeURIComponent(sectionId)}/pages`,
          { method: "POST", headers: { "Content-Type": "application/xhtml+xml" }, rawBody: html },
        );
        await db.insert(onenoteLinks).values({
          workspaceId: ws,
          activityId: note.id,
          pageId: page.id,
          lastPushedAt: new Date(),
        });
        result.pushed++;
      } catch (e) {
        result.errors.push(`push #${note.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    /* ---- PULL: pages Velocity didn't author → note activities ---- */
    const sinceClause = conn.onenoteSyncedAt
      ? `&$filter=lastModifiedDateTime ge ${new Date(conn.onenoteSyncedAt).toISOString()}`
      : "";
    const pages = await graphFetch<{
      value?: Array<{ id: string; title?: string; createdDateTime?: string; parentSection?: { displayName?: string }; links?: { oneNoteWebUrl?: { href?: string } } }>;
    }>(
      conn,
      `/me/onenote/pages?$top=50&$select=id,title,createdDateTime&$expand=parentSection($select=displayName)${sinceClause}`,
    );

    const pageIds = (pages.value ?? []).map((p) => p.id);
    const known = pageIds.length
      ? await db.select({ pageId: onenoteLinks.pageId }).from(onenoteLinks)
          .where(and(eq(onenoteLinks.workspaceId, ws), inArray(onenoteLinks.pageId, pageIds)))
      : [];
    const knownIds = new Set(known.map((k) => k.pageId));

    for (const page of pages.value ?? []) {
      if (knownIds.has(page.id)) continue; // Velocity-authored or already pulled
      const sectionName = page.parentSection?.displayName ?? "";
      const target = await matchSectionToRecord(ws, sectionName);
      if (!target) {
        result.skippedUnmatched++;
        continue;
      }
      try {
        // Page body as text — OneNote returns XHTML; strip to text for the
        // timeline (the page stays the canonical rich copy).
        const content = await graphFetch<string>(conn, `/me/onenote/pages/${encodeURIComponent(page.id)}/content`, {
          headers: { Accept: "text/html" },
        }).catch(() => "");
        const text = String(content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
        const ins = await db.insert(activities).values({
          workspaceId: ws,
          type: "note",
          relatedType: target.relatedType,
          relatedId: target.relatedId,
          subject: `OneNote: ${page.title ?? "Untitled page"}`.slice(0, 500),
          body: text || "(empty page)",
          actorUserId: conn.userId,
          occurredAt: page.createdDateTime ? new Date(page.createdDateTime) : new Date(),
        });
        const activityId = Number((ins as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
        if (activityId) {
          await db.insert(onenoteLinks).values({
            workspaceId: ws,
            activityId,
            pageId: page.id,
            lastPulledAt: new Date(),
          });
        }
        result.pulled++;
      } catch (e) {
        result.errors.push(`pull "${page.title ?? page.id}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await db.update(graphConnections)
      .set({ onenoteSyncedAt: new Date(), lastSyncResult: result })
      .where(eq(graphConnections.id, conn.id));
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    await db.update(graphConnections).set({ lastSyncResult: result }).where(eq(graphConnections.id, conn.id));
  }
  return result;
}

async function resolveRecordName(ws: number, relatedType: string, relatedId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  if (relatedType === "contact") {
    const [c] = await db.select({ f: contacts.firstName, l: contacts.lastName }).from(contacts)
      .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, relatedId))).limit(1);
    return c ? [c.f, c.l].filter(Boolean).join(" ") : null;
  }
  if (relatedType === "lead") {
    const [l] = await db.select({ f: leads.firstName, l: leads.lastName }).from(leads)
      .where(and(eq(leads.workspaceId, ws), eq(leads.id, relatedId))).limit(1);
    return l ? [l.f, l.l].filter(Boolean).join(" ") : null;
  }
  if (relatedType === "account") {
    const [a] = await db.select({ n: accounts.name }).from(accounts)
      .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, relatedId))).limit(1);
    return a?.n ?? null;
  }
  return null;
}

/** The pull side of the naming contract — exported with sectionNameFor so
 *  the round-trip test pins that they agree. */
export const SECTION_NAME_RE = /^(Contact|Lead|Account)\s+—\s+(.+)$/;

/** Invert sectionNameFor: "Contact — Jane Doe" → the matching record. */
async function matchSectionToRecord(
  ws: number,
  sectionName: string,
): Promise<{ relatedType: string; relatedId: number } | null> {
  const m = SECTION_NAME_RE.exec(sectionName.trim());
  if (!m) return null;
  const db = await getDb();
  if (!db) return null;
  const name = m[2].trim();
  if (m[1] === "Account") {
    const [a] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.workspaceId, ws), eq(accounts.name, name))).limit(1);
    return a ? { relatedType: "account", relatedId: a.id } : null;
  }
  const table = m[1] === "Contact" ? contacts : leads;
  const [r] = await db.select({ id: table.id }).from(table)
    .where(and(
      eq(table.workspaceId, ws),
      or(
        eq(sql`TRIM(CONCAT(COALESCE(${table.firstName},''),' ',COALESCE(${table.lastName},'')))`, name),
        eq(table.firstName, name),
      ),
    ))
    .limit(1);
  return r ? { relatedType: m[1].toLowerCase(), relatedId: r.id } : null;
}

/** Cron entry: sync every active connection, oldest-synced first. */
export async function runOneNoteSyncSweep(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const conns = await db.select().from(graphConnections)
    .where(eq(graphConnections.status, "active"))
    .orderBy(graphConnections.onenoteSyncedAt)
    .limit(10);
  for (const conn of conns) {
    try {
      await runOneNoteSync(conn);
    } catch (e) {
      console.warn(`[onenoteSync] connection ${conn.id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
