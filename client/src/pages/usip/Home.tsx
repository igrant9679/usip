/**
 * Home — the redesigned home page with a layout editor (/v2/home).
 *
 * Mirrors Apollo's home: a "Welcome, {name} 👋" header with Edit layout, and a
 * stack of widget cards. Clicking "Edit layout" enters edit mode — each widget
 * gets a drag handle + delete, a "+" opens the Widget library (categorised:
 * Execution / Recommended / Summary / Reports), drag reorders, and Cancel /
 * Save changes persist the layout (localStorage for now).
 *
 * Several widgets are wired to live data (People → prospects, Companies →
 * accounts, Tasks → tasks, Sequence stats → sequences, Email stats →
 * dataHealth); the rest are compact scaffolds.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Pencil, Plus, X, GripVertical, Trash2, ChevronDown, Sparkles, Users, Building2,
  ListChecks, Mail, MessageSquare, Lightbulb, DollarSign, Activity, BarChart3,
  Phone, ArrowRight, Inbox,
} from "lucide-react";

const LS_KEY = "velocity_home_layout_v1";
const LS_HEIGHTS = "velocity_home_heights_v1";

type Ctx = {
  accent: string;
  nav: (href: string) => void;
  people: any[];
  companies: any[];
  tasks: any[];
  sequences: any[];
  metrics: any;
};

type WidgetDef = {
  title: string;
  category: "Execution" | "Recommended" | "Summary" | "Reports";
  icon: any;
  render: (c: Ctx) => React.ReactNode;
};

/* ── small building blocks ── */
function MiniRow({ primary, secondary, right }: { primary: string; secondary?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{primary}</div>
        {secondary && <div className="text-[11px] text-muted-foreground truncate">{secondary}</div>}
      </div>
      {right}
    </div>
  );
}
function EmptyHint({ text }: { text: string }) {
  return <p className="text-[12px] text-muted-foreground py-4 text-center">{text}</p>;
}
function statRow(items: { l: string; v: string | number }[], accent: string) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
      {items.map((s) => (
        <div key={s.l} className="min-w-0">
          <div className="text-lg font-semibold tabular-nums truncate" style={{ color: accent }}>{s.v}</div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{s.l}</div>
        </div>
      ))}
    </div>
  );
}

const WIDGETS: Record<string, WidgetDef> = {
  recommendations: {
    title: "Recommendations", category: "Recommended", icon: Lightbulb,
    render: (c) => (
      <div>
        {[
          { t: "Authenticate domains to avoid spam issues", d: "Some domains aren't fully verified — emails may be filtered.", tag: "Deliverability", to: "/v2/deliverability" },
          { t: "Enrich contacts missing an email", d: `${c.metrics?.total ? 100 - (c.metrics?.pctWithEmail ?? 0) : 0}% of contacts have no email on file.`, tag: "Data", to: "/v2/data-enrichment" },
        ].map((r) => (
          <MiniRow key={r.t} primary={r.t} secondary={r.d} right={<Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => c.nav(r.to)}>{r.tag} <ArrowRight className="size-3" /></Button>} />
        ))}
      </div>
    ),
  },
  people: {
    title: "Suggested leads", category: "Execution", icon: Users,
    render: (c) => c.people.length === 0 ? <EmptyHint text="No prospects yet." /> : (
      <div>{c.people.slice(0, 5).map((p) => <MiniRow key={p.id} primary={`${p.firstName} ${p.lastName}`} secondary={[p.title, p.company].filter(Boolean).join(" · ")} right={p.email ? <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Mail className="size-3" /> email</span> : <span className="text-[11px] text-blue-600">Access email</span>} />)}</div>
    ),
  },
  companies: {
    title: "Top companies", category: "Execution", icon: Building2,
    render: (c) => c.companies.length === 0 ? <EmptyHint text="No accounts yet." /> : (
      <div>{c.companies.slice(0, 5).map((a) => <MiniRow key={a.id} primary={a.name} secondary={[a.industry, a.region].filter(Boolean).join(" · ") || a.domain} />)}</div>
    ),
  },
  tasks: {
    title: "Your tasks", category: "Execution", icon: ListChecks,
    render: (c) => {
      const open = c.tasks.filter((t) => t.status === "open");
      return open.length === 0 ? <EmptyHint text="No open tasks. Nice." /> : (
        <div>{open.slice(0, 5).map((t) => <MiniRow key={t.id} primary={t.title} secondary={t.type && t.type !== "todo" ? t.type : t.relatedType ?? undefined} right={t.priority ? <span className="text-[10px] capitalize text-muted-foreground">{t.priority}</span> : undefined} />)}</div>
      );
    },
  },
  "recent-replies": {
    title: "Recent replies", category: "Execution", icon: MessageSquare,
    render: () => <EmptyHint text="No replies yet — they'll show up here once your sequences get responses." />,
  },
  "email-stats": {
    title: "Your email stats", category: "Summary", icon: Mail,
    render: (c) => statRow([
      { l: "Sent", v: 0 }, { l: "Delivered", v: 0 }, { l: "Opened", v: 0 },
      { l: "Replied", v: 0 }, { l: "With email", v: c.metrics?.withEmail ?? 0 }, { l: "Verified", v: `${c.metrics?.pctVerified ?? 0}%` },
    ], c.accent),
  },
  "call-stats": {
    title: "Call stats", category: "Summary", icon: Phone,
    render: (c) => statRow([{ l: "Calls", v: 0 }, { l: "Connected", v: 0 }, { l: "Voicemail", v: 0 }], c.accent),
  },
  "pending-deals": {
    title: "Pending deals", category: "Recommended", icon: DollarSign,
    render: (c) => <div className="flex items-center justify-between"><EmptyHint text="No open deals to action right now." /><Button variant="outline" size="sm" className="h-7" onClick={() => c.nav("/v2/deals")}>View pipeline</Button></div>,
  },
  "sequence-stats": {
    title: "Sequence stats", category: "Reports", icon: Activity,
    render: (c) => {
      const active = c.sequences.filter((s) => s.status === "active").length;
      const enrolled = c.sequences.reduce((n, s) => n + (s.enrolledCount ?? 0), 0);
      return statRow([{ l: "Sequences", v: c.sequences.length }, { l: "Active", v: active }, { l: "Enrolled", v: enrolled }], c.accent);
    },
  },
  "data-health": {
    title: "Data health", category: "Reports", icon: BarChart3,
    render: (c) => statRow([
      { l: "Contacts", v: c.metrics?.total ?? 0 }, { l: "% Email", v: `${c.metrics?.pctWithEmail ?? 0}%` }, { l: "% Phone", v: `${c.metrics?.pctWithPhone ?? 0}%` },
    ], c.accent),
  },
};

const DEFAULT_LAYOUT = ["recommendations", "people", "email-stats", "tasks", "recent-replies"];
const CATEGORIES = ["Execution", "Recommended", "Summary", "Reports"] as const;

function loadLayout(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr.filter((k) => WIDGETS[k]); }
  } catch { /* ignore */ }
  return DEFAULT_LAYOUT;
}
function loadHeights(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_HEIGHTS);
    if (raw) { const obj = JSON.parse(raw); if (obj && typeof obj === "object") return obj; }
  } catch { /* ignore */ }
  return {};
}

export default function Home() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const { user } = useAuth();

  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<string[]>(loadLayout);
  const [draft, setDraft] = useState<string[]>([]);
  const [heights, setHeights] = useState<Record<string, number>>(loadHeights);
  const [draftHeights, setDraftHeights] = useState<Record<string, number>>({});
  const [libOpen, setLibOpen] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // live data for widgets
  const people = ((trpc.prospects.list.useQuery({ page: 1, perPage: 8 }).data as any)?.data ?? []) as any[];
  const companies = (trpc.accounts.list.useQuery().data ?? []) as any[];
  const tasks = (trpc.tasks.list.useQuery({}).data ?? []) as any[];
  const sequences = (trpc.sequences.list.useQuery().data ?? []) as any[];
  const metrics = trpc.dataHealth.getMetrics.useQuery().data as any;
  const trend = trpc.workspace.trend7d.useQuery().data;
  const convStats = trpc.conversations.stats.useQuery().data as any;
  const notifs = (trpc.notifications.list.useQuery().data ?? []) as any[];
  const ctx: Ctx = { accent, nav: setLocation, people, companies, tasks, sequences, metrics };

  const current = editing ? draft : layout;

  const startEdit = () => { setDraft([...layout]); setDraftHeights({ ...heights }); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setLibOpen(false); setDraft([]); setDraftHeights({}); };
  const saveEdit = () => {
    setLayout(draft); setHeights(draftHeights);
    try { localStorage.setItem(LS_KEY, JSON.stringify(draft)); localStorage.setItem(LS_HEIGHTS, JSON.stringify(draftHeights)); } catch { /* ignore */ }
    setEditing(false); setLibOpen(false);
  };

  const removeWidget = (key: string) => setDraft((d) => d.filter((k) => k !== key));
  const addWidget = (key: string) => setDraft((d) => (d.includes(key) ? d : [...d, key]));
  const reorder = (from: number, to: number) => setDraft((d) => { const n = [...d]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n; });

  const firstName = (user?.name ?? "there").split(" ")[0];
  const available = useMemo(() => Object.keys(WIDGETS), []);

  return (
    <Shell title="Home">
      <div className="flex flex-col h-full min-h-0">
        {/* header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 md:px-6 h-12 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <h1 className="text-[17px] font-semibold tracking-tight">{editing ? "Editing home layout" : <>Welcome, {firstName} <span className="ml-0.5">👋</span></>}</h1>
          <div className="flex-1" />
          {editing ? (
            <>
              <Button variant="ghost" size="sm" className="h-8" onClick={cancelEdit}>Cancel</Button>
              <Button size="sm" className="h-8" style={{ backgroundColor: accent }} onClick={saveEdit}>Save changes</Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={startEdit}><Pencil className="size-3.5" /> Edit layout</Button>
              <Button size="sm" className="h-8 gap-1.5" style={{ backgroundColor: accent }} onClick={() => setLocation("/are")}><Sparkles className="size-3.5" /> Generate Pipeline <ChevronDown className="size-3 opacity-70" /></Button>
            </>
          )}
        </div>

        {/* hero strip — today at a glance + honest 7-day sparklines + autopilot ticker */}
        {!editing && (
          <div className="shrink-0 flex flex-wrap items-center gap-2.5 px-4 md:px-6 py-2.5 border-b border-border/70"
            style={{ background: `linear-gradient(90deg, ${accent}14, transparent 65%)` }}>
            <HeroChip label="Meetings today" value={trend?.meetings?.[6] ?? 0} series={trend?.meetings} color="#10B981" onClick={() => setLocation("/v2/meetings")} />
            <HeroChip label="Tasks due today" value={tasks.filter((t: any) => t.status === "open" && t.dueAt && new Date(t.dueAt) <= new Date(new Date().setHours(23, 59, 59, 999))).length} series={trend?.activities} color="#F59E0B" onClick={() => setLocation("/v2/tasks")} />
            <HeroChip label="Unhandled replies" value={convStats?.unhandled ?? 0} series={trend?.replies} color="#8B5CF6" onClick={() => setLocation("/v2/conversations")} />
            <div className="flex-1" />
            <button type="button" onClick={() => setLocation("/inbox")} className="hidden lg:flex min-w-0 max-w-md items-center gap-2 text-left">
              <span className="shrink-0 size-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
              <span className="truncate text-[12px] text-muted-foreground hover:text-foreground">
                {(() => { const n = notifs.find((x: any) => ["are_event", "workflow_fired", "system"].includes(x.kind)); return n ? `${n.title}${n.body ? ` — ${String(n.body).slice(0, 80)}` : ""}` : "Autopilots are quiet right now"; })()}
              </span>
            </button>
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          {/* canvas */}
          <div className="flex-1 min-w-0 relative">
            {editing && (
              <button
                onClick={() => setLibOpen((v) => !v)}
                title="Add widget"
                aria-label="Add widget"
                className="absolute top-3 right-4 z-20 size-9 rounded-lg border bg-card shadow-sm flex items-center justify-center hover:bg-muted"
              >
                <Plus className="size-4" style={{ color: accent }} />
              </button>
            )}
            <div className="h-full overflow-auto p-4 md:p-6">
            <div className="max-w-4xl mx-auto space-y-4">
              {current.length === 0 && (
                <div className="text-center py-16 border border-dashed rounded-xl">
                  <p className="text-sm text-muted-foreground">No widgets on your home.</p>
                  {editing && <Button size="sm" className="mt-3" style={{ backgroundColor: accent }} onClick={() => setLibOpen(true)}><Plus className="size-4 mr-1" /> Add a widget</Button>}
                </div>
              )}
              {current.map((key, i) => {
                const w = WIDGETS[key];
                if (!w) return null;
                const Icon = w.icon;
                const h = (editing ? draftHeights : heights)[key];
                return (
                  <div
                    key={key}
                    draggable={editing}
                    onDragStart={() => setDragIdx(i)}
                    onDragOver={(e) => { if (editing) e.preventDefault(); }}
                    onDrop={() => { if (editing && dragIdx !== null && dragIdx !== i) reorder(dragIdx, i); setDragIdx(null); }}
                    className={cn("rounded-xl border bg-card shadow-sm", editing && "ring-1 ring-border cursor-move")}
                  >
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
                      {editing && <GripVertical className="size-4 text-muted-foreground/60 shrink-0" />}
                      <Icon className="size-4 shrink-0" style={{ color: accent }} />
                      <h2 className="text-sm font-semibold flex-1">{w.title}</h2>
                      {editing && <button onClick={() => removeWidget(key)} className="p-1 rounded text-muted-foreground hover:text-destructive" title="Remove widget"><Trash2 className="size-4" /></button>}
                    </div>
                    <div
                      className="p-4 overflow-auto"
                      style={{ height: h ? `${h}px` : undefined, resize: editing ? "vertical" : "none" }}
                      onMouseUp={(e) => { if (!editing) return; const ht = (e.currentTarget as HTMLElement).clientHeight; setDraftHeights((d) => ({ ...d, [key]: ht })); }}
                    >
                      {w.render(ctx)}
                    </div>
                  </div>
                );
              })}

            </div>
            </div>
          </div>

          {/* widget library */}
          {editing && libOpen && (
            <aside className="w-80 shrink-0 border-l border-border bg-card flex flex-col min-h-0">
              <div className="flex items-center justify-between px-4 h-11 border-b border-border">
                <h2 className="text-sm font-semibold">Widget library</h2>
                <button onClick={() => setLibOpen(false)} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
                {CATEGORIES.map((cat) => {
                  const items = available.filter((k) => WIDGETS[k].category === cat && !draft.includes(k));
                  if (items.length === 0) return null;
                  return (
                    <div key={cat}>
                      <div className="text-[12px] font-semibold mb-2">{cat}</div>
                      <div className="grid grid-cols-2 gap-2">
                        {items.map((k) => {
                          const w = WIDGETS[k];
                          const Icon = w.icon;
                          return (
                            <button key={k} onClick={() => addWidget(k)} className="rounded-lg border p-3 text-left hover:bg-muted/40 hover:shadow-sm transition-all">
                              <div className="size-8 rounded-md flex items-center justify-center mb-2" style={{ backgroundColor: `${accent}1f`, color: accent }}><Icon className="size-4" /></div>
                              <div className="text-[12px] font-medium leading-tight">{w.title}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {/* already added */}
                {draft.length > 0 && (
                  <div>
                    <div className="text-[12px] font-semibold mb-2 text-muted-foreground">Already added</div>
                    <div className="flex flex-wrap gap-1.5">
                      {draft.map((k) => (
                        <span key={k} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-secondary text-muted-foreground">
                          {WIDGETS[k]?.title}
                          <button onClick={() => removeWidget(k)} className="hover:text-destructive"><X className="size-3" /></button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </Shell>
  );
}

/* ── Home hero strip pieces (vibrance batch) ─────────────────────────────── */

function Sparkline({ series, color }: { series?: number[]; color: string }) {
  const data = series && series.length >= 2 ? series : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 56},${16 - (v / max) * 14}`).join(" ");
  return (
    <svg viewBox="0 0 56 18" className="h-[18px] w-[56px] shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </svg>
  );
}

function HeroChip({ label, value, series, color, onClick }: { label: string; value: number; series?: number[]; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-1.5 shadow-sm transition-colors hover:bg-muted/60"
      style={{ borderColor: `${color}55` }}
    >
      <span className="text-lg font-semibold tabular-nums" style={{ color }}>{value}</span>
      <span className="text-[11.5px] leading-tight text-muted-foreground text-left">{label}<br /><span className="opacity-70">7-day trend</span></span>
      <Sparkline series={series} color={color} />
    </button>
  );
}
