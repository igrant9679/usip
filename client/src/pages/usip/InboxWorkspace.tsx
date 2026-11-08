/**
 * Inbox — the one reply workspace (/v2/inbox), audit 2026-10-20, F25.
 *
 * Four pages answered "what came back": Inbox (notifications), My Mailbox
 * (the connected mailbox), Unified Inbox (live LinkedIn and social chats) and
 * Conversations (classified replies, social replies and the voice agents'
 * calls). They are tabs of this page now, and each old URL redirects to its
 * tab (lib/retiredRoutes.ts):
 *
 *   Replies        genuine replies to sequences and Revenue Engine campaigns,
 *                  with their classification and next action, read state and
 *                  a "Mine" filter; a reply opens its thread in Mailbox
 *   Mailbox        the mailbox: threads, Reply, Reply all, Forward, Compose
 *   LinkedIn & social   classified social replies, and the live chats
 *   Calls          the voice agents' calls
 *   Notifications  mentions, tasks, approvals and engine events
 *
 * Every tab is the old page's own component (ConversationsPanel,
 * MailboxPanel, SocialChatsPanel, VoiceCallsChannel, NotificationsPanel), so
 * there is one implementation of reading and sending mail, and replying keeps
 * the mailbox's own pause, suppression and claim checks. This page adds none.
 */
import { Link, useLocation, useSearch } from "wouter";
import { Inbox as InboxIcon, FileText, Plug } from "lucide-react";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { SendingStatusBar } from "@/components/usip/SendingStatusBar";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { tablistProps, tabProps } from "@/lib/tabs";
import { INBOX_TABS, inboxStateFrom, inboxUrl, type InboxTab } from "@/lib/inboxTabs";
import { ConversationsPanel } from "@/pages/usip/ConversationsV2";
import { MailboxPanel } from "@/pages/usip/Mailbox";
import { SocialChatsPanel } from "@/pages/usip/UnifiedInbox";
import { NotificationsPanel } from "@/pages/usip/Inbox";

export default function InboxWorkspace() {
  const accent = useAccentColor();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { tab, view, replyId } = inboxStateFrom(search);
  const go = (t: InboxTab, v?: "replies" | "chats") => setLocation(inboxUrl(t, v), { replace: true });

  // The counts on the tabs, from the reads those tabs already make.
  const replyStats = trpc.conversations.stats.useQuery();
  const notifications = trpc.notifications.list.useQuery();
  const badge: Partial<Record<InboxTab, number>> = {
    replies: Number(replyStats.data?.unhandled ?? 0),
    notifications: ((notifications.data ?? []) as Array<{ readAt?: unknown }>).filter((n) => !n.readAt).length,
  };

  return (
    <Shell title="Inbox">
      <div className="flex flex-col h-full min-h-0">
        {/* What is holding sends right now, if anything (audit 2026-10-20, U1): the mailbox's holds, or LinkedIn's on the Social tab. */}
        {tab === "social" ? <SendingStatusBar surface="social" className="shrink-0" /> : <SendingStatusBar surface="mailbox" className="shrink-0" />}
        <div data-tour-id="page-inbox" className="relative shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 min-h-11 py-1.5 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <InboxIcon className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Inbox</h1>
          <div {...tablistProps("Inbox sections")} className="ml-2 flex flex-wrap items-center gap-0.5">
            {INBOX_TABS.map((t) => (
              <button
                {...tabProps(tab === t.key)}
                key={t.key}
                onClick={() => go(t.key)}
                className={cn("h-7 rounded-md px-2.5 text-[12.5px] font-medium inline-flex items-center gap-1.5", tab === t.key ? "text-white" : "text-muted-foreground hover:text-foreground hover:bg-muted/60")}
                style={tab === t.key ? { backgroundColor: accent } : undefined}
              >
                {t.label}
                {(badge[t.key] ?? 0) > 0 && (
                  <span className={cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums", tab === t.key ? "bg-white/25" : "bg-muted text-foreground")}>{badge[t.key]}</span>
                )}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <Link href="/v2/emails?status=awaiting&source=sequence" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" title="Drafts waiting for review">
            <FileText className="size-3.5" /> Drafts
          </Link>
          <Link href="/connected-accounts" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" title="Connect a mailbox or LinkedIn">
            <Plug className="size-3.5" /> Accounts
          </Link>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          {tab === "replies" && (
            <div data-tour-id="conversations-list" className="flex-1 min-h-0 flex flex-col">
              <ConversationsPanel channel="email" openReplyId={replyId} />
            </div>
          )}
          {tab === "social" && (
            <>
              <div className="shrink-0 px-4 md:px-6 pt-3 flex items-center gap-2">
                <div role="radiogroup" aria-label="Social view" className="inline-flex rounded-md border bg-card p-0.5">
                  {(["replies", "chats"] as const).map((v) => (
                    <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => go("social", v)}
                      className={cn("h-6 px-2.5 rounded text-[12px] font-medium", view === v ? "text-white" : "text-muted-foreground hover:text-foreground")}
                      style={view === v ? { backgroundColor: accent } : undefined}>
                      {v === "replies" ? "Replies to our outreach" : "All chats"}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {view === "replies" ? "Classified, with what to do next." : "Live from your connected LinkedIn, WhatsApp and other accounts; read and reply here."}
                </span>
              </div>
              {view === "chats" ? <SocialChatsPanel className="flex-1 min-h-0 mt-2 border-t" /> : <ConversationsPanel key="social" channel="social" />}
            </>
          )}
          {tab === "mailbox" && <div data-tour-id="page-mailbox" className="flex-1 min-h-0 flex flex-col"><MailboxPanel className="flex-1 min-h-0" /></div>}
          {tab === "calls" && <ConversationsPanel key="calls" channel="calls" />}
          {tab === "notifications" && <div className="flex-1 min-h-0 overflow-auto"><NotificationsPanel /></div>}
        </div>
      </div>
    </Shell>
  );
}
