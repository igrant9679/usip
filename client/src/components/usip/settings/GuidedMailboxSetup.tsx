/**
 * GuidedMailboxSetup — the full-screen guided mailbox linking + configuration
 * wizard (Settings → Mailboxes → "Link mailbox" / "Configure mailbox").
 *
 * Backed by the REAL sending-accounts infrastructure (sending_accounts table,
 * migration 0118 setup columns): linking creates rows, the SMTP test buttons
 * hit sendingAccounts.testConfig (live nodemailer verification), and every
 * configuration module persists via sendingAccounts.update.
 *
 * Flow: provider select → (OAuth-less Google/Outlook link | SMTP/IMAP choice →
 * single form | CSV bulk import) → linked confirmation → Signature → Sending
 * limits → Opt-out link → completion. Re-entry with an incomplete account
 * lands on the configuration overview (resume) screen.
 *
 * TODO(oauth): Google/Outlook cards collect the address and create the account
 * without provider credentials — real OAuth consent needs a Google/Microsoft
 * app registration. TODO(imap-verify): IMAP test validates fields only; no
 * IMAP client library is installed server-side.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  X,
  Mail,
  Check,
  ChevronLeft,
  ChevronDown,
  Server,
  FileSpreadsheet,
  UploadCloud,
  Trash2,
  Download,
  Eye,
  EyeOff,
  Info,
  CheckCircle2,
  XCircle,
  Loader2,
  RotateCcw,
  Sparkles,
  Plug,
  Network,
  Link2,
  Lock,
  Lightbulb,
  Settings2,
  Wrench,
  CheckCheck,
  TriangleAlert,
  Send,
} from "lucide-react";

/* ─────────────────────────── shared helpers ───────────────────────────── */

export type MailboxAccount = Record<string, any>;

/** Setup progress: 40% for linking + 20% per completed configuration module. */
export function setupProgress(a: MailboxAccount): number {
  let p = 40;
  if (a.signatureCompleted) p += 20;
  if (a.sendingLimitsCompleted) p += 20;
  if (a.optOutCompleted) p += 20;
  return p;
}
export function setupComplete(a: MailboxAccount): boolean {
  return !!(a.signatureCompleted && a.sendingLimitsCompleted && a.optOutCompleted);
}

export const PROVIDER_META: Record<string, { label: string; tile: string; letter: string }> = {
  google_oauth: { label: "Google", tile: "bg-red-500", letter: "G" },
  outlook_oauth: { label: "Outlook", tile: "bg-sky-600", letter: "O" },
  generic_smtp: { label: "SMTP/IMAP", tile: "bg-slate-600", letter: "S" },
  amazon_ses: { label: "Amazon SES", tile: "bg-amber-600", letter: "A" },
};

/** Hand-rolled brand glyphs (lucide has no brand icons — house rule). */
export function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn("size-6 shrink-0", className)} aria-label="Google">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function OutlookGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6 shrink-0", className)} aria-label="Outlook">
      <rect x="1.5" y="3.5" width="21" height="17" rx="3" fill="#0F6CBD" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="#fff" strokeWidth="2.6" />
    </svg>
  );
}

/** Gmail envelope (used to the left of the address in the mailbox listing). */
export function GmailGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn("size-6 shrink-0", className)} aria-label="Gmail">
      <path fill="#4caf50" d="M45 16.2l-5 2.75l-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8C4.924 8 3 9.924 3 12.298z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8C43.076 8 45 9.924 45 12.298z" />
    </svg>
  );
}

export function ProviderTile({ provider, email, className }: { provider: string; email?: string; className?: string }) {
  if (provider === "google_oauth") return <GmailGlyph className={className} />;
  if (provider === "outlook_oauth") return <OutlookGlyph className={className} />;
  // SMTP/IMAP mailboxes carry no provider brand — infer it from the address so
  // the listing shows a real logo instead of a bare "S". Outlook-family domains
  // get the Outlook mark; everything else defaults to the Gmail mark.
  if (provider === "generic_smtp") {
    const domain = (email ?? "").split("@")[1]?.toLowerCase() ?? "";
    if (/(outlook|hotmail|live|msn|office365|microsoft)\./.test(domain + ".")) {
      return <OutlookGlyph className={className} />;
    }
    return <GmailGlyph className={className} />;
  }
  const m = PROVIDER_META[provider] ?? PROVIDER_META.generic_smtp;
  return (
    <span
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white",
        m.tile,
        className,
      )}
      title={m.label}
    >
      {m.letter}
    </span>
  );
}

/** Lime primary button used across the guided setup (matches the reference). */
export const limeBtn =
  "inline-flex items-center gap-1.5 rounded-md bg-lime-300 px-4 py-2 text-[13px] font-semibold text-slate-900 transition-colors hover:bg-lime-400 disabled:opacity-50 disabled:pointer-events-none";
const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-[13px] font-medium transition-colors hover:bg-muted disabled:opacity-50";

type WizardStep =
  | "provider"
  | "linked"
  | "signature"
  | "limits"
  | "optout"
  | "overview"
  | "complete";

/* ─────────────────────────────── wizard ───────────────────────────────── */

export function GuidedMailboxSetup({
  open,
  onClose,
  account,
  initialStep,
}: {
  open: boolean;
  onClose: () => void;
  /** Resume configuration for an existing account. */
  account?: MailboxAccount | null;
  initialStep?: WizardStep;
}) {
  const utils = trpc.useUtils();
  const [step, setStep] = useState<WizardStep>(initialStep ?? "provider");
  const [acct, setAcct] = useState<MailboxAccount | null>(account ?? null);
  const [provider, setProvider] = useState<"google" | "outlook" | "imap" | null>(null);
  const [tos, setTos] = useState(false);
  const [modal, setModal] = useState<null | "choice" | "smtp" | "csv" | "oauth">(null);

  // Reset when (re)opened.
  useEffect(() => {
    if (open) {
      setStep(initialStep ?? (account ? "overview" : "provider"));
      setAcct(account ?? null);
      setProvider(null);
      setTos(false);
      setModal(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = trpc.sendingAccounts.update.useMutation({
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const saveAcct = async (patch: Record<string, unknown>) => {
    if (!acct) return;
    await update.mutateAsync({ id: acct.id, ...patch } as any);
    setAcct((a) => (a ? { ...a, ...patch } : a));
    utils.sendingAccounts.list.invalidate();
  };

  const onLinked = (created: MailboxAccount) => {
    setAcct(created);
    setModal(null);
    setStep("linked");
    utils.sendingAccounts.list.invalidate();
  };

  if (!open) return null;

  const modulesDone = acct ? [acct.signatureCompleted, acct.sendingLimitsCompleted, acct.optOutCompleted].filter(Boolean).length : 0;
  const configuring = ["signature", "limits", "optout", "overview"].includes(step);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="fixed inset-0 z-[90] flex bg-background text-foreground" role="dialog" aria-modal="true" aria-label="Guided mailbox setup">
        {/* ── dark setup sidebar ── */}
        <aside className="hidden md:flex w-72 shrink-0 flex-col bg-slate-900 text-slate-100">
          <div className="px-6 pt-8 pb-6">
            <h2 className="text-[17px] font-semibold leading-snug">Welcome to the guided mailbox setup!</h2>
          </div>
          <nav className="flex-1 space-y-1 px-4">
            <SidebarStep label="Link mailbox" state={acct ? "done" : "active"} />
            <SidebarStep
              label="Configure mailbox"
              state={configuring ? "active" : step === "complete" ? "done" : "todo"}
              chevron={configuring || step === "complete"}
            />
            {(configuring || step === "complete") && (
              <div className="ml-[17px] space-y-0.5 border-l border-slate-700 pl-3">
                <SidebarSubstep label="Signature" done={!!acct?.signatureCompleted} active={step === "signature"} />
                <SidebarSubstep label="Sending limits" done={!!acct?.sendingLimitsCompleted} active={step === "limits"} />
                <SidebarSubstep label="Opt out link" done={!!acct?.optOutCompleted} active={step === "optout"} />
              </div>
            )}
            <SidebarStep label="Finish setup" state={step === "complete" ? "active" : "todo"} />
          </nav>
          <div className="px-5 pb-6 space-y-3">
            <div className="relative rounded-lg rounded-bl-none bg-slate-800/80 p-3.5 text-[12px] leading-relaxed text-slate-300">
              <Sparkles className="absolute -top-2 right-2 size-4 text-slate-400" />
              {STEP_TIPS[step] ?? STEP_TIPS.provider}
            </div>
            <a href="/help" className="block text-[12px] font-medium text-slate-300 underline underline-offset-2 hover:text-white">
              Learn more about linking mailboxes
            </a>
          </div>
        </aside>

        {/* ── main area ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* top bar */}
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4 sm:px-6">
            {acct && (
              <>
                <Mail className="size-4 text-muted-foreground" />
                <span className="truncate text-[13px] font-medium">{acct.fromEmail}</span>
                <span className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                  setupComplete(acct)
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
                )}>
                  {setupComplete(acct) ? "Setup complete" : "Setup in progress"}
                </span>
              </>
            )}
            <div className="flex-1" />
            <button type="button" onClick={onClose} aria-label="Close setup" className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>

          {/* step body */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {step === "provider" && (
              <ProviderStep
                provider={provider}
                setProvider={setProvider}
                tos={tos}
                setTos={setTos}
                onLink={() => setModal(provider === "imap" ? "choice" : "oauth")}
              />
            )}
            {step === "linked" && acct && <LinkedStep acct={acct} onCloseWizard={onClose} />}
            {step === "signature" && acct && (
              <SignatureStep acct={acct} save={saveAcct} />
            )}
            {step === "limits" && acct && <LimitsStep acct={acct} save={saveAcct} />}
            {step === "optout" && acct && <OptOutStep acct={acct} save={saveAcct} />}
            {step === "overview" && acct && (
              <OverviewStep acct={acct} goTo={(s) => setStep(s)} />
            )}
            {step === "complete" && acct && (
              <CompleteStep acct={acct} onClose={onClose} onLinkAnother={() => { setAcct(null); setProvider(null); setTos(false); setStep("provider"); }} onConfigure={() => setStep(setupComplete(acct) ? "overview" : "signature")} />
            )}
          </div>

          {/* bottom action bar */}
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 sm:px-6">
            {step === "provider" && (
              <>
                <div className="flex-1" />
                <button type="button" className={ghostBtn} onClick={onClose}>Back</button>
                {/* Enabled once a mailbox is linked — linking auto-advances, so it stays disabled here. */}
                <button type="button" className={ghostBtn} disabled>
                  Next: Configure mailbox
                </button>
              </>
            )}
            {step === "linked" && (
              <>
                <button type="button" className={ghostBtn} onClick={onClose}>Finish later</button>
                <div className="flex-1" />
                <button type="button" className={ghostBtn} onClick={() => setStep("provider")}>Back</button>
                <button type="button" className={limeBtn} onClick={() => setStep("signature")}>Next: Configure mailbox</button>
              </>
            )}
            {step === "signature" && (
              <StepBar
                onSkip={async () => { await saveAcct({ signatureCompleted: true }); setStep("limits"); }}
                onPrev={() => setStep("linked")}
                onComplete={async () => { await saveAcct({ signatureCompleted: true }); setStep("limits"); }}
                completing={update.isPending}
              />
            )}
            {step === "limits" && (
              <StepBar
                onSkip={async () => { await saveAcct({ sendingLimitsCompleted: true }); setStep("optout"); }}
                onPrev={() => setStep("signature")}
                onComplete={async () => { await saveAcct({ sendingLimitsCompleted: true }); setStep("optout"); }}
                completing={update.isPending}
                completeViaEvent
              />
            )}
            {step === "optout" && (
              <StepBar
                onSkip={async () => { await saveAcct({ optOutCompleted: true }); setStep("complete"); }}
                onPrev={() => setStep("limits")}
                onComplete={async () => { await saveAcct({ optOutCompleted: true }); setStep("complete"); }}
                completing={update.isPending}
                prevLabel="Back"
              />
            )}
            {step === "overview" && acct && (
              <>
                <button type="button" className={ghostBtn} onClick={onClose}>Skip this step</button>
                <div className="flex-1" />
                <button type="button" className={ghostBtn} onClick={onClose}>Back</button>
                {modulesDone === 3 ? (
                  <button type="button" className={limeBtn} onClick={() => setStep("complete")}>Finish setup</button>
                ) : (
                  <button
                    type="button"
                    className={limeBtn}
                    onClick={() => setStep(!acct.signatureCompleted ? "signature" : !acct.sendingLimitsCompleted ? "limits" : "optout")}
                  >
                    Fix Configuration Issues
                  </button>
                )}
              </>
            )}
            {step === "complete" && (
              <>
                <div className="flex-1" />
                <button type="button" className={ghostBtn} onClick={() => setStep("optout")}>Previous</button>
                <button type="button" className={limeBtn} onClick={onClose}>Close</button>
              </>
            )}
          </div>
        </div>

        {/* ── overlays ── */}
        <OauthLinkDialog
          open={modal === "oauth"}
          provider={provider === "google" ? "google_oauth" : "outlook_oauth"}
          onBack={() => setModal(null)}
          onLinked={onLinked}
        />
        <SmtpImapChoiceDialog
          open={modal === "choice"}
          onBack={() => setModal(null)}
          onSingle={() => setModal("smtp")}
          onBulk={() => setModal("csv")}
        />
        <SmtpImapFormDialog open={modal === "smtp"} onCancel={() => setModal("choice")} onLinked={onLinked} />
        <CsvImportDialog open={modal === "csv"} onCancel={() => setModal("choice")} onLinked={onLinked} />
      </div>
    </TooltipProvider>
  );
}

/** Contextual assistant tip shown in the sidebar speech bubble, per step. */
const STEP_TIPS: Record<string, string> = {
  provider:
    "While Gmail is a popular Email Service Provider (ESP), Velocity supports many different email providers and custom email servers.",
  linked: "Check your mailbox configuration to ensure your outbound is set up for success.",
  signature:
    "Keep it simple and professional to avoid spam flags. Include your name, position, company and contact info, but avoid heavy images, fancy text formatting, or heavy HTML.",
  limits: "Use Velocity's default sending limits to maintain deliverability and a good sender reputation.",
  optout:
    "Recipients can opt out of emails sent by you, maintaining their choice. This also ensures you are adhering to best practices per Google and Microsoft.",
  overview:
    "Uh-oh! If your mailbox needs a few tweaks, making updates is simple: just hit \"Fix Configuration Issues\" to start.",
  complete: "Check your mailbox configuration to ensure your outbound is set up for success.",
};

function SidebarStep({
  label, state, chevron,
}: {
  label: string;
  state: "done" | "active" | "todo";
  chevron?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-md px-2.5 py-2", state === "active" && "bg-slate-800")}>
      {state === "done" ? (
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-emerald-400 text-emerald-400">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      ) : state === "active" ? (
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full bg-emerald-400" />
        </span>
      ) : (
        <span className="size-[18px] shrink-0 rounded-full border-[1.5px] border-slate-600" />
      )}
      <span className={cn("text-[13px]", state === "todo" ? "text-slate-400" : "font-medium text-slate-100")}>
        {label}
      </span>
      {chevron && <ChevronDown className="ml-auto size-3.5 rotate-180 text-slate-400" />}
    </div>
  );
}

function SidebarSubstep({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5", active && "bg-slate-800")}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {done && <Check className="size-3 text-emerald-400" strokeWidth={3} />}
      </span>
      <span className={cn("text-[12.5px]", active || done ? "text-slate-100" : "text-slate-400", active && "font-medium")}>
        {label}
      </span>
    </div>
  );
}

function StepBar({
  onSkip, onPrev, onComplete, completing, prevLabel = "Previous", completeViaEvent,
}: {
  onSkip: () => void;
  onPrev: () => void;
  onComplete: () => void;
  completing?: boolean;
  prevLabel?: string;
  /** limits step saves its own inputs first via a custom event */
  completeViaEvent?: boolean;
}) {
  return (
    <>
      <button type="button" className={ghostBtn} onClick={onSkip} disabled={completing}>Skip this step</button>
      <div className="flex-1" />
      <button type="button" className={ghostBtn} onClick={onPrev} disabled={completing}>{prevLabel}</button>
      <button
        type="button"
        className={limeBtn}
        disabled={completing}
        onClick={() => {
          if (completeViaEvent) window.dispatchEvent(new CustomEvent("mailbox-limits-complete"));
          onComplete();
        }}
      >
        {completing ? <Loader2 className="size-3.5 animate-spin" /> : null} Complete
      </button>
    </>
  );
}

/* ─────────────────────── step 1: provider selection ───────────────────── */

function ProviderStep({
  provider, setProvider, tos, setTos, onLink,
}: {
  provider: "google" | "outlook" | "imap" | null;
  setProvider: (p: "google" | "outlook" | "imap") => void;
  tos: boolean;
  setTos: (v: boolean) => void;
  onLink: () => void;
}) {
  const kw = "font-medium text-sky-700 dark:text-sky-400";
  const cards = [
    { id: "google" as const, title: "Google", sub: "Gmail / GSuite", icon: <GoogleGlyph className="size-9" /> },
    { id: "outlook" as const, title: "Outlook", sub: "Hotmail, Live, MSN", icon: <OutlookGlyph className="size-9" /> },
    { id: "imap" as const, title: "Other", sub: "Any provider, IMAP", icon: <Mail className="size-9 text-foreground/80" strokeWidth={1.25} />, lock: true },
  ];
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-[26px] font-bold tracking-tight">Let's link your mailbox</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
        Link your mailboxes with Velocity to gain full functionality of core engagement tools, like{" "}
        <span className={kw}>emails</span>, <span className={kw}>sequences</span>,{" "}
        <span className={kw}>conversations</span>, <span className={kw}>meetings</span> and more.
      </p>

      <h2 className="mt-8 text-[14px] font-semibold">Choose your email provider</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setProvider(c.id)}
            aria-pressed={provider === c.id}
            className={cn(
              "relative flex flex-col items-center gap-1.5 rounded-lg border bg-card px-4 py-7 text-center transition-colors",
              provider === c.id ? "border-sky-500 shadow-sm" : "border-border hover:border-foreground/30",
            )}
          >
            {c.lock && <Lock className="absolute right-3 top-3 size-3.5 text-muted-foreground" />}
            <span className="flex h-11 items-center">{c.icon}</span>
            <span className="text-[14px] font-semibold">{c.title}</span>
            <span className="text-[12.5px] text-muted-foreground">{c.sub}</span>
          </button>
        ))}
      </div>

      <h2 className="mt-9 text-[14px] font-semibold">Velocity Terms of Service</h2>
      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg bg-muted/70 px-4 py-4 text-[12.5px] leading-relaxed">
        <Checkbox checked={tos} onCheckedChange={(v) => setTos(v === true)} className="mt-0.5 bg-background" />
        <span className="text-muted-foreground">
          I agree to Velocity's{" "}
          <a href="/help" className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">Terms of Service</a>{" "}
          and will not use Velocity to send any spam or harassing emails (commercial or otherwise) in violation
          of any applicable laws. By clicking "Link mailbox" below, I acknowledge that Velocity will send email
          on my behalf from this account and store the connection credentials securely to provide me with the
          Services.
        </span>
      </label>

      <div className="mt-8 flex justify-end border-t border-border pt-5">
        <button type="button" className={limeBtn} disabled={!provider || !tos} onClick={onLink}>
          <Link2 className="size-4" /> Link mailbox
        </button>
      </div>
    </div>
  );
}

/* ─────────────── OAuth-less Google/Outlook link (TODO oauth) ──────────── */

function OauthLinkDialog({
  open, provider, onBack, onLinked,
}: {
  open: boolean;
  provider: "google_oauth" | "outlook_oauth";
  onBack: () => void;
  onLinked: (a: MailboxAccount) => void;
}) {
  const [email, setEmail] = useState("");
  const utils = trpc.useUtils();
  const create = trpc.sendingAccounts.create.useMutation({
    onError: (e: any) => toast.error(e?.message ?? "Could not link mailbox"),
  });
  const label = provider === "google_oauth" ? "Google" : "Outlook";
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const link = async () => {
    const fromEmail = email.trim().toLowerCase();
    const r = await create.mutateAsync({
      name: fromEmail,
      provider,
      fromEmail,
      dailySendLimit: 50,
      hourlySendLimit: 6,
      delaySeconds: 600,
    } as any);
    const list = await utils.sendingAccounts.list.fetch();
    const created = (list as any[]).find((a) => a.id === (r as any).id) ?? { id: (r as any).id, fromEmail, provider, aliases: [], isDefault: false };
    toast.success(`${fromEmail} linked`);
    onLinked(created);
    setEmail("");
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onBack()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link your {label} mailbox</DialogTitle>
          <DialogDescription>
            Enter the {label} address to link. Full {label} OAuth consent isn't connected yet — sending
            through this mailbox activates once credentials are added (or connect it via SMTP/IMAP instead).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Email address</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
          <Button size="sm" disabled={!valid || create.isPending} onClick={link} className="gap-1.5">
            {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Link mailbox
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────── SMTP/IMAP option choice modal ───────────────────── */

function SmtpImapChoiceDialog({
  open, onBack, onSingle, onBulk,
}: {
  open: boolean;
  onBack: () => void;
  onSingle: () => void;
  onBulk: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onBack()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onBack} aria-label="Back" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronLeft className="size-4" />
            </button>
            <DialogTitle>Connect SMTP/IMAP accounts</DialogTitle>
          </div>
          <DialogDescription className="pt-1">
            Choose an option to connect email accounts either in bulk or individually.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
          <button
            type="button"
            onClick={onSingle}
            className="flex flex-col items-center gap-2.5 rounded-lg bg-muted/70 px-4 py-8 text-center transition-shadow hover:ring-2 hover:ring-sky-400"
          >
            <Server className="size-9 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
            <span className="text-[15px] font-semibold">Connect Single account</span>
            <span className="max-w-[200px] text-[12.5px] text-muted-foreground">Connect single email account via SMTP</span>
          </button>
          <button
            type="button"
            onClick={onBulk}
            className="flex flex-col items-center gap-2.5 rounded-lg bg-muted/70 px-4 py-8 text-center transition-shadow hover:ring-2 hover:ring-sky-400"
          >
            <FileSpreadsheet className="size-9 text-emerald-600" strokeWidth={1.5} />
            <span className="text-[15px] font-semibold">Bulk Import Via CSV</span>
            <span className="max-w-[200px] text-[12.5px] text-muted-foreground">Import &amp; connect multiple email accounts at once via CSV</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────── single SMTP/IMAP account form ────────────────────── */

const ENCRYPTIONS = ["SSL", "TLS", "None"] as const;

function EncryptionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {ENCRYPTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onChange(e)}
          className={cn(
            "px-3 py-1.5 text-[12px] font-medium transition-colors",
            value === e ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-muted",
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pr-9" autoComplete="new-password" />
      <button type="button" tabIndex={-1} onClick={() => setShow((s) => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** Section shell for the SMTP/IMAP form — module-scope so React keeps the
 *  same component identity across renders (inputs must not lose focus). */
function Sect({ title, sub, children, aside }: { title: string; sub: string; children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="mb-4">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <p className="text-[12px] text-muted-foreground">{sub}</p>
        </div>
        {children}
      </div>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-[12px] leading-relaxed text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        {aside}
      </div>
    </div>
  );
}

function SmtpImapFormDialog({
  open, onCancel, onLinked,
}: {
  open: boolean;
  onCancel: () => void;
  onLinked: (a: MailboxAccount) => void;
}) {
  const utils = trpc.useUtils();
  const [f, setF] = useState({
    diffUsername: false,
    espProvider: "",
    email: "",
    firstName: "",
    lastName: "",
    username: "",
    password: "",
    smtpHost: "",
    smtpPort: "587",
    smtpEnc: "TLS",
    imapSame: true,
    imapEmail: "",
    imapPassword: "",
    imapHost: "",
    imapPort: "993",
    imapEnc: "SSL",
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const testConfig = trpc.sendingAccounts.testConfig.useMutation();
  const create = trpc.sendingAccounts.create.useMutation({
    onError: (e: any) => toast.error(e?.message ?? "Could not connect mailbox"),
  });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  const smtpReady = emailOk && f.password.length > 0 && f.smtpHost.trim().length > 0 && Number(f.smtpPort) > 0;
  const imapEmailV = f.imapSame ? f.email : f.imapEmail;
  const imapPassV = f.imapSame ? f.password : f.imapPassword;
  const imapReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(imapEmailV.trim()) && imapPassV.length > 0 && f.imapHost.trim().length > 0 && Number(f.imapPort) > 0;

  const [smtpTest, setSmtpTest] = useState<null | "ok" | "fail">(null);
  const [imapTest, setImapTest] = useState<null | "ok" | "fail">(null);

  const runSmtpTest = async () => {
    setSmtpTest(null);
    try {
      const r: any = await testConfig.mutateAsync({
        provider: "generic_smtp",
        smtpHost: f.smtpHost.trim(),
        smtpPort: Number(f.smtpPort),
        smtpUsername: (f.diffUsername ? f.username : f.email).trim(),
        smtpPassword: f.password,
      } as any);
      setSmtpTest(r.ok ? "ok" : "fail");
      if (r.ok) toast.success("SMTP connection verified");
      else toast.error(r.error ?? "SMTP connection failed");
    } catch (e: any) {
      setSmtpTest("fail");
      toast.error(e?.message ?? "SMTP connection failed");
    }
  };

  // TODO(imap-verify): no IMAP client library server-side — field validation only.
  const runImapTest = () => {
    setImapTest(imapReady ? "ok" : "fail");
    if (imapReady) toast.success("IMAP details look valid — live verification runs on first sync");
    else toast.error("Fill the IMAP fields first");
  };

  const connectSave = async () => {
    const fromEmail = f.email.trim().toLowerCase();
    const r = await create.mutateAsync({
      name: `${f.firstName} ${f.lastName}`.trim() || fromEmail,
      provider: "generic_smtp",
      fromEmail,
      fromName: `${f.firstName} ${f.lastName}`.trim() || undefined,
      smtpHost: f.smtpHost.trim(),
      smtpPort: Number(f.smtpPort) || 587,
      smtpSecure: f.smtpEnc === "SSL",
      smtpUsername: (f.diffUsername ? f.username : f.email).trim(),
      smtpPassword: f.password,
      imapHost: f.imapHost.trim() || undefined,
      imapPort: Number(f.imapPort) || 993,
      imapSecure: f.imapEnc !== "None",
      imapUsername: imapEmailV.trim() || undefined,
      imapPassword: imapPassV || undefined,
      dailySendLimit: 50,
      hourlySendLimit: 6,
      delaySeconds: 600,
    } as any);
    const list = await utils.sendingAccounts.list.fetch();
    const created = (list as any[]).find((a) => a.id === (r as any).id) ?? { id: (r as any).id, fromEmail, provider: "generic_smtp", aliases: [], isDefault: false };
    toast.success(`${fromEmail} connected`);
    onLinked(created);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>Connect SMTP/IMAP account</DialogTitle>
          <DialogDescription>Enter the sending (SMTP) and reading (IMAP) details for the mailbox.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-muted/40 px-6 py-5">
          {/* SMTP */}
          <Sect
            title="SMTP Details"
            sub="to send your email"
            aside={
              <>
                <div className="mb-1.5 font-semibold">Steps to connect SMTP</div>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Ensure your email account is enabled for SMTP.</li>
                  <li>Ensure that 2FA is not enabled on your email account.</li>
                  <li>If 2FA is enabled, please use app-password instead of email password.</li>
                </ol>
              </>
            }
          >
            <div className="space-y-3.5">
              <label className="flex items-center gap-2.5 text-[13px]">
                <Switch checked={f.diffUsername} onCheckedChange={(v) => set("diffUsername", v)} />
                Use different username
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Email Provider</Label>
                  <select
                    value={f.espProvider}
                    onChange={(e) => {
                      const v = e.target.value;
                      const presets: Record<string, { h: string; p: string; ih: string }> = {
                        gmail: { h: "smtp.gmail.com", p: "465", ih: "imap.gmail.com" },
                        outlook: { h: "smtp.office365.com", p: "587", ih: "outlook.office365.com" },
                        zoho: { h: "smtp.zoho.com", p: "465", ih: "imap.zoho.com" },
                        yahoo: { h: "smtp.mail.yahoo.com", p: "465", ih: "imap.mail.yahoo.com" },
                      };
                      const preset = presets[v];
                      setF((p) => ({
                        ...p, espProvider: v,
                        ...(preset ? { smtpHost: preset.h, smtpPort: preset.p, imapHost: preset.ih, imapPort: "993" } : {}),
                      }));
                    }}
                    className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]"
                  >
                    <option value="">Select email service provider</option>
                    <option value="gmail">Gmail / Google Workspace</option>
                    <option value="outlook">Outlook / Microsoft 365</option>
                    <option value="zoho">Zoho Mail</option>
                    <option value="yahoo">Yahoo Mail</option>
                    <option value="custom">Custom / other</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Email Address</Label>
                  <Input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="email@address.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>First Name</Label>
                  <Input value={f.firstName} onChange={(e) => set("firstName", e.target.value)} placeholder="First name" />
                </div>
                <div className="space-y-1.5">
                  <Label>Last Name</Label>
                  <Input value={f.lastName} onChange={(e) => set("lastName", e.target.value)} placeholder="Last name" />
                </div>
                {f.diffUsername && (
                  <div className="space-y-1.5">
                    <Label>SMTP Username</Label>
                    <Input value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="username" />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <PasswordInput value={f.password} onChange={(v) => set("password", v)} placeholder="App password" />
                </div>
                <div className="space-y-1.5">
                  <Label>SMTP Host</Label>
                  <Input value={f.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder="host.email.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>SMTP Port</Label>
                  <Input inputMode="numeric" value={f.smtpPort} onChange={(e) => set("smtpPort", e.target.value.replace(/\D/g, ""))} placeholder="123" />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1.5">
                  <Label>Encryption</Label>
                  <div><EncryptionPicker value={f.smtpEnc} onChange={(v) => set("smtpEnc", v)} /></div>
                </div>
                <Button variant="outline" size="sm" disabled={!smtpReady || testConfig.isPending} onClick={runSmtpTest} className="gap-1.5 border-sky-300 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40">
                  {testConfig.isPending ? <Loader2 className="size-3.5 animate-spin" /> : smtpTest === "ok" ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : smtpTest === "fail" ? <XCircle className="size-3.5 text-rose-600" /> : null}
                  Test SMTP Connection
                </Button>
              </div>
            </div>
          </Sect>

          {/* IMAP */}
          <Sect
            title="IMAP Details"
            sub="to track your email"
            aside={
              <>
                <div className="mb-1.5 font-semibold">Steps to connect IMAP</div>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Ensure your email account is enabled for IMAP.</li>
                  <li>Use your email account credentials for the IMAP connection.</li>
                </ol>
              </>
            }
          >
            <div className="space-y-3.5">
              <label className="flex items-center gap-2.5 text-[13px]">
                <Switch checked={f.imapSame} onCheckedChange={(v) => set("imapSame", v)} />
                Use the same username and password from SMTP
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {!f.imapSame && (
                  <>
                    <div className="space-y-1.5">
                      <Label>Email Address</Label>
                      <Input type="email" value={f.imapEmail} onChange={(e) => set("imapEmail", e.target.value)} placeholder="email@address.com" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Password</Label>
                      <PasswordInput value={f.imapPassword} onChange={(v) => set("imapPassword", v)} />
                    </div>
                  </>
                )}
                <div className="space-y-1.5">
                  <Label>IMAP Host</Label>
                  <Input value={f.imapHost} onChange={(e) => set("imapHost", e.target.value)} placeholder="imap.email.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>IMAP Port</Label>
                  <Input inputMode="numeric" value={f.imapPort} onChange={(e) => set("imapPort", e.target.value.replace(/\D/g, ""))} placeholder="993" />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1.5">
                  <Label>Encryption</Label>
                  <div><EncryptionPicker value={f.imapEnc} onChange={(v) => set("imapEnc", v)} /></div>
                </div>
                <Button variant="outline" size="sm" disabled={!imapReady} onClick={runImapTest} className="gap-1.5 border-sky-300 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40">
                  {imapTest === "ok" ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : imapTest === "fail" ? <XCircle className="size-3.5 text-rose-600" /> : null}
                  Test IMAP Connection
                </Button>
              </div>
            </div>
          </Sect>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3.5">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={!smtpReady || create.isPending} onClick={connectSave} className="gap-1.5 bg-indigo-600 text-white hover:bg-indigo-700">
            {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Connect &amp; Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────── bulk CSV import ────────────────────────────── */

type CsvRow = {
  fromEmail: string;
  fromName?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number;
  dailySendLimit?: number;
  hourlySendLimit?: number;
  delaySeconds?: number;
};

function parseMailboxCsv(text: string): { rows: CsvRow[]; skipped: number; error?: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], skipped: 0, error: "The CSV needs a header row and at least one account row." };
  const split = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const idx = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iEmail = idx("email account", "email address", "email");
  if (iEmail < 0) return { rows: [], skipped: 0, error: "No email column found — the header must include an Email Address column." };
  const iFirst = idx("first name");
  const iLast = idx("last name");
  const iSHost = idx("smtp host");
  const iSPort = idx("smtp port");
  const iSUser = idx("smtp user");
  const iSPass = idx("smtp pass");
  const iIHost = idx("imap host");
  const iIPort = idx("imap port");
  const iDaily = idx("daily");
  const iHourly = idx("hourly");
  const iDelay = idx("delay", "interval");
  const num = (v?: string) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined; };

  const rows: CsvRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = split(line);
    const email = (c[iEmail] ?? "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
    rows.push({
      fromEmail: email,
      fromName: [iFirst >= 0 ? c[iFirst] : "", iLast >= 0 ? c[iLast] : ""].filter(Boolean).join(" ") || undefined,
      smtpHost: iSHost >= 0 ? c[iSHost] || undefined : undefined,
      smtpPort: iSPort >= 0 ? num(c[iSPort]) : undefined,
      smtpUsername: iSUser >= 0 ? c[iSUser] || undefined : undefined,
      smtpPassword: iSPass >= 0 ? c[iSPass] || undefined : undefined,
      imapHost: iIHost >= 0 ? c[iIHost] || undefined : undefined,
      imapPort: iIPort >= 0 ? num(c[iIPort]) : undefined,
      dailySendLimit: iDaily >= 0 ? num(c[iDaily]) : undefined,
      hourlySendLimit: iHourly >= 0 ? num(c[iHourly]) : undefined,
      delaySeconds: iDelay >= 0 ? num(c[iDelay]) : undefined,
    });
  }
  if (rows.length === 0) return { rows, skipped, error: "No valid email accounts found in the CSV." };
  if (rows.length > 100) return { rows: [], skipped, error: `The CSV has ${rows.length} accounts — the maximum per import is 100.` };
  return { rows, skipped };
}

function CsvImportDialog({
  open, onCancel, onLinked,
}: {
  open: boolean;
  onCancel: () => void;
  onLinked: (a: MailboxAccount) => void;
}) {
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ rows: CsvRow[]; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const bulkCreate = trpc.sendingAccounts.bulkCreateSmtp.useMutation({
    onError: (e: any) => toast.error(e?.message ?? "Import failed"),
  });

  const reset = () => { setFileName(null); setParsed(null); setError(null); if (fileRef.current) fileRef.current.value = ""; };

  const onFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setError("Please choose a .csv file."); setParsed(null); setFileName(file.name); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const result = parseMailboxCsv(String(reader.result ?? ""));
      setFileName(file.name);
      if (result.error) { setError(result.error); setParsed(null); }
      else { setError(null); setParsed({ rows: result.rows, skipped: result.skipped }); }
    };
    reader.readAsText(file);
  };

  const connect = async () => {
    if (!parsed) return;
    const r: any = await bulkCreate.mutateAsync({ rows: parsed.rows } as any);
    const list = (await utils.sendingAccounts.list.fetch()) as any[];
    toast.success(`Connected ${r.created} mailbox${r.created === 1 ? "" : "es"}${r.skipped ? ` · ${r.skipped} already linked` : ""}`);
    const first = list.find((a) => a.fromEmail === parsed.rows[0].fromEmail) ?? list[0];
    reset();
    onLinked(first);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onCancel(); } }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import email accounts</DialogTitle>
          <DialogDescription>Connect multiple SMTP/IMAP mailboxes at once from a CSV file.</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-muted/70 p-4 text-[12.5px] leading-relaxed text-foreground/80">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
            <Lightbulb className="size-3.5 text-amber-500" /> Steps to import email accounts:
          </div>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>Download <a href="/mailbox-import-sample.csv" download className="font-medium text-sky-700 hover:underline dark:text-sky-400">Sample CSV</a> file</li>
            <li>Fill details for all connection fields. (Email account, SMTP host, etc.)</li>
            <li>Fill details for email account settings. (Sending interval, daily limit, etc.)</li>
            <li>Email account field should be valid and not left blank.</li>
            <li>Import your CSV file and click on Connect.</li>
          </ol>
        </div>

        {/* upload zone — empty / success / error states */}
        {!parsed ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files?.[0]); }}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed bg-muted/30 px-6 py-10 text-center transition-colors",
              error ? "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/20"
                : dragOver ? "border-sky-400 bg-sky-50/60" : "border-border hover:border-foreground/40",
            )}
          >
            <UploadCloud className="size-8 text-muted-foreground" strokeWidth={1.5} />
            <div className="text-[14px]">
              Drag &amp; Drop CSV file or <span className="font-semibold text-sky-700 dark:text-sky-400">Choose a file</span>
            </div>
            <div className="text-[12px] text-muted-foreground">Maximum allowed accounts per CSV: 100</div>
            {error && <div className="mt-1 text-[12px] font-medium text-rose-600">{fileName ? `${fileName}: ` : ""}{error}</div>}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-emerald-400 bg-emerald-50 px-6 py-8 text-center dark:border-emerald-800 dark:bg-emerald-950/30">
            <FileSpreadsheet className="size-9 text-emerald-600 dark:text-emerald-400" strokeWidth={1.5} />
            <div className="mt-1 max-w-full truncate text-[15px] font-semibold">{fileName}</div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[13px]">
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCheck className="size-4" /> Successfully imported: <span className="font-bold">{parsed.rows.length}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 font-medium text-rose-600 dark:text-rose-400">
                <TriangleAlert className="size-4 text-amber-500" /> Skipped: <span className="font-bold">{parsed.skipped}</span>
              </span>
              <a href="/mailbox-import-sample.csv" download title="Download sample CSV" className="text-muted-foreground hover:text-foreground">
                <Download className="size-4" />
              </a>
            </div>
            <button type="button" onClick={reset} className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] text-foreground/80 hover:text-rose-600">
              <Trash2 className="size-3.5" /> Remove file
            </button>
          </div>
        )}
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => { reset(); onCancel(); }}>Cancel</Button>
          <Button size="sm" disabled={!parsed || bulkCreate.isPending} onClick={connect} className="gap-1.5 bg-indigo-600 text-white hover:bg-indigo-700">
            {bulkCreate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Connect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────── linked confirmation step ─────────────────────── */

function LinkedStep({ acct, onCloseWizard }: { acct: MailboxAccount; onCloseWizard: () => void }) {
  const [, navigate] = useLocation();
  const aliases = Array.isArray(acct.aliases) ? acct.aliases : [];
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-[26px] font-bold tracking-tight">Great job! Your mailbox has been linked</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
        Up next: Configure your mailbox to ensure everything is properly set up to maintain deliverability and
        a good sender reputation.
      </p>
      <div className="mt-6 flex items-start gap-2.5 rounded-lg bg-slate-100 px-4 py-3.5 text-[13px] text-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Don't want to configure the mailbox now? No worries! You can access this flow anytime from the
          mailbox listing page in{" "}
          <button
            type="button"
            onClick={() => { onCloseWizard(); navigate("/v2/settings/mailboxes"); }}
            className="font-semibold underline underline-offset-2"
          >
            Settings
          </button>.
        </span>
      </div>
      <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5">
        <ProviderTile provider={acct.provider} email={acct.fromEmail} className="size-8 text-[13px]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{acct.fromEmail}</div>
          <span className="inline-flex items-center gap-0.5 text-[12.5px] font-medium text-sky-700 dark:text-sky-400">
            {aliases.length} email alias{aliases.length === 1 ? "" : "es"} <ChevronDown className="size-3.5" />
          </span>
        </div>
        {acct.isDefault && (
          <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-[11px] font-medium text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200">Default</span>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── configuration steps ────────────────────────── */

function SignatureStep({ acct, save }: { acct: MailboxAccount; save: (p: Record<string, unknown>) => Promise<void> }) {
  const [sig, setSig] = useState<string>(acct.signature ?? "");
  // Persist the text ONCE when the step unmounts (Complete/Skip/Previous all
  // navigate away) — a ref keeps the latest value without re-running the effect.
  const sigRef = useRef(sig);
  sigRef.current = sig;
  useEffect(() => {
    return () => {
      if (sigRef.current !== (acct.signature ?? "")) void save({ signature: sigRef.current || null });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-[26px] font-bold tracking-tight">Signature</h1>
      <p className="mt-2 text-[13.5px] text-muted-foreground">
        Email signatures add credibility and professionalism to your messages.
      </p>
      <div className="mt-5 rounded-xl border border-border bg-card">
        <textarea
          value={sig}
          onChange={(e) => setSig(e.target.value)}
          rows={9}
          placeholder={"Best regards,\nYour name\nYour title · Your company\nyourwebsite.com"}
          className="w-full resize-y rounded-xl bg-transparent px-4 py-3 text-[13px] leading-relaxed outline-none"
        />
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          Plain text — URLs and [label](url) links are rendered automatically when emails send.
        </div>
      </div>
    </div>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" tabIndex={0} aria-label="More information" className="text-muted-foreground hover:text-foreground">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-center leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

/** 3-column read-only limits summary (wizard limits step + configuration overview). */
function LimitsSummary({
  daily, hourly, delay, className,
}: {
  daily: string | number; hourly: string | number; delay: string | number; className?: string;
}) {
  const n = (v: string | number) => (Number(v) > 0 ? Number(v) : 0);
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      <div className="grid grid-cols-3 border-b border-border/70 text-center text-[12px] text-muted-foreground">
        {["Emails sent per day", "Emails sent per hour", "Delay between emails"].map((h) => (
          <div key={h} className="px-3 py-2.5">{h}</div>
        ))}
      </div>
      <div className="grid grid-cols-3 text-center text-[13.5px] font-medium tabular-nums">
        <div className="px-3 py-4">{n(daily)}</div>
        <div className="px-3 py-4">{n(hourly)}</div>
        <div className="px-3 py-4">{n(delay)} secs</div>
      </div>
    </div>
  );
}

function LimitsStep({ acct, save }: { acct: MailboxAccount; save: (p: Record<string, unknown>) => Promise<void> }) {
  const [daily, setDaily] = useState(String(acct.dailySendLimit ?? 50));
  const [hourly, setHourly] = useState(String(acct.hourlySendLimit ?? 6));
  const [delay, setDelay] = useState(String(acct.delaySeconds ?? 600));
  const [editorOpen, setEditorOpen] = useState(false);

  // The Complete button (in the wizard's bottom bar) fires this event so the
  // current input values persist together with sendingLimitsCompleted.
  useEffect(() => {
    const handler = () => {
      void save({
        dailySendLimit: Math.max(1, Number(daily) || 50),
        hourlySendLimit: Math.max(1, Number(hourly) || 6),
        delaySeconds: Math.max(0, Number(delay) || 600),
      });
    };
    window.addEventListener("mailbox-limits-complete", handler);
    return () => window.removeEventListener("mailbox-limits-complete", handler);
  }, [daily, hourly, delay]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-[26px] font-bold tracking-tight">Sending limits</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        Sending limits are essential to maintaining a healthy deliverability rate and domain safety. We
        recommend utilizing the Velocity default limits to minimize risk.
      </p>

      <LimitsSummary daily={daily} hourly={hourly} delay={delay} className="mt-6" />

      <div className="mt-5 rounded-lg border border-border bg-card">
        <button
          type="button"
          onClick={() => setEditorOpen((o) => !o)}
          aria-expanded={editorOpen}
          className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left sm:px-5"
        >
          <Settings2 className="size-4 text-muted-foreground" />
          <span className="text-[14px] font-semibold">Sending limits</span>
          <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", editorOpen && "rotate-180")} />
        </button>
        <div className={cn("space-y-5 px-4 pb-5 sm:px-5", !editorOpen && "hidden")}>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              Emails sent per day (24-hour-period)
              <InfoTip text="The emails sent per day (daily limit) is the maximum number of emails you can send per mailbox within a 24-hour period. This calculation may vary depending on your email service provider (ESP)." />
            </Label>
            <Input inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value.replace(/\D/g, ""))} />
            <p className="text-xs text-muted-foreground">
              Recommended daily limit: 50, or 50+ if you're sending campaigns with a &gt; 5% reply rate and have a high domain reputation.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              Email sent per hour (optional)
              <InfoTip text="The emails sent per hour (hourly limit) is the maximum number of emails you can send per mailbox within a single hour. This limit helps prevent spam and keeps accounts safe." />
            </Label>
            <Input inputMode="numeric" value={hourly} onChange={(e) => setHourly(e.target.value.replace(/\D/g, ""))} />
            <p className="text-xs text-muted-foreground">Recommended hourly limit: 6 emails.</p>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              Delay between emails in seconds (optional)
              <InfoTip text="This is the time (in seconds) between sending consecutive emails. This helps ensure compliance, prevent spam, and maintain a good sender reputation." />
            </Label>
            <Input inputMode="numeric" value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, ""))} />
            <p className="text-xs text-muted-foreground">
              Recommended delay: 600 sec. The current delay will allow you to send at most {Number(delay) > 0 ? Math.max(1, Math.floor(3600 / Number(delay))) : "—"} emails/hour.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setDaily("50"); setHourly("6"); setDelay("600"); }}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-sky-700 hover:underline dark:text-sky-400"
          >
            <RotateCcw className="size-3.5" /> Reset to default
          </button>
        </div>
      </div>
    </div>
  );
}

function OptOutStep({ acct, save }: { acct: MailboxAccount; save: (p: Record<string, unknown>) => Promise<void> }) {
  const [enabled, setEnabled] = useState<boolean>(acct.optOutEnabled === true);
  const [msg, setMsg] = useState<string>(acct.optOutMessage ?? "");
  const commit = (nextEnabled: boolean, nextMsg: string) =>
    void save({ optOutEnabled: nextEnabled, optOutMessage: nextMsg.trim() || null });
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-[26px] font-bold tracking-tight">Opt-out link</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        Opt-out links are necessary for compliance and provide recipients with an easy way to unsubscribe —
        and better than being marked as spam.
      </p>
      <label className="mt-6 flex cursor-pointer items-center gap-2.5 text-[13px]">
        <Switch checked={enabled} onCheckedChange={(v) => { setEnabled(v); commit(v, msg); }} />
        Append the following opt-out message after my signature in sequences
      </label>
      <div className="mt-4 space-y-1.5">
        <Label className={cn(!enabled && "text-muted-foreground/60")}>Message for your opt-out link</Label>
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onBlur={() => enabled && commit(enabled, msg)}
          disabled={!enabled}
          rows={4}
          placeholder="If you don't want to hear from me again, please <%let me know%>."
          className={cn(
            "w-full rounded-md border px-3 py-2 text-[13px] outline-none transition-colors",
            enabled
              ? "border-border bg-background font-medium text-foreground focus:ring-2 focus:ring-ring"
              : "border-border/60 bg-muted/50 text-muted-foreground/60",
          )}
        />
        <p className="text-xs text-muted-foreground">
          {"Surround your opt-out link with brackets <% and %>. E.g. If you don't want to hear from me, you can <%unsubscribe here%>."}
        </p>
      </div>
    </div>
  );
}

/* ─────────────────── overview / resume configuration ──────────────────── */

function ModuleBadge({ done }: { done: boolean }) {
  return done ? (
    <Check className="size-[18px] shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
  ) : (
    <X className="size-[18px] shrink-0 text-rose-600 dark:text-rose-400" strokeWidth={2.5} />
  );
}

function OverviewModule({
  done, title, eta, desc, action, children,
}: {
  done: boolean;
  title: string;
  eta: string;
  desc: string;
  action: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <ModuleBadge done={done} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold leading-[18px]">{title}</h3>
          {!done && <div className="mt-0.5 text-[12px] text-muted-foreground">{eta}</div>}
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
          {children}
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={action}>
          {done ? <Settings2 className="size-3.5" /> : <Wrench className="size-3.5" />}
          {done ? "Configure" : "Fix"}
        </Button>
      </div>
    </div>
  );
}

function OverviewStep({ acct, goTo }: { acct: MailboxAccount; goTo: (s: WizardStep) => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-[26px] font-bold tracking-tight">Mailbox configuration</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        This includes essential elements such as authentication, sending limits, opt-out links, and more that
        help ensure secure and efficient email management.
      </p>
      <div className="mt-6 space-y-3">
        <OverviewModule
          done={!!acct.signatureCompleted}
          title="Signature"
          eta="About 1 min"
          desc="Email signatures improve deliverability by adding credibility and professionalism to your messages."
          action={() => goTo("signature")}
        />
        <OverviewModule
          done={!!acct.sendingLimitsCompleted}
          title="Sending limits"
          eta="About 1 min"
          desc="Sending limits are essential to maintaining a healthy deliverability rate and domain safety. Maintain the Velocity default to minimize risk."
          action={() => goTo("limits")}
        >
          <LimitsSummary
            daily={acct.dailySendLimit ?? 50}
            hourly={acct.hourlySendLimit ?? 6}
            delay={acct.delaySeconds ?? 600}
            className="mt-3"
          />
        </OverviewModule>
        <OverviewModule
          done={!!acct.optOutCompleted}
          title="Opt out link"
          eta="About 1 min"
          desc="Ensure compliance and reduce spam risk by adding an opt-out link for easy unsubscribing."
          action={() => goTo("optout")}
        />
      </div>
    </div>
  );
}

/* ───────────────────────── completion screen ──────────────────────────── */

function CompleteStep({
  acct, onClose, onLinkAnother, onConfigure,
}: {
  acct: MailboxAccount;
  onClose: () => void;
  onLinkAnother: () => void;
  onConfigure: () => void;
}) {
  const [, navigate] = useLocation();
  const options = [
    { icon: Network, tint: "text-sky-600", label: "Explore the Deliverability suite", act: () => { onClose(); navigate("/v2/deliverability"); } },
    { icon: Mail, tint: "text-muted-foreground", label: "Link another mailbox", act: onLinkAnother },
    { icon: Send, tint: "text-pink-500", label: "Create sequence", act: () => { onClose(); navigate("/sequences"); } },
    { icon: Plug, tint: "text-indigo-500", label: "Connect your CRM", act: () => { onClose(); navigate("/settings?tab=integrations"); } },
  ];
  const cardCls =
    "flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-4 text-left text-[13.5px] font-semibold transition-colors hover:border-foreground/30";
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <span className="relative inline-flex">
        <CheckCircle2 className="size-12 text-emerald-500" strokeWidth={1.5} />
        <Sparkles className="absolute -right-3 -top-1.5 size-4 text-emerald-500" />
      </span>
      <h1 className="mt-5 text-[26px] font-bold tracking-tight">Your mailbox has been linked</h1>

      <h2 className="mt-7 text-[13.5px] font-semibold">Up next: Configure your mailbox</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        Completing mailbox configuration is essential to maintaining deliverability and domain health. Take
        these steps to safeguard your messages from being marked as spam or phishing attempts.
      </p>
      <button type="button" onClick={onConfigure} className={cn(cardCls, "mt-4")}>
        <Settings2 className="size-5 shrink-0 text-emerald-600" />
        Configure mailbox
      </button>

      <h2 className="mt-8 text-[13px] font-semibold text-muted-foreground">More options to explore</h2>
      <div className="mt-3 space-y-2.5">
        {options.map((o) => (
          <button key={o.label} type="button" onClick={o.act} className={cardCls}>
            <o.icon className={cn("size-5 shrink-0", o.tint)} />
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
