/**
 * NotificationsSection — the Notifications settings subpage rendered inside the
 * Settings hub (/v2/settings/notifications).
 *
 * Apollo-style layout: grouped white cards on a light-grey canvas, each row a
 * notification event with a single "Email" checkbox column, and a Save button
 * top-right. EMAIL ONLY by design — there is deliberately no Slack column,
 * banner, or button (Velocity notifications are email + in-app only).
 *
 * Backed by team.getNotifPrefs / updateNotifPrefs (per-workspace-member prefs).
 * Every event key here must also be in the updateNotifPrefs zod allowlist in
 * server/routers/admin.ts, or its checkbox silently fails to persist.
 */
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const NOTIF_GROUPS = [
  {
    title: "Leads & deals",
    description: "Stay on top of new leads and movement in your pipeline.",
    items: [
      { key: "newLead", label: "New lead assigned to me" },
      { key: "dealStageChange", label: "Deal stage changes" },
    ],
  },
  {
    title: "Tasks",
    description: "Reminders so nothing falls through the cracks.",
    items: [{ key: "taskDue", label: "Receive reminders when tasks are due within a day" }],
  },
  {
    title: "Conversations",
    description: "Know the moment a prospect replies.",
    items: [{ key: "emailReply", label: "Email reply received" }],
  },
  {
    title: "Automation",
    description: "Updates from your sequences and workflow rules.",
    items: [
      { key: "sequenceComplete", label: "Sequence enrollment completed" },
      { key: "workflowFired", label: "Workflow rule fired" },
    ],
  },
  {
    title: "Team & feedback",
    description: "Activity from your teammates and customers.",
    items: [
      { key: "npsSubmitted", label: "NPS survey submitted" },
      { key: "teamInvite", label: "Team invitation accepted" },
    ],
  },
] as const;

type PrefKey = (typeof NOTIF_GROUPS)[number]["items"][number]["key"];
const ALL_KEYS = NOTIF_GROUPS.flatMap((g) => g.items.map((i) => i.key)) as PrefKey[];

export function NotificationsSection() {
  const me = trpc.team.getNotifPrefs.useQuery();
  const update = trpc.team.updateNotifPrefs.useMutation({
    onSuccess: () => {
      me.refetch();
      setDirty(false);
      toast.success("Notification preferences saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>({} as Record<PrefKey, boolean>);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!me.data) return;
    const loaded: Record<string, boolean> = me.data.notifPrefs ?? {};
    const merged = {} as Record<PrefKey, boolean>;
    // Any missing key defaults to ON — matches the server DEFAULT_PREFS.
    ALL_KEYS.forEach((k) => { merged[k] = loaded[k] !== false; });
    setPrefs(merged);
    setDirty(false);
  }, [me.data]);

  const toggle = (key: PrefKey) => {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
    setDirty(true);
  };

  const handleSave = () => update.mutate({ notifPrefs: prefs });

  return (
    <>
      {/* header: title + save */}
      <div className="shrink-0 px-6 pt-4 flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <Button size="sm" disabled={!dirty || update.isPending} onClick={handleSave} className="gap-1.5">
          {update.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
        </Button>
      </div>

      {/* body — light-grey canvas with centred white cards */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto w-full max-w-[820px] px-4 sm:px-6 py-6 space-y-5">
          <p className="text-[13px] text-muted-foreground">
            Choose which events send you an email notification. These apply to your account only.
          </p>

          {me.isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-40 rounded-xl bg-card/70 animate-pulse" />
              ))}
            </div>
          ) : (
            NOTIF_GROUPS.map((group) => (
              <div key={group.title} className="rounded-xl border border-border bg-card shadow-sm">
                <div className="px-5 py-4 border-b border-border">
                  <h2 className="text-[15px] font-semibold text-foreground">{group.title}</h2>
                  <p className="mt-1 text-[13px] text-muted-foreground">{group.description}</p>
                </div>

                {/* column header */}
                <div className="flex items-center px-5 py-2 border-b border-border">
                  <div className="flex-1" />
                  <div className="w-16 shrink-0 text-center text-[12px] font-medium text-muted-foreground">
                    Email
                  </div>
                </div>

                <div className="divide-y divide-border">
                  {group.items.map((it) => (
                    <label
                      key={it.key}
                      className="flex items-center px-5 py-3.5 cursor-pointer hover:bg-muted/40 transition-colors"
                    >
                      <span className="flex-1 text-[13px] text-foreground">{it.label}</span>
                      <div className="w-16 shrink-0 flex justify-center">
                        <Checkbox
                          checked={prefs[it.key as PrefKey] ?? true}
                          onCheckedChange={() => toggle(it.key as PrefKey)}
                        />
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
