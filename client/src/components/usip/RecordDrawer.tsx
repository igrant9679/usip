import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { invalidateDealReads } from "@/lib/crmCache";
import { ConfirmButton, fmtDate, StatusPill } from "./Common";
import { Brain, ChevronDown, CheckCircle2, Clock, Loader2, Paperclip, Phone, Calendar, MessageSquare, RefreshCw, Sparkles, Trash2, Users, XCircle, ShieldCheck, Send, Wand2, Sparkle, Linkedin, UserPlus } from "lucide-react";
import { EmailVerificationBadge } from "./EmailVerificationBadge";
import { RichTextEditor } from "./RichTextEditor";
import { isEmptyEmailBody } from "@shared/emailBody";
import { RecordFiles } from "./MicrosoftGraph";
import { RecordAttachments, RecordNotes } from "./EntityDetail";
import { DrawerTimeline } from "./detail/DrawerTimeline";
import { LinkedInActionsPanel } from "./detail/LinkedInActionsPanel";
import { useLocation } from "wouter";
import { LEAD_TIERS, leadTierLabel, type LeadTier } from "@shared/leadTier";
import { savedScoreLine, type SavedScore } from "@/lib/leadScoreText";
import { ContactOverview } from "./detail/ContactOverview";
import { AccountOverview } from "./detail/AccountOverview";
import { OpportunityOverview } from "./detail/OpportunityOverview";
import { ActivityTimeline } from "./detail/ActivityTimeline";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { toast } from "sonner";
import { tablistProps, tabProps } from "@/lib/tabs";
import { AccountBriefPanel } from "./company/AccountBriefPanel";
import { OPPORTUNITY_DELETE_SCOPE } from "@shared/dealDelete";
import { confirmPaidLookup, useSourceBudgets } from "@/components/usip/SpendPreview";

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
  const recompute = trpc.leadScoring.recompute.useMutation({ onSuccess: () => { utils.leadScoring.breakdown.invalidate({ leadId }); utils.leads.invalidate(); toast.success("Re-scored"); }, onError: (e) => toast.error(e.message) });
  const [openSec, setOpenSec] = useState<"firmo" | "behav" | "ai" | null>("firmo");
  if (isLoading || !bd) return <div className="text-sm text-muted-foreground py-6 flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading score…</div>;
  const tier = bd.tier as string;
  // The label comes from @shared/leadTier rather than a local special case for
  // "sales_ready" plus a capitalise-the-first-letter fallback — which is how
  // one surface ends up saying "Sales Ready" and another "Sales_ready".
  // A lead never scored says so rather than Cold (audit 2026-10-20, P119).
  const tierLabel = bd.saved.scored ? leadTierLabel((LEAD_TIERS as readonly string[]).includes(tier) ? (tier as LeadTier) : null) : "Not scored";
  const tierCls = !bd.saved.scored ? "bg-muted text-muted-foreground" : tier === "sales_ready" ? "bg-emerald-100 text-emerald-800" : tier === "hot" ? "bg-orange-100 text-orange-800" : tier === "warm" ? "bg-yellow-100 text-yellow-800" : "bg-slate-200 text-slate-700";
  // The server's sum of the three maximums (P22).
  const max = bd.maxSum;
  const sparkW = 540, sparkH = 36;
  const vals = (bd.history ?? []).map((h: any) => h.total);
  const sparkPts = vals.length ? vals.map((v: number, i: number) => `${(i * sparkW) / Math.max(1, vals.length - 1)},${sparkH - (v / 100) * (sparkH - 4)}`).join(" ") : "";
  return (
    <div className="space-y-3">
      <div className="rounded border bg-card p-3 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">Total score</div>
          <div className="text-2xl font-mono tabular-nums">{bd.total}<span className="text-sm text-muted-foreground">/100</span> <span className={`text-xs ml-2 px-1.5 rounded ${tierCls}`}>{tierLabel}</span></div>
          <div className="text-[11px] text-muted-foreground mt-1">The three below added up, capped at 100 (max possible {max} pts) · Grade {bd.grade ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">{savedScoreLine(bd.saved as SavedScore, bd.total)}</div>
        </div>
        <Button size="sm" variant="outline" className="bg-card" onClick={() => recompute.mutate({ leadId })} disabled={recompute.isPending}>
          <RefreshCw className={`size-3.5 ${recompute.isPending ? "animate-spin" : ""}`} /> Recompute
        </Button>
      </div>

      <Accordion open={openSec === "firmo"} onToggle={() => setOpenSec(openSec === "firmo" ? null : "firmo")} title="Firmographic" value={bd.firmographic.value} max={bd.firmographic.max} reasons={bd.firmographic.reasons} />
      {/* Behaviour below zero is shown as it is: it lowers the total (P33). */}
      <Accordion open={openSec === "behav"} onToggle={() => setOpenSec(openSec === "behav" ? null : "behav")} title="Behavioral" value={bd.behavioral.value} max={bd.behavioral.max} reasons={bd.behavioral.reasons} />
      <Accordion open={openSec === "ai"} onToggle={() => setOpenSec(openSec === "ai" ? null : "ai")} title="AI Fit" value={bd.aiFit.value} max={bd.aiFit.max} reasons={bd.aiFit.reasons} />

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
    onError: (e) => toast.error(e.message),
  });
  const removeCoOwner = trpc.oppIntelligence.removeCoOwner.useMutation({
    onSuccess: () => utils.oppIntelligence.getCoOwners.invalidate({ opportunityId }),
    onError: (e) => toast.error(e.message),
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

type RecordDrawerProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  relatedType: RelatedType;
  relatedId: number | null;
  title: string;
  subtitle?: string;
  headerExtras?: React.ReactNode;
};

type DrawerTab = "overview" | "timeline" | "opp-timeline" | "call" | "meeting" | "note" | "files" | "score" | "intelligence" | "verify" | "brief" | "email" | "enrich" | "linkedin";

/** Only these types render an Overview; the rest open on their timeline. */
const HAS_OVERVIEW: RelatedType[] = ["contact", "account", "opportunity"];

/**
 * One drawer per record (audit 2026-10-20, R6). The pages keep a single
 * drawer mounted and swap its record, and every piece of state below — the
 * open tab, the email being written, an AI draft — carried over to the next
 * record: a draft written for lead A sat ready to send to lead B. Keyed by
 * the record, the drawer starts fresh for each one. Leads and customers have
 * no Overview, and opened on that blank tab.
 */
export function RecordDrawer(props: RecordDrawerProps) {
  return <RecordDrawerForRecord key={`${props.relatedType}:${props.relatedId ?? "none"}`} {...props} />;
}

function RecordDrawerForRecord({
  open,
  onOpenChange,
  relatedType,
  relatedId,
  title,
  subtitle,
  headerExtras,
}: RecordDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>(() => (HAS_OVERVIEW.includes(relatedType) ? "overview" : "timeline"));
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
  // A lead's LinkedIn profile, for the LinkedIn tab (R44).
  const leadData = trpc.leads.get.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "lead" && !!relatedId },
  );
  const [, navigate] = useLocation();
  const opportunityWithRelated = trpc.opportunities.getWithRelated.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "opportunity" && !!relatedId },
  );
  const verifyBudgets = useSourceBudgets(relatedType === "contact");
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
  const oppTimeline = trpc.opportunities.getTimeline.useQuery(
    { id: relatedId ?? 0 },
    { enabled: relatedType === "opportunity" && !!relatedId },
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
    if (relatedType === "opportunity") utils.opportunities.getTimeline.invalidate({ id: relatedId });
  };

  const logCall = trpc.activities.logCall.useMutation({ onSuccess: () => { refresh(); toast.success("Call logged"); setTab("timeline"); }, onError: (e) => toast.error(e.message) });
  const logMeeting = trpc.activities.logMeeting.useMutation({ onSuccess: () => { refresh(); toast.success("Meeting logged"); setTab("timeline"); }, onError: (e) => toast.error(e.message) });
  const delActivity = trpc.activities.delete.useMutation({
    onSuccess: () => { refresh(); toast.success("Activity deleted"); },
    onError: (e) => toast.error(e.message),
  });
  // Entity-level delete — routes to the right router based on relatedType.
  const delContact = trpc.contacts.delete.useMutation({ onError: (e) => toast.error(e.message) });
  const delAccount = trpc.accounts.delete.useMutation({ onError: (e) => toast.error(e.message) });
  const delLead = trpc.leads.delete.useMutation({ onError: (e) => toast.error(e.message) });
  const delOpp = trpc.opportunities.delete.useMutation({ onError: (e) => toast.error(e.message) });
  // Confirmation is handled by <ConfirmButton> (an in-app AlertDialog), NOT
  // window.confirm — the native dialog blocks the renderer thread, which makes
  // the whole app unresponsive until it's dismissed and is unstyleable.
  const deleteRecord = () => {
    if (!relatedId) return;
    const opts = {
      onSuccess: () => {
        toast.success(`${relatedType.charAt(0).toUpperCase() + relatedType.slice(1)} deleted`);
        // Every list the record was on, not just one (R31): a deleted company
        // stayed on Companies and a deleted deal on Deals, Forecast and Quota.
        if (relatedType === "contact") utils.contacts.invalidate();
        if (relatedType === "account") {
          utils.accounts.invalidate();
          utils.companies.invalidate();
        }
        if (relatedType === "lead") utils.leads.invalidate();
        if (relatedType === "opportunity") invalidateDealReads(utils);
        onOpenChange(false);
      },
      onError: (e: { message: string }) => toast.error(`Failed to delete: ${e.message}`),
    };
    if (relatedType === "contact") delContact.mutate({ id: relatedId }, opts);
    else if (relatedType === "account") delAccount.mutate({ id: relatedId }, opts);
    else if (relatedType === "lead") delLead.mutate({ id: relatedId }, opts);
    else if (relatedType === "opportunity") delOpp.mutate({ id: relatedId }, opts);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          {/* pr-12 reserves space for the Sheet's absolute top-right Close (X)
              so header actions — especially the destructive Delete — never sit
              flush against it (misclick hazard). The Delete is further set apart
              with a divider + margin from the other header actions. */}
          <SheetTitle className="flex items-center justify-between gap-2 pr-12">
            <span className="min-w-0 truncate">{title}</span>
            <div className="flex items-center gap-2 shrink-0">
              {headerExtras}
              {relatedId && (relatedType === "contact" || relatedType === "account" || relatedType === "lead" || relatedType === "opportunity") && (
                <ConfirmButton
                  ariaLabel={`Delete this ${relatedType}`}
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 p-1.5 h-auto rounded-md ml-1 border-l border-border pl-2"
                  title={`Delete this ${relatedType}?`}
                  description={relatedType === "opportunity"
                    ? `"${title || relatedType}" will be permanently deleted, ${OPPORTUNITY_DELETE_SCOPE}. This cannot be undone.`
                    : `"${title || relatedType}" will be permanently deleted. This cannot be undone.`}
                  confirmLabel="Delete"
                  disabled={delContact.isPending || delAccount.isPending || delLead.isPending || delOpp.isPending}
                  onConfirm={deleteRecord}
                >
                  <Trash2 className="size-4" />
                </ConfirmButton>
              )}
            </div>
          </SheetTitle>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </SheetHeader>

        <div {...tablistProps("Record sections")} className="flex gap-1 border-b text-xs mt-2 overflow-x-auto">
          {[
            ...(HAS_OVERVIEW.includes(relatedType) ? [{ k: "overview", label: "Overview" }] : []),
            { k: "timeline", label: "Timeline" },
            { k: "call", label: "Log call" },
            { k: "meeting", label: "Log meeting" },
            { k: "note", label: "Notes" },
            { k: "files", label: `Files (${files.data?.length ?? 0})` },
            ...(relatedType === "lead" ? [{ k: "score", label: "Score" }] : []),
            ...(relatedType === "opportunity" ? [{ k: "opp-timeline", label: "Deal Timeline" }] : []),
            ...(relatedType === "opportunity" ? [{ k: "intelligence", label: "AI Intel" }] : []),
            ...((relatedType === "contact" || relatedType === "lead") ? [{ k: "email", label: "Send Email" }] : []),
            ...((relatedType === "contact" || relatedType === "lead") ? [{ k: "linkedin", label: "LinkedIn" }] : []),
            ...(relatedType === "contact" ? [{ k: "verify", label: "Email Verify" }] : []),
            ...(relatedType === "contact" ? [{ k: "enrich", label: "AI Enrich" }] : []),
            ...(relatedType === "account" ? [{ k: "brief", label: "AI Brief" }] : []),
          ].map((t) => (
            <button {...tabProps(tab === t.k)}
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
              {/* Reads type / body / callDisposition, the row's columns (R7). */}
              {acts.data && <DrawerTimeline rows={acts.data as any[]} onDelete={(id) => delActivity.mutate({ id })} />}
            </>
          )}

          {tab === "opp-timeline" && relatedType === "opportunity" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">All activities for this opportunity in chronological order, including pushed AI meeting summaries.</p>
              </div>
              <ActivityTimeline
                isLoading={oppTimeline.isLoading}
                emptyMessage="No activities yet. Log a call, meeting, or note, or push an AI meeting summary to this opportunity."
                activities={(oppTimeline.data ?? []).map((a) => ({
                  id: a.id,
                  kind: a.isMeetingSummary ? "meeting" : (a.type ?? "note"),
                  subject: a.isMeetingSummary ? a.subject : (a.subject ?? undefined),
                  notes: a.body ?? undefined,
                  disposition: a.disposition ?? undefined,
                  createdAt: a.createdAt,
                }))}
              />
              {/* Meeting summary highlight strip */}
              {(oppTimeline.data ?? []).some((a) => a.isMeetingSummary) && (
                <div className="mt-2 rounded-md border border-violet-200 bg-violet-50 dark:bg-violet-950/30 dark:border-violet-800 px-3 py-2 flex items-center gap-2 text-xs text-violet-700 dark:text-violet-300">
                  <Sparkle className="size-3.5 shrink-0" />
                  <span>AI meeting summaries are highlighted in this timeline. Push more from the Calendar page.</span>
                </div>
              )}
            </div>
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
                <select aria-label="Disposition" name="disposition" className="w-full border rounded-md px-3 py-2 text-sm h-10" defaultValue="connected">
                  {DISPOSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold mb-1">Duration (seconds)</div>
                  <input aria-label="Duration (seconds)" name="durationSec" type="number" min={0} defaultValue={120} className="w-full border rounded-md px-3 py-2 text-sm h-10" />
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">Outcome (one line)</div>
                  <input aria-label="Outcome" name="outcome" placeholder="Booked next meeting" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Notes</div>
                <textarea aria-label="Notes" name="notes" rows={5} className="w-full border rounded-md px-3 py-2 text-sm" />
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
                <input aria-label="Subject" name="subject" required defaultValue="Discovery" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Attendees (comma separated)</div>
                <input aria-label="Attendees (comma separated)" name="attendees" placeholder="Alice, Bob, …" className="w-full border rounded-md px-3 py-2 text-sm h-10" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Agenda</div>
                <textarea aria-label="Agenda" name="agenda" rows={3} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Meeting notes</div>
                <textarea aria-label="Meeting notes" name="notes" rows={6} className="w-full border rounded-md px-3 py-2 text-sm" />
              </div>
              <Button type="submit" disabled={logMeeting.isPending}>{logMeeting.isPending ? "Saving…" : "Log meeting"}</Button>
            </form>
          )}

          {/* The record's notes, the same store its detail page reads (R45):
              the drawer wrote activities rows the detail page never showed. */}
          {tab === "note" && relatedId && (
            <div className="space-y-2">
              {/* R105: this told people to type the raw token. */}
              <div className="text-xs text-muted-foreground">Type @ and a name to mention a teammate. They'll get an in-app notification.</div>
              <RecordNotes entityType={relatedType} entityId={relatedId} />
            </div>
          )}

          {tab === "overview" && relatedType === "contact" && (
            <ContactOverview
              contact={contactWithAccount.data?.contact ?? contactData.data ?? { id: relatedId ?? 0, firstName: "", lastName: "" }}
              account={contactWithAccount.data?.account ?? null}
              isLoading={contactWithAccount.isLoading}
              // The live pages (R46): the toasts sent people to the retired
              // Accounts and Contacts lists.
              onAccountClick={(accountId) => navigate(`/v2/companies/${accountId}`)}
            />
          )}

          {tab === "overview" && relatedType === "account" && (
            <AccountOverview
              account={accountWithContacts.data?.account ?? { id: relatedId ?? 0, name: title }}
              contacts={accountWithContacts.data?.contacts ?? []}
              isLoading={accountWithContacts.isLoading}
              onContactClick={(contactId) => navigate(`/contacts/${contactId}`)}
            />
          )}

          {tab === "overview" && relatedType === "opportunity" && (
            <OpportunityOverview
              opportunity={opportunityWithRelated.data?.opportunity ?? { id: relatedId ?? 0, name: title, stage: "discovery", value: "0", winProb: 20 }}
              account={opportunityWithRelated.data?.account ?? null}
              contactRoles={opportunityWithRelated.data?.contactRoles ?? []}
              isLoading={opportunityWithRelated.isLoading}
              onAccountClick={(accountId) => navigate(`/v2/companies/${accountId}`)}
              onContactClick={(contactId) => navigate(`/contacts/${contactId}`)}
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

          {/* One Files list (R46): the attachments every detail page shows,
              whose delete asks first. OneDrive links appear beneath it only
              for a workspace that connected Microsoft 365. */}
          {tab === "files" && relatedId && (
            <div className="space-y-3">
              <RecordAttachments entityType={relatedType} entityId={relatedId} />
              {["contact", "lead", "account", "opportunity"].includes(relatedType) && (
                <RecordFiles relatedType={relatedType as "contact" | "lead" | "account" | "opportunity"} relatedId={relatedId} onlyWhenConnected />
              )}
            </div>
          )}
          {tab === "verify" && relatedType === "contact" && (
            <ContactVerifyPanel
              contact={contactData.data}
              isLoading={contactData.isLoading}
              isVerifying={verifySingle.isPending}
              onVerify={() => {
                if (relatedId && contactData.data?.email) {
                  // What it spends, said first (audit 2026-10-20, F8).
                  confirmPaidLookup({ title: `Verify ${contactData.data.email}?`, vendor: "Reoon", count: 1, unit: "daily credit", allowance: verifyBudgets.data?.reoon.allowance ?? null, confirmLabel: "Verify" }, () => verifySingle.mutate({ contactId: relatedId }));
                }
              }}
            />
          )}

          {tab === "enrich" && relatedType === "contact" && relatedId && (
            <ContactEnrichPanel contactId={relatedId} onEnriched={() => { contactData.refetch(); contactWithAccount.refetch(); }} />
          )}

          {tab === "linkedin" && (relatedType === "contact" || relatedType === "lead") && (
            <LinkedInActionsPanel
              relatedType={relatedType}
              relatedId={relatedId ?? 0}
              linkedinUrl={relatedType === "lead" ? (leadData.data as any)?.linkedinUrl ?? "" : (contactData.data as any)?.linkedinUrl ?? (contactData.data as any)?.linkedin_url ?? ""}
              name={title}
            />
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
          <Textarea aria-label="Describe the email"
            placeholder="Describe the email (e.g. 'Follow up on our demo last week, offer a free trial')"
            value={aiPrompt}
            onChange={(e) => onAiPromptChange(e.target.value)}
            rows={3}
          />
          {/* Written for this lead, and saved nowhere: the copy fills this form (R50). */}
          <Button size="sm" className="w-full" onClick={() => generate.mutate({ prompt: aiPrompt, toLeadId: leadId, previewOnly: true })} disabled={!aiPrompt.trim() || generate.isPending}>
            {generate.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Wand2 className="size-4 mr-1" />}
            Generate Email
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Subject</label>
        <Input aria-label="Subject" placeholder="Email subject…" value={subject} onChange={(e) => onSubjectChange(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Body</label>
        <RichTextEditor placeholder="Email body…" value={body} onChange={onBodyChange} minHeight="200px" compact aiContext={{ subject, leadId }} />
      </div>
      <Button
        className="w-full"
        onClick={() => send.mutate({ leadId, subject, body, aiGenerated: generate.isSuccess })}
        disabled={!subject.trim() || isEmptyEmailBody(body) || send.isPending}
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
          <Textarea aria-label="Describe the email"
            placeholder="Describe the email (e.g. 'Follow up on our demo last week, offer a free trial')"
            value={aiPrompt}
            onChange={(e) => onAiPromptChange(e.target.value)}
            rows={3}
          />
          {/* Written for this contact, and saved nowhere (R50). */}
          <Button size="sm" className="w-full" onClick={() => generate.mutate({ prompt: aiPrompt, toContactId: contactId, previewOnly: true })} disabled={!aiPrompt.trim() || generate.isPending}>
            {generate.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Wand2 className="size-4 mr-1" />}
            Generate Email
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Subject</label>
        <Input aria-label="Subject" placeholder="Email subject…" value={subject} onChange={(e) => onSubjectChange(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Body</label>
        <RichTextEditor placeholder="Email body…" value={body} onChange={onBodyChange} minHeight="200px" compact aiContext={{ subject, contactId }} />
      </div>
      <Button
        className="w-full"
        onClick={() => send.mutate({ contactIds: [contactId], subject, body, aiGenerated: false })}
        disabled={!subject.trim() || isEmptyEmailBody(body) || send.isPending}
      >
        {send.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Send className="size-4 mr-1" />}
        Send Email
      </Button>
    </div>
  );
}
