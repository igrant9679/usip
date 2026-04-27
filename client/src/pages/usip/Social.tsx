import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, fmtDate, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Calendar, ExternalLink, Plus, RefreshCw, Send, Share2, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const PLATFORMS = ["linkedin", "twitter", "facebook", "instagram"] as const;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Social() {
  const utils = trpc.useUtils();
  const accounts = trpc.social.listAccounts.useQuery();
  const posts = trpc.social.listPosts.useQuery();
  const analytics = trpc.social.analytics.useQuery();
  const [tab, setTab] = useState("queue");
  const [connectOpen, setConnectOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [variants, setVariants] = useState<string[]>([]);
  const [topic, setTopic] = useState("");
  const [body, setBody] = useState("");

  // Recurrence state
  const [recurrencePostId, setRecurrencePostId] = useState<number | null>(null);
  const [recurrenceType, setRecurrenceType] = useState<"" | "daily" | "weekly" | "custom">("");
  const [recurrenceInterval, setRecurrenceInterval] = useState("7");
  const [recurrenceDays, setRecurrenceDays] = useState<number[]>([]);
  const [recurrenceEndDate, setRecurrenceEndDate] = useState("");

  const connect = trpc.social.connectAccount.useMutation({ onSuccess: () => { utils.social.listAccounts.invalidate(); setConnectOpen(false); toast.success("Connected (stub)"); } });
  const disconnect = trpc.social.disconnectAccount.useMutation({ onSuccess: () => utils.social.listAccounts.invalidate() });
  const create = trpc.social.createPost.useMutation({ onSuccess: () => { utils.social.listPosts.invalidate(); setComposeOpen(false); setBody(""); setVariants([]); toast.success("Saved"); } });
  const approve = trpc.social.approvePost.useMutation({ onSuccess: () => utils.social.listPosts.invalidate() });
  const sched = trpc.social.schedulePost.useMutation({ onSuccess: () => utils.social.listPosts.invalidate() });
  const pub = trpc.social.publishNowStub.useMutation({ onSuccess: () => { utils.social.listPosts.invalidate(); utils.social.analytics.invalidate(); toast.success("Published (stub)"); } });
  const del = trpc.social.deletePost.useMutation({ onSuccess: () => utils.social.listPosts.invalidate() });
  const genVariants = trpc.social.generateVariants.useMutation({ onSuccess: (r) => { setVariants(r.variants); toast.success("Variants generated"); } });
  const setRecurrence = trpc.social.setRecurrence.useMutation({
    onSuccess: () => { utils.social.listPosts.invalidate(); setRecurrencePostId(null); toast.success("Recurrence saved"); },
    onError: (e) => toast.error(e.message),
  });

  const openRecurrenceDialog = (postId: number) => {
    const post = posts.data?.find((p) => p.id === postId);
    const rec = (post as any)?.recurrence as any;
    setRecurrenceType(rec?.type ?? "");
    setRecurrenceInterval(rec?.interval ? String(rec.interval) : "7");
    setRecurrenceDays(rec?.daysOfWeek ?? []);
    setRecurrenceEndDate(rec?.endDate ?? "");
    setRecurrencePostId(postId);
  };

  const handleSaveRecurrence = () => {
    if (!recurrencePostId) return;
    setRecurrence.mutate({
      id: recurrencePostId,
      recurrence: recurrenceType
        ? {
            type: recurrenceType as any,
            interval: recurrenceType === "custom" ? Number(recurrenceInterval) : undefined,
            daysOfWeek: recurrenceType === "weekly" ? recurrenceDays : undefined,
            endDate: recurrenceEndDate || undefined,
          }
        : null,
    });
  };

  const calendarMap = useMemo(() => {
    const map: Record<string, any[]> = {};
    (posts.data ?? []).filter((p) => p.scheduledFor).forEach((p) => {
      const k = new Date(p.scheduledFor!).toISOString().slice(0, 10);
      (map[k] ||= []).push(p);
    });
    return map;
  }, [posts.data]);

  const last30Days = useMemo(() => Array.from({ length: 30 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i - 7);
    return d.toISOString().slice(0, 10);
  }), []);

  return (
    <Shell title="Social Publishing">
      <PageHeader title="Social Publishing" description="Schedule, approve, and analyze posts across platforms." pageKey="social">
        <Button variant="outline" onClick={() => setConnectOpen(true)}><Plus className="size-4" /> Connect account</Button>
        <Button onClick={() => setComposeOpen(true)}><Plus className="size-4" /> New post</Button>
      </PageHeader>

      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Connected" value={(accounts.data ?? []).filter((a) => a.connected).length} />
          <StatCard label="Published" value={analytics.data?.totalPosts ?? 0} />
          <StatCard label="Impressions" value={(analytics.data?.totalImpressions ?? 0).toLocaleString()} />
          <StatCard label="Engagement" value={`${((analytics.data?.engagementRate ?? 0) * 100).toFixed(1)}%`} />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="queue">Queue</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>
          <TabsContent value="queue">
            <Section title={`All posts (${posts.data?.length ?? 0})`}>
              {(posts.data ?? []).length === 0 ? <EmptyState icon={Share2} title="No posts" /> : (
                <ul className="divide-y">
                  {posts.data!.map((p) => {
                    const rec = (p as any).recurrence as any;
                    return (
                      <li key={p.id} className="p-3 text-sm">
                        <div className="flex items-center gap-2 mb-1">
                          <StatusPill tone="info">{p.platform}</StatusPill>
                          <StatusPill tone={p.status === "published" ? "success" : p.status === "scheduled" ? "info" : p.status === "approved" ? "success" : "muted"}>{p.status}</StatusPill>
                          {rec?.type && (
                            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full capitalize">
                              ↻ {rec.type}
                            </span>
                          )}
                          <div className="ml-auto text-xs text-muted-foreground">{p.scheduledFor ? fmtDate(p.scheduledFor) : "—"}</div>
                        </div>
                        <div className="text-sm whitespace-pre-wrap line-clamp-3">{p.body}</div>
                        {p.status === "published" && <div className="mt-1 text-xs text-muted-foreground font-mono">{p.impressions.toLocaleString()} imp · {p.engagements.toLocaleString()} eng · {p.clicks} clicks</div>}
                        <div className="mt-2 flex gap-1 flex-wrap">
                          {p.status !== "approved" && p.status !== "published" && <Button size="sm" variant="ghost" onClick={() => approve.mutate({ id: p.id })}>Approve</Button>}
                          {p.status === "approved" && <Button size="sm" variant="ghost" onClick={() => sched.mutate({ id: p.id, scheduledFor: new Date(Date.now() + 3600000).toISOString() })}>Schedule +1h</Button>}
                          {p.status !== "published" && <Button size="sm" variant="ghost" onClick={() => pub.mutate({ id: p.id })}><Send className="size-3.5" /> Publish now (stub)</Button>}
                          <Button size="sm" variant="ghost" onClick={() => openRecurrenceDialog(p.id)} title="Set recurrence"><RefreshCw className="size-3.5" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: p.id })}><Trash2 className="size-3.5" /></Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="calendar">
            <Section title="Next 30 days">
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-1 p-3">
                {last30Days.map((k) => {
                  const items = calendarMap[k] ?? [];
                  const d = new Date(k);
                  return (
                    <div key={k} className="border rounded p-2 min-h-20 bg-card">
                      <div className="text-[11px] text-muted-foreground">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</div>
                      {items.map((p) => <div key={p.id} className="text-[11px] mt-1 truncate"><StatusPill tone="info">{p.platform[0]}</StatusPill> {p.body.slice(0, 28)}…</div>)}
                    </div>
                  );
                })}
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="accounts">
            <Section title={`Connected accounts (${accounts.data?.length ?? 0})`}>
              {(accounts.data ?? []).length === 0 ? <EmptyState icon={Calendar} title="None connected" /> : (
                <ul className="divide-y">
                  {accounts.data!.map((a) => (
                    <li key={a.id} className="p-3 flex items-center text-sm gap-2">
                      <StatusPill tone="info">{a.platform}</StatusPill>
                      <div className="font-medium">{a.displayName}</div>
                      <div className="text-xs text-muted-foreground">{a.handle}</div>
                      <div className="ml-auto"><StatusPill tone={a.connected ? "success" : "muted"}>{a.connected ? "connected" : "disconnected"}</StatusPill></div>
                      {a.connected && <Button size="sm" variant="ghost" onClick={() => disconnect.mutate({ id: a.id })}>Disconnect</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="analytics">
            <Section title="By platform">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3">
                {Object.entries(analytics.data?.byPlatform ?? {}).map(([k, v]: any) => (
                  <div key={k} className="border rounded p-3 bg-card">
                    <div className="text-xs uppercase text-muted-foreground">{k}</div>
                    <div className="font-mono text-lg mt-1 tabular-nums truncate">{v.posts} posts</div>
                    <div className="text-xs text-muted-foreground">{v.impressions.toLocaleString()} imp · {v.engagements.toLocaleString()} eng</div>
                  </div>
                ))}
              </div>
            </Section>
          </TabsContent>
        </Tabs>
      </div>

      {/* Recurrence dialog */}
      <FormDialog
        open={recurrencePostId !== null}
        onOpenChange={(o) => { if (!o) setRecurrencePostId(null); }}
        title="Set post recurrence"
        isPending={setRecurrence.isPending}
        onSubmit={handleSaveRecurrence}
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Repeat schedule</label>
            <select
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              value={recurrenceType}
              onChange={(e) => setRecurrenceType(e.target.value as any)}
            >
              <option value="">No repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly (select days)</option>
              <option value="custom">Custom interval (every N days)</option>
            </select>
          </div>
          {recurrenceType === "custom" && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Interval (days)</label>
              <input
                type="number" min="1" max="365"
                value={recurrenceInterval}
                onChange={(e) => setRecurrenceInterval(e.target.value)}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          )}
          {recurrenceType === "weekly" && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Days of week</label>
              <div className="flex gap-1 flex-wrap">
                {DAY_LABELS.map((d, i) => (
                  <button
                    type="button" key={d}
                    className={`px-2 py-1 text-xs rounded border transition ${recurrenceDays.includes(i) ? "bg-primary text-primary-foreground border-primary" : "bg-transparent hover:bg-secondary"}`}
                    onClick={() => setRecurrenceDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
          {recurrenceType && (
            <div className="space-y-1">
              <label className="text-sm font-medium">End date (optional)</label>
              <input
                type="date"
                value={recurrenceEndDate}
                onChange={(e) => setRecurrenceEndDate(e.target.value)}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">Leave blank for no end date.</p>
            </div>
          )}
        </div>
      </FormDialog>

      <FormDialog open={connectOpen} onOpenChange={setConnectOpen} title="Connect social account (stub OAuth)" isPending={connect.isPending}
        onSubmit={(f) => connect.mutate({ platform: f.get("platform") as any, handle: String(f.get("handle")), displayName: String(f.get("displayName") ?? "") || undefined })}>
        <SelectField name="platform" label="Platform" options={PLATFORMS.map((p) => ({ value: p, label: p }))} defaultValue="linkedin" />
        <Field name="handle" label="Handle" placeholder="@usip" required />
        <Field name="displayName" label="Display name" />
        <p className="text-xs text-muted-foreground">Stub: real OAuth requires platform app review.</p>
      </FormDialog>

      <FormDialog open={composeOpen} onOpenChange={setComposeOpen} title="Compose post" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          socialAccountId: Number(f.get("socialAccountId")),
          platform: f.get("platform") as any,
          body: String(f.get("body")),
          scheduledFor: f.get("scheduledFor") ? new Date(String(f.get("scheduledFor"))).toISOString() : undefined,
          status: (f.get("status") as any) || "draft",
        })}>
        <SelectField name="platform" label="Platform" options={PLATFORMS.map((p) => ({ value: p, label: p }))} defaultValue="linkedin" />
        <SelectField name="socialAccountId" label="Account" options={(accounts.data ?? []).filter((a) => a.connected).map((a) => ({ value: String(a.id), label: `${a.platform} · ${a.handle}` }))} />
        <div>
          <div className="flex items-end gap-2">
            <div className="flex-1"><Field name="topic" label="AI topic (optional)" value={topic} onChange={(e: any) => setTopic(e.target.value)} /></div>
            <Button type="button" variant="outline" disabled={genVariants.isPending || topic.length < 4}
              onClick={() => genVariants.mutate({ topic, platform: "linkedin", count: 3 })}><Sparkles className="size-3.5" /> Variants</Button>
          </div>
          {variants.length > 0 && (
            <ul className="mt-2 space-y-1.5">{variants.map((v, i) => (
              <li key={i} className="text-xs p-2 border rounded bg-secondary/40 cursor-pointer hover:bg-secondary" onClick={() => setBody(v)}>{v}</li>
            ))}</ul>
          )}
        </div>
        <TextareaField name="body" label="Body" rows={5} value={body} onChange={(e: any) => setBody(e.target.value)} required />
        <Field name="scheduledFor" label="Schedule (optional)" type="datetime-local" />
        <SelectField name="status" label="Initial status" options={[{ value: "draft", label: "draft" }, { value: "in_review", label: "in_review" }, { value: "scheduled", label: "scheduled" }]} defaultValue="draft" />
      </FormDialog>
    </Shell>
  );
}
