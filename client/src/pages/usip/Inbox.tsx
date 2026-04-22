import { Button } from "@/components/ui/button";
import { fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { CheckCheck, Inbox as InboxIcon } from "lucide-react";

export default function Inbox() {
  const utils = trpc.useUtils();
  const { data } = trpc.notifications.list.useQuery();
  const markAll = trpc.notifications.markAllRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  return (
    <Shell title="Inbox">
      <PageHeader title="Inbox" description="Mentions, AI alerts, churn flags, and workflow events.">
        <Button variant="outline" className="bg-card" onClick={() => markAll.mutate()}><CheckCheck className="size-4" /> Mark all read</Button>
      </PageHeader>
      <div className="p-6">
        {(data ?? []).length === 0 ? <EmptyState icon={InboxIcon} title="Inbox zero" description="No notifications." /> : (
          <ul className="rounded-lg border bg-card divide-y">
            {data!.map((n) => (
              <li key={n.id} className={`p-3 flex items-start gap-3 ${!n.readAt ? "bg-primary/5" : ""}`}>
                <div className="mt-1 size-2 rounded-full" style={{ background: n.readAt ? "transparent" : "var(--color-primary)" }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{n.title}</div>
                  <div className="text-xs text-muted-foreground">{n.body}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">{fmtDate(n.createdAt)}</div>
                </div>
                {!n.readAt && <Button size="sm" variant="ghost" onClick={() => markRead.mutate({ id: n.id })}>Read</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}
