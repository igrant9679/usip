/**
 * Prompt Templates — versioned AI prompt templates for email generation (A/B groups)
 */
import { useState } from "react";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { FlaskConical, GitBranch, Plus, Star, Trash2, Edit2, Copy, Clock, MessageSquare } from "lucide-react";

type GoalType = "intro" | "follow_up" | "meeting_request" | "value_prop" | "breakup" | "check_in";
const GOALS: GoalType[] = ["intro", "follow_up", "meeting_request", "value_prop", "breakup", "check_in"];

interface PromptForm {
  name: string;
  goal: GoalType;
  promptText: string;
  abGroup: "A" | "B";
}

const DEFAULT_FORM: PromptForm = {
  name: "",
  goal: "intro",
  promptText: "Write a {{goal}} email to {{firstName}} at {{company}}. Use a professional tone. Context: {{context}}",
  abGroup: "A",
};

const GOAL_LABELS: Record<GoalType, string> = {
  intro: "Intro",
  follow_up: "Follow Up",
  meeting_request: "Meeting Request",
  value_prop: "Value Prop",
  breakup: "Break Up",
  check_in: "Check In",
};

const goalColor: Record<GoalType, string> = {
  intro: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  follow_up: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  meeting_request: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  value_prop: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  breakup: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  check_in: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

const MERGE_TAGS = ["{{firstName}}", "{{lastName}}", "{{company}}", "{{title}}", "{{goal}}", "{{context}}", "{{painPoint}}", "{{senderName}}"];

export default function PromptTemplatesPage() {
  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<PromptForm>(DEFAULT_FORM);
  const [filterGoal, setFilterGoal] = useState<"all" | GoalType>("all");

  const { data: templates, isLoading } = trpc.promptTemplates.list.useQuery({
    goal: filterGoal === "all" ? undefined : filterGoal,
  });
  const utils = trpc.useUtils();

  const createMutation = trpc.promptTemplates.create.useMutation({
    onSuccess: () => {
      utils.promptTemplates.list.invalidate();
      toast.success("Prompt template created");
      setShowDialog(false);
      setForm(DEFAULT_FORM);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const updateMutation = trpc.promptTemplates.update.useMutation({
    onSuccess: () => {
      utils.promptTemplates.list.invalidate();
      toast.success("Prompt template updated");
      setShowDialog(false);
      setEditId(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const activateMutation = trpc.promptTemplates.activate.useMutation({
    onSuccess: () => {
      utils.promptTemplates.list.invalidate();
      toast.success("Set as active template");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteMutation = trpc.promptTemplates.delete.useMutation({
    onSuccess: () => {
      utils.promptTemplates.list.invalidate();
      toast.success("Deleted");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const openCreate = () => {
    setEditId(null);
    setForm(DEFAULT_FORM);
    setShowDialog(true);
  };

  const openEdit = (t: any) => {
    setEditId(t.id);
    setForm({
      name: t.name,
      goal: t.goal as GoalType,
      promptText: t.promptText,
      abGroup: (t.abGroup ?? "A") as "A" | "B",
    });
    setShowDialog(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim() || !form.promptText.trim()) {
      toast.error("Name and prompt text are required");
      return;
    }
    if (editId) {
      updateMutation.mutate({ id: editId, name: form.name, promptText: form.promptText, abGroup: form.abGroup });
    } else {
      createMutation.mutate({ name: form.name, goal: form.goal, promptText: form.promptText, abGroup: form.abGroup });
    }
  };

  const handleDuplicate = (t: any) => {
    createMutation.mutate({
      name: `${t.name} (copy)`,
      goal: t.goal as GoalType,
      promptText: t.promptText,
      abGroup: t.abGroup === "A" ? "B" : "A",
    });
  };

  const filtered = templates ?? [];

  // Group by goal
  const grouped = GOALS.reduce((acc, goal) => {
    const items = filtered.filter((t: any) => t.goal === goal);
    if (items.length > 0) acc[goal] = items;
    return acc;
  }, {} as Record<GoalType, any[]>);

  return (
    <Shell title="Prompt Templates">
      <PageHeader
        title="Prompt Templates" pageKey="prompt-templates"
        description="Manage AI prompt templates used across the email composer, research pipeline, and ICP agent."
      
        icon={<MessageSquare className="size-5" />}
      >
        <Button size="sm" onClick={openCreate}>
          <Plus size={14} className="mr-1.5" /> New Template
        </Button>
      </PageHeader>

      {/* Filter */}
      <div className="flex items-center gap-3 mb-5">
        <Select value={filterGoal} onValueChange={(v) => setFilterGoal(v as any)}>
          <SelectTrigger className="h-9 w-48">
            <SelectValue placeholder="All goals" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All goals</SelectItem>
            {GOALS.map((g) => (
              <SelectItem key={g} value={g}>{GOAL_LABELS[g]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{filtered.length} template{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => <div key={i} className="h-32 rounded-xl bg-muted animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FlaskConical size={40} className="text-muted-foreground mb-4" />
          <p className="text-lg font-semibold">No prompt templates yet</p>
          <p className="text-sm text-muted-foreground mt-1">Create your first prompt template to customize how the AI writes emails</p>
          <Button className="mt-4" onClick={openCreate}>
            <Plus size={14} className="mr-1.5" /> Create Template
          </Button>
        </div>
      ) : (
        <div className="space-y-8">
          {(Object.entries(grouped) as [GoalType, any[]][]).map(([goal, items]) => (
            <div key={goal}>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-semibold">{GOAL_LABELS[goal]}</h3>
                <Badge className={`text-[10px] ${goalColor[goal]}`}>{items.length}</Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {items.map((t: any) => (
                  <Card key={t.id} className={`group hover:shadow-md transition-shadow ${t.isActive ? "ring-2 ring-primary" : ""}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-sm font-semibold truncate">{t.name}</CardTitle>
                            {t.isActive && (
                              <Badge className="text-[10px] bg-primary/10 text-primary border-primary/20">
                                <Star size={9} className="mr-0.5 fill-current" /> Active
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1">
                            <Badge variant="secondary" className={`text-[10px] ${goalColor[t.goal as GoalType]}`}>
                              {GOAL_LABELS[t.goal as GoalType]}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">Group {t.abGroup ?? "A"}</Badge>
                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                              <GitBranch size={9} /> v{t.version ?? 1}
                            </span>
                          </div>
                        </div>
                        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          {!t.isActive && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Set as active"
                              onClick={() => activateMutation.mutate({ id: t.id })}
                            >
                              <Star size={12} />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(t)}>
                            <Edit2 size={12} />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDuplicate(t)}>
                            <Copy size={12} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 hover:text-destructive"
                            onClick={() => deleteMutation.mutate({ id: t.id })}
                            disabled={t.isActive}
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-muted-foreground line-clamp-2 font-mono bg-muted/40 rounded p-1.5">
                        {t.promptText}
                      </p>
                      {t.createdAt && (
                        <p className="text-[10px] text-muted-foreground mt-2 flex items-center gap-1">
                          <Clock size={9} /> Created {new Date(t.createdAt).toLocaleDateString()}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={showDialog} onOpenChange={(o) => { setShowDialog(o); if (!o) { setEditId(null); setForm(DEFAULT_FORM); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Prompt Template" : "New Prompt Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label>Template Name *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Warm Intro v2"
                />
              </div>
              <div className="space-y-1.5">
                <Label>A/B Group</Label>
                <Select value={form.abGroup} onValueChange={(v) => setForm((f) => ({ ...f, abGroup: v as "A" | "B" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">Group A</SelectItem>
                    <SelectItem value="B">Group B</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!editId && (
              <div className="space-y-1.5">
                <Label>Goal</Label>
                <Select value={form.goal} onValueChange={(v) => setForm((f) => ({ ...f, goal: v as GoalType }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GOALS.map((g) => (
                      <SelectItem key={g} value={g}>{GOAL_LABELS[g]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Prompt Text *</Label>
              <Textarea
                value={form.promptText}
                onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
                placeholder="Write a {{goal}} email to {{firstName}} at {{company}}…"
                className="min-h-[160px] resize-y text-sm font-mono"
              />
              <div className="flex flex-wrap gap-1 mt-1">
                {MERGE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setForm((f) => ({ ...f, promptText: f.promptText + tag }))}
                    className="text-[10px] bg-muted hover:bg-primary/10 hover:text-primary rounded px-1.5 py-0.5 font-mono transition-colors"
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Click tags to insert at end. Use merge tags to personalize the prompt.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending}>
              {editId ? "Save Changes" : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
