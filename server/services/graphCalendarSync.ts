/**
 * graphCalendarSync — the member's REAL Outlook calendar, on My Calendar.
 *
 * The calendar page renders `calendar_events` rows, which only the old
 * paste-your-tokens connect flow ever populated — so for everyone else the
 * page sat empty while their actual calendar lived in Outlook. This sweep
 * mirrors the Graph calendar view (7 days back, 60 forward) into that same
 * table under a per-connection `calendar_accounts` row, so the existing
 * page renders it with zero UI changes.
 *
 * The bridge row is found by `oauthScope = 'msgraph'` — a deliberate
 * marker value, since the row carries NO tokens of its own (credentials
 * live in graph_connections; this row exists because calendar_events
 * requires a calendarAccountId).
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../db";
import {
  calendarAccounts,
  calendarEvents,
  graphConnections,
  type GraphConnection,
} from "../../drizzle/schema";
import { graphFetch } from "./msgraph";

const MARKER_SCOPE = "msgraph";

async function ensureBridgeAccount(conn: GraphConnection): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [existing] = await db.select({ id: calendarAccounts.id }).from(calendarAccounts)
    .where(and(
      eq(calendarAccounts.workspaceId, conn.workspaceId),
      eq(calendarAccounts.userId, conn.userId),
      eq(calendarAccounts.oauthScope, MARKER_SCOPE),
    ))
    .limit(1);
  if (existing) return existing.id;
  const ins = await db.insert(calendarAccounts).values({
    workspaceId: conn.workspaceId,
    userId: conn.userId,
    provider: "outlook_oauth",
    label: "Microsoft 365",
    email: conn.msEmail,
    oauthScope: MARKER_SCOPE,
    calendarId: "primary",
  });
  return Number((ins as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
}

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string };
  isAllDay?: boolean;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: Array<{ emailAddress?: { address?: string; name?: string } }>;
}

export async function runGraphCalendarSync(conn: GraphConnection): Promise<{ synced: number }> {
  const db = await getDb();
  if (!db) return { synced: 0 };
  const accountId = await ensureBridgeAccount(conn);
  if (!accountId) return { synced: 0 };

  const from = new Date(Date.now() - 7 * 86400_000);
  const to = new Date(Date.now() + 60 * 86400_000);
  const q = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $top: "200",
    $select: "id,subject,bodyPreview,location,onlineMeeting,isAllDay,start,end,attendees",
  });
  // calendarView expands recurrences into instances — exactly what a
  // calendar GRID needs (the /events endpoint returns series masters).
  const res = await graphFetch<{ value?: GraphEvent[] }>(
    conn,
    `/me/calendarView?${q}`,
    { headers: { Prefer: 'outlook.timezone="UTC"' } },
  );
  const items = res.value ?? [];

  // Same replace-the-window strategy as the existing manual sync: delete
  // the range, insert what Graph returned. Events deleted in Outlook
  // disappear here too — an upsert-only sync would keep ghosts forever.
  await db.delete(calendarEvents).where(and(
    eq(calendarEvents.calendarAccountId, accountId),
    eq(calendarEvents.workspaceId, conn.workspaceId),
    gte(calendarEvents.startAt, from),
    lte(calendarEvents.startAt, to),
  ));
  for (const ev of items) {
    const start = ev.start?.dateTime ? new Date(`${ev.start.dateTime}Z`) : null;
    const end = ev.end?.dateTime ? new Date(`${ev.end.dateTime}Z`) : null;
    if (!start || !end || Number.isNaN(start.getTime())) continue;
    await db.insert(calendarEvents).values({
      workspaceId: conn.workspaceId,
      userId: conn.userId,
      calendarAccountId: accountId,
      externalId: ev.id,
      title: (ev.subject ?? "(no title)").slice(0, 500),
      description: ev.bodyPreview ?? null,
      location: ev.location?.displayName?.slice(0, 500) ?? null,
      meetingUrl: ev.onlineMeeting?.joinUrl?.slice(0, 1000) ?? null,
      startAt: start,
      endAt: end,
      allDay: !!ev.isAllDay,
      attendees: (ev.attendees ?? [])
        .map((a) => ({ email: a.emailAddress?.address ?? "", name: a.emailAddress?.name ?? "" }))
        .filter((a) => a.email),
    });
  }
  await db.update(calendarAccounts)
    .set({ lastSyncAt: new Date(), lastSyncError: null })
    .where(eq(calendarAccounts.id, accountId));
  return { synced: items.length };
}

/** Cron entry — mirrors runOneNoteSyncSweep's shape. */
export async function runGraphCalendarSweep(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const conns = await db.select().from(graphConnections)
    .where(eq(graphConnections.status, "active"))
    .limit(20);
  for (const conn of conns) {
    try {
      await runGraphCalendarSync(conn);
    } catch (e) {
      console.warn(`[graphCalendarSync] connection ${conn.id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
