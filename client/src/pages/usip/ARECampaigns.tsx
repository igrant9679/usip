/**
 * ARE Campaigns — list and create autonomous prospecting campaigns
 */
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Plus,
  Radar,
  Trash2, Megaphone
} from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

const STATUS_COLOR: Record<string, string> = {
  draft: "#94A3B8",
  active: "#34D399",
  paused: "#F59E0B",
  completed: "#60A5FA",
};

const SOURCE_OPTIONS = [
  { id: "internal", label: "Internal CRM" },
  { id: "google_business", label: "Google Business" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "web", label: "Web Scraping" },
  { id: "news", label: "News & Events" },
  { id: "ai_research", label: "AI Research" },
];

export default function ARECampaigns() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { data: campaigns, isLoading } = trpc.are.campaigns.list.useQuery({});
  const [showCreate, setShowCreate] = useState(false);

  const [form, setForm] = useState({
    name: "",
    description: "",
    autonomyMode: "batch_approval" as "full" | "batch_approval" | "review_release",
    goalType: "reply" as "meeting_booked" | "reply" | "opportunity_created",
    targetProspectCount: 100,
    dailySendCap: 50,
    prospectSources: ["internal", "google_business", "linkedin", "news"] as string[],
    channelsEnabled: { email: true, linkedin: false, sms: false, voice: false },
  });

  const create = trpc.are.campaigns.create.useMutation({
    onSuccess: (data) => {
      toast.success("Campaign created");
      utils.are.campaigns.list.invalidate();
      setShowCreate(false);
      navigate(`/are/campaigns/${data.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const setStatus = trpc.are.campaigns.setStatus.useMutation({
    onSuccess: () => utils.are.campaigns.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const deleteCampaign = trpc.are.campaigns.delete.useMutation({
    onSuccess: () => {
      toast.success("Campaign deleted");
      utils.are.campaigns.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleSource = (id: string) => {
    setForm((f) => ({
      ...f,
      prospectSources: f.prospectSources.includes(id)
        ? f.prospectSources.filter((s) => s !== id)
        : [...f.prospectSources, id],
    }));
  };

  return (
    <Shell title="ARE Campaigns">
      <PageHeader
        title="Autonomous Campaigns" pageKey="are-campaigns"
        description="Create and manage ARE campaigns that source, score, and sequence prospects."
      
        icon={<Megaphone className="size-5" />}
      >
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="size-4" /> New Campaign
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-4 max-w-5xl">
        {/* Campaign list */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="size-5 animate-spin" /> Loading campaigns…
          </div>
        ) : !campaigns || campaigns.length === 0 ? (
          <div className="rounded-xl border border-dashed p-12 text-center">
            <Bot className="size-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">No campaigns yet. Create your first autonomous prospecting campaign.</p>
            <Button onClick={() => setShowCreate(true)} className="gap-2">
              <Plus className="size-4" /> Create Campaign
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-xl border bg-card p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors">
                <div className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: STATUS_COLOR[c.status] ?? "#94A3B8" }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                    <Badge variant="outline" className="text-[10px] capitalize">{c.status}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{c.autonomyMode}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {c.prospectsDiscovered} discovered · {c.prospectsEnriched} enriched · {c.prospectsContacted} contacted · {c.prospectsReplied} replied · {c.meetingsBooked} meetings
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {c.status === "active" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-amber-600 hover:text-amber-700 gap-1 text-xs"
                      onClick={() => setStatus.mutate({ id: c.id, status: "paused" })}
                    >
                      <Pause className="size-3" /> Pause
                    </Button>
                  ) : c.status === "paused" || c.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-emerald-600 hover:text-emerald-700 gap-1 text-xs"
                      onClick={() => setStatus.mutate({ id: c.id, status: "active" })}
                    >
                      <Play className="size-3" /> Activate
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive/60 hover:text-destructive gap-1 text-xs"
                    onClick={() => {
                      if (confirm("Delete this campaign?")) deleteCampaign.mutate({ id: c.id });
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                  <Link href={`/are/campaigns/${c.id}`}>
                    <Button size="sm" variant="ghost" className="gap-1 text-xs">
                      Open <ArrowRight className="size-3" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Campaign Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              New Autonomous Campaign
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Campaign Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Q2 SaaS CFO Outreach"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Description (optional)</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What is this campaign targeting?"
                className="text-sm"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Autonomy Mode</Label>
                <Select value={form.autonomyMode} onValueChange={(v) => setForm((f) => ({ ...f, autonomyMode: v as typeof form.autonomyMode }))}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full Auto</SelectItem>
                    <SelectItem value="batch_approval">Batch Approval</SelectItem>
                    <SelectItem value="review_release">Review &amp; Release</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Goal</Label>
                <Select value={form.goalType} onValueChange={(v) => setForm((f) => ({ ...f, goalType: v as typeof form.goalType }))}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="reply">Get a Reply</SelectItem>
                    <SelectItem value="meeting_booked">Book a Meeting</SelectItem>
                    <SelectItem value="opportunity_created">Create Opportunity</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Target Prospects</Label>
                <Input
                  type="number"
                  value={form.targetProspectCount}
                  onChange={(e) => setForm((f) => ({ ...f, targetProspectCount: parseInt(e.target.value) || 100 }))}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Daily Send Cap</Label>
                <Input
                  type="number"
                  value={form.dailySendCap}
                  onChange={(e) => setForm((f) => ({ ...f, dailySendCap: parseInt(e.target.value) || 50 }))}
                />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Prospect Sources</Label>
              <div className="grid grid-cols-2 gap-2">
                {SOURCE_OPTIONS.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={form.prospectSources.includes(s.id)}
                      onCheckedChange={() => toggleSource(s.id)}
                    />
                    <span className="text-xs text-foreground">{s.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Channels</Label>
              <div className="flex gap-4">
                {(["email", "linkedin", "sms", "voice"] as const).map((ch) => (
                  <label key={ch} className="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox
                      checked={form.channelsEnabled[ch]}
                      onCheckedChange={(v) => setForm((f) => ({ ...f, channelsEnabled: { ...f.channelsEnabled, [ch]: !!v } }))}
                    />
                    <span className="text-xs text-foreground capitalize">{ch}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => create.mutate(form)}
              disabled={create.isPending || !form.name.trim()}
              className="gap-2"
            >
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Create Campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
