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

  // Step 2: field mapping
  const [headers, setHeaders] = useState<string[]>([]);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string | null>>({});

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

  // Step 4: import result
  const [importResult, setImportResult] = useState<{
    importId: number;
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    errorRows: number;
  } | null>(null);

  /* ── tRPC mutations ── */
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

  return (
    <Shell>
      <PageHeader
        title="Import Contacts" pageKey="import-contacts"
        description="Bulk-import contacts from a CSV file, enrichment providers, or third-party integrations. Map columns, validate data, and resolve duplicates before committing records to your CRM."
      
        icon={<Upload className="size-5" />}
      />

      <div className="max-w-3xl">
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

        {/* ── Step 2: Map Fields ── */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Map CSV Columns to Contact Fields</CardTitle>
              <CardDescription>
                Match each column in your CSV to a Velocity contact field. Required fields are marked
                with *.
              </CardDescription>
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
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                          {header}
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
                    ? "Rows become contacts immediately. Nothing verifies their email addresses."
                    : "Rows join the prospect backlog. The enrichment sweeper finds and verifies an address for each one, and only those that come back verified are promoted to contacts — where your segment rules can enrol them."}
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
                  Your contacts have been added to the workspace.
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
                <Link href="/v2/people">
                  <Button className="gap-2">
                    <Users className="h-4 w-4" />
                    View Contacts
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
