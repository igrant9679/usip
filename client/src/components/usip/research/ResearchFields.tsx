/**
 * Shared pieces for the Research pages (markets, sectors) and the persona
 * editor: list editors, the status badge, the Markets / Personas / ICP strip,
 * the role checks, and the version history dialog.
 *
 * Editors hand back raw values; the server's shared shape
 * (shared/researchShape.ts) trims, deduplicates and drops personal data, so
 * these stay simple and typing is never fought by a cleaner mid-keystroke.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { SubNav } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { History, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { rankOf, ROLE_RANK } from "@shared/roleRank";
import { RESEARCH_PART_LABEL, RESEARCH_STATUS_LABEL, type ResearchStatus } from "@shared/researchShape";

/* ── Navigation and roles ───────────────────────────────────────────────── */

/** Research absorbs Personas and the ICP page (owner decision 2026-10-14). */
export const RESEARCH_TABS = [
  { href: "/research", label: "Markets", title: "Markets and the sectors inside them" },
  { href: "/personas", label: "Personas", title: "The buyers you write to" },
  { href: "/are/icp", label: "ICP", title: "Your ideal customer profile, learned from won and lost deals" },
];

export function ResearchSubNav() {
  return <SubNav items={RESEARCH_TABS} />;
}

/** Managers and admins edit research; everyone in the workspace reads it. */
export function useResearchRoles() {
  const { current } = useWorkspace();
  const rank = rankOf(current?.role ?? "rep");
  return { canEdit: rank >= ROLE_RANK.manager, canDelete: rank >= ROLE_RANK.admin };
}

/** Toast what the server dropped because it looked like personal contact data. */
export function reportDropped(dropped: string[] | undefined) {
  if (!dropped?.length) return;
  toast.warning(
    `Removed ${dropped.length} ${dropped.length === 1 ? "value" : "values"} that looked like an email address or phone number. Research holds organizations, never people.`,
  );
}

/* ── Display ────────────────────────────────────────────────────────────── */

const STATUS_CLASS: Record<ResearchStatus, string> = {
  draft: "bg-muted text-muted-foreground border-transparent",
  researched: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-transparent",
  verified: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-transparent",
};

export function StatusBadge({ status }: { status: ResearchStatus }) {
  return <Badge variant="outline" className={`text-[10px] ${STATUS_CLASS[status] ?? STATUS_CLASS.draft}`}>{RESEARCH_STATUS_LABEL[status] ?? status}</Badge>;
}

export function Section({ id, title, description, actions, children }: { id?: string; title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="shrink-0 scroll-mt-4">
      <CardHeader>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription className="mt-1">{description}</CardDescription>}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/* ── Editors ────────────────────────────────────────────────────────────── */

/** Short values as chips: titles, industries, keywords. Enter or comma adds. */
export function TagInput({ label, hint, value, onChange, placeholder, disabled }: {
  label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text.split(",").map((t) => t.trim()).filter(Boolean);
    const lower = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const p of parts) if (!lower.has(p.toLowerCase())) { next.push(p); lower.add(p.toLowerCase()); }
    if (next.length !== value.length) onChange(next);
    setText("");
  };
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground -mt-1">{hint}</p>}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="text-xs gap-1">
              {v}
              {!disabled && (
                <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="ml-0.5 hover:opacity-70">×</button>
              )}
            </Badge>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
            onBlur={() => { if (text.trim()) add(); }}
            placeholder={placeholder}
          />
          <Button type="button" variant="outline" size="sm" onClick={add}>Add</Button>
        </div>
      )}
    </div>
  );
}

/** Sentences, one per line: pains, avoid rules, open questions. */
export function LinesInput({ label, hint, value, onChange, placeholder, rows = 4, disabled }: {
  label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number; disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground -mt-1">{hint}</p>}
      <Textarea
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
      />
    </div>
  );
}

export type RowField<T> = { key: keyof T & string; label: string; placeholder?: string; multiline?: boolean; wide?: boolean };

/** A list of small records: glossary terms, competitors, programs, sources. */
export function RowsEditor<T extends Record<string, string>>({ label, hint, fields, value, onChange, addLabel, disabled }: {
  label: string; hint?: string; fields: RowField<T>[]; value: T[]; onChange: (v: T[]) => void; addLabel: string; disabled?: boolean;
}) {
  const blank = () => Object.fromEntries(fields.map((f) => [f.key, ""])) as T;
  const set = (i: number, key: keyof T, v: string) => onChange(value.map((row, j) => (j === i ? { ...row, [key]: v } : row)));
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground -mt-1">{hint}</p>}
      {value.length === 0 && <p className="text-xs text-muted-foreground italic">None yet.</p>}
      <div className="space-y-2">
        {value.map((row, i) => (
          <div key={i} className="rounded-md border p-2.5 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((f) => (
                <div key={f.key} className={f.wide || f.multiline ? "sm:col-span-2 space-y-1" : "space-y-1"}>
                  <span className="text-[11px] text-muted-foreground">{f.label}</span>
                  {f.multiline ? (
                    <Textarea rows={2} value={row[f.key] ?? ""} placeholder={f.placeholder} disabled={disabled} onChange={(e) => set(i, f.key, e.target.value)} />
                  ) : (
                    <Input value={row[f.key] ?? ""} placeholder={f.placeholder} disabled={disabled} onChange={(e) => set(i, f.key, e.target.value)} />
                  )}
                </div>
              ))}
            </div>
            {!disabled && (
              <div className="flex justify-end">
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5 mr-1 text-destructive" /> Remove
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, blank()])}>
          <Plus className="size-3.5 mr-1" /> {addLabel}
        </Button>
      )}
    </div>
  );
}

/* ── Version history ────────────────────────────────────────────────────── */

const fmt = (d: string | Date) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Any part of a market or sector as plain lines, for history and review. */
export function readableText(v: unknown): string {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === "object" ? Object.values(x as Record<string, unknown>).filter((y) => y != null && y !== "").map(String).join(" · ") : String(x)))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => { const s = readableText(x); return s ? `${k}: ${s.replace(/\n/g, "; ")}` : ""; })
      .filter(Boolean)
      .join("\n");
  }
  return String(v);
}

/** A saved version as readable text, part by part. */
function VersionView({ data }: { data: Record<string, unknown> }) {
  const line = readableText;
  const parts = Object.keys(RESEARCH_PART_LABEL).filter((k) => k in data).map((k) => [k, line(data[k])] as const).filter(([, s]) => s);
  return (
    <dl className="space-y-2 text-xs">
      {parts.map(([k, s]) => (
        <div key={k}>
          <dt className="font-medium">{RESEARCH_PART_LABEL[k]}</dt>
          <dd className="whitespace-pre-wrap text-muted-foreground break-words">{s}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HistoryButton(props: { entityType: "market" | "sector"; entityId: number; currentRevision: number; dirty: boolean; onRestored: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History className="size-4 mr-1" /> History
      </Button>
      {open && <HistoryDialog {...props} open={open} onOpenChange={setOpen} />}
    </>
  );
}

function HistoryDialog({ entityType, entityId, currentRevision, dirty, onRestored, open, onOpenChange }: {
  entityType: "market" | "sector"; entityId: number; currentRevision: number; dirty: boolean; onRestored: () => void; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const { canEdit } = useResearchRoles();
  const list = trpc.research.revisions.list.useQuery({ entityType, entityId });
  const [picked, setPicked] = useState<number | null>(null);
  const version = trpc.research.revisions.get.useQuery(
    { entityType, entityId, revision: picked ?? 1 },
    { enabled: picked != null },
  );
  const restore = trpc.research.revisions.restore.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (r) => {
      toast.success(r.changed.length ? `Restored as version ${r.revision}` : "That version is the same as the current one");
      onOpenChange(false);
      onRestored();
    },
  });
  const rows = list.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Every save is kept (the latest 50). Restoring saves the old content as a new version, so nothing is lost.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] min-h-0 flex-1 overflow-hidden">
          <div className="overflow-y-auto pr-1 space-y-1 max-h-[60vh]">
            {list.isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {list.error && <p className="text-xs text-destructive">{list.error.message}</p>}
            {rows.map((r) => (
              <button
                key={r.revision}
                type="button"
                onClick={() => setPicked(r.revision)}
                className={`w-full text-left rounded-md border px-2.5 py-2 text-xs hover:bg-accent ${picked === r.revision ? "border-primary bg-accent" : ""}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">Version {r.revision}</span>
                  {r.revision === currentRevision && <Badge variant="secondary" className="text-[9px] px-1 py-0">current</Badge>}
                </div>
                <div className="text-muted-foreground">{r.note ?? "Edited"} · {r.savedByName}</div>
                <div className="text-muted-foreground">{fmt(r.savedAt)}</div>
                {r.changed.length > 0 && (
                  <div className="text-muted-foreground mt-0.5">Changed: {r.changed.map((c) => RESEARCH_PART_LABEL[c] ?? c).join(", ")}</div>
                )}
              </button>
            ))}
          </div>
          <div className="overflow-y-auto max-h-[60vh] rounded-md border p-3">
            {picked == null ? (
              <p className="text-xs text-muted-foreground">Pick a version to see what it held.</p>
            ) : version.isLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : version.error ? (
              <p className="text-xs text-destructive">{version.error.message}</p>
            ) : version.data ? (
              <div className="space-y-3">
                {canEdit && picked !== currentRevision && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      disabled={restore.isPending || dirty}
                      onClick={() => restore.mutate({ entityType, entityId, revision: picked, expectedRevision: currentRevision })}
                    >
                      <RotateCcw className="size-3.5 mr-1" /> Restore version {picked}
                    </Button>
                    {dirty && <span className="text-xs text-muted-foreground">Save or discard your unsaved changes first.</span>}
                  </div>
                )}
                <VersionView data={version.data.data as unknown as Record<string, unknown>} />
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Editing a saved record ─────────────────────────────────────────────── */

/**
 * The page edits a draft of the saved content. The draft remembers the
 * revision it started from, and that is the revision a save names, so a
 * newer save by someone else makes ours fail with CONFLICT instead of
 * silently replacing theirs. `stale` says so before the person presses Save.
 */
export function useResearchDraft<T>(saved: T | undefined, revision: number | undefined) {
  const [draft, setDraft] = useState<{ value: T; base: number } | null>(null);
  const value = draft?.value ?? saved;
  const dirty = !!draft && JSON.stringify(draft.value) !== JSON.stringify(saved);
  const stale = dirty && revision != null && draft!.base !== revision;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return {
    value,
    dirty,
    stale,
    /** The revision a save must name. */
    baseRevision: draft?.base ?? revision ?? 1,
    patch: (p: Partial<T>) => {
      if (saved === undefined || revision === undefined) return;
      setDraft((d) => ({ value: { ...(d?.value ?? saved), ...p }, base: d?.base ?? revision }));
    },
    discard: () => setDraft(null),
  };
}

/** Pinned to the bottom of the page while there are unsaved changes. */
export function SaveBar({ dirty, stale, saving, onSave, onDiscard }: { dirty: boolean; stale: boolean; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-0 z-10 shrink-0 border-t bg-background/95 backdrop-blur px-4 md:px-6 py-2.5 flex items-center gap-2 flex-wrap">
      <span className="text-sm flex-1 min-w-[12rem]">
        {stale
          ? "Someone saved a newer version while you were editing. Saving will be refused; note your changes, discard, and make them again."
          : "You have unsaved changes."}
      </span>
      <Button variant="outline" size="sm" onClick={onDiscard} disabled={saving}>Discard</Button>
      <Button size="sm" onClick={onSave} disabled={saving || stale}>
        {saving && <Loader2 className="size-3.5 mr-1 animate-spin" />} Save changes
      </Button>
    </div>
  );
}

/** "Research › Market › Sector" above a detail page. */
export function Crumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground px-4 md:px-6 pt-3 shrink-0 flex-wrap">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5 min-w-0">
          {i > 0 && <span aria-hidden>›</span>}
          {it.href ? <Link href={it.href} className="hover:text-foreground hover:underline truncate max-w-[16rem]">{it.label}</Link> : <span className="text-foreground truncate max-w-[16rem]">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}
