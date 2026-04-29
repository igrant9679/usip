import { useState } from "react";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { CheckCircle, Circle, Loader2, ChevronDown, ChevronRight, Sparkles, Copy, ArrowRight, FlaskConical } from "lucide-react";
import { toast } from "sonner";

const STAGES = [
  { id: 1, label: "Prospect Research", description: "Company + person profile" },
  { id: 2, label: "Signal Detection", description: "Recent triggers & buying signals" },
  { id: 3, label: "Angle Generation", description: "Value-prop angles ranked by relevance" },
  { id: 4, label: "Draft Candidates", description: "3 subject + body variants" },
  { id: 5, label: "Final Selection", description: "Best variant with personalization tokens" },
];

function StageIndicator({ stage, current, status }: { stage: number; current: number; status: string }) {
  const done = status === "complete" || current > stage;
  const active = current === stage && status === "running";
  const failed = status === "failed" && current === stage;
  return (
    <div className="flex items-center gap-2">
      {done ? (
        <CheckCircle className="h-5 w-5 text-emerald-500 shrink-0" />
      ) : active ? (
        <Loader2 className="h-5 w-5 text-blue-500 animate-spin shrink-0" />
      ) : failed ? (
        <Circle className="h-5 w-5 text-red-500 shrink-0" />
      ) : (
        <Circle className="h-5 w-5 text-muted-foreground/40 shrink-0" />
      )}
      <div>
        <p className={`text-sm font-medium ${done ? "text-foreground" : active ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}>
          {STAGES[stage - 1].label}
        </p>
        <p className="text-xs text-muted-foreground">{STAGES[stage - 1].description}</p>
      </div>
    </div>
  );
}

function JsonSection({ title, data }: { title: string; data: any }) {
  const [open, setOpen] = useState(false);
  if (!data) return null;
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 bg-muted/40 hover:bg-muted/70 text-sm font-medium text-left"
      >
        {title}
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <pre className="px-4 py-3 text-xs overflow-auto max-h-64 bg-background">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function ResearchPipeline() {
  const [goal, setGoal] = useState("");
  const [tone, setTone] = useState<"concise" | "warm" | "formal" | "punchy">("concise");
  const [activePipelineId, setActivePipelineId] = useState<number | null>(null);

  const { data: pipelines = [], refetch } = trpc.researchPipeline.list.useQuery(undefined);
  const { data: activePipeline, refetch: refetchActive } = trpc.researchPipeline.get.useQuery(
    { id: activePipelineId! },
    { enabled: !!activePipelineId, refetchInterval: activePipelineId ? 2000 : false },
  );

  const start = trpc.researchPipeline.start.useMutation({
    onSuccess: (data) => {
      setActivePipelineId(data.pipelineId);
      refetch();
      toast.success(`Draft created: "${data.subject}"`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleStart = () => {
    if (!goal.trim()) return;
    start.mutate({ goal: goal.trim(), tone });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const stage5 = activePipeline?.stage5_final as any;
  const stage4 = activePipeline?.stage4_draft as any;
  const stage3 = activePipeline?.stage3_angles as any;
  const stage2 = activePipeline?.stage2_signals as any;
  const stage1 = activePipeline?.stage1_prospect as any;

  return (
    <Shell title="Research Pipeline">
      <PageHeader title="AI Research Pipeline" description="Run the 5-stage AI research pipeline: org signals → contact fit → angle generation → draft variants → final review. Each stage is fully auditable and can be paused for human approval." pageKey="research-pipeline" 
        icon={<FlaskConical className="size-5" />}
      />
      <div className="p-6 max-w-5xl mx-auto space-y-6">

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Start panel */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Start New Pipeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Outreach Goal</Label>
                <Textarea
                  placeholder="e.g. Book a discovery call to discuss how USIP can improve their sales pipeline visibility"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={4}
                  className="resize-none"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <Select value={tone} onValueChange={(v) => setTone(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="concise">Concise</SelectItem>
                    <SelectItem value="warm">Warm</SelectItem>
                    <SelectItem value="formal">Formal</SelectItem>
                    <SelectItem value="punchy">Punchy</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                className="w-full"
                onClick={handleStart}
                disabled={start.isPending || !goal.trim()}
              >
                {start.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Running pipeline…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Run Pipeline
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Recent pipelines */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent Pipelines</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-72 overflow-y-auto">
              {pipelines.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No pipelines yet</p>
              )}
              {pipelines.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setActivePipelineId(p.id)}
                  className={`w-full text-left p-2.5 rounded-lg border text-sm hover:bg-muted/50 transition-colors ${activePipelineId === p.id ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30" : ""}`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-medium truncate">Pipeline #{p.id}</span>
                    <Badge
                      variant={p.status === "complete" ? "default" : p.status === "failed" ? "destructive" : "secondary"}
                      className="text-xs shrink-0 ml-1"
                    >
                      {p.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{new Date(p.createdAt).toLocaleString()}</p>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right: Pipeline progress + output */}
        <div className="lg:col-span-2 space-y-4">
          {!activePipeline && !start.isPending && (
            <Card className="flex items-center justify-center h-64">
              <div className="text-center text-muted-foreground">
                <Sparkles className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Run a pipeline to see results here</p>
              </div>
            </Card>
          )}

          {(activePipeline || start.isPending) && (
            <>
              {/* Stage progress */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Pipeline Progress</CardTitle>
                    {activePipeline && (
                      <Badge variant={activePipeline.status === "complete" ? "default" : activePipeline.status === "failed" ? "destructive" : "secondary"}>
                        {activePipeline.status}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {STAGES.map((s, i) => (
                      <div key={s.id}>
                        <StageIndicator
                          stage={s.id}
                          current={activePipeline?.currentStage ?? (start.isPending ? 1 : 0)}
                          status={activePipeline?.status ?? (start.isPending ? "running" : "complete")}
                        />
                        {i < STAGES.length - 1 && <div className="ml-2.5 my-1 h-4 w-px bg-border" />}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Final draft output */}
              {stage5 && (
                <Card className="border-emerald-200 dark:border-emerald-800">
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-5 w-5 text-emerald-500" />
                      <CardTitle className="text-base">Generated Draft</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground uppercase tracking-wide">Subject</Label>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => copyToClipboard(stage5.subject)}>
                          <Copy className="h-3 w-3 mr-1" /> Copy
                        </Button>
                      </div>
                      <p className="text-sm font-medium border rounded-md px-3 py-2 bg-muted/30">{stage5.subject}</p>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground uppercase tracking-wide">Body</Label>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => copyToClipboard(stage5.body)}>
                          <Copy className="h-3 w-3 mr-1" /> Copy
                        </Button>
                      </div>
                      <pre className="text-sm whitespace-pre-wrap border rounded-md px-3 py-2 bg-muted/30 font-sans">{stage5.body}</pre>
                    </div>
                    {stage5.personalizationTokens && (
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(stage5.personalizationTokens).map(([k, v]) => (
                          <Badge key={k} variant="outline" className="text-xs font-mono">
                            {`{{${k}}}`} = {String(v)}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {activePipeline?.emailDraftId && (
                      <div className="pt-2">
                        <a href="/email-drafts" className="inline-flex items-center gap-1.5 text-sm text-emerald-600 hover:underline">
                          View in Email Drafts queue <ArrowRight className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Stage detail accordion */}
              {activePipeline?.status === "complete" && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Stage Details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <JsonSection title="Stage 1 — Prospect Research" data={stage1} />
                    <JsonSection title="Stage 2 — Signal Detection" data={stage2} />
                    <JsonSection title="Stage 3 — Angle Generation" data={stage3} />
                    <JsonSection title="Stage 4 — Draft Candidates" data={stage4} />
                  </CardContent>
                </Card>
              )}

              {activePipeline?.status === "failed" && (
                <Card className="border-red-200 dark:border-red-800">
                  <CardContent className="py-4">
                    <p className="text-sm text-red-600 dark:text-red-400">
                      Pipeline failed: {activePipeline.errorMessage ?? "Unknown error"}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
      </div>
    </Shell>
  );
}
