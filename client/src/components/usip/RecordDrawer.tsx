import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { fmtDate, StatusPill } from "./Common";
import { Loader2, Paperclip, Phone, Calendar, MessageSquare, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

type RelatedType = "lead" | "contact" | "account" | "opportunity" | "customer";

const DISPOSITIONS = [
  ["connected", "Connected"],
  ["voicemail", "Voicemail"],
  ["no_answer", "No answer"],
  ["bad_number", "Bad number"],
  ["gatekeeper", "Gatekeeper"],
  ["callback_requested", "Callback requested"],
  ["not_interested", "Not interested"],
] as const;

export function RecordDrawer({
  open,
  onOpenChange,
  relatedType,
  relatedId,
  title,
  subtitle,
  headerExtras,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  relatedType: RelatedType;
  relatedId: number | null;
  title: string;
  subtitle?: string;
  headerExtras?: React.ReactNode;
}) {
  const [tab, setTab] = useState<"timeline" | "call" | "meeting" | "note" | "files">("timeline");
  const utils = trpc.useUtils();
  const enabled = !!relatedId;
  const acts = trpc.activities.list.useQuery(
    { relatedType, relatedId: relatedId ?? 0 },
    { enabled },
  );
  const files = trpc.attachments.list.useQuery(
    { relatedType, relatedId: relatedId ?? 0 },
    { enabled },
  );

  const refresh = () => {
    if (!relatedId) return;
    utils.activities.list.invalidate({ relatedType, relatedId });
    utils.attachments.list.invalidate({ relatedType, relatedId });
    utils.notifications.list.invalidate();
  };

  const logCall = trpc.activities.logCall.useMutation({ onSuccess: () => { refresh(); toast.success("Call logged"); setTab("timeline"); } });
  const logMeeting = trpc.activities.logMeeting.useMutation({ onSuccess: () => { refresh(); toast.success("Meeting logged"); setTab("timeline"); } });
  const addNote = trpc.activities.addNote.useMutation({ onSuccess: () => { refresh(); toast.success("Note added"); setTab("timeline"); } });
  const upload = trpc.attachments.upload.useMutation({ onSuccess: () => { refresh(); toast.success("File attached"); } });
  const delAtt = trpc.attachments.delete.useMutation({ onSuccess: () => refresh() });

  const fileInput = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !relatedId) return;
    if (f.size > 5 * 1024 * 1024) { toast.error("Max 5MB per file"); return; }
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const b64 = btoa(bin);
    upload.mutate({ relatedType, relatedId, fileName: f.name, mimeType: f.type || "application/octet-stream", base64: b64 });
    e.target.value = "";
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            <span>{title}</span>
            {headerExtras}
          </SheetTitle>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </SheetHeader>

        <div className="flex gap-1 border-b text-xs mt-2">
          {[
            { k: "timeline", label: "Timeline" },
            { k: "call", label: "Log call" },
            { k: "meeting", label: "Log meeting" },
            { k: "note", label: "Add note" },
            { k: "files", label: `Files (${files.data?.length ?? 0})` },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k as any)}
              className={`px-3 py-2 ${tab === t.k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}
            >{t.label}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto py-3 space-y-3">
          {tab === "timeline" && (
            <>
              {acts.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Loading…</div>}
              {acts.data?.length === 0 && <div className="text-sm text-muted-foreground py-8 text-center">No activity logged yet. Use the tabs above to log a call, meeting, or note.</div>}
              {acts.data?.map((a: any) => (
                <div key={a.id} className="border rounded-md p-3 bg-card">
                  <div className="flex items-center gap-2 text-xs">
                    {a.kind === "call" && <Phone className="size-3 text-[#14B89A]" />}
                    {a.kind === "meeting" && <Calendar className="size-3 text-blue-600" />}
                    {a.kind === "note" && <MessageSquare className="size-3 text-amber-600" />}
                    <span className="font-semibold uppercase tracking-wide">{a.kind}</span>
                    {a.disposition && <StatusPill tone={a.disposition === "connected" ? "success" : a.disposition === "not_interested" ? "danger" : "warning"}>{a.disposition.replace(/_/g, " ")}</StatusPill>}
                    <span className="ml-auto text-muted-foreground">{fmtDate(a.createdAt)}</span>
                  </div>
                  {a.subject && <div className="text-sm font-semibold mt-1">{a.subject}</div>}
                  {a.notes && <div className="text-sm whitespace-pre-wrap mt-1 text-foreground/90">{a.notes}</div>}
                  {Array.isArray(a.mentions) && a.mentions.length > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-1">Notified: {a.mentions.length} user(s)</div>
                  )}
                </div>
              ))}
            </>
          )}

          {tab === "call" && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!relatedId) return;
              const fd = new FormData(e.currentTarget);
              logCall.mutate({
                relatedType, relatedId,
                disposition: fd.get("disposition") as any,
                durationSec: Number(fd.get("durationSec") || 0),
                outcome: String(fd.get("outcome") || ""),
                notes: String(fd.get("notes") || ""),
              });
            }} className="space-y-3">
              <div>
                <div className="text-xs font-semibold mb-1">Disposition</div>
                <select name="disposition" className="w-full border rounded-md px-3 py-2 text-sm h-10" defaultValue="connected">
                  {DISPOSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold mb-1">Duration (seconds)</div>
                  <input name="durationSec" type="number" min={0} defaultValue={120} className="w-full border rounded-md px-3 py-2 text-sm h-10" />
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">Outcome (one line)</div>
                  <input name="outcome" placeholder="Booked next meeting" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Notes</div>
                <textarea name="notes" rows={5} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <Button type="submit" disabled={logCall.isPending}>{logCall.isPending ? "Saving…" : "Log call"}</Button>
            </form>
          )}

          {tab === "meeting" && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!relatedId) return;
              const fd = new FormData(e.currentTarget);
              logMeeting.mutate({
                relatedType, relatedId,
                subject: String(fd.get("subject") || "Meeting"),
                attendees: String(fd.get("attendees") || "").split(",").map((s) => s.trim()).filter(Boolean),
                notes: [String(fd.get("agenda") || ""), String(fd.get("notes") || "")].filter(Boolean).join("\n\n---\n\n"),
              });
            }} className="space-y-3">
              <div>
                <div className="text-xs font-semibold mb-1">Subject</div>
                <input name="subject" required defaultValue="Discovery" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Attendees (comma separated)</div>
                <input name="attendees" placeholder="Alice, Bob, …" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Agenda</div>
                <textarea name="agenda" rows={3} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Meeting notes</div>
                <textarea name="notes" rows={6} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <Button type="submit" disabled={logMeeting.isPending}>{logMeeting.isPending ? "Saving…" : "Log meeting"}</Button>
            </form>
          )}

          {tab === "note" && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!relatedId) return;
              const fd = new FormData(e.currentTarget);
              addNote.mutate({
                relatedType, relatedId,
                body: String(fd.get("body") || ""),
              });
            }} className="space-y-3">
              <div className="text-xs text-muted-foreground">Use <code className="bg-secondary px-1 rounded">@[Name](user:1)</code> to @-mention a teammate. They'll get an in-app notification.</div>
              <textarea name="body" required rows={6} placeholder="Quick update on this account…" className="w-full border rounded-md px-3 py-2 text-sm" />
              <Button type="submit" disabled={addNote.isPending}>{addNote.isPending ? "Saving…" : "Add note"}</Button>
            </form>
          )}

          {tab === "files" && (
            <>
              <div className="flex items-center gap-2">
                <input ref={fileInput} type="file" className="hidden" onChange={onFile} />
                <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
                  <Paperclip className="size-3 mr-1" /> {upload.isPending ? "Uploading…" : "Attach file"}
                </Button>
                <span className="text-xs text-muted-foreground">5 MB max per file. Stored in S3.</span>
              </div>
              {files.data?.length === 0 && <div className="text-sm text-muted-foreground py-8 text-center">No files attached.</div>}
              <div className="space-y-2">
                {files.data?.map((f: any) => (
                  <div key={f.id} className="flex items-center gap-2 border rounded-md p-2 bg-card">
                    <Paperclip className="size-3 text-muted-foreground" />
                    <a href={f.url} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline flex-1 truncate">{f.fileName}</a>
                    <span className="text-[11px] text-muted-foreground">{Math.round(((f.sizeBytes ?? 0) / 1024))} KB</span>
                    <button onClick={() => delAtt.mutate({ id: f.id })} className="text-muted-foreground hover:text-rose-600">
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
