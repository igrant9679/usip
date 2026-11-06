/**
 * ARESettings — Global Autonomous Revenue Engine configuration
 *
 * Sections:
 *  1. Autonomy defaults — default autonomy mode, auto-approve threshold, daily send cap
 *  2. Signal automation — signal-to-opportunity toggle, notification prefs
 *  3. Channel defaults — email and LinkedIn (SMS / AI Voice shown disabled: no provider)
 *  4. Capacity — max concurrent campaigns
 *  5. Notification preferences — which ARE events trigger in-app notifications
 */
import { Shell, PageHeader, QueryError } from "@/components/usip/Shell";
import { AreSubNav } from "@/components/usip/are/AreSubNav";
import { ApolloSourceCard } from "@/components/usip/settings/ApolloSourceCard";
import { ReoonVerifierCard } from "@/components/usip/settings/ReoonVerifierCard";
import { QuickEnrichSourceCard } from "@/components/usip/settings/QuickEnrichSourceCard";
import { WarmySenderSourceCard } from "@/components/usip/settings/WarmySenderSourceCard";
import { LeadOceanSourceCard } from "@/components/usip/settings/LeadOceanSourceCard";
import { ARE_SEQUENCE_TEMPLATES, DEFAULT_ARE_SEQUENCE_TEMPLATE } from "@shared/areSequenceTemplates";
import { UNSENDABLE_CHANNEL_REASON } from "@shared/areSequenceSteps";
import { APPROVE_THRESHOLD_EXPLAINER, APPROVE_THRESHOLD_START, approveThresholdSummary } from "@shared/areApproveThreshold";
import { ARE_SOURCES, ARE_SOURCE_IDS, resolveSourceOrder } from "@shared/areSources";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  Bell,
  Bot,
  Brain,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Globe,
  Linkedin,
  Loader2,
  Mail,
  MessageSquare,
  Mic2,
  Moon,
  Newspaper,
  Phone,
  RefreshCw,
  Save,
  Search,
  Shield,
  Sliders,
  Sparkles,
  Zap, Settings2, MailCheck, Radar, ChevronUp, ChevronDown, Flame, Waves
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { areSettingsDraft, changedAreSettings, type AreSettingsDraft } from "./areSettingsModel";
import { Link } from "wouter";
import { toast } from "sonner";
import { confirmAction } from "@/components/usip/Common";

/** Descriptions keyed by source id, so this page and the campaign wizard
 *  describe the same source the same way. */
const ARE_SOURCE_DESC: Record<string, string> = Object.fromEntries(
  ARE_SOURCES.map((s) => [s.id, s.description]),
);

/* --- Types ---------------------------------------------------------------- */
// review_release was removed 2026-09-02: it never had an engine branch (it
// behaved like batch_approval minus the junk floor while the copy promised
// a per-email hold). Rows still carrying it are treated as batch_approval.
type AutonomyMode = "full" | "batch_approval";

// Mirrors the z.enum the save mutation now accepts (server/routers/admin.ts).
// The column drives real LLM spend in the ICP cron, so the domain is closed at
// both ends rather than left as a free string (2026-09-20).
type IcpRegenSchedule = "daily" | "weekly" | "on_new_deal" | "manual";
const ICP_REGEN_SCHEDULES: IcpRegenSchedule[] = ["daily", "weekly", "on_new_deal", "manual"];

const AUTONOMY_OPTIONS: { value: AutonomyMode; label: string; description: string; color: string }[] = [
  {
    value: "full",
    label: "Full Autonomy",
    description: "With an auto-approve threshold set, the AI approves, sequences and sends everyone at or above it with no human review, and rejects the rest. Without one, nothing is approved automatically.",
    color: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  },
  {
    value: "batch_approval",
    label: "Batch Approval",
    description: "The AI prepares batches of prospects and sequences. You review and approve each batch before sending. Balances speed with oversight.",
    color: "border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-300",
  },
];

/** Icons only. The label, the step count and the description live in
 *  shared/areSequenceTemplates.ts so the generator and this picker cannot
 *  disagree about how many steps a template has — they did until 2026-09-20,
 *  when "Aggressive 3-Step" and "Nurture 14-Step" both produced five. shared/
 *  stays free of lucide, so the icon stays here. */
const TEMPLATE_ICONS: Record<string, typeof Mail> = {
  standard_7step: Mail,
  aggressive_3step: Zap,
  nurture_14step: RefreshCw,
  custom: Sparkles,
};

/** `sendable` is what the engine can actually deliver, not what the column can
 *  hold. SMS and AI Voice were plain enabled toggles here until 2026-09-20 —
 *  turning one on put steps into the queue that nothing has ever been able to
 *  send (no SMS gateway; the voice bridge only answers inbound call-backs).
 *  They stay listed, disabled and reasoned, rather than disappearing: a
 *  workspace whose row already says sms:true deserves to see why it is off. */
const CHANNEL_OPTIONS = [
  { key: "email", label: "Email", icon: Mail, color: "text-blue-500", sendable: true },
  { key: "linkedin", label: "LinkedIn", icon: Linkedin, color: "text-blue-600", sendable: true },
  { key: "sms", label: "SMS", icon: MessageSquare, color: "text-emerald-500", sendable: false },
  { key: "voice", label: "AI Voice", icon: Phone, color: "text-violet-500", sendable: false },
];

/* --- Section card wrapper ------------------------------------------------- */
function Section({ icon: Icon, title, description, children }: {
  icon: any; title: string; description: string; children: React.ReactNode;
}) {
  return (
    <Card className="bg-card border">
      <CardHeader className="pb-3 pt-4 px-5">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-4">
        {children}
      </CardContent>
    </Card>
  );
}

/* --- Toggle switch -------------------------------------------------------- */
function Toggle({ checked, onChange, label, color = "bg-primary" }: { checked: boolean; onChange: () => void; label: string; color?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? color : "bg-muted"}`}
      role="switch"
      aria-checked={checked}
      style={{ height: "20px", width: "36px" }}
    >
      <span
        className="pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform"
        style={{ width: "16px", height: "16px", transform: checked ? "translateX(16px)" : "translateX(0)" }}
      />
    </button>
  );
}

/* --- Main page ------------------------------------------------------------ */
export default function ARESettings() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading, error: loadError, refetch } = trpc.settings.getAreSettings.useQuery();

  // Local draft state — mirrors the actual schema columns
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>("batch_approval");
  const [dailySendCap, setDailySendCap] = useState(50);
  const [autoApproveThreshold, setAutoApproveThreshold] = useState<number | null>(null);
  const [signalToOpportunity, setSignalToOpportunity] = useState(false);
  const [channels, setChannels] = useState<Record<string, boolean>>({ email: true, linkedin: false, sms: false, voice: false });
  const [maxConcurrent, setMaxConcurrent] = useState(5);
  const [notifyMeeting, setNotifyMeeting] = useState(true);
  const [notifyAutoApprove, setNotifyAutoApprove] = useState(false);
  const [notifyIcpUpdate, setNotifyIcpUpdate] = useState(true);
  // New settings
  const [sequenceTemplate, setSequenceTemplate] = useState(DEFAULT_ARE_SEQUENCE_TEMPLATE);
  // Keys come from the shared ARE_SOURCES vocabulary — the same ids the wizard
  // shows and the engine dispatches on. All on by default: a new campaign
  // sources from everything unless the user narrows it.
  const [scraperSources, setScraperSources] = useState<Record<string, boolean>>(
    Object.fromEntries(ARE_SOURCE_IDS.map((id) => [id, true])),
  );
  // Checking order — the engine's dedup priority, through the ONE resolver
  // (mask {} so disabled sources stay visible/reorderable on this card).
  const [sourceOrder, setSourceOrder] = useState<string[]>(
    resolveSourceOrder(null, {}, ARE_SOURCE_IDS),
  );
  // "daily" both here and at the hydrate below: a workspace that never touched
  // this card stores NULL and the cron runs it daily, so displaying "Weekly"
  // was showing a cadence nothing was on (2026-09-20).
  const [icpRegenSchedule, setIcpRegenSchedule] = useState<IcpRegenSchedule>("daily");
  const [dirty, setDirty] = useState(false);

  // The form from the loaded settings (areSettingsModel, A60). Discard calls
  // this directly: refetching relied on an effect that never ran when the
  // refetch came back unchanged, so Discard reverted nothing.
  const hydrate = (d: AreSettingsDraft) => {
    setAutonomyMode(d.areDefaultAutonomyMode);
    setDailySendCap(d.areDefaultDailySendCap);
    setAutoApproveThreshold(d.areDefaultAutoApproveThreshold);
    setSignalToOpportunity(d.areDefaultSignalToOpportunity);
    setChannels(d.areDefaultChannels);
    setMaxConcurrent(d.areMaxConcurrentCampaigns);
    setNotifyMeeting(d.areNotifyOnMeetingBooked);
    setNotifyAutoApprove(d.areNotifyOnAutoApprove);
    setNotifyIcpUpdate(d.areNotifyOnIcpUpdate);
    setSequenceTemplate(d.areDefaultSequenceTemplate);
    setScraperSources(d.areScraperSources);
    setSourceOrder(d.areSourceOrder);
    setIcpRegenSchedule(d.areIcpRegenSchedule);
    setDirty(false);
  };
  const loaded = useMemo(() => (settings ? areSettingsDraft(settings as Record<string, any>) : null), [settings]);
  useEffect(() => { if (loaded) hydrate(loaded); }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = trpc.settings.updateAreSettings.useMutation({
    onSuccess: () => {
      toast.success("ARE settings saved");
      setDirty(false);
      utils.settings.getAreSettings.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Only what changed (A60): writing every field put back values someone
  // else had changed since this page loaded.
  const handleSave = () => {
    if (!loaded) return;
    const patch = changedAreSettings(loaded, {
      areDefaultAutonomyMode: autonomyMode,
      areDefaultDailySendCap: dailySendCap,
      areDefaultAutoApproveThreshold: autoApproveThreshold,
      areDefaultSignalToOpportunity: signalToOpportunity,
      areDefaultChannels: channels,
      areMaxConcurrentCampaigns: maxConcurrent,
      areNotifyOnMeetingBooked: notifyMeeting,
      areNotifyOnAutoApprove: notifyAutoApprove,
      areNotifyOnIcpUpdate: notifyIcpUpdate,
      areDefaultSequenceTemplate: sequenceTemplate,
      areScraperSources: scraperSources,
      areSourceOrder: sourceOrder,
      areIcpRegenSchedule: icpRegenSchedule,
    });
    if (Object.keys(patch).length === 0) { setDirty(false); return; }
    save.mutate(patch);
  };

  // Reset All (A60): it only ever showed an error toast. Now it sets
  // every campaign and the default for new ones to Batch approval, which has
  // no approve line, so nothing is approved without a person.
  const resetAll = trpc.are.campaigns.setAllAutonomy.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.campaignsUpdated} campaign${r.campaignsUpdated === 1 ? "" : "s"} set to Batch approval, and new campaigns default to it.`);
      utils.settings.getAreSettings.invalidate();
      utils.are.campaigns.list.invalidate();
      utils.are.campaigns.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const mark = () => setDirty(true);

  if (isLoading) {
    return (
      <Shell title="ARE Settings">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    );
  }
  // A failed load showed the defaults, and Save wrote them over the real
  // settings (audit 2026-10-20, A60). No form until the settings are here.
  if (!settings) {
    return (
      <Shell title="ARE Settings">
        <QueryError what="ARE settings" message={loadError?.message} onRetry={() => refetch()} />
      </Shell>
    );
  }

  return (
    <Shell title="ARE Settings">
      <PageHeader
        title="ARE Settings" pageKey="are-settings"
        description="Configure ARE engine defaults including scoring thresholds, enrichment providers, and automation rules. These settings apply globally to all new campaigns unless overridden."
      
        icon={<Settings2 className="size-5" />}
      >
        <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-emerald-500/30 text-emerald-600 bg-emerald-500/10 gap-1">
          <Bot className="size-3" /> Autonomous Revenue Engine
        </Badge>
      </PageHeader>
      <AreSubNav />

      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-6">

        {/* -- 1. Autonomy Defaults -- */}
        <Section
          icon={Sliders}
          title="Default Autonomy Mode"
          description="New campaigns will inherit this autonomy mode. You can override it per campaign in the campaign settings tab."
        >
          <div className="space-y-2">
            {AUTONOMY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { setAutonomyMode(opt.value); mark(); }}
                className={`w-full text-left rounded-xl border px-4 py-3 transition-all ${
                  autonomyMode === opt.value
                    ? opt.color + " border-current shadow-sm"
                    : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{opt.label}</span>
                  {autonomyMode === opt.value && <CheckCircle2 className="size-4 text-current" />}
                </div>
                <p className="text-xs mt-0.5 leading-relaxed opacity-80">{opt.description}</p>
              </button>
            ))}
          </div>

          {/* Auto-approve threshold: Full Auto's only (A16), so shown only for it. */}
          {autonomyMode !== "full" ? (
            <p className="pt-3 border-t text-[11px] text-muted-foreground">
              Batch approval has no auto-approve threshold: nothing is approved until a person approves it.
            </p>
          ) : (
          <div className="space-y-3 pt-3 border-t">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium">Default Auto-Approve Threshold</div>
                <div className="text-[11px] text-muted-foreground">{APPROVE_THRESHOLD_EXPLAINER}</div>
              </div>
              <div className="flex items-center gap-2">
                {autoApproveThreshold !== null ? (
                  <span
                    className="text-sm font-bold tabular-nums"
                    style={{ color: autoApproveThreshold >= 70 ? "#34D399" : autoApproveThreshold >= 40 ? "#F59E0B" : "#F87171" }}
                  >
                    {autoApproveThreshold}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground italic">Off</span>
                )}
                <Button
                  size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                  onClick={() => { setAutoApproveThreshold(autoApproveThreshold === null ? APPROVE_THRESHOLD_START : null); mark(); }}
                >
                  {autoApproveThreshold === null ? "Enable" : "Disable"}
                </Button>
              </div>
            </div>
            {autoApproveThreshold !== null && (
              <div className="space-y-1.5">
                <input aria-label="Auto-approve threshold"
                  type="range" min={0} max={100} step={5}
                  value={autoApproveThreshold}
                  onChange={(e) => { setAutoApproveThreshold(parseInt(e.target.value)); mark(); }}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>0 — approve all</span>
                  <span>50 — moderate</span>
                  <span>100 — perfect only</span>
                </div>
                <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 text-xs">
                  <div
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: autoApproveThreshold >= 70 ? "#34D399" : autoApproveThreshold >= 40 ? "#F59E0B" : "#F87171" }}
                  />
                  <span>{approveThresholdSummary(autoApproveThreshold)}.</span>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Daily send cap */}
          <div className="space-y-2 pt-3 border-t">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium">Daily Send Cap</div>
                {/* Two caps read this number, each counted on its own (A19). */}
                <div className="text-[11px] text-muted-foreground">
                  The most the Revenue Engine sends in a day across all its campaigns, email and LinkedIn steps
                  together; each campaign's own daily cap still applies. The same number separately caps the
                  emails reps send by hand and through Sequences each day.
                </div>
              </div>
              <span className="text-sm font-bold tabular-nums text-primary">{dailySendCap}</span>
            </div>
            <input aria-label="Daily send cap"
              type="range" min={10} max={500} step={10}
              value={dailySendCap}
              onChange={(e) => { setDailySendCap(parseInt(e.target.value)); mark(); }}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>10</span>
              <span>250</span>
              <span>500</span>
            </div>
          </div>
        </Section>

        {/* -- 2. Channel Defaults -- */}
        <Section
          icon={Globe}
          title="Default Outreach Channels"
          description="New campaigns will have these channels pre-selected. You can override per campaign. The engine sends email and LinkedIn; SMS and AI Voice have no provider connected."
        >
          <div className="grid grid-cols-2 gap-2">
            {CHANNEL_OPTIONS.map(({ key, label, icon: Icon, color, sendable }) => {
              // Derived at the read, never written back: a row saved before
              // 2026-09-20 may hold sms:true, and it renders off here without
              // this page silently rewriting the workspace's stored settings.
              const active = !!channels[key] && sendable;
              return (
                <button
                  key={key}
                  disabled={!sendable}
                  title={sendable ? undefined : UNSENDABLE_CHANNEL_REASON[key]}
                  onClick={() => {
                    if (!sendable) return;
                    setChannels((prev) => ({ ...prev, [key]: !prev[key] }));
                    mark();
                  }}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-xs transition-all ${
                    !sendable
                      ? "border-border bg-muted/20 text-muted-foreground cursor-not-allowed opacity-70"
                      : active
                      ? "border-primary/40 bg-primary/5 text-foreground shadow-sm"
                      : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/30"
                  }`}
                >
                  <Icon className={`size-4 ${active ? color : "text-muted-foreground"}`} />
                  <div className="min-w-0 text-left">
                    <span className="font-medium">{label}</span>
                    {!sendable && (
                      <div className="text-[10px] text-muted-foreground leading-tight">
                        {UNSENDABLE_CHANNEL_REASON[key]}
                      </div>
                    )}
                  </div>
                  {active && <CheckCircle2 className="size-3.5 text-primary ml-auto" />}
                  {!sendable && (
                    <span className="ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      Unavailable
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Section>

        {/* -- 3. Signal Automation -- */}
        <Section
          icon={Zap}
          title="Signal Automation"
          description="Control what the AI does automatically when engagement signals are received."
        >
          <div className="flex items-center justify-between p-3 rounded-xl border bg-muted/30">
            <div className="space-y-0.5 flex-1 min-w-0 pr-4">
              <div className="text-xs font-medium flex items-center gap-1.5">
                <Zap className="size-3.5 text-violet-500" />
                Auto-create opportunity on meeting booked
              </div>
              <div className="text-[11px] text-muted-foreground">
                The default for new campaigns. A booked meeting always adds the person to your CRM as a contact, with their company; with this on, a discovery-stage opportunity pre-filled from the intelligence dossier is opened too.
              </div>
            </div>
            <Toggle label="Auto-create opportunity on meeting booked" checked={signalToOpportunity} onChange={() => { setSignalToOpportunity(!signalToOpportunity); mark(); }} color="bg-violet-500" />
          </div>
        </Section>

        {/* -- 4. Capacity -- */}
        <Section
          icon={Sparkles}
          title="Capacity Limits"
          description="Control how many campaigns the ARE can run simultaneously across your workspace."
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium">Max Concurrent Campaigns</div>
                <div className="text-[11px] text-muted-foreground">
                  How many campaigns may be <span className="font-medium">active</span> at once. At the limit, launching or
                  starting another is refused and the Auto router holds its proposals until a slot frees up. Campaigns
                  already running are never stopped by this — pause one to make room. Drafts are always allowed.
                </div>
              </div>
              <span className="text-sm font-bold tabular-nums text-primary">{maxConcurrent}</span>
            </div>
            <input aria-label="Maximum concurrent campaigns"
              type="range" min={1} max={50} step={1}
              value={maxConcurrent}
              onChange={(e) => { setMaxConcurrent(parseInt(e.target.value)); mark(); }}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>1</span>
              <span>25</span>
              <span>50</span>
            </div>
          </div>
        </Section>

        {/* -- 5. Notification Preferences --
            The description used to read "which ARE agent events generate
            in-app notifications", which is how three switches over a six-event
            vocabulary read as complete coverage. Engagement signals fire on
            every email open and the weekly rejection digest is written
            straight to `notifications` by the email tracker; neither passes
            the gate these three control (2026-09-20). -- */}
        <Section
          icon={Bell}
          title="Notification Preferences"
          description="Choose which of these ARE events notify you. Engagement signals and the weekly rejection digest always appear."
        >
          <div className="space-y-2">
            {[
              { key: "meeting", label: "Meeting booked via signal", icon: Zap, color: "text-violet-500", checked: notifyMeeting, toggle: () => { setNotifyMeeting(!notifyMeeting); mark(); } },
              { key: "autoApprove", label: "Prospect auto-approved", icon: CheckCircle2, color: "text-emerald-500", checked: notifyAutoApprove, toggle: () => { setNotifyAutoApprove(!notifyAutoApprove); mark(); } },
              { key: "icpUpdate", label: "ICP profile updated or restored", icon: Brain, color: "text-blue-500", checked: notifyIcpUpdate, toggle: () => { setNotifyIcpUpdate(!notifyIcpUpdate); mark(); } },
            ].map(({ key, label, icon: Icon, color, checked, toggle }) => (
              <div key={key} className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/20">
                <div className="flex items-center gap-2.5 text-xs">
                  <Icon className={`size-3.5 ${color}`} />
                  <span className="font-medium">{label}</span>
                </div>
                <Toggle label={label} checked={checked} onChange={toggle} />
              </div>
            ))}
          </div>
        </Section>

        {/* -- 6. Sequence Template -- */}
        <Section
          icon={FileText}
          title="Default Sequence Template"
          description="New campaigns inherit this sequence structure. Step spacing is the campaign's own step gap (one week by default), and changing this does not alter campaigns that already exist."
        >
          <div className="grid grid-cols-2 gap-2">
            {/* -- The literal array that used to sit here printed a day span
                and a channel mix for each template. Both were fiction: the
                campaign owns the cadence (DEFAULT_STEP_GAP_DAYS — seven steps a
                week apart is six weeks, whatever span the copy claimed), and no
                channel mix has ever been enforced, since the prompt only
                forbids two consecutive non-email steps on the same channel and
                the channels come from the campaign's own channelsEnabled. The
                counts were fiction too until the generator started reading the
                same table this renders from (2026-09-20). The exact old strings
                are pinned as forbidden in areSequenceTemplateSteps.test.ts, so
                do not quote them back into this file. -- */}
            {ARE_SEQUENCE_TEMPLATES.map(({ value, label, description: desc }) => {
              const Icon = TEMPLATE_ICONS[value] ?? Sparkles;
              return (
                <button
                  key={value}
                  onClick={() => { setSequenceTemplate(value); mark(); }}
                  className={`text-left rounded-xl border px-3 py-2.5 transition-all ${
                    sequenceTemplate === value
                      ? "border-primary/50 bg-primary/5 shadow-sm"
                      : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Icon className={`size-3.5 ${sequenceTemplate === value ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-xs font-medium">{label}</span>
                    {sequenceTemplate === value && <CheckCircle2 className="size-3 text-primary ml-auto" />}
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
                </button>
              );
            })}
          </div>

          {/* The Sequence Quality Threshold slider is gone (audit 2026-10-20,
              A60): nothing ever read it, while it said low-scoring steps were
              rewritten before sending. The score itself is real and shown. */}
          <p className="pt-3 border-t text-[11px] text-muted-foreground">
            The AI scores each sequence it writes (out of 40, on the prospect's dossier). No threshold acts on that score:
            nothing is rewritten or held because of it.
          </p>
        </Section>

        {/* -- 7. Brand Voice --
            This was a four-button tone picker of its own, saving to a
            workspace_settings column no AI writer has ever read. The ARE
            sequence writer builds its prompt from buildBrandContext(), which
            reads brand_voice_profiles, so the picker was a second vocabulary
            that could never win — and one of its four tones was not even a
            value the real tone enum accepts.
            Removed 2026-09-20 rather than rewired: that row already has two
            editors (/brand-voice and Settings → Branding) and a master
            off-switch a third picker would silently ignore. -- */}
        <Section
          icon={Mic2}
          title="Brand Voice"
          description="ARE outreach copy is written in your workspace Brand Voice profile — its tone, preferred words and words to avoid."
        >
          <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              There is one profile for the whole workspace, shared by every AI writer rather than set per
              page. Turning <span className="font-medium text-foreground">Apply to AI</span> off there
              disables branding for all of them, ARE included — copy is then written with no voice
              instructions at all.
            </p>
            <Link href="/brand-voice">
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                <Mic2 className="size-3.5" /> Edit Brand Voice
              </Button>
            </Link>
          </div>
        </Section>

        {/* -- 8. Prospect sources: checking order + workspace enable mask -- */}
        <Section
          icon={Search}
          title="Prospect Sources & Checking Order"
          description="Sources are checked top-to-bottom: when two find the same person, the higher one's record wins. A source toggled off never runs anywhere in this workspace — discovery, Find prospects, or campaigns — whatever a campaign selected. New campaigns start with the enabled sources pre-selected, except LeadOcean, which a person ticks per campaign because it bills its previews."
        >
          <div className="space-y-2">
            {sourceOrder.map((key, idx) => {
              const meta = ARE_SOURCES.find((s) => s.id === key);
              if (!meta) return null;
              const iconFor: Record<string, { icon: typeof Database; color: string }> = {
                internal: { icon: Database, color: "text-slate-500" },
                google_business: { icon: Globe, color: "text-blue-500" },
                linkedin: { icon: Linkedin, color: "text-blue-600" },
                web: { icon: Globe, color: "text-emerald-500" },
                news: { icon: Newspaper, color: "text-amber-500" },
                apollo: { icon: Database, color: "text-violet-500" },
                quickenrich: { icon: Radar, color: "text-cyan-600" },
                warmysender: { icon: Flame, color: "text-orange-500" },
                leadocean: { icon: Waves, color: "text-sky-600" },
              };
              const { icon: Icon, color } = iconFor[key] ?? { icon: Database, color: "text-slate-500" };
              const active = !!scraperSources[key];
              const move = (dir: -1 | 1) => {
                setSourceOrder((prev) => {
                  const i = prev.indexOf(key);
                  const j = i + dir;
                  if (i < 0 || j < 0 || j >= prev.length) return prev;
                  const next = [...prev];
                  [next[i], next[j]] = [next[j], next[i]];
                  return next;
                });
                mark();
              };
              return (
                <div key={key} className={`flex items-center gap-3 p-2.5 rounded-xl border transition-all ${
                  active ? "border-primary/30 bg-primary/5" : "border-border bg-card opacity-70"
                }`}>
                  <span className="w-5 text-center text-[10px] font-semibold tabular-nums text-muted-foreground shrink-0">{idx + 1}</span>
                  <div className="flex flex-col shrink-0">
                    <button
                      type="button" aria-label={`Move ${meta.label} up`} disabled={idx === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      onClick={() => move(-1)}
                    ><ChevronUp className="size-3.5" /></button>
                    <button
                      type="button" aria-label={`Move ${meta.label} down`} disabled={idx === sourceOrder.length - 1}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      onClick={() => move(1)}
                    ><ChevronDown className="size-3.5" /></button>
                  </div>
                  <Icon className={`size-4 shrink-0 ${active ? color : "text-muted-foreground"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium">{meta.label}</div>
                    <div className="text-[10px] text-muted-foreground">{ARE_SOURCE_DESC[key]}</div>
                  </div>
                  <Toggle label={meta.label} checked={active} onChange={() => { setScraperSources(prev => ({ ...prev, [key]: !prev[key] })); mark(); }} />
                </div>
              );
            })}
          </div>
        </Section>

        {/* -- 8b. Apollo.io connection (feeds the "Apollo" source above) -- */}
        <Section
          icon={Database}
          title="Apollo.io"
          description="Connect your Apollo account so campaigns can source prospects from it. Search-only — costs no Apollo credits."
        >
          <ApolloSourceCard variant="bare" />
        </Section>

        {/* -- 8c. Reoon connection (turns the domain above into a real address) -- */}
        <Section
          icon={MailCheck}
          title="Reoon Email Verifier"
          description="Verifies the addresses Velocity derives from the company domain. Without it, sourcing finds people but never a sendable email."
        >
          <ReoonVerifierCard variant="bare" />
        </Section>

        {/* -- 8d. QuickEnrich connection (feeds the "QuickEnrich" source above) -- */}
        <Section
          icon={Radar}
          title="QuickEnrich"
          description="Campaigns discover people from the QuickEnrich database for free; the enrichment sweep then buys their emails one credit per hit, Reoon-verified."
        >
          <QuickEnrichSourceCard variant="bare" />
        </Section>

        {/* -- 8e. WarmySender connection (feeds the "WarmySender leads" source above) -- */}
        <Section
          icon={Flame}
          title="WarmySender"
          description="Campaigns preview WarmySender's lead database for free (masked) and spend one lead unit per net-new person acquired, metered by the budget ledger against the plan's daily pace and monthly allowance."
        >
          <WarmySenderSourceCard variant="bare" />
        </Section>

        {/* -- 8f. LeadOcean connection (feeds the "LeadOcean" source above) -- */}
        <Section
          icon={Waves}
          title="LeadOcean"
          description="This workspace's own LeadOcean key. Every search row and lookup counts as a record, so it runs only on a campaign or a Source search that ticks it."
        >
          <LeadOceanSourceCard variant="bare" />
        </Section>

        {/* -- 9. ICP Regen Schedule -- */}
        <Section
          icon={Clock}
          title="ICP Re-inference Schedule"
          description="How often the ICP Agent re-reads your CRM data and updates the ideal customer profile. The engine's pass is boot-relative, not a wall clock, so these are minimum intervals rather than appointments."
        >
          <div className="grid grid-cols-2 gap-2">
            {/* No option may name a clock time. Two of these used to promise a
                nightly and a Monday run at a fixed UTC hour; the pass is a
                setTimeout + 24h setInterval from server boot, so no wall clock
                was ever reachable (2026-09-20). */}
            {([
              { value: "daily", label: "Daily", desc: "Re-infer on the engine's daily pass — at most once a day. Recommended for most teams.", icon: RefreshCw },
              { value: "weekly", label: "Weekly", desc: "Re-infer at most once every 7 days. Lowest AI spend.", icon: Clock },
              { value: "on_new_deal", label: "On New Won Deal", desc: "Re-infer on the first daily pass after a deal closes Won.", icon: Zap },
              { value: "manual", label: "Manual Only", desc: "Only re-infer when you click Regenerate on the ICP Agent page.", icon: Shield },
            ] as { value: IcpRegenSchedule; label: string; desc: string; icon: typeof Clock }[]).map(({ value, label, desc, icon: Icon }) => (
              <button
                key={value}
                onClick={() => { setIcpRegenSchedule(value); mark(); }}
                className={`text-left rounded-xl border px-3 py-2.5 transition-all ${
                  icpRegenSchedule === value
                    ? "border-primary/50 bg-primary/5 shadow-sm"
                    : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Icon className={`size-3.5 ${icpRegenSchedule === value ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-xs font-medium">{label}</span>
                  {icpRegenSchedule === value && <CheckCircle2 className="size-3 text-primary ml-auto" />}
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
              </button>
            ))}
          </div>
        </Section>

        {/* -- Save bar -- */}
        <div className={`flex items-center gap-3 p-4 rounded-xl border transition-all ${
          dirty ? "border-primary/30 bg-primary/5 shadow-sm" : "border-transparent bg-transparent"
        }`}>
          {dirty && (
            <span className="text-xs text-primary font-medium flex items-center gap-1.5">
              <div className="size-1.5 rounded-full bg-primary animate-pulse" />
              Unsaved changes
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <Button
                variant="ghost" size="sm" className="text-xs text-muted-foreground"
                onClick={() => { if (loaded) hydrate(loaded); }}
              >
                Discard
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={save.isPending || !dirty}
              className="gap-1.5"
              size="sm"
            >
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Save Settings
            </Button>
          </div>
        </div>

        {/* -- Danger zone -- */}
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader className="pb-2 pt-4 px-5">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-4" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="flex items-center justify-between p-3 rounded-xl border border-destructive/20 bg-background">
              <div className="space-y-0.5 flex-1 min-w-0 pr-4">
                <div className="text-xs font-medium">Set every campaign to Batch approval</div>
                <div className="text-[11px] text-muted-foreground">
                  Sets every campaign, and the default for new ones, to <strong>Batch approval</strong>, so nobody is approved
                  for sending without a person. Each campaign keeps its auto-approve threshold in case you switch it back.
                  There is no undo for all of them at once. Admins only.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 text-xs gap-1.5"
                disabled={resetAll.isPending}
                onClick={() => confirmAction({
                  title: "Set every campaign to Batch approval?",
                  description: "Every campaign in this workspace, and the default for new ones, switches to Batch approval: nothing is approved for sending until a person approves it. Fully autonomous campaigns stop approving on their own.",
                  confirmLabel: "Set all to Batch approval",
                }, () => resetAll.mutate({ mode: "batch_approval" }))}
              >
                {resetAll.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Shield className="size-3.5" />}
                Reset All
              </Button>
            </div>
          </CardContent>
        </Card>

      </div>
    </Shell>
  );
}
