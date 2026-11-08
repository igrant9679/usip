/**
 * What's Working's filters and its CSV (audit 2026-10-20, F20). Pure, so the
 * tests read every rule.
 *
 *   presetRange  "Last 30 days" as two of the workspace's own days, both
 *                included — counted on the calendar, so a daylight-saving
 *                change in between moves nothing
 *   performanceCsv  the four tables as they stand under the filters, one
 *                section each, every cell through csvCell, so a campaign
 *                named "=HYPERLINK(…)" opens in a spreadsheet as text (the
 *                way the suppression and board exports already are)
 */
import { csvCell } from "@shared/csvCell";
import { localDateOf, safeTimezone } from "@shared/availability";

export const RANGE_PRESETS = [
  { key: "all", label: "All time", days: null },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "custom", label: "Custom range", days: null },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["key"];

const ymd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

/** The last `days` days of the workspace's calendar, today included; nothing for "all" or "custom". */
export function presetRange(preset: RangePreset, tz: string, nowMs: number = Date.now()): { from?: string; to?: string } {
  const p = RANGE_PRESETS.find((r) => r.key === preset);
  if (!p || p.days == null) return {};
  const { y, m, d } = localDateOf(safeTimezone(tz), nowMs);
  return { from: ymd(y, m, d - (p.days - 1)), to: ymd(y, m, d) };
}

export interface PerformanceCsvInput {
  /** "All campaigns · 2026-10-01 to 2026-10-31", written at the top. */
  scopeLabel: string;
  areSteps: Array<{ campaignName: string | null; campaignId: number; stepIndex: number; sent: number; opens: number; opensTracked: boolean; openRate: number; replies: number; replyRate: number; meetings: number; meetingRate: number }>;
  sources: Array<{ sourceType: string; discovered: number; avgIcpScore: number; contacted: number; replied: number; replyRate: number; meetings: number; meetingRate: number }>;
  replies: Array<{ replyClass: string; count: number; share: number }>;
  sequenceSteps: Array<{ sequenceId: number; stepIndex: number; sent: number; opens: number; openRate: number; replies: number; replyRate: number; positiveReplies: number; meetings: number; meetingRate: number }>;
  sourceLabel?: (s: string) => string;
  replyLabel?: (s: string) => string;
}

const line = (cells: unknown[]) => cells.map(csvCell).join(",");

export function performanceCsv(x: PerformanceCsvInput): string {
  const src = x.sourceLabel ?? ((s: string) => s);
  const rep = x.replyLabel ?? ((s: string) => s);
  const out: string[] = [
    line(["What's Working", x.scopeLabel]),
    "",
    line(["Revenue Engine steps"]),
    line(["Campaign", "Step", "Sent", "Opened", "Open rate %", "Replied", "Reply rate %", "Meetings", "Meeting rate %"]),
    ...x.areSteps.map((r) => line([r.campaignName ?? `Campaign ${r.campaignId}`, r.stepIndex + 1, r.sent, r.opensTracked ? r.opens : "not tracked", r.opensTracked ? r.openRate : "", r.replies, r.replyRate, r.meetings, r.meetingRate])),
    "",
    line(["Prospect sources"]),
    line(["Source", "Found", "Avg ICP", "Contacted", "Replied", "Reply rate %", "Meetings", "Meeting rate %"]),
    ...x.sources.map((r) => line([src(r.sourceType), r.discovered, r.avgIcpScore, r.contacted, r.replied, r.replyRate, r.meetings, r.meetingRate])),
    "",
    line(["Reply mix"]),
    line(["Reply", "People", "Share %"]),
    ...x.replies.map((r) => line([rep(r.replyClass), r.count, r.share])),
    "",
    line(["CRM Sequences (not the Revenue Engine)"]),
    line(["Sequence", "Step", "Sent", "Opens", "Open rate %", "Replies", "Reply rate %", "Willing to meet", "Meetings", "Meeting rate %"]),
    ...x.sequenceSteps.map((r) => line([r.sequenceId, r.stepIndex + 1, r.sent, r.opens, r.openRate, r.replies, r.replyRate, r.positiveReplies, r.meetings, r.meetingRate])),
  ];
  return out.join("\r\n") + "\r\n";
}
