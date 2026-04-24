/**
 * Mailbox.tsx - Rep Mailbox UI (Feature 73, v2)
 *
 * Layout:
 *   Left panel (220px): Central Inbox + per-account list + folder list
 *   Center panel (320px): Thread list
 *   Right panel (flex): Thread reading pane
 *
 * Features:
 *   - Central Inbox: aggregated view of all accounts
 *   - Per-account inbox views with folder navigation
 *   - Reading pane: renders HTML body with correct field mapping
 *   - AI-assisted Reply and Forward
 *   - Delete (move to trash) and Move-to-folder
 *   - Compose new email
 */
import { useState, useEffect } from "react";
import { Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Mail, MailOpen, RefreshCw, Trash2, Reply, Send, Pencil,
  ChevronLeft, Inbox, AlertCircle, Loader2, Users,
  Forward, FolderInput, Archive, ChevronDown, Sparkles,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Account {
  id: number;
  name: string | null;
  email: string;
  provider: string;
  inboxEnabled: boolean;
}

interface EmailThread {
  threadId: string;
  subject: string;
  snippet: string;
  fromEmail: string;
  fromName: string;
  date: Date;
  unread: boolean;
  messageCount: number;
  labels: string[];
  accountId?: number;
  accountEmail?: string;
}

interface EmailMessage {
  messageId: string;
  threadId: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  ccEmail?: string;
  date: Date;
  bodyText: string;
  bodyHtml: string;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  inReplyTo?: string;
  references?: string;
  unread: boolean;
}

type ComposeMode = "new" | "reply" | "forward";

interface ComposeState {
  mode: ComposeMode;
  accountId: number;
  to: string;
  subject: string;
  body: string;
  cc: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  originalMessage?: EmailMessage;
  threadMessages?: EmailMessage[];
}

// ─── Compose / Reply / Forward Dialog ─────────────────────────────────────────

function ComposeDialog({ state, onClose }: { state: ComposeState; onClose: () => void }) {
  const [to, setTo] = useState(state.to);
  const [subject, setSubject] = useState(state.subject);
  const [body, setBody] = useState(state.body);
  const [cc, setCc] = useState(state.cc);
  const [aiLoading, setAiLoading] = useState(false);

  const aiDraftReply = trpc.mailbox.aiDraftReply.useMutation({
    onSuccess: (data) => { setBody(data.body); setAiLoading(false); },
    onError: (e) => { toast.error("AI draft failed: " + e.message); setAiLoading(false); },
  });
  const aiDraftForward = trpc.mailbox.aiDraftForward.useMutation({
    onSuccess: (data) => { setBody(data.body); setAiLoading(false); },
    onError: (e) => { toast.error("AI draft failed: " + e.message); setAiLoading(false); },
  });

  useEffect(() => {
    if (state.mode === "reply" && state.threadMessages?.length) {
      setAiLoading(true);
      aiDraftReply.mutate({
        accountId: state.accountId,
        messages: state.threadMessages.map((m) => ({
          fromEmail: m.fromEmail, fromName: m.fromName, toEmail: m.toEmail,
          subject: m.subject, bodyText: m.bodyText,
          date: m.date ? new Date(m.date).toISOString() : undefined,
        })),
      });
    } else if (state.mode === "forward" && state.originalMessage) {
      setAiLoading(true);
      aiDraftForward.mutate({
        accountId: state.accountId,
        originalMessage: {
          fromEmail: state.originalMessage.fromEmail,
          fromName: state.originalMessage.fromName,
          subject: state.originalMessage.subject,
          bodyText: state.originalMessage.bodyText,
          date: state.originalMessage.date ? new Date(state.originalMessage.date).toISOString() : undefined,
        },
      });
    }
  }, []);

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
    if (!to.trim()) { toast.error("Recipient required"); return; }
    if (!subject.trim()) { toast.error("Subject required"); return; }
    const bodyHtml = body.replace(/\n/g, "<br/>");
    if (state.mode === "new") {
      sendNew.mutate({ accountId: state.accountId, to, subject, bodyHtml, bodyText: body, cc: cc || undefined });
    } else {
      sendReply.mutate({
        accountId: state.accountId, threadId: state.threadId ?? "",
        to, subject, bodyHtml, bodyText: body, cc: cc || undefined,
        inReplyTo: state.inReplyTo, references: state.references,
      });
    }
  }

  function regenerateAI() {
    setAiLoading(true);
    if (state.mode === "reply" && state.threadMessages?.length) {
      aiDraftReply.mutate({
        accountId: state.accountId,
        messages: state.threadMessages.map((m) => ({
          fromEmail: m.fromEmail, fromName: m.fromName, toEmail: m.toEmail,
          subject: m.subject, bodyText: m.bodyText,
        })),
      });
    } else if (state.mode === "forward" && state.originalMessage) {
      aiDraftForward.mutate({
        accountId: state.accountId,
        originalMessage: {
          fromEmail: state.originalMessage.fromEmail,
          fromName: state.originalMessage.fromName,
          subject: state.originalMessage.subject,
          bodyText: state.originalMessage.bodyText,
        },
      });
    }
  }

  const modeLabel = state.mode === "reply" ? "Reply" : state.mode === "forward" ? "Forward" : "New Email";
  const ModeIcon = state.mode === "reply" ? Reply : state.mode === "forward" ? Forward : Pencil;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ModeIcon className="size-4" /> {modeLabel}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[60px_1fr] items-center gap-2">
            <Label className="text-right">To</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" />
          </div>
          <div className="grid grid-cols-[60px_1fr] items-center gap-2">
            <Label className="text-right">CC</Label>
            <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Optional" />
          </div>
          <div className="grid grid-cols-[60px_1fr] items-center gap-2">
            <Label className="text-right">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="relative">
            {aiLoading && (
              <div className="absolute inset-0 bg-background/80 flex items-center justify-center rounded-md z-10">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Sparkles className="size-4 animate-pulse text-primary" />
                  Generating AI draft...
                </div>
              </div>
            )}
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              className="min-h-[220px] font-mono text-sm"
            />
          </div>
          {(state.mode === "reply" || state.mode === "forward") && !aiLoading && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={regenerateAI}>
              <Sparkles className="size-3.5" /> Regenerate AI draft
            </Button>
          )}
          {state.mode === "forward" && state.originalMessage && (
            <div className="border rounded-md p-3 bg-muted/30 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">Forwarded message</div>
              <div>From: {state.originalMessage.fromName || state.originalMessage.fromEmail}</div>
              <div>Subject: {state.originalMessage.subject}</div>
              <div>Date: {new Date(state.originalMessage.date).toLocaleString()}</div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSend} disabled={isLoading || aiLoading}>
            {isLoading ? <Loader2 className="size-4 animate-spin mr-2" /> : <Send className="size-4 mr-2" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Thread Reading Pane ───────────────────────────────────────────────────────

function ThreadView({
  accountId, threadId, folder, folders, onBack, onCompose, onDeleted, onMoved,
}: {
  accountId: number; threadId: string; folder: string;
  folders: Array<{ name: string; path: string }>;
  onBack: () => void; onCompose: (s: ComposeState) => void;
  onDeleted: () => void; onMoved: () => void;
}) {
  const { data, isLoading } = trpc.mailbox.getThread.useQuery(
    { accountId, threadId, folder },
    { enabled: !!accountId && !!threadId }
  );
  const markRead = trpc.mailbox.markRead.useMutation();
  const moveToTrash = trpc.mailbox.moveToTrash.useMutation({
    onSuccess: () => { toast.success("Moved to trash"); onDeleted(); },
    onError: (e) => toast.error(e.message),
  });
  const moveToFolder = trpc.mailbox.moveToFolder.useMutation({
    onSuccess: () => { toast.success("Message moved"); onMoved(); },
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => {
    if ((data as EmailMessage[])?.length) {
      (data as EmailMessage[]).filter((m) => m.unread).forEach((m) =>
        markRead.mutate({ accountId, messageId: m.messageId, read: true })
      );
    }
  }, [data]);

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );

  const messages: EmailMessage[] = (data as EmailMessage[]) ?? [];

  if (!messages.length) return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
      <MailOpen className="size-10 opacity-30" />
      <p className="text-sm">Thread not found or empty.</p>
      <Button variant="outline" size="sm" onClick={onBack}>Go back</Button>
    </div>
  );

  const lastMsg = messages[messages.length - 1];
  const firstMsg = messages[0];
  const moveFolders = folders.filter((f) => f.path !== folder && f.name !== folder);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-2.5 border-b flex items-center gap-2 shrink-0 bg-background">
        <Button variant="ghost" size="icon" onClick={onBack} className="md:hidden shrink-0">
          <ChevronLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{firstMsg.subject}</h2>
          <p className="text-xs text-muted-foreground">{messages.length} message{messages.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs"
            onClick={() => onCompose({
              mode: "reply", accountId, to: lastMsg.fromEmail,
              subject: "Re: " + lastMsg.subject.replace(/^Re:\s*/i, ""),
              body: "", cc: "", threadId,
              inReplyTo: lastMsg.messageId, references: lastMsg.references,
              threadMessages: messages,
            })}>
            <Reply className="size-3.5" />
            <span className="hidden sm:inline">Reply</span>
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs"
            onClick={() => onCompose({
              mode: "forward", accountId, to: "",
              subject: "Fwd: " + lastMsg.subject.replace(/^Fwd:\s*/i, ""),
              body: "", cc: "", threadId, originalMessage: lastMsg,
            })}>
            <Forward className="size-3.5" />
            <span className="hidden sm:inline">Forward</span>
          </Button>
          {moveFolders.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                  <FolderInput className="size-3.5" />
                  <span className="hidden sm:inline">Move</span>
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {moveFolders.map((f) => (
                  <DropdownMenuItem key={f.path}
                    onClick={() => moveToFolder.mutate({ accountId, messageId: lastMsg.messageId, destFolder: f.path, currentFolder: folder })}>
                    <Mail className="size-3.5 mr-2" /> {f.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  onClick={() => moveToFolder.mutate({ accountId, messageId: lastMsg.messageId, destFolder: "Archive", currentFolder: folder })}>
                  <Archive className="size-3.5 mr-2" /> Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost" size="sm"
            className="gap-1.5 text-xs text-destructive hover:text-destructive"
            onClick={() => moveToTrash.mutate({ accountId, messageId: lastMsg.messageId })}
            disabled={moveToTrash.isPending}>
            {moveToTrash.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {messages.map((msg) => (
            <div key={msg.messageId} className="border rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/40 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-sm">{msg.fromName || msg.fromEmail}</span>
                    {msg.fromName && <span className="text-xs text-muted-foreground">&lt;{msg.fromEmail}&gt;</span>}
                  </div>
                  {msg.toEmail && <div className="text-xs text-muted-foreground mt-0.5">To: {msg.toEmail}</div>}
                  {msg.ccEmail && <div className="text-xs text-muted-foreground">CC: {msg.ccEmail}</div>}
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                  {new Date(msg.date).toLocaleString()}
                </span>
              </div>
              <div className="p-4">
                {msg.bodyHtml ? (
                  <div
                    className="prose prose-sm max-w-none text-foreground [&_a]:text-primary [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: msg.bodyHtml }}
                  />
                ) : msg.bodyText ? (
                  <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">{msg.bodyText}</pre>
                ) : (
                  <p className="text-sm text-muted-foreground italic">(No message body)</p>
                )}
                {msg.attachments?.length > 0 && (
                  <div className="mt-3 pt-3 border-t flex flex-wrap gap-2">
                    {msg.attachments.map((att, i) => (
                      <Badge key={i} variant="secondary" className="gap-1 text-xs">
                        <Mail className="size-3" /> {att.filename}
                        {att.size > 0 && <span className="text-muted-foreground ml-1">({Math.round(att.size / 1024)}KB)</span>}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ─── Thread Row ────────────────────────────────────────────────────────────────

function ThreadRow({ thread, selected, showAccountBadge, onSelect }: {
  thread: EmailThread; selected: boolean; showAccountBadge: boolean; onSelect: () => void;
}) {
  return (
    <button onClick={onSelect}
      className={cn(
        "w-full text-left px-3 py-3 hover:bg-muted/50 transition-colors border-b last:border-b-0",
        selected && "bg-muted", thread.unread && "font-semibold"
      )}>
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-sm truncate">{thread.fromName || thread.fromEmail}</span>
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          {new Date(thread.date).toLocaleDateString()}
        </span>
      </div>
      <div className="text-sm truncate">{thread.subject}</div>
      {thread.snippet && <div className="text-xs text-muted-foreground truncate mt-0.5">{thread.snippet}</div>}
      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        {thread.unread && <Badge variant="default" className="text-[10px] h-4 px-1.5">New</Badge>}
        {thread.messageCount > 1 && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{thread.messageCount}</Badge>}
        {showAccountBadge && thread.accountEmail && (
          <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-normal truncate max-w-[140px]">{thread.accountEmail}</Badge>
        )}
      </div>
    </button>
  );
}

// ─── Single-account thread list ────────────────────────────────────────────────

function SingleAccountThreadList({ accountId, folder, selectedId, onSelect }: {
  accountId: number; folder: string; selectedId?: string; onSelect: (id: string) => void;
}) {
  const [pageToken, setPageToken] = useState<string | undefined>();
  const { data, isLoading, refetch } = trpc.mailbox.listThreads.useQuery(
    { accountId, folder, pageToken, maxResults: 50 }, { enabled: !!accountId }
  );
  const threads: EmailThread[] = (data?.threads ?? []) as EmailThread[];
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{threads.length} thread{threads.length !== 1 ? "s" : ""}</span>
        <Button variant="ghost" size="icon" onClick={() => refetch()} className="size-7"><RefreshCw className="size-3.5" /></Button>
      </div>
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : !threads.length ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-4">
          <MailOpen className="size-8 opacity-30" />
          <p className="text-xs text-center">{folder} is empty.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {threads.map((t) => (
            <ThreadRow key={t.threadId} thread={t} selected={selectedId === t.threadId}
              showAccountBadge={false} onSelect={() => onSelect(t.threadId)} />
          ))}
          {data?.nextPageToken && (
            <div className="p-2">
              <Button variant="outline" size="sm" className="w-full" onClick={() => setPageToken(data.nextPageToken)}>Load more</Button>
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
}

// ─── Central Inbox (supports up to 5 accounts) ────────────────────────────────

function CentralInboxThreadList({ accounts, selectedId, onSelect }: {
  accounts: Account[]; selectedId?: string; onSelect: (threadId: string, accountId: number) => void;
}) {
  const q0 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[0]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[0] });
  const q1 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[1]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[1] });
  const q2 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[2]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[2] });
  const q3 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[3]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[3] });
  const q4 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[4]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[4] });
  const qs = [q0, q1, q2, q3, q4].slice(0, accounts.length);
  const isLoading = qs.some((q) => q.isLoading);
  const allThreads: EmailThread[] = qs.flatMap((q, i) =>
    ((q.data?.threads ?? []) as EmailThread[]).map((t) => ({ ...t, accountId: accounts[i].id, accountEmail: accounts[i].email }))
  ).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{allThreads.length} thread{allThreads.length !== 1 ? "s" : ""}</span>
        <Button variant="ghost" size="icon" onClick={() => qs.forEach((q) => q.refetch())} className="size-7"><RefreshCw className="size-3.5" /></Button>
      </div>
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : !allThreads.length ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-4">
          <MailOpen className="size-8 opacity-30" />
          <p className="text-xs text-center">No messages across any account.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {allThreads.map((t) => (
            <ThreadRow key={t.accountId + "-" + t.threadId} thread={t} selected={selectedId === t.threadId}
              showAccountBadge={true} onSelect={() => onSelect(t.threadId, t.accountId!)} />
          ))}
        </ScrollArea>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type SelectedView = { type: "central" } | { type: "account"; accountId: number };

export default function MailboxPage() {
  const { user } = useAuth();
  const [selectedView, setSelectedView] = useState<SelectedView>({ type: "central" });
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [selectedThreadAccountId, setSelectedThreadAccountId] = useState<number | undefined>();
  const [composeState, setComposeState] = useState<ComposeState | null>(null);
  const [repUserId, setRepUserId] = useState<number | undefined>();

  const { data: accounts = [], isLoading: accountsLoading } = trpc.mailbox.listAccounts.useQuery({ repUserId }, { enabled: true });
  const currentAccountId = selectedView.type === "account" ? selectedView.accountId : undefined;
  const { data: folders = [] } = trpc.mailbox.listFolders.useQuery({ accountId: currentAccountId!, repUserId }, { enabled: !!currentAccountId });
  const { data: teamData } = trpc.team.list.useQuery(undefined, { enabled: true });

  const isManager = (user as any)?.role === "manager" || (user as any)?.role === "admin" || (user as any)?.role === "super_admin";

  const folderList: Array<{ name: string; path: string }> = (folders as any[]).length
    ? (folders as Array<{ name: string; path: string }>)
    : [
        { name: "Inbox", path: "INBOX" }, { name: "Sent", path: "SENT" },
        { name: "Drafts", path: "DRAFTS" }, { name: "Trash", path: "TRASH" }, { name: "Spam", path: "SPAM" },
      ];

  function selectThread(threadId: string, accountId?: number) {
    setSelectedThreadId(threadId);
    setSelectedThreadAccountId(accountId ?? currentAccountId);
  }
  function clearThread() { setSelectedThreadId(undefined); setSelectedThreadAccountId(undefined); }
  function openCompose(accountId?: number) {
    const accId = accountId ?? currentAccountId ?? (accounts as Account[])[0]?.id;
    if (!accId) { toast.error("No account selected"); return; }
    setComposeState({ mode: "new", accountId: accId, to: "", subject: "", body: "", cc: "" });
  }

  const folderIcon = (path: string) => {
    const p = path.toUpperCase();
    if (p === "INBOX") return Inbox; if (p === "SENT") return Send;
    if (p === "TRASH") return Trash2; if (p === "SPAM") return AlertCircle;
    if (p === "ARCHIVE") return Archive; return Mail;
  };

  const readingPaneAccountId = selectedThreadAccountId ?? currentAccountId;

  return (
    <Shell title="My Mailbox">
      <div className="h-[calc(100vh-3.5rem)] flex overflow-hidden">

        {/* Left panel */}
        <div className="w-52 shrink-0 border-r bg-muted/20 flex flex-col overflow-hidden">
          <div className="p-2.5 border-b space-y-2">
            <Button size="sm" className="w-full" onClick={() => openCompose()} disabled={!(accounts as Account[]).length}>
              <Pencil className="size-3.5 mr-2" /> Compose
            </Button>
            {isManager && (teamData as any[])?.length > 0 && (
              <Select value={repUserId?.toString() ?? "me"}
                onValueChange={(v) => { setRepUserId(v === "me" ? undefined : Number(v)); setSelectedView({ type: "central" }); clearThread(); }}>
                <SelectTrigger className="h-8 text-xs">
                  <Users className="size-3 mr-1" />
                  <SelectValue placeholder="View rep..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">My Mailbox</SelectItem>
                  {(teamData as any[])?.map((m: any) => (
                    <SelectItem key={m.userId} value={m.userId.toString()}>{m.name ?? m.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-0.5">
              <button
                onClick={() => { setSelectedView({ type: "central" }); setSelectedFolder("INBOX"); clearThread(); }}
                className={cn(
                  "w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors font-medium",
                  selectedView.type === "central" ? "bg-primary/10 text-primary" : "hover:bg-muted text-foreground"
                )}>
                <Inbox className="size-3.5 shrink-0" />
                <span>Central Inbox</span>
                {(accounts as Account[]).length > 0 && (
                  <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">{(accounts as Account[]).length}</Badge>
                )}
              </button>

              {accountsLoading ? (
                <div className="flex justify-center py-2"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
              ) : (accounts as Account[]).length ? (
                <>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 pt-3 pb-1">Accounts</div>
                  {(accounts as Account[]).map((acc) => (
                    <button key={acc.id}
                      onClick={() => { setSelectedView({ type: "account", accountId: acc.id }); setSelectedFolder("INBOX"); clearThread(); }}
                      className={cn(
                        "w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors",
                        selectedView.type === "account" && (selectedView as any).accountId === acc.id
                          ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
                      )}>
                      <Mail className="size-3 shrink-0" />
                      <span className="truncate">{acc.email}</span>
                    </button>
                  ))}
                </>
              ) : (
                <p className="text-xs text-muted-foreground px-2 py-2">
                  No inbox-enabled accounts. Configure Gmail OAuth or IMAP in Sending Accounts.
                </p>
              )}

              {selectedView.type === "account" && (
                <>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 pt-3 pb-1">Folders</div>
                  {folderList.map((f) => {
                    const Icon = folderIcon(f.path);
                    return (
                      <button key={f.path}
                        onClick={() => { setSelectedFolder(f.path); clearThread(); }}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors",
                          selectedFolder === f.path ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
                        )}>
                        <Icon className="size-3 shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Center panel: thread list */}
        <div className={cn("w-80 shrink-0 border-r flex flex-col overflow-hidden", selectedThreadId && "hidden md:flex")}>
          {selectedView.type === "central" ? (
            (accounts as Account[]).length ? (
              <CentralInboxThreadList accounts={accounts as Account[]} selectedId={selectedThreadId}
                onSelect={(threadId, accountId) => selectThread(threadId, accountId)} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-4">
                <MailOpen className="size-8 opacity-30" />
                <p className="text-xs text-center">No inbox-enabled accounts configured.</p>
              </div>
            )
          ) : (
            <SingleAccountThreadList
              accountId={(selectedView as { type: "account"; accountId: number }).accountId}
              folder={selectedFolder} selectedId={selectedThreadId} onSelect={(id) => selectThread(id)} />
          )}
        </div>

        {/* Right panel: reading pane */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedThreadId && readingPaneAccountId ? (
            <ThreadView
              accountId={readingPaneAccountId} threadId={selectedThreadId}
              folder={selectedView.type === "account" ? selectedFolder : "INBOX"}
              folders={folderList} onBack={clearThread}
              onCompose={(s) => setComposeState(s)} onDeleted={clearThread} onMoved={clearThread} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <MailOpen className="size-12 opacity-20" />
              <div className="text-center">
                <p className="text-sm font-medium">No message selected</p>
                <p className="text-xs mt-1">Select a thread from the list to read it here.</p>
              </div>
              {(accounts as Account[]).length > 0 && (
                <Button size="sm" variant="outline" onClick={() => openCompose()}>
                  <Pencil className="size-3.5 mr-2" /> Compose new email
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {composeState && <ComposeDialog state={composeState} onClose={() => setComposeState(null)} />}
    </Shell>
  );
}
