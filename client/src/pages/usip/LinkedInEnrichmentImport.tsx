/**
 * LinkedIn Enrichment Import (/v2/data-enrichment/linkedin).
 *
 * The batch-import workflow over the compliant Unipile enrichment backend:
 *   1. Integration-health banner gates the page (connect a LinkedIn account).
 *   2. Paste URLs or upload a CSV → read by lib/linkedinCsv, columns mapped by
 *      the person, sliced into batches of MAX_BATCH_ROWS (client-side). The
 *      batch on screen is kept in the URL, so a reload returns to it.
 *   3. Validate & import → createBatch (server validates/normalizes/dedupes).
 *   4. Review the validation preview → Run enrichment (Unipile retrieve + match).
 *   5. Results table with per-row match status + inline review for uncertain
 *      matches (match existing / create new / skip).
 *   6. Daily-check status card (+ admin "Run check now").
 *
 * Retrieval is Unipile-only — no scraping. Enrichment is optional metadata.
 */
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Shell } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { rankOf, ROLE_RANK } from "@shared/roleRank";
import { confirmAction } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Link2, Upload, FileUp, Loader2, CheckCircle2, AlertTriangle, ArrowRight,
  RefreshCw, Clock, Plug, ChevronLeft, Users,
} from "lucide-react";
import {
  LINKEDIN_IMPORT_FIELDS, MAX_BATCH_ROWS, columnNames, columnSamples, findHeaderRow, guessMapping, mappingPreview, parseCsvRecords, rowsFromMapping,
  type LinkedInImportField, type LinkedInImportRow as ParsedRow,
} from "@/lib/linkedinCsv";

/* ───────────────────────── CSV / paste parsing ────────────────────────── */

// One CSV reader and a mapping step (audit 2026-10-20, P91): see
// lib/linkedinCsv. A pasted list is read by the same reader: URL, then name,
// then company, as the placeholder shows.
function parsePaste(text: string): ParsedRow[] {
  return rowsFromMapping(parseCsvRecords(text), null, { linkedinUrl: 0, fullName: 1, company: 2 });
}

type ParsedFile = { name: string; records: string[][]; headerRow: number | null; mapping: Partial<Record<LinkedInImportField, number>> };

/** The batch on screen is in the URL (?batch=), so a reload comes back to it (P96). */
function batchFromUrl(): number | null {
  const v = Number(new URLSearchParams(window.location.search).get("batch"));
  return Number.isInteger(v) && v > 0 ? v : null;
}
function writeBatchToUrl(id: number | null) {
  const sp = new URLSearchParams(window.location.search);
  if (id) sp.set("batch", String(id)); else sp.delete("batch");
  const qs = sp.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
}

/* ──────────────────────────── health banner ───────────────────────────── */

function HealthBanner({ onConnect }: { onConnect: () => void }) {
  const { data, isLoading } = trpc.linkedinEnrichment.status.useQuery();
  if (isLoading || !data) return null;
  if (data.status === "connected") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 px-3 py-2 text-[13px] text-emerald-800 dark:text-emerald-300">
        <CheckCircle2 className="size-4 shrink-0" />
        LinkedIn connected via Unipile — {data.linkedin_capable_account_count} account(s) ready.
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-3 py-2.5 text-[13px] text-amber-800 dark:text-amber-300">
      <AlertTriangle className="size-4 shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-medium">LinkedIn enrichment isn't ready</div>
        <div className="text-[12px] opacity-90">{data.missing_requirements[0] ?? "Connect a LinkedIn-capable Unipile account."}</div>
      </div>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 shrink-0" onClick={onConnect}>
        <Plug className="size-3.5" /> Connect
      </Button>
    </div>
  );
}

/* ───────────────────────── daily-check status card ────────────────────── */

function DailyCheckCard({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const { data: job } = trpc.linkedinEnrichment.dailyCheckStatus.useQuery(undefined, {
    refetchInterval: (q) => ((q.state.data as any)?.status === "running" ? 15_000 : false),
  });
  const run = trpc.linkedinEnrichment.dailyCheckRun.useMutation({
    onSuccess: (r) => { toast.success(`Change check started for ${r.due} profile${r.due === 1 ? "" : "s"}. It runs at the pace the LinkedIn limits allow.`); utils.linkedinEnrichment.dailyCheckStatus.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  // Audit P157: "Run now" forced up to 250 lookups, unconfirmed. It now says
  // how many profiles are due and how many lookups today has left, first.
  const askRun = async () => {
    const p = await utils.linkedinEnrichment.dailyCheckPreview.fetch();
    if (p.due === 0) { toast.info("No profiles are due for a check: each was checked in the last 24 hours."); return; }
    confirmAction({
      title: `Check ${p.due} LinkedIn profile${p.due === 1 ? "" : "s"} now?`,
      description: `Each check is one LinkedIn profile lookup. Your accounts have ${p.lookupsLeftToday} lookup${p.lookupsLeftToday === 1 ? "" : "s"} left today; the checks run at the pace the account limits allow, and what does not fit today continues tomorrow.`,
      confirmLabel: "Check now",
    }, () => run.mutate());
  };
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold inline-flex items-center gap-1.5"><Clock className="size-3.5 text-muted-foreground" /> Daily change check</div>
        {isAdmin && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={run.isPending || job?.status === "running"} onClick={askRun}>
            {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Run now
          </Button>
        )}
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {!job
          ? "No daily check has run yet. Enriched prospects are checked automatically once a day, in working hours."
          : job.status === "waiting" && job.holdReason
            ? `Today's check is waiting for the LinkedIn limits (${job.holdReason}). ${job.checkedCount} checked, ${job.changedCount} changed so far; it continues automatically.`
            : job.status === "running" || job.status === "waiting" || job.status === "pending"
              ? `Today's check is under way: ${job.checkedCount} checked, ${job.changedCount} changed, ${job.failedCount} failed so far.`
              : `Last run ${new Date(job.completedAt ?? job.createdAt).toLocaleString()} — ${job.checkedCount} checked, ${job.changedCount} changed, ${job.failedCount} failed.`}
      </p>
    </div>
  );
}

/* ───────────────────── needs-review / conflict worklist ───────────────── */

/**
 * Unresolved needs_review / conflict items from one-click Enrich jobs.
 * Confirm = the reviewer asserts that the profile shown IS this person →
 * confirmEnrich applies exactly that stored candidate and resolves the item
 * (audit P8: it used to look the person up again and apply whatever came back,
 * unseen). Skip just resolves it. Renders nothing when the worklist is empty.
 */
function ReviewPanel() {
  const utils = trpc.useUtils();
  const itemsQ = trpc.linkedinEnrichment.listReviewItems.useQuery(undefined);
  const confirm = trpc.linkedinEnrichment.confirmEnrich.useMutation();
  const resolve = trpc.linkedinEnrichment.resolveJobItem.useMutation({
    onSuccess: () => utils.linkedinEnrichment.listReviewItems.invalidate(),
  });
  const [busyId, setBusyId] = useState<number | null>(null);

  const items = itemsQ.data ?? [];
  if (items.length === 0) return null;

  const onConfirm = async (item: (typeof items)[number]) => {
    setBusyId(item.id);
    try {
      const r = await confirm.mutateAsync({ itemId: item.id });
      toast.success(`Applied — ${r.changes.length} change${r.changes.length === 1 ? "" : "s"} detected`);
      utils.linkedinEnrichment.listReviewItems.invalidate();
      utils.linkedinEnrichment.getChangeSummaries.invalidate();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not apply enrichment");
    } finally {
      setBusyId(null);
    }
  };
  const onSkip = async (item: (typeof items)[number]) => {
    setBusyId(item.id);
    try {
      await resolve.mutateAsync({ itemId: item.id, resolution: "skipped" });
      toast.info("Skipped");
    } catch (e: any) {
      // A failed skip said nothing and the item simply stayed (audit
      // 2026-10-20, P155).
      toast.error(e?.message ?? "Could not skip this item");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="text-[13px] font-semibold inline-flex items-center gap-1.5">
          <AlertTriangle className="size-3.5 text-amber-500" /> Needs review
          <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
        </div>
        <span className="text-[11px] text-muted-foreground">Uncertain or conflicting matches from Enrich runs</span>
      </div>
      <div className="max-h-72 overflow-y-auto divide-y">
        {items.map((it) => (
          <div key={it.id} className="px-4 py-2 text-[12px]">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{it.prospectName}</span>
              {it.prospectCompany && <span className="text-muted-foreground truncate">· {it.prospectCompany}</span>}
              <span className="flex-1" />
              {it.matchScore != null && <span className="text-muted-foreground tabular-nums">score {it.matchScore}</span>}
              <Badge variant={it.status === "conflict" ? "destructive" : "secondary"} className="text-[10px]">
                {it.status === "conflict" ? "Conflict" : "Needs review"}
              </Badge>
            </div>
            {it.candidate ? (
              <div className="mt-1 rounded border bg-muted/30 px-2 py-1">
                <div className="text-muted-foreground">Found on LinkedIn:</div>
                <div className="font-medium">{it.candidate.fullName ?? "Unnamed profile"}</div>
                {(it.candidate.headline || it.candidate.currentTitle) && (
                  <div className="text-muted-foreground truncate">{it.candidate.headline ?? it.candidate.currentTitle}{it.candidate.currentCompanyName ? ` · ${it.candidate.currentCompanyName}` : ""}</div>
                )}
                {it.candidate.location && <div className="text-muted-foreground truncate">{it.candidate.location}</div>}
                {it.candidate.profileUrl && (
                  <a href={it.candidate.profileUrl} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline truncate block">{it.candidate.profileUrl}</a>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground">No candidate was kept for this item. Run Enrich again for this person to review a match.</div>
            )}
            {it.errorMessage && <div className="text-muted-foreground truncate">{it.errorMessage}</div>}
            <div className="mt-1.5 flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-6 gap-1" disabled={busyId != null || !it.candidate} onClick={() => onConfirm(it)}>
                {busyId === it.id ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />} Confirm & apply
              </Button>
              <Button size="sm" variant="ghost" className="h-6" disabled={busyId != null} onClick={() => onSkip(it)}>Skip</Button>
              <a
                href={`/prospects/${it.prospectId}`}
                className="text-[11px] text-sky-600 hover:underline ml-auto"
              >
                Open prospect
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── page ─────────────────────────────────── */

export default function LinkedInEnrichmentImport() {
  const [, setLocation] = useLocation();
  // The workspace role (audit P153): this read users.role, the PLATFORM role,
  // so workspace admins never saw "Run now" and the platform owner always did.
  const { current } = useWorkspace();
  const rank = rankOf(current?.role ?? "rep");
  const isAdmin = rank >= ROLE_RANK.admin;
  const isManager = rank >= ROLE_RANK.manager;
  const utils = trpc.useUtils();

  const [paste, setPaste] = useState("");
  const [pasted, setPasted] = useState<ParsedRow[]>([]);
  const [file, setFile] = useState<ParsedFile | null>(null);
  // A batch takes MAX_BATCH_ROWS; a longer file is imported a slice at a time.
  const [chunk, setChunk] = useState(0);
  const [batchId, setBatchIdState] = useState<number | null>(batchFromUrl);
  const setBatchId = (id: number | null) => { setBatchIdState(id); writeBatchToUrl(id); };
  const fileRef = useRef<HTMLInputElement>(null);

  const allRows = useMemo(
    () => (file ? rowsFromMapping(file.records, file.headerRow, file.mapping) : pasted),
    [file, pasted],
  );
  const chunks = Math.max(1, Math.ceil(allRows.length / MAX_BATCH_ROWS));
  const rows = allRows.slice(chunk * MAX_BATCH_ROWS, (chunk + 1) * MAX_BATCH_ROWS);
  // The mapping step's preview (audit 2026-10-20, U31): what each column
  // holds, and the first rows as the chosen mapping reads them, before import.
  const samples = useMemo(() => (file ? columnSamples(file.records, file.headerRow) : []), [file]);
  const preview = useMemo(() => (file ? mappingPreview(file.records, file.headerRow, file.mapping) : null), [file]);
  const fieldLabel = (k: LinkedInImportField) => LINKEDIN_IMPORT_FIELDS.find((f) => f.key === k)?.label ?? k;

  const createMut = trpc.linkedinEnrichment.createBatch.useMutation({
    onSuccess: (s) => { setBatchId(s.batchId); toast.success(`Batch created — ${s.validRows}/${s.totalRows} valid`); },
    onError: (e) => toast.error(e.message),
  });
  const runMut = trpc.linkedinEnrichment.runBatch.useMutation({
    onSuccess: (s) => {
      toast.success(`Queued ${s.pending} lookup${s.pending === 1 ? "" : "s"}. ${s.lookupsLeftToday} left today; they run at the pace the LinkedIn limits allow, and the rest continue tomorrow.`);
      utils.linkedinEnrichment.listBatchRows.invalidate({ batchId: s.batchId });
      utils.linkedinEnrichment.getBatch.invalidate({ batchId: s.batchId });
    },
    onError: (e) => toast.error(e.message),
  });
  const retryMut = trpc.linkedinEnrichment.retryFailedRows.useMutation({
    onSuccess: (r) => {
      toast.success(r.retried ? `Queued ${r.retried} failed row${r.retried === 1 ? "" : "s"} again.` : "No failed rows to retry.");
      if (batchId) { utils.linkedinEnrichment.listBatchRows.invalidate({ batchId }); utils.linkedinEnrichment.getBatch.invalidate({ batchId }); }
    },
    onError: (e) => toast.error(e.message),
  });
  const reviewMut = trpc.linkedinEnrichment.reviewBatch.useMutation({
    onSuccess: () => { if (batchId) utils.linkedinEnrichment.listBatchRows.invalidate({ batchId }); toast.success("Review applied"); },
    onError: (e) => toast.error(e.message),
  });

  // A queued batch runs in the background: poll while it does.
  const live = (s?: string) => s === "queued" || s === "running" || s === "waiting";
  const batchQ = trpc.linkedinEnrichment.getBatch.useQuery({ batchId: batchId! }, {
    enabled: !!batchId,
    refetchInterval: (q) => (live((q.state.data as any)?.status) ? 5000 : false),
  });
  const batchLive = live(batchQ.data?.status);
  const rowsQ = trpc.linkedinEnrichment.listBatchRows.useQuery({ batchId: batchId! }, { enabled: !!batchId, refetchInterval: batchLive ? 5000 : false });
  const batchRows = (rowsQ.data ?? []) as any[];

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const records = parseCsvRecords(String(reader.result ?? ""));
      const headerRow = findHeaderRow(records);
      setFile({ name: f.name, records, headerRow, mapping: guessMapping(records, headerRow) });
      setPasted([]);
      setChunk(0);
      toast.success(`Read ${f.name}: check the columns below`);
    };
    reader.readAsText(f);
  };
  const onParsePaste = () => { setFile(null); setChunk(0); setPasted(parsePaste(paste)); };
  const setMapping = (field: LinkedInImportField, col: number | undefined) =>
    setFile((cur) => (cur ? { ...cur, mapping: { ...cur.mapping, [field]: col } } : cur));

  // A new batch keeps a long file's rows, so its next slice can follow.
  const reset = () => {
    setBatchId(null);
    if (file && chunk + 1 < chunks) setChunk(chunk + 1);
    else { setFile(null); setPasted([]); setPaste(""); setChunk(0); }
  };

  const counts = useMemo(() => {
    const c = { enriched: 0, needs_review: 0, no_match: 0, failed: 0, skipped: 0, pending: 0 };
    for (const r of batchRows) c[r.rowStatus as keyof typeof c] = (c[r.rowStatus as keyof typeof c] ?? 0) + 1;
    return c;
  }, [batchRows]);

  return (
    <Shell title="LinkedIn enrichment">
      <div className="max-w-4xl mx-auto w-full p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 -ml-2" onClick={() => setLocation("/v2/data-enrichment")}>
            <ChevronLeft className="size-4" /> Data enrichment
          </Button>
        </div>
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight inline-flex items-center gap-2">
            <Link2 className="size-4 text-sky-600" /> LinkedIn enrichment import
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Paste or upload LinkedIn profile URLs. Velocity retrieves permitted data through Unipile, matches each to a
            prospect, and checks daily for changes. No scraping — vendor API only.
          </p>
        </div>

        <HealthBanner onConnect={() => setLocation("/connected-accounts")} />
        <DailyCheckCard isAdmin={isAdmin} />
        <ReviewPanel />

        {/* ── input ── */}
        {!batchId && (
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="text-[13px] font-semibold">Add LinkedIn URLs</div>
            <Textarea aria-label="LinkedIn URLs, one per line"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={"One LinkedIn profile URL per line\nhttps://www.linkedin.com/in/jane-smith\nhttps://www.linkedin.com/in/john-doe, John Doe, Acme"}
              className="min-h-[120px] font-mono text-[12px]"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={onParsePaste} disabled={!paste.trim()}>
                Parse pasted URLs
              </Button>
              <span className="text-muted-foreground text-[12px]">or</span>
              <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => fileRef.current?.click()}>
                <FileUp className="size-3.5" /> Upload CSV
              </Button>
              <span className="text-muted-foreground text-[11px]">You choose which column holds what, next.</span>
            </div>

            {/* The mapping step: the guess, which the person can change. */}
            {file && (
              <div className="border-t pt-3 space-y-2">
                <div className="text-[13px] font-medium">
                  Columns in {file.name}
                  {file.headerRow === null
                    ? <span className="font-normal text-muted-foreground"> · no header row found, so every row is read as data</span>
                    : file.headerRow > 0
                      ? <span className="font-normal text-muted-foreground"> · header on row {file.headerRow + 1}; the lines above it are skipped</span>
                      : null}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {LINKEDIN_IMPORT_FIELDS.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 text-[12px]">
                      <span className="w-40 shrink-0 text-muted-foreground">{f.label}{f.required ? " *" : ""}</span>
                      <select
                        className="flex-1 min-w-0 h-7 rounded border bg-background px-1.5 text-[12px]"
                        value={file.mapping[f.key] ?? ""}
                        onChange={(e) => setMapping(f.key, e.target.value === "" ? undefined : Number(e.target.value))}
                      >
                        <option value="">— not in this file —</option>
                        {columnNames(file.records, file.headerRow).map((c, i) => (
                          <option key={i} value={i}>{c}{samples[i]?.length ? ` — e.g. ${samples[i].join(", ")}` : " — empty"}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                {file.mapping.linkedinUrl === undefined && (
                  <p className="text-[12px] text-amber-700">Choose the column that holds the LinkedIn profile URLs.</p>
                )}
                {preview && preview.fields.length > 0 && (
                  <div className="space-y-1" data-testid="linkedin-mapping-preview">
                    <div className="text-[12px] font-medium">Preview: the first rows as these columns read them</div>
                    <div className="overflow-x-auto rounded border">
                      <table className="w-full text-[11.5px]">
                        <thead className="bg-muted/50 text-left">
                          <tr>
                            <th className="px-2 py-1 font-medium">Line</th>
                            {preview.fields.map((k) => <th key={k} className="px-2 py-1 font-medium whitespace-nowrap">{fieldLabel(k)}</th>)}
                            <th className="px-2 py-1 font-medium">Import</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.rows.map((r) => (
                            <tr key={r.line} className={cn("border-t", r.status !== "ok" && "bg-amber-50/60 dark:bg-amber-950/20")}>
                              <td className="px-2 py-1 tabular-nums text-muted-foreground">{r.line}</td>
                              {preview.fields.map((k) => (
                                <td key={k} className="px-2 py-1 max-w-[180px] truncate" title={r.values[k] ?? ""}>{r.values[k] || <span className="text-muted-foreground">—</span>}</td>
                              ))}
                              <td className="px-2 py-1 whitespace-nowrap">
                                {r.status === "ok" ? "Yes" : r.status === "no_url" ? <span className="text-amber-700">No URL, left out</span> : <span className="text-amber-700">Not a profile URL</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {(preview.noUrl > 0 || preview.notProfile > 0) && (
                      <p className="text-[11.5px] text-amber-700">
                        {preview.noUrl > 0 ? `${preview.noUrl.toLocaleString()} row${preview.noUrl === 1 ? " has" : "s have"} no URL in this column and will be left out. ` : ""}
                        {preview.notProfile > 0 ? `${preview.notProfile.toLocaleString()} ${preview.notProfile === 1 ? "is" : "are"} not a LinkedIn profile URL and will be marked invalid. ` : ""}
                        If that is a lot, check the URL column above.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {rows.length > 0 && (
              <div className="border-t pt-3 space-y-2">
                {allRows.length > MAX_BATCH_ROWS && (
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>This file has {allRows.length.toLocaleString()} rows and a batch takes {MAX_BATCH_ROWS.toLocaleString()}. Import it a slice at a time:</span>
                    <select
                      aria-label="Rows to import in this batch"
                      className="h-7 rounded border bg-background px-1.5 text-[12px]"
                      value={chunk}
                      onChange={(e) => setChunk(Number(e.target.value))}
                    >
                      {Array.from({ length: chunks }, (_, i) => (
                        <option key={i} value={i}>
                          Rows {(i * MAX_BATCH_ROWS + 1).toLocaleString()}–{Math.min((i + 1) * MAX_BATCH_ROWS, allRows.length).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="font-medium">{rows.length} row(s) to import</span>
                  <div className="flex items-center gap-2">
                    {/* createBatch is a manager's; say so rather than fail on click (P96). */}
                    {!isManager && <span className="text-[11px] text-muted-foreground">A manager imports and runs these batches.</span>}
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={createMut.isPending || !isManager}
                      onClick={() => createMut.mutate({ sourceType: file ? "csv_upload" : "pasted_urls", rows })}
                    >
                      {createMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Validate & import
                    </Button>
                  </div>
                </div>
                <div className="max-h-44 overflow-y-auto rounded border divide-y text-[12px]">
                  {rows.slice(0, 100).map((r, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1">
                      <span className="text-muted-foreground tabular-nums w-6 shrink-0">{i + 1}</span>
                      <span className="truncate flex-1">{r.linkedinUrl}</span>
                      {r.fullName && <span className="text-muted-foreground truncate max-w-[120px]">{r.fullName}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── batch created: preview + run ── */}
        {batchId && (
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <div className="text-[13px] font-semibold inline-flex items-center gap-2">
                Batch #{batchId}
                {batchQ.data && (
                  <span className="text-[12px] font-normal text-muted-foreground">
                    {batchQ.data.validRows}/{batchQ.data.totalRows} valid · {batchQ.data.invalidRows} invalid
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {!isManager && <span className="text-[11px] text-muted-foreground">A manager runs enrichment.</span>}
                <Button variant="ghost" size="sm" className="h-7" onClick={reset}>
                  {file && chunk + 1 < chunks ? "Next slice of the file" : "New batch"}
                </Button>
                {isManager && batchQ.data?.status === "completed" && counts.failed > 0 && (
                  <Button variant="outline" size="sm" className="h-7" disabled={retryMut.isPending} onClick={() => retryMut.mutate({ batchId })}>
                    Retry {counts.failed} failed
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-7 gap-1.5"
                  disabled={!isManager || runMut.isPending || batchLive || (batchQ.data?.status === "completed")}
                  onClick={() => runMut.mutate({ batchId })}
                >
                  {runMut.isPending || batchLive ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
                  {batchQ.data?.status === "completed" ? "Completed" : batchLive ? "Running" : "Run enrichment"}
                </Button>
              </div>
            </div>

            {batchLive && (
              <div className="px-4 py-2 border-b text-[12px] text-muted-foreground">
                {batchQ.data?.status === "waiting" && batchQ.data?.holdReason
                  ? `Waiting for the LinkedIn limits (${batchQ.data.holdReason}). ${counts.pending} left; it continues automatically.`
                  : `Looking up profiles at the pace the LinkedIn limits allow: ${counts.pending} left.`}
              </div>
            )}

            {/* result counts */}
            {batchQ.data?.status === "completed" && (
              <div className="flex flex-wrap gap-2 px-4 py-2.5 border-b text-[12px]">
                <Stat label="Enriched" value={counts.enriched} tone="good" />
                <Stat label="Needs review" value={counts.needs_review} tone="warn" />
                <Stat label="No match" value={counts.no_match} />
                <Stat label="Failed" value={counts.failed} tone="bad" />
                <Stat label="Skipped" value={counts.skipped} />
              </div>
            )}

            {/* rows */}
            <div className="max-h-[420px] overflow-y-auto divide-y">
              {batchRows.map((r) => (
                <BatchRow key={r.id} row={r} onReview={(action, prospectId) => reviewMut.mutate({ batchId, decisions: [{ rowId: r.id, action, prospectId }] })} reviewing={reviewMut.isPending} />
              ))}
              {batchRows.length === 0 && (
                // A batch reopened from the URL may be gone or another workspace's.
                batchQ.error || rowsQ.error
                  ? <div className="p-4 text-center text-[13px] text-muted-foreground">Batch #{batchId} could not be loaded: {(batchQ.error ?? rowsQ.error)?.message}</div>
                  : <div className="p-4 text-center text-[13px] text-muted-foreground">Loading rows…</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" | "bad" }) {
  const c = tone === "good" ? "text-emerald-700 dark:text-emerald-400"
    : tone === "warn" ? "text-amber-700 dark:text-amber-400"
      : tone === "bad" ? "text-rose-700 dark:text-rose-400" : "text-foreground";
  return <span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5"><span className={cn("font-semibold tabular-nums", c)}>{value}</span> {label}</span>;
}

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  enriched: { label: "Enriched", variant: "default" },
  needs_review: { label: "Needs review", variant: "secondary" },
  no_match: { label: "No match", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Skipped", variant: "outline" },
  pending: { label: "Pending", variant: "outline" },
};

function BatchRow({ row, onReview, reviewing }: { row: any; onReview: (action: any, prospectId?: number) => void; reviewing: boolean }) {
  const sb = STATUS_BADGE[row.rowStatus] ?? STATUS_BADGE.pending;
  const reasons: string[] = row.matchReasons?.reasons ?? [];
  const profile = row.matchReasons?.profile;
  const name = profile?.fullName ?? row.providedFullName ?? row.normalizedUrl ?? row.originalUrl;
  const needsReview = row.rowStatus === "needs_review";
  return (
    <div className="px-4 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="truncate flex-1 font-medium">{name}</span>
        {row.matchScore != null && <span className="text-muted-foreground tabular-nums">score {row.matchScore}</span>}
        <Badge variant={sb.variant} className="text-[10px]">{sb.label}</Badge>
      </div>
      <div className="text-muted-foreground truncate">{row.normalizedUrl ?? row.originalUrl}{row.validationError ? ` · ${row.validationError}` : ""}{row.errorMessage ? ` · ${row.errorMessage}` : ""}</div>
      {reasons.length > 0 && <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{reasons.join(" · ")}</div>}
      {needsReview && (
        <div className="mt-1.5 flex items-center gap-2">
          {row.matchedProspectId && (
            <Button size="sm" variant="outline" className="h-6 gap-1" disabled={reviewing} onClick={() => onReview("match_existing", row.matchedProspectId)}>
              <CheckCircle2 className="size-3" /> Match #{row.matchedProspectId}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-6 gap-1" disabled={reviewing} onClick={() => onReview("create_new")}>
            <Users className="size-3" /> Create new
          </Button>
          <Button size="sm" variant="ghost" className="h-6" disabled={reviewing} onClick={() => onReview("skip")}>Skip</Button>
        </div>
      )}
    </div>
  );
}
