import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import {
  CheckCheck, Inbox as InboxIcon, Mail, Bell, AlertTriangle,
  CheckCircle2, XCircle, CalendarClock, Zap, AtSign, ClipboardList, MailOpen
} from "lucide-react";

const KIND_META: Record<string, { label: string; icon: any; color: string }> = {
  mention:          { label: "Mention",        icon: AtSign,        color: "text-blue-500" },
  task_assigned:    { label: "Task",           icon: ClipboardList, color: "text-purple-500" },
  task_due:         { label: "Task Due",       icon: ClipboardList, color: "text-amber-500" },
  deal_won:         { label: "Deal Won",       icon: CheckCircle2,  color: "text-emerald-500" },
  deal_lost:        { label: "Deal Lost",      icon: XCircle,       color: "text-rose-500" },
  renewal_due:      { label: "Renewal Due",    icon: CalendarClock, color: "text-amber-500" },
  churn_risk:       { label: "Churn Risk",     icon: AlertTriangle, color: "text-rose-500" },
  approval_request: { label: "Approval",       icon: Bell,          color: "text-blue-500" },
  workflow_fired:   { label: "Workflow",       icon: Zap,           color: "text-violet-500" },
  system:           { label: "System",         icon: Bell,          color: "text-muted-foreground" },
  email_reply:      { label: "Email Reply",    icon: MailOpen,      color: "text-sky-500" },
};

type FilterKind = "all" | "email_reply" | "system";

export default function Inbox() {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<FilterKind>("all");
  const { data } = trpc.notifications.list.useQuery();
  const markAll = trpc.notifications.markAllRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });

  const filtered = (data ?? []).filter((n) => {
    if (filter === "all") return true;
    if (filter === "email_reply") return n.kind === "email_reply";
    return n.kind !== "email_reply";
  });
  const unreadCount = (data ?? []).filter((n) => !n.readAt).length;
  const replyCount = (data ?? []).filter((n) => n.kind === "email_reply" && !n.readAt).length;

  return (
    <Shell title="Inbox">
      <PageHeader title="Inbox" description="Email replies, mentions, AI alerts, churn flags, and workflow events.">
        <Button variant="outline" className="bg-card" onClick={() => markAll.mutate()}>
          <CheckCheck className="size-4 mr-2" /> Mark all read
        </Button>
      </PageHeader>
      <div className="p-4 md:p-6 max-w-3xl">
        <div className="flex items-center gap-2 mb-4">
          {(["all", "email_reply", "system"] as FilterKind[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
              {f === "all" ? "All" : f === "email_reply" ? "Email Replies" : "Notifications"}
              {f === "all" && unreadCount > 0 && <Badge variant="secondary" className="ml-1.5 h-4 text-[10px]">{unreadCount}</Badge>}
              {f === "email_reply" && replyCount > 0 && <Badge variant="secondary" className="ml-1.5 h-4 text-[10px]">{replyCount}</Badge>}
            </button>
          ))}
        </div>
        {filtered.length === 0 ? (
          <EmptyState icon={filter === "email_reply" ? MailOpen : InboxIcon}
            title={filter === "email_reply" ? "No email replies" : "Inbox zero"}
            description={filter === "email_reply" ? "When contacts reply to your outbound emails, their replies will appear here." : "No notifications yet."} />
        ) : (
          <ul className="rounded-lg border bg-card divide-y">
            {filtered.map((n) => {
              const meta = KIND_META[n.kind] ?? KIND_META.system;
              const Icon = meta.icon;
              const isEmailReply = n.kind === "email_reply";
              const isUnread = !n.readAt;
              return (
                <li key={n.id} className={cn("p-3 flex items-start gap-3 transition-colors", isUnread && "bg-primary/5")}>
                  <div className={cn("mt-0.5 shrink-0", meta.color)}><Icon className="size-4" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{n.title}</span>
                      <Badge variant="outline" className="text-[10px] h-4 font-normal">{meta.label}</Badge>
                    </div>
                    {n.body && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</div>}
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-muted-foreground">{fmtDate(n.createdAt)}</span>
                      {isEmailReply && (
                        <Link href="/mailbox" className="text-[11px] text-primary hover:underline flex items-center gap-1">
                          <Mail className="size-3" /> Open in Mailbox
                        </Link>
                      )}
                    </div>
                  </div>
                  {isUnread && (
                    <div className="flex items-center gap-1 shrink-0">
                      <div className="size-2 rounded-full bg-primary" />
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => markRead.mutate({ id: n.id })}>Read</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Shell>
  );
}
