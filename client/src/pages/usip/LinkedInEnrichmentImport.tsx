/**
 * LinkedIn Enrichment Import (/v2/data-enrichment/linkedin).
 *
 * The batch-import workflow over the compliant Unipile enrichment backend:
 *   1. Integration-health banner gates the page (connect a LinkedIn account).
 *   2. Paste URLs or upload a CSV → parsed to rows (client-side).
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
import { useAuth } from "@/_core/hooks/useAuth";
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

type ParsedRow = {
  linkedinUrl: string;
  fullName?: string; firstName?: string; lastName?: string;
  company?: string; title?: string; email?: string; prospectId?: number;
};

/* ───────────────────────── CSV / paste parsing ────────────────────────── */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const COL_ALIASES: Record<keyof ParsedRow, string[]> = {
  linkedinUrl: ["linkedin_url", "linkedinurl", "linkedin", "url", "profile_url", "profile"],
  fullName: ["full_name", "fullname", "name"],
  firstName: ["first_name", "firstname", "first"],
  lastName: ["last_name", "lastname", "last"],
  company: ["company", "account_name", "organization"],
  title: ["title", "job_title", "headline"],
  email: ["email", "email_address"],
  prospectId: ["prospect_id", "prospectid", "id"],
};

function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const idxOf = (key: keyof ParsedRow) => header.findIndex((h) => COL_ALIASES[key].includes(h));
  const map: Partial<Record<keyof ParsedRow, number>> = {};
  (Object.keys(COL_ALIASES) as (keyof ParsedRow)[]).forEach((k) => { const i = idxOf(k); if (i >= 0) map[k] = i; });
  // No recognizable header → treat every line as a bare URL.
  if (map.linkedinUrl === undefined) return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((u) => ({ linkedinUrl: splitCsvLine(u)[0] }));
  const out: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const get = (k: keyof ParsedRow) => (map[k] !== undefined ? cells[map[k]!] : undefined);
    const url = get("linkedinUrl");
    if (!url) continue;
    const pid = get("prospectId");
    out.push({
      linkedinUrl: url,
      fullName: get("fullName") || undefined,
      firstName: get("firstName") || undefined,
      lastName: get("lastName") || undefined,
      company: get("company") || undefined,
      title: get("title") || undefined,
      email: get("email") || undefined,
      prospectId: pid && /^\d+$/.test(pid) ? Number(pid) : undefined,
    });
  }
  return out;
}

function parsePaste(text: string): ParsedRow[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const cells = splitCsvLine(line);
    return { linkedinUrl: cells[0], fullName: cells[1] || undefined, company: cells[2] || undefined };
  });
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
  const { data: job } = trpc.linkedinEnrichment.dailyCheckStatus.useQuery();
  const run = trpc.linkedinEnrichment.dailyCheckRun.useMutation({
    onSuccess: (r) => { toast.success(`Daily check: ${r.checked} checked, ${r.changed} changed`); utils.linkedinEnrichment.dailyCheckStatus.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold inline-flex items-center gap-1.5"><Clock className="size-3.5 text-muted-foreground" /> Daily change check</div>
        {isAdmin && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={run.isPending} onClick={() => run.mutate({ force: true })}>
            {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Run now
          </Button>
        )}
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {job
          ? `Last run ${new Date(job.completedAt ?? job.createdAt).toLocaleString()} — ${job.checkedCount} checked, ${job.changedCount} changed, ${job.failedCount} failed.`
          : "No daily check has run yet. Enriched prospects are checked automatically once a day."}
      </p>
    </div>
  );
}

/* ─────────────────────────────── page ─────────────────────────────────── */

export default function LinkedInEnrichmentImport() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isAdmin = ["admin", "super_admin"].includes((user as any)?.role ?? "");
  const utils = trpc.useUtils();

  const [paste, setPaste] = useState("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const createMut = trpc.linkedinEnrichment.createBatch.useMutation({
    onSuccess: (s) => { setBatchId(s.batchId); toast.success(`Batch created — ${s.validRows}/${s.totalRows} valid`); },
    onError: (e) => toast.error(e.message),
  });
  const runMut = trpc.linkedinEnrichment.runBatch.useMutation({
    onSuccess: (s) => {
      toast.success(`Enriched ${s.matchedRows}, ${s.needsReviewRows} to review, ${s.failedRows} failed`);
      utils.linkedinEnrichment.listBatchRows.invalidate({ batchId: s.batchId });
      utils.linkedinEnrichment.getBatch.invalidate({ batchId: s.batchId });
    },
    onError: (e) => toast.error(e.message),
  });
  const reviewMut = trpc.linkedinEnrichment.reviewBatch.useMutation({
    onSuccess: () => { if (batchId) utils.linkedinEnrichment.listBatchRows.invalidate({ batchId }); toast.success("Review applied"); },
    onError: (e) => toast.error(e.message),
  });

  const batchQ = trpc.linkedinEnrichment.getBatch.useQuery({ batchId: batchId! }, { enabled: !!batchId });
  const rowsQ = trpc.linkedinEnrichment.listBatchRows.useQuery({ batchId: batchId! }, { enabled: !!batchId });
  const batchRows = (rowsQ.data ?? []) as any[];

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => { setRows(parseCsv(String(reader.result ?? ""))); toast.success(`Parsed ${f.name}`); };
    reader.readAsText(f);
  };
  const onParsePaste = () => setRows(parsePaste(paste));

  const reset = () => { setBatchId(null); setRows([]); setPaste(""); };

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

        {/* ── input ── */}
        {!batchId && (
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="text-[13px] font-semibold">Add LinkedIn URLs</div>
            <Textarea
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
              <span className="text-muted-foreground text-[11px]">columns: linkedin_url, full_name, company, title, email, prospect_id…</span>
            </div>

            {rows.length > 0 && (
              <div className="border-t pt-3 space-y-2">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="font-medium">{rows.length} row(s) parsed</span>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={createMut.isPending}
                    onClick={() => createMut.mutate({ sourceType: paste.trim() ? "pasted_urls" : "csv_upload", rows })}
                  >
                    {createMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Validate & import
                  </Button>
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
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="h-7" onClick={reset}>New batch</Button>
                <Button
                  size="sm"
                  className="h-7 gap-1.5"
                  disabled={runMut.isPending || (batchQ.data?.status === "completed")}
                  onClick={() => runMut.mutate({ batchId })}
                >
                  {runMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
                  {batchQ.data?.status === "completed" ? "Completed" : "Run enrichment"}
                </Button>
              </div>
            </div>

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
              {batchRows.length === 0 && <div className="p-4 text-center text-[13px] text-muted-foreground">Loading rows…</div>}
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
