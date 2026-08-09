/**
 * Microsoft 365 (OneNote + OneDrive) — client surfaces.
 *
 * MicrosoftGraphCard: the connection card on /connected-accounts. Per
 * MEMBER — each person OAuths their own Microsoft account; the card shows
 * whose account is linked, the OneNote sync state, and a Sync-now button.
 * Until the server has MS_GRAPH_CLIENT_ID/SECRET the card says exactly
 * that instead of a dead Connect button.
 *
 * RecordFiles: the Files section inside the record drawer — list linked
 * OneDrive files, attach an existing one (mini folder browser), upload a
 * new one into /Velocity CRM/<type>s/.
 */
import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Cloud, FolderOpen, File as FileIcon, ChevronLeft, Loader2, Upload,
  ExternalLink, X, RefreshCw, CheckCircle2, AlertTriangle, NotebookPen,
} from "lucide-react";

/* ── Connection card ────────────────────────────────────────────────────── */

export function MicrosoftGraphCard() {
  const utils = trpc.useUtils();
  const status = trpc.graph.status.useQuery(undefined, { refetchInterval: 15_000 });
  const getUrl = trpc.graph.getConnectUrl.useMutation({
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast.error(e.message),
  });
  const disconnect = trpc.graph.disconnect.useMutation({
    onSuccess: () => { utils.graph.status.invalidate(); toast.success("Microsoft account disconnected"); },
    onError: (e) => toast.error(e.message),
  });
  const syncNow = trpc.graph.onenoteSyncNow.useMutation({
    onSuccess: (r) => {
      utils.graph.status.invalidate();
      toast.success(`OneNote synced — ${r.pushed} pushed, ${r.pulled} pulled${r.skippedUnmatched ? `, ${r.skippedUnmatched} unmatched skipped` : ""}`);
      if (r.errors.length) toast.warning(`${r.errors.length} item(s) failed — details on the card`);
    },
    onError: (e) => toast.error(e.message),
  });

  const s = status.data;
  const last = s?.lastSyncResult;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Cloud className="size-4 text-sky-600" />
          Microsoft 365 — OneNote &amp; OneDrive
          {s?.connected && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300 rounded-full px-1.5 py-0.5">
              <CheckCircle2 className="size-3" /> {s.msEmail ?? "Connected"}
            </span>
          )}
          {s?.needsReconnect && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-100 rounded-full px-1.5 py-0.5">
              <AlertTriangle className="size-3" /> Reconnect needed
            </span>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Your notes mirror into a “Velocity CRM” OneNote notebook (both directions, every 30 minutes),
          and OneDrive files can be attached to contacts, companies, and deals. Each team member connects
          their own Microsoft account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!s?.envConfigured && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-[11px] text-amber-900 dark:text-amber-200">
            Server setup pending: <code className="bg-amber-500/10 px-1 rounded">MS_GRAPH_CLIENT_ID</code> and{" "}
            <code className="bg-amber-500/10 px-1 rounded">MS_GRAPH_CLIENT_SECRET</code> are not set on Railway yet.
            The Connect button activates the moment they are.
          </div>
        )}
        {s?.connected && (
          <div className="rounded-md border bg-muted/30 p-2.5 text-[11px] text-muted-foreground space-y-1">
            <div className="flex items-center gap-1.5">
              <NotebookPen className="size-3.5" />
              OneNote sync: {s.onenoteSyncedAt ? `last ran ${new Date(s.onenoteSyncedAt).toLocaleString()}` : "hasn't run yet"}
            </div>
            {last && (
              <div>
                Last result: {last.pushed} pushed · {last.pulled} pulled
                {last.skippedUnmatched ? ` · ${last.skippedUnmatched} skipped (no matching record — pages sync only from sections named like “Contact — Jane Doe”)` : ""}
                {last.errors.length ? ` · ${last.errors.length} error(s): ${last.errors[0]}` : ""}
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2">
          {s?.connected ? (
            <>
              <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={syncNow.isPending}
                onClick={() => syncNow.mutate()}>
                {syncNow.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                Sync OneNote now
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-8 gap-1.5" disabled={!s?.envConfigured || getUrl.isPending}
              onClick={() => getUrl.mutate()}>
              {getUrl.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Cloud className="size-3.5" />}
              {s?.needsReconnect ? "Reconnect Microsoft account" : "Connect Microsoft account"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── OneDrive picker dialog ─────────────────────────────────────────────── */

function OneDrivePicker({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (itemId: string, name: string) => void;
}) {
  // Folder navigation stack: [{id?: undefined = root, name: "OneDrive"}]
  const [stack, setStack] = useState<Array<{ id?: string; name: string }>>([{ name: "OneDrive" }]);
  const top = stack[stack.length - 1];
  const list = trpc.graph.oneDriveList.useQuery({ itemId: top.id }, { enabled: open });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Cloud className="size-4 text-sky-600" /> Attach from OneDrive
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {stack.length > 1 && (
            <button type="button" className="p-1 rounded hover:bg-muted"
              onClick={() => setStack((s) => s.slice(0, -1))}>
              <ChevronLeft className="size-3.5" />
            </button>
          )}
          <span className="truncate">{stack.map((s) => s.name).join(" / ")}</span>
        </div>
        <div className="border rounded-md max-h-72 overflow-y-auto divide-y">
          {list.isLoading && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin inline mr-1.5" /> Loading…
            </div>
          )}
          {list.error && (
            <div className="p-4 text-xs text-destructive">{list.error.message}</div>
          )}
          {(list.data?.items ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/60"
              onClick={() =>
                item.isFolder
                  ? setStack((s) => [...s, { id: item.id, name: item.name }])
                  : onPick(item.id, item.name)
              }
            >
              {item.isFolder
                ? <FolderOpen className="size-4 text-amber-500 shrink-0" />
                : <FileIcon className="size-4 text-muted-foreground shrink-0" />}
              <span className="text-xs text-foreground truncate flex-1">{item.name}</span>
              {!item.isFolder && item.size != null && (
                <span className="text-[10px] text-muted-foreground shrink-0">{(item.size / 1024).toFixed(0)} KB</span>
              )}
            </button>
          ))}
          {!list.isLoading && (list.data?.items ?? []).length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">Empty folder</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Files section for a record ─────────────────────────────────────────── */

export function RecordFiles({
  relatedType, relatedId,
}: {
  relatedType: "contact" | "lead" | "account" | "opportunity";
  relatedId: number;
}) {
  const utils = trpc.useUtils();
  const status = trpc.graph.status.useQuery();
  const files = trpc.graph.listFiles.useQuery({ relatedType, relatedId });
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const invalidate = () => utils.graph.listFiles.invalidate({ relatedType, relatedId });
  const attach = trpc.graph.attachFile.useMutation({
    onSuccess: (r) => { invalidate(); setPickerOpen(false); toast.success(`Attached ${r.name}`); },
    onError: (e) => toast.error(e.message),
  });
  const upload = trpc.graph.uploadFile.useMutation({
    onSuccess: (r) => { invalidate(); toast.success(`Uploaded ${r.name} to OneDrive`); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.graph.removeFile.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const download = trpc.graph.downloadUrl.useMutation({
    onSuccess: (r) => window.open(r.url, "_blank", "noopener"),
    onError: (e) => toast.error(e.message),
  });

  const onUploadPick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast.error("Keep uploads under 20 MB."); return; }
    const buf = await f.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    upload.mutate({ relatedType, relatedId, filename: f.name, dataBase64: btoa(binary) });
  };

  const connected = status.data?.connected;

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Cloud className="size-4 text-sky-600" />
        <span className="text-sm font-medium">Files (OneDrive)</span>
        <span className="ml-auto" />
        {connected && (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] gap-1"
              onClick={() => setPickerOpen(true)}>
              <FolderOpen className="size-3" /> Attach
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] gap-1"
              disabled={upload.isPending}
              onClick={() => fileInputRef.current?.click()}>
              {upload.isPending ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />} Upload
            </Button>
            <input ref={fileInputRef} type="file" className="hidden"
              onChange={(e) => { void onUploadPick(e.target.files?.[0]); e.target.value = ""; }} />
          </>
        )}
      </div>

      {!connected && (
        <p className="text-[11px] text-muted-foreground">
          Connect Microsoft 365 on <a href="/connected-accounts" className="underline">Connected Accounts</a> to
          attach OneDrive files here.
        </p>
      )}

      {connected && (files.data?.files ?? []).length === 0 && (
        <p className="text-[11px] text-muted-foreground">No files linked yet.</p>
      )}

      <ul className="space-y-1">
        {(files.data?.files ?? []).map((f) => (
          <li key={f.id} className="flex items-center gap-2 min-w-0 text-xs group">
            <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
            <button
              type="button"
              className="truncate text-foreground hover:underline text-left flex-1"
              title="Open in OneDrive"
              onClick={() => f.webUrl ? window.open(f.webUrl, "_blank", "noopener") : f.driveItemId && download.mutate({ itemId: f.driveItemId })}
            >
              {f.name}
            </button>
            {f.webUrl && (
              <a href={f.webUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100">
                <ExternalLink className="size-3 text-muted-foreground" />
              </a>
            )}
            <button type="button" title="Unlink (keeps the file in OneDrive)"
              className="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100"
              onClick={() => remove.mutate({ id: f.id })}>
              <X className="size-3 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>

      <OneDrivePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(itemId) => attach.mutate({ relatedType, relatedId, itemId })}
      />
    </div>
  );
}
