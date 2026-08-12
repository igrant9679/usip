import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, Section } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Bell, BellRing, Mail } from "lucide-react";
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
 * Two switches per event since 2026-08-12: bell (in-app) and email are
 * separate channels, so "in-app but no email" finally exists. The server
 * fans a legacy single-switch value out to both columns on read.
 *
 * A member's switch can only MUTE an event the workspace has enabled; it cannot
 * enable one the admin turned off. See the header in @shared/notifyPolicy.
 */
const PREF_ITEMS = NOTIFY_EVENTS;

type PrefKey = string;
type ChannelPref = { inApp: boolean; email: boolean };

export default function NotificationPrefs() {
  const me = trpc.team.getNotifPrefs.useQuery();
  const update = trpc.team.updateNotifPrefs.useMutation({
    onSuccess: () => { me.refetch(); toast.success("Preferences saved"); },
    onError: (e) => toast.error(e.message),
  });

  const [email, setEmail] = useState("");
  const [prefs, setPrefs] = useState<Record<PrefKey, ChannelPref>>({} as any);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (me.data) {
      setEmail(me.data.notifEmail ?? "");
      const loaded = (me.data.notifPrefs ?? {}) as Record<string, ChannelPref>;
      const merged: Record<PrefKey, ChannelPref> = {} as any;
      PREF_ITEMS.forEach(({ key }) => {
        merged[key] = {
          inApp: loaded[key]?.inApp !== false,
          email: loaded[key]?.email !== false,
        };
      });
      setPrefs(merged);
      setDirty(false);
    }
  }, [me.data]);

  const toggle = (key: PrefKey, channel: keyof ChannelPref) => {
    setPrefs((p) => ({ ...p, [key]: { ...p[key], [channel]: !p[key]?.[channel] } }));
    setDirty(true);
  };

  const handleSave = () => {
    update.mutate({ notifEmail: email || undefined, notifPrefs: prefs as any });
    setDirty(false);
  };

  return (
    <Shell title="Notification Preferences">
      <PageHeader title="Notification Preferences" description="Mute any event per channel — bell is the in-app notification, email is its emailed copy. These switches narrow what your workspace has enabled in Settings → Notifications; they cannot switch on an event an admin has turned off." pageKey="notification-prefs"
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
            <div className="flex items-center justify-between px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Each event has two channels — mute either one independently.
              </p>
              <div className="flex items-center gap-6 pr-1 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><Bell className="size-3.5" /> In-app</span>
                <span className="flex items-center gap-1"><Mail className="size-3.5" /> Email</span>
              </div>
            </div>
            {PREF_ITEMS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm">{label}</span>
                <div className="flex items-center gap-8">
                  <Switch
                    aria-label={`${label} — in-app`}
                    checked={prefs[key]?.inApp ?? true}
                    onCheckedChange={() => toggle(key, "inApp")}
                  />
                  <Switch
                    aria-label={`${label} — email`}
                    checked={prefs[key]?.email ?? true}
                    onCheckedChange={() => toggle(key, "email")}
                  />
                </div>
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
