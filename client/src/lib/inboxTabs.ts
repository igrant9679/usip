/**
 * The one reply workspace's tabs (audit 2026-10-20, F25), and how a URL picks
 * one. Inbox, My Mailbox, Unified Inbox and Conversations were four pages; each
 * is now a tab or a view of /v2/inbox, and its old URL redirects to it
 * (lib/retiredRoutes.ts), so the old query strings are read here too:
 *
 *   ?tab=…                      the tab, when named
 *   ?channel=social | calls     the old Conversations channel
 *   ?reply=<id>                 a reply: its thread in the Mailbox tab when the
 *                               tab says mailbox, else the reply itself on the
 *                               Replies tab (Meetings links "the reply that
 *                               booked this" this way)
 *   ?view=chats                 the Social tab's live chats (the old Unified
 *                               Inbox) instead of its classified replies
 */
export const INBOX_TABS = [
  { key: "replies", label: "Replies" },
  { key: "mailbox", label: "Mailbox" },
  { key: "social", label: "LinkedIn & social" },
  { key: "calls", label: "Calls" },
  { key: "notifications", label: "Notifications" },
] as const;

export type InboxTab = (typeof INBOX_TABS)[number]["key"];
export type SocialView = "replies" | "chats";

const isTab = (v: string | null): v is InboxTab => INBOX_TABS.some((t) => t.key === v);

export function inboxStateFrom(search: string): { tab: InboxTab; view: SocialView; replyId: number | null } {
  const q = new URLSearchParams(search.replace(/^\?/, ""));
  const named = q.get("tab");
  const channel = q.get("channel");
  const tab: InboxTab = isTab(named) ? named : channel === "social" ? "social" : channel === "calls" ? "calls" : "replies";
  const reply = q.get("reply");
  return {
    tab,
    view: q.get("view") === "chats" ? "chats" : "replies",
    replyId: reply && /^\d+$/.test(reply) ? Number(reply) : null,
  };
}

/** The URL for a tab (and, on Social, a view). Other state is dropped on purpose: it belonged to the tab being left. */
export function inboxUrl(tab: InboxTab, view?: SocialView): string {
  if (tab === "replies") return "/v2/inbox";
  return `/v2/inbox?tab=${tab}${tab === "social" && view === "chats" ? "&view=chats" : ""}`;
}
