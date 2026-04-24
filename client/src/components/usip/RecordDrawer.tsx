import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { fmtDate, StatusPill } from "./Common";
import { Brain, ChevronDown, CheckCircle2, Clock, Loader2, Paperclip, Phone, Calendar, MessageSquare, RefreshCw, Sparkles, Trash2, Users, XCircle, ShieldCheck, FileText, Download, Send, Wand2 } from "lucide-react";
import { EmailVerificationBadge } from "./EmailVerificationBadge";
import { ContactOverview } from "./detail/ContactOverview";
import { AccountOverview } from "./detail/AccountOverview";
import { OpportunityOverview } from "./detail/OpportunityOverview";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRef, useState } from "react";
import { toast } from "sonner";

type RelatedType = "lead" | "contact" | "account" | "opportunity" | "customer";

const DISPOSITIONS = [
  ["connected", "Connected"],
  ["voicemail", "Voicemail"],
  ["no_answer", "No answer"],
  ["bad_number", "Bad number"],
  ["gatekeeper", "Gatekeeper"],
  ["callback_requested", "Callback requested"],
  ["not_interested", "Not interested"],
] as const;

function LeadScorePanel({ leadId }: { leadId: number }) {
  const utils = trpc.useUtils();
  const { data: bd, isLoading } = trpc.leadScoring.breakdown.useQuery({ leadId });
  const recompute = trpc.leadScoring.recompute.useMutation({ onSuccess: () => { utils.leadScoring.breakdown.invalidate({ leadId }); utils.leads.list.invalidate(); toast.success("Re-scored"); } });
  const [openSec, setOpenSec] = useState<"firmo" | "behav" | "ai" | null>("firmo");
  if (isLoading || !bd) return <div className="text-sm text-muted-foreground py-6 flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading score…</div>;
  const tier = bd.tier as string;
  const tierLabel = tier === "sales_ready" ? "Sales Ready" : tier.charAt(0).toUpperCase() + tier.slice(1);
  const tierCls = tier === "sales_ready" ? "bg-emerald-100 text-emerald-800" : tier === "hot" ? "bg-orange-100 text-orange-800" : tier === "warm" ? "bg-yellow-100 text-yellow-800" : "bg-slate-200 text-slate-700";
  const max = (bd.firmographic.max ?? 40) + (bd.behavioral.max ?? 30) + (bd.aiFit.max ?? 30);
  const sparkW = 540, sparkH = 36;
  const vals = (bd.history ?? []).map((h: any) => h.total);
  const sparkPts = vals.length ? vals.map((v: number, i: number) => `${(i * sparkW) / Math.max(1, vals.length - 1)},${sparkH - (v / 100) * (sparkH - 4)}`).join(" ") : "";
  return (
    <div className="space-y-3">
      <div className="rounded border bg-card p-3 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">Total score</div>
          <div className="text-2xl font-mono tabular-nums">{bd.total}<span className="text-sm text-muted-foreground">/100</span> <span className={`text-xs ml-2 px-1.5 rounded ${tierCls}`}>{tierLabel}</span></div>
          <div className="text-[11px] text-muted-foreground mt-1">Max possible: {max} pts · Grade {bd.grade ?? "—"}</div>
        </div>
        <Button size="sm" variant="outline" className="bg-card" onClick={() => recompute.mutate({ leadId })} disabled={recompute.isPending}>
          <RefreshCw className={`size-3.5 ${recompute.isPending ? "animate-spin" : ""}`} /> Recompute
        </Button>
      </div>

      <Accordion open={openSec === "firmo"} onToggle={() => setOpenSec(openSec === "firmo" ? null : "firmo")} title="Firmographic" value={bd.firmographic.value} max={bd.firmographic.max} reasons={bd.firmographic.reasons} />
      <Accordion open={openSec === "behav"} onToggle={() => setOpenSec(openSec === "behav" ? null : "behav")} title="Behavioral" value={Math.max(0, bd.behavioral.value)} max={bd.behavioral.max} reasons={bd.behavioral.reasons} />
      <Accordion open={openSec === "ai"} onToggle={() => setOpenSec(openSec === "ai" ? null : "ai")} title="AI Fit" value={bd.aiFit.value} max={bd.aiFit.max} reasons={[`Tier: ${tierLabel}`]} />

      <div className="rounded border bg-card p-3">
        <div className="text-xs font-semibold mb-1">90-day history</div>
        {vals.length === 0 ? <div className="text-[11px] text-muted-foreground">No history yet — click Recompute to capture the first snapshot.</div> : (
          <svg viewBox={`0 0 ${sparkW} ${sparkH}`} className="w-full h-9"><polyline points={sparkPts} fill="none" stroke="#16a34a" strokeWidth="1.5" /></svg>
        )}
      </div>
    </div>
  );
}

function Accordion({ open, onToggle, title, value, max, reasons }: { open: boolean; onToggle: () => void; title: string; value: number; max: number; reasons: string[] }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div className="rounded border bg-card">
      <button className="w-full flex items-center justify-between p-3 text-left" onClick={onToggle}>
        <div className="flex items-center gap-2">
          <ChevronDown className={`size-3 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="font-mono tabular-nums text-sm">{value}/{max}</div>
      </button>
      <div className="px-3"><div className="h-1.5 bg-muted rounded overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div></div>
      {open && (
        <ul className="px-3 pt-2 pb-3 text-[11px] text-muted-foreground space-y-0.5">
          {reasons.length === 0 ? <li>No contributing signals.</li> : reasons.slice(0, 8).map((r, i) => <li key={i}>• {r}</li>)}
        </ul>
      )}
    </div>
  );
}

function WinProbBadge({ prob }: { prob: number }) {
  const cls = prob >= 70 ? "bg-emerald-100 text-emerald-800" : prob >= 40 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cls}`}>{prob}% win prob</span>;
}

function OppIntelligencePanel({ opportunityId }: { opportunityId: number }) {
  const utils = trpc.useUtils();
  const { data: intel, isLoading } = trpc.oppIntelligence.getIntelligence.useQuery({ opportunityId });
  const { data: history = [] } = trpc.oppIntelligence.getStageHistory.useQuery({ opportunityId });
  const { data: coOwners = [] } = trpc.oppIntelligence.getCoOwners.useQuery({ opportunityId });
  const { data: members = [] } = trpc.workspace.members.useQuery();
  const generate = trpc.oppIntelligence.generateIntelligence.useMutation({
    onSuccess: () => { utils.oppIntelligence.getIntelligence.invalidate({ opportunityId }); toast.success("Intelligence refreshed"); },
    onError: (e) => toast.error(e.message),
  });
  const addCoOwner = trpc.oppIntelligence.addCoOwner.useMutation({
    onSuccess: () => utils.oppIntelligence.getCoOwners.invalidate({ opportunityId }),
  });
  const removeCoOwner = trpc.oppIntelligence.removeCoOwner.useMutation({
    onSuccess: () => utils.oppIntelligence.getCoOwners.invalidate({ opportunityId }),
  });
  const [section, setSection] = useState<"nba" | "signals" | "actions" | "email" | "history" | "owners">("nba");

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground py-8"><Loader2 className="size-4 animate-spin" /> Loading intelligence…</div>;

  const nba: any[] = (intel?.nextBestActions as any) ?? [];
  const signals: any[] = (intel?.conversationSignals as any) ?? [];
  const actionItems: any[] = (intel?.actionItems as any) ?? [];
  const altSubjects: any[] = (intel?.altSubjectLines as any) ?? [];
  const winProb = Number(intel?.winProbability ?? 0);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="rounded border bg-card p-3 flex items-start justify-between gap-3">
        <div className="space-y-1">
          {intel ? (
            <>
              <WinProbBadge prob={winProb} />
              <p className="text-xs text-muted-foreground mt-1">{intel.winProbabilityRationale}</p>
              <p className="text-[11px] text-muted-foreground">Last updated {fmtDate(intel.generatedAt)}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No intelligence snapshot yet. Click Analyze to generate one.</p>
          )}
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => generate.mutate({ opportunityId })} disabled={generate.isPending}>
          <Brain className={`size-3.5 mr-1 ${generate.isPending ? "animate-pulse" : ""}`} />
          {generate.isPending ? "Analyzing…" : "Analyze"}
        </Button>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 flex-wrap text-xs">
        {[
          { k: "nba", label: `Next Actions (${nba.length})` },
          { k: "signals", label: `Signals (${signals.length})` },
          { k: "actions", label: `Action Items (${actionItems.length})` },
          { k: "email", label: `Email Score` },
          { k: "history", label: `Stage History (${history.length})` },
          { k: "owners", label: `Co-Owners (${coOwners.length})` },
        ].map((s) => (
          <button key={s.k} onClick={() => setSection(s.k as any)}
            className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
              section === s.k ? "bg-[#14B89A] text-white border-[#14B89A]" : "text-muted-foreground hover:text-foreground"
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Next Best Actions */}
      {section === "nba" && (
        <div className="space-y-2">
          {nba.length === 0 && <p className="text-sm text-muted-foreground">No actions yet — click Analyze.</p>}
          {nba.map((a: any, i: number) => (
            <div key={i} className="rounded border bg-card p-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  a.priority === "high" ? "bg-red-100 text-red-700" : a.priority === "medium" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-700"
                }`}>{a.priority}</span>
                <span className="text-sm font-medium">{a.action}</span>
              </div>
              <p className="text-xs text-muted-foreground">{a.rationale}</p>
            </div>
          ))}
        </div>
      )}

      {/* Conversation Signals */}
      {section === "signals" && (
        <div className="space-y-2">
          {signals.length === 0 && <p className="text-sm text-muted-foreground">No signals detected yet.</p>}
          {signals.map((s: any, i: number) => (
            <div key={i} className="flex items-start gap-2 rounded border bg-card p-2.5">
              {s.sentiment === "positive" ? <CheckCircle2 className="size-3.5 text-emerald-500 mt-0.5" /> : s.sentiment === "negative" ? <XCircle className="size-3.5 text-red-500 mt-0.5" /> : <Clock className="size-3.5 text-muted-foreground mt-0.5" />}
              <span className="text-xs">{s.signal}</span>
            </div>
          ))}
        </div>
      )}

      {/* Action Items */}
      {section === "actions" && (
        <div className="space-y-2">
          {actionItems.length === 0 && <p className="text-sm text-muted-foreground">No action items extracted yet.</p>}
          {actionItems.map((a: any, i: number) => (
            <div key={i} className="rounded border bg-card p-2.5 text-xs space-y-0.5">
              <p className="font-medium">{a.item}</p>
              <p className="text-muted-foreground">Owner: {a.owner} · Due: {a.dueDate}</p>
            </div>
          ))}
        </div>
      )}

      {/* Email Effectiveness */}
      {section === "email" && (
        <div className="space-y-3">
          <div className="rounded border bg-card p-3">
            <div className="text-xs text-muted-foreground mb-1">Email Effectiveness Score</div>
            <div className="text-3xl font-mono tabular-nums">{Number(intel?.emailEffectivenessScore ?? 0).toFixed(0)}<span className="text-sm text-muted-foreground">/100</span></div>
            <div className="h-2 bg-muted rounded mt-2 overflow-hidden">
              <div className="h-full bg-[#14B89A]" style={{ width: `${Number(intel?.emailEffectivenessScore ?? 0)}%` }} />
            </div>
          </div>
          {altSubjects.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Alternative Subject Lines</div>
              {altSubjects.map((s: any, i: number) => (
                <div key={i} className="rounded border bg-card p-2.5 text-xs space-y-0.5">
                  <p className="font-medium">{s.subject}</p>
                  <p className="text-muted-foreground">{s.rationale}</p>
                </div>
              ))}
            </div>
          )}
          {intel?.winStory && (
            <div className="rounded border bg-card p-3">
              <div className="text-xs font-semibold mb-1">Win Story</div>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{intel.winStory}</p>
            </div>
          )}
        </div>
      )}

      {/* Stage History */}
      {section === "history" && (
        <div className="space-y-2">
          {history.length === 0 && <p className="text-sm text-muted-foreground">No stage changes recorded yet.</p>}
          {(history as any[]).map((h: any, i: number) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <div className="mt-1 size-2 rounded-full bg-[#14B89A] shrink-0" />
              <div>
                <span className="font-medium capitalize">{h.fromStage ?? "created"}</span>
                <span className="text-muted-foreground"> → </span>
                <span className="font-medium capitalize">{h.toStage}</span>
                {h.daysInPrevStage != null && <span className="text-muted-foreground"> ({h.daysInPrevStage}d)</span>}
                <div className="text-muted-foreground">{fmtDate(h.createdAt)}{h.note ? ` · ${h.note}` : ""}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Co-Owners */}
      {section === "owners" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Co-Owners</span>
          </div>
          {(coOwners as any[]).map((m: any) => (
            <div key={m.userId} className="flex items-center justify-between rounded border bg-card px-3 py-2">
              <span className="text-sm">{m.name ?? m.email}</span>
              <Button size="sm" variant="ghost" className="h-6 text-xs text-red-500" onClick={() => removeCoOwner.mutate({ opportunityId, userId: m.userId })}>Remove</Button>
            </div>
          ))}
          {(members as any[]).filter((m: any) => !(coOwners as any[]).some((c: any) => c.userId === m.userId)).length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-muted-foreground">Add co-owner:</div>
              <div className="flex flex-wrap gap-1">
                {(members as any[]).filter((m: any) => !(coOwners as any[]).some((c: any) => c.userId === m.userId)).map((m: any) => (
                  <button key={m.userId} onClick={() => addCoOwner.mutate({ opportunityId, userId: m.userId })}
                    className="text-xs border rounded px-2 py-0.5 hover:bg-muted transition-colors">
                    + {m.name ?? m.email}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Account Brief Panel ──────────────────────────────────────────────── */
function AccountBriefPanel({ accountId }: { accountId: number }) {
  const utils = trpc.useUtils();
  const { data: brief, isLoading } = trpc.accountBriefs.getLatest.useQuery({ accountId });
  const generate = trpc.accountBriefs.generate.useMutation({
    onSuccess: () => {
      utils.accountBriefs.getLatest.invalidate({ accountId });
      toast.success("Account brief generated");
    },
    onError: (e) => toast.error(e.message),
  });
  const exportPdf = trpc.accountBriefs.exportPdf.useMutation({
    onSuccess: (data) => {
      window.open(data.url, "_blank");
      toast.success("PDF ready");
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="size-3 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">AI Account Brief</p>
          {brief && (
            <p className="text-xs text-muted-foreground">
              Generated {new Date(brief.generatedAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {brief && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => exportPdf.mutate({ briefId: brief.id })}
              disabled={exportPdf.isPending}
            >
              {exportPdf.isPending ? <Loader2 className="size-3 animate-spin mr-1" /> : <Download className="size-3 mr-1" />}
              PDF
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => generate.mutate({ accountId })}
            disabled={generate.isPending}
          >
            {generate.isPending ? <Loader2 className="size-3 animate-spin mr-1" /> : <Brain className="size-3 mr-1" />}
            {brief ? "Regenerate" : "Generate Brief"}
          </Button>
        </div>
      </div>

      {!brief && !generate.isPending && (
        <div className="rounded-lg border bg-muted/30 p-6 text-center">
          <FileText className="size-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No brief generated yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Click "Generate Brief" to create an AI-powered 300-word executive account summary.
          </p>
        </div>
      )}

      {generate.isPending && (
        <div className="rounded-lg border bg-muted/30 p-6 text-center">
          <Loader2 className="size-6 text-[#14B89A] animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Generating brief…</p>
        </div>
      )}

      {brief && !generate.isPending && (
        <div className="rounded-lg border bg-card p-4">
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap">
            {brief.content}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Contact Email Verify Panel ───────────────────────────────────────── */
function ContactVerifyPanel({
  contact,
  isLoading,
  isVerifying,
  onVerify,
}: {
  contact: any;
  isLoading: boolean;
  isVerifying: boolean;
  onVerify: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="size-3 animate-spin" /> Loading…
      </div>
    );
  }

  if (!contact?.email) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground text-center">
        No email address on this contact. Add one to enable verification.
      </div>
    );
  }

  const status = contact.emailVerificationStatus as string | null;
  const verifiedAt = contact.emailVerifiedAt as Date | string | null;
  const rawData = contact.emailVerificationData as Record<string, any> | null;

  const DETAIL_LABELS: Record<string, string> = {
    is_valid_syntax: "Valid syntax",
    is_disposable: "Disposable domain",
    is_role_account: "Role account",
    is_catch_all: "Catch-all domain",
    is_spamtrap: "Spam trap",
    is_free: "Free email provider",
    overall_score: "Overall score",
  };

  return (
    <div className="space-y-4">
      {/* Status card */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Email address</p>
            <p className="text-sm font-medium">{contact.email}</p>
          </div>
          <EmailVerificationBadge status={status} verifiedAt={verifiedAt} />
        </div>

        {verifiedAt && (
          <p className="text-xs text-muted-foreground">
            Last verified: {new Date(verifiedAt).toLocaleString()}
          </p>
        )}

        <Button
          size="sm"
          variant="outline"
          onClick={onVerify}
          disabled={isVerifying}
          className="w-full gap-2"
        >
          {isVerifying ? (
            <><Loader2 className="size-3 animate-spin" /> Verifying…</>
          ) : (
            <><ShieldCheck className="size-3" /> {status ? "Re-verify" : "Verify Email"}</>
          )}
        </Button>
      </div>

      {/* Reoon detail breakdown */}
      {rawData && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Verification Details</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {Object.entries(DETAIL_LABELS).map(([key, label]) => {
              const val = rawData[key];
              if (val === undefined || val === null) return null;
              const isBool = typeof val === "boolean";
              return (
                <div key={key} className="flex items-center justify-between col-span-1">
                  <span className="text-muted-foreground">{label}</span>
                  {isBool ? (
                    <span className={val ? "text-amber-600 font-medium" : "text-green-600 font-medium"}>
                      {val ? "Yes" : "No"}
                    </span>
                  ) : (
                    <span className="font-medium">{String(val)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!status && !isVerifying && (
        <p className="text-xs text-muted-foreground text-center">
          Click "Verify Email" to check deliverability using Reoon Power Mode.
        </p>
      )}
    </div>
  );
}

/* ─── Contact Enrich Panel ──────────────────────────────────────────────── */
function ContactEnrichPanel({ contactId, onEnriched }: { contactId: number; onEnriched: () => void }) {
  const utils = trpc.useUtils();
  const { data: contact, isLoading } = trpc.contacts.get.useQuery({ id: contactId });
  const [result, setResult] = useState<{ fieldsUpdated: string[]; suggestions: Record<string, string> } | null>(null);

  const enrich = trpc.contacts.enrich.useMutation({
    onSuccess: (data) => {
      setResult(data);
      utils.contacts.get.invalidate({ id: contactId });
      utils.contacts.getWithAccount.invalidate({ id: contactId });
      onEnriched();
      if (data.fieldsUpdated.length > 0) {
        toast.success(`Enriched ${data.fieldsUpdated.length} field${data.fieldsUpdated.length > 1 ? "s" : ""}: ${data.fieldsUpdated.join(", ")}`);
      } else {
        toast.info("No new fields to enrich — contact already has all available data.");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="size-3 animate-spin" /> Loading…</div>;
  }

  const FIELD_LABELS: Record<string, string> = {
    title: "Job Title",
    phone: "Phone",
    linkedinUrl: "LinkedIn URL",
    city: "City",
    seniority: "Seniority",
  };

  const missingFields = Object.keys(FIELD_LABELS).filter((f) => {
    const v = (contact as any)?.[f];
    return v === null || v === undefined || v === "";
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{contact?.firstName} {contact?.lastName}</p>
            <p className="text-xs text-muted-foreground">{contact?.email ?? "No email"}</p>
          </div>
          <Button
            size="sm"
            onClick={() => enrich.mutate({ id: contactId })}
            disabled={enrich.isPending}
            className="bg-[#14B89A] hover:bg-[#12a589] text-white shrink-0"
          >
            {enrich.isPending ? <><Loader2 className="size-3 animate-spin mr-1" /> Enriching…</> : <><Sparkles className="size-3 mr-1" /> AI Enrich</>}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          AI enrichment uses the contact's name, email domain, and company to suggest missing firmographic fields. Only empty fields are updated.
        </p>

        {missingFields.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Missing Fields</p>
            <div className="flex flex-wrap gap-1.5">
              {missingFields.map((f) => (
                <span key={f} className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{FIELD_LABELS[f]}</span>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-emerald-600">
            <CheckCircle2 className="size-3" /> All enrichable fields are already filled.
          </div>
        )}
      </div>

      {result && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Last Enrichment Result</p>
          {Object.keys(result.suggestions).length === 0 ? (
            <p className="text-sm text-muted-foreground">No suggestions returned by AI.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(result.suggestions).map(([field, value]) => {
                const applied = result.fieldsUpdated.includes(field);
                return (
                  <div key={field} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{FIELD_LABELS[field] ?? field}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{String(value)}</span>
                      {applied ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Applied</span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">Already set</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RecordDrawer({
  open,
  onOpenChange,
  relatedType,
  relatedId,
  title,
  subtitle,
  headerExtras,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  relatedType: RelatedType;
  relatedId: number | null;
  title: string;
  subtitle?: string;
  headerExtras?: React.ReactNode;
}) {
  const [tab, setTab] = useState<"overview" | "timeline" | "call" | "meeting" | "note" | "files" | "score" | "intelligence" | "verify" | "brief" | "email" | "enrich">("overview");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailAiPrompt, setEmailAiPrompt] = useState("");
  const [emailAiMode, setEmailAiMode] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const contactData = trpc.contacts.get.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "contact" && !!relatedId },
  );
  const contactWithAccount = trpc.contacts.getWithAccount.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "contact" && !!relatedId },
  );
  const accountWithContacts = trpc.accounts.getWithContacts.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "account" && !!relatedId },
  );
  const opportunityWithRelated = trpc.opportunities.getWithRelated.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "opportunity" && !!relatedId },
  );
  const verifySingle = trpc.emailVerification.verifySingle.useMutation({
    onSuccess: () => {
      contactData.refetch();
      toast.success("Email verified");
    },
    onError: (err) => toast.error(err.message ?? "Verification failed"),
  });
  const utils = trpc.useUtils();
  const enabled = !!relatedId;
  const acts = trpc.activities.list.useQuery(
    { relatedType, relatedId: relatedId ?? 0 },
    { enabled },
  );
  const files = trpc.attachments.list.useQuery(
    { relatedType, relatedId: relatedId ?? 0 },
    { enabled },
  );

  const refresh = () => {
    if (!relatedId) return;
    utils.activities.list.invalidate({ relatedType, relatedId });
    utils.attachments.list.invalidate({ relatedType, relatedId });
    utils.notifications.list.invalidate();
  };

  const logCall = trpc.activities.logCall.useMutation({ onSuccess: () => { refresh(); toast.success("Call logged"); setTab("timeline"); } });
  const logMeeting = trpc.activities.logMeeting.useMutation({ onSuccess: () => { refresh(); toast.success("Meeting logged"); setTab("timeline"); } });
  const addNote = trpc.activities.addNote.useMutation({ onSuccess: () => { refresh(); toast.success("Note added"); setTab("timeline"); } });
  const upload = trpc.attachments.upload.useMutation({ onSuccess: () => { refresh(); toast.success("File attached"); } });
  const delAtt = trpc.attachments.delete.useMutation({ onSuccess: () => refresh() });

  const fileInput = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !relatedId) return;
    if (f.size > 5 * 1024 * 1024) { toast.error("Max 5MB per file"); return; }
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const b64 = btoa(bin);
    upload.mutate({ relatedType, relatedId, fileName: f.name, mimeType: f.type || "application/octet-stream", base64: b64 });
    e.target.value = "";
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            <span>{title}</span>
            {headerExtras}
          </SheetTitle>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </SheetHeader>

        <div className="flex gap-1 border-b text-xs mt-2 overflow-x-auto">
          {[
            ...(relatedType !== "lead" ? [{ k: "overview", label: "Overview" }] : []),
            { k: "timeline", label: "Timeline" },
            { k: "call", label: "Log call" },
            { k: "meeting", label: "Log meeting" },
            { k: "note", label: "Add note" },
            { k: "files", label: `Files (${files.data?.length ?? 0})` },
            ...(relatedType === "lead" ? [{ k: "score", label: "Score" }] : []),
            ...(relatedType === "opportunity" ? [{ k: "intelligence", label: "AI Intel" }] : []),
            ...((relatedType === "contact" || relatedType === "lead") ? [{ k: "email", label: "Send Email" }] : []),
            ...(relatedType === "contact" ? [{ k: "verify", label: "Email Verify" }] : []),
            ...(relatedType === "contact" ? [{ k: "enrich", label: "AI Enrich" }] : []),
            ...(relatedType === "account" ? [{ k: "brief", label: "AI Brief" }] : []),
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k as any)}
              className={`px-3 py-2 ${tab === t.k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}
            >{t.label}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto py-3 space-y-3">
          {tab === "timeline" && (
            <>
              {acts.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Loading…</div>}
              {acts.data?.length === 0 && <div className="text-sm text-muted-foreground py-8 text-center">No activity logged yet. Use the tabs above to log a call, meeting, or note.</div>}
              {acts.data?.map((a: any) => (
                <div key={a.id} className="border rounded-md p-3 bg-card">
                  <div className="flex items-center gap-2 text-xs">
                    {a.kind === "call" && <Phone className="size-3 text-[#14B89A]" />}
                    {a.kind === "meeting" && <Calendar className="size-3 text-blue-600" />}
                    {a.kind === "note" && <MessageSquare className="size-3 text-amber-600" />}
                    <span className="font-semibold uppercase tracking-wide">{a.kind}</span>
                    {a.disposition && <StatusPill tone={a.disposition === "connected" ? "success" : a.disposition === "not_interested" ? "danger" : "warning"}>{a.disposition.replace(/_/g, " ")}</StatusPill>}
                    <span className="ml-auto text-muted-foreground">{fmtDate(a.createdAt)}</span>
                  </div>
                  {a.subject && <div className="text-sm font-semibold mt-1">{a.subject}</div>}
                  {a.notes && <div className="text-sm whitespace-pre-wrap mt-1 text-foreground/90">{a.notes}</div>}
                  {Array.isArray(a.mentions) && a.mentions.length > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-1">Notified: {a.mentions.length} user(s)</div>
                  )}
                </div>
              ))}
            </>
          )}

          {tab === "call" && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!relatedId) return;
              const fd = new FormData(e.currentTarget);
              logCall.mutate({
                relatedType, relatedId,
                disposition: fd.get("disposition") as any,
                durationSec: Number(fd.get("durationSec") || 0),
                outcome: String(fd.get("outcome") || ""),
                notes: String(fd.get("notes") || ""),
              });
            }} className="space-y-3">
              <div>
                <div className="text-xs font-semibold mb-1">Disposition</div>
                <select name="disposition" className="w-full border rounded-md px-3 py-2 text-sm h-10" defaultValue="connected">
                  {DISPOSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold mb-1">Duration (seconds)</div>
                  <input name="durationSec" type="number" min={0} defaultValue={120} className="w-full border rounded-md px-3 py-2 text-sm h-10" />
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">Outcome (one line)</div>
                  <input name="outcome" placeholder="Booked next meeting" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Notes</div>
                <textarea name="notes" rows={5} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <Button type="submit" disabled={logCall.isPending}>{logCall.isPending ? "Saving…" : "Log call"}</Button>
            </form>
          )}

          {tab === "meeting" && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!relatedId) return;
              const fd = new FormData(e.currentTarget);
              logMeeting.mutate({
                relatedType, relatedId,
                subject: String(fd.get("subject") || "Meeting"),
                attendees: String(fd.get("attendees") || "").split(",").map((s) => s.trim()).filter(Boolean),
                notes: [String(fd.get("agenda") || ""), String(fd.get("notes") || "")].filter(Boolean).join("\n\n---\n\n"),
              });
            }} className="space-y-3">
              <div>
                <div className="text-xs font-semibold mb-1">Subject</div>
                <input name="subject" required defaultValue="Discovery" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Attendees (comma separated)</div>
                <input name="attendees" placeholder="Alice, Bob, …" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Agenda</div>
                <textarea name="agenda" rows={3} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Meeting notes</div>
                <textarea name="notes" rows={6} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <Button type="submit" disabled={logMeeting.isPending}>{logMeeting.isPending ? "Saving…" : "Log meeting"}</Button>
            </form>
          )}

          {tab === "note" && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!relatedId) return;
              const fd = new FormData(e.currentTarget);
              addNote.mutate({
                relatedType, relatedId,
                body: String(fd.get("body") || ""),
              });
            }} className="space-y-3">
              <div className="text-xs text-muted-foreground">Use <code className="bg-secondary px-1 rounded">@[Name](user:1)</code> to @-mention a teammate. They'll get an in-app notification.</div>
              <textarea name="body" required rows={6} placeholder="Quick update on this account…" className="w-full border rounded-md px-3 py-2 text-sm" />
              <Button type="submit" disabled={addNote.isPending}>{addNote.isPending ? "Saving…" : "Add note"}</Button>
            </form>
          )}

          {tab === "overview" && relatedType === "contact" && (
            <ContactOverview
              contact={contactWithAccount.data?.contact ?? contactData.data ?? { id: relatedId ?? 0, firstName: "", lastName: "" }}
              account={contactWithAccount.data?.account ?? null}
              isLoading={contactWithAccount.isLoading}
              onAccountClick={(accountId) => {
                // Navigate to account drawer — caller can handle via onOpenChange + re-open
                toast.info(`Account ID ${accountId} — open from the Accounts list`);
              }}
            />
          )}

          {tab === "overview" && relatedType === "account" && (
            <AccountOverview
              account={accountWithContacts.data?.account ?? { id: relatedId ?? 0, name: title }}
              contacts={accountWithContacts.data?.contacts ?? []}
              isLoading={accountWithContacts.isLoading}
              onContactClick={(contactId) => {
                toast.info(`Contact ID ${contactId} — open from the Contacts list`);
              }}
            />
          )}

          {tab === "overview" && relatedType === "opportunity" && (
            <OpportunityOverview
              opportunity={opportunityWithRelated.data?.opportunity ?? { id: relatedId ?? 0, name: title, stage: "discovery", value: "0", winProb: 20 }}
              account={opportunityWithRelated.data?.account ?? null}
              contactRoles={opportunityWithRelated.data?.contactRoles ?? []}
              isLoading={opportunityWithRelated.isLoading}
              onAccountClick={(accountId) => {
                toast.info(`Account ID ${accountId} — open from the Accounts list`);
              }}
              onContactClick={(contactId) => {
                toast.info(`Contact ID ${contactId} — open from the Contacts list`);
              }}
            />
          )}

          {tab === "score" && relatedType === "lead" && relatedId && (
            <LeadScorePanel leadId={relatedId} />
          )}

          {tab === "intelligence" && relatedType === "opportunity" && relatedId && (
            <OppIntelligencePanel opportunityId={relatedId} />
          )}

          {tab === "brief" && relatedType === "account" && relatedId && (
            <AccountBriefPanel accountId={relatedId} />
          )}

          {tab === "email" && relatedType === "contact" && relatedId && (
            <ContactEmailTab
              contactId={relatedId}
              subject={emailSubject}
              body={emailBody}
              aiPrompt={emailAiPrompt}
              aiMode={emailAiMode}
              sent={emailSent}
              onSubjectChange={setEmailSubject}
              onBodyChange={setEmailBody}
              onAiPromptChange={setEmailAiPrompt}
              onAiModeChange={setEmailAiMode}
              onSent={() => { setEmailSent(true); refresh(); }}
              onReset={() => { setEmailSubject(""); setEmailBody(""); setEmailAiPrompt(""); setEmailAiMode(false); setEmailSent(false); }}
            />
          )}

          {tab === "email" && relatedType === "lead" && relatedId && (
            <LeadEmailTab
              leadId={relatedId}
              subject={emailSubject}
              body={emailBody}
              aiPrompt={emailAiPrompt}
              aiMode={emailAiMode}
              sent={emailSent}
              onSubjectChange={setEmailSubject}
              onBodyChange={setEmailBody}
              onAiPromptChange={setEmailAiPrompt}
              onAiModeChange={setEmailAiMode}
              onSent={() => { setEmailSent(true); refresh(); }}
              onReset={() => { setEmailSubject(""); setEmailBody(""); setEmailAiPrompt(""); setEmailAiMode(false); setEmailSent(false); }}
            />
          )}

          {tab === "verify" && relatedType === "contact" && (
            <ContactVerifyPanel
              contact={contactData.data}
              isLoading={contactData.isLoading}
              isVerifying={verifySingle.isPending}
              onVerify={() => {
                if (relatedId && contactData.data?.email) {
                  verifySingle.mutate({ contactId: relatedId });
                }
              }}
            />
          )}

          {tab === "enrich" && relatedType === "contact" && relatedId && (
            <ContactEnrichPanel contactId={relatedId} onEnriched={() => { contactData.refetch(); contactWithAccount.refetch(); }} />
          )}

          {tab === "files" && (
            <>
              <div className="flex items-center gap-2">
                <input ref={fileInput} type="file" className="hidden" onChange={onFile} />
                <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
                  <Paperclip className="size-3 mr-1" /> {upload.isPending ? "Uploading…" : "Attach file"}
                </Button>
                <span className="text-xs text-muted-foreground">5 MB max per file. Stored in S3.</span>
              </div>
              {files.data?.length === 0 && <div className="text-sm text-muted-foreground py-8 text-center">No files attached.</div>}
              <div className="space-y-2">
                {files.data?.map((f: any) => (
                  <div key={f.id} className="flex items-center gap-2 border rounded-md p-2 bg-card">
                    <Paperclip className="size-3 text-muted-foreground" />
                    <a href={f.url} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline flex-1 truncate">{f.fileName}</a>
                    <span className="text-[11px] text-muted-foreground">{Math.round(((f.sizeBytes ?? 0) / 1024))} KB</span>
                    <button onClick={() => delAtt.mutate({ id: f.id })} className="text-muted-foreground hover:text-rose-600">
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ─── Lead Email Tab ──────────────────────────────────────────────────── */
function LeadEmailTab({
  leadId,
  subject,
  body,
  aiPrompt,
  aiMode,
  sent,
  onSubjectChange,
  onBodyChange,
  onAiPromptChange,
  onAiModeChange,
  onSent,
  onReset,
}: {
  leadId: number;
  subject: string;
  body: string;
  aiPrompt: string;
  aiMode: boolean;
  sent: boolean;
  onSubjectChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onAiPromptChange: (v: string) => void;
  onAiModeChange: (v: boolean) => void;
  onSent: () => void;
  onReset: () => void;
}) {
  const generate = trpc.emailDrafts.compose.useMutation({
    onSuccess: (data) => {
      onSubjectChange(data.subject ?? "");
      onBodyChange(data.body ?? "");
      onAiModeChange(false);
      toast.success("AI email generated — review and send");
    },
    onError: (e: any) => toast.error(e.message),
  });
  const send = trpc.leads.sendAdHocEmail.useMutation({
    onSuccess: () => { onSent(); toast.success("Email sent"); },
    onError: (e: any) => toast.error(e.message),
  });
  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <CheckCircle2 className="size-10 text-emerald-500" />
        <p className="text-sm font-medium">Email sent successfully</p>
        <Button variant="outline" size="sm" onClick={onReset}>Send another</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
        <Wand2 className="size-4 text-violet-500 shrink-0" />
        <div className="flex-1 text-sm">Generate with AI</div>
        <Button size="sm" variant={aiMode ? "default" : "outline"} onClick={() => onAiModeChange(!aiMode)}>
          {aiMode ? "Cancel" : "Use AI"}
        </Button>
      </div>
      {aiMode && (
        <div className="space-y-2">
          <Textarea
            placeholder="Describe the email (e.g. 'Follow up on our demo last week, offer a free trial')"
            value={aiPrompt}
            onChange={(e) => onAiPromptChange(e.target.value)}
            rows={3}
          />
          <Button size="sm" className="w-full" onClick={() => generate.mutate({ prompt: aiPrompt })} disabled={!aiPrompt.trim() || generate.isPending}>
            {generate.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Wand2 className="size-4 mr-1" />}
            Generate Email
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Subject</label>
        <Input placeholder="Email subject…" value={subject} onChange={(e) => onSubjectChange(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Body</label>
        <Textarea placeholder="Email body…" value={body} onChange={(e) => onBodyChange(e.target.value)} rows={10} />
      </div>
      <Button
        className="w-full"
        onClick={() => send.mutate({ leadId, subject, body, aiGenerated: generate.isSuccess })}
        disabled={!subject.trim() || !body.trim() || send.isPending}
      >
        {send.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Send className="size-4 mr-1" />}
        Send Email
      </Button>
    </div>
  );
}

/* ─── Contact Email Tab ────────────────────────────────────────────────── */
function ContactEmailTab({
  contactId,
  subject,
  body,
  aiPrompt,
  aiMode,
  sent,
  onSubjectChange,
  onBodyChange,
  onAiPromptChange,
  onAiModeChange,
  onSent,
  onReset,
}: {
  contactId: number;
  subject: string;
  body: string;
  aiPrompt: string;
  aiMode: boolean;
  sent: boolean;
  onSubjectChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onAiPromptChange: (v: string) => void;
  onAiModeChange: (v: boolean) => void;
  onSent: () => void;
  onReset: () => void;
}) {
  const generate = trpc.emailDrafts.compose.useMutation({
    onSuccess: (data) => {
      onSubjectChange(data.subject ?? "");
      onBodyChange(data.body ?? "");
      onAiModeChange(false);
      toast.success("AI email generated — review and send");
    },
    onError: (e: any) => toast.error(e.message),
  });
  const send = trpc.contacts.sendAdHocEmail.useMutation({
    onSuccess: () => { onSent(); toast.success("Email sent"); },
    onError: (e: any) => toast.error(e.message),
  });
  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <CheckCircle2 className="size-10 text-emerald-500" />
        <p className="text-sm font-medium">Email sent successfully</p>
        <Button variant="outline" size="sm" onClick={onReset}>Send another</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
        <Wand2 className="size-4 text-violet-500 shrink-0" />
        <div className="flex-1 text-sm">Generate with AI</div>
        <Button size="sm" variant={aiMode ? "default" : "outline"} onClick={() => onAiModeChange(!aiMode)}>
          {aiMode ? "Cancel" : "Use AI"}
        </Button>
      </div>
      {aiMode && (
        <div className="space-y-2">
          <Textarea
            placeholder="Describe the email (e.g. 'Follow up on our demo last week, offer a free trial')"
            value={aiPrompt}
            onChange={(e) => onAiPromptChange(e.target.value)}
            rows={3}
          />
          <Button size="sm" className="w-full" onClick={() => generate.mutate({ prompt: aiPrompt })} disabled={!aiPrompt.trim() || generate.isPending}>
            {generate.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Wand2 className="size-4 mr-1" />}
            Generate Email
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Subject</label>
        <Input placeholder="Email subject…" value={subject} onChange={(e) => onSubjectChange(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Body</label>
        <Textarea placeholder="Email body…" value={body} onChange={(e) => onBodyChange(e.target.value)} rows={10} />
      </div>
      <Button
        className="w-full"
        onClick={() => send.mutate({ contactIds: [contactId], subject, body, aiGenerated: false })}
        disabled={!subject.trim() || !body.trim() || send.isPending}
      >
        {send.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Send className="size-4 mr-1" />}
        Send Email
      </Button>
    </div>
  );
}
