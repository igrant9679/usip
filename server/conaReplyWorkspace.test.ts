/**
 * F25 (audit 2026-10-20): one reply workspace replacing Inbox, My Mailbox,
 * Unified Inbox and Conversations.
 *
 *   /v2/inbox is one lazy page whose tabs are the four old pages' own
 *   components · each old URL redirects to its tab, its query string carried ·
 *   the rail, the bell, help and every in-app link point at it · replies show
 *   their sequence or campaign, their next action and their read state, and
 *   "Mine" narrows them on the server · a reply opens its thread in the Mailbox
 *   tab, where Reply, Reply all and Forward are · the page adds no send path ·
 *   the sending status bar is on it.
 *
 * Procedures run for real against the SQL-evaluating fake; screens are pinned
 * by slicing their source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { RETIRED_ROUTES, retiredRedirectUrl, type RetiredRoute } from "../client/src/lib/retiredRoutes";
import { INBOX_TABS, inboxStateFrom, inboxUrl } from "../client/src/lib/inboxTabs";
import { nextActionFor } from "../client/src/lib/replyNextAction";

const WS = 2, OTHER = 9, ME = 1, TEAMMATE = 5;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
function between(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  expect(i, `anchor "${from}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(to, i + from.length);
  expect(j, `anchor "${to}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}
function caller(userId = ME) {
  return appRouter.createCaller({
    user: { id: userId, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

const APP = read("client/src/App.tsx");
const PAGE = read("client/src/pages/usip/InboxWorkspace.tsx");
const CONV = read("client/src/pages/usip/ConversationsV2.tsx");

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  const at = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
  rows("email_drafts").push(
    { id: 70, workspaceId: WS, sequenceId: 31, status: "sent" },
    { id: 71, workspaceId: WS, sequenceId: null, status: "sent" },
    // Another workspace's draft with the id one of our replies names: must not lend its sequence.
    { id: 72, workspaceId: OTHER, sequenceId: 99, status: "sent" },
  );
  rows("email_replies").push(
    { id: 1, workspaceId: WS, userId: ME, sendingAccountId: 1, fromEmail: "a@x.example", draftId: 70, campaignId: null, receivedAt: at(1), readAt: null },
    { id: 2, workspaceId: WS, userId: TEAMMATE, sendingAccountId: 2, fromEmail: "b@x.example", draftId: 71, campaignId: null, receivedAt: at(2), readAt: at(3) },
    { id: 3, workspaceId: WS, userId: ME, sendingAccountId: 1, fromEmail: "c@x.example", draftId: null, campaignId: 40, receivedAt: at(4), readAt: null },
    { id: 4, workspaceId: WS, userId: ME, sendingAccountId: 1, fromEmail: "d@x.example", draftId: 72, campaignId: null, receivedAt: at(5), readAt: at(5) },
    // Private mail: not a reply to our outreach, never listed.
    { id: 5, workspaceId: WS, userId: ME, sendingAccountId: 1, fromEmail: "e@x.example", draftId: null, campaignId: null, receivedAt: at(6), readAt: null },
    { id: 6, workspaceId: OTHER, userId: ME, sendingAccountId: 9, fromEmail: "f@x.example", draftId: 72, campaignId: null, receivedAt: at(7), readAt: null },
  );
});

/* ── The replies the Replies tab lists ──────────────────────────────────────── */

describe("Replies: their sequence, read state and owner, on the server", () => {
  it("each reply names the sequence its draft came from, in this workspace only", async () => {
    const list = await caller().conversations.list({ filter: "all" });
    const byId = new Map(list.map((r: any) => [r.id, r]));
    expect(list.map((r: any) => r.id)).toEqual([4, 3, 2, 1]); // newest first, genuine and ours only
    expect((byId.get(1) as any).sequenceId).toBe(31);
    expect((byId.get(2) as any).sequenceId).toBeNull(); // a draft outside any sequence
    expect((byId.get(3) as any).sequenceId).toBeNull(); // a campaign reply
    expect((byId.get(4) as any).sequenceId).toBeNull(); // the matching draft id is another workspace's
  });

  it("Mine is the replies that came into my own mailbox", async () => {
    expect((await caller(ME).conversations.list({ filter: "all", mine: true })).map((r: any) => r.id)).toEqual([4, 3, 1]);
    expect((await caller(TEAMMATE).conversations.list({ filter: "all", mine: true })).map((r: any) => r.id)).toEqual([2]);
  });

  it("Unread and Mine combine", async () => {
    expect((await caller(ME).conversations.list({ filter: "all", mine: true, unreadOnly: true })).map((r: any) => r.id)).toEqual([3, 1]);
  });

  it("opening marks read and Mark unread puts it back, on the one row", async () => {
    await caller().conversations.markRead({ id: 1, read: true });
    expect(rows("email_replies").find((r) => r.id === 1).readAt).toBeInstanceOf(Date);
    await caller().conversations.markRead({ id: 1, read: false });
    expect(rows("email_replies").find((r) => r.id === 1).readAt).toBeNull();
    // Another workspace's reply with an id is out of reach.
    await caller().conversations.markRead({ id: 6, read: true });
    expect(rows("email_replies").find((r) => r.id === 6).readAt).toBeNull();
  });

  it("social Mine is messages to my own connected accounts, and nothing when I have none", async () => {
    expect(await caller(ME).conversations.socialList({ filter: "all", mine: true })).toEqual([]);
    const src = read("server/routers/conversations.ts");
    const mine = between(src, "if (input?.mine) {", "return db.select().from(unipileMessages)");
    expect(mine).toContain("eq(unipileAccounts.workspaceId, ctx.workspace.id), eq(unipileAccounts.userId, ctx.user.id)");
    expect(mine).toContain("inArray(unipileMessages.unipileAccountId, own.map((a) => a.id))");
  });
});

/* ── The page ───────────────────────────────────────────────────────────────── */

describe("one page, whose tabs are the old pages' own components", () => {
  it("is a lazy route at /v2/inbox", () => {
    expect(APP).toContain('const InboxWorkspace = lazyChunk(() => import("@/pages/usip/InboxWorkspace"));');
    expect(APP).toContain('<Route path="/v2/inbox"><AuthGate><InboxWorkspace /></AuthGate></Route>');
    expect(APP).not.toMatch(/^import InboxWorkspace/m);
  });

  it("renders each old page's component, not a copy", () => {
    expect(PAGE).toContain('import { ConversationsPanel } from "@/pages/usip/ConversationsV2";');
    expect(PAGE).toContain('import { MailboxPanel } from "@/pages/usip/Mailbox";');
    expect(PAGE).toContain('import { SocialChatsPanel } from "@/pages/usip/UnifiedInbox";');
    expect(PAGE).toContain('import { NotificationsPanel } from "@/pages/usip/Inbox";');
    expect(PAGE).toContain('<ConversationsPanel channel="email" openReplyId={replyId} />');
    expect(PAGE).toContain('<MailboxPanel className="flex-1 min-h-0" />');
    expect(PAGE).toContain('<SocialChatsPanel className="flex-1 min-h-0 mt-2 border-t" />');
    expect(PAGE).toContain('<ConversationsPanel key="social" channel="social" />');
    expect(PAGE).toContain('<ConversationsPanel key="calls" channel="calls" />');
    expect(PAGE).toContain("<NotificationsPanel />");
    // And the old pages render those same components, so there is one of each.
    expect(read("client/src/pages/usip/Mailbox.tsx")).toContain('<MailboxPanel className="h-[calc(100vh-8.5rem)]" />');
    expect(read("client/src/pages/usip/UnifiedInbox.tsx")).toContain('<SocialChatsPanel className="h-[calc(100vh-140px)]" />');
    expect(read("client/src/pages/usip/Inbox.tsx")).toContain("<NotificationsPanel />");
    expect(CONV).toContain("<ConversationsPanel key={channel} channel={channel} />");
  });

  it("adds no send path: no mutation of its own, and it never calls a send", () => {
    expect(PAGE).not.toMatch(/useMutation/);
    expect(PAGE).not.toMatch(/sendReply|sendNew|sendMessage|deliver/);
  });

  it("shows the sending status bar: the mailbox's holds, or LinkedIn's on the Social tab", () => {
    expect(PAGE).toContain('import { SendingStatusBar } from "@/components/usip/SendingStatusBar";');
    expect(PAGE).toContain('{tab === "social" ? <SendingStatusBar surface="social" className="shrink-0" /> : <SendingStatusBar surface="mailbox" className="shrink-0" />}');
  });

  it("has the five tabs, as a keyboard tab strip, kept in the URL", () => {
    expect(INBOX_TABS.map((t) => t.key)).toEqual(["replies", "mailbox", "social", "calls", "notifications"]);
    expect(PAGE).toContain('{...tablistProps("Inbox sections")}');
    expect(PAGE).toContain("{...tabProps(tab === t.key)}");
    expect(PAGE).toContain("setLocation(inboxUrl(t, v), { replace: true })");
    expect(inboxUrl("replies")).toBe("/v2/inbox");
    expect(inboxUrl("mailbox")).toBe("/v2/inbox?tab=mailbox");
    expect(inboxUrl("social", "chats")).toBe("/v2/inbox?tab=social&view=chats");
    expect(inboxUrl("social")).toBe("/v2/inbox?tab=social");
  });
});

/* ── The old URLs ───────────────────────────────────────────────────────────── */

describe("each old route redirects to the matching tab, bookmarks included", () => {
  const land = (from: RetiredRoute, search = "") => {
    const url = retiredRedirectUrl(from, { search });
    const [path, query = ""] = url.split("?");
    return { path, ...inboxStateFrom(query) };
  };

  it("the four routes render the redirect", () => {
    for (const path of ["/inbox", "/mailbox", "/unified-inbox", "/v2/conversations"] as const) {
      expect(APP).toContain(`<Route path="${path}"><AuthGate><RetiredRedirect from="${path}" /></AuthGate></Route>`);
      expect(RETIRED_ROUTES[path].startsWith("/v2/inbox")).toBe(true);
    }
  });

  it("Inbox lands on Notifications, Mailbox on Mailbox, Unified Inbox on the live chats, Conversations on Replies", () => {
    expect(land("/inbox")).toMatchObject({ path: "/v2/inbox", tab: "notifications" });
    expect(land("/mailbox")).toMatchObject({ path: "/v2/inbox", tab: "mailbox" });
    expect(land("/unified-inbox")).toMatchObject({ path: "/v2/inbox", tab: "social", view: "chats" });
    expect(land("/v2/conversations")).toMatchObject({ path: "/v2/inbox", tab: "replies" });
  });

  it("the old query strings still mean what they meant", () => {
    // A notification's "Open in Mailbox" link: that reply's thread.
    expect(retiredRedirectUrl("/mailbox", { search: "?reply=12" })).toBe("/v2/inbox?tab=mailbox&reply=12");
    expect(land("/mailbox", "?reply=12")).toMatchObject({ tab: "mailbox", replyId: 12 });
    // Home's social card and the calls channel.
    expect(land("/v2/conversations", "?channel=social")).toMatchObject({ tab: "social", view: "replies" });
    expect(land("/v2/conversations", "?channel=calls")).toMatchObject({ tab: "calls" });
    // Meetings' "the reply that booked this": the reply itself, on Replies.
    expect(land("/v2/conversations", "?reply=5")).toMatchObject({ tab: "replies", replyId: 5 });
    // The target's own tab wins over an old parameter of the same name.
    expect(retiredRedirectUrl("/inbox", { search: "?tab=mailbox" })).toBe("/v2/inbox?tab=notifications");
    // Junk is ignored, not obeyed.
    expect(inboxStateFrom("?tab=nope&reply=abc")).toEqual({ tab: "replies", view: "replies", replyId: null });
  });

  it("a ?reply= on the Replies tab opens that reply once it loads", () => {
    expect(CONV).toContain("const linkedQ = trpc.conversations.get.useQuery({ id: openReplyId ?? 0 }, { enabled: isEmail && !!openReplyId });");
    expect(CONV).toContain("open(linkedQ.data as Reply);");
    // And the mailbox still reads its own ?reply= the way it always did.
    expect(read("client/src/pages/usip/Mailbox.tsx")).toContain('const v = new URLSearchParams(window.location.search).get("reply");');
  });
});

/* ── What the Replies and Social tabs show ──────────────────────────────────── */

describe("replies with their classification, next action and read state", () => {
  const panel = between(CONV, "export function ConversationsPanel(", "export function VoiceCallsChannel(");

  it("the list asks the server for Unread and Mine", () => {
    expect(panel).toContain("const listInput = { filter: filter as any, ...(unreadOnly ? { unreadOnly: true } : {}), ...(mine ? { mine: true } : {}) };");
    expect(panel).toContain("trpc.conversations.list.useQuery(listInput, { enabled: isEmail })");
    expect(panel).toContain("trpc.conversations.socialList.useQuery(listInput, { enabled: channel === \"social\" })");
    expect(panel).toContain("aria-pressed={unreadOnly}");
    expect(panel).toContain("aria-pressed={mine}");
  });

  it("opening reads it, and Mark unread is offered in both dialogs", () => {
    expect(panel).toContain("if (!r.readAt) setRead(r, true);");
    expect(panel).toContain("const setRead = (r: Reply, read: boolean) => (isEmail ? markRead : markSocialRead).mutate({ id: r.id, read });");
    expect(CONV).toContain('{onMarkUnread && <Button variant="ghost" onClick={() => onMarkUnread(reply)}>Mark unread</Button>}');
    expect(CONV.split("onMarkUnread={(r) => { setRead(r, false); setSelected(null); }}").length - 1).toBe(2);
  });

  it("each row names its sequence or campaign and the next thing to do", () => {
    expect(panel).toContain("Revenue Engine</span>");
    expect(panel).toContain('Sequence{seqName ? `: ${seqName}` : ""}');
    expect(panel).toContain("<span>Next: {nextActionFor(r)}</span>");
  });

  it("an email reply opens its thread in the Mailbox tab, where Reply, Reply all and Forward are", () => {
    const dialog = between(CONV, "function ReplyDialog(", "\n}\n");
    expect(dialog).toContain("href={`/v2/inbox?tab=mailbox&reply=${reply.id}`}");
    const view = read("client/src/pages/usip/Mailbox.tsx");
    expect(view).toContain('aria-label="Reply all"');
    expect(view).toContain('mode: "forward"');
  });
});

describe("the next action for a reply", () => {
  const base = { classifiedAt: new Date(), handledAt: null, autoActionTaken: null };

  it("says what Apply action does for each class", () => {
    expect(nextActionFor({ ...base, replyClass: "willing_to_meet" })).toBe("Propose a meeting");
    expect(nextActionFor({ ...base, replyClass: "follow_up_question" })).toBe("Answer their question");
    expect(nextActionFor({ ...base, replyClass: "unsubscribe" })).toBe("Suppress their address");
    expect(nextActionFor({ ...base, replyClass: "out_of_office" })).toBe("Resume when they're back");
    expect(nextActionFor({ ...base, replyClass: "something_new" })).toBe("Read and decide");
  });

  it("an unclassified reply needs classifying, a handled one is done, and an action the AI took is named", () => {
    expect(nextActionFor({ ...base, classifiedAt: null, replyClass: null })).toBe("Classify it");
    expect(nextActionFor({ ...base, replyClass: "willing_to_meet", handledAt: new Date() })).toBe("Handled");
    expect(nextActionFor({ ...base, replyClass: "willing_to_meet", autoActionTaken: "meeting_proposed" })).toBe("Done: meeting proposed");
    expect(nextActionFor({ ...base, replyClass: "not_interested", autoActionTaken: "none" })).toBe("Mark not interested");
  });
});

/* ── Navigation and help ────────────────────────────────────────────────────── */

describe("the nav entries move to the one page", () => {
  const OLD = ["/inbox", "/mailbox", "/unified-inbox", "/v2/conversations"];

  it("the registry and the rail have one Inbox, and none of the four", () => {
    const reg = read("client/src/lib/toolRegistry.ts");
    expect(reg).toContain('{ href: "/v2/inbox", label: "Inbox", icon: Inbox, group: "Daily", primary: true,');
    const shell = read("client/src/components/usip/Shell.tsx");
    expect(shell).toContain('{ href: "/v2/inbox", label: "Inbox", icon: Inbox, color: "#1D4ED8", darkColor: "#93C5FD" },');
    expect(shell).toContain('<Link href="/v2/inbox?tab=notifications" className="relative p-2 rounded-md hover:bg-secondary" title="Notifications" aria-label="Notifications">');
    for (const f of ["client/src/lib/toolRegistry.ts", "client/src/components/usip/Shell.tsx", "client/src/lib/helpText.ts", "client/src/components/usip/Elsie.tsx"]) {
      const src = read(f);
      for (const p of OLD) expect(src, `${f} → ${p}`).not.toContain(`"${p}"`);
    }
    expect(read("client/src/lib/helpText.ts")).toContain('"/v2/inbox": {');
    expect(read("client/src/components/usip/Elsie.tsx")).toContain('["/v2/inbox", "inbox"],');
  });

  it("no in-app link still points at an old page", () => {
    const files = [
      "client/src/components/usip/AttentionPanel.tsx", "client/src/components/usip/settings/SocialAccountsSection.tsx",
      "client/src/pages/usip/AREHub.tsx", "client/src/pages/usip/Dashboard.tsx", "client/src/pages/usip/Home.tsx",
      "client/src/pages/usip/MeetingsV2.tsx", "client/src/pages/usip/WorkflowsV2.tsx", "client/src/pages/usip/Inbox.tsx",
      "client/src/pages/usip/ConversationsV2.tsx", "client/src/pages/usip/InboxWorkspace.tsx",
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/["'`(]\/(inbox|mailbox|unified-inbox|v2\/conversations)(["'`?#)]|$)/m);
    }
  });

  it("help, tours, the manual and the assistant digest name the one Inbox", () => {
    const help = read("server/seedHelpContent.ts");
    for (const p of OLD) {
      expect(help, p).not.toContain(`"${p}"`);
      expect(help, p).not.toContain(`(${p})`);
    }
    expect(help).toContain('routeTo: "/v2/inbox?tab=mailbox"');
    expect(help).toContain('routeTo: "/v2/inbox?tab=social&view=chats"');
    const manual = read("server/seedHelpOperatorManual.ts");
    expect(manual).toContain("**Inbox** (/v2/inbox)");
    for (const p of OLD) expect(manual, p).not.toContain(`(${p})`);
    const digest = read("server/productKnowledge.ts");
    expect(digest).toContain("Inbox /v2/inbox (Replies; ?tab= mailbox, social, calls, notifications)");
    expect(digest).not.toContain("Unified Inbox /unified-inbox");
  });
});
