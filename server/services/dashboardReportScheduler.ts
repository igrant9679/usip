/**
 * Dashboard report schedules (report_schedules) — the CLOCK half.
 *
 * The table has always promised daily/weekly/monthly delivery and stored
 * `enabled` + `lastSentAt`, but the only sender was the rep's "Send now"
 * button — no cron ever read the rows, so every schedule was a decoration
 * (audit 2026-09-20). This sweep runs hourly and mails whatever is due,
 * through the SAME implementation the button uses
 * (operations.sendDashboardScheduleEmail), so the two can never drift.
 *
 * Due = lastSentAt is null, or older than the frequency minus a small
 * tolerance (the tick is hourly, and "daily at roughly the same hour" must
 * not drift later every day by the tick's own latency).
 */
import { eq } from "drizzle-orm";
import { reportSchedules } from "../../drizzle/schema";
import { getDb } from "../db";
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { sendDashboardScheduleEmail } from "../routers/operations";

const HOUR = 3_600_000;
const DUE_AFTER: Record<string, number> = {
  daily: 23 * HOUR,
  weekly: (7 * 24 - 1) * HOUR,
  monthly: (30 * 24 - 1) * HOUR,
};

export async function runDashboardReportSchedules(): Promise<{ considered: number; sent: number; failed: number }> {
  const out = { considered: 0, sent: 0, failed: 0 };
  const db = await getDb();
  if (!db) return out;

  const rows = await db.select().from(reportSchedules).where(eq(reportSchedules.enabled, true));
  if (!rows.length) return out;
  const archived = await archivedWorkspaceIds();
  const now = Date.now();

  for (const s of rows) {
    if (archived.has(s.workspaceId)) continue;
    const window = DUE_AFTER[s.frequency] ?? DUE_AFTER.daily;
    if (s.lastSentAt && now - new Date(s.lastSentAt).getTime() < window) continue;
    out.considered++;
    try {
      const r = await sendDashboardScheduleEmail(s.workspaceId, s.id, null);
      if (r.ok) out.sent++;
      else {
        out.failed++;
        // "no_recipients" / "No active SMTP config" are configuration gaps
        // the owner sees on the schedule itself; log once per tick, don't
        // retry-storm — the due-check naturally re-asks next window only
        // because lastSentAt stays unset, so keep the log terse.
        console.log(`[DashboardReports] ws ${s.workspaceId} schedule ${s.id} not sent: ${r.reason} — ${r.message ?? ""}`);
      }
    } catch (e) {
      out.failed++;
      console.error(`[DashboardReports] ws ${s.workspaceId} schedule ${s.id} failed:`, (e as Error).message);
    }
  }
  if (out.sent > 0) console.log(`[DashboardReports] sent ${out.sent} of ${out.considered} due schedule(s)`);
  return out;
}
