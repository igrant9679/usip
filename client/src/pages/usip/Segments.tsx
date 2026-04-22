import { useState } from "react";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Filter,
  Plus,
  Trash2,
  Edit2,
  Users,
  RefreshCw,
  ChevronRight,
  X,
} from "lucide-react";
import { useParams, useLocation } from "wouter";

// ─── Types ────────────────────────────────────────────────────────────────────
type RuleField =
  | "email" | "firstName" | "lastName" | "title" | "phone" | "linkedinUrl"
  | "seniority" | "city" | "emailVerificationStatus" | "isPrimary" | "createdAt";

type RuleOperator =
  | "equals" | "not_equals" | "contains" | "not_contains"
  | "is_empty" | "is_not_empty" | "gt" | "lt";

interface Rule {
  id: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
}

interface SegmentForm {
  name: string;
  description: string;
  matchType: "all" | "any";
  rules: Rule[];
}

// ─── Field/Operator Config ────────────────────────────────────────────────────
const FIELDS: { value: RuleField; label: string; type: "text" | "select" | "date" | "boolean" }[] = [
  { value: "email", label: "Email", type: "text" },
  { value: "firstName", label: "First Name", type: "text" },
  { value: "lastName", label: "Last Name", type: "text" },
  { value: "title", label: "Job Title", type: "text" },
  { value: "phone", label: "Phone", type: "text" },
  { value: "linkedinUrl", label: "LinkedIn URL", type: "text" },
  { value: "seniority", label: "Seniority", type: "text" },
  { value: "city", label: "City", type: "text" },
  { value: "emailVerificationStatus", label: "Email Status", type: "select" },
  { value: "isPrimary", label: "Is Primary Contact", type: "boolean" },
  { value: "createdAt", label: "Created Date", type: "date" },
];

const TEXT_OPERATORS: { value: RuleOperator; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const DATE_OPERATORS: { value: RuleOperator; label: string }[] = [
  { value: "gt", label: "after" },
  { value: "lt", label: "before" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const EMAIL_STATUS_VALUES = [
  { value: "valid", label: "Valid" },
  { value: "accept_all", label: "Accept-All" },
  { value: "risky", label: "Risky" },
  { value: "invalid", label: "Invalid" },
];

function getOperators(field: RuleField) {
  const f = FIELDS.find((x) => x.value === field);
  if (!f) return TEXT_OPERATORS;
  if (f.type === "date") return DATE_OPERATORS;
  if (f.type === "boolean") return [
    { value: "equals" as RuleOperator, label: "is" },
    { value: "not_equals" as RuleOperator, label: "is not" },
  ];
  if (f.type === "select") return [
    { value: "equals" as RuleOperator, label: "equals" },
    { value: "not_equals" as RuleOperator, label: "does not equal" },
    { value: "is_empty" as RuleOperator, label: "is empty" },
    { value: "is_not_empty" as RuleOperator, label: "is not empty" },
  ];
  return TEXT_OPERATORS;
}

function needsValue(operator: RuleOperator) {
  return operator !== "is_empty" && operator !== "is_not_empty";
}

// ─── Rule Row ─────────────────────────────────────────────────────────────────
function RuleRow({
  rule,
  index,
  matchType,
  onChange,
  onRemove,
  isFirst,
}: {
  rule: Rule;
  index: number;
  matchType: "all" | "any";
  onChange: (r: Rule) => void;
  onRemove: () => void;
  isFirst: boolean;
}) {
  const fieldMeta = FIELDS.find((f) => f.value === rule.field);
  const operators = getOperators(rule.field);
  const showValue = needsValue(rule.operator);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground w-8 text-right shrink-0">
        {isFirst ? "Where" : matchType === "all" ? "AND" : "OR"}
      </span>

      <Select
        value={rule.field}
        onValueChange={(v) => onChange({ ...rule, field: v as RuleField, operator: "contains", value: "" })}
      >
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELDS.map((f) => (
            <SelectItem key={f.value} value={f.value} className="text-xs">
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={rule.operator}
        onValueChange={(v) => onChange({ ...rule, operator: v as RuleOperator, value: "" })}
      >
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op.value} value={op.value} className="text-xs">
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showValue && (
        <>
          {fieldMeta?.type === "select" ? (
            <Select value={rule.value} onValueChange={(v) => onChange({ ...rule, value: v })}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_STATUS_VALUES.map((v) => (
                  <SelectItem key={v.value} value={v.value} className="text-xs">
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : fieldMeta?.type === "boolean" ? (
            <Select value={rule.value || "true"} onValueChange={(v) => onChange({ ...rule, value: v })}>
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true" className="text-xs">Yes</SelectItem>
                <SelectItem value="false" className="text-xs">No</SelectItem>
              </SelectContent>
            </Select>
          ) : fieldMeta?.type === "date" ? (
            <Input
              type="date"
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              className="h-8 w-36 text-xs"
            />
          ) : (
            <Input
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder="Value…"
              className="h-8 w-40 text-xs"
            />
          )}
        </>
      )}

      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onRemove}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

// ─── Segment Builder Modal ────────────────────────────────────────────────────
function SegmentBuilderModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial?: { id: number; name: string; description: string; matchType: "all" | "any"; rules: Rule[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<SegmentForm>(() =>
    initial
      ? { name: initial.name, description: initial.description, matchType: initial.matchType, rules: initial.rules }
      : { name: "", description: "", matchType: "all", rules: [] }
  );
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const createMut = trpc.segments.create.useMutation({
    onSuccess: () => { utils.segments.list.invalidate(); onSaved(); toast.success("Segment created"); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.segments.update.useMutation({
    onSuccess: () => { utils.segments.list.invalidate(); onSaved(); toast.success("Segment updated"); },
    onError: (e) => toast.error(e.message),
  });
  const evalMut = trpc.segments.evaluate.useMutation({
    onSuccess: (d) => { setPreviewCount(d.count); setPreviewing(false); },
    onError: (e) => { toast.error(e.message); setPreviewing(false); },
  });

  const addRule = () => {
    setForm((f) => ({
      ...f,
      rules: [...f.rules, { id: crypto.randomUUID(), field: "email", operator: "contains", value: "" }],
    }));
    setPreviewCount(null);
  };

  const updateRule = (id: string, rule: Rule) => {
    setForm((f) => ({ ...f, rules: f.rules.map((r) => (r.id === id ? rule : r)) }));
    setPreviewCount(null);
  };

  const removeRule = (id: string) => {
    setForm((f) => ({ ...f, rules: f.rules.filter((r) => r.id !== id) }));
    setPreviewCount(null);
  };

  const handlePreview = () => {
    setPreviewing(true);
    evalMut.mutate({ rules: form.rules, matchType: form.matchType });
  };

  const handleSave = () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (initial) {
      updateMut.mutate({ id: initial.id, name: form.name, description: form.description, matchType: form.matchType, rules: form.rules });
    } else {
      createMut.mutate({ name: form.name, description: form.description, matchType: form.matchType, rules: form.rules });
    }
  };

  const saving = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Segment" : "New Segment"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Segment Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. High-value SaaS contacts"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Match Type</Label>
              <Select
                value={form.matchType}
                onValueChange={(v) => setForm((f) => ({ ...f, matchType: v as "all" | "any" }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">Match ALL rules (AND)</SelectItem>
                  <SelectItem value="any" className="text-xs">Match ANY rule (OR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Optional description…"
              className="text-sm resize-none h-16"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Filter Rules</Label>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addRule}>
                <Plus className="size-3 mr-1" /> Add Rule
              </Button>
            </div>

            {form.rules.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                No rules yet — this segment will match all contacts.
                <br />
                Click "Add Rule" to filter by specific criteria.
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border p-3 bg-secondary/30">
                {form.rules.map((rule, i) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    index={i}
                    matchType={form.matchType}
                    isFirst={i === 0}
                    onChange={(r) => updateRule(rule.id, r)}
                    onRemove={() => removeRule(rule.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handlePreview} disabled={previewing}>
              {previewing ? <RefreshCw className="size-3 mr-1 animate-spin" /> : <Users className="size-3 mr-1" />}
              Preview Count
            </Button>
            {previewCount !== null && (
              <span className="text-sm font-medium">
                <span className="text-primary font-bold">{previewCount.toLocaleString()}</span> contacts match
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <RefreshCw className="size-3.5 mr-1.5 animate-spin" /> : null}
            {initial ? "Save Changes" : "Create Segment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Segments() {
  const [, setLocation] = useLocation();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const { data: segments, isLoading, refetch } = trpc.segments.list.useQuery();
  const utils = trpc.useUtils();

  const deleteMut = trpc.segments.delete.useMutation({
    onSuccess: () => { utils.segments.list.invalidate(); toast.success("Segment deleted"); setConfirmDelete(null); },
    onError: (e) => toast.error(e.message),
  });

  const refreshMut = trpc.segments.refresh.useMutation({
    onSuccess: () => { utils.segments.list.invalidate(); toast.success("Segment counts refreshed"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Shell title="Segments">
      <PageHeader
        title="Segments"
        description="Build rule-based contact filters to target the right audience for sequences and campaigns."
      >
        <Button size="sm" onClick={() => { setEditing(null); setBuilderOpen(true); }}>
          <Plus className="size-3.5 mr-1.5" />
          New Segment
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : !segments || segments.length === 0 ? (
          <EmptyState
            icon={Filter}
            title="No segments yet"
            description="Create your first segment to start targeting contacts by specific criteria."
            action={
              <Button size="sm" onClick={() => { setEditing(null); setBuilderOpen(true); }}>
                <Plus className="size-3.5 mr-1.5" />
                New Segment
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {segments.map((seg) => (
              <Card key={seg.id} className="hover:shadow-md transition-shadow cursor-pointer group">
                <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm font-semibold truncate">{seg.name}</CardTitle>
                    {seg.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{seg.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(seg);
                        setBuilderOpen(true);
                      }}
                    >
                      <Edit2 className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(seg.id); }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        <Users className="size-3 mr-1" />
                        {(seg.contactCount ?? 0).toLocaleString()} contacts
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {(seg.rules as Rule[])?.length ?? 0} rule{((seg.rules as Rule[])?.length ?? 0) !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setLocation(`/contacts?segment=${seg.id}`)}
                    >
                      View <ChevronRight className="size-3 ml-0.5" />
                    </Button>
                  </div>
                  {seg.lastEvaluatedAt && (
                    <div className="text-[11px] text-muted-foreground mt-2">
                      Last evaluated {new Date(seg.lastEvaluatedAt).toLocaleDateString()}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Builder Modal */}
      <SegmentBuilderModal
        open={builderOpen}
        initial={editing}
        onClose={() => { setBuilderOpen(false); setEditing(null); }}
        onSaved={() => { setBuilderOpen(false); setEditing(null); }}
      />

      {/* Delete Confirm */}
      <Dialog open={confirmDelete !== null} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Segment?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently delete the segment. Contacts are not affected.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete !== null && deleteMut.mutate({ id: confirmDelete })}
              disabled={deleteMut.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
