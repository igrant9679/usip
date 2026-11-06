/**
 * The record drawer's Timeline tab: one card per activity, newest first.
 *
 * Reads the activities row as activities.list returns it (audit 2026-10-20,
 * R7). The drawer read `kind`, `notes` and `disposition`, which no row has —
 * the columns are `type`, `body` and `callDisposition` — so every card showed
 * no type, no note text and no call outcome. Only the deal timeline, which
 * maps its own rows, ever showed them.
 */
import { Calendar, MessageSquare, Phone, Trash2 } from "lucide-react";
import { ConfirmButton, fmtDate, StatusPill } from "../Common";

export type ActivityRow = {
  id: number;
  type?: string | null;
  subject?: string | null;
  body?: string | null;
  callDisposition?: string | null;
  mentions?: unknown;
  occurredAt?: Date | string | null;
  createdAt?: Date | string | null;
};

/** What one card shows, from the row's own columns. */
export function activityView(a: ActivityRow) {
  return {
    kind: a.type ?? "note",
    subject: a.subject ?? null,
    text: a.body ?? null,
    disposition: a.callDisposition ?? null,
    at: a.occurredAt ?? a.createdAt ?? null,
    mentioned: Array.isArray(a.mentions) ? a.mentions.length : 0,
  };
}

export function DrawerTimeline({ rows, onDelete }: { rows: ActivityRow[]; onDelete: (id: number) => void }) {
  return (
    <>
      {rows.map((a) => {
        const v = activityView(a);
        return (
          <div key={a.id} className="border rounded-md p-3 bg-card group">
            <div className="flex items-center gap-2 text-xs">
              {v.kind === "call" && <Phone className="size-3 text-[#14B89A]" />}
              {v.kind === "meeting" && <Calendar className="size-3 text-blue-600" />}
              {v.kind === "note" && <MessageSquare className="size-3 text-amber-600" />}
              <span className="font-semibold uppercase tracking-wide">{v.kind}</span>
              {v.disposition && <StatusPill tone={v.disposition === "connected" ? "success" : v.disposition === "not_interested" ? "danger" : "warning"}>{v.disposition.replace(/_/g, " ")}</StatusPill>}
              <span className="ml-auto text-muted-foreground">{fmtDate(v.at)}</span>
              <ConfirmButton
                ariaLabel="Delete activity"
                className="text-muted-foreground hover:text-destructive p-0.5 h-auto rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                title="Delete this activity?"
                description="This activity will be permanently removed from the timeline. This cannot be undone."
                confirmLabel="Delete"
                onConfirm={() => onDelete(a.id)}
              >
                <Trash2 className="size-3" />
              </ConfirmButton>
            </div>
            {v.subject && <div className="text-sm font-semibold mt-1">{v.subject}</div>}
            {v.text && <div className="text-sm whitespace-pre-wrap mt-1 text-foreground/90">{v.text}</div>}
            {v.mentioned > 0 && (
              <div className="text-[11px] text-muted-foreground mt-1">Notified: {v.mentioned} user(s)</div>
            )}
          </div>
        );
      })}
    </>
  );
}
