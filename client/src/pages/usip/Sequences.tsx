import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RichTextEditor } from "@/components/usip/RichTextEditor";
import { trpc } from "@/lib/trpc";
import {
  Activity, GitBranch, Pause, Play, Plus, Power, CheckCircle2, XCircle,
  BarChart3, RefreshCw, Pencil, Trash2, ArrowUp, ArrowDown, Mail, Clock, ClipboardList, TrendingUp,
  FlaskConical, Trophy, Loader2, ListOrdered, UserPlus
} from "lucide-react";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";

// ─── Types ───────────────────────────────────────────────────────────────────
type StepType = "email" | "wait" | "task";
interface EmailStep { type: "email"; subject: string; body?: string; templateId?: number }

/**
 * Strip HTML tags and decode common entities into a plaintext preview.
 * Used by the right-panel step summary so RichTextEditor-encoded bodies
 * (which store HTML) render as readable text in the line-clamped
 * preview rather than as visible markup.
 */
function htmlToPlainText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
interface WaitStep { type: "wait"; days: number }
interface TaskStep { type: "task"; body: string }
type Step = EmailStep | WaitStep | TaskStep;

// ─── EnrollDialog ────────────────────────────────────────────────────────────
/**
 * Picker for bulk-enrolling contacts and/or leads into a sequence.
 * Two tabs (Contacts, Leads), each with a search box and multi-select
 * checkboxes. The "Enroll N selected" CTA submits one bulkEnroll
 * mutation per dialog confirm — server handles dedup + invalid-email
 * gating and returns granular counts that flow into the toast.
 */
function EnrollDialog({ sequenceId, open, onClose, onEnrolled }: {
  sequenceId: number;
  open: boolean;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [tab, setTab] = useState<"contacts" | "leads" | "prospects">("contacts");
  const [search, setSearch] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<number>>(new Set());
  const [selectedProspectIds, setSelectedProspectIds] = useState<Set<number>>(new Set());

  // Reset on every fresh open.
  useEffect(() => {
    if (open) {
      setTab("contacts");
      setSearch("");
      setSelectedContactIds(new Set());
      setSelectedLeadIds(new Set());
      setSelectedProspectIds(new Set());
    }
  }, [open]);

  // Important: don't gate these on `enabled: open` — that pattern was
  // returning empty data on first dialog open in some cases. The lists
  // are tiny and the cache is shared with the main sidebar pages, so
  // there's no real cost to loading them eagerly.
  const contactsQ = trpc.contacts.list.useQuery({});
  const leadsQ = trpc.leads.list.useQuery({});
  // Prospects: show ALL non-archived (verified + needs_review) so we
  // surface the entire workspace pool. Verification status is shown
  // as a per-row badge so users can spot risky ones. The server
  // promotes whichever ones get enrolled; the engine's per-message
  // suppression check handles outright-bad addresses at send time.
  const prospectsVerifiedQ = trpc.prospects.list.useQuery({ verificationStatus: "verified", page: 1, perPage: 200 });
  const prospectsNeedsReviewQ = trpc.prospects.list.useQuery({ verificationStatus: "needs_review", page: 1, perPage: 200 });

  // Already enrolled in this sequence — show a disabled checkbox + "already enrolled" label.
  const { data: existingEnrollments = [] } = trpc.sequences.listEnrollments.useQuery({ sequenceId }, { enabled: open });
  const alreadyContactIds = new Set<number>();
  const alreadyLeadIds = new Set<number>();
  for (const e of existingEnrollments as any[]) {
    if (e.status === "exited") continue;
    if (e.contactId) alreadyContactIds.add(e.contactId);
    if (e.leadId) alreadyLeadIds.add(e.leadId);
  }
  // Prospects can also be "already enrolled" via their linkedContactId
  // pointing at an already-enrolled contact. We compute that per-row
  // below using alreadyContactIds.

  const q = search.trim().toLowerCase();
  const filteredContacts = ((contactsQ.data ?? []) as any[]).filter((c) => {
    if (!q) return true;
    const hay = `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.email ?? ""} ${(c as any).accountName ?? ""} ${c.title ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
  const filteredLeads = ((leadsQ.data ?? []) as any[]).filter((l) => {
    if (!q) return true;
    const hay = `${l.firstName ?? ""} ${l.lastName ?? ""} ${l.email ?? ""} ${l.company ?? ""} ${l.title ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
  // prospects.list returns { data, total, page, perPage }. We merge
  // verified + needs_review pools so the picker shows the full
  // selectable workspace (200 each = 400 max, plenty for an interactive
  // dialog; if a workspace genuinely has more we can paginate later).
  const prospectsCombined: any[] = [
    ...(((prospectsVerifiedQ.data as any)?.data ?? []) as any[]),
    ...(((prospectsNeedsReviewQ.data as any)?.data ?? []) as any[]),
  ];
  const filteredProspects = prospectsCombined.filter((p) => {
    if (!q) return true;
    const hay = `${p.firstName ?? ""} ${p.lastName ?? ""} ${p.email ?? ""} ${p.companyName ?? p.company ?? ""} ${p.title ?? ""}`.toLowerCase();
    return hay.includes(q);
  });

  const bulkEnroll = trpc.sequences.bulkEnroll.useMutation({
    onSuccess: (r) => {
      const parts = [`Enrolled ${r.enrolled}`];
      if (r.skippedAlreadyEnrolled > 0) parts.push(`${r.skippedAlreadyEnrolled} already enrolled`);
      if (r.blockedInvalidEmail > 0) parts.push(`${r.blockedInvalidEmail} blocked (invalid email)`);
      toast.success(parts.join(" · "));
      onEnrolled();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const totalSelected = selectedContactIds.size + selectedLeadIds.size + selectedProspectIds.size;

  /** A prospect is "already enrolled" if its linked contact is in the
   *  alreadyContactIds set we computed from existing enrollments. */
  function isProspectAlreadyEnrolled(p: any): boolean {
    return typeof p.linkedContactId === "number" && alreadyContactIds.has(p.linkedContactId);
  }

  function toggleContact(id: number) {
    if (alreadyContactIds.has(id)) return;
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleLead(id: number) {
    if (alreadyLeadIds.has(id)) return;
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleProspect(p: any) {
    if (isProspectAlreadyEnrolled(p)) return;
    setSelectedProspectIds((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
      return next;
    });
  }
  function selectAllVisible() {
    if (tab === "contacts") {
      setSelectedContactIds((prev) => {
        const next = new Set(prev);
        for (const c of filteredContacts) if (!alreadyContactIds.has(c.id)) next.add(c.id);
        return next;
      });
    } else if (tab === "leads") {
      setSelectedLeadIds((prev) => {
        const next = new Set(prev);
        for (const l of filteredLeads) if (!alreadyLeadIds.has(l.id)) next.add(l.id);
        return next;
      });
    } else {
      setSelectedProspectIds((prev) => {
        const next = new Set(prev);
        for (const p of filteredProspects) if (!isProspectAlreadyEnrolled(p)) next.add(p.id);
        return next;
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Enroll prospects into sequence</DialogTitle>
        </DialogHeader>

        <div className="flex border-b shrink-0">
          {([
            { k: "contacts", label: "Contacts", count: filteredContacts.length },
            { k: "leads", label: "Leads", count: filteredLeads.length },
            { k: "prospects", label: "Prospects", count: filteredProspects.length },
          ] as const).map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
              className={`px-4 py-2 text-sm ${tab === t.k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
              {t.label} <span className="text-xs text-muted-foreground">({t.count})</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-3 shrink-0">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${tab}…`}
            className="h-8 text-sm"
          />
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={selectAllVisible}>
            Select all visible
          </Button>
        </div>

        {tab === "prospects" && (
          <p className="text-[11px] text-muted-foreground mt-2 px-1">
            Prospects are enrolled as-is — no auto-promotion to contacts. Shows
            verified + needs-review prospects from your workspace; status appears
            as a per-row badge. Prospects without an email are not selectable.
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto border rounded-md mt-2">
          {tab === "contacts" ? (
            contactsQ.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading contacts…</div>
            ) : contactsQ.error ? (
              <div className="p-4 text-sm text-destructive">Couldn't load contacts: {contactsQ.error.message}</div>
            ) : (contactsQ.data ?? []).length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No contacts in this workspace yet.</div>
            ) : filteredContacts.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No contacts match your search.</div>
            ) : (
              <ul className="divide-y">
                {filteredContacts.map((c: any) => {
                  const already = alreadyContactIds.has(c.id);
                  const checked = selectedContactIds.has(c.id);
                  return (
                    <li key={c.id} className={`flex items-center gap-3 p-2.5 text-sm ${already ? "opacity-50" : "hover:bg-muted/40 cursor-pointer"}`} onClick={() => toggleContact(c.id)}>
                      <input
                        type="checkbox"
                        checked={checked || already}
                        disabled={already}
                        onChange={() => toggleContact(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-gray-300 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{c.firstName} {c.lastName}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {c.email ?? "(no email)"}{c.title ? ` · ${c.title}` : ""}{(c as any).accountName ? ` · ${(c as any).accountName}` : ""}
                        </div>
                      </div>
                      {already && <span className="text-[10px] text-muted-foreground shrink-0">already enrolled</span>}
                    </li>
                  );
                })}
              </ul>
            )
          ) : tab === "leads" ? (
            leadsQ.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading leads…</div>
            ) : leadsQ.error ? (
              <div className="p-4 text-sm text-destructive">Couldn't load leads: {leadsQ.error.message}</div>
            ) : (leadsQ.data ?? []).length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No leads in this workspace yet.</div>
            ) : filteredLeads.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No leads match your search.</div>
            ) : (
              <ul className="divide-y">
                {filteredLeads.map((l: any) => {
                  const already = alreadyLeadIds.has(l.id);
                  const checked = selectedLeadIds.has(l.id);
                  return (
                    <li key={l.id} className={`flex items-center gap-3 p-2.5 text-sm ${already ? "opacity-50" : "hover:bg-muted/40 cursor-pointer"}`} onClick={() => toggleLead(l.id)}>
                      <input
                        type="checkbox"
                        checked={checked || already}
                        disabled={already}
                        onChange={() => toggleLead(l.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-gray-300 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{l.firstName} {l.lastName}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {l.email ?? "(no email)"}{l.title ? ` · ${l.title}` : ""}{l.company ? ` · ${l.company}` : ""}
                        </div>
                      </div>
                      {already && <span className="text-[10px] text-muted-foreground shrink-0">already enrolled</span>}
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            (prospectsVerifiedQ.isLoading || prospectsNeedsReviewQ.isLoading) ? (
              <div className="p-4 text-sm text-muted-foreground">Loading prospects…</div>
            ) : (prospectsVerifiedQ.error || prospectsNeedsReviewQ.error) ? (
              <div className="p-4 text-sm text-destructive">
                Couldn't load prospects: {(prospectsVerifiedQ.error ?? prospectsNeedsReviewQ.error)?.message}
              </div>
            ) : prospectsCombined.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No prospects in this workspace yet. Run discovery from <strong>Find Prospects</strong> or an ARE campaign first.
              </div>
            ) : filteredProspects.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No prospects match your search.</div>
            ) : (
              <ul className="divide-y">
                {filteredProspects.map((p: any) => {
                  const already = isProspectAlreadyEnrolled(p);
                  const noEmail = !p.email;
                  const disabled = already || noEmail;
                  const checked = selectedProspectIds.has(p.id);
                  const company = p.companyName ?? p.company ?? "";
                  const status = p.verificationStatus as string | undefined;
                  return (
                    <li key={p.id} className={`flex items-center gap-3 p-2.5 text-sm ${disabled ? "opacity-50" : "hover:bg-muted/40 cursor-pointer"}`} onClick={() => !disabled && toggleProspect(p)}>
                      <input
                        type="checkbox"
                        checked={checked || already}
                        disabled={disabled}
                        onChange={() => !disabled && toggleProspect(p)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-gray-300 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate flex items-center gap-1.5">
                          {p.firstName} {p.lastName}
                          {status === "needs_review" && (
                            <span className="text-[9px] px-1 py-0 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                              needs review
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {p.email ?? "(no email)"}{p.title ? ` · ${p.title}` : ""}{company ? ` · ${company}` : ""}
                        </div>
                      </div>
                      {already && <span className="text-[10px] text-muted-foreground shrink-0">already enrolled</span>}
                      {!already && noEmail && <span className="text-[10px] text-muted-foreground shrink-0">no email</span>}
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </div>

        <DialogFooter className="shrink-0 pt-2 border-t">
          <span className="text-xs text-muted-foreground self-center mr-auto">
            {totalSelected} selected
          </span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={totalSelected === 0 || bulkEnroll.isPending}
            onClick={() => bulkEnroll.mutate({
              sequenceId,
              contactIds: Array.from(selectedContactIds),
              leadIds: Array.from(selectedLeadIds),
              prospectIds: Array.from(selectedProspectIds),
            })}
          >
            {bulkEnroll.isPending ? "Enrolling…" : `Enroll ${totalSelected}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── EnrollmentStatsPanel ────────────────────────────────────────────────────
function EnrollmentStatsPanel({ sequenceId, steps }: { sequenceId: number; steps: any[] }) {
  const utils = trpc.useUtils();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const { data: stats, isLoading: statsLoading, refetch } = trpc.sequences.getEnrollmentStats.useQuery({ sequenceId });
  const { data: stepStats = [] } = trpc.sequences.getEnrollmentStepStats.useQuery({ sequenceId });
  const { data: enrollmentList = [], isLoading: listLoading } = trpc.sequences.listEnrollments.useQuery({ sequenceId });

  const resume = trpc.sequences.resumeEnrollment.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment resumed"); },
    onError: (e) => toast.error(e.message),
  });
  const exit = trpc.sequences.exitEnrollment.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment exited"); },
    onError: (e) => toast.error(e.message),
  });
  const pauseOnReply = trpc.sequences.pauseOnReply.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment paused (reply detected)"); },
    onError: (e) => toast.error(e.message),
  });

  const total = (stats?.active ?? 0) + (stats?.paused ?? 0) + (stats?.finished ?? 0) + (stats?.exited ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: "Active", value: stats?.active ?? 0, icon: Play, color: "text-emerald-600" },
          { label: "Paused", value: stats?.paused ?? 0, icon: Pause, color: "text-amber-600" },
          { label: "Finished", value: stats?.finished ?? 0, icon: CheckCircle2, color: "text-blue-600" },
          { label: "Exited", value: stats?.exited ?? 0, icon: XCircle, color: "text-muted-foreground" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="border">
            <CardContent className="p-3 flex items-center gap-2">
              <Icon className={`h-5 w-5 ${color} shrink-0`} />
              <div>
                <p className="text-xl font-bold tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {steps.length > 0 && stepStats.length > 0 && (
        <Section title="Step Performance">
          <div className="p-3 space-y-2">
            {steps.map((step, i) => {
              const count = stepStats.find((s: any) => s.step === i)?.count ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="w-16 text-xs text-muted-foreground font-mono shrink-0">Step {i + 1}</span>
                  <span className="w-14 text-xs capitalize text-muted-foreground shrink-0">{step.type}</span>
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div className="h-2 rounded-full bg-[#14B89A] transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs tabular-nums w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title={`Enrollments (${total})`} right={
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => setEnrollOpen(true)}>
            <UserPlus className="h-3 w-3 mr-1" /> Enroll
          </Button>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>
      }>
        {listLoading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        ) : enrollmentList.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No enrollments yet.</div>
        ) : (
          <ul className="divide-y">
            {enrollmentList.map((e: any) => (
              <li key={e.id} className="p-3 flex items-center gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-medium">Enrollment #{e.id}</span>
                  <span className="text-muted-foreground ml-2">· Step {e.currentStep + 1}</span>
                  {e.nextActionAt && (
                    <span className="text-xs text-muted-foreground ml-2">
                      · Next: {new Date(e.nextActionAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <StatusPill tone={e.status === "active" ? "success" : e.status === "paused" ? "warning" : e.status === "finished" ? "info" : "muted"}>{e.status}</StatusPill>
                <div className="flex gap-1 shrink-0">
                  {e.status === "paused" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => resume.mutate({ id: e.id })} disabled={resume.isPending}>Resume</Button>
                  )}
                  {e.status === "active" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-amber-600" onClick={() => pauseOnReply.mutate({ enrollmentId: e.id })} disabled={pauseOnReply.isPending}>Reply</Button>
                  )}
                  {(e.status === "active" || e.status === "paused") && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-muted-foreground" onClick={() => exit.mutate({ id: e.id })} disabled={exit.isPending}>Exit</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <EnrollDialog
        sequenceId={sequenceId}
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        onEnrolled={() => {
          // Refresh the stats + enrollment list so the new rows appear
          // immediately. invalidate is cheap; refetch() already wired
          // for the stats block keeps the existing UX.
          utils.sequences.getEnrollmentStats.invalidate({ sequenceId });
          utils.sequences.getEnrollmentStepStats.invalidate({ sequenceId });
          utils.sequences.listEnrollments.invalidate({ sequenceId });
          refetch();
        }}
      />
    </div>
  );
}

// ─── StepEditor ──────────────────────────────────────────────────────────────
function StepEditor({ steps, onChange, disabled }: { steps: Step[]; onChange: (s: Step[]) => void; disabled?: boolean }) {
  // Pull every non-archived workspace template so each email step gets
  // a template picker. The list endpoint already returns the full row
  // (htmlOutput included) so apply-template is a single client-side
  // copy — no extra fetch per pick.
  const templatesQ = trpc.emailTemplates?.list?.useQuery({ status: "all" });
  const templates = (templatesQ?.data ?? []).filter((t: any) => t.status !== "archived");
  const templateById = new Map<number, any>(templates.map((t: any) => [t.id, t]));

  function applyTemplateToStep(i: number, templateId: number) {
    const t = templateById.get(templateId);
    if (!t) return;
    // RichTextEditor stores HTML, so we drop the template's htmlOutput
    // in verbatim. Subject is plain text. templateId tracked so the
    // breadcrumb survives reopening the dialog.
    updateStep(i, {
      subject: t.subject ?? "",
      body: t.htmlOutput ?? "",
      templateId,
    } as Partial<EmailStep>);
  }

  function addStep(type: StepType) {
    const newStep: Step =
      type === "email" ? { type: "email", subject: "New email", body: "" } :
      type === "wait"  ? { type: "wait", days: 1 } :
                         { type: "task", body: "Follow up task" };
    onChange([...steps, newStep]);
  }

  function removeStep(i: number) {
    onChange(steps.filter((_, idx) => idx !== i));
  }

  function moveStep(i: number, dir: -1 | 1) {
    const arr = [...steps];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
  }

  function updateStep(i: number, patch: Partial<Step>) {
    const arr = [...steps];
    arr[i] = { ...arr[i], ...patch } as Step;
    onChange(arr);
  }

  return (
    <div className="space-y-2">
      {steps.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">No steps yet. Add one below.</p>
      )}
      {steps.map((step, i) => (
        <div key={i} className="border rounded-md p-3 bg-card space-y-2">
          <div className="flex items-center gap-2">
            {step.type === "email" && <Mail className="h-3.5 w-3.5 text-blue-500 shrink-0" />}
            {step.type === "wait"  && <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
            {step.type === "task"  && <ClipboardList className="h-3.5 w-3.5 text-purple-500 shrink-0" />}
            <span className="text-xs font-mono text-muted-foreground">Step {i + 1}</span>
            <span className="text-xs capitalize text-muted-foreground">· {step.type}</span>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled || i === 0} onClick={() => moveStep(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled || i === steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" disabled={disabled} onClick={() => removeStep(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>

          {step.type === "email" && (() => {
            const appliedTemplate = step.templateId ? templateById.get(step.templateId) : null;
            return (
              <div className="space-y-1.5">
                {/* Apply-template picker + breadcrumb. Selecting a
                    template copies its subject + body straight into
                    this step so the user sees the content immediately
                    and can edit it inline. The source template stays
                    untouched. */}
                <div className="flex items-center gap-2">
                  <Select
                    value={step.templateId?.toString() ?? ""}
                    disabled={disabled}
                    onValueChange={(v) => applyTemplateToStep(i, Number(v))}
                  >
                    <SelectTrigger className="h-7 text-xs flex-1">
                      <SelectValue placeholder={
                        templates.length === 0 ? "No templates saved yet" : "Apply a template…"
                      } />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t: any) => (
                        <SelectItem key={t.id} value={t.id.toString()} className="text-xs">
                          <span className="flex items-center gap-2">
                            <span>{t.name}</span>
                            {t.status === "draft" && (
                              <span className="text-[10px] px-1 py-0 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                draft
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                      {templates.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          No templates found — create one in Email Builder.
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {appliedTemplate && (
                  <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-2.5 py-1 text-[11px] text-blue-700 dark:text-blue-300">
                    <Mail className="size-3 shrink-0" />
                    <span className="flex-1 truncate">
                      Applied from template: <span className="font-medium">{appliedTemplate.name}</span>
                    </span>
                    {!disabled && (
                      <button
                        type="button"
                        className="text-[11px] underline-offset-2 hover:underline shrink-0"
                        onClick={() => updateStep(i, { templateId: undefined } as Partial<EmailStep>)}
                        title="Detach from the source template (keeps the content)"
                      >
                        Detach
                      </button>
                    )}
                  </div>
                )}
                <Input
                  placeholder="Subject"
                  value={step.subject}
                  disabled={disabled}
                  onChange={(e) => updateStep(i, { subject: e.target.value })}
                  className="h-7 text-sm"
                />
                <RichTextEditor
                  value={step.body ?? ""}
                  onChange={(html) => updateStep(i, { body: html })}
                  placeholder="Body (optional — leave blank to compose with AI at send time)"
                  minHeight="80px"
                  maxHeight="300px"
                  compact
                  disabled={disabled}
                />
              </div>
            );
          })()}

          {step.type === "wait" && (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground shrink-0">Wait days</Label>
              <Input
                type="number"
                min={0}
                max={60}
                value={step.days}
                disabled={disabled}
                onChange={(e) => updateStep(i, { days: Math.max(0, Math.min(60, Number(e.target.value))) })}
                className="h-7 w-20 text-sm"
              />
            </div>
          )}

          {step.type === "task" && (
            <RichTextEditor
              value={step.body ?? ""}
              onChange={(html) => updateStep(i, { body: html })}
              placeholder="Task description"
              minHeight="60px"
              maxHeight="200px"
              compact
              disabled={disabled}
            />
          )}
        </div>
      ))}

      {!disabled && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addStep("email")}><Mail className="h-3 w-3 mr-1" /> Email</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addStep("wait")}><Clock className="h-3 w-3 mr-1" /> Wait</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addStep("task")}><ClipboardList className="h-3 w-3 mr-1" /> Task</Button>
        </div>
      )}
    </div>
  );
}

// ─── SequenceEditDialog ───────────────────────────────────────────────────────
function SequenceEditDialog({ seq, open, onClose }: { seq: any; open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<"settings" | "steps">("settings");

  // Settings state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dailyCap, setDailyCap] = useState<string>("");
  const [skipWeekends, setSkipWeekends] = useState(false);
  const [replyDetection, setReplyDetection] = useState(true);
  const [sendWindowStart, setSendWindowStart] = useState("08:00");
  const [sendWindowEnd, setSendWindowEnd] = useState("18:00");

  // Steps state
  const [steps, setSteps] = useState<Step[]>([]);
  // Local flag: bumped each time the user saves steps so we don't
  // reset their in-progress edits with the just-refetched server data.
  // (The seq prop is a parent snapshot — if we hydrated unconditionally
  // on every refresh, save → server refetch → snapshot replacement would
  // race the user's typing.)
  const [stepsDirtyAfterLoad, setStepsDirtyAfterLoad] = useState(false);

  // Live query so the dialog stays in sync with parallel edits made
  // from the canvas / right panel. seq prop seeds the initial load;
  // liveSeq drives every subsequent refresh so a save (which
  // invalidates sequences.get) flows back here cleanly.
  const liveSeqQ = trpc.sequences.get.useQuery({ id: seq?.id }, { enabled: open && !!seq?.id });
  const liveSeq = liveSeqQ.data ?? seq;

  // Same lock rule as the canvas — paused sequences should be editable
  // (that's why users pause). Only lock active (running) and archived.
  const isLocked = liveSeq?.status === "active" || liveSeq?.status === "archived";

  // Pre-fill when dialog opens, or when the live data updates (and the
  // user hasn't started editing steps yet — otherwise we'd nuke their
  // unsaved changes).
  useEffect(() => {
    if (!liveSeq || !open) return;
    setName(liveSeq.name ?? "");
    setDescription(liveSeq.description ?? "");
    setDailyCap(liveSeq.dailyCap != null ? String(liveSeq.dailyCap) : "");
    const s = liveSeq.settings ?? {};
    setSkipWeekends(s.skipWeekends ?? false);
    setReplyDetection(s.replyDetection ?? true);
    setSendWindowStart(s.sendWindowStart ?? "08:00");
    setSendWindowEnd(s.sendWindowEnd ?? "18:00");
    if (!stepsDirtyAfterLoad) {
      setSteps((liveSeq.steps as Step[]) ?? []);
    }
  }, [liveSeq, open, stepsDirtyAfterLoad]);

  // Reset tab + dirty flag whenever the dialog opens fresh.
  useEffect(() => {
    if (open) {
      setTab("settings");
      setStepsDirtyAfterLoad(false);
    }
  }, [open, seq?.id]);

  const updateMeta = trpc.sequences.updateMeta.useMutation({
    onSuccess: () => {
      utils.sequences.list.invalidate();
      utils.sequences.get.invalidate({ id: seq.id });
      toast.success("Sequence settings saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateSteps = trpc.sequences.updateSteps.useMutation({
    onSuccess: () => {
      utils.sequences.list.invalidate();
      utils.sequences.get.invalidate({ id: seq.id });
      // Clear the local dirty flag so the next live-query refresh
      // (carrying the just-saved data) hydrates the dialog. Without
      // this, the user's edits would stay frozen as "in-progress" and
      // any parallel canvas edit would never propagate in.
      setStepsDirtyAfterLoad(false);
      toast.success("Steps saved");
    },
    onError: (e) => toast.error(e.message),
  });

  function handleSaveSettings() {
    updateMeta.mutate({
      id: seq.id,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      dailyCap: dailyCap !== "" ? Number(dailyCap) : null,
      settings: { skipWeekends, replyDetection, sendWindowStart, sendWindowEnd },
    });
  }

  function handleSaveSteps() {
    updateSteps.mutate({ id: seq.id, steps });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Edit sequence — {liveSeq?.name}</DialogTitle>
        </DialogHeader>

        {isLocked && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            This sequence is <strong>{liveSeq?.status}</strong>. Settings can be edited, but steps are read-only. Pause the sequence to edit steps.
          </div>
        )}

        {/* Tab bar */}
        <div className="flex border-b shrink-0">
          {(["settings", "steps"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
              {t}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 py-3 space-y-4">
          {tab === "settings" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-sm">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sequence name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Description</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" rows={2} className="resize-none" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Daily send cap</Label>
                <Input type="number" min={1} max={10000} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="Unlimited" className="w-36" />
                <p className="text-xs text-muted-foreground">Maximum emails sent per day across all enrollments. Leave blank for unlimited.</p>
              </div>
              <div className="border rounded-md p-3 space-y-3">
                <p className="text-sm font-medium">Send window</p>
                <div className="flex items-center gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Start</Label>
                    <Input type="time" value={sendWindowStart} onChange={(e) => setSendWindowStart(e.target.value)} className="w-32 h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">End</Label>
                    <Input type="time" value={sendWindowEnd} onChange={(e) => setSendWindowEnd(e.target.value)} className="w-32 h-8 text-sm" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="skipWeekends" checked={skipWeekends} onCheckedChange={setSkipWeekends} />
                  <Label htmlFor="skipWeekends" className="text-sm cursor-pointer">Skip weekends</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="replyDetection" checked={replyDetection} onCheckedChange={setReplyDetection} />
                  <Label htmlFor="replyDetection" className="text-sm cursor-pointer">Pause enrollment on reply</Label>
                </div>
              </div>
            </>
          )}

          {tab === "steps" && (
            <StepEditor
              steps={steps}
              onChange={(next) => { setSteps(next); setStepsDirtyAfterLoad(true); }}
              disabled={isLocked}
            />
          )}
        </div>

        <DialogFooter className="shrink-0 pt-2 border-t">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {tab === "settings" && (
            <Button onClick={handleSaveSettings} disabled={updateMeta.isPending}>
              {updateMeta.isPending ? "Saving…" : "Save settings"}
            </Button>
          )}
          {tab === "steps" && (
            <Button onClick={handleSaveSteps} disabled={updateSteps.isPending || isLocked}>
              {updateSteps.isPending ? "Saving…" : "Save steps"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SequenceAbPanel ────────────────────────────────────────────────────────
function SequenceAbPanel({ sequenceId, steps }: { sequenceId: number; steps: any[] }) {
  const [selectedStep, setSelectedStep] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [editVariant, setEditVariant] = useState<any | null>(null);
  const [minSendsEditing, setMinSendsEditing] = useState<number | null>(null);
  const [minSendsValue, setMinSendsValue] = useState<number>(100);
  const utils = trpc.useUtils();

  const emailSteps = steps
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => s.type === "email");

  const { data: variants, isLoading } = trpc.sequenceAb.list.useQuery(
    { sequenceId, stepIndex: selectedStep },
    { enabled: emailSteps.length > 0 },
  );
  const { data: stats } = trpc.sequenceAb.getStats.useQuery(
    { sequenceId, stepIndex: selectedStep },
    { enabled: emailSteps.length > 0 },
  );

  const createVariant = trpc.sequenceAb.create.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); setAddOpen(false); toast.success("Variant added"); },
    onError: (e) => toast.error(e.message),
  });
  const updateVariant = trpc.sequenceAb.update.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); setEditVariant(null); toast.success("Variant updated"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteVariant = trpc.sequenceAb.delete.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); toast.success("Variant deleted"); },
    onError: (e) => toast.error(e.message),
  });
  const promoteWinner = trpc.sequenceAb.promoteWinner.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); toast.success("Winner promoted!"); },
    onError: (e) => toast.error(e.message),
  });
  const setMinSends = trpc.sequenceAb.setMinSends.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); setMinSendsEditing(null); toast.success("Min-sends threshold saved"); },
    onError: (e) => toast.error(e.message),
  });

  if (emailSteps.length === 0) {
    return <div className="text-sm text-muted-foreground py-6 text-center">No email steps in this sequence. Add an email step first.</div>;
  }

  const topVariant = stats && stats.length > 0 ? stats.reduce((a, b) => a.score > b.score ? a : b) : null;
  const promotedVariant = stats?.find((v) => v.isWinner);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Email step:</Label>
          <select
            className="text-sm border rounded px-2 py-1 bg-background"
            value={selectedStep}
            onChange={(e) => setSelectedStep(Number(e.target.value))}
          >
            {emailSteps.map((s) => (
              <option key={s.index} value={s.index}>Step {s.index + 1}: {s.subject || "(no subject)"}</option>
            ))}
          </select>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="size-3.5 mr-1" /> Add variant</Button>
      </div>

      {/* Winner / auto-promotion status banner */}
      {promotedVariant && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-sm">
          <Trophy className="size-4 text-amber-500 shrink-0" />
          <span className="font-medium text-amber-800 dark:text-amber-300">Variant {promotedVariant.variantLabel} is the winner</span>
          {promotedVariant.promotedAt && (
            <span className="text-xs text-muted-foreground ml-1">
              — promoted {new Date(promotedVariant.promotedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
      {!promotedVariant && stats && stats.length >= 2 && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
          <Activity className="size-4 shrink-0" />
          <span>Testing in progress — winner will be auto-promoted once all variants reach their min-sends threshold.</span>
        </div>
      )}

      {isLoading && <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}

      {!isLoading && (variants ?? []).length === 0 && (
        <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
          No A/B variants for this step yet. Add a variant to start testing.
        </div>
      )}

      {(variants ?? []).length > 0 && (
        <div className="space-y-2">
          {/* Stats comparison table */}
          {stats && stats.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1.5 px-2">Variant</th>
                    <th className="text-left py-1.5 px-2">Subject</th>
                    <th className="text-right py-1.5 px-2">Split</th>
                    <th className="text-right py-1.5 px-2">Sent</th>
                    <th className="text-right py-1.5 px-2">Open %</th>
                    <th className="text-right py-1.5 px-2">Reply %</th>
                    <th className="text-right py-1.5 px-2">Min Sends</th>
                    <th className="py-1.5 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((v) => (
                    <tr key={v.id} className={`border-b hover:bg-muted/30 ${v.isWinner ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}`}>
                      <td className="py-1.5 px-2">
                        <span className="font-mono font-semibold">{v.variantLabel}</span>
                        {v.isWinner && (
                          <span className="inline-flex items-center gap-0.5 ml-1.5 text-amber-600 dark:text-amber-400">
                            <Trophy className="size-3" />
                            <span className="text-[10px] font-medium">Winner</span>
                          </span>
                        )}
                        {!v.isWinner && topVariant?.id === v.id && v.sentCount > 0 && !promotedVariant && (
                          <span className="inline-flex items-center gap-0.5 ml-1.5 text-blue-500">
                            <TrendingUp className="size-3" />
                            <span className="text-[10px]">Leading</span>
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-2 max-w-[160px] truncate">{v.subject}</td>
                      <td className="py-1.5 px-2 text-right">{v.splitPct}%</td>
                      <td className="py-1.5 px-2 text-right">{v.sentCount}</td>
                      <td className={`py-1.5 px-2 text-right font-medium ${v.openRate >= 30 ? "text-emerald-600" : v.openRate >= 15 ? "text-amber-600" : "text-muted-foreground"}`}>{v.openRate}%</td>
                      <td className={`py-1.5 px-2 text-right font-medium ${v.replyRate >= 10 ? "text-emerald-600" : v.replyRate >= 5 ? "text-amber-600" : "text-muted-foreground"}`}>{v.replyRate}%</td>
                      <td className="py-1.5 px-2 text-right">
                        {minSendsEditing === v.id ? (
                          <div className="flex items-center gap-1 justify-end">
                            <Input
                              type="number"
                              className="h-5 w-16 text-xs px-1"
                              value={minSendsValue}
                              min={1}
                              onChange={(e) => setMinSendsValue(Number(e.target.value))}
                            />
                            <Button size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setMinSends.mutate({ id: v.id, minSendsForPromotion: minSendsValue })} disabled={setMinSends.isPending}>Save</Button>
                            <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setMinSendsEditing(null)}>✕</Button>
                          </div>
                        ) : (
                          <button
                            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                            onClick={() => { setMinSendsEditing(v.id); setMinSendsValue(v.minSendsForPromotion ?? 100); }}
                          >
                            {v.minSendsForPromotion ?? 100}
                          </button>
                        )}
                      </td>
                      <td className="py-1.5 px-2">
                        <div className="flex gap-1 justify-end">
                          {!v.isWinner && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 px-1.5 text-[10px] text-amber-700 border-amber-300 hover:bg-amber-50"
                              onClick={() => promoteWinner.mutate({ sequenceId, stepIndex: selectedStep, winnerId: v.id })}
                              disabled={promoteWinner.isPending}
                              title="Promote as winner"
                            >
                              <Trophy className="size-3 mr-0.5" />Promote
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => setEditVariant(variants!.find((vv) => vv.id === v.id))}><Pencil className="size-3" /></Button>
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-destructive" onClick={() => deleteVariant.mutate({ id: v.id })}><Trash2 className="size-3" /></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add variant dialog */}
      <FormDialog open={addOpen} onOpenChange={setAddOpen} title="Add A/B Variant" isPending={createVariant.isPending}
        onSubmit={(f) => createVariant.mutate({
          sequenceId,
          stepIndex: selectedStep,
          variantLabel: String(f.get("variantLabel") ?? ""),
          subject: String(f.get("subject") ?? ""),
          body: String(f.get("body") ?? ""),
          splitPct: Number(f.get("splitPct") ?? 50),
        })}>
        <Field label="Variant label (e.g. A, B, C)" name="variantLabel" placeholder="B" required />
        <Field label="Subject line" name="subject" placeholder="Alternative subject..." required />
        <TextareaField label="Body" name="body" placeholder="Email body for this variant..." />
        <Field label="Split %" name="splitPct" type="number" placeholder="50" />
      </FormDialog>

      {/* Edit variant dialog */}
      {editVariant && (
        <Dialog open={!!editVariant} onOpenChange={(v) => !v && setEditVariant(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Edit Variant {editVariant.variantLabel}</DialogTitle></DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1"><Label>Subject</Label><Input defaultValue={editVariant.subject} id="ev-subject" /></div>
              <div className="space-y-1"><Label>Body</Label><Textarea defaultValue={editVariant.body} id="ev-body" rows={5} /></div>
              <div className="space-y-1"><Label>Split %</Label><Input type="number" defaultValue={editVariant.splitPct} id="ev-split" /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditVariant(null)}>Cancel</Button>
              <Button
                onClick={() => updateVariant.mutate({
                  id: editVariant.id,
                  subject: (document.getElementById("ev-subject") as HTMLInputElement)?.value,
                  body: (document.getElementById("ev-body") as HTMLTextAreaElement)?.value,
                  splitPct: Number((document.getElementById("ev-split") as HTMLInputElement)?.value),
                })}
                disabled={updateVariant.isPending}
              >
                {updateVariant.isPending && <Loader2 className="size-4 animate-spin mr-1" />}Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
// ─── SequencePerformancePanel ───────────────────────────────────────────────
function SequencePerformancePanel({ sequenceId }: { sequenceId: number }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const queryInput: { sequenceId: number; dateFrom?: string; dateTo?: string } = { sequenceId };
  if (dateFrom) queryInput.dateFrom = dateFrom;
  if (dateTo) queryInput.dateTo = dateTo;
  const { data, isLoading } = trpc.sequences.getPerformanceAnalytics.useQuery(queryInput);
  const row = data?.[0];
  const hasDateFilter = !!dateFrom || !!dateTo;

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><RefreshCw className="size-3 animate-spin" /> Loading analytics…</div>;
  }

  if (!row) {
    return <div className="text-sm text-muted-foreground py-8 text-center">No analytics data yet. Send emails through this sequence to see performance metrics.</div>;
  }

  const metrics = [
    { label: "Emails Sent", value: row.sent, sub: "total sent", color: "text-foreground" },
    { label: "Open Rate", value: `${row.openRate}%`, sub: `${row.uniqueOpens} unique opens`, color: row.openRate >= 30 ? "text-emerald-600" : row.openRate >= 15 ? "text-amber-600" : "text-muted-foreground" },
    { label: "Click Rate", value: `${row.clickRate}%`, sub: `${row.uniqueClicks} unique clicks`, color: row.clickRate >= 5 ? "text-emerald-600" : row.clickRate >= 2 ? "text-amber-600" : "text-muted-foreground" },
    { label: "Bounce Rate", value: `${row.bounceRate}%`, sub: `${row.bounced} bounced`, color: row.bounceRate > 5 ? "text-rose-600" : row.bounceRate > 2 ? "text-amber-600" : "text-emerald-600" },
    { label: "Exit Rate", value: `${row.exitRate}%`, sub: `${row.exited} exited`, color: row.exitRate > 20 ? "text-rose-600" : "text-muted-foreground" },
  ];

  const enrollment = [
    { label: "Total Enrolled", value: row.totalEnrolled },
    { label: "Active", value: row.active },
    { label: "Finished", value: row.finished },
    { label: "Paused", value: row.paused },
    { label: "Exited", value: row.exited },
  ];

  return (
    <div className="space-y-4">
      {/* Date range filter */}
      <div className="flex flex-wrap items-end gap-3 p-3 bg-muted/40 rounded-lg border">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[#14B89A]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[#14B89A]"
          />
        </div>
        {hasDateFilter && (
          <button
            onClick={() => { setDateFrom(""); setDateTo(""); }}
            className="h-8 px-3 rounded-md text-xs border border-border text-muted-foreground hover:text-foreground hover:border-[#14B89A] transition-colors"
          >
            Clear filter
          </button>
        )}
        {hasDateFilter && (
          <span className="text-xs text-[#14B89A] font-medium self-end pb-1">
            Filtered: {dateFrom || "…"} → {dateTo || "…"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {metrics.map(({ label, value, sub, color }) => (
          <Card key={label} className="border">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
              <p className="text-[11px] text-muted-foreground">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Section title="Enrollment Funnel">
        <div className="p-3 space-y-2">
          {enrollment.map(({ label, value }) => {
            const pct = row.totalEnrolled > 0 ? Math.round((value / row.totalEnrolled) * 100) : 0;
            return (
              <div key={label} className="flex items-center gap-3 text-sm">
                <span className="w-28 text-xs text-muted-foreground shrink-0">{label}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="h-2 rounded-full bg-[#14B89A] transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs tabular-nums w-10 text-right font-mono">{value}</span>
                <span className="text-[11px] text-muted-foreground w-8 text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      </Section>

      {row.sent > 0 && (
        <Section title="Email Engagement Funnel">
          <div className="p-3 space-y-2">
            {[
              { label: "Sent", value: row.sent, pct: 100 },
              { label: "Opened (unique)", value: row.uniqueOpens, pct: row.openRate },
              { label: "Clicked (unique)", value: row.uniqueClicks, pct: row.clickRate },
              { label: "Bounced", value: row.bounced, pct: row.bounceRate },
            ].map(({ label, value, pct }) => (
              <div key={label} className="flex items-center gap-3 text-sm">
                <span className="w-32 text-xs text-muted-foreground shrink-0">{label}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="h-2 rounded-full bg-[#14B89A] transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs tabular-nums w-10 text-right font-mono">{value}</span>
                <span className="text-[11px] text-muted-foreground w-8 text-right">{pct}%</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <SequenceStepBreakdown sequenceId={sequenceId} />
    </div>
  );
}

/**
 * Per-step performance table — one row per email step in the sequence,
 * showing sent / unique opens / unique clicks / replies / bounces and
 * their rates as % bars. Surfaces where a sequence's funnel is leaking.
 */
function SequenceStepBreakdown({ sequenceId }: { sequenceId: number }) {
  const { data, isLoading } = trpc.sequences.getStepAnalytics.useQuery({ sequenceId });
  if (isLoading) {
    return (
      <Section title="Per-step performance">
        <div className="p-3 text-sm text-muted-foreground">Loading step breakdown…</div>
      </Section>
    );
  }
  const steps = (data?.steps ?? []).filter((s: any) => s.stepType === "email" || s.stepIndex === -1 || s.sent > 0);
  if (steps.length === 0) {
    return (
      <Section title="Per-step performance">
        <div className="p-3 text-sm text-muted-foreground">
          No email steps have sent yet — once drafts go out, this will break down by step.
        </div>
      </Section>
    );
  }
  // Color thresholds: green if good, amber if mid, muted otherwise.
  const tone = (rate: number, good: number, mid: number) =>
    rate >= good ? "text-emerald-600" : rate >= mid ? "text-amber-600" : "text-muted-foreground";
  const bounceTone = (rate: number) =>
    rate > 5 ? "text-rose-600" : rate > 2 ? "text-amber-600" : rate > 0 ? "text-emerald-600" : "text-muted-foreground";

  return (
    <Section title="Per-step performance">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b">
              <th className="text-left py-2 pl-3 pr-2 font-medium">Step</th>
              <th className="text-right px-2 font-medium">Sent</th>
              <th className="text-right px-2 font-medium">Opens</th>
              <th className="text-right px-2 font-medium">Clicks</th>
              <th className="text-right px-2 font-medium">Replies</th>
              <th className="text-right pr-3 pl-2 font-medium">Bounced</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s: any) => (
              <tr key={s.stepIndex} className="border-b last:border-b-0 hover:bg-muted/40">
                <td className="py-2 pl-3 pr-2">
                  <div className="text-xs font-medium">
                    {s.stepIndex === -1 ? "—" : `Step ${s.stepIndex + 1}`}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate max-w-[260px]" title={s.stepLabel}>
                    {s.stepLabel}
                  </div>
                </td>
                <td className="text-right px-2 tabular-nums font-mono">{s.sent}</td>
                <td className="text-right px-2 tabular-nums">
                  <span className={tone(s.openRate, 30, 15)}>{s.uniqueOpens}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.openRate}%)</span>
                </td>
                <td className="text-right px-2 tabular-nums">
                  <span className={tone(s.clickRate, 5, 2)}>{s.uniqueClicks}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.clickRate}%)</span>
                </td>
                <td className="text-right px-2 tabular-nums">
                  <span className={tone(s.replyRate, 5, 2)}>{s.replied}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.replyRate}%)</span>
                </td>
                <td className="text-right pr-3 pl-2 tabular-nums">
                  <span className={bounceTone(s.bounceRate)}>{s.bounced}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.bounceRate}%)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export default function Sequences() {
  const [open, setOpen] = useState(false);
  const [editSeq, setEditSeq] = useState<any | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"steps" | "stats" | "analytics" | "ab">("steps");
  const utils = trpc.useUtils();
  const { data } = trpc.sequences.list.useQuery();
  const create = trpc.sequences.create.useMutation({
    onSuccess: () => { utils.sequences.list.invalidate(); setOpen(false); toast.success("Sequence created"); },
    onError: (e) => toast.error("Failed to create sequence", { description: e.message }),
  });
  const setStatus = trpc.sequences.setStatus.useMutation({
    onSuccess: () => utils.sequences.list.invalidate(),
    onError: (e) => toast.error("Failed to change status", { description: e.message }),
  });
  const remove = trpc.sequences.delete.useMutation({
    onSuccess: (_d, vars) => {
      utils.sequences.list.invalidate();
      // Clear the right-pane selection if we just deleted what was open.
      if (selected === vars.id) setSelected(null);
      toast.success("Sequence deleted");
    },
    onError: (e) => toast.error("Failed to delete sequence", { description: e.message }),
  });
  const detail = trpc.sequences.get.useQuery({ id: selected! }, { enabled: !!selected });
  // Workspace templates available for the right-panel "From template: <name>"
  // chip. Cheap query; result is reused across every step row that has a
  // templateId, so each step doesn't trigger its own fetch.
  const allTemplatesQ = trpc.emailTemplates?.list?.useQuery({ status: "all" });
  const templateNameById = new Map<number, string>(
    ((allTemplatesQ?.data ?? []) as any[]).map((t) => [t.id as number, t.name as string]),
  );

  return (
    <Shell title="Sequences">
      <PageHeader title="Sequences" description="Build multi-step email and task cadences to engage prospects at scale with personalised touchpoints. Set delays, branching conditions, and auto-stop rules to keep every sequence relevant." pageKey="sequences"
        icon={<ListOrdered className="size-5" />}
      >
        <Link
          href="/email-drafts"
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          title="Review and edit drafts created by sequence steps"
        >
          Email Drafts →
        </Link>
        <Link
          href="/email-analytics"
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          title="Open / click / reply rates per sequence and per step"
        >
          Email Analytics →
        </Link>
        <Button onClick={() => setOpen(true)} data-tour-id="sequences-new-button"><Plus className="size-4" /> New sequence</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title="All sequences">
            {(data ?? []).length === 0 ? <EmptyState icon={Activity} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((s) => (
                  <li key={s.id}
                    className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === s.id ? "bg-secondary/60" : ""}`}
                    onClick={() => { setSelected(s.id); setActiveTab("steps"); }}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-sm font-medium truncate">{s.name}</div>
                      <StatusPill tone={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "muted"}>{s.status}</StatusPill>
                      <button
                        className="text-muted-foreground hover:text-destructive p-1 rounded"
                        title="Delete sequence"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete sequence "${s.name}"? This removes the sequence and its steps; enrollments stop. This cannot be undone.`)) {
                            remove.mutate({ id: s.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-1">{s.description}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {s.enrolledCount} enrolled
                      {s.dailyCap ? ` · ${s.dailyCap}/day cap` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {!selected ? <EmptyState icon={Activity} title="Select a sequence" /> : detail.data ? (
            <>
              <Section title={detail.data.name} description={detail.data.description ?? ""}
                right={
                  <div className="flex gap-1 flex-wrap">
                    <Button size="sm" variant="outline" onClick={() => setEditSeq(detail.data)}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Link href={`/sequences/${detail.data.id}/canvas`}>
                      <Button size="sm" variant="outline"><GitBranch className="size-3.5" /> Canvas</Button>
                    </Link>
                    <Button size="sm" variant="ghost"
                      onClick={() => setStatus.mutate({ id: detail.data!.id, status: detail.data!.status === "active" ? "paused" : "active" })}>
                      {detail.data.status === "active" ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Activate</>}
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setStatus.mutate({ id: detail.data!.id, status: "archived" })}>
                      <Power className="size-3.5" /> Archive
                    </Button>
                  </div>
                }>
                {/* Tab bar */}
                <div className="flex border-b mb-3 px-3">
                  {[
                    { k: "steps", label: "Steps", icon: Activity },
                    { k: "stats", label: "Stats & Enrollments", icon: BarChart3 },
                    { k: "analytics", label: "Performance", icon: TrendingUp },
                    { k: "ab", label: "A/B Testing", icon: FlaskConical },
                  ].map(({ k, label, icon: Icon }) => (
                    <button key={k}
                      onClick={() => setActiveTab(k as any)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-sm ${activeTab === k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>

                {activeTab === "steps" && (
                  <ol className="p-3 space-y-2">
                    {((detail.data.steps as any[]) ?? []).map((step, i) => {
                      // Resolve template provenance for the right-pane chip.
                      // templateId is plumbed end-to-end (Edit dialog +
                      // canvas → server stepSchema → here) so the chip
                      // shows in lock-step with whichever editor the user
                      // last touched.
                      const tmplName = step.type === "email" && typeof step.templateId === "number"
                        ? templateNameById.get(step.templateId)
                        : null;
                      const bodyPreview = step.body ? htmlToPlainText(String(step.body)) : "";
                      return (
                        <li key={i} className="border rounded p-2.5">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-mono">Step {i + 1}</span> · {step.type}
                            {step.type === "wait" ? ` · ${step.days}d` : ""}
                            {tmplName && (
                              <span className="ml-auto text-[10px] px-1.5 py-0 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                                from template: {tmplName}
                              </span>
                            )}
                          </div>
                          {step.subject && <div className="text-sm font-medium mt-1">{step.subject}</div>}
                          {bodyPreview && <div className="text-xs text-muted-foreground line-clamp-3 mt-1 whitespace-pre-wrap">{bodyPreview}</div>}
                        </li>
                      );
                    })}
                    {((detail.data.steps as any[]) ?? []).length === 0 && (
                      <div className="text-sm text-muted-foreground py-4 text-center">
                        No steps yet. Click <strong>Edit</strong> to add steps, or open the Canvas.
                      </div>
                    )}
                  </ol>
                )}

                {activeTab === "stats" && (
                  <div className="p-3">
                    <EnrollmentStatsPanel
                      sequenceId={detail.data.id}
                      steps={(detail.data.steps as any[]) ?? []}
                    />
                  </div>
                )}

                {activeTab === "analytics" && (
                  <div className="p-3">
                    <SequencePerformancePanel sequenceId={detail.data.id} />
                  </div>
                )}

                {activeTab === "ab" && (
                  <div className="p-3">
                    <SequenceAbPanel
                      sequenceId={detail.data.id}
                      steps={(detail.data.steps as any[]) ?? []}
                    />
                  </div>
                )}
              </Section>
            </>
          ) : null}
        </div>
      </div>

      {/* New sequence dialog */}
      <FormDialog open={open} onOpenChange={setOpen} title="New sequence" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")), description: String(f.get("description") ?? "") || undefined,
          steps: [
            { type: "email", subject: String(f.get("step1Subject") ?? "Quick intro"), body: String(f.get("step1Body") ?? "") },
            { type: "wait", days: 3 },
            { type: "email", subject: "Following up", body: "Did this come at a bad time?" },
          ],
        })}>
        <Field name="name" label="Name" required />
        <TextareaField name="description" label="Description" />
        <Field name="step1Subject" label="Step 1 subject" />
        <TextareaField name="step1Body" label="Step 1 body" />
      </FormDialog>

      {/* Edit sequence dialog */}
      {editSeq && (
        <SequenceEditDialog
          seq={editSeq}
          open={!!editSeq}
          onClose={() => setEditSeq(null)}
        />
      )}
    </Shell>
  );
}
