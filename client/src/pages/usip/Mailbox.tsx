/**
 * Mailbox.tsx — Rep Mailbox UI (Feature 73)
 *
 * Layout:
 *   Left panel (280px): Account selector + folder list
 *   Center panel (flex): Thread list
 *   Right panel (flex): Thread view + inline reply composer
 *
 * Manager access: managers can select a rep from a dropdown to view their mailbox.
 */

import { useState, useRef, useEffect } from "react";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Mail, MailOpen, RefreshCw, Trash2, Reply, Send, Pencil,
  ChevronLeft, Inbox, Star, AlertCircle, Loader2, Users
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmailThread {
  id: string;
  subject: string;
  snippet: string;
  from: string;
  fromName: string;
  date: Date;
  unread: boolean;
  hasAttachments: boolean;
  messageCount: number;
}

interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string;
  cc?: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  date: Date;
  unread: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

// ─── Compose Dialog ────────────────────────────────────────────────────────────

function ComposeDialog({
  open, onClose, accountId, replyTo
}: {
  open: boolean;
  onClose: () => void;
  accountId: number;
  replyTo?: { to: string; subject: string; threadId: string; inReplyTo?: string; references?: string };
}) {
  const [to, setTo] = useState(replyTo?.to ?? "");
  const [subject, setSubject] = useState(replyTo ? `Re: ${replyTo.subject.replace(/^Re:\s*/i, "")}` : "");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");

  const sendNew = trpc.mailbox.sendNew.useMutation({
    onSuccess: () => { toast.success("Email sent"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const sendReply = trpc.mailbox.sendReply.useMutation({
    onSuccess: () => { toast.success("Reply sent"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const isLoading = sendNew.isPending || sendReply.isPending;

  function handleSend() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("To, Subject, and Body are required");
      return;
    }
    if (replyTo) {
      sendReply.mutate({
        accountId, threadId: replyTo.threadId,
        to, subject, bodyHtml: `<p>${body.replace(/\n/g, "<br>")}</p>`,
        bodyText: body, cc: cc || undefined,
        inReplyTo: replyTo.inReplyTo, references: replyTo.references,
      });
    } else {
      sendNew.mutate({
        accountId, to, subject,
        bodyHtml: `<p>${body.replace(/\n/g, "<br>")}</p>`,
        bodyText: body, cc: cc || undefined,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{replyTo ? "Reply" : "New Email"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-[60px_1fr] items-center gap-2">
            <Label>To</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" />
          </div>
          <div className="grid grid-cols-[60px_1fr] items-center gap-2">
            <Label>CC</Label>
            <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Optional" />
          </div>
          <div className="grid grid-cols-[60px_1fr] items-center gap-2">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
            className="min-h-[200px] font-mono text-sm"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSend} disabled={isLoading}>
            {isLoading ? <Loader2 className="size-4 animate-spin mr-2" /> : <Send className="size-4 mr-2" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Thread View ───────────────────────────────────────────────────────────────

function ThreadView({
  accountId, threadId, onBack, onReply
}: {
  accountId: number;
  threadId: string;
  onBack: () => void;
  onReply: (msg: EmailMessage) => void;
}) {
  const { data, isLoading } = trpc.mailbox.getThread.useQuery({ accountId, threadId });
  const markRead = trpc.mailbox.markRead.useMutation();
  const moveToTrash = trpc.mailbox.moveToTrash.useMutation({
    onSuccess: () => { toast.success("Moved to trash"); onBack(); },
  });

  useEffect(() => {
    if (data?.messages?.length) {
      const unread = data.messages.filter((m: EmailMessage) => m.unread);
      unread.forEach((m: EmailMessage) => markRead.mutate({ accountId, messageId: m.id, read: true }));
    }
  }, [data]);

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );

  if (!data?.messages?.length) return (
    <EmptyState icon={MailOpen} title="Thread not found" description="This thread may have been deleted or moved." />
  );

  const messages: EmailMessage[] = data.messages;
  const lastMsg = messages[messages.length - 1];

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="px-4 py-3 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="md:hidden">
          <ChevronLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{messages[0]?.subject}</h2>
          <p className="text-xs text-muted-foreground">{messages.length} message{messages.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" title="Reply" onClick={() => onReply(lastMsg)}>
            <Reply className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="Move to trash"
            onClick={() => moveToTrash.mutate({ accountId, messageId: lastMsg.id })}>
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg: EmailMessage) => (
          <div key={msg.id} className="border rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-muted/40 flex items-start justify-between gap-2">
              <div>
                <span className="font-medium text-sm">{msg.fromName || msg.from}</span>
                {msg.fromName && <span className="text-xs text-muted-foreground ml-1">&lt;{msg.from}&gt;</span>}
                {msg.to && <div className="text-xs text-muted-foreground">To: {msg.to}</div>}
                {msg.cc && <div className="text-xs text-muted-foreground">CC: {msg.cc}</div>}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(msg.date).toLocaleString()}
              </span>
            </div>
            <div className="p-4">
              {msg.bodyHtml ? (
                <div
                  className="prose prose-sm max-w-none text-foreground"
                  dangerouslySetInnerHTML={{ __html: msg.bodyHtml }}
                />
              ) : (
                <pre className="text-sm whitespace-pre-wrap font-sans">{msg.bodyText}</pre>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Thread List ───────────────────────────────────────────────────────────────

function ThreadList({
  accountId, folder, selectedId, onSelect
}: {
  accountId: number;
  folder: string;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [pageToken, setPageToken] = useState<string | undefined>();
  const { data, isLoading, refetch } = trpc.mailbox.listThreads.useQuery(
    { accountId, folder, pageToken, maxResults: 50 },
    { enabled: !!accountId }
  );

  const threads: EmailThread[] = data?.threads ?? [];

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center py-12">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );

  if (!threads.length) return (
    <EmptyState icon={MailOpen} title="No messages" description={`${folder} is empty.`} />
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{threads.length} threads</span>
        <Button variant="ghost" size="icon" onClick={() => refetch()} title="Refresh">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto divide-y">
        {threads.map((t: EmailThread) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              "w-full text-left px-3 py-3 hover:bg-muted/50 transition-colors",
              selectedId === t.id && "bg-muted",
              t.unread && "font-semibold"
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="text-sm truncate">{t.fromName || t.from}</span>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                {new Date(t.date).toLocaleDateString()}
              </span>
            </div>
            <div className="text-sm truncate">{t.subject}</div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">{t.snippet}</div>
            {t.messageCount > 1 && (
              <Badge variant="secondary" className="mt-1 text-[10px] h-4">{t.messageCount}</Badge>
            )}
          </button>
        ))}
      </div>
      {data?.nextPageToken && (
        <div className="p-2 border-t">
          <Button variant="outline" size="sm" className="w-full" onClick={() => setPageToken(data.nextPageToken)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function MailboxPage() {
  const { user } = useAuth();
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyData, setReplyData] = useState<any>(undefined);
  const [repUserId, setRepUserId] = useState<number | undefined>();

  const { data: accounts, isLoading: accountsLoading } = trpc.mailbox.listAccounts.useQuery(
    { repUserId },
    { enabled: true }
  );
  const { data: folders } = trpc.mailbox.listFolders.useQuery(
    { accountId: selectedAccountId!, repUserId },
    { enabled: !!selectedAccountId }
  );
  const { data: teamData } = trpc.team.list.useQuery(undefined, { enabled: true });

  // Auto-select first account
  useEffect(() => {
    if (accounts?.length && !selectedAccountId) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts]);

  const isManager = (user as any)?.role === "manager" || (user as any)?.role === "admin" || (user as any)?.role === "super_admin";

  const folderList = folders?.length
    ? folders
    : [
        { name: "INBOX", label: "Inbox" },
        { name: "SENT", label: "Sent" },
        { name: "DRAFTS", label: "Drafts" },
        { name: "TRASH", label: "Trash" },
        { name: "SPAM", label: "Spam" },
      ];

  function handleReply(msg: any) {
    setReplyData({
      to: msg.from,
      subject: msg.subject,
      threadId: msg.threadId,
      inReplyTo: msg.messageId,
      references: msg.references,
    });
    setComposeOpen(true);
  }

  return (
    <Shell title="My Mailbox">
      <div className="h-[calc(100vh-3.5rem)] flex overflow-hidden">
        {/* Left panel: accounts + folders */}
        <div className="w-56 shrink-0 border-r bg-muted/20 flex flex-col overflow-hidden">
          <div className="p-3 border-b space-y-2">
            <Button
              size="sm"
              className="w-full"
              onClick={() => { setReplyData(undefined); setComposeOpen(true); }}
              disabled={!selectedAccountId}
            >
              <Pencil className="size-3.5 mr-2" /> Compose
            </Button>

            {/* Manager rep selector */}
            {isManager && teamData?.members?.length && (
              <Select
                value={repUserId?.toString() ?? "me"}
                onValueChange={(v) => {
                  setRepUserId(v === "me" ? undefined : Number(v));
                  setSelectedAccountId(null);
                  setSelectedThreadId(undefined);
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <Users className="size-3 mr-1" />
                  <SelectValue placeholder="View rep…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">My Mailbox</SelectItem>
                  {teamData.members.map((m: any) => (
                    <SelectItem key={m.userId} value={m.userId.toString()}>
                      {m.name ?? m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Account list */}
          <div className="p-2 border-b">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1 mb-1">Accounts</div>
            {accountsLoading ? (
              <div className="flex justify-center py-2"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
            ) : accounts?.length ? (
              accounts.map((acc: any) => (
                <button
                  key={acc.id}
                  onClick={() => { setSelectedAccountId(acc.id); setSelectedThreadId(undefined); }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors",
                    selectedAccountId === acc.id ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
                  )}
                >
                  <Mail className="size-3 shrink-0" />
                  <span className="truncate">{acc.email}</span>
                </button>
              ))
            ) : (
              <p className="text-xs text-muted-foreground px-2 py-2">
                No inbox-enabled accounts. Configure Gmail OAuth or IMAP in Sending Accounts.
              </p>
            )}
          </div>

          {/* Folder list */}
          <div className="flex-1 overflow-y-auto p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1 mb-1">Folders</div>
            {folderList.map((f: any) => {
              const name = typeof f === "string" ? f : f.name;
              const label = typeof f === "string" ? f : (f.label ?? f.name);
              const Icon = name === "INBOX" ? Inbox : name === "SENT" ? Send : name === "TRASH" ? Trash2 : name === "SPAM" ? AlertCircle : Mail;
              return (
                <button
                  key={name}
                  onClick={() => { setSelectedFolder(name); setSelectedThreadId(undefined); }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors",
                    selectedFolder === name ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
                  )}
                >
                  <Icon className="size-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Center panel: thread list */}
        <div className={cn(
          "w-72 shrink-0 border-r flex flex-col overflow-hidden",
          selectedThreadId && "hidden md:flex"
        )}>
          {selectedAccountId ? (
            <ThreadList
              accountId={selectedAccountId}
              folder={selectedFolder}
              selectedId={selectedThreadId}
              onSelect={(id) => setSelectedThreadId(id)}
            />
          ) : (
            <EmptyState icon={MailOpen} title="Select an account" description="Choose an email account from the left panel to view your inbox." />
          )}
        </div>

        {/* Right panel: thread view */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedThreadId && selectedAccountId ? (
            <ThreadView
              accountId={selectedAccountId}
              threadId={selectedThreadId}
              onBack={() => setSelectedThreadId(undefined)}
              onReply={handleReply}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={MailOpen}
                title="No thread selected"
                description="Select a thread from the list to read it here."
              />
            </div>
          )}
        </div>
      </div>

      {/* Compose / Reply dialog */}
      {composeOpen && selectedAccountId && (
        <ComposeDialog
          open={composeOpen}
          onClose={() => { setComposeOpen(false); setReplyData(undefined); }}
          accountId={selectedAccountId}
          replyTo={replyData}
        />
      )}
    </Shell>
  );
}
