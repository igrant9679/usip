import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Inbox,
  Send,
  Search,
  RefreshCw,
  Loader2,
  MessageSquare,
  Filter,
  Plug,
  ChevronRight,
} from "lucide-react";
import { Link } from "wouter";

// ─── Provider color map ───────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  LINKEDIN:  "#0A66C2",
  WHATSAPP:  "#25D366",
  INSTAGRAM: "#E1306C",
  MESSENGER: "#0084FF",
  TELEGRAM:  "#2AABEE",
  TWITTER:   "#000000",
  GOOGLE:    "#EA4335",
  MICROSOFT: "#0078D4",
  IMAP:      "#6B7280",
};

const PROVIDER_LABELS: Record<string, string> = {
  LINKEDIN:  "LinkedIn",
  WHATSAPP:  "WhatsApp",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  TELEGRAM:  "Telegram",
  TWITTER:   "X",
  GOOGLE:    "Gmail",
  MICROSOFT: "Outlook",
  IMAP:      "Email",
};

const PROVIDER_EMOJI: Record<string, string> = {
  LINKEDIN:  "💼",
  WHATSAPP:  "💬",
  INSTAGRAM: "📸",
  MESSENGER: "💙",
  TELEGRAM:  "✈️",
  TWITTER:   "𝕏",
  GOOGLE:    "📧",
  MICROSOFT: "📨",
  IMAP:      "📮",
};

function ProviderBadge({ provider }: { provider: string }) {
  const color = PROVIDER_COLORS[provider] ?? "#6B7280";
  const label = PROVIDER_LABELS[provider] ?? provider;
  const emoji = PROVIDER_EMOJI[provider] ?? "📩";
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
      style={{ backgroundColor: color }}
    >
      {emoji} {label}
    </span>
  );
}

// ─── Chat list item ───────────────────────────────────────────────────────────

interface ChatItem {
  id: string;
  account_id: string;
  provider: string;
  name?: string;
  unread_count?: number;
  last_message?: { text?: string; created_at?: string };
  attendees?: Array<{ id: string; name?: string }>;
}

function ChatListItem({
  chat,
  selected,
  onClick,
}: {
  chat: ChatItem;
  selected: boolean;
  onClick: () => void;
}) {
  const initials = (chat.name ?? "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-start gap-3 p-3 rounded-lg text-left transition-colors ${
        selected ? "bg-violet-500/15 border border-violet-500/30" : "hover:bg-muted/50"
      }`}
    >
      <Avatar className="h-10 w-10 flex-shrink-0">
        <AvatarFallback
          style={{ backgroundColor: PROVIDER_COLORS[chat.provider] + "30", color: PROVIDER_COLORS[chat.provider] }}
        >
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm truncate">{chat.name ?? "Unknown"}</span>
          {chat.unread_count ? (
            <Badge className="bg-violet-500 text-white text-xs h-5 min-w-5 flex items-center justify-center">
              {chat.unread_count}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {chat.last_message?.text ?? "No messages yet"}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <ProviderBadge provider={chat.provider} />
          {chat.last_message?.created_at && (
            <span className="text-xs text-muted-foreground">
              {new Date(chat.last_message.created_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface MessageItem {
  id: string;
  text?: string;
  is_sender: boolean;
  sender_name?: string;
  created_at: string;
  provider: string;
}

function MessageBubble({ msg }: { msg: MessageItem }) {
  const color = PROVIDER_COLORS[msg.provider] ?? "#6B7280";
  return (
    <div className={`flex ${msg.is_sender ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2 ${
          msg.is_sender
            ? "text-white rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm"
        }`}
        style={msg.is_sender ? { backgroundColor: color } : {}}
      >
        {!msg.is_sender && (
          <p className="text-xs font-semibold mb-1" style={{ color }}>
            {msg.sender_name ?? "Contact"}
          </p>
        )}
        <p className="text-sm whitespace-pre-wrap">{msg.text ?? "(no text)"}</p>
        <p className={`text-xs mt-1 ${msg.is_sender ? "text-white/70" : "text-muted-foreground"}`}>
          {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function UnifiedInbox() {
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedChat, setSelectedChat] = useState<ChatItem | null>(null);
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: accounts = [] } = trpc.unipile.listConnectedAccounts.useQuery();
  const {
    data: inboxData,
    isLoading: inboxLoading,
    refetch: refetchInbox,
  } = trpc.unipile.getInbox.useQuery({
    provider: providerFilter === "all" ? undefined : providerFilter,
    limit: 30,
  });

  const {
    data: messagesData,
    isLoading: messagesLoading,
    refetch: refetchMessages,
  } = trpc.unipile.getChatMessages.useQuery(
    { chatId: selectedChat?.id ?? "", limit: 50 },
    { enabled: !!selectedChat },
  );

  const sendMsg = trpc.unipile.sendMessage.useMutation({
    onSuccess: () => {
      setReplyText("");
      refetchMessages();
      refetchInbox();
    },
    onError: (err) => toast.error("Failed to send", { description: err.message }),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesData]);

  const chats: ChatItem[] = (inboxData?.chats as ChatItem[]) ?? [];
  const filteredChats = chats.filter((c) =>
    search ? (c.name ?? "").toLowerCase().includes(search.toLowerCase()) : true,
  );

  const messages: MessageItem[] = ((messagesData?.items as MessageItem[]) ?? []).slice().reverse();

  const handleSend = async () => {
    if (!replyText.trim() || !selectedChat) return;
    const account = accounts.find((a) => a.unipileAccountId === selectedChat.account_id);
    if (!account) {
      toast.error("Account not found");
      return;
    }
    setIsSending(true);
    try {
      await sendMsg.mutateAsync({
        chatId: selectedChat.id,
        unipileAccountId: selectedChat.account_id,
        text: replyText.trim(),
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSend();
    }
  };

  // Available providers from connected accounts
  const connectedProviders = [...new Set(accounts.map((a) => a.provider))];

  return (
    <Shell>
      <PageHeader
        title="Unified Inbox" description="A single inbox for all inbound replies across connected email accounts." pageKey="unified-inbox"
        subtitle="All your conversations across every channel in one place"
        actions={
          <div className="flex gap-2"
        icon={<Inbox className="size-5" />}
      >
            <Button variant="outline" size="sm" onClick={() => refetchInbox()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Link href="/connected-accounts">
              <Button variant="outline" size="sm">
                <Plug className="h-4 w-4 mr-2" />
                Manage Accounts
              </Button>
            </Link>
          </div>
        }
      />

      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-96 gap-4 p-6">
          <div className="h-16 w-16 rounded-full bg-violet-500/10 flex items-center justify-center">
            <Inbox className="h-8 w-8 text-violet-500" />
          </div>
          <div className="text-center">
            <h3 className="font-semibold text-lg">No accounts connected</h3>
            <p className="text-muted-foreground text-sm mt-1">
              Connect your LinkedIn, email, or messaging accounts to see your unified inbox.
            </p>
          </div>
          <Link href="/connected-accounts">
            <Button className="bg-violet-600 hover:bg-violet-700 text-white">
              <Plug className="h-4 w-4 mr-2" />
              Connect Accounts
            </Button>
          </Link>
        </div>
      ) : (
        <div className="flex h-[calc(100vh-140px)] overflow-hidden">
          {/* ── Left panel: chat list ── */}
          <div className="w-80 flex-shrink-0 border-r flex flex-col">
            {/* Filters */}
            <div className="p-3 border-b space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search conversations..."
                  className="pl-9 h-8 text-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="h-8 text-sm">
                  <Filter className="h-3 w-3 mr-2" />
                  <SelectValue placeholder="All channels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {connectedProviders.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PROVIDER_EMOJI[p]} {PROVIDER_LABELS[p] ?? p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Chat list */}
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {inboxLoading ? (
                  <div className="flex items-center justify-center h-20">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredChats.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No conversations yet
                  </div>
                ) : (
                  filteredChats.map((chat) => (
                    <ChatListItem
                      key={chat.id}
                      chat={chat}
                      selected={selectedChat?.id === chat.id}
                      onClick={() => setSelectedChat(chat)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* ── Right panel: message thread ── */}
          <div className="flex-1 flex flex-col">
            {selectedChat ? (
              <>
                {/* Thread header */}
                <div className="p-4 border-b flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarFallback
                        style={{
                          backgroundColor: PROVIDER_COLORS[selectedChat.provider] + "30",
                          color: PROVIDER_COLORS[selectedChat.provider],
                        }}
                      >
                        {(selectedChat.name ?? "?").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-semibold text-sm">{selectedChat.name ?? "Unknown"}</p>
                      <ProviderBadge provider={selectedChat.provider} />
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => refetchMessages()}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>

                {/* Messages */}
                <ScrollArea className="flex-1 p-4">
                  {messagesLoading ? (
                    <div className="flex items-center justify-center h-20">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No messages in this conversation yet
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <MessageBubble
                        key={msg.id}
                        msg={{ ...msg, provider: selectedChat.provider }}
                      />
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </ScrollArea>

                {/* Reply composer */}
                <div className="p-4 border-t">
                  <div className="flex gap-2 items-end">
                    <Textarea
                      placeholder="Type a message… (Ctrl+Enter to send)"
                      className="flex-1 min-h-[60px] max-h-[120px] resize-none text-sm"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                    <Button
                      onClick={handleSend}
                      disabled={!replyText.trim() || isSending}
                      className="h-10 px-4"
                      style={{ backgroundColor: PROVIDER_COLORS[selectedChat.provider] }}
                    >
                      {isSending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Sending via {PROVIDER_LABELS[selectedChat.provider] ?? selectedChat.provider}
                  </p>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <MessageSquare className="h-12 w-12 opacity-30" />
                <p className="text-sm">Select a conversation to start messaging</p>
                <p className="text-xs opacity-60">← Pick from the list on the left</p>
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
