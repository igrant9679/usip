/**
 * Prospect Import Dialog — LeadRocks CSV upload wizard.
 *
 * Three-step flow (compressed into one Dialog with conditional content):
 *   1. Upload — drag/drop or file picker, parse on submit
 *   2. Preview — server-rendered stats + first 10 rows
 *   3. Result — created / errored counts after commit
 *
 * The CSV is read client-side via FileReader.readAsText and sent as plain
 * UTF-8 in the tRPC body (no base64 — the body parser is already configured
 * for 50 MB). Server caps at 50,000 rows.
 */

import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Upload, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";

type Step = "upload" | "preview" | "result";

type PreviewSample = {
  firstName: string;
  lastName: string;
  linkedinUrl: string;
  title: string | null;
  company: string | null;
  companyDomain: string | null;
  email: string | null;
  emailStatus: string | null;
  emailRawStatus: string | null;
  emailSource: "work" | "direct" | null;
  phone: string | null;
};

type PreviewResult = {
  importToken: string;
  format: string;
  filename: string;
  totalRows: number;
  unmappableRows: number;
  duplicateInFile: number;
  alreadyExisting: number;
  toImport: number;
  withEmailRows: number;
  withoutEmailRows: number;
  sample: PreviewSample[];
};

type CommitResult = {
  filename: string;
  attempted: number;
  created: number;
  errored: number;
};

export function ProspectImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [filename, setFilename] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const parsePreview = trpc.prospectImports.parsePreview.useMutation({
    onSuccess: (res) => {
      setPreview(res as PreviewResult);
      setStep("preview");
    },
    onError: (e) => toast.error(e.message),
  });

  const commit = trpc.prospectImports.commit.useMutation({
    onSuccess: (res) => {
      setResult(res);
      setStep("result");
      onImported();
    },
    onError: (e) => toast.error(e.message),
  });

  const discard = trpc.prospectImports.discard.useMutation();

  const reset = () => {
    if (preview && step === "preview") {
      // Best-effort cleanup of the server-side draft
      discard.mutate({ importToken: preview.importToken });
    }
    setStep("upload");
    setFilename("");
    setPreview(null);
    setResult(null);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please pick a .csv file.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast.error("File is larger than 50 MB. Split it into smaller batches.");
      return;
    }
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const csv = reader.result as string;
      parsePreview.mutate({ csv, filename: file.name });
    };
    reader.onerror = () => toast.error("Could not read file.");
    reader.readAsText(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import prospects from CSV</DialogTitle>
          <DialogDescription>
            LeadRocks-style export. We pick the best email per row by status,
            dedup by LinkedIn URL, and skip rows already in your workspace.
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <div
            className={`mt-2 border-2 border-dashed rounded-lg p-10 text-center transition-colors ${
              dragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <div className="text-sm font-medium mb-1">
              {parsePreview.isPending ? "Parsing…" : "Drop your CSV here"}
            </div>
            <div className="text-xs text-muted-foreground mb-4">
              or click to pick a file · up to 50 MB / 50,000 rows
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsePreview.isPending}
            >
              {parsePreview.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              Choose file
            </Button>
            {filename && (
              <div className="text-xs text-muted-foreground mt-3">{filename}</div>
            )}
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-4 mt-2">
            <div className="rounded-md border bg-muted/30 p-4 grid grid-cols-2 gap-3 text-sm">
              <Stat label="File" value={preview.filename} />
              <Stat label="Format" value={preview.format} mono />
              <Stat label="Total rows in file" value={preview.totalRows.toLocaleString()} />
              <Stat
                label="Already in workspace"
                value={preview.alreadyExisting.toLocaleString()}
                hint="Skipped (same LinkedIn URL)"
              />
              <Stat
                label="Duplicates within file"
                value={preview.duplicateInFile.toLocaleString()}
                hint="Same LinkedIn URL twice"
              />
              <Stat
                label="Unmappable rows"
                value={preview.unmappableRows.toLocaleString()}
                hint="Missing name or LinkedIn URL"
              />
              <Stat label="With email" value={preview.withEmailRows.toLocaleString()} />
              <Stat label="Without email" value={preview.withoutEmailRows.toLocaleString()} />
            </div>

            <div className="rounded-md border bg-green-50 border-green-200 p-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-green-800">
                <CheckCircle2 className="h-5 w-5" />
                <div>
                  <div className="text-sm font-semibold">
                    {preview.toImport.toLocaleString()} new prospects ready to import
                  </div>
                  <div className="text-xs">
                    {preview.withEmailRows.toLocaleString()} of these will have an email pre-filled —
                    run "Find contact info" later for the rest.
                  </div>
                </div>
              </div>
            </div>

            {preview.sample.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Preview (first {preview.sample.length})
                </div>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="text-left p-2">Name</th>
                        <th className="text-left p-2">Title</th>
                        <th className="text-left p-2">Company</th>
                        <th className="text-left p-2">Email</th>
                        <th className="text-left p-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((p, i) => (
                        <tr key={`${p.linkedinUrl}-${i}`} className="border-t">
                          <td className="p-2 font-medium">
                            {p.firstName} {p.lastName}
                          </td>
                          <td className="p-2 text-muted-foreground">{p.title ?? "—"}</td>
                          <td className="p-2">
                            <div>{p.company ?? "—"}</div>
                            {p.companyDomain && (
                              <div className="text-muted-foreground text-[10px]">
                                {p.companyDomain}
                              </div>
                            )}
                          </td>
                          <td className="p-2 font-mono">{p.email ?? "—"}</td>
                          <td className="p-2">
                            {p.emailRawStatus && (
                              <Badge variant="outline" className="text-[10px]">
                                {p.emailRawStatus}
                                {p.emailSource ? ` · ${p.emailSource}` : ""}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={reset} disabled={commit.isPending}>
                <Trash2 className="h-4 w-4 mr-2" />
                Discard & re-upload
              </Button>
              <Button
                onClick={() => commit.mutate({ importToken: preview.importToken })}
                disabled={commit.isPending || preview.toImport === 0}
              >
                {commit.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                )}
                Import {preview.toImport.toLocaleString()} prospect
                {preview.toImport === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="mt-2 space-y-4">
            <div className="rounded-md border bg-green-50 border-green-200 p-6 text-center">
              <CheckCircle2 className="h-10 w-10 text-green-700 mx-auto mb-3" />
              <div className="text-lg font-semibold text-green-900">
                {result.created.toLocaleString()} prospects imported
              </div>
              <div className="text-sm text-green-800 mt-1">from {result.filename}</div>
            </div>

            {result.errored > 0 && (
              <div className="rounded-md border bg-yellow-50 border-yellow-200 p-3 flex gap-2 items-start">
                <AlertCircle className="h-4 w-4 text-yellow-700 mt-0.5" />
                <div className="text-sm text-yellow-800">
                  <div className="font-medium">
                    {result.errored.toLocaleString()} row{result.errored === 1 ? "" : "s"} failed
                  </div>
                  <div className="text-xs">
                    Likely a race-condition duplicate. Re-importing the same file should be a no-op.
                  </div>
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              Next step: select prospects and use "Find contact info" to fill emails for the
              rows that came in without one, and to verify the ones that did.
            </div>

            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${mono ? "font-mono" : ""}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
