/**
 * AddExistingProspectsDialog — the "Add existing" WIZARD on a Revenue Engine
 * campaign (owner ask 2026-09-03: bulk select, a table view, duplicate
 * verification, and whether and where each person already sits in other
 * campaigns and sequences).
 *
 * Three steps:
 *   1 Select  — People in a table: search, filters, pagination, select-all on
 *               the page, the selection kept across pages and searches; or
 *               every person on a saved List in one click.
 *   2 Verify  — the server REHEARSES the push (are.prospects.pushExistingPreview)
 *               and the table shows, per person, the verdict the push would
 *               give, every campaign + sequence they are in (active or past),
 *               duplicates inside the selection, and other People records for
 *               the same human. Only "ready" rows can stay ticked.
 *   3 Add     — options and the count, then the push itself
 *               (are.prospects.pushExisting, in batches of 100) and the result
 *               with every skip reason.
 *
 * The verdicts are not computed here. The preview calls the same classifier
 * the write path uses, so what step 2 promises is what step 3 does.
 *
 * History: the first version (owner ask 2026-08-14) was a checklist over the
 * first 50 search hits, and the only warning came AFTER the push as a skip
 * reason. Each pushed person is still queued, enriched, and then has their
 * sequence generated, in that order, server-side.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { emailStatusBadge } from "@/components/usip/people/peopleShared";
import { EnrollmentChip, type EnrollmentMap } from "@/components/usip/AddToMenu";
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ChevronLeft, ChevronRight, Copy, ExternalLink,
  ListChecks, Loader2, Search, UserPlus, Users, XCircle,
} from "lucide-react";

const PAGE_SIZE = 50;
/** The preview procedure's cap — one verify pass, one table. */
const MAX_SELECTION = 200;
/** pushExisting accepts 100 ids per call; bigger runs go in batches. */
const PUSH_BATCH = 100;

type Step = 1 | 2 | 3;
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 1, label: "Select" },
  { id: 2, label: "Verify" },
  { id: 3, label: "Add" },
];

type PersonRow = Record<string, any>;
type PreviewVerdict = "ready" | "already_here" | "other_campaign" | "active_sequence" | "duplicate" | "unidentifiable";
interface PreviewRow {
  prospectId: number;
  name: string;
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  verdict: PreviewVerdict;
  reason: string | null;
  claim: { campaignId: number | null; campaignName: string | null } | null;
  duplicateOf: { prospectId: number; name: string } | null;
  crmDuplicates: Array<{ prospectId: number; name: string; email: string | null; via: "email" | "linkedin" }>;
  campaigns: Array<{ campaignId: number; campaignName: string; sequenceStatus: string; active: boolean; isThisCampaign: boolean }>;
  sequences: Array<{ sequenceId: number; sequenceName: string; status: string; currentStep: number; active: boolean }>;
}

const VERDICT_META: Record<PreviewVerdict, { label: string; className: string; order: number }> = {
  other_campaign: { label: "In another campaign", className: "border-red-300/60 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300", order: 0 },
  active_sequence: { label: "In a sequence", className: "border-red-300/60 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300", order: 1 },
  already_here: { label: "Already here", className: "border-amber-300/60 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200", order: 2 },
  duplicate: { label: "Duplicate", className: "border-amber-300/60 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200", order: 3 },
  unidentifiable: { label: "Unidentifiable", className: "border-border bg-muted text-muted-foreground", order: 4 },
  ready: { label: "Ready", className: "border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300", order: 5 },
};

const nameOf = (p: PersonRow) =>
  [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email || `Prospect ${p.id}`;

export function AddExistingProspectsDialog({
  open,
  onOpenChange,
  campaignId,
  campaignName,
  onPushed,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: number;
  campaignName?: string;
  onPushed?: () => void;
}) {
  const [step, setStep] = useState<Step>(1);

  // ── Step 1 state ──
  const [source, setSource] = useState<"search" | "list">("search");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [emailFilter, setEmailFilter] = useState<"any" | "yes" | "no">("any");
  const [hideSequenced, setHideSequenced] = useState(false);
  const [listId, setListId] = useState<number | null>(null);
  /** The selection: id → the row as last seen, kept across pages and searches. */
  const [selected, setSelected] = useState<Map<number, PersonRow>>(new Map());

  // ── Step 2 state ──
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [verdictFilter, setVerdictFilter] = useState<"all" | PreviewVerdict>("all");

  // ── Step 3 state ──
  const [generate, setGenerate] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ added: Array<{ prospectId: number; queueId: number }>; skipped: Array<{ prospectId: number; reason: string }> } | null>(null);

  const reset = () => {
    setStep(1); setSource("search"); setSearchInput(""); setSearch(""); setPage(1);
    setEmailFilter("any"); setHideSequenced(false); setListId(null); setSelected(new Map());
    setExcluded(new Set()); setVerdictFilter("all"); setGenerate(true); setSubmitting(false); setResult(null);
  };
  useEffect(() => { if (open) reset(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search — the list is a server query, not a page-local filter.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => { setPage(1); }, [emailFilter, hideSequenced]);

  const list = trpc.prospects.list.useQuery(
    {
      page, perPage: PAGE_SIZE,
      search: search || undefined,
      hasEmail: emailFilter === "yes" ? true : emailFilter === "no" ? false : undefined,
      enrolled: hideSequenced ? "no" : undefined,
    },
    { enabled: open && step === 1 && source === "search" },
  );
  const lists = trpc.recordLists.list.useQuery(undefined, { enabled: open && step === 1 && source === "list" });
  const listMembers = trpc.recordLists.members.useQuery(
    { id: listId ?? 0 },
    { enabled: open && step === 1 && source === "list" && listId != null },
  );

  const pageRows: PersonRow[] = useMemo(() => {
    if (source === "search") return ((list.data as any)?.data ?? []) as PersonRow[];
    return ((listMembers.data ?? []) as any[])
      .filter((m) => m.recordType === "prospect" && m.record)
      .map((m) => m.record as PersonRow);
  }, [source, list.data, listMembers.data]);
  const pageIds = useMemo(() => pageRows.map((r) => r.id as number), [pageRows]);
  const total: number = source === "search" ? Number((list.data as any)?.total ?? 0) : pageRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rowsLoading = source === "search" ? list.isLoading : listId != null && listMembers.isLoading;

  // "In: …" chips for the rows on screen — where each person is right now.
  const enrollmentsQ = trpc.prospects.enrollmentsFor.useQuery(
    { ids: pageIds.slice(0, 200) },
    { enabled: open && step === 1 && pageIds.length > 0 },
  );
  const enrollmentMap = enrollmentsQ.data as EnrollmentMap | undefined;

  const toggle = (row: PersonRow) =>
    setSelected((prev) => {
      const n = new Map(prev);
      if (n.has(row.id)) n.delete(row.id);
      else if (n.size >= MAX_SELECTION) { toast.error(`Up to ${MAX_SELECTION} people per run`); return prev; }
      else n.set(row.id, row);
      return n;
    });
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleAllOnPage = () =>
    setSelected((prev) => {
      const n = new Map(prev);
      if (allOnPageSelected) { for (const id of pageIds) n.delete(id); return n; }
      let capped = false;
      for (const r of pageRows) {
        if (n.has(r.id)) continue;
        if (n.size >= MAX_SELECTION) { capped = true; break; }
        n.set(r.id, r);
      }
      if (capped) toast.info(`Selection capped at ${MAX_SELECTION} per run — add the rest in a second pass`);
      return n;
    });

  // ── Step 2: the rehearsal ──
  const selectedIds = useMemo(() => Array.from(selected.keys()), [selected]);
  const preview = trpc.are.prospects.pushExistingPreview.useQuery(
    { campaignId, prospectIds: selectedIds },
    { enabled: open && step >= 2 && selectedIds.length > 0, retry: false, staleTime: 0 },
  );
  const previewRows = (preview.data?.rows ?? []) as PreviewRow[];
  const counts = preview.data?.counts as Record<PreviewVerdict, number> | undefined;
  const readyRows = useMemo(() => previewRows.filter((r) => r.verdict === "ready"), [previewRows]);
  const toAdd = useMemo(() => readyRows.filter((r) => !excluded.has(r.prospectId)), [readyRows, excluded]);
  const previewById = useMemo(() => new Map(previewRows.map((r) => [r.prospectId, r])), [previewRows]);
  const shownRows = useMemo(() => {
    const rows = verdictFilter === "all" ? previewRows : previewRows.filter((r) => r.verdict === verdictFilter);
    return rows.slice().sort((a, b) => VERDICT_META[a.verdict].order - VERDICT_META[b.verdict].order);
  }, [previewRows, verdictFilter]);
  const blocked = previewRows.length - readyRows.length;
  const toggleExcluded = (id: number) =>
    setExcluded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ── Step 3: the push ──
  // Errors are handled at the mutateAsync call (try/catch → toast); per-person
  // refusals come back in the RESULT (skipped[]) and render inline.
  const push = trpc.are.prospects.pushExisting.useMutation();
  const submit = async () => {
    const ids = toAdd.map((r) => r.prospectId);
    if (ids.length === 0) { toast.error("Nothing to add"); return; }
    setSubmitting(true);
    const added: Array<{ prospectId: number; queueId: number }> = [];
    const skipped: Array<{ prospectId: number; reason: string }> = [];
    try {
      for (let i = 0; i < ids.length; i += PUSH_BATCH) {
        const r = await push.mutateAsync({ campaignId, prospectIds: ids.slice(i, i + PUSH_BATCH), generateSequence: generate });
        added.push(...r.added);
        skipped.push(...r.skipped);
      }
      setResult({ added, skipped });
      if (added.length > 0) {
        toast.success(
          `${added.length} ${added.length === 1 ? "person" : "people"} added to ${campaignName ? `"${campaignName}"` : "the campaign"}` +
          (generate ? " — enriching, then generating sequences" : " — enriching"),
        );
        onPushed?.();
      } else {
        toast.error("No one was added — see the reasons below");
      }
    } catch (e) {
      toast.error((e as Error).message || "Could not add those prospects");
      // A later batch failed after earlier ones landed: show what did happen.
      if (added.length > 0) { setResult({ added, skipped }); onPushed?.(); }
    } finally {
      setSubmitting(false);
    }
  };

  const goVerify = () => {
    if (selected.size === 0) { toast.error("Pick at least one person"); return; }
    setExcluded(new Set()); setVerdictFilter("all"); setStep(2);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-* (not bare max-w-*): DialogContent's default ends with sm:max-w-lg. */}
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-5xl max-h-[88vh] flex flex-col p-0 gap-0">
        <div className="px-6 pt-6 pb-3 border-b border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="size-4" /> Add existing people{campaignName ? ` to "${campaignName}"` : ""}
            </DialogTitle>
            <DialogDescription>
              Pick people already in your CRM, verify duplicates and where they already are, then add them.
              Each one is enriched and then has a sequence generated.
            </DialogDescription>
          </DialogHeader>
          <StepIndicator current={result ? 4 : step} />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {step === 1 && (
            <SelectStep
              source={source} setSource={(s) => { setSource(s); setListId(null); }}
              searchInput={searchInput} setSearchInput={setSearchInput}
              emailFilter={emailFilter} setEmailFilter={setEmailFilter}
              hideSequenced={hideSequenced} setHideSequenced={setHideSequenced}
              lists={(lists.data ?? []) as any[]} listsLoading={lists.isLoading} listId={listId} setListId={setListId}
              rows={pageRows} loading={rowsLoading} total={total} page={page} totalPages={totalPages} setPage={setPage}
              selected={selected} toggle={toggle} allOnPageSelected={allOnPageSelected} toggleAllOnPage={toggleAllOnPage}
              clearSelection={() => setSelected(new Map())} enrollmentMap={enrollmentMap}
            />
          )}

          {step === 2 && (
            <VerifyStep
              loading={preview.isLoading} error={preview.error?.message ?? null} retry={() => preview.refetch()}
              rows={shownRows} allRows={previewRows} counts={counts} verdictFilter={verdictFilter} setVerdictFilter={setVerdictFilter}
              excluded={excluded} toggleExcluded={toggleExcluded} readyCount={readyRows.length} toAddCount={toAdd.length} blocked={blocked}
              campaignId={campaignId}
            />
          )}

          {step === 3 && !result && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-[13px]">
                <div className="font-medium">
                  {toAdd.length} {toAdd.length === 1 ? "person" : "people"} will be added to {campaignName ? `"${campaignName}"` : "this campaign"}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {blocked > 0 ? `${blocked} left out after verification` : "Everyone selected passed verification"}
                  {excluded.size > 0 ? ` · ${excluded.size} unticked by you` : ""}
                  {toAdd.length > PUSH_BATCH ? ` · sent in ${Math.ceil(toAdd.length / PUSH_BATCH)} batches of ${PUSH_BATCH}` : ""}
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-[13px]">
                <Checkbox checked={generate} onCheckedChange={(v) => setGenerate(v === true)} className="mt-0.5" />
                <span>
                  <span className="block font-medium">Generate a sequence once enrichment finishes</span>
                  <span className="block text-[12px] text-muted-foreground">Off = queue and enrich only; you can generate sequences later from the Prospects tab.</span>
                </span>
              </label>
              <div className="max-h-[38vh] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Email</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {toAdd.map((r) => (
                      <TableRow key={r.prospectId}>
                        <TableCell className="text-[13px] font-medium">{r.name}</TableCell>
                        <TableCell className="text-[12.5px] text-muted-foreground"><div className="max-w-[180px] truncate" title={r.title ?? undefined}>{r.title || "—"}</div></TableCell>
                        <TableCell className="text-[12.5px] text-muted-foreground"><div className="max-w-[180px] truncate" title={r.company ?? undefined}>{r.company || "—"}</div></TableCell>
                        <TableCell className="text-[12.5px]">{r.email || <span className="text-muted-foreground">—</span>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {step === 3 && result && (
            <ResultView result={result} previewById={previewById} generate={generate} />
          )}
        </div>

        <div className="flex items-center gap-2 px-6 py-4 border-t border-border">
          <div className="flex-1 text-[12.5px] text-muted-foreground">
            {step === 1 && (
              <>
                <span className="font-medium text-foreground">{selected.size}</span> selected
                {selected.size > 0 && <> · <button type="button" className="underline hover:text-foreground" onClick={() => setSelected(new Map())}>clear</button></>}
                <span className="ml-2 text-muted-foreground/70">up to {MAX_SELECTION} per run</span>
              </>
            )}
            {step === 2 && !preview.isLoading && !preview.error && (
              <><span className="font-medium text-foreground">{toAdd.length}</span> of {previewRows.length} will be added</>
            )}
          </div>
          {step === 1 && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={selected.size === 0} onClick={goVerify}>
                Verify {selected.size || ""} <ChevronRight className="ml-1 size-4" />
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={() => setStep(1)}><ChevronLeft className="mr-1 size-4" /> Back</Button>
              <Button disabled={preview.isLoading || !!preview.error || toAdd.length === 0} onClick={() => setStep(3)}>
                Continue with {toAdd.length} <ChevronRight className="ml-1 size-4" />
              </Button>
            </>
          )}
          {step === 3 && !result && (
            <>
              <Button variant="outline" disabled={submitting} onClick={() => setStep(2)}><ChevronLeft className="mr-1 size-4" /> Back</Button>
              <Button disabled={submitting || toAdd.length === 0} onClick={submit}>
                {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <UserPlus className="mr-1.5 size-4" />}
                Add {toAdd.length} to campaign
              </Button>
            </>
          )}
          {step === 3 && result && (
            <>
              <Button variant="outline" onClick={reset}>Add more</Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Step indicator ─────────────────────────────────────────────────────── */

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="mt-3 flex items-center">
      {STEPS.map((s, i) => {
        const done = s.id < current;
        const active = s.id === current;
        return (
          <div key={s.id} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <div className={`flex size-6 items-center justify-center rounded-full border-2 text-[11px] font-semibold transition-colors ${
                done ? "border-primary bg-primary text-primary-foreground"
                  : active ? "border-primary bg-background text-primary"
                    : "border-muted-foreground/30 bg-background text-muted-foreground/50"}`}>
                {done ? <CheckCircle2 className="size-3.5" /> : s.id}
              </div>
              <span className={`text-[12px] ${active ? "font-medium text-primary" : done ? "text-foreground" : "text-muted-foreground"}`}>{s.label}</span>
            </div>
            {i < STEPS.length - 1 && <div className={`mx-3 h-0.5 w-10 transition-colors ${done ? "bg-primary" : "bg-muted-foreground/20"}`} />}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Step 1: select ─────────────────────────────────────────────────────── */

function SelectStep(props: {
  source: "search" | "list"; setSource: (s: "search" | "list") => void;
  searchInput: string; setSearchInput: (s: string) => void;
  emailFilter: "any" | "yes" | "no"; setEmailFilter: (v: "any" | "yes" | "no") => void;
  hideSequenced: boolean; setHideSequenced: (v: boolean) => void;
  lists: any[]; listsLoading: boolean; listId: number | null; setListId: (id: number | null) => void;
  rows: PersonRow[]; loading: boolean; total: number; page: number; totalPages: number; setPage: (p: number) => void;
  selected: Map<number, PersonRow>; toggle: (r: PersonRow) => void; allOnPageSelected: boolean; toggleAllOnPage: () => void;
  clearSelection: () => void; enrollmentMap?: EnrollmentMap;
}) {
  const { source, rows, loading, selected } = props;
  const segBtn = (on: boolean) =>
    `h-8 rounded-md px-3 text-[12.5px] font-medium transition-colors ${on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          <button type="button" className={segBtn(source === "search")} onClick={() => props.setSource("search")}><Search className="mr-1 inline size-3.5" />Search people</button>
          <button type="button" className={segBtn(source === "list")} onClick={() => props.setSource("list")}><ListChecks className="mr-1 inline size-3.5" />From a list</button>
        </div>
        {source === "search" ? (
          <>
            <div className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={props.searchInput}
                onChange={(e) => props.setSearchInput(e.target.value)}
                placeholder="Search by name, email, title or company"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </div>
            <select
              value={props.emailFilter}
              onChange={(e) => props.setEmailFilter(e.target.value as "any" | "yes" | "no")}
              className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px]"
            >
              <option value="any">Any email</option>
              <option value="yes">Has email</option>
              <option value="no">No email</option>
            </select>
            <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Checkbox checked={props.hideSequenced} onCheckedChange={(v) => props.setHideSequenced(v === true)} className="size-3.5" />
              Hide people in a sequence
            </label>
          </>
        ) : (
          <select
            value={props.listId ?? ""}
            onChange={(e) => props.setListId(e.target.value ? Number(e.target.value) : null)}
            className="h-8 min-w-[240px] rounded-md border border-border bg-background px-2 text-[12.5px]"
          >
            <option value="">{props.listsLoading ? "Loading lists…" : props.lists.length ? "Choose a list…" : "No lists yet"}</option>
            {props.lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.memberCount != null ? ` (${l.memberCount})` : ""}</option>
            ))}
          </select>
        )}
      </div>

      <div className="rounded-lg border border-border">
        <div className="max-h-[46vh] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox checked={props.allOnPageSelected} onCheckedChange={props.toggleAllOnPage} disabled={rows.length === 0} aria-label="Select all on this page" />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>In outreach</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></TableCell></TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-[13px] text-muted-foreground">
                    {source === "list"
                      ? props.listId == null ? "Choose a list to see its people." : "This list has no people on it."
                      : props.searchInput.trim() ? "No people match that search." : "No people in the CRM yet."}
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.map((p) => {
                const on = selected.has(p.id);
                return (
                  <TableRow key={p.id} className={`cursor-pointer ${on ? "bg-primary/5" : "hover:bg-muted/50"}`} onClick={() => props.toggle(p)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={on} onCheckedChange={() => props.toggle(p)} aria-label={`Select ${nameOf(p)}`} />
                    </TableCell>
                    <TableCell>
                      <div className="text-[13px] font-medium">{nameOf(p)}</div>
                      {p.linkedinUrl && (
                        <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-0.5 text-[11px] text-blue-600 hover:underline">
                          <ExternalLink className="size-2.5" /> LinkedIn
                        </a>
                      )}
                    </TableCell>
                    <TableCell className="text-[12.5px]"><div className="max-w-[160px] truncate" title={p.title ?? undefined}>{p.title || "—"}</div></TableCell>
                    <TableCell className="text-[12.5px]"><div className="max-w-[160px] truncate" title={p.company ?? undefined}>{p.company || "—"}</div></TableCell>
                    <TableCell>
                      {p.email ? (
                        <div className="flex max-w-[220px] items-center gap-1">
                          <span className="min-w-0 truncate text-[12px]" title={p.email}>{p.email}</span>
                          {emailStatusBadge(p.emailStatus)}
                        </div>
                      ) : <span className="text-[12px] text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-[12px] text-muted-foreground">{[p.city, p.state, p.country].filter(Boolean).join(", ") || "—"}</TableCell>
                    <TableCell>
                      <EnrollmentChip prospectId={p.id} map={props.enrollmentMap} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
          <span>{props.total.toLocaleString()} {props.total === 1 ? "person" : "people"}{source === "search" ? ` · page ${props.page} of ${props.totalPages}` : ""}</span>
          {source === "search" && props.totalPages > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2" disabled={props.page <= 1} onClick={() => props.setPage(props.page - 1)}><ChevronLeft className="size-4" /></Button>
              <Button size="sm" variant="ghost" className="h-7 px-2" disabled={props.page >= props.totalPages} onClick={() => props.setPage(props.page + 1)}><ChevronRight className="size-4" /></Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Step 2: verify ─────────────────────────────────────────────────────── */

function VerifyStep(props: {
  loading: boolean; error: string | null; retry: () => void;
  rows: PreviewRow[]; allRows: PreviewRow[]; counts?: Record<PreviewVerdict, number>;
  verdictFilter: "all" | PreviewVerdict; setVerdictFilter: (v: "all" | PreviewVerdict) => void;
  excluded: Set<number>; toggleExcluded: (id: number) => void;
  readyCount: number; toAddCount: number; blocked: number; campaignId: number;
}) {
  if (props.loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking duplicates and where each person already is…
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="rounded-lg border border-red-300/60 bg-red-50 px-4 py-3 text-[13px] text-red-800 dark:bg-red-950/40 dark:text-red-200">
        <div className="flex items-center gap-1.5 font-medium"><XCircle className="size-4" /> Verification failed</div>
        <p className="mt-1">{props.error}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={props.retry}>Try again</Button>
      </div>
    );
  }
  const counts = props.counts;
  const tiles: Array<{ key: "all" | PreviewVerdict; label: string; value: number; tone: string }> = [
    { key: "all", label: "Selected", value: props.allRows.length, tone: "text-foreground" },
    { key: "ready", label: "Ready", value: counts?.ready ?? 0, tone: "text-emerald-600 dark:text-emerald-400" },
    { key: "already_here", label: "Already here", value: counts?.already_here ?? 0, tone: "text-amber-600 dark:text-amber-400" },
    { key: "other_campaign", label: "In another campaign", value: counts?.other_campaign ?? 0, tone: "text-red-600 dark:text-red-400" },
    { key: "active_sequence", label: "In a sequence", value: counts?.active_sequence ?? 0, tone: "text-red-600 dark:text-red-400" },
    { key: "duplicate", label: "Duplicates", value: counts?.duplicate ?? 0, tone: "text-amber-600 dark:text-amber-400" },
    { key: "unidentifiable", label: "Unidentifiable", value: counts?.unidentifiable ?? 0, tone: "text-muted-foreground" },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {tiles.map((t) => {
          const on = props.verdictFilter === t.key;
          return (
            <button key={t.key} type="button" onClick={() => props.setVerdictFilter(t.key)}
              className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${on ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}>
              <div className={`text-[18px] font-semibold leading-none ${t.tone}`}>{t.value}</div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">{t.label}</div>
            </button>
          );
        })}
      </div>

      {props.blocked > 0 && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {props.blocked} of {props.allRows.length} can't be added as-is — the reason is on each row. A person can be in only one campaign at a time,
            and one an active sequence is working must exit it first.
          </span>
        </div>
      )}

      <div className="max-h-[44vh] overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Person</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Where they already are</TableHead>
              <TableHead>Duplicates</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-[13px] text-muted-foreground">No one in this group.</TableCell></TableRow>
            )}
            {props.rows.map((r) => {
              const ready = r.verdict === "ready";
              const on = ready && !props.excluded.has(r.prospectId);
              return (
                <TableRow key={r.prospectId} className={ready ? "" : "opacity-80"}>
                  <TableCell>
                    <Checkbox checked={on} disabled={!ready} onCheckedChange={() => props.toggleExcluded(r.prospectId)} aria-label={`Include ${r.name}`} />
                  </TableCell>
                  <TableCell>
                    <Link href={`/prospects/${r.prospectId}`} className="text-[13px] font-medium hover:underline">{r.name}</Link>
                    <div className="max-w-[220px] truncate text-[11.5px] text-muted-foreground" title={[r.title, r.company, r.email].filter(Boolean).join(" · ")}>
                      {[r.title, r.company].filter(Boolean).join(" · ") || "—"}
                    </div>
                    {r.email && (
                      <div className="flex max-w-[220px] items-center gap-1 text-[11.5px] text-muted-foreground">
                        <span className="min-w-0 truncate">{r.email}</span>{emailStatusBadge(r.emailStatus)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <VerdictBadge verdict={r.verdict} />
                    {r.reason && <div className="mt-1 max-w-[240px] text-[11.5px] leading-snug text-muted-foreground">{r.reason}</div>}
                  </TableCell>
                  <TableCell><WhereCell row={r} campaignId={props.campaignId} /></TableCell>
                  <TableCell><DuplicatesCell row={r} /></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: PreviewVerdict }) {
  const m = VERDICT_META[verdict];
  return <Badge variant="outline" className={`text-[10.5px] px-1.5 py-0 ${m.className}`}>{m.label}</Badge>;
}

/** Every campaign and sequence this person is in — active ones bold, past
 *  ones dimmed with their status — each linking to the record. */
function WhereCell({ row, campaignId }: { row: PreviewRow; campaignId: number }) {
  if (row.campaigns.length === 0 && row.sequences.length === 0 && !row.claim) {
    return <span className="text-[12px] text-muted-foreground">Not in any campaign or sequence</span>;
  }
  const chip = "inline-flex max-w-[240px] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium";
  // A claim with no membership row on record (a name+company match on an
  // older queue row, say) still names the campaign holding the identity.
  const claimShown = row.claim && !row.campaigns.some((c) => c.campaignId === row.claim!.campaignId);
  return (
    <div className="flex flex-col items-start gap-1">
      {row.campaigns.map((c) => (
        <Link key={`c${c.campaignId}`} href={`/are/campaigns/${c.campaignId}`}
          title={`Campaign "${c.campaignName}" — ${c.sequenceStatus}${c.isThisCampaign ? " (this campaign)" : ""}`}
          className={`${chip} ${c.active
            ? "border-violet-300/60 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
            : "border-border bg-muted/40 text-muted-foreground"}`}>
          <Bot className="size-3 shrink-0" />
          <span className="truncate">{c.isThisCampaign ? "This campaign" : c.campaignName}</span>
          <span className="shrink-0 opacity-70">· {c.sequenceStatus}</span>
        </Link>
      ))}
      {claimShown && row.claim && (
        <span className={`${chip} border-violet-300/60 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300`}
          title="The identity (email, LinkedIn or name + company) is held by a row in this campaign">
          <Bot className="size-3 shrink-0" />
          <span className="truncate">{row.claim.campaignId === campaignId ? "This campaign" : row.claim.campaignName ?? `Campaign #${row.claim.campaignId ?? "?"}`}</span>
        </span>
      )}
      {row.sequences.map((s) => (
        <Link key={`s${s.sequenceId}`} href={`/v2/sequences/${s.sequenceId}`}
          title={`Sequence "${s.sequenceName}" — ${s.status}, step ${s.currentStep + 1}`}
          className={`${chip} ${s.active
            ? "border-sky-300/60 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
            : "border-border bg-muted/40 text-muted-foreground"}`}>
          <Activity className="size-3 shrink-0" />
          <span className="truncate">{s.sequenceName}</span>
          <span className="shrink-0 opacity-70">· {s.status}{s.active ? `, step ${s.currentStep + 1}` : ""}</span>
        </Link>
      ))}
    </div>
  );
}

/** Same human twice in the selection, or a second People record elsewhere. */
function DuplicatesCell({ row }: { row: PreviewRow }) {
  if (!row.duplicateOf && row.crmDuplicates.length === 0) return <span className="text-[12px] text-muted-foreground">—</span>;
  return (
    <div className="space-y-1 text-[11.5px]">
      {row.duplicateOf && (
        <div className="flex items-start gap-1 text-amber-800 dark:text-amber-200">
          <Copy className="mt-0.5 size-3 shrink-0" />
          <span>Same as <Link href={`/prospects/${row.duplicateOf.prospectId}`} className="font-medium underline">{row.duplicateOf.name}</Link> in this selection</span>
        </div>
      )}
      {row.crmDuplicates.map((d) => (
        <div key={d.prospectId} className="flex items-start gap-1 text-muted-foreground">
          <Users className="mt-0.5 size-3 shrink-0" />
          <span>
            Another record: <Link href={`/prospects/${d.prospectId}`} className="font-medium underline">{d.name}</Link>
            {" "}(same {d.via === "email" ? "email" : "LinkedIn"}, not selected)
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─── Step 3 result ──────────────────────────────────────────────────────── */

function ResultView({ result, previewById, generate }: {
  result: { added: Array<{ prospectId: number; queueId: number }>; skipped: Array<{ prospectId: number; reason: string }> };
  previewById: Map<number, PreviewRow>;
  generate: boolean;
}) {
  const { added, skipped } = result;
  const label = (id: number) => previewById.get(id)?.name ?? `Prospect ${id}`;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-200">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-medium">{added.length} {added.length === 1 ? "person" : "people"} added</div>
          <div className="mt-0.5 text-[12.5px] opacity-90">
            {added.length > 0
              ? generate ? "Each is being enriched now; sequences generate once enrichment lands. The Prospects tab shows progress." : "Each is being enriched now. Generate sequences from the Prospects tab when ready."
              : "Nothing was added."}
          </div>
        </div>
      </div>
      {skipped.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-center gap-1.5 px-3 py-2 font-medium"><AlertTriangle className="size-3.5" /> {skipped.length} not added</div>
          <ul className="max-h-[30vh] space-y-0.5 overflow-auto border-t border-amber-300/40 px-3 py-2">
            {skipped.map((s) => (
              <li key={`${s.prospectId}-${s.reason}`}>
                <span className="font-medium">{label(s.prospectId)}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {added.length > 0 && (
        <div className="max-h-[30vh] overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader><TableRow><TableHead>Added</TableHead><TableHead>Company</TableHead><TableHead>Email</TableHead></TableRow></TableHeader>
            <TableBody>
              {added.map((a) => {
                const r = previewById.get(a.prospectId);
                return (
                  <TableRow key={a.queueId}>
                    <TableCell className="text-[13px] font-medium">{label(a.prospectId)}</TableCell>
                    <TableCell className="text-[12.5px] text-muted-foreground">{r?.company || "—"}</TableCell>
                    <TableCell className="text-[12.5px] text-muted-foreground">{r?.email || "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
