/**
 * ARESettings — Global Autonomous Revenue Engine configuration
 *
 * Sections:
 *  1. Autonomy defaults — default autonomy mode, auto-approve threshold, daily send cap
 *  2. Signal automation — signal-to-opportunity toggle, notification prefs
 *  3. Channel defaults — email, LinkedIn, SMS, voice
 *  4. Capacity — max concurrent campaigns
 *  5. Notification preferences — which ARE events trigger in-app notifications
 */
import { Shell, PageHeader } from "@/components/usip/Shell";
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
  Star,
  Zap, Settings2
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/* --- Types ---------------------------------------------------------------- */
type AutonomyMode = "full" | "batch_approval" | "review_release";

const AUTONOMY_OPTIONS: { value: AutonomyMode; label: string; description: string; color: string }[] = [
  {
    value: "full",
    label: "Full Autonomy",
    description: "The AI discovers, enriches, sequences, and sends without any human approval. Best for high-volume campaigns where you trust the ICP model.",
    color: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  },
  {
    value: "batch_approval",
    label: "Batch Approval",
    description: "The AI prepares batches of prospects and sequences. You review and approve each batch before sending. Balances speed with oversight.",
    color: "border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-300",
  },
  {
    value: "review_release",
    label: "Review & Release",
    description: "Every prospect requires individual approval before any outreach is sent. Maximum control — ideal for high-value or sensitive accounts.",
    color: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  },
];

const CHANNEL_OPTIONS = [
  { key: "email", label: "Email", icon: Mail, color: "text-blue-500" },
  { key: "linkedin", label: "LinkedIn", icon: Linkedin, color: "text-blue-600" },
  { key: "sms", label: "SMS", icon: MessageSquare, color: "text-emerald-500" },
  { key: "voice", label: "AI Voice", icon: Phone, color: "text-violet-500" },
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
function Toggle({ checked, onChange, color = "bg-primary" }: { checked: boolean; onChange: () => void; color?: string }) {
  return (
    <button
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
  const { data: settings, isLoading } = trpc.settings.getAreSettings.useQuery();

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
  const [sequenceTemplate, setSequenceTemplate] = useState("standard_7step");
  const [brandVoice, setBrandVoice] = useState("professional");
  const [scraperSources, setScraperSources] = useState<Record<string, boolean>>({ google_business: true, linkedin_company: true, linkedin_people: true, web: true, news: true, events: false });
  const [icpRegenSchedule, setIcpRegenSchedule] = useState("weekly");
  const [sequenceQualityThreshold, setSequenceQualityThreshold] = useState(65);
  const [dirty, setDirty] = useState(false);

  // Sync from server on load
  useEffect(() => {
    if (!settings) return;
    setAutonomyMode((settings.areDefaultAutonomyMode as AutonomyMode) ?? "batch_approval");
    setDailySendCap(settings.areDefaultDailySendCap ?? 50);
    setAutoApproveThreshold(settings.areDefaultAutoApproveThreshold ?? null);
    setSignalToOpportunity(settings.areDefaultSignalToOpportunity ?? false);
    setChannels((settings.areDefaultChannels as Record<string, boolean>) ?? { email: true, linkedin: false, sms: false, voice: false });
    setMaxConcurrent(settings.areMaxConcurrentCampaigns ?? 5);
    setNotifyMeeting(settings.areNotifyOnMeetingBooked ?? true);
    setNotifyAutoApprove(settings.areNotifyOnAutoApprove ?? false);
    setNotifyIcpUpdate(settings.areNotifyOnIcpUpdate ?? true);
    setSequenceTemplate((settings.areDefaultSequenceTemplate as string) ?? "standard_7step");
    setBrandVoice((settings as any).areBrandVoice ?? "professional");
    setScraperSources((settings as any).areScraperSources ?? { google_business: true, linkedin_company: true, linkedin_people: true, web: true, news: true, events: false });
    setIcpRegenSchedule((settings as any).areIcpRegenSchedule ?? "weekly");
    setSequenceQualityThreshold((settings as any).areSequenceQualityThreshold ?? 65);
    setDirty(false);
  }, [settings]);

  const save = trpc.settings.updateAreSettings.useMutation({
    onSuccess: () => {
      toast.success("ARE settings saved");
      setDirty(false);
      utils.settings.getAreSettings.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSave = () => {
    save.mutate({
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
    });
  };

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

  return (
    <Shell title="ARE Settings">
      <PageHeader
        title="ARE Settings" pageKey="are-settings"
        description="Configure ARE engine defaults — scoring, enrichment, and automation rules."
      
        icon={<Settings2 className="size-5" />}
      >
        <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-emerald-500/30 text-emerald-600 bg-emerald-500/10 gap-1">
          <Bot className="size-3" /> Autonomous Revenue Engine
        </Badge>
      </PageHeader>

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

          {/* Auto-approve threshold */}
          <div className="space-y-3 pt-3 border-t">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium">Default Auto-Approve Threshold</div>
                <div className="text-[11px] text-muted-foreground">Prospects above this ICP match score are auto-approved in new campaigns.</div>
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
                  <span className="text-xs text-muted-foreground italic">Disabled</span>
                )}
                <Button
                  size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                  onClick={() => { setAutoApproveThreshold(autoApproveThreshold === null ? 70 : null); mark(); }}
                >
                  {autoApproveThreshold === null ? "Enable" : "Disable"}
                </Button>
              </div>
            </div>
            {autoApproveThreshold !== null && (
              <div className="space-y-1.5">
                <input
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
                  <span>
                    {autoApproveThreshold >= 70
                      ? "High precision — only strong ICP matches will be auto-approved."
                      : autoApproveThreshold >= 40
                      ? "Balanced — moderate and strong matches will be auto-approved."
                      : "High volume — most prospects will be auto-approved regardless of fit."}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Daily send cap */}
          <div className="space-y-2 pt-3 border-t">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium">Daily Send Cap</div>
                <div className="text-[11px] text-muted-foreground">Maximum emails sent per day across all active ARE campaigns.</div>
              </div>
              <span className="text-sm font-bold tabular-nums text-primary">{dailySendCap}</span>
            </div>
            <input
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
          description="New campaigns will have these channels pre-selected. You can override per campaign."
        >
          <div className="grid grid-cols-2 gap-2">
            {CHANNEL_OPTIONS.map(({ key, label, icon: Icon, color }) => {
              const active = !!channels[key];
              return (
                <button
                  key={key}
                  onClick={() => { setChannels((prev) => ({ ...prev, [key]: !prev[key] })); mark(); }}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-xs transition-all ${
                    active
                      ? "border-primary/40 bg-primary/5 text-foreground shadow-sm"
                      : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/30"
                  }`}
                >
                  <Icon className={`size-4 ${active ? color : "text-muted-foreground"}`} />
                  <span className="font-medium">{label}</span>
                  {active && <CheckCircle2 className="size-3.5 text-primary ml-auto" />}
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
                When a <code className="bg-muted px-1 rounded text-[10px]">meeting_booked</code> signal is received, the AI automatically creates a CRM account, contact, and discovery-stage opportunity pre-filled with the intelligence dossier.
              </div>
            </div>
            <Toggle checked={signalToOpportunity} onChange={() => { setSignalToOpportunity(!signalToOpportunity); mark(); }} color="bg-violet-500" />
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
                <div className="text-[11px] text-muted-foreground">The ARE will not start new campaigns beyond this limit.</div>
              </div>
              <span className="text-sm font-bold tabular-nums text-primary">{maxConcurrent}</span>
            </div>
            <input
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

        {/* -- 5. Notification Preferences -- */}
        <Section
          icon={Bell}
          title="Notification Preferences"
          description="Choose which ARE agent events generate in-app notifications in your Inbox."
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
                <Toggle checked={checked} onChange={toggle} />
              </div>
            ))}
          </div>
        </Section>

        {/* -- 6. Sequence Template -- */}
        <Section
          icon={FileText}
          title="Default Sequence Template"
          description="New campaigns inherit this sequence structure. The AI adapts the copy but follows the step cadence."
        >
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "standard_7step", label: "Standard 7-Step", desc: "Email × 4 + LinkedIn × 2 + call × 1 over 21 days. Best for most B2B campaigns.", icon: Mail },
              { value: "aggressive_3step", label: "Aggressive 3-Step", desc: "3 emails in 7 days. High velocity, best for warm lists or time-sensitive offers.", icon: Zap },
              { value: "nurture_14step", label: "Nurture 14-Step", desc: "14 touches over 60 days mixing email, LinkedIn, and value content. Best for enterprise.", icon: RefreshCw },
              { value: "custom", label: "Custom", desc: "The AI designs the sequence from scratch based on the campaign ICP and channels.", icon: Sparkles },
            ].map(({ value, label, desc, icon: Icon }) => (
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
            ))}
          </div>

          {/* Sequence quality threshold */}
          <div className="space-y-2 pt-3 border-t">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium flex items-center gap-1.5"><Star className="size-3.5 text-amber-500" /> Sequence Quality Threshold</div>
                <div className="text-[11px] text-muted-foreground">The AI self-evaluates each sequence. Steps scoring below this threshold are automatically rewritten before sending.</div>
              </div>
              <span className="text-sm font-bold tabular-nums" style={{ color: sequenceQualityThreshold >= 70 ? "#34D399" : sequenceQualityThreshold >= 50 ? "#F59E0B" : "#F87171" }}>{sequenceQualityThreshold}</span>
            </div>
            <input type="range" min={0} max={100} step={5} value={sequenceQualityThreshold}
              onChange={(e) => { setSequenceQualityThreshold(parseInt(e.target.value)); mark(); }}
              className="w-full accent-amber-500" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>0 — send anything</span>
              <span>50 — moderate</span>
              <span>100 — perfect only</span>
            </div>
          </div>
        </Section>

        {/* -- 7. Brand Voice -- */}
        <Section
          icon={Mic2}
          title="Brand Voice"
          description="The AI uses this voice profile when writing all outreach copy for new campaigns."
        >
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "professional", label: "Professional", desc: "Formal, precise, and credibility-focused. Suits financial services, legal, and enterprise SaaS.", color: "text-blue-500" },
              { value: "conversational", label: "Conversational", desc: "Warm, human, and approachable. Suits SMB, HR tech, and consumer-adjacent B2B.", color: "text-emerald-500" },
              { value: "direct", label: "Direct", desc: "Short, punchy, and action-oriented. Suits sales tools, growth products, and time-sensitive offers.", color: "text-orange-500" },
              { value: "consultative", label: "Consultative", desc: "Insight-led and value-first. Suits consulting, advisory, and complex solution selling.", color: "text-violet-500" },
            ].map(({ value, label, desc, color }) => (
              <button
                key={value}
                onClick={() => { setBrandVoice(value); mark(); }}
                className={`text-left rounded-xl border px-3 py-2.5 transition-all ${
                  brandVoice === value
                    ? "border-primary/50 bg-primary/5 shadow-sm"
                    : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`text-xs font-semibold ${brandVoice === value ? color : "text-muted-foreground"}`}>{label}</span>
                  {brandVoice === value && <CheckCircle2 className="size-3 text-primary ml-auto" />}
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
              </button>
            ))}
          </div>
        </Section>

        {/* -- 8. Scraper Source Defaults -- */}
        <Section
          icon={Search}
          title="Default Scraper Sources"
          description="New campaigns will have these sources pre-enabled. The AI uses them to discover and enrich prospects."
        >
          <div className="space-y-2">
            {[
              { key: "google_business", label: "Google Business Profiles", desc: "Discover local and regional businesses via Google Maps and Business listings.", icon: Globe, color: "text-blue-500" },
              { key: "linkedin_company", label: "LinkedIn Company Pages", desc: "Scrape company size, industry, recent posts, and hiring signals from LinkedIn.", icon: Linkedin, color: "text-blue-600" },
              { key: "linkedin_people", label: "LinkedIn People Search", desc: "Find decision-makers matching your ICP title filters on LinkedIn.", icon: Linkedin, color: "text-blue-400" },
              { key: "web", label: "General Web", desc: "Crawl company websites for contact info, tech stack signals, and about pages.", icon: Globe, color: "text-emerald-500" },
              { key: "news", label: "News Monitoring", desc: "Track funding rounds, product launches, leadership changes, and press mentions.", icon: Newspaper, color: "text-amber-500" },
              { key: "events", label: "Industry Events", desc: "Find companies attending or sponsoring relevant conferences and trade shows.", icon: Star, color: "text-violet-500" },
            ].map(({ key, label, desc, icon: Icon, color }) => {
              const active = !!scraperSources[key];
              return (
                <div key={key} className={`flex items-center gap-3 p-2.5 rounded-xl border transition-all ${
                  active ? "border-primary/30 bg-primary/5" : "border-border bg-card"
                }`}>
                  <Icon className={`size-4 shrink-0 ${active ? color : "text-muted-foreground"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium">{label}</div>
                    <div className="text-[10px] text-muted-foreground">{desc}</div>
                  </div>
                  <Toggle checked={active} onChange={() => { setScraperSources(prev => ({ ...prev, [key]: !prev[key] })); mark(); }} />
                </div>
              );
            })}
          </div>
        </Section>

        {/* -- 9. ICP Regen Schedule -- */}
        <Section
          icon={Clock}
          title="ICP Re-inference Schedule"
          description="How often the ICP Agent re-reads your CRM data and updates the ideal customer profile."
        >
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "daily", label: "Daily", desc: "Re-infer every night at 02:00 UTC. Best for high-velocity teams closing deals frequently.", icon: RefreshCw },
              { value: "weekly", label: "Weekly", desc: "Re-infer every Monday at 02:00 UTC. Recommended default for most teams.", icon: Clock },
              { value: "on_new_deal", label: "On New Deal", desc: "Re-infer automatically whenever a deal is marked Won or Lost.", icon: Zap },
              { value: "manual", label: "Manual Only", desc: "Only re-infer when you click Regenerate on the ICP Agent page.", icon: Shield },
            ].map(({ value, label, desc, icon: Icon }) => (
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
                onClick={() => { utils.settings.getAreSettings.invalidate(); setDirty(false); }}
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
                <div className="text-xs font-medium">Reset all campaigns to Manual Review</div>
                <div className="text-[11px] text-muted-foreground">
                  Sets every active campaign's autonomy mode to <strong>Review &amp; Release</strong> and disables auto-approve. This cannot be undone in bulk.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 text-xs gap-1.5"
                onClick={() => toast.error("This action requires confirmation — contact your admin.")}
              >
                <Shield className="size-3.5" />
                Reset All
              </Button>
            </div>
          </CardContent>
        </Card>

      </div>
    </Shell>
  );
}
