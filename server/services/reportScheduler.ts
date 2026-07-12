/**
 * reportScheduler.ts — emails scheduled saved reports (migration 0122).
 *
 * Hourly cron: any saved_reports row with scheduleFreq != none and recipients
 * gets run + emailed when due — daily (first tick ≥ 08:00 UTC each day),
 * weekly (Mondays), monthly (the 1st). Delivery goes through sendSystemEmail —
 * the workspace's dedicated SYSTEM sender (same path as team invites and
 * notifications), never a rep's mailbox. Body is an inline HTML table capped
 * at 100 rows with a link to open the full report in /reports.
 */
import { and, eq, ne } from "drizzle-orm";
import { savedReports } from "../../drizzle/schema";
import { getDb } from "../db";
import { sendSystemEmail } from "../emailDelivery";
import { runSpec, type ReportSpec } from "../routers/reports";

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CHART_PALETTE = ["#0EA5E9", "#8B5CF6", "#F59E0B", "#10B981", "#EC4899", "#06B6D4", "#F43F5E", "#84CC16", "#6366F1"];

/** Email-safe horizontal bar chart (pure tables + inline styles — SVG is
 *  stripped by Gmail and unsupported in desktop Outlook). */
function renderBarsHtml(title: string, series: Array<{ label: string; value: number }>, valueFmt?: (n: number) => string): string {
  const max = Math.max(...series.map((s) => s.value), 1);
  const fmt = valueFmt ?? ((n: number) => n.toLocaleString());
  const rows = series.map((s, i) => {
    const pct = Math.max(2, Math.round((s.value / max) * 100));
    return `<tr>
      <td style="padding:3px 10px 3px 0;font-size:12px;color:#334155;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(s.label)}</td>
      <td style="width:60%;padding:3px 0">
        <div style="background:#f1f5f9;border-radius:4px"><div style="width:${pct}%;height:14px;border-radius:4px;background:${CHART_PALETTE[i % CHART_PALETTE.length]}"></div></div>
      </td>
      <td style="padding:3px 0 3px 10px;font-size:12px;color:#0f172a;font-weight:600;white-space:nowrap;text-align:right">${esc(fmt(s.value))}</td>
    </tr>`;
  }).join("");
  return `<div style="margin:14px 0">
    <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin-bottom:6px">${esc(title)}</div>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
  </div>`;
}

/** Chart block for the email — mirrors the in-app ReportInsights. */
function renderChartHtml(result: Awaited<ReturnType<typeof runSpec>>): string {
  if (result.rows.length === 0) return "";
  if (result.grouped) {
    const series = result.rows.slice(0, 12).map((r) => ({ label: String(r.group ?? "(empty)"), value: Number(r.agg) || 0 }));
    const total = result.rows.reduce((s, r) => s + (Number(r.agg) || 0), 0);
    const aggLabel = result.columns[1]?.label ?? "Value";
    const summary = `<p style="font-size:12px;color:#334155;margin:0 0 4px"><b>${result.rows.length}</b> groups · total ${esc(aggLabel.toLowerCase())} <b>${total.toLocaleString()}</b>${result.rows.length > 12 ? " · chart shows top 12" : ""}</p>`;
    return summary + renderBarsHtml(aggLabel, series);
  }
  const dateCol = result.columns.find((c) => c.kind === "date");
  if (!dateCol) return "";
  const byDay = new Map<string, number>();
  for (const r of result.rows) {
    const v = r[dateCol.key];
    if (!v) continue;
    const d = new Date(v as string);
    if (Number.isNaN(d.getTime())) continue;
    const k = d.toISOString().slice(0, 10);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  if (byDay.size < 2) return "";
  const series = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14)
    .map(([k, n]) => ({ label: k, value: n }));
  return renderBarsHtml(`Rows per day · ${dateCol.label}`, series);
}

export function renderReportHtml(name: string, result: Awaited<ReturnType<typeof runSpec>>): string {
  const rows = result.rows.slice(0, 100);
  const head = result.columns.map((c) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase">${esc(c.label)}</th>`).join("");
  const body = rows.map((r) =>
    `<tr>${result.columns.map((c) => {
      const v = r[c.key];
      const text = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "number" ? v.toLocaleString() : String(v ?? "—");
      return `<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:13px">${esc(text)}</td>`;
    }).join("")}</tr>`,
  ).join("");
  const more = result.rows.length > rows.length ? `<p style="color:#64748b;font-size:12px">Showing ${rows.length} of ${result.rows.length} rows — open the report in Velocity for everything.</p>` : "";
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:720px">
    <h2 style="font-size:16px;margin:0 0 2px">${esc(name)}</h2>
    <p style="color:#64748b;font-size:12px;margin:0 0 12px">Scheduled report from Velocity · ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}</p>
    ${renderChartHtml(result)}
    <table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    ${more}
    <p style="margin-top:16px;font-size:12px"><a href="https://getvelocityai.app/reports" style="color:#4f46e5">Open Reports in Velocity →</a></p>
  </div>`;
}

function isDue(freq: string, lastSentAt: Date | null, now: Date): boolean {
  if (now.getUTCHours() < 8) return false; // deliver in the morning, once due
  const today = now.toISOString().slice(0, 10);
  const sentToday = lastSentAt && new Date(lastSentAt).toISOString().slice(0, 10) === today;
  if (sentToday) return false;
  if (freq === "daily") return true;
  if (freq === "weekly") return now.getUTCDay() === 1; // Monday
  if (freq === "monthly") return now.getUTCDate() === 1;
  return false;
}

/** Send one saved report immediately (also used by the Send-now proc). */
export async function emailSavedReport(reportId: number, workspaceId: number): Promise<{ ok: boolean; reason?: string; sentTo?: number }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "DB unavailable" };
  const [r] = await db.select().from(savedReports)
    .where(and(eq(savedReports.id, reportId), eq(savedReports.workspaceId, workspaceId))).limit(1);
  if (!r) return { ok: false, reason: "Report not found" };
  const recipients = String(r.scheduleRecipients ?? "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (recipients.length === 0) return { ok: false, reason: "No valid recipients configured" };
  const result = await runSpec(r.workspaceId, r.config as ReportSpec);
  const send = await sendSystemEmail(r.workspaceId, {
    to: recipients,
    subject: `Velocity report: ${r.name}`,
    html: renderReportHtml(r.name, result),
  });
  if (!send.ok) return { ok: false, reason: send.reason };
  await db.update(savedReports).set({ scheduleLastSentAt: new Date() }).where(eq(savedReports.id, r.id));
  return { ok: true, sentTo: recipients.length };
}

/** Hourly cron tick (registered in _core/index.ts). */
export async function runReportScheduler(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date();
  const scheduled = await db.select().from(savedReports).where(ne(savedReports.scheduleFreq, "none"));
  for (const r of scheduled) {
    try {
      if (!isDue(r.scheduleFreq, r.scheduleLastSentAt ? new Date(r.scheduleLastSentAt) : null, now)) continue;
      const res = await emailSavedReport(r.id, r.workspaceId);
      console.log(`[ReportScheduler] "${r.name}" (ws ${r.workspaceId}): ${res.ok ? `sent to ${res.sentTo}` : `skipped — ${res.reason}`}`);
    } catch (e) {
      console.error(`[ReportScheduler] report ${r.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
}
