import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Field, FormDialog, SelectField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { EmailVerificationBadge } from "@/components/usip/EmailVerificationBadge";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Users,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
} from "lucide-react";
import { toast } from "sonner";

/* ─── Bulk Verify Modal ─────────────────────────────────────────────────── */
function BulkVerifyModal({
  open,
  onOpenChange,
  contactIds,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactIds: number[];
  onComplete: () => void;
}) {
  const [jobId, setJobId] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "done" | "error">("idle");
  const [summary, setSummary] = useState<{ valid: number; invalid: number; risky: number; acceptAll: number; unknown: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utils = trpc.useUtils();

  const startBulk = trpc.emailVerification.verifyBulk.useMutation({
    onSuccess: (data) => {
      setJobId(data.jobId);
      setStatus("running");
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to start verification job.");
      setStatus("error");
    },
  });

  // Start polling when jobId is set
  useEffect(() => {
    if (!jobId || status !== "running") return;
    pollRef.current = setInterval(async () => {
      try {
        const result = await utils.emailVerification.getBulkJobStatus.fetch({ jobId });
        setProgress(result.progressPct ?? 0);
        if (result.status === "completed") {
          clearInterval(pollRef.current!);
          setStatus("done");
          utils.contacts.list.invalidate();
          onComplete();
        } else if (result.status === "failed") {
          clearInterval(pollRef.current!);
          setStatus("error");
        }
      } catch {
        // ignore transient poll errors
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, status]);

  // Reset when modal closes
  useEffect(() => {
    if (!open) {
      setJobId(null);
      setProgress(0);
      setStatus("idle");
      setSummary(null);
      if (pollRef.current) clearInterval(pollRef.current);
    }
  }, [open]);

  function handleStart() {
    setStatus("starting");
    startBulk.mutate({ contactIds });
  }

  const emailCount = contactIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[#14B89A]" />
            Bulk Email Verification
          </DialogTitle>
          <DialogDescription>
            Verify {emailCount} email address{emailCount !== 1 ? "es" : ""} using Reoon Power Mode.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {status === "idle" && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contacts selected</span>
                  <span className="font-medium">{emailCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Verification mode</span>
                  <span className="font-medium">Reoon Power Mode</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Estimated time</span>
                  <span className="font-medium">~{Math.max(1, Math.ceil(emailCount / 100))} min</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Results will be applied to each contact record automatically. You can close this dialog and check back later.
              </p>
              <Button onClick={handleStart} className="w-full gap-2">
                <ShieldCheck className="h-4 w-4" />
                Start Verification
              </Button>
            </div>
          )}

          {status === "starting" && (
            <div className="flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Starting verification job…
            </div>
          )}

          {status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Verifying emails…
                </span>
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground text-center">
                This may take a few minutes. You can close this dialog — results will be saved automatically.
              </p>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                Close and continue working
              </Button>
            </div>
          )}

          {status === "done" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-700">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-semibold">Verification complete</span>
              </div>
              {summary && (
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg border bg-green-50 p-2">
                    <p className="text-lg font-bold text-green-700">{summary.valid}</p>
                    <p className="text-green-600">Valid</p>
                  </div>
                  <div className="rounded-lg border bg-yellow-50 p-2">
                    <p className="text-lg font-bold text-yellow-700">{summary.acceptAll + summary.risky}</p>
                    <p className="text-yellow-600">Risky</p>
                  </div>
                  <div className="rounded-lg border bg-red-50 p-2">
                    <p className="text-lg font-bold text-red-700">{summary.invalid}</p>
                    <p className="text-red-600">Invalid</p>
                  </div>
                </div>
              )}
              <Button onClick={() => onOpenChange(false)} className="w-full">
                Done
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span className="font-semibold">Verification failed</span>
              </div>
              <p className="text-sm text-muted-foreground">
                The verification job encountered an error. Please check your Reoon API key in Settings → Integrations and try again.
              </p>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                Close
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Main Contacts page ────────────────────────────────────────────────── */
export default function Contacts() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkVerifyOpen, setBulkVerifyOpen] = useState(false);

  const utils = trpc.useUtils();
  const { data } = trpc.contacts.list.useQuery({ search });
  const { data: accounts } = trpc.accounts.list.useQuery();

  const create = trpc.contacts.create.useMutation({
    onSuccess: () => {
      utils.contacts.list.invalidate();
      setOpen(false);
      toast.success("Contact added");
    },
  });

  const allIds = (data ?? []).map((c) => c.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  }

  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Only select contacts that have an email address for bulk verify
  const verifiableIds = Array.from(selectedIds).filter((id) =>
    (data ?? []).find((c) => c.id === id && c.email),
  );

  return (
    <Shell title="Contacts">
      <PageHeader title="Contacts" description="People at your accounts.">
        <Input
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-56"
        />
        {someSelected && (
          <Button
            variant="outline"
            onClick={() => setBulkVerifyOpen(true)}
            disabled={verifiableIds.length === 0}
            className="gap-2"
          >
            <ShieldCheck className="h-4 w-4 text-[#14B89A]" />
            Verify Emails ({verifiableIds.length})
          </Button>
        )}
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" /> New contact
        </Button>
      </PageHeader>

      <div className="p-6">
        {(data ?? []).length === 0 ? (
          <EmptyState icon={Users} title="No contacts" description="Add one or convert a lead." />
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="rounded border-gray-300 cursor-pointer"
                      title="Select all"
                    />
                  </th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-left px-3 py-2">Account</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2 w-28">Verified</th>
                  <th className="text-left px-3 py-2">Phone</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(data ?? []).map((c) => (
                  <tr
                    key={c.id}
                    className={`hover:bg-secondary/30 cursor-pointer ${selectedIds.has(c.id) ? "bg-primary/5" : ""}`}
                    onClick={() =>
                      setDrawer({
                        id: c.id,
                        name: `${c.firstName} ${c.lastName}`,
                        subtitle: `${c.title ?? ""} · ${(c as any).accountName ?? ""}`,
                      })
                    }
                  >
                    <td
                      className="px-3 py-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleOne(c.id);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleOne(c.id)}
                        className="rounded border-gray-300 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <span className="underline-offset-2 hover:underline">
                        {c.firstName} {c.lastName}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{c.title}</td>
                    <td className="px-3 py-2 text-muted-foreground">{(c as any).accountName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.email}</td>
                    <td className="px-3 py-2">
                      {c.email ? (
                        <EmailVerificationBadge
                          status={c.emailVerificationStatus}
                          verifiedAt={c.emailVerifiedAt}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{c.phone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* New contact dialog */}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="New contact"
        isPending={create.isPending}
        onSubmit={(f) =>
          create.mutate({
            firstName: String(f.get("firstName")),
            lastName: String(f.get("lastName")),
            email: String(f.get("email") ?? "") || undefined,
            title: String(f.get("title") ?? "") || undefined,
            phone: String(f.get("phone") ?? "") || undefined,
            accountId: Number(f.get("accountId")) || undefined,
          })
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field name="firstName" label="First name" required />
          <Field name="lastName" label="Last name" required />
        </div>
        <Field name="email" label="Email" type="email" />
        <Field name="title" label="Title" />
        <Field name="phone" label="Phone" />
        <SelectField
          name="accountId"
          label="Account"
          options={[
            { value: "", label: "—" },
            ...((accounts ?? []).map((a) => ({ value: String(a.id), label: a.name }))),
          ]}
        />
      </FormDialog>

      {/* Record drawer */}
      <RecordDrawer
        open={!!drawer}
        onOpenChange={(v) => !v && setDrawer(null)}
        relatedType="contact"
        relatedId={drawer?.id ?? null}
        title={drawer?.name ?? ""}
        subtitle={drawer?.subtitle}
      />

      {/* Bulk verify modal */}
      <BulkVerifyModal
        open={bulkVerifyOpen}
        onOpenChange={setBulkVerifyOpen}
        contactIds={verifiableIds}
        onComplete={() => {
          setSelectedIds(new Set());
          utils.contacts.list.invalidate();
        }}
      />
    </Shell>
  );
}
