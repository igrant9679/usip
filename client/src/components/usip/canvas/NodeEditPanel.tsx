/**
 * NodeEditPanel — slide-in right panel for editing a selected canvas node.
 * Supports all node types: email, wait, condition, action, goal, start.
 * Email nodes have a three-tab generation mode selector:
 *   - dynamic: AI-generated at send time per recipient
 *   - template: pick from saved template library
 *   - typed: user writes subject + body directly
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  Bot,
  Clock,
  FileText,
  GitBranch,
  Mail,
  PenLine,
  Play,
  Settings2,
  Sparkles,
  X,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Node } from "@xyflow/react";

/* ─── Types ─────────────────────────────────────────────────────────────── */
export type EmailMode = "dynamic" | "template" | "typed";

export interface NodeData extends Record<string, unknown> {
  label?: string;
  description?: string;
  // Email node
  emailMode?: EmailMode;
  staticSubject?: string;
  staticBody?: string;
  staticTemplateId?: number;
  aiTone?: string;
  aiLength?: string;
  aiFocus?: string;
  // Wait node
  delayDays?: number;
  delayHours?: number;
  // Condition node
  branchOn?: string;
  branchTrueLabel?: string;
  branchFalseLabel?: string;
  // Action node
  actionType?: string;
  actionValue?: string;
  // Goal node
  goalType?: string;
  goalValue?: string;
}

interface Props {
  node: Node<NodeData> | null;
  readOnly: boolean;
  onClose: () => void;
  onSave: (nodeId: string, data: NodeData) => void;
}

/* ─── Field section wrapper ─────────────────────────────────────────────── */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/* ─── Email mode panel ──────────────────────────────────────────────────── */
function EmailModePanel({
  data,
  readOnly,
  onChange,
}: {
  data: NodeData;
  readOnly: boolean;
  onChange: (patch: Partial<NodeData>) => void;
}) {
  const mode = data.emailMode ?? "typed";
  const templatesQ = trpc.emailTemplates?.list?.useQuery({ status: "active" }, { enabled: mode === "template" });

  return (
    <Section title="Email content">
      <Tabs value={mode} onValueChange={(v) => !readOnly && onChange({ emailMode: v as EmailMode })}>
        <TabsList className="w-full grid grid-cols-3 h-8">
          <TabsTrigger value="typed" className="text-xs gap-1">
            <PenLine className="size-3" /> Typed
          </TabsTrigger>
          <TabsTrigger value="template" className="text-xs gap-1">
            <FileText className="size-3" /> Template
          </TabsTrigger>
          <TabsTrigger value="dynamic" className="text-xs gap-1">
            <Sparkles className="size-3" /> AI
          </TabsTrigger>
        </TabsList>

        {/* ── Typed mode ── */}
        <TabsContent value="typed" className="space-y-3 mt-3">
          <Field label="Subject line">
            <Input
              value={data.staticSubject ?? ""}
              disabled={readOnly}
              placeholder="e.g. Quick question about {{company}}"
              onChange={(e) => onChange({ staticSubject: e.target.value })}
            />
          </Field>
          <Field label="Email body">
            <Textarea
              value={data.staticBody ?? ""}
              disabled={readOnly}
              placeholder="Hi {{firstName}},&#10;&#10;…"
              rows={8}
              className="font-mono text-xs resize-y"
              onChange={(e) => onChange({ staticBody: e.target.value })}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            Use <code className="bg-muted px-1 rounded">{"{{firstName}}"}</code>,{" "}
            <code className="bg-muted px-1 rounded">{"{{company}}"}</code>,{" "}
            <code className="bg-muted px-1 rounded">{"{{title}}"}</code> as merge tags.
          </p>
        </TabsContent>

        {/* ── Template mode ── */}
        <TabsContent value="template" className="space-y-3 mt-3">
          <Field label="Select template">
            <Select
              value={data.staticTemplateId?.toString() ?? ""}
              disabled={readOnly}
              onValueChange={(v) => onChange({ staticTemplateId: Number(v) })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue placeholder="Choose a template…" />
              </SelectTrigger>
              <SelectContent>
                {templatesQ?.data?.map((t: any) => (
                  <SelectItem key={t.id} value={t.id.toString()} className="text-xs">
                    {t.name}
                  </SelectItem>
                ))}
                {(!templatesQ?.data || templatesQ.data.length === 0) && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No templates found</div>
                )}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-[11px] text-muted-foreground">
            The template subject and body are used as-is with merge tag substitution at send time.
          </p>
        </TabsContent>

        {/* ── Dynamic / AI mode ── */}
        <TabsContent value="dynamic" className="space-y-3 mt-3">
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 flex gap-2">
            <Bot className="size-4 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700 dark:text-blue-300">
              Subject and body are generated by AI at the moment of send, personalised per recipient using their contact and account data.
            </p>
          </div>
          <Field label="Tone">
            <Select
              value={data.aiTone ?? "professional"}
              disabled={readOnly}
              onValueChange={(v) => onChange({ aiTone: v })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["professional", "friendly", "direct", "consultative", "casual"].map((t) => (
                  <SelectItem key={t} value={t} className="text-xs capitalize">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Length">
            <Select
              value={data.aiLength ?? "medium"}
              disabled={readOnly}
              onValueChange={(v) => onChange({ aiLength: v })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  { value: "short", label: "Short (1–2 sentences)" },
                  { value: "medium", label: "Medium (3–5 sentences)" },
                  { value: "long", label: "Long (full paragraph)" },
                ].map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Focus / angle (optional)">
            <Input
              value={data.aiFocus ?? ""}
              disabled={readOnly}
              placeholder="e.g. ROI, pain point, social proof…"
              onChange={(e) => onChange({ aiFocus: e.target.value })}
            />
          </Field>
        </TabsContent>
      </Tabs>
    </Section>
  );
}

/* ─── Wait node fields ──────────────────────────────────────────────────── */
function WaitFields({ data, readOnly, onChange }: { data: NodeData; readOnly: boolean; onChange: (p: Partial<NodeData>) => void }) {
  return (
    <Section title="Delay">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Days">
          <Input
            type="number"
            min={0}
            max={365}
            value={data.delayDays ?? 1}
            disabled={readOnly}
            onChange={(e) => onChange({ delayDays: Number(e.target.value) })}
          />
        </Field>
        <Field label="Hours">
          <Input
            type="number"
            min={0}
            max={23}
            value={data.delayHours ?? 0}
            disabled={readOnly}
            onChange={(e) => onChange({ delayHours: Number(e.target.value) })}
          />
        </Field>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Wait this long after the previous step before proceeding.
      </p>
    </Section>
  );
}

/* ─── Condition node fields ─────────────────────────────────────────────── */
const BRANCH_CONDITIONS = [
  { value: "email_opened", label: "Email opened" },
  { value: "email_clicked", label: "Link clicked" },
  { value: "email_replied", label: "Email replied" },
  { value: "email_bounced", label: "Email bounced" },
  { value: "email_unsubscribed", label: "Unsubscribed" },
  { value: "task_completed", label: "Task completed" },
  { value: "score_above", label: "Lead score above threshold" },
  { value: "tag_applied", label: "Tag applied" },
];

function ConditionFields({ data, readOnly, onChange }: { data: NodeData; readOnly: boolean; onChange: (p: Partial<NodeData>) => void }) {
  return (
    <Section title="Branch condition">
      <Field label="Condition">
        <Select
          value={data.branchOn ?? "email_opened"}
          disabled={readOnly}
          onValueChange={(v) => onChange({ branchOn: v })}
        >
          <SelectTrigger className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BRANCH_CONDITIONS.map((c) => (
              <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="TRUE branch label">
          <Input
            value={data.branchTrueLabel ?? "Yes"}
            disabled={readOnly}
            placeholder="Yes"
            onChange={(e) => onChange({ branchTrueLabel: e.target.value })}
          />
        </Field>
        <Field label="FALSE branch label">
          <Input
            value={data.branchFalseLabel ?? "No"}
            disabled={readOnly}
            placeholder="No"
            onChange={(e) => onChange({ branchFalseLabel: e.target.value })}
          />
        </Field>
      </div>
    </Section>
  );
}

/* ─── Action node fields ────────────────────────────────────────────────── */
const ACTION_TYPES = [
  { value: "update_status", label: "Update lead/contact status" },
  { value: "apply_tag", label: "Apply tag" },
  { value: "remove_tag", label: "Remove tag" },
  { value: "create_task", label: "Create task" },
  { value: "assign_owner", label: "Assign owner" },
  { value: "notify_rep", label: "Notify rep" },
  { value: "enroll_sequence", label: "Enroll in another sequence" },
  { value: "update_field", label: "Update custom field" },
];

function ActionFields({ data, readOnly, onChange }: { data: NodeData; readOnly: boolean; onChange: (p: Partial<NodeData>) => void }) {
  return (
    <Section title="Action">
      <Field label="Action type">
        <Select
          value={data.actionType ?? "create_task"}
          disabled={readOnly}
          onValueChange={(v) => onChange({ actionType: v })}
        >
          <SelectTrigger className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_TYPES.map((a) => (
              <SelectItem key={a.value} value={a.value} className="text-xs">{a.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Value / parameter">
        <Input
          value={data.actionValue ?? ""}
          disabled={readOnly}
          placeholder="e.g. tag name, status value, sequence ID…"
          onChange={(e) => onChange({ actionValue: e.target.value })}
        />
      </Field>
    </Section>
  );
}

/* ─── Goal node fields ──────────────────────────────────────────────────── */
const GOAL_TYPES = [
  { value: "reply", label: "Prospect replies" },
  { value: "meeting_booked", label: "Meeting booked" },
  { value: "opportunity_created", label: "Opportunity created" },
  { value: "deal_won", label: "Deal won" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "custom", label: "Custom event" },
];

function GoalFields({ data, readOnly, onChange }: { data: NodeData; readOnly: boolean; onChange: (p: Partial<NodeData>) => void }) {
  return (
    <Section title="Goal / exit event">
      <Field label="Goal type">
        <Select
          value={data.goalType ?? "reply"}
          disabled={readOnly}
          onValueChange={(v) => onChange({ goalType: v })}
        >
          <SelectTrigger className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GOAL_TYPES.map((g) => (
              <SelectItem key={g.value} value={g.value} className="text-xs">{g.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {data.goalType === "custom" && (
        <Field label="Custom event name">
          <Input
            value={data.goalValue ?? ""}
            disabled={readOnly}
            placeholder="e.g. form_submitted"
            onChange={(e) => onChange({ goalValue: e.target.value })}
          />
        </Field>
      )}
    </Section>
  );
}

/* ─── NODE_TYPE_META ────────────────────────────────────────────────────── */
const NODE_META: Record<string, { icon: React.FC<any>; color: string; label: string }> = {
  start: { icon: Play, color: "#14B89A", label: "Start" },
  email: { icon: Mail, color: "#3B82F6", label: "Email" },
  wait: { icon: Clock, color: "#F59E0B", label: "Wait" },
  condition: { icon: GitBranch, color: "#8B5CF6", label: "Condition" },
  action: { icon: Zap, color: "#EC4899", label: "Action" },
  goal: { icon: CheckCircle2, color: "#10B981", label: "Goal" },
};

/* ─── Main panel ────────────────────────────────────────────────────────── */
export function NodeEditPanel({ node, readOnly, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<NodeData>({});

  useEffect(() => {
    if (node) setDraft({ ...node.data });
  }, [node?.id]);

  if (!node) return null;

  const meta = NODE_META[node.type ?? "email"] ?? NODE_META.email;
  const Icon = meta.icon;

  const patch = (p: Partial<NodeData>) => {
    if (readOnly) return;
    setDraft((d) => ({ ...d, ...p }));
  };

  const handleSave = () => {
    onSave(node.id, draft);
    onClose();
  };

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-card border-l shadow-xl z-10 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0" style={{ borderLeftColor: meta.color, borderLeftWidth: 3 }}>
        <Icon className="size-4 shrink-0" style={{ color: meta.color }} />
        <span className="font-semibold text-sm">{meta.label} step</span>
        {readOnly && <Badge variant="secondary" className="text-[10px] ml-1">read-only</Badge>}
        <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground transition">
          <X className="size-4" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Common: label */}
        <Section title="Step label">
          <Field label="Display name">
            <Input
              value={draft.label ?? ""}
              disabled={readOnly}
              placeholder={`${meta.label} step…`}
              onChange={(e) => patch({ label: e.target.value })}
            />
          </Field>
          {node.type !== "start" && (
            <Field label="Description (optional)">
              <Input
                value={draft.description ?? ""}
                disabled={readOnly}
                placeholder="Short note visible on the canvas"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          )}
        </Section>

        <Separator />

        {/* Type-specific fields */}
        {node.type === "email" && (
          <EmailModePanel data={draft} readOnly={readOnly} onChange={patch} />
        )}
        {node.type === "wait" && (
          <WaitFields data={draft} readOnly={readOnly} onChange={patch} />
        )}
        {node.type === "condition" && (
          <ConditionFields data={draft} readOnly={readOnly} onChange={patch} />
        )}
        {node.type === "action" && (
          <ActionFields data={draft} readOnly={readOnly} onChange={patch} />
        )}
        {node.type === "goal" && (
          <GoalFields data={draft} readOnly={readOnly} onChange={patch} />
        )}
        {node.type === "start" && (
          <Section title="Start node">
            <p className="text-xs text-muted-foreground">
              This is the entry point of the sequence. All enrolled contacts begin here.
            </p>
          </Section>
        )}
      </div>

      {/* Footer */}
      {!readOnly && (
        <div className="border-t px-4 py-3 flex gap-2 shrink-0">
          <Button size="sm" className="flex-1" onClick={handleSave}>
            Apply changes
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      )}
      {readOnly && (
        <div className="border-t px-4 py-3 shrink-0">
          <Button size="sm" variant="outline" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}
