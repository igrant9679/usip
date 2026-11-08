import { useEffect, useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { tabRedirectUrl } from "@/pages/usip/dataEnrichmentTabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  Download,
  RefreshCw,
  Users,
  X,
  Info,
  ChevronRight,
} from "lucide-react";
import { Link } from "wouter";
import {
  CONTACT_IMPORT_FIELDS,
  autoMapHeaders,
  decodeCsvBytes,
  findDuplicateFieldMappings,
  isImportableFileName,
  isFieldRequiredFor,
  missingRequiredMappings,
  requiredFieldsFor,
} from "@shared/importFields";
import { pressable } from "@/lib/pressable";
import { confirmAction } from "@/components/usip/Common";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/* ─── System fields ──────────────────────────────────────────────────────────
 * Imported, not mirrored. This file used to declare its own copy under a comment
 * claiming it "mirrors backend SYSTEM_FIELDS" — it had 13 entries to the
 * server's 14, in a different order, and the order decides which field a header
 * auto-maps to. See shared/importFields.ts. */
const SYSTEM_FIELDS = CONTACT_IMPORT_FIELDS;

/* ─── Step indicator ────────────────────────────────────────────────────── */
const STEPS = [
  { id: 1, label: "Upload" },
  { id: 2, label: "Map Fields" },
  { id: 3, label: "Validate" },
  { id: 4, label: "Import" },
  { id: 5, label: "Done" },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((step, i) => (
        <div key={step.id} className="flex items-center">
          <div className="flex flex-col items-center gap-1">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors ${
                step.id < current
                  ? "bg-primary border-primary text-primary-foreground"
                  : step.id === current
                  ? "border-primary text-primary bg-background"
                  : "border-muted-foreground/30 text-muted-foreground/50 bg-background"
              }`}
            >
              {step.id < current ? <CheckCircle2 className="h-4 w-4" /> : step.id}
            </div>
            <span
              className={`text-xs whitespace-nowrap ${
                step.id === current ? "text-primary font-medium" : "text-muted-foreground"
              }`}
            >
              {step.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div
              className={`h-0.5 w-12 mx-1 mb-5 transition-colors ${
                step.id < current ? "bg-primary" : "bg-muted-foreground/20"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Verification status badge ─────────────────────────────────────────── */
const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  valid: { label: "Valid", className: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200" },
  accept_all: { label: "Accept-All", className: "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300 border-yellow-200" },
  risky: { label: "Risky", className: "bg-orange-100 text-orange-700 border-orange-200" },
  invalid: { label: "Invalid", className: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200" },
  unknown: { label: "Unknown", className: "bg-muted text-muted-foreground border-border" },
};

/** Save CSV text the server built as a file. */
function saveCsv(csv: string, name: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.toLowerCase().endsWith(".csv") ? name : `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── Main panel ────────────────────────────────────────────────────────── */
/**
 * The whole import wizard as an embeddable panel. Since 2026-08-21 it renders
 * inside Data Enrichment's "Import contacts" tab (owner fold ask — same
 * protocol as the Find Prospects fold, replacing that page's mock "CSV"
 * upsell tab whose only CTAs navigated here anyway); /import is a
 * query-preserving redirect there.
 */
export function ImportContactsPanel() {
  const [step, setStep] = useState(1);

  // Step 1: file upload
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState("");
  const [filename, setFilename] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Step 2: field mapping (+ the parse's column profiles and preview rows —
  // the server returned these all along and the page rendered none of it)
  const [headers, setHeaders] = useState<string[]>([]);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string | null>>({});
  const [totalParsedRows, setTotalParsedRows] = useState(0);
  const [previewRows, setPreviewRows] = useState<Array<Record<string, string>>>([]);
  const [columnStats, setColumnStats] = useState<Array<{ header: string; filled: number; samples: string[] }>>([]);
  // The upload is kept on the server under this token (audit 2026-10-20,
  // R86): validation and commit name it instead of sending the file again.
  const [fileToken, setFileToken] = useState<string | null>(null);
  // A LeadRocks export is read through its preset (F32); the person can read
  // it as a plain CSV instead.
  const [preset, setPreset] = useState<string | null>(null);
  const [detectedPreset, setDetectedPreset] = useState<string | null>(null);

  // Step 3: validation results. newCount + duplicateCount + errorCount is the
  // file; importCount is what the button creates (new, plus duplicates when
  // they are not skipped) — the server's number, not a client sum (R52).
  const [newCount, setNewCount] = useState(0);
  const [importCount, setImportCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  /** Every error row, for the report — the list on screen shows the first 20. */
  const [errorRows, setErrorRows] = useState<Array<{ rowIndex: number; reason: string }>>([]);
  const [totalRowCount, setTotalRowCount] = useState(0);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  /**
   * Match rows that have NO email on first+last name + company.
   *
   * Defaults OFF deliberately: email is a unique identifier, a name is not.
   * Two different people called "John Smith" are common, and silently merging
   * them loses a real contact — worse than importing a duplicate. Requiring a
   * company narrows it but cannot eliminate it, so this stays the user's call.
   */
  const [matchOnNameCompany, setMatchOnNameCompany] = useState(false);
  /**
   * Where the rows land. `contacts` is the CRM proper; `prospects` is the
   * backlog the enrichment sweeper actually reads — the sweeper never looks at
   * contacts, so an old list imported straight into the CRM is never cleaned.
   */
  const [destination, setDestination] = useState<"contacts" | "prospects">("contacts");
  /** Rows with no email — email dedup is structurally blind to these. */
  const [noEmailCount, setNoEmailCount] = useState(0);
  const [unmatchableCount, setUnmatchableCount] = useState(0);
  const [tag, setTag] = useState("");
  /** WHO the duplicate rows matched (first 10) — a count can't be eyeballed. */
  const [duplicateSamples, setDuplicateSamples] = useState<Array<{ rowIndex: number; name: string; email: string | null; matchedBy: string; existingName: string | null }>>([]);
  /** Error reasons tallied over ALL rows, not just the 200 the list shows. */
  const [errorReasonSummary, setErrorReasonSummary] = useState<Array<{ reason: string; count: number }>>([]);

  // Step 4: import result
  const [importResult, setImportResult] = useState<{
    importId: number;
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    errorRows: number;
    peopleLinkMode?: "synchronous" | "background" | "none";
    peopleLinked?: number;
    peopleCreated?: number;
  } | null>(null);

  /* ── tRPC mutations ── */
  const utils = trpc.useUtils();
  const parseCSVMutation = trpc.imports.parseCSV.useMutation();
  const setPresetMutation = trpc.imports.setPreset.useMutation({ onError: (e) => toast.error(e.message) });
  const validateRowsMutation = trpc.imports.validateRows.useMutation();
  const commitMutation = trpc.imports.commit.useMutation();

  /** What the server read: its columns, through the preset when there is one. */
  function applyParsed(result: { fileToken: string; detectedPreset: string | null; preset: string | null; presetMapping: Record<string, string> | null; headers: string[]; totalRows: number; previewRows: unknown; columnStats?: unknown }) {
    setFileToken(result.fileToken);
    setDetectedPreset(result.detectedPreset);
    setPreset(result.preset);
    setHeaders(result.headers);
    setTotalParsedRows(result.totalRows ?? 0);
    setPreviewRows((result.previewRows as Array<Record<string, string>>) ?? []);
    setColumnStats((result.columnStats as typeof columnStats) ?? []);
    // A preset maps every column to its own field; otherwise exact label /
    // key / alias matching, one column per field (shared/importFields.ts).
    setFieldMapping(result.presetMapping ?? autoMapHeaders(result.headers));
    // A LeadRocks list is prospects to clean, as its old importer put them.
    if (result.preset === "leadrocks") setDestination("prospects");
  }
  async function switchPreset(next: "leadrocks" | null) {
    if (!fileToken) return;
    try {
      applyParsed(await setPresetMutation.mutateAsync({ fileToken, preset: next }));
    } catch {
      /* said by onError */
    }
  }

  /* ── Step 1: File upload ── */
  function handleFile(f: File) {
    if (!isImportableFileName(f.name)) {
      toast.error("Please upload a .csv file (a tab-separated .tsv or .txt works too).");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast.error("File is too large. Maximum size is 10 MB.");
      return;
    }
    setFile(f);
    setFilename(f.name);
    // Bytes, then decoded here: readAsText assumed UTF-8, which garbled
    // Excel's UTF-16 and Windows-1252 exports (R53). See decodeCsvBytes.
    const reader = new FileReader();
    reader.onload = (e) => setCsvText(decodeCsvBytes(new Uint8Array((e.target?.result as ArrayBuffer) ?? new ArrayBuffer(0))));
    reader.readAsArrayBuffer(f);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  async function handleParseCSV() {
    if (!csvText) return;
    try {
      // The one upload: the server keeps the file and answers with a token.
      const result = await parseCSVMutation.mutateAsync({ csvText, filename });
      applyParsed(result);
      setStep(2);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to parse CSV.");
    }
  }

  /* ── Step 3: Validate ── */
  // `override` lets the name+company toggle re-validate immediately with its new
  // value, rather than waiting a render for state to settle (which would show
  // counts from the previous setting).
  async function handleValidate(override?: { matchOnNameCompany?: boolean; skipDuplicates?: boolean }) {
    try {
      if (!fileToken) { toast.error("Upload the file again."); setStep(1); return; }
      const result = await validateRowsMutation.mutateAsync({
        // The stored upload, not the file again (R86).
        fileToken,
        filename,
        fieldMapping,
        matchOnNameCompany: override?.matchOnNameCompany ?? matchOnNameCompany,
        destination,
        // Both dedupe settings must reach the preview, or its counts describe a
        // different import than the one the button performs.
        skipDuplicates: override?.skipDuplicates ?? skipDuplicates,
      } as any);
      setNewCount(result.newCount);
      setImportCount(result.importCount);
      setDuplicateCount(result.duplicateCount);
      setErrorCount(result.errorCount);
      setErrorRows(result.errorRows);
      setTotalRowCount(result.totalRows);
      setNoEmailCount((result as any).noEmailCount ?? 0);
      setUnmatchableCount((result as any).unmatchableCount ?? 0);
      setDuplicateSamples(((result as any).duplicateSamples as typeof duplicateSamples) ?? []);
      setErrorReasonSummary(((result as any).errorReasonSummary as typeof errorReasonSummary) ?? []);
      setStep(3);
    } catch (err: any) {
      toast.error(err.message ?? "Validation failed.");
    }
  }

  /* ── Step 4: Commit ── */
  async function handleCommit() {
    try {
      if (!fileToken) { toast.error("Upload the file again."); setStep(1); return; }
      const result = await commitMutation.mutateAsync({
        fileToken,
        filename,
        fieldMapping,
        skipDuplicates,
        // Must mirror what the preview was computed with, or the summary would
        // promise one thing and the import do another.
        matchOnNameCompany,
        destination,
        postImportActions: { tag: tag || undefined },
      } as any);
      setImportResult(result);
      // The step-1 history card must list this import when the user returns.
      utils.imports.getHistory.invalidate();
      setStep(5);
    } catch (err: any) {
      toast.error(err.message ?? "Import failed.");
    }
  }

  /* ── Download error report ── */
  // Every error row with its own columns, row number and reason, built by the
  // server from the stored upload (F32): the file can be fixed and imported again.
  async function downloadErrorReport() {
    if (!fileToken) return;
    try {
      const r = await utils.imports.errorReport.fetch({ fileToken });
      saveCsv(r.csv, r.filename);
    } catch (err: any) {
      toast.error(err.message ?? "Could not build the error report.");
    }
  }

  const totalRows = totalRowCount || newCount + duplicateCount + errorCount;

  /**
   * Two columns claiming one field. The import keeps whichever comes last and
   * discards the other silently, so this blocks rather than warns — the server
   * refuses it too, which is the guard that actually holds.
   */
  const duplicateMappings = findDuplicateFieldMappings(fieldMapping);
  const conflictedHeaders = new Set(duplicateMappings.flatMap((d) => d.headers));

  /**
   * Required fields depend on the DESTINATION, which is chosen on this same
   * screen — so the list re-evaluates as the user switches it rather than
   * describing whichever destination happened to be selected first.
   */
  const missingRequired = missingRequiredMappings(fieldMapping, destination);
  const canContinue = duplicateMappings.length === 0 && missingRequired.length === 0;

  /* Column profiles from the server's ONE parse — mapping by what a column
   * HOLDS, not what its header claims (the 8c967cc mismap started as a
   * plausible-looking header). */
  const statFor = (h: string) => columnStats.find((c) => c.header === h);
  const fillPct = (h: string) => {
    const s = statFor(h);
    return s && totalParsedRows ? Math.round((s.filled / totalParsedRows) * 100) : null;
  };
  const mappedCount = Object.values(fieldMapping).filter(Boolean).length;
  /** For each destination-required field: which column feeds it and how full that column is. */
  const requiredCoverage = requiredFieldsFor(destination).map((f) => {
    const mappedHeader = Object.entries(fieldMapping).find(([, v]) => v === f.key)?.[0] ?? null;
    return { label: f.label, mappedHeader, pct: mappedHeader ? fillPct(mappedHeader) : null };
  });

  return (
      <div className="max-w-4xl">
        <StepIndicator current={step} />

        {/* ── Step 1: Upload ── */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Upload CSV File</CardTitle>
              <CardDescription>
                Supported: .csv files (comma, semicolon or tab separated) up to 50,000 rows and 10 MB.
                Required columns: {requiredFieldsFor("contacts").map((f) => f.label).join(", ")} for CRM
                Contacts, or {requiredFieldsFor("prospects").map((f) => f.label).join(", ")} for Prospects.
                You map columns and choose where they go in the next step.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : file
                    ? "border-green-400 bg-green-50 dark:bg-green-950/40"
                    : "border-muted-foreground/25 hover:border-primary/50"
                }`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                {...pressable(() => fileInputRef.current?.click())}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                />
                {file ? (
                  <div className="space-y-2">
                    <CheckCircle2 className="h-10 w-10 text-green-500 dark:text-green-400 mx-auto" />
                    <p className="font-medium text-green-700 dark:text-green-300">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} KB · Click to replace
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Upload className="h-10 w-10 text-muted-foreground/50 mx-auto" />
                    <p className="font-medium">Drop your CSV here or click to browse</p>
                    <p className="text-sm text-muted-foreground">Comma-separated values (.csv)</p>
                  </div>
                )}
              </div>

              <Alert className="border-blue-200 bg-blue-50 dark:bg-blue-950/40">
                <Info className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                <AlertDescription className="text-blue-800 dark:text-blue-200 text-sm">
                  <strong>Tip:</strong> Export your contacts from Google Contacts, HubSpot, Salesforce,
                  or LinkedIn Sales Navigator as CSV. Include at minimum:{" "}
                  {requiredFieldsFor("contacts").map((f) => f.label).join(", ")} — or, with no email
                  column, import into Prospects and let the sweeper find one.
                </AlertDescription>
              </Alert>

              <div className="flex justify-end">
                <Button
                  onClick={handleParseCSV}
                  disabled={!file || parseCSVMutation.isPending}
                  className="gap-2"
                >
                  {parseCSVMutation.isPending ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  {parseCSVMutation.isPending ? "Parsing…" : "Continue"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Past imports — imports.getHistory existed server-side with no
            consumer, while step 3's copy told users to find their batch in
            "the import history below". Now there is one. */}
        {step === 1 && <ImportHistoryCard />}

        {/* ── Step 2: Map Fields ── */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Map CSV Columns to Contact Fields</CardTitle>
              <CardDescription>
                Match each column in your CSV to a Velocity contact field. Required fields are marked
                with *. Each column shows how full it is and a sample of what it holds — map by the
                data, not the header.
              </CardDescription>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">{totalParsedRows.toLocaleString()} rows</span>
                <span>·</span>
                <span className="tabular-nums">{headers.length} columns</span>
                <span>·</span>
                <span className="tabular-nums">{mappedCount} mapped, {headers.length - mappedCount} skipped</span>
                <span>·</span>
                <span className="truncate">{filename}</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* LeadRocks is a preset of this importer (F32): its fourteen
                  email columns become one best address, its location three
                  fields, its website the company domain. */}
              {detectedPreset === "leadrocks" && (
                <Alert className="border-sky-200 bg-sky-50 dark:bg-sky-950/40" data-testid="leadrocks-preset">
                  <Info className="h-4 w-4 text-sky-600 dark:text-sky-300" />
                  <AlertDescription className="text-sm text-sky-900 dark:text-sky-200 flex flex-wrap items-center gap-2">
                    {preset === "leadrocks" ? (
                      <>
                        <span className="flex-1 min-w-0">This is a LeadRocks export, read with the LeadRocks preset: the best of its email columns, its first phone and its location split into city, state and country. Rows need a LinkedIn profile URL. LeadRocks' own email verdict is kept with each person; Velocity verifies the address before it is used.</span>
                        <Button size="sm" variant="outline" className="h-7" disabled={setPresetMutation.isPending} onClick={() => void switchPreset(null)}>Read as a plain CSV</Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 min-w-0">This looks like a LeadRocks export.</span>
                        <Button size="sm" variant="outline" className="h-7" disabled={setPresetMutation.isPending} onClick={() => void switchPreset("leadrocks")}>Use the LeadRocks preset</Button>
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <div className="rounded-lg border overflow-hidden">
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">CSV Column</th>
                      <th className="text-left px-4 py-2 font-medium">Maps to Velocity Field</th>
                    </tr>
                  </thead>
                  <tbody>
                    {headers.map((header) => (
                      <tr
                        key={header}
                        className={
                          conflictedHeaders.has(header)
                            ? "border-t bg-destructive/10"
                            : "border-t"
                        }
                      >
                        <td className="px-4 py-2">
                          <div className="font-mono text-xs text-foreground">{header}</div>
                          {(() => {
                            const s = statFor(header);
                            const pct = fillPct(header);
                            if (!s) return null;
                            return (
                              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span className={`inline-block h-1 w-10 shrink-0 overflow-hidden rounded-full bg-muted ${pct === 0 ? "opacity-60" : ""}`} aria-hidden>
                                  <span className="block h-full rounded-full bg-primary/60" style={{ width: `${pct ?? 0}%` }} />
                                </span>
                                <span className="tabular-nums shrink-0">{pct}% filled</span>
                                {s.samples.length > 0
                                  ? <span className="truncate max-w-[260px]" title={s.samples.join("  ·  ")}>e.g. {s.samples.join(" · ")}</span>
                                  : <span className="italic">empty column</span>}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-2">
                          <Select
                            value={fieldMapping[header] ?? "__skip__"}
                            onValueChange={(val) =>
                              setFieldMapping((prev) => ({
                                ...prev,
                                [header]: val === "__skip__" ? null : val,
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 text-xs w-52">
                              <SelectValue placeholder="Skip this column" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__skip__">
                                <span className="text-muted-foreground">— Skip this column —</span>
                              </SelectItem>
                              {SYSTEM_FIELDS.map((f) => (
                                <SelectItem key={f.key} value={f.key}>
                                  {f.label}
                                  {isFieldRequiredFor(f, destination) && (
                                    <span className="ml-1 text-destructive">*</span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>

              {/* First rows of the file, exactly as the server parsed them —
                  the fastest way to catch a wrong delimiter or shifted columns. */}
              {previewRows.length > 0 && (
                <details className="rounded-lg border">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium hover:bg-muted/40">
                    Preview first {previewRows.length} rows (as parsed)
                  </summary>
                  <div className="overflow-x-auto border-t">
                    <table className="w-full text-[11px]">
                      <thead className="bg-muted/50">
                        <tr>{headers.map((h) => <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {previewRows.map((row, i) => (
                          <tr key={i} className="border-t">
                            {headers.map((h) => (
                              <td key={h} className="max-w-[180px] truncate whitespace-nowrap px-2 py-1 text-muted-foreground" title={row[h] ?? ""}>
                                {row[h] || <span className="italic opacity-50">—</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* How complete the REQUIRED data actually is for this destination
                  — a field can be mapped to a column that is nearly empty. */}
              {columnStats.length > 0 && (
                <div className="rounded-lg border p-3">
                  <p className="mb-2 text-xs font-medium">Required-field coverage — {destination === "prospects" ? "Prospects" : "CRM Contacts"}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {requiredCoverage.map((rc) => (
                      <div key={rc.label} className="flex items-center gap-2 text-xs">
                        <span className="w-24 shrink-0 text-muted-foreground">{rc.label}</span>
                        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span className={`block h-full rounded-full ${rc.pct == null ? "" : rc.pct >= 90 ? "bg-emerald-500" : rc.pct >= 50 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${rc.pct ?? 0}%` }} />
                        </span>
                        <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                          {rc.mappedHeader == null ? "not mapped" : rc.pct == null ? "—" : `${rc.pct}% of rows`}
                        </span>
                      </div>
                    ))}
                  </div>
                  {requiredCoverage.some((rc) => rc.mappedHeader != null && (rc.pct ?? 0) < 100) && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Rows missing a required value fail validation individually — the next step counts them exactly.
                    </p>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                <span className="text-destructive">*</span> Required for{" "}
                {destination === "prospects" ? "Prospects" : "CRM Contacts"}:{" "}
                {requiredFieldsFor(destination).map((f) => f.label).join(", ")}
                {destination === "prospects" && (
                  <> — Email is not required here, because finding one is what this destination is for.</>
                )}
              </p>

              {missingRequired.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="space-y-1">
                    <p className="font-medium">
                      No column is mapped to{" "}
                      {missingRequired.map((f) => f.label).join(", ")}.
                    </p>
                    <p className="text-xs">
                      {destination === "prospects"
                        ? "Prospects need a name and a company — the enrichment sweeper resolves the company to a domain before it can find an address."
                        : "A CRM contact needs a name, a company and an email address. If your file has no email column, import into Prospects instead and let the sweeper find one."}
                    </p>
                  </AlertDescription>
                </Alert>
              )}

              {duplicateMappings.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="space-y-2">
                    <p className="font-medium">
                      Two columns are mapped to the same field.
                    </p>
                    <ul className="text-xs space-y-1">
                      {duplicateMappings.map((d) => (
                        <li key={d.field}>
                          <span className="font-medium">{d.label}</span> ←{" "}
                          {d.headers.map((h) => `"${h}"`).join(", ")}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs">
                      Only one of them would be imported and the other would be dropped without
                      a warning, so pick one and set the rest to “Skip this column”.
                    </p>
                  </AlertDescription>
                </Alert>
              )}

              {/* Chosen BEFORE validation, because the preview dedupes against
                  whichever table the rows will land in. */}
              <div className="rounded-lg border p-3 space-y-2">
                <p className="text-sm font-medium">Import into</p>
                <Select value={destination} onValueChange={(v) => setDestination(v as "contacts" | "prospects")}>
                  <SelectTrigger className="w-full sm:w-80"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contacts">CRM Contacts — ready to use</SelectItem>
                    <SelectItem value="prospects">Prospects — clean them first</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {destination === "contacts"
                    ? "Rows become contacts immediately and are linked onto the People tab as part of the import. Nothing verifies their email addresses."
                    : "Rows join the prospect backlog — which is the People tab — and the enrichment sweeper finds and verifies an address for each one; only those that come back verified are promoted to contacts, where your segment rules can enrol them."}
                </p>
                {destination === "prospects" && (
                  <p className="text-xs text-muted-foreground">
                    Cleaning runs on a daily cap (Settings → Prospects), so a large list is worked through over
                    several days rather than all at once.
                  </p>
                )}
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button
                  // Not `onClick={handleValidate}`: that hands the MouseEvent in
                  // as `override`, so every field of it reads undefined and the
                  // function works only because each one falls back to state.
                  onClick={() => void handleValidate()}
                  disabled={validateRowsMutation.isPending || !canContinue}
                  className="gap-2"
                >
                  {validateRowsMutation.isPending ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  {validateRowsMutation.isPending ? "Validating…" : "Validate Rows"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Validation Results ── */}
        {step === 3 && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Validation Results</CardTitle>
                <CardDescription>
                  Review the results before committing the import.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* One glance: how the file splits. The tiles below carry the numbers. */}
                {totalRows > 0 && (
                  <div className="space-y-1">
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span className="bg-emerald-500" style={{ width: `${(newCount / totalRows) * 100}%` }} />
                      <span className="bg-amber-400" style={{ width: `${(duplicateCount / totalRows) * 100}%` }} />
                      <span className="bg-red-500" style={{ width: `${(errorCount / totalRows) * 100}%` }} />
                    </div>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {totalRows.toLocaleString()} rows — {Math.round((newCount / totalRows) * 100)}% new ·{" "}
                      {Math.round((duplicateCount / totalRows) * 100)}% duplicates · {Math.round((errorCount / totalRows) * 100)}% errors
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border bg-green-50 dark:bg-green-950/40 p-3 text-center">
                    <p className="text-2xl font-bold text-green-700 dark:text-green-300">{newCount}</p>
                    <p className="text-xs text-green-600 dark:text-green-300 mt-0.5">New, ready to import</p>
                  </div>
                  <div className="rounded-lg border bg-yellow-50 dark:bg-yellow-950/40 p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">{duplicateCount}</p>
                    <p className="text-xs text-yellow-600 dark:text-yellow-300 mt-0.5">Duplicates found</p>
                  </div>
                  <div className="rounded-lg border bg-red-50 dark:bg-red-950/40 p-3 text-center">
                    <p className="text-2xl font-bold text-red-700 dark:text-red-300">{errorCount}</p>
                    <p className="text-xs text-red-600 dark:text-red-300 mt-0.5">Errors (will skip)</p>
                  </div>
                </div>

                {duplicateCount > 0 && (
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">Skip duplicates?</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {duplicateCount} row{duplicateCount === 1 ? "" : "s"} match an existing contact
                        {matchOnNameCompany ? " by email, or by name + company" : " by email"}
                      </p>
                    </div>
                    {/* Re-validate on change, like the name+company toggle: the
                        counts above are computed WITH this setting, so leaving it
                        out left "Valid" and "Duplicates found" describing an
                        import the button would no longer perform. */}
                    <Switch aria-label="Skip duplicates"
                      checked={skipDuplicates}
                      onCheckedChange={(v) => { setSkipDuplicates(v); void handleValidate({ skipDuplicates: v }); }}
                    />
                  </div>
                )}

                {/* WHO the duplicates matched — a count alone can't be checked;
                    a name pair can be eyeballed in seconds. */}
                {duplicateSamples.length > 0 && (
                  <details className="rounded-lg border" open={duplicateCount <= 10}>
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium hover:bg-muted/40">
                      Who they matched {duplicateCount > duplicateSamples.length ? `(first ${duplicateSamples.length} of ${duplicateCount})` : ""}
                    </summary>
                    <div className="max-h-44 overflow-y-auto border-t">
                      {duplicateSamples.map((d) => (
                        <div key={d.rowIndex} className="flex flex-wrap items-baseline gap-x-2 border-b px-3 py-1.5 text-xs last:border-0">
                          <span className="shrink-0 text-muted-foreground tabular-nums">Row {d.rowIndex}</span>
                          <span className="font-medium">{d.name}</span>
                          {d.email && <span className="font-mono text-[11px] text-muted-foreground">{d.email}</span>}
                          <span className="text-muted-foreground">
                            {d.existingName ? `↔ existing “${d.existingName}” · by ${d.matchedBy}` : `↔ ${d.matchedBy}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Duplicate detection is email-based. Say so plainly whenever
                    rows lack one, so the summary can never imply that dedup ran
                    on rows it structurally cannot see. */}
                {noEmailCount > 0 && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {noEmailCount} row{noEmailCount === 1 ? " has" : "s have"} no email address
                    </p>
                    <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-300/90">
                      Duplicate detection normally matches on email, so {noEmailCount === 1 ? "this row" : "these rows"} can't be
                      checked against your existing contacts that way — {noEmailCount === 1 ? "it" : "they"} will import even if
                      already present.
                      {unmatchableCount > 0 && ` ${unmatchableCount} of them also have no company, so no fallback match is possible at all.`}
                    </p>
                    <div className="mt-2.5 flex items-center justify-between gap-3 rounded-md bg-background/60 p-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-medium">Also match on name + company</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Off by default: two different people can share a name, and merging them
                          loses a real contact. Only rows with a company are matched.
                        </p>
                      </div>
                      <Switch aria-label="Match on name and company"
                        checked={matchOnNameCompany}
                        disabled={validateRowsMutation.isPending}
                        onCheckedChange={(v) => {
                          setMatchOnNameCompany(v);
                          // Re-validate so the counts above reflect the new rule.
                          handleValidate({ matchOnNameCompany: v });
                        }}
                      />
                    </div>
                  </div>
                )}

                {errorCount > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
                        <AlertCircle className="h-4 w-4" />
                        {errorCount} rows with errors (will be skipped)
                      </p>
                      <Button variant="outline" size="sm" onClick={downloadErrorReport} className="gap-1.5 h-7 text-xs">
                        <Download className="h-3 w-3" /> Download error report
                      </Button>
                    </div>
                    {/* WHY, grouped — tallied server-side over ALL error rows,
                        because the list below caps at 200. One dominant reason
                        usually means one fixable column. */}
                    {errorReasonSummary.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {errorReasonSummary.map((r) => (
                          <span key={r.reason} className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-[11px]">
                            <span className="font-semibold tabular-nums text-destructive">{r.count}×</span>
                            <span className="max-w-[280px] truncate" title={r.reason}>{r.reason}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="rounded-lg border max-h-40 overflow-y-auto">
                      {errorRows.slice(0, 20).map((r) => (
                        <div key={r.rowIndex} className="flex items-start gap-2 px-3 py-1.5 border-b last:border-0 text-xs">
                          <span className="text-muted-foreground shrink-0">Row {r.rowIndex}</span>
                          <span className="text-destructive">{r.reason}</span>
                        </div>
                      ))}
                      {errorCount > 20 && (
                        <p className="px-3 py-1.5 text-xs text-muted-foreground">
                          … and {errorCount - 20} more. Download the full report above.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <Separator />

                {/* The old copy promised "easy filtering later". There is no
                    contact tag to filter on: `contacts` has no tags column (only
                    leads and help articles do), the label is written to
                    customFields.importTag, and nothing in the app reads that key.
                    Saying what it actually does instead of implying a feature
                    that does not exist. */}
                <div className="space-y-2">
                  <Label htmlFor="tag">Label this import (optional)</Label>
                  <Input
                    id="tag"
                    placeholder="e.g. Q2-2026-import, tradeshow-leads"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Recorded on each contact as import provenance, alongside this import's
                    id. Contacts have no tag field to filter on yet — the import history
                    below is where you find a batch again.
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)} className="gap-2">
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button
                onClick={() => setStep(4)}
                disabled={importCount === 0}
                className="gap-2"
              >
                Continue to Import <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 4: Confirm & Import ── */}
        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle>Confirm Import</CardTitle>
              <CardDescription>
                Review the summary below and click Import to commit.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">File</span>
                  <span className="font-medium">{filename}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total rows parsed</span>
                  <span className="font-medium">{totalRows}</span>
                </div>
                {/* The two facts this summary used to omit — WHERE the rows land
                    and WHICH rule produced the duplicate count. */}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Destination</span>
                  <span className="font-medium">{destination === "prospects" ? "Prospects — cleaned by the sweeper first" : "CRM Contacts — usable immediately"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Duplicate matching</span>
                  <span className="font-medium">{matchOnNameCompany ? "email, or name + company" : "email only"}</span>
                </div>
                {noEmailCount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Rows dedup can't see{matchOnNameCompany ? "" : " (no email)"}</span>
                    <span className="font-medium text-amber-700 dark:text-amber-300">{matchOnNameCompany ? unmatchableCount : noEmailCount}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Contacts to import</span>
                  <span className="font-medium text-green-700 dark:text-green-300">
                    {importCount}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Duplicates</span>
                  <span className="font-medium text-yellow-700 dark:text-yellow-300">
                    {skipDuplicates ? `${duplicateCount} (skipped)` : `${duplicateCount} (included)`}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Rows with errors</span>
                  <span className="font-medium text-red-700 dark:text-red-300">{errorCount} (skipped)</span>
                </div>
                {tag && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Import label</span>
                    <Badge variant="outline">{tag}</Badge>
                  </div>
                )}
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(3)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={handleCommit}
                  disabled={commitMutation.isPending}
                  className="gap-2"
                >
                  {commitMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Importing…
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4" />
                      Import {importCount} Contacts
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 5: Done ── */}
        {step === 5 && importResult && (
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-5">
              <div className="flex justify-center">
                <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-300" />
                </div>
              </div>
              <div>
                <h2 className="text-xl font-bold">Import Complete</h2>
                <p className="text-muted-foreground mt-1">
                  {destination === "prospects"
                    ? "Your rows joined the prospect backlog — they are on the People tab now. The enrichment sweeper finds and verifies an email for each (on its daily cap)."
                    : importResult.peopleLinkMode === "background"
                    ? "Your contacts have been added. This was a large import, so linking to the People tab is finishing in the background — every row will appear there."
                    : `Your contacts have been added and are on the People tab${importResult.peopleLinked ? ` — ${importResult.peopleLinked} linked${importResult.peopleCreated ? ` (${importResult.peopleCreated} new People records)` : ""}` : ""}.`}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 max-w-xs mx-auto">
                <div className="rounded-lg border bg-green-50 dark:bg-green-950/40 p-3 text-center">
                  <p className="text-2xl font-bold text-green-700 dark:text-green-300">{importResult.importedRows}</p>
                  <p className="text-xs text-green-600 dark:text-green-300">Imported</p>
                </div>
                <div className="rounded-lg border bg-yellow-50 dark:bg-yellow-950/40 p-3 text-center">
                  <p className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">{importResult.skippedRows}</p>
                  <p className="text-xs text-yellow-600 dark:text-yellow-300">Skipped</p>
                </div>
                <div className="rounded-lg border bg-red-50 dark:bg-red-950/40 p-3 text-center">
                  <p className="text-2xl font-bold text-red-700 dark:text-red-300">{importResult.errorRows}</p>
                  <p className="text-xs text-red-600 dark:text-red-300">Errors</p>
                </div>
              </div>

              <div className="flex justify-center">
                <UndoImportButton importId={importResult.importId} onUndone={() => utils.imports.getHistory.invalidate()} />
              </div>

              <div className="flex justify-center gap-3 pt-2">
                {/* The CTA lands where the rows are. Both destinations end up
                    on People now that the /prospects list is retired (phase 5
                    item 2, 2026-10-27), so there is one link, not two. */}
                <Link href="/v2/people">
                  <Button className="gap-2">
                    <Users className="h-4 w-4" />
                    View People
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep(1);
                    setFile(null);
                    setCsvText("");
                    setFilename("");
                    setHeaders([]);
                    setFieldMapping({});
                    setNewCount(0);
                    setImportCount(0);
                    setDuplicateCount(0);
                    setErrorCount(0);
                    setErrorRows([]);
                    setTotalRowCount(0);
                    setImportResult(null);
                    setTag("");
                    setTotalParsedRows(0);
                    setPreviewRows([]);
                    setColumnStats([]);
                    setDuplicateSamples([]);
                    setErrorReasonSummary([]);
                    setFileToken(null);
                    setPreset(null);
                    setDetectedPreset(null);
                  }}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  Import Another File
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
  );
}

/**
 * The /import route since the fold: a query-preserving redirect into Data
 * Enrichment's "Import contacts" tab (same protocol as /find-prospects).
 */
export default function ImportContactsRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(tabRedirectUrl("Import contacts", window.location.search), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/* ─── Import history ─────────────────────────────────────────────────────
 * The server has recorded every import (contact_imports) since the feature
 * shipped; imports.getHistory returned them to nobody. Rendered only when
 * there is history — a first-run user sees no empty box. */
function ImportHistoryCard() {
  const { data: history = [] } = trpc.imports.getHistory.useQuery({ limit: 8 });
  const [openId, setOpenId] = useState<number | null>(null);
  if (!Array.isArray(history) || history.length === 0) return null;
  const when = (d: unknown) => {
    const dt = new Date(d as string);
    return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Recent imports</CardTitle>
        <CardDescription className="text-xs">Every committed import, newest first. Open one to see the rows it did not import and why, download the full report, or undo it.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border divide-y">
          {/* A row opens its errors (audit 2026-10-20, U27): it showed a count and led nowhere. */}
          {(history as any[]).map((h) => (
            <div key={h.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-xs cursor-pointer hover:bg-muted/40" {...pressable(() => setOpenId(h.id))}>
              <FileText className="size-3.5 shrink-0 self-center text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{h.filename}</span>
              <span className="shrink-0 tabular-nums text-emerald-700 dark:text-emerald-400">{h.importedRows} imported</span>
              {h.skippedRows > 0 && <span className="shrink-0 tabular-nums text-amber-700 dark:text-amber-400">{h.skippedRows} skipped</span>}
              {h.errorRows > 0 && <span className="shrink-0 tabular-nums text-red-700 dark:text-red-400">{h.errorRows} errors</span>}
              <span className={`shrink-0 ${h.status === "failed" ? "text-red-600" : "text-muted-foreground"}`}>{h.undoneAt ? "undone" : h.status}</span>
              <span className="shrink-0 text-muted-foreground">{when(h.createdAt)}</span>
              <ChevronRight className="size-3.5 shrink-0 self-center text-muted-foreground" />
            </div>
          ))}
        </div>
      </CardContent>
      {openId != null && <ImportDetailDialog importId={openId} onClose={() => setOpenId(null)} />}
    </Card>
  );
}

/** One import: the rows it did not import, a page at a time, the full report, and Undo (U27, F32). */
function ImportDetailDialog({ importId, onClose }: { importId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const PER = 50;
  const q = trpc.imports.getImport.useQuery({ importId, page, perPage: PER }, { placeholderData: (prev) => prev });
  const rec = q.data?.record as any;
  const total = q.data?.errorTotal ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER));
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      const r = await utils.imports.errorReport.fetch({ importId });
      saveCsv(r.csv, r.filename);
    } catch (err: any) {
      toast.error(err.message ?? "Could not build the error report.");
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{rec?.filename ?? "Import"}</DialogTitle></DialogHeader>
        {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : q.error ? <p className="text-sm text-destructive">{q.error.message}</p> : (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {rec?.importedRows ?? 0} imported · {rec?.skippedRows ?? 0} skipped as duplicates · {rec?.errorRows ?? 0} errors
              {rec?.destination ? ` · into ${rec.destination === "prospects" ? "People" : "CRM contacts"}` : ""}
              {rec?.preset === "leadrocks" ? " · LeadRocks preset" : ""}
              {rec?.undoneAt ? ` · undone ${new Date(rec.undoneAt).toLocaleString()}` : ""}
            </p>
            {total === 0 ? <p className="text-xs text-muted-foreground">Every row was imported.</p> : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{total.toLocaleString()} row{total === 1 ? "" : "s"} not imported</span>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={downloading} onClick={() => void download()}>
                    <Download className="h-3 w-3" /> Download the full report
                  </Button>
                </div>
                <div className="max-h-72 overflow-y-auto rounded-lg border divide-y">
                  {(q.data?.errorRows ?? []).map((r: any) => (
                    <div key={r.id} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                      <span className="shrink-0 tabular-nums text-muted-foreground">Row {r.rowIndex}</span>
                      <span className={r.status === "duplicate" ? "text-amber-700 dark:text-amber-400" : "text-destructive"}>{r.errorReason ?? r.status}</span>
                    </div>
                  ))}
                </div>
                {pages > 1 && (
                  <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                    <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <span>Page {page} of {pages}</span>
                    <Button size="sm" variant="outline" className="h-7" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                )}
              </>
            )}
            {rec && !rec.undoneAt && rec.status === "completed" && (
              <div className="border-t pt-3">
                <UndoImportButton importId={importId} onUndone={() => { utils.imports.getImport.invalidate({ importId }); utils.imports.getHistory.invalidate(); }} />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Undo this import" (F32): removes what this import created and nothing
 * else. Asked first, with what is kept; the removed rows stay in the audit
 * log, from which they can be restored.
 */
function UndoImportButton({ importId, onUndone }: { importId: number; onUndone?: () => void }) {
  const utils = trpc.useUtils();
  const undo = trpc.imports.undo.useMutation({
    onSuccess: (s) => {
      toast.success(`Import undone: ${s.removedPeople + s.removedContacts} record${s.removedPeople + s.removedContacts === 1 ? "" : "s"} removed${s.removedCompanies ? `, ${s.removedCompanies} compan${s.removedCompanies === 1 ? "y" : "ies"}` : ""}`, {
        description: s.keptInUse ? `${s.keptInUse} kept: promoted, enrolled, in a campaign or on a deal since the import.` : undefined,
      });
      utils.prospects.list.invalidate();
      onUndone?.();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs text-destructive" disabled={undo.isPending}
      onClick={() => confirmAction({
        title: "Undo this import?",
        description: "This deletes the people or contacts this import created, and the companies it created that nothing else uses. Rows that were promoted, enrolled in a sequence, put in a campaign or put on a deal since are kept. Nothing else is touched. The removed rows are kept in the audit log.",
        confirmLabel: "Undo the import",
      }, () => undo.mutate({ importId }))}>
      {undo.isPending ? <RefreshCw className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} Undo this import
    </Button>
  );
}
