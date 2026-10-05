/**
 * KnowledgeSection — Settings → Knowledge base (owner ask 2026-10-05:
 * "attach pdfs to provide full product/service/pricing/etc. knowledge to the
 * agent and to inform the AI generated outputs (emails, etc.) in general").
 *
 * Documents (PDF, .txt/.md, web pages) and the overview every AI prompt and
 * call carries. Admins manage; everyone can see what the AI knows and try a
 * search.
 */
import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/usip/Common";
import { FileText, Globe, Loader2, RefreshCw, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { isAdminRole } from "@shared/roleRank";

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {sub && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

const fmtSize = (n?: number | null) => (n == null ? "" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
}

export function KnowledgeSection() {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = isAdminRole(me.data?.role);
  const list = trpc.knowledgeBase.list.useQuery(undefined, {
    // Poll while something is being read.
    refetchInterval: (q) => ((q.state.data as any)?.documents ?? []).some((d: any) => d.status === "processing") ? 3000 : false,
  });
  const refresh = () => void utils.knowledgeBase.list.invalidate();

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");

  // Failures are reported per file, with its name, by onFiles' catch.
  const upload = trpc.knowledgeBase.upload.useMutation({ meta: { silentError: true } });
  const addUrl = trpc.knowledgeBase.addUrl.useMutation({
    onSuccess: () => { setUrl(""); toast.success("Reading the page…"); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.knowledgeBase.update.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const remove = trpc.knowledgeBase.remove.useMutation({ onSuccess: () => { toast.success("Document deleted"); refresh(); }, onError: (e) => toast.error(e.message) });
  const reread = trpc.knowledgeBase.refresh.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const saveSummary = trpc.knowledgeBase.saveSummary.useMutation({
    onSuccess: () => { toast.success("Overview saved"); setSummary(null); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const genSummary = trpc.knowledgeBase.generateSummary.useMutation({
    onSuccess: () => { toast.success("Overview redrafted from your documents"); setSummary(null); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const search = trpc.knowledgeBase.search.useQuery({ query: asked }, { enabled: asked.trim().length > 0 });

  const data = list.data;
  const docs = (data?.documents ?? []) as Record<string, any>[];
  const maxBytes = data?.limits.maxUploadBytes ?? 20 * 1024 * 1024;
  const summaryText = summary ?? data?.summary ?? "";

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > maxBytes) { toast.error(`${file.name} is larger than 20 MB.`); continue; }
      setUploading((n) => n + 1);
      try {
        const base64 = await readBase64(file);
        await upload.mutateAsync({ fileName: file.name, mimeType: file.type, base64 });
        toast.success(`Reading ${file.name}…`);
      } catch (e: any) {
        toast.error(`${file.name}: ${e?.message ?? "upload failed"}`);
      } finally {
        setUploading((n) => n - 1);
        refresh();
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <>
      <div className="shrink-0 px-6 pt-4">
        <h1 className="text-xl font-semibold tracking-tight">Knowledge base</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40 mt-3 border-t border-border">
        <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6">
          <Card
            title="Documents"
            sub="Product sheets, pricing, service descriptions, policies, FAQs. Every AI writer in this workspace (emails, replies, sequences, campaigns, proposals) uses them, and the AI phone agent can search them during a call. PDFs with real text work best; scanned images can't be read."
          >
            {isAdmin && (
              <div className="space-y-3">
                <div
                  className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}
                >
                  <Upload className="size-6 text-muted-foreground" />
                  <div className="text-[13px]">Drop PDFs here, or</div>
                  <Button size="sm" variant="outline" disabled={uploading > 0} onClick={() => fileRef.current?.click()}>
                    {uploading > 0 ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Choose files
                  </Button>
                  <input ref={fileRef} type="file" multiple accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" className="hidden" onChange={(e) => void onFiles(e.target.files)} />
                  <div className="text-[11.5px] text-muted-foreground">PDF, .txt or .md, up to 20 MB each, {data?.limits.maxDocuments ?? 100} documents in all.</div>
                </div>
                <div className="flex gap-2">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourcompany.com/pricing" />
                  <Button size="sm" variant="outline" className="gap-1.5 shrink-0" disabled={!/^https?:\/\/\S+\.\S+/.test(url.trim()) || addUrl.isPending}
                    onClick={() => addUrl.mutate({ url: url.trim() })}>
                    <Globe className="size-3.5" /> Add web page
                  </Button>
                </div>
              </div>
            )}

            {list.isLoading ? (
              <div className="h-20 animate-pulse rounded-lg bg-muted/60" />
            ) : docs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[12.5px] text-muted-foreground">
                No documents yet.{isAdmin ? "" : " An admin adds them."}
              </div>
            ) : (
              <div className="divide-y divide-border/60 rounded-lg border border-border/70">
                {docs.map((d) => (
                  <div key={d.id} className="flex items-center gap-3 px-3.5 py-3">
                    {d.sourceType === "url" ? <Globe className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium" title={d.sourceUrl ?? d.title}>{d.title}</div>
                      <div className={cn("truncate text-[12px]", d.status === "failed" ? "text-rose-600" : "text-muted-foreground")}>
                        {d.status === "processing" && <><Loader2 className="mr-1 inline size-3 animate-spin" />Reading…</>}
                        {d.status === "failed" && (d.error ?? "Could not be read")}
                        {d.status === "ready" && [
                          d.pageCount ? `${d.pageCount} page${d.pageCount === 1 ? "" : "s"}` : null,
                          d.charCount ? `${Math.round(d.charCount / 1000)}k characters` : null,
                          fmtSize(d.sizeBytes) || null,
                          d.uploadedByName ? `added by ${d.uploadedByName}` : null,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {isAdmin && (
                      <>
                        {d.sourceType === "url" && (
                          <button type="button" aria-label={`Read ${d.title} again`} title="Read the page again"
                            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => reread.mutate({ id: d.id })}>
                            <RefreshCw className="size-4" />
                          </button>
                        )}
                        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground" title="Off: kept, but no AI uses it">
                          <Switch checked={!!d.enabled} disabled={update.isPending} onCheckedChange={(v) => update.mutate({ id: d.id, enabled: v })} />
                          {d.enabled ? "In use" : "Off"}
                        </label>
                        <button type="button" aria-label={`Delete ${d.title}`}
                          className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600"
                          onClick={() => confirmAction({ title: `Delete ${d.title}?`, description: "The AI stops using it. The original file is not kept, so upload it again to restore it.", confirmLabel: "Delete" }, () => remove.mutate({ id: d.id }))}>
                          <Trash2 className="size-4" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Overview"
            sub="A short summary every AI prompt and every call carries: what you offer, to whom, prices and key terms. Drafted from your documents when the first one is added; edit it, or redraft it after adding documents. Details beyond it are looked up from the documents as needed."
          >
            <textarea
              value={summaryText}
              onChange={(e) => setSummary(e.target.value)}
              readOnly={!isAdmin}
              rows={9}
              maxLength={data?.limits.summaryMaxChars ?? 2500}
              placeholder={docs.length ? "No overview yet: redraft it from your documents." : "Add a document and an overview is drafted from it."}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && (
                <>
                  <Button size="sm" disabled={summary === null || saveSummary.isPending} onClick={() => saveSummary.mutate({ summary: summaryText })}>Save</Button>
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={genSummary.isPending || !docs.some((d) => d.status === "ready" && d.enabled)}
                    onClick={() => confirmAction({ title: "Redraft the overview?", description: "It replaces the current overview, including your edits.", confirmLabel: "Redraft" }, () => genSummary.mutate())}>
                    {genSummary.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Redraft from documents
                  </Button>
                </>
              )}
              <span className="text-[11.5px] text-muted-foreground">
                {summaryText.length}/{data?.limits.summaryMaxChars ?? 2500}
                {data?.summaryUpdatedAt ? ` · updated ${new Date(data.summaryUpdatedAt).toLocaleString()}` : ""}
              </span>
            </div>
          </Card>

          <Card title="Try it" sub="Ask a question the way a prospect would. These are the passages an email writer or the phone agent would be given.">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setAsked(query.trim()); }}>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="How much is the enterprise plan?" />
              <Button size="sm" type="submit" variant="outline" className="gap-1.5 shrink-0" disabled={!query.trim()}><Search className="size-3.5" /> Search</Button>
            </form>
            {asked && (
              search.isLoading ? <div className="h-16 animate-pulse rounded-lg bg-muted/60" /> :
              (search.data?.passages ?? []).length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">Nothing in the documents matches. The AI would say the team will follow up.</p>
              ) : (
                <div className="space-y-2">
                  {(search.data?.passages ?? []).map((p, i) => (
                    <div key={i} className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                      <div className="text-[11.5px] font-medium text-muted-foreground">{p.title}{p.page ? `, page ${p.page}` : ""}</div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[12.5px]">{p.content}</div>
                    </div>
                  ))}
                </div>
              )
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
