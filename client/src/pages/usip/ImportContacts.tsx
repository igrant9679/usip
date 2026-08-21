import { useState, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader } from "@/components/usip/Shell";
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
  findDuplicateFieldMappings,
  isFieldRequiredFor,
  missingRequiredMappings,
  requiredFieldsFor,
} from "@shared/importFields";

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

/* ─── Main component ────────────────────────────────────────────────────── */
export default function ImportContacts() {
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

  // Step 3: validation results
  const [validCount, setValidCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
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
  const validateRowsMutation = trpc.imports.validateRows.useMutation();
  const commitMutation = trpc.imports.commit.useMutation();

  /* ── Step 1: File upload ── */
  function handleFile(f: File) {
    if (!f.name.endsWith(".csv")) {
      toast.error("Please upload a .csv file.");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast.error("File is too large. Maximum size is 10 MB.");
      return;
    }
    setFile(f);
    setFilename(f.name);
    const reader = new FileReader();
    reader.onload = (e) => setCsvText(e.target?.result as string ?? "");
    reader.readAsText(f);
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
      const result = await parseCSVMutation.mutateAsync({ csvText, filename });
      setHeaders(result.headers);
      setTotalParsedRows(result.totalRows ?? 0);
      setPreviewRows((result.previewRows as Array<Record<string, string>>) ?? []);
      setColumnStats(((result as any).columnStats as typeof columnStats) ?? []);
      // Exact label / key / alias matching, one column per field — see
      // shared/importFields.ts for why this is not a similarity match.
      setFieldMapping(autoMapHeaders(result.headers));
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
      const result = await validateRowsMutation.mutateAsync({
        csvText,
        filename,
        fieldMapping,
        matchOnNameCompany: override?.matchOnNameCompany ?? matchOnNameCompany,
        destination,
        // Both dedupe settings must reach the preview, or its counts describe a
        // different import than the one the button performs.
        skipDuplicates: override?.skipDuplicates ?? skipDuplicates,
      } as any);
      setValidCount(result.validCount);
      setDuplicateCount(result.duplicateCount);
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
      const result = await commitMutation.mutateAsync({
        csvText,
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
  function downloadErrorReport() {
    const lines = [
      "Row,Reason",
      ...errorRows.map((r) => `${r.rowIndex},"${r.reason.replace(/"/g, '""')}"`),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${filename}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalRows = totalRowCount || validCount + duplicateCount + errorRows.length;

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
    <Shell>
      <PageHeader
        title="Import Contacts" pageKey="import-contacts"
        description="Bulk-import contacts from a CSV file, enrichment providers, or third-party integrations. Map columns, validate data, and resolve duplicates before committing records to your CRM."
      
        icon={<Upload className="size-5" />}
      />

      <div className="max-w-4xl">
        <StepIndicator current={step} />

        {/* ── Step 1: Upload ── */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Upload CSV File</CardTitle>
              <CardDescription>
                Supported: .csv files up to 50,000 rows and 10 MB. Required columns: First Name,
                Last Name. You will map columns in the next step.
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
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
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
                  or LinkedIn Sales Navigator as CSV. Include at minimum: First Name, Last Name, and Email.
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
                      <span className="bg-emerald-500" style={{ width: `${(validCount / totalRows) * 100}%` }} />
                      <span className="bg-amber-400" style={{ width: `${(duplicateCount / totalRows) * 100}%` }} />
                      <span className="bg-red-500" style={{ width: `${(errorRows.length / totalRows) * 100}%` }} />
                    </div>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {totalRows.toLocaleString()} rows — {Math.round((validCount / totalRows) * 100)}% ready ·{" "}
                      {Math.round((duplicateCount / totalRows) * 100)}% duplicates · {Math.round((errorRows.length / totalRows) * 100)}% errors
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border bg-green-50 dark:bg-green-950/40 p-3 text-center">
                    <p className="text-2xl font-bold text-green-700 dark:text-green-300">{validCount}</p>
                    <p className="text-xs text-green-600 dark:text-green-300 mt-0.5">Ready to import</p>
                  </div>
                  <div className="rounded-lg border bg-yellow-50 dark:bg-yellow-950/40 p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">{duplicateCount}</p>
                    <p className="text-xs text-yellow-600 dark:text-yellow-300 mt-0.5">Duplicates found</p>
                  </div>
                  <div className="rounded-lg border bg-red-50 dark:bg-red-950/40 p-3 text-center">
                    <p className="text-2xl font-bold text-red-700 dark:text-red-300">{errorRows.length}</p>
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
                    <Switch
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
                      <Switch
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

                {errorRows.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
                        <AlertCircle className="h-4 w-4" />
                        {errorRows.length} rows with errors (will be skipped)
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
                      {errorRows.length > 20 && (
                        <p className="px-3 py-1.5 text-xs text-muted-foreground">
                          … and {errorRows.length - 20} more. Download the full report above.
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
                disabled={validCount === 0 && (skipDuplicates || duplicateCount === 0)}
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
                    {validCount + (skipDuplicates ? 0 : duplicateCount)}
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
                  <span className="font-medium text-red-700 dark:text-red-300">{errorRows.length} (skipped)</span>
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
                      Import {validCount + (skipDuplicates ? 0 : duplicateCount)} Contacts
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

              <div className="flex justify-center gap-3 pt-2">
                {/* The CTA follows the DESTINATION — "View Contacts" after a
                    prospects import pointed at a page the rows are not on. */}
                <Link href={destination === "prospects" ? "/prospects" : "/v2/people"}>
                  <Button className="gap-2">
                    <Users className="h-4 w-4" />
                    {destination === "prospects" ? "View Prospects" : "View People"}
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
                    setValidCount(0);
                    setDuplicateCount(0);
                    setErrorRows([]);
                    setTotalRowCount(0);
                    setImportResult(null);
                    setTag("");
                    setTotalParsedRows(0);
                    setPreviewRows([]);
                    setColumnStats([]);
                    setDuplicateSamples([]);
                    setErrorReasonSummary([]);
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
    </Shell>
  );
}

/* ─── Import history ─────────────────────────────────────────────────────
 * The server has recorded every import (contact_imports) since the feature
 * shipped; imports.getHistory returned them to nobody. Rendered only when
 * there is history — a first-run user sees no empty box. */
function ImportHistoryCard() {
  const { data: history = [] } = trpc.imports.getHistory.useQuery({ limit: 8 });
  if (!Array.isArray(history) || history.length === 0) return null;
  const when = (d: unknown) => {
    const dt = new Date(d as string);
    return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Recent imports</CardTitle>
        <CardDescription className="text-xs">Every committed import, newest first — the label you set is recorded on each contact as provenance.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border divide-y">
          {(history as any[]).map((h) => (
            <div key={h.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
              <FileText className="size-3.5 shrink-0 self-center text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{h.filename}</span>
              <span className="shrink-0 tabular-nums text-emerald-700 dark:text-emerald-400">{h.importedRows} imported</span>
              {h.skippedRows > 0 && <span className="shrink-0 tabular-nums text-amber-700 dark:text-amber-400">{h.skippedRows} skipped</span>}
              {h.errorRows > 0 && <span className="shrink-0 tabular-nums text-red-700 dark:text-red-400">{h.errorRows} errors</span>}
              <span className={`shrink-0 ${h.status === "failed" ? "text-red-600" : "text-muted-foreground"}`}>{h.status}</span>
              <span className="shrink-0 text-muted-foreground">{when(h.createdAt)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
