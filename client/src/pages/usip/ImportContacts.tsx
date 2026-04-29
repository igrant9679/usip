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

/* ─── System fields definition (mirrors backend SYSTEM_FIELDS) ──────────── */
const SYSTEM_FIELDS = [
  { key: "firstName", label: "First Name", required: true },
  { key: "lastName", label: "Last Name", required: true },
  { key: "email", label: "Email", required: false },
  { key: "phone", label: "Phone", required: false },
  { key: "title", label: "Job Title", required: false },
  { key: "company", label: "Company", required: false },
  { key: "linkedinUrl", label: "LinkedIn URL", required: false },
  { key: "website", label: "Website", required: false },
  { key: "industry", label: "Industry", required: false },
  { key: "city", label: "City", required: false },
  { key: "state", label: "State / Region", required: false },
  { key: "country", label: "Country", required: false },
  { key: "seniority", label: "Seniority", required: false },
];

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
  valid: { label: "Valid", className: "bg-green-100 text-green-700 border-green-200" },
  accept_all: { label: "Accept-All", className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  risky: { label: "Risky", className: "bg-orange-100 text-orange-700 border-orange-200" },
  invalid: { label: "Invalid", className: "bg-red-100 text-red-700 border-red-200" },
  unknown: { label: "Unknown", className: "bg-gray-100 text-gray-500 border-gray-200" },
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
      // Auto-map: try to match CSV headers to system fields by label similarity
      const autoMapping: Record<string, string | null> = {};
      result.headers.forEach((h) => {
        const normalized = h.toLowerCase().replace(/[^a-z0-9]/g, "");
        const match = SYSTEM_FIELDS.find((f) => {
          const fNorm = f.label.toLowerCase().replace(/[^a-z0-9]/g, "");
          const kNorm = f.key.toLowerCase();
          return normalized === fNorm || normalized === kNorm ||
            normalized.includes(kNorm) || kNorm.includes(normalized);
        });
        autoMapping[h] = match?.key ?? null;
      });
      setFieldMapping(autoMapping);
      setStep(2);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to parse CSV.");
    }
  }

  /* ── Step 3: Validate ── */
  async function handleValidate() {
    try {
      const result = await validateRowsMutation.mutateAsync({
        csvText,
        filename,
        fieldMapping,
      });
      setValidCount(result.validCount);
      setDuplicateCount(result.duplicateCount);
      setErrorRows(result.errorRows);
      setTotalRowCount(result.totalRows);
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
        postImportActions: { tag: tag || undefined },
      });
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
                    ? "border-green-400 bg-green-50"
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
                    <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto" />
                    <p className="font-medium text-green-700">{file.name}</p>
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

              <Alert className="border-blue-200 bg-blue-50">
                <Info className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800 text-sm">
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
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">CSV Column</th>
                      <th className="text-left px-4 py-2 font-medium">Maps to Velocity Field</th>
                    </tr>
                  </thead>
                  <tbody>
                    {headers.map((header) => (
                      <tr key={header} className="border-t">
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
                                  {f.required && (
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
                </table>
              </div>

              <p className="text-xs text-muted-foreground">
                <span className="text-destructive">*</span> Required fields: First Name, Last Name
              </p>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={handleValidate}
                  disabled={validateRowsMutation.isPending}
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
                  <div className="rounded-lg border bg-green-50 p-3 text-center">
                    <p className="text-2xl font-bold text-green-700">{validCount}</p>
                    <p className="text-xs text-green-600 mt-0.5">Ready to import</p>
                  </div>
                  <div className="rounded-lg border bg-yellow-50 p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-700">{duplicateCount}</p>
                    <p className="text-xs text-yellow-600 mt-0.5">Duplicates found</p>
                  </div>
                  <div className="rounded-lg border bg-red-50 p-3 text-center">
                    <p className="text-2xl font-bold text-red-700">{errorRows.length}</p>
                    <p className="text-xs text-red-600 mt-0.5">Errors (will skip)</p>
                  </div>
                </div>

                {duplicateCount > 0 && (
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">Skip duplicate emails?</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {duplicateCount} rows match existing contacts by email
                      </p>
                    </div>
                    <Switch
                      checked={skipDuplicates}
                      onCheckedChange={setSkipDuplicates}
                    />
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

                <div className="space-y-2">
                  <Label htmlFor="tag">Tag imported contacts (optional)</Label>
                  <Input
                    id="tag"
                    placeholder="e.g. Q2-2026-import, tradeshow-leads"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Adds a tag to all imported contacts for easy filtering later.
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
                  <span className="font-medium text-green-700">
                    {validCount + (skipDuplicates ? 0 : duplicateCount)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Duplicates</span>
                  <span className="font-medium text-yellow-700">
                    {skipDuplicates ? `${duplicateCount} (skipped)` : `${duplicateCount} (included)`}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Rows with errors</span>
                  <span className="font-medium text-red-700">{errorRows.length} (skipped)</span>
                </div>
                {tag && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Tag</span>
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
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-green-600" />
                </div>
              </div>
              <div>
                <h2 className="text-xl font-bold">Import Complete</h2>
                <p className="text-muted-foreground mt-1">
                  Your contacts have been added to the workspace.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 max-w-xs mx-auto">
                <div className="rounded-lg border bg-green-50 p-3 text-center">
                  <p className="text-2xl font-bold text-green-700">{importResult.importedRows}</p>
                  <p className="text-xs text-green-600">Imported</p>
                </div>
                <div className="rounded-lg border bg-yellow-50 p-3 text-center">
                  <p className="text-2xl font-bold text-yellow-700">{importResult.skippedRows}</p>
                  <p className="text-xs text-yellow-600">Skipped</p>
                </div>
                <div className="rounded-lg border bg-red-50 p-3 text-center">
                  <p className="text-2xl font-bold text-red-700">{importResult.errorRows}</p>
                  <p className="text-xs text-red-600">Errors</p>
                </div>
              </div>

              <div className="flex justify-center gap-3 pt-2">
                <Link href="/contacts">
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
