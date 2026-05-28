/**
 * EntityDetail — shared detail-page chrome for CRM entities.
 *
 * Provides the tabs layout (Overview · Activities · Notes · Related · Files)
 * used by /accounts/:id, /contacts/:id, /leads/:id, /opportunities/:id.
 *
 * The caller supplies:
 *   - `header` (already wrapped in <PageHeader>)
 *   - `overview` (the entity-specific summary panel)
 *   - `related` (entity-specific related-records panel — e.g. opps under
 *     an account, contact roles on an opp)
 *   - `entityType` + `entityId` — passed to Activities/Notes/Files tabs
 *     so they fetch the right slice via the existing tRPC endpoints.
 *
 * The Activities tab reuses the existing `trpc.activities.list` endpoint
 * which already takes (relatedType, relatedId). The Notes tab uses the
 * new `trpc.crmNotes.*` endpoints. Files uses `trpc.attachments.*`.
 */
import { ReactNode, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Activity,
  FileText,
  Pin,
  PinOff,
  Trash2,
  Upload,
  Download,
  StickyNote,
  LinkIcon,
  Phone,
  Mail,
  Calendar,
} from "lucide-react";
import { EmptyState } from "@/components/usip/Shell";

export type CrmEntityType = "account" | "contact" | "lead" | "opportunity" | "customer";

function ActivityIcon({ type }: { type: string }) {
  if (type === "call") return <Phone className="size-3.5" />;
  if (type === "meeting") return <Calendar className="size-3.5" />;
  if (type === "email") return <Mail className="size-3.5" />;
  if (type === "note") return <StickyNote className="size-3.5" />;
  return <Activity className="size-3.5" />;
}

function fmt(t: any): string {
  if (!t) return "";
  try { return new Date(t).toLocaleString(); } catch { return String(t); }
}

/* ─── Activities tab ────────────────────────────────────────────────── */
function ActivitiesTab({ entityType, entityId }: { entityType: CrmEntityType; entityId: number }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.activities.list.useQuery({ relatedType: entityType, relatedId: entityId });
  const [callOpen, setCallOpen] = useState(false);
  const invalidate = () => utils.activities.list.invalidate({ relatedType: entityType, relatedId: entityId });
  const logCall = trpc.activities.logCall.useMutation({ onSuccess: () => { invalidate(); setCallOpen(false); toast.success("Call logged"); } });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setCallOpen(true)}><Phone className="size-3.5 mr-1" /> Log call</Button>
      </div>
      {isLoading ? <div className="text-sm text-muted-foreground p-6">Loading…</div> :
        !data || data.length === 0 ? <EmptyState icon={Activity} title="No activity yet" description="Calls, meetings, emails, and notes will appear here." /> :
        <ul className="divide-y rounded-lg border bg-card">
          {data.map((a: any) => (
            <li key={a.id} className="p-3 flex gap-3">
              <div className="mt-0.5 size-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
                <ActivityIcon type={a.type} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{a.subject ?? a.type}</span>
                  <Badge variant="outline" className="text-[10px]">{a.type}</Badge>
                  {a.callDurationSec ? <span className="text-[11px] text-muted-foreground">{Math.round(a.callDurationSec / 60)}m</span> : null}
                </div>
                {a.body && <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap line-clamp-4">{a.body}</div>}
                <div className="text-[11px] text-muted-foreground mt-1">{fmt(a.occurredAt ?? a.createdAt)}</div>
              </div>
            </li>
          ))}
        </ul>
      }
      {callOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setCallOpen(false)}>
          <div className="bg-card rounded-lg border p-4 w-[420px] max-w-[90vw] space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-medium">Log call</h3>
            <CallLogForm onSubmit={(payload) => logCall.mutate({ relatedType: entityType, relatedId: entityId, ...payload })} isPending={logCall.isPending} onCancel={() => setCallOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function CallLogForm({ onSubmit, isPending, onCancel }: {
  onSubmit: (p: { disposition: any; durationSec: number; outcome?: string; notes?: string }) => void;
  isPending: boolean; onCancel: () => void;
}) {
  const [disposition, setDisposition] = useState<string>("connected");
  const [duration, setDuration] = useState<string>("5");
  const [outcome, setOutcome] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ disposition: disposition as any, durationSec: Math.round(Number(duration) * 60), outcome: outcome || undefined, notes: notes || undefined }); }}>
      <div>
        <label className="text-xs text-muted-foreground">Disposition</label>
        <select className="w-full bg-secondary rounded px-2 py-1.5 text-sm mt-1" value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          {["connected", "voicemail", "no_answer", "bad_number", "gatekeeper", "callback_requested", "not_interested"].map((d) => <option key={d} value={d}>{d.replace(/_/g, " ")}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Duration (minutes)</label>
          <input type="number" min={0} className="w-full bg-secondary rounded px-2 py-1.5 text-sm mt-1" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Outcome (optional)</label>
          <input type="text" className="w-full bg-secondary rounded px-2 py-1.5 text-sm mt-1" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="next steps…" />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Notes</label>
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={isPending}>Save call</Button>
      </div>
    </form>
  );
}

/* ─── Notes tab ─────────────────────────────────────────────────────── */
function NotesTab({ entityType, entityId }: { entityType: CrmEntityType; entityId: number }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.crmNotes.list.useQuery({ entityType, entityId });
  const [draft, setDraft] = useState("");
  const invalidate = () => utils.crmNotes.list.invalidate({ entityType, entityId });
  const create = trpc.crmNotes.create.useMutation({ onSuccess: () => { setDraft(""); invalidate(); } });
  const update = trpc.crmNotes.update.useMutation({ onSuccess: invalidate });
  const del = trpc.crmNotes.delete.useMutation({ onSuccess: invalidate });

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-4 space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a note…" rows={3} />
          <div className="flex justify-end">
            <Button size="sm" disabled={!draft.trim() || create.isPending}
              onClick={() => create.mutate({ entityType, entityId, body: draft.trim() })}>
              Save note
            </Button>
          </div>
        </CardContent>
      </Card>
      {isLoading ? <div className="text-sm text-muted-foreground">Loading…</div> :
        !data || data.length === 0 ? <EmptyState icon={StickyNote} title="No notes yet" /> :
        <ul className="space-y-2">
          {data.map((n) => (
            <li key={n.id} className={`rounded-lg border bg-card p-3 ${n.pinned ? "border-amber-300/60" : ""}`}>
              <div className="flex justify-between items-start gap-2">
                <div className="text-sm whitespace-pre-wrap flex-1">{n.body}</div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="size-7"
                    onClick={() => update.mutate({ id: n.id, pinned: !n.pinned })}>
                    {n.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7 text-destructive"
                    onClick={() => { if (confirm("Delete this note?")) del.mutate({ id: n.id }); }}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{fmt(n.createdAt)}</div>
            </li>
          ))}
        </ul>
      }
    </div>
  );
}

/* ─── Files tab ─────────────────────────────────────────────────────── */
function FilesTab({ entityType, entityId }: { entityType: CrmEntityType; entityId: number }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.attachments.list.useQuery({ relatedType: entityType, relatedId: entityId });
  const upload = trpc.attachments.upload.useMutation({
    onSuccess: () => { utils.attachments.list.invalidate({ relatedType: entityType, relatedId: entityId }); toast.success("Uploaded"); },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.attachments.delete.useMutation({
    onSuccess: () => utils.attachments.list.invalidate({ relatedType: entityType, relatedId: entityId }),
  });

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error("Files must be under 8 MB"); return; }
    // Use FileReader → data URL to avoid the spread-arg ceiling on Uint8Array
    // for large files. Strip the leading "data:...;base64," prefix.
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ""));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.split(",")[1] ?? "";
    upload.mutate({ relatedType: entityType, relatedId: entityId, fileName: file.name, mimeType: file.type || undefined, base64 });
    e.target.value = "";
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <label className="cursor-pointer">
          <input type="file" className="hidden" onChange={onPick} />
          <Button asChild size="sm" variant="outline" disabled={upload.isPending}>
            <span><Upload className="size-3.5 mr-1" /> {upload.isPending ? "Uploading…" : "Upload file"}</span>
          </Button>
        </label>
      </div>
      {isLoading ? <div className="text-sm text-muted-foreground">Loading…</div> :
        !data || data.length === 0 ? <EmptyState icon={FileText} title="No files yet" /> :
        <ul className="rounded-lg border bg-card divide-y">
          {data.map((f: any) => (
            <li key={f.id} className="p-3 flex items-center gap-3">
              <FileText className="size-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{f.fileName}</div>
                <div className="text-[11px] text-muted-foreground">{fmt(f.createdAt)} · {f.sizeBytes ? `${Math.ceil(f.sizeBytes / 1024)} KB` : ""}</div>
              </div>
              {f.url && (
                <a href={f.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                  <Download className="size-4" />
                </a>
              )}
              <Button variant="ghost" size="icon" className="size-7 text-destructive"
                onClick={() => { if (confirm("Delete this file?")) del.mutate({ id: f.id }); }}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      }
    </div>
  );
}

/* ─── Public component ──────────────────────────────────────────────── */
export function EntityDetailTabs({
  entityType, entityId, overview, related, extraTabs,
}: {
  entityType: CrmEntityType;
  entityId: number;
  overview: ReactNode;
  related?: ReactNode;
  /** Optional extra tabs slotted between Overview and Activities (e.g. Stage history on opps). */
  extraTabs?: { value: string; label: string; icon?: ReactNode; content: ReactNode }[];
}) {
  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        {(extraTabs ?? []).map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}
        <TabsTrigger value="activities"><Activity className="size-3.5 mr-1" /> Activities</TabsTrigger>
        <TabsTrigger value="notes"><StickyNote className="size-3.5 mr-1" /> Notes</TabsTrigger>
        {related ? <TabsTrigger value="related"><LinkIcon className="size-3.5 mr-1" /> Related</TabsTrigger> : null}
        <TabsTrigger value="files"><FileText className="size-3.5 mr-1" /> Files</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="pt-4">{overview}</TabsContent>
      {(extraTabs ?? []).map((t) => (
        <TabsContent key={t.value} value={t.value} className="pt-4">{t.content}</TabsContent>
      ))}
      <TabsContent value="activities" className="pt-4">
        <ActivitiesTab entityType={entityType} entityId={entityId} />
      </TabsContent>
      <TabsContent value="notes" className="pt-4">
        <NotesTab entityType={entityType} entityId={entityId} />
      </TabsContent>
      {related ? <TabsContent value="related" className="pt-4">{related}</TabsContent> : null}
      <TabsContent value="files" className="pt-4">
        <FilesTab entityType={entityType} entityId={entityId} />
      </TabsContent>
    </Tabs>
  );
}
