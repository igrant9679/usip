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
  CheckCircle2, XCircle, CalendarClock, Zap, AtSign, ClipboardList, MailOpen, Bot, Sparkles
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
  are_event:        { label: "ARE Agent",      icon: Bot,           color: "text-violet-500" },
};

type FilterKind = "all" | "email_reply" | "are_event" | "mention" | "system";

/** Parse the optional JSON deep-link prefix embedded in mention notification bodies. */
function parseMentionBody(body: string | null | undefined): {
  deepLink: string | null;
  displayBody: string;
} {
  if (!body) return { deepLink: null, displayBody: "" };
  const firstLine = body.split("\n")[0];
  try {
    const meta = JSON.parse(firstLine);
    if (meta.campaignId && meta.prospectId) {
      return {
        deepLink: `/are/campaigns/${meta.campaignId}?prospect=${meta.prospectId}`,
        displayBody: body.slice(firstLine.length + 1),
      };
    }
  } catch {
    /* not a deep-link prefix — fall through */
  }
  return { deepLink: null, displayBody: body };
}

export default function Inbox() {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<FilterKind>("all");
  const { data } = trpc.notifications.list.useQuery();
  const markAll = trpc.notifications.markAllRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });

  const filtered = (data ?? []).filter((n) => {
    if (filter === "all") return true;
    if (filter === "email_reply") return n.kind === "email_reply";
    if (filter === "are_event") return n.kind === "are_event";
    if (filter === "mention") return n.kind === "mention";
    return n.kind !== "email_reply" && n.kind !== "are_event" && n.kind !== "mention";
  });
  const unreadCount = (data ?? []).filter((n) => !n.readAt).length;
  const replyCount = (data ?? []).filter((n) => n.kind === "email_reply" && !n.readAt).length;
  const areCount = (data ?? []).filter((n) => n.kind === "are_event" && !n.readAt).length;
  const mentionCount = (data ?? []).filter((n) => n.kind === "mention" && !n.readAt).length;

  return (
    <Shell title="Inbox">
      <PageHeader title="Inbox" description="Email replies, mentions, AI alerts, churn flags, and workflow events." pageKey="inbox">
        <Button variant="outline" className="bg-card" onClick={() => markAll.mutate()}>
          <CheckCheck className="size-4 mr-2" /> Mark all read
        </Button>
      </PageHeader>
      <div className="p-4 md:p-6 max-w-3xl">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {(["all", "mention", "email_reply", "are_event", "system"] as FilterKind[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
              {f === "all" ? "All" : f === "email_reply" ? "Email Replies" : f === "are_event" ? "ARE Agent" : f === "mention" ? "Mentions" : "Notifications"}
              {f === "all" && unreadCount > 0 && <Badge variant="secondary" className="ml-1.5 h-4 text-[10px]">{unreadCount}</Badge>}
              {f === "email_reply" && replyCount > 0 && <Badge variant="secondary" className="ml-1.5 h-4 text-[10px]">{replyCount}</Badge>}
              {f === "are_event" && areCount > 0 && <Badge variant="secondary" className="ml-1.5 h-4 text-[10px] bg-violet-500/20 text-violet-600">{areCount}</Badge>}
              {f === "mention" && mentionCount > 0 && <Badge variant="secondary" className="ml-1.5 h-4 text-[10px] bg-blue-500/20 text-blue-600">{mentionCount}</Badge>}
            </button>
          ))}
        </div>
        {filtered.length === 0 ? (
          <EmptyState icon={filter === "email_reply" ? MailOpen : filter === "mention" ? AtSign : InboxIcon}
            title={filter === "email_reply" ? "No email replies" : filter === "mention" ? "No mentions" : "Inbox zero"}
            description={
              filter === "email_reply" ? "When contacts reply to your outbound emails, their replies will appear here."
              : filter === "mention" ? "When a teammate @mentions you in a prospect note, it will appear here."
              : "No notifications yet."
            } />
        ) : (
          <ul className="rounded-lg border bg-card divide-y">
            {filtered.map((n) => {
              const kindMeta = KIND_META[n.kind] ?? KIND_META.system;
              const Icon = kindMeta.icon;
              const isEmailReply = n.kind === "email_reply";
              const isMention = n.kind === "mention";
              const isAreEvent = n.kind === "are_event";
              const isUnread = !n.readAt;

              // Parse deep-link for mention notifications
              const { deepLink: mentionDeepLink, displayBody } = isMention
                ? parseMentionBody(n.body)
                : { deepLink: null, displayBody: n.body ?? "" };

              // Deep-link for ARE event notifications with relatedType=are_campaign
              const areDeepLink =
                isAreEvent && n.relatedType === "are_campaign" && n.relatedId
                  ? `/are/campaigns/${n.relatedId}`
                  : null;

              return (
                <li key={n.id} className={cn("p-3 flex items-start gap-3 transition-colors", isUnread && "bg-primary/5")}>
                  <div className={cn("mt-0.5 shrink-0", kindMeta.color)}><Icon className="size-4" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{n.title}</span>
                      <Badge variant="outline" className="text-[10px] h-4 font-normal">{kindMeta.label}</Badge>
                    </div>
                    {displayBody && (
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{displayBody}</div>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-muted-foreground">{fmtDate(n.createdAt)}</span>
                      {isEmailReply && (
                        <Link href="/mailbox" className="text-[11px] text-primary hover:underline flex items-center gap-1">
                          <Mail className="size-3" /> Open in Mailbox
                        </Link>
                      )}
                      {isMention && mentionDeepLink && (
                        <Link href={mentionDeepLink} className="text-[11px] text-violet-600 hover:underline flex items-center gap-1">
                          <AtSign className="size-3" /> View Prospect
                        </Link>
                      )}
                      {isAreEvent && areDeepLink && (
                        <Link href={areDeepLink} className="text-[11px] text-violet-600 hover:underline flex items-center gap-1">
                          <Sparkles className="size-3" /> View Campaign
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
