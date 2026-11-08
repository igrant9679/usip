import { useState } from "react";
import { Shell, PageHeader, EmptyState, QueryError, SubNav } from "@/components/usip/Shell";
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
import { useParams, useLocation, Link } from "wouter";
import { NotFoundState, isNotFoundError } from "@/components/usip/QueryState";
import { EMAIL_STATUS_VALUES as STATUS_VALUES, segmentFieldsFor, type SegmentSubject } from "@shared/segmentRules";
import { invalidateListReads } from "@/lib/entityCache";

// ─── Types ────────────────────────────────────────────────────────────────────
type RuleField =
  | "email" | "firstName" | "lastName" | "title" | "phone" | "linkedinUrl"
  | "seniority" | "city" | "emailVerificationStatus" | "isPrimary" | "createdAt"
  | "company" | "industry" | "state" | "country";

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
  // People fields (audit 2026-10-20, F42): a People segment can filter on these.
  { value: "company", label: "Company", type: "text" },
  { value: "industry", label: "Industry", type: "text" },
  { value: "city", label: "City", type: "text" },
  { value: "state", label: "State", type: "text" },
  { value: "country", label: "Country", type: "text" },
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

// Exactly the statuses the server accepts, Unknown among them (audit
// 2026-10-20, P140): verification writes "unknown" and nothing could pick it.
const EMAIL_STATUS_LABELS: Record<string, string> = {
  valid: "Valid", accept_all: "Accept-All", risky: "Risky", invalid: "Invalid", unknown: "Unknown",
};
const EMAIL_STATUS_VALUES = STATUS_VALUES.map((value) => ({ value, label: EMAIL_STATUS_LABELS[value] ?? value }));

/** The fields the segment's table has: People's, or a CRM contact's for a segment not moved (P21). */
function fieldsFor(subject: SegmentSubject) {
  const allowed = segmentFieldsFor(subject);
  return FIELDS.filter((f) => allowed[f.value]);
}

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

/**
 * The value a rule starts with for a field (audit 2026-10-20, P19). A Yes/No
 * select SHOWED "Yes" over an empty value, so "Is primary contact is Yes"
 * saved as "is blank" and matched nobody — or, under "contains", everybody.
 */
/** Text fields start on "contains"; every other kind on its own first operator. */
function defaultOperatorFor(field: RuleField): RuleOperator {
  const type = FIELDS.find((x) => x.value === field)?.type ?? "text";
  return type === "text" ? "contains" : getOperators(field)[0].value;
}

function defaultValueFor(field: RuleField): string {
  return FIELDS.find((x) => x.value === field)?.type === "boolean" ? "true" : "";
}

// ─── Rule Row ─────────────────────────────────────────────────────────────────
function RuleRow({
  rule,
  index,
  matchType,
  onChange,
  onRemove,
  isFirst,
  subject,
}: {
  rule: Rule;
  index: number;
  matchType: "all" | "any";
  onChange: (r: Rule) => void;
  onRemove: () => void;
  isFirst: boolean;
  subject: SegmentSubject;
}) {
  const fieldMeta = FIELDS.find((f) => f.value === rule.field);
  const fields = fieldsFor(subject);
  // A rule moved from contacts on a field People don't have (P21): kept and
  // shown, so nothing is dropped silently; it must be removed or changed to save.
  const unmapped = !fields.some((f) => f.value === rule.field);
  const operators = getOperators(rule.field);
  const showValue = needsValue(rule.operator);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground w-8 text-right shrink-0">
        {isFirst ? "Where" : matchType === "all" ? "AND" : "OR"}
      </span>

      <Select
        value={rule.field}
        onValueChange={(v) => {
          // The field's own first operator: "contains" was kept for every
          // field, so on a Yes/No or a status it matched everyone (P19).
          const field = v as RuleField;
          onChange({ ...rule, field, operator: defaultOperatorFor(field), value: defaultValueFor(field) });
        }}
      >
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {unmapped && fieldMeta && (
            <SelectItem value={fieldMeta.value} className="text-xs" disabled>{fieldMeta.label} (not a People field)</SelectItem>
          )}
          {fields.map((f) => (
            <SelectItem key={f.value} value={f.value} className="text-xs">
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={rule.operator}
        onValueChange={(v) => onChange({ ...rule, operator: v as RuleOperator, value: defaultValueFor(rule.field) })}
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
            <Select value={rule.value} onValueChange={(v) => onChange({ ...rule, value: v })}>
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true" className="text-xs">Yes</SelectItem>
                <SelectItem value="false" className="text-xs">No</SelectItem>
              </SelectContent>
            </Select>
          ) : fieldMeta?.type === "date" ? (
            <Input aria-label="Value"
              type="date"
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              className="h-8 w-36 text-xs"
            />
          ) : (
            <Input aria-label="Value"
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder="Value…"
              className="h-8 w-40 text-xs"
            />
          )}
        </>
      )}

      <Button aria-label="Remove condition" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onRemove}>
        <X className="size-3.5" />
      </Button>
      {unmapped && (
        <div role="alert" className="basis-full pl-10 text-[11px] text-amber-700 dark:text-amber-400">
          {fieldMeta?.label ?? rule.field} is a contact field People don't have. This rule was kept when the segment moved to People; remove it or pick a People field to save.
        </div>
      )}
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
  initial?: { id: number; name: string; description: string; matchType: "all" | "any"; rules: Rule[]; subject?: SegmentSubject };
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  // New segments are on People (P21); an existing one keeps the table it reads.
  const subject: SegmentSubject = initial?.subject ?? "people";
  const who = subject === "people" ? "people" : "CRM contacts";
  const [form, setForm] = useState<SegmentForm>(() =>
    initial
      ? { name: initial.name, description: initial.description, matchType: initial.matchType, rules: initial.rules }
      : { name: "", description: "", matchType: "all", rules: [] }
  );
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const createMut = trpc.segments.create.useMutation({
    onSuccess: () => { invalidateListReads(utils); onSaved(); toast.success("Segment created"); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.segments.update.useMutation({
    onSuccess: () => { invalidateListReads(utils); onSaved(); toast.success("Segment updated"); },
    onError: (e) => toast.error(e.message),
  });
  const evalMut = trpc.segments.evaluate.useMutation({
    onSuccess: (d) => { setPreviewCount(d.count); setPreviewing(false); },
    onError: (e) => { toast.error(e.message); setPreviewing(false); },
  });

  const addRule = () => {
    setForm((f) => ({
      ...f,
      rules: [...f.rules, { id: crypto.randomUUID(), field: "email", operator: defaultOperatorFor("email"), value: "" }],
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
    evalMut.mutate({ rules: form.rules, matchType: form.matchType, ...(initial ? { segmentId: initial.id } : {}) });
  };

  const handleSave = () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    // No rules matches every contact, and a linked auto-enrol rule then
    // enrols the whole base on its next hourly run (P1). The server refuses
    // it too.
    if (form.rules.length === 0) { toast.error(`Add at least one rule — a segment with no rules matches every ${subject === "people" ? "person" : "contact"}.`); return; }
    const allowed = fieldsFor(subject);
    if (form.rules.some((r) => !allowed.some((f) => f.value === r.field))) { toast.error("Remove the rules on fields People don't have first."); return; }
    const unfinished = form.rules.find((r) => needsValue(r.operator) && !r.value.trim());
    if (unfinished) { toast.error("Every rule needs a value (or use \"is empty\")."); return; }
    if (initial) {
      updateMut.mutate({ id: initial.id, name: form.name, description: form.description, matchType: form.matchType, rules: form.rules });
    } else {
      createMut.mutate({ name: form.name, description: form.description, matchType: form.matchType, rules: form.rules });
    }
  };

  const saving = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Segment" : "New Segment"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Segment Name *</Label>
              <Input aria-label="Segment Name"
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
            <Textarea aria-label="Description"
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
                No rules yet. A segment needs at least one.
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
                    subject={subject}
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
                <span className="text-primary font-bold">{previewCount.toLocaleString()}</span> {who} match
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

// ─── Members ──────────────────────────────────────────────────────────────────
const MEMBERS_PER_PAGE = 50;

/**
 * A segment's own page, /segments/:id: who is in it now, a page at a time.
 * View sent people to /contacts?segment=id, which dropped the id on its way to
 * People, and /segments/:id showed the index, so members could not be seen
 * (audit 2026-10-20, P20). The total is counted when the page loads.
 */
function SegmentMembers({ id }: { id: number }) {
  const [page, setPage] = useState(1);
  const segmentsQ = trpc.segments.list.useQuery();
  const seg = segmentsQ.data?.find((s) => s.id === id);
  const membersQ = trpc.segments.getContacts.useQuery(
    { id, page, perPage: MEMBERS_PER_PAGE },
    { enabled: Number.isFinite(id), placeholderData: (prev) => prev },
  );
  const rows = membersQ.data?.rows ?? [];
  const total = membersQ.data?.total ?? 0;
  // People since migration 0363 (P21); a segment not moved still reads CRM contacts.
  const people = (membersQ.data?.subject ?? (seg as { subject?: string } | undefined)?.subject) === "people";
  const pages = Math.max(1, Math.ceil(total / MEMBERS_PER_PAGE));

  if (!Number.isFinite(id) || (membersQ.error && isNotFoundError(membersQ.error)) || (segmentsQ.isFetched && !segmentsQ.error && !seg)) {
    return <Shell title="Segment"><NotFoundState what="segment" backHref="/segments" backLabel="All segments" /></Shell>;
  }

  return (
    <Shell title={seg?.name ?? "Segment"}>
      <PageHeader title={seg?.name ?? "Segment"} description={seg?.description ?? undefined} icon={<Filter className="size-5" />}>
        <Button asChild size="sm" variant="outline"><Link href="/segments">All segments</Link></Button>
      </PageHeader>
      <div className="p-4 md:p-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary" className="text-xs"><Users className="size-3 mr-1" />{membersQ.data ? `${total.toLocaleString()} ${people ? (total === 1 ? "person" : "people") : "CRM contacts"} now` : "Counting…"}</Badge>
          <span className="text-xs text-muted-foreground">
            {people
              ? "This segment reads People. Archived people are left out."
              : "This segment still reads CRM contacts, not People: someone who is only in People is not in it. A contact linked to a People record opens it."}
          </span>
        </div>
        {membersQ.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}</div>
        ) : membersQ.error && !membersQ.data ? (
          <QueryError what="this segment's members" message={membersQ.error.message} onRetry={() => membersQ.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="No one is in this segment now" description={people ? "No one in People matches its rules today." : "No CRM contact matches its rules today."} />
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">Title</th>
                  <th className="px-2 py-1.5 font-medium">Company</th>
                  <th className="px-2 py-1.5 font-medium">Email</th>
                  <th className="px-2 py-1.5 font-medium">Email status</th>
                  <th className="px-2 py-1.5 font-medium">People</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-1.5 font-medium">{`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—"}</td>
                    <td className="px-2 py-1.5"><div className="max-w-[160px] truncate">{c.title || "—"}</div></td>
                    <td className="px-2 py-1.5"><div className="max-w-[160px] truncate">{c.companyName || "—"}</div></td>
                    <td className="px-2 py-1.5 text-xs"><div className="max-w-[200px] truncate">{c.email || "—"}</div></td>
                    <td className="px-2 py-1.5 text-xs">{c.emailVerificationStatus ? (EMAIL_STATUS_LABELS[c.emailVerificationStatus] ?? c.emailVerificationStatus) : "—"}</td>
                    <td className="px-2 py-1.5 text-xs">
                      {c.personProspectId ? <Link href={`/prospects/${c.personProspectId}`} className="underline">Open</Link> : <span className="text-muted-foreground">Not in People</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{(page - 1) * MEMBERS_PER_PAGE + 1}–{(page - 1) * MEMBERS_PER_PAGE + rows.length} of {total.toLocaleString()}</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="px-2">Page {page} of {pages}</span>
              <Button size="sm" variant="outline" className="h-7" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Segments() {
  const { id } = useParams<{ id?: string }>();
  if (id !== undefined) return <SegmentMembers id={Number(id)} />;
  return <SegmentIndex />;
}

function SegmentIndex() {
  const [, setLocation] = useLocation();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const { data: segments, isLoading, error, refetch } = trpc.segments.list.useQuery();
  const utils = trpc.useUtils();

  const deleteMut = trpc.segments.delete.useMutation({
    onSuccess: () => { invalidateListReads(utils); toast.success("Segment deleted"); setConfirmDelete(null); },
    onError: (e) => toast.error(e.message),
  });

  // The page said segments update automatically while a card's count changed
  // only on save, and this had no button (audit 2026-10-20, P53).
  const refreshMut = trpc.segments.refresh.useMutation({
    onSuccess: () => { invalidateListReads(utils); toast.success("Segment counts refreshed"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Shell title="Segments">
      <PageHeader
        title="Segments" pageKey="segments"
        description="Rule-based audiences of the people in People. Who is in a segment is worked out each time it is used, by auto-enrol rules and on its own page; the count on a card is from its last save or refresh."

        icon={<Filter className="size-5" />}
      >
        {segments && segments.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => refreshMut.mutate({})} disabled={refreshMut.isPending}>
            <RefreshCw className={`size-3.5 mr-1.5${refreshMut.isPending ? " animate-spin" : ""}`} />
            Refresh counts
          </Button>
        )}
        <Button size="sm" onClick={() => { setEditing(null); setBuilderOpen(true); }}>
          <Plus className="size-3.5 mr-1.5" />
          New Segment
        </Button>
      </PageHeader>
      <SubNav items={[
        { href: "/segment-rules", label: "Auto-Enroll Rules", title: "Configure segment → sequence auto-enrollment rules" },
      ]} />

      <div className="p-4 md:p-6">
        {/* Said here as well as in the header, whose text an admin can replace (P21). */}
        <p className="text-xs text-muted-foreground mb-4">
          Segments read People (since 2026-11-07; they read CRM contacts before). Segments that moved kept their rules, and the
          auto-enroll rules on them were switched off: check each rule's dry run on Auto-Enroll Rules, then turn it on again.
        </p>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : error && !segments ? (
          <QueryError what="segments" message={error.message} onRetry={() => refetch()} />
        ) : !segments || segments.length === 0 ? (
          <EmptyState
            icon={Filter}
            title="No segments yet"
            description="Create your first segment to start targeting people by specific criteria."
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
              <Card key={seg.id} className="hover:shadow-md transition-shadow group">
                <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm font-semibold truncate">{seg.name}</CardTitle>
                    {seg.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{seg.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
                    <Button aria-label="Edit segment"
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
                    <Button aria-label="Delete segment"
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
                        {seg.subject === "people"
                          ? seg.contactCount == null ? "Not counted on People yet" : `${seg.contactCount.toLocaleString()} ${seg.contactCount === 1 ? "person" : "people"}`
                          : `${(seg.contactCount ?? 0).toLocaleString()} CRM contacts`}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {(seg.rules as Rule[])?.length ?? 0} rule{((seg.rules as Rule[])?.length ?? 0) !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      aria-label={`View the ${seg.subject === "people" ? "people" : "contacts"} in ${seg.name}`}
                      onClick={() => setLocation(`/segments/${seg.id}`)}
                    >
                      View <ChevronRight className="size-3 ml-0.5" />
                    </Button>
                  </div>
                  {seg.lastEvaluatedAt && (
                    <div className="text-[11px] text-muted-foreground mt-2">
                      Counted {new Date(seg.lastEvaluatedAt).toLocaleDateString()}
                    </div>
                  )}
                  {/* Kept and flagged, never dropped (P21): a rule People have no field for. */}
                  {seg.unmappedNote && (
                    <div role="note" className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">
                      {seg.unmappedNote}: edit this segment before it is used.
                    </div>
                  )}
                  {seg.movedToPeopleAt && !seg.unmappedNote && (
                    <div className="text-[11px] text-muted-foreground mt-1">Moved from CRM contacts to People {new Date(seg.movedToPeopleAt).toLocaleDateString()}.</div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Builder Modal */}
      {/* Mounted per segment (P1): one long-lived modal read `initial` only on
          its first render, so Edit opened a blank form, or the previous
          segment's — and Save wrote that over the one being edited. */}
      {builderOpen && (
        <SegmentBuilderModal
          key={editing?.id ?? "new"}
          open
          initial={editing ? {
            id: editing.id,
            name: editing.name,
            description: editing.description ?? "",
            matchType: editing.matchType === "any" ? "any" : "all",
            rules: Array.isArray(editing.rules) ? editing.rules : [],
            subject: editing.subject === "people" ? "people" : "contacts",
          } : undefined}
          onClose={() => { setBuilderOpen(false); setEditing(null); }}
          onSaved={() => { setBuilderOpen(false); setEditing(null); }}
        />
      )}

      {/* Delete Confirm */}
      <Dialog open={confirmDelete !== null} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Segment?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently delete the segment. The people in it are not affected. A segment an auto-enroll rule uses can't be deleted until that rule is.</p>
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
