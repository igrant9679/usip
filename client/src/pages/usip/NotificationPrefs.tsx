import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, Section } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Bell, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NOTIFY_EVENTS } from "@shared/notifyPolicy";

/**
 * The SAME five events the workspace policy uses (@shared/notifyPolicy).
 *
 * This page used to list eight events of its own invention — newLead, taskDue,
 * dealStageChange, emailReply, sequenceComplete, workflowFired, npsSubmitted,
 * teamInvite — none of which matched the four keys the server accepted, which
 * in turn matched none of the five the product notifies on. Zod strips unknown
 * keys, so every save wrote `{}` and the page reported success.
 *
 * A member's switch can only MUTE an event the workspace has enabled; it cannot
 * enable one the admin turned off. See the header in @shared/notifyPolicy.
 */
const PREF_ITEMS = NOTIFY_EVENTS;

type PrefKey = string;

export default function NotificationPrefs() {
  const me = trpc.team.getNotifPrefs.useQuery();
  const update = trpc.team.updateNotifPrefs.useMutation({
    onSuccess: () => { me.refetch(); toast.success("Preferences saved"); },
    onError: (e) => toast.error(e.message),
  });

  const [email, setEmail] = useState("");
  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>({} as any);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (me.data) {
      setEmail(me.data.notifEmail ?? "");
      const loaded: Record<string, boolean> = me.data.notifPrefs ?? {};
      const merged: Record<PrefKey, boolean> = {} as any;
      PREF_ITEMS.forEach(({ key }) => {
        merged[key] = loaded[key] !== false; // default on
      });
      setPrefs(merged);
      setDirty(false);
    }
  }, [me.data]);

  const toggle = (key: PrefKey) => {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
    setDirty(true);
  };

  const handleSave = () => {
    update.mutate({ notifEmail: email || undefined, notifPrefs: prefs as any });
    setDirty(false);
  };

  return (
    <Shell title="Notification Preferences">
      {/* The old description promised frequency, grouping and per-channel
          delivery — none of which exists. What these switches actually do is
          mute an event for you, both in-app and by email. */}
      <PageHeader title="Notification Preferences" description="Mute any event you would rather not hear about. These switches narrow what your workspace has enabled in Settings → Notifications; they cannot switch on an event an admin has turned off." pageKey="notification-prefs"
        icon={<BellRing className="size-5" />}
      >
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save preferences"}
        </Button>
      </PageHeader>

      <div className="p-4 md:p-5 max-w-2xl space-y-6">
        <Section title="Notification email">
          <div className="p-4">
            <p className="text-sm text-muted-foreground mb-3">
              Override the email address where notifications are sent. Leave blank to use your account email.
            </p>
            <Field
              name="notifEmail"
              label="Notification email (optional)"
              type="email"
              value={email}
              onChange={(e: any) => { setEmail(e.target.value); setDirty(true); }}
              placeholder="you@company.com"
            />
          </div>
        </Section>

        <Section title="Event notifications">
          <div className="divide-y">
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Turning one off stops both the bell notification and the email for that event.
            </p>
            {PREF_ITEMS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <Bell className="size-4 text-muted-foreground" />
                  <span className="text-sm">{label}</span>
                </div>
                <Switch
                  checked={prefs[key] ?? true}
                  onCheckedChange={() => toggle(key)}
                />
              </div>
            ))}
          </div>
        </Section>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? "Saving…" : "Save preferences"}
          </Button>
        </div>
      </div>
    </Shell>
  );
}
