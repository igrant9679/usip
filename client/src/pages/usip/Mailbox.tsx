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
import { useState, useEffect, useRef } from "react";
import { Shell, PageHeader } from "@/components/usip/Shell";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Mail, MailOpen, RefreshCw, Trash2, Reply, Send, Pencil,
  ChevronLeft, Inbox, AlertCircle, Loader2, Users,
  Forward, FolderInput, Archive, ChevronDown, Sparkles,
  Clock, Search, FileText, Download, Paperclip, X,
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

// ─── Snooze Popover ───────────────────────────────────────────────────────────

function SnoozePopover({ accountId, thread, onSnoozed }: {
  accountId: number;
  thread: { threadId: string; subject: string };
  onSnoozed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const createTask = trpc.tasks.create.useMutation({
    onSuccess: () => { toast.success("Snoozed — a follow-up task has been created"); setOpen(false); onSnoozed(); },
    onError: (e) => toast.error("Snooze failed: " + e.message),
  });

  function snooze(dueAt: Date) {
    createTask.mutate({
      title: `Follow up: ${thread.subject}`,
      type: "follow_up",
      dueAt: dueAt.toISOString(),
      relatedType: "mailbox_thread",
      relatedId: accountId,
    });
  }

  const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; };
  const in3Days = () => { const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0); return d; };
  const nextWeek = () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
          <Clock className="size-3.5" />
          <span className="hidden sm:inline">Snooze</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2" align="end">
        <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Remind me…</p>
        <div className="space-y-0.5">
          {[
            { label: "Tomorrow (9am)", fn: tomorrow },
            { label: "In 3 days", fn: in3Days },
            { label: "Next week", fn: nextWeek },
          ].map(({ label, fn }) => (
            <button key={label}
              className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted transition-colors"
              onClick={() => snooze(fn())}>
              {label}
            </button>
          ))}
          <div className="pt-1 border-t mt-1">
            <p className="text-[10px] text-muted-foreground px-1 mb-1">Custom date</p>
            <input type="datetime-local" value={customDate} onChange={(e) => setCustomDate(e.target.value)}
              className="w-full text-xs border rounded px-2 py-1 bg-background" />
            <Button size="sm" className="w-full mt-1.5" disabled={!customDate || createTask.isPending}
              onClick={() => customDate && snooze(new Date(customDate))}>
              {createTask.isPending ? <Loader2 className="size-3 animate-spin" /> : "Set reminder"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
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
    const atts = attachments.length > 0 ? attachments.map(({ filename, contentType, content }) => ({ filename, contentType, content })) : undefined;
    if (state.mode === "new") {
      sendNew.mutate({ accountId: state.accountId, to, subject, bodyHtml, bodyText: body, cc: cc || undefined, attachments: atts });
    } else {
      sendReply.mutate({
        accountId: state.accountId, threadId: state.threadId ?? "",
        to, subject, bodyHtml, bodyText: body, cc: cc || undefined,
        inReplyTo: state.inReplyTo, references: state.references,
        attachments: atts,
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

  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const { data: templatesData } = trpc.emailTemplates.list.useQuery({ status: "active" });
  const templates = (templatesData as any[]) ?? [];

  // File attachments
  const [attachments, setAttachments] = useState<Array<{ filename: string; contentType: string; content: string; size: number }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = (ev.target?.result as string).split(",")[1];
        setAttachments((prev) => [...prev, { filename: file.name, contentType: file.type || "application/octet-stream", content: base64, size: file.size }]);
      };
      reader.readAsDataURL(file);
    });
    // Reset so same file can be re-selected
    e.target.value = "";
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function applyTemplate(tpl: any) {
    if (tpl.subject) setSubject(tpl.subject);
    if (tpl.plainOutput) setBody(tpl.plainOutput);
    else if (tpl.htmlOutput) setBody(tpl.htmlOutput.replace(/<[^>]+>/g, ""));
    setTemplatePickerOpen(false);
    toast.success(`Template "${tpl.name}" applied`);
  }

  const modeLabel = state.mode === "reply" ? "Reply" : state.mode === "forward" ? "Forward" : "New Email";
  const ModeIcon = state.mode === "reply" ? Reply : state.mode === "forward" ? Forward : Pencil;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 justify-between">
            <span className="flex items-center gap-2"><ModeIcon className="size-4" /> {modeLabel}</span>
            <Popover open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 text-xs h-7">
                  <FileText className="size-3.5" /> Use template
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="end">
                <Command>
                  <CommandInput placeholder="Search templates..." />
                  <CommandList>
                    <CommandEmpty>{templates.length === 0 ? "No active templates saved yet." : "No templates found."}</CommandEmpty>
                    <CommandGroup heading="Active templates">
                      {templates.map((tpl: any) => (
                        <CommandItem key={tpl.id} value={tpl.name} onSelect={() => applyTemplate(tpl)}>
                          <FileText className="size-3.5 mr-2 text-muted-foreground" />
                          <span className="text-sm">{tpl.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
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

          {/* File attachments */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5 text-xs h-7" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="size-3.5" /> Attach file
              </Button>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
            </div>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map((att, idx) => (
                  <div key={idx} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-xs">
                    <Paperclip className="size-3 text-muted-foreground" />
                    <span className="max-w-[140px] truncate">{att.filename}</span>
                    <span className="text-muted-foreground">({Math.round(att.size / 1024)}KB)</span>
                    <button onClick={() => removeAttachment(idx)} className="ml-1 text-muted-foreground hover:text-destructive">
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
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

// ─── Attachment Badge (clickable download) ────────────────────────────────────

function AttachmentBadge({ accountId, messageId, attachment, index }: {
  accountId: number;
  messageId: string;
  attachment: { filename: string; contentType: string; size: number; attachmentId?: string };
  index: number;
}) {
  const [loading, setLoading] = useState(false);
  const utils = trpc.useUtils();

  async function handleDownload() {
    const attId = (attachment as any).attachmentId ?? String(index);
    setLoading(true);
    try {
      const result = await utils.client.mailbox.getAttachment.query({ accountId, messageId, attachmentId: attId });
      const bytes = Uint8Array.from(atob(result.dataBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = result.filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error("Download failed: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Badge
      variant="secondary"
      className="gap-1 text-xs cursor-pointer hover:bg-secondary/80 transition-colors"
      onClick={handleDownload}
      title="Click to download">
      {loading ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
      {attachment.filename}
      {attachment.size > 0 && <span className="text-muted-foreground ml-1">({Math.round(attachment.size / 1024)}KB)</span>}
    </Badge>
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
  const markRead = trpc.mailbox.markRead.useMutation({
    onSuccess: () => utils.mailbox.getThread.invalidate({ accountId, threadId, folder }),
  });
  const moveToTrash = trpc.mailbox.moveToTrash.useMutation({
    onSuccess: () => { toast.success("Moved to trash"); onDeleted(); },
    onError: (e) => toast.error(e.message),
  });
  const moveToFolder = trpc.mailbox.moveToFolder.useMutation({
    onSuccess: () => { toast.success("Message moved"); onMoved(); },
    onError: (e) => toast.error(e.message),
  });
  const utils = trpc.useUtils();

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
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs"
            title={lastMsg.unread ? "Mark as read" : "Mark as unread"}
            onClick={() => markRead.mutate({ accountId, messageId: lastMsg.messageId, read: !!lastMsg.unread })}>
            {lastMsg.unread ? <MailOpen className="size-3.5" /> : <Mail className="size-3.5" />}
            <span className="hidden sm:inline">{lastMsg.unread ? "Mark read" : "Mark unread"}</span>
          </Button>
          <SnoozePopover accountId={accountId} thread={{ threadId, subject: firstMsg.subject }} onSnoozed={() => {}} />
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
                      <AttachmentBadge key={i} accountId={accountId} messageId={msg.messageId} attachment={att} index={i} />
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
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleSearch(q: string) {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(q), 400);
  }

  const { data, isLoading, refetch } = trpc.mailbox.listThreads.useQuery(
    { accountId, folder, pageToken, maxResults: 50 }, { enabled: !!accountId && !debouncedQuery }
  );
  const { data: searchData, isLoading: searchLoading } = trpc.mailbox.searchThreads.useQuery(
    { accountId, query: debouncedQuery, folder, maxResults: 30 },
    { enabled: !!accountId && !!debouncedQuery }
  );

  const threads: EmailThread[] = debouncedQuery
    ? ((searchData?.threads ?? []) as EmailThread[])
    : ((data?.threads ?? []) as EmailThread[]);
  const loading = debouncedQuery ? searchLoading : isLoading;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{threads.length} thread{threads.length !== 1 ? "s" : ""}</span>
          <Button variant="ghost" size="icon" onClick={() => refetch()} className="size-7"><RefreshCw className="size-3.5" /></Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input value={searchQuery} onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search messages..." className="pl-7 h-7 text-xs" />
        </div>
      </div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : !threads.length ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-4">
          <MailOpen className="size-8 opacity-30" />
          <p className="text-xs text-center">{debouncedQuery ? `No results for "${debouncedQuery}"` : `${folder} is empty.`}</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {threads.map((t) => (
            <ThreadRow key={t.threadId} thread={t} selected={selectedId === t.threadId}
              showAccountBadge={false} onSelect={() => onSelect(t.threadId)} />
          ))}
          {!debouncedQuery && data?.nextPageToken && (
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
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleSearch(q: string) {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(q), 400);
  }

  const q0 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[0]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[0] && !debouncedQuery });
  const q1 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[1]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[1] && !debouncedQuery });
  const q2 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[2]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[2] && !debouncedQuery });
  const q3 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[3]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[3] && !debouncedQuery });
  const q4 = trpc.mailbox.listThreads.useQuery({ accountId: accounts[4]?.id ?? 0, folder: "INBOX", maxResults: 30 }, { enabled: !!accounts[4] && !debouncedQuery });
  const s0 = trpc.mailbox.searchThreads.useQuery({ accountId: accounts[0]?.id ?? 0, query: debouncedQuery, folder: "INBOX" }, { enabled: !!accounts[0] && !!debouncedQuery });
  const s1 = trpc.mailbox.searchThreads.useQuery({ accountId: accounts[1]?.id ?? 0, query: debouncedQuery, folder: "INBOX" }, { enabled: !!accounts[1] && !!debouncedQuery });
  const s2 = trpc.mailbox.searchThreads.useQuery({ accountId: accounts[2]?.id ?? 0, query: debouncedQuery, folder: "INBOX" }, { enabled: !!accounts[2] && !!debouncedQuery });
  const s3 = trpc.mailbox.searchThreads.useQuery({ accountId: accounts[3]?.id ?? 0, query: debouncedQuery, folder: "INBOX" }, { enabled: !!accounts[3] && !!debouncedQuery });
  const s4 = trpc.mailbox.searchThreads.useQuery({ accountId: accounts[4]?.id ?? 0, query: debouncedQuery, folder: "INBOX" }, { enabled: !!accounts[4] && !!debouncedQuery });
  const qs = [q0, q1, q2, q3, q4].slice(0, accounts.length);
  const ss = [s0, s1, s2, s3, s4].slice(0, accounts.length);
  const isLoading = debouncedQuery ? ss.some((q) => q.isLoading) : qs.some((q) => q.isLoading);
  const allThreads: EmailThread[] = debouncedQuery
    ? ss.flatMap((q, i) => ((q.data?.threads ?? []) as EmailThread[]).map((t) => ({ ...t, accountId: accounts[i].id, accountEmail: accounts[i].email })))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    : qs.flatMap((q, i) => ((q.data?.threads ?? []) as EmailThread[]).map((t) => ({ ...t, accountId: accounts[i].id, accountEmail: accounts[i].email })))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{allThreads.length} thread{allThreads.length !== 1 ? "s" : ""}</span>
          <Button variant="ghost" size="icon" onClick={() => qs.forEach((q) => q.refetch())} className="size-7"><RefreshCw className="size-3.5" /></Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input value={searchQuery} onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search all inboxes..." className="pl-7 h-7 text-xs" />
        </div>
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
      <PageHeader title="My Mailbox" description="Manage your connected email accounts, compose new messages, and track replies across all inboxes. All sent emails are automatically logged to the relevant contact and deal records." pageKey="mailbox" 
        icon={<Mail className="size-5" />}
      />
      <div className="h-[calc(100vh-8.5rem)] flex overflow-hidden">

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
                      <span className="truncate flex-1">{acc.email}</span>
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
