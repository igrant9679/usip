/**
 * Pick the record a task is about by name (audit 2026-10-20, R104).
 *
 * The legacy New task dialog asked for a "Related ID" — a raw database number
 * nobody can see anywhere in the app — and /v2/tasks could not link a task to
 * a record at all. This searches the chosen kind of record and hands back its
 * type and id, which is what tasks.create stores.
 */
import { useState } from "react";
import { X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

export const RELATED_RECORD_TYPES = [
  { value: "account", label: "Company" },
  { value: "contact", label: "Contact" },
  { value: "lead", label: "Lead" },
  { value: "opportunity", label: "Deal" },
  { value: "prospect", label: "Person" },
] as const;
export type RelatedRecordType = (typeof RELATED_RECORD_TYPES)[number]["value"];
export type RelatedRecord = { type: RelatedRecordType; id: number; label: string };

const fullName = (r: { firstName?: string | null; lastName?: string | null; email?: string | null }) =>
  `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.email || "Unnamed";

export function RelatedRecordPicker({ value, onChange, idPrefix = "related" }: {
  value: RelatedRecord | null;
  onChange: (v: RelatedRecord | null) => void;
  idPrefix?: string;
}) {
  const [type, setType] = useState<RelatedRecordType | "">(value?.type ?? "");
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  const ready = q.length >= 2;

  const accounts = trpc.accounts.list.useQuery({ search: q, limit: 8 }, { enabled: type === "account" && ready });
  const contacts = trpc.contacts.list.useQuery({ search: q }, { enabled: type === "contact" && ready });
  const leads = trpc.leads.list.useQuery({ search: q, limit: 8 }, { enabled: type === "lead" && ready });
  const deals = trpc.opportunities.list.useQuery(undefined, { enabled: type === "opportunity" && ready });
  const people = trpc.prospects.list.useQuery({ page: 1, perPage: 10, search: q }, { enabled: type === "prospect" && ready });

  const options: { id: number; label: string; meta?: string }[] =
    !ready ? []
    : type === "account" ? (accounts.data ?? []).map((a) => ({ id: a.id, label: a.name, meta: a.domain ?? undefined }))
    : type === "contact" ? (contacts.data ?? []).slice(0, 8).map((c) => ({ id: c.id, label: fullName(c), meta: c.email ?? undefined }))
    : type === "lead" ? (leads.data ?? []).map((l) => ({ id: l.id, label: fullName(l), meta: l.company ?? undefined }))
    : type === "opportunity" ? (deals.data ?? []).filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8).map((o) => ({ id: o.id, label: o.name, meta: o.stage }))
    : type === "prospect" ? ((people.data?.data ?? []) as Array<{ id: number; firstName?: string | null; lastName?: string | null; email?: string | null; company?: string | null }>).slice(0, 8).map((p) => ({ id: p.id, label: fullName(p), meta: p.company ?? undefined }))
    : [];

  if (value) {
    const kind = RELATED_RECORD_TYPES.find((t) => t.value === value.type)?.label ?? value.type;
    return (
      <div className="space-y-1">
        <div className="text-sm font-medium">Related to</div>
        <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <span className="text-muted-foreground">{kind}:</span>
          <span className="font-medium truncate">{value.label}</span>
          <button type="button" aria-label="Clear related record" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => { onChange(null); setSearch(""); }}>
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor={`${idPrefix}-type`} className="text-sm font-medium">Related to</label>
      <div className="flex gap-2">
        <select
          id={`${idPrefix}-type`}
          aria-label="Related record type"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={type}
          onChange={(e) => { setType(e.target.value as RelatedRecordType | ""); setSearch(""); }}
        >
          <option value="">Nothing</option>
          {RELATED_RECORD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {type && (
          <input
            aria-label="Search records"
            className="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm"
            placeholder="Type a name to search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {type && ready && (
        <ul className="max-h-40 overflow-y-auto rounded-md border bg-card text-sm">
          {options.length === 0
            ? <li className="px-2 py-1.5 text-xs text-muted-foreground">No matches</li>
            : options.map((o) => (
              <li key={o.id}>
                <button type="button" className="w-full text-left px-2 py-1.5 hover:bg-muted flex items-center gap-2"
                  onClick={() => onChange({ type: type as RelatedRecordType, id: o.id, label: o.label })}>
                  <span className="truncate">{o.label}</span>
                  {o.meta && <span className="ml-auto text-xs text-muted-foreground truncate">{o.meta}</span>}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
