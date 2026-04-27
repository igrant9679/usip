import React, { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Plug,
  RefreshCw,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  Wifi,
  WifiOff,
  TriangleAlert,
  XCircle,
} from "lucide-react";


// ─── Provider definitions ─────────────────────────────────────────────────────

const PROVIDERS = [
  { id: "LINKEDIN",  label: "LinkedIn",    color: "#0A66C2", bg: "bg-[#0A66C2]", textColor: "text-white", emoji: "💼", description: "Connect requests, DMs, InMail" },
  { id: "WHATSAPP",  label: "WhatsApp",    color: "#25D366", bg: "bg-[#25D366]", textColor: "text-white", emoji: "💬", description: "Business messaging" },
  { id: "INSTAGRAM", label: "Instagram",   color: "#E1306C", bg: "bg-[#E1306C]", textColor: "text-white", emoji: "📸", description: "DMs and story replies" },
  { id: "MESSENGER", label: "Messenger",   color: "#0084FF", bg: "bg-[#0084FF]", textColor: "text-white", emoji: "💙", description: "Facebook Messenger" },
  { id: "TELEGRAM",  label: "Telegram",    color: "#2AABEE", bg: "bg-[#2AABEE]", textColor: "text-white", emoji: "✈️", description: "Channels and direct messages" },
  { id: "TWITTER",   label: "X (Twitter)", color: "#000000", bg: "bg-black",     textColor: "text-white", emoji: "𝕏", description: "Direct messages" },
  { id: "GOOGLE",    label: "Gmail",       color: "#EA4335", bg: "bg-[#EA4335]", textColor: "text-white", emoji: "📧", description: "Full email inbox sync" },
  { id: "MICROSOFT", label: "Outlook",     color: "#0078D4", bg: "bg-[#0078D4]", textColor: "text-white", emoji: "📨", description: "Microsoft 365 / Outlook" },
  { id: "IMAP",      label: "IMAP Email",  color: "#6B7280", bg: "bg-gray-500",  textColor: "text-white", emoji: "📮", description: "Any IMAP-compatible email" },
];

function ProviderIcon({ providerId, size = 32 }: { providerId: string; size?: number }) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return <div style={{ width: size, height: size }} className="rounded-full bg-muted flex items-center justify-center text-xs">?</div>;
  return (
    <div
      className={`${p.bg} ${p.textColor} rounded-full flex items-center justify-center font-bold`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {p.emoji}
    </div>
  );
}

// Statuses that mean the account needs re-authentication
const EXPIRED_STATUSES = new Set(["CREDENTIALS", "ERROR", "STOPPED"]);

function StatusBadge({ status }: { status: string }) {
  if (status === "OK" || status === "CONNECTED") {
    return <Badge className="bg-green-500/15 text-green-600 border-green-500/30 gap-1"><CheckCircle2 className="h-3 w-3" />Connected</Badge>;
  }
  if (status === "CONNECTING" || status === "PENDING") {
    return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 gap-1"><Loader2 className="h-3 w-3 animate-spin" />Connecting</Badge>;
  }
  if (status === "CREDENTIALS") {
    return <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 gap-1"><TriangleAlert className="h-3 w-3" />Credentials expired</Badge>;
  }
  if (status === "STOPPED" || status === "ERROR") {
    return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 gap-1"><XCircle className="h-3 w-3" />{status === "STOPPED" ? "Stopped" : "Error"}</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 gap-1"><AlertCircle className="h-3 w-3" />Disconnected</Badge>;
}

// ─── Connect Dialog ───────────────────────────────────────────────────────────

function ConnectDialog({
  open,
  onOpenChange,
  onConnecting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConnecting?: () => void;
}) {
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const generateLink = trpc.unipile.generateConnectLink.useMutation();

  const toggleProvider = (id: string) => {
    setSelectedProviders((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const { url } = await generateLink.mutateAsync({
        providers: selectedProviders.length ? selectedProviders : undefined,
        origin: window.location.origin,
      });
      // Open Unipile Hosted Auth Wizard in a new tab.
      // Unipile will redirect back to /connected-accounts?connected=1 on success.
      window.open(url, "_blank", "noopener,noreferrer");
      onOpenChange(false);
      onConnecting?.();
      toast.success("Auth window opened", { description: "Complete the connection in the new tab — this page will refresh automatically when you return." });
    } catch (err) {
      toast.error("Failed to generate connect link", { description: String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-violet-500" />
            Connect a Channel
          </DialogTitle>
          <DialogDescription>
            Select one or more channels to connect. You'll be redirected to a secure Unipile authentication page to complete the connection.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 py-4">
          {PROVIDERS.map((p) => {
            const selected = selectedProviders.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() => toggleProvider(p.id)}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-left ${
                  selected
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-border hover:border-violet-300 hover:bg-muted/50"
                }`}
              >
                <ProviderIcon providerId={p.id} size={40} />
                <div>
                  <p className="font-semibold text-sm text-center">{p.label}</p>
                  <p className="text-xs text-muted-foreground text-center">{p.description}</p>
                </div>
                {selected && <CheckCircle2 className="h-4 w-4 text-violet-500" />}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t">
          <p className="text-sm text-muted-foreground">
            {selectedProviders.length === 0
              ? "All channels will be available"
              : `${selectedProviders.length} channel${selectedProviders.length > 1 ? "s" : ""} selected`}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              onClick={handleConnect}
              disabled={isLoading}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ExternalLink className="h-4 w-4 mr-2" />}
              Open Auth Wizard
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ConnectedAccounts() {
  const [connectOpen, setConnectOpen] = useState(false);
  // True while the user has the Unipile auth tab open (cleared after 5 min or on ?connected=1)
  const [isConnecting, setIsConnecting] = useState(false);
  const connectingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utils = trpc.useUtils();
  const { data: accounts = [], isLoading, refetch } = trpc.unipile.listConnectedAccounts.useQuery(
    undefined,
    {
      // Poll every 8s so the new account appears quickly after the user returns
      // from the Unipile auth tab (webhook fires within ~2s of completion).
      refetchInterval: 8_000,
      refetchIntervalInBackground: false,
    },
  );
  const disconnect = trpc.unipile.disconnectAccount.useMutation({
    onSuccess: () => {
      utils.unipile.listConnectedAccounts.invalidate();
      toast.success("Account disconnected");
    },
    onError: (err) => toast.error("Failed to disconnect", { description: err.message }),
  });
  const generateLink = trpc.unipile.generateConnectLink.useMutation();
  const [isReconnectingAll, setIsReconnectingAll] = useState(false);
  const handleReconnectAll = async () => {
    const expired = accounts.filter((a) => EXPIRED_STATUSES.has(a.status));
    if (expired.length === 0) return;
    setIsReconnectingAll(true);
    try {
      for (const acc of expired) {
        const { url } = await generateLink.mutateAsync({
          reconnectAccountId: acc.unipileAccountId,
          origin: window.location.origin,
        });
        window.open(url, '_blank', 'noopener,noreferrer');
        // Small delay between tabs to avoid popup blockers
        await new Promise((r) => setTimeout(r, 600));
      }
      setIsConnecting(true);
      if (connectingTimerRef.current) clearTimeout(connectingTimerRef.current);
      connectingTimerRef.current = setTimeout(() => setIsConnecting(false), 5 * 60 * 1000);
    } catch (err) {
      toast.error('Failed to generate reconnect links', { description: String(err) });
    } finally {
      setIsReconnectingAll(false);
    }
  };
  const handleReconnect = async (unipileAccountId: string) => {
    try {
      const { url } = await generateLink.mutateAsync({
        reconnectAccountId: unipileAccountId,
        origin: window.location.origin,
      });
      window.open(url, "_blank", "noopener,noreferrer");
      setIsConnecting(true);
      if (connectingTimerRef.current) clearTimeout(connectingTimerRef.current);
      connectingTimerRef.current = setTimeout(() => setIsConnecting(false), 5 * 60 * 1000);
    } catch (err) {
      toast.error("Failed to generate reconnect link", { description: String(err) });
    }
  };

  // When Unipile redirects back with ?connected=1, immediately refetch and
  // show a success toast, then clean the query param from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      setIsConnecting(false);
      if (connectingTimerRef.current) clearTimeout(connectingTimerRef.current);
      refetch();
      toast.success("Account connected!", { description: "Your new account is now visible below." });
      // Remove the query param without a page reload
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Group accounts by provider
  const byProvider = accounts.reduce<Record<string, typeof accounts>>((acc, a) => {
    if (!acc[a.provider]) acc[a.provider] = [];
    acc[a.provider].push(a);
    return acc;
  }, {});

  return (
    <Shell>
      <PageHeader
        title="Connected Accounts" pageKey="connected-accounts"
        subtitle="Manage your multichannel connections — LinkedIn, email, messaging, and more"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button
              size="sm"
              className="bg-violet-600 hover:bg-violet-700 text-white"
              onClick={() => setConnectOpen(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Connect Account
            </Button>
          </div>
        }
      />
      {/* Connecting banner - shown while auth tab is open */}
      {isConnecting && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span className="font-medium">Connecting...</span>
          <span className="text-amber-600">Complete the authentication in the new tab. This page will update automatically when the connection is established.</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-amber-700 hover:bg-amber-500/20 h-6 px-2 text-xs"
            onClick={() => setIsConnecting(false)}
          >
            Dismiss
          </Button>
        </div>
      )}
      {/* Expired credentials banner - shown when any account needs re-auth */}
      {accounts.some((a) => EXPIRED_STATUSES.has(a.status)) && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-start gap-3">
              <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
              <div className="text-amber-800">
                <span className="font-semibold">Action required: </span>
                <span>
                  {accounts.filter((a) => EXPIRED_STATUSES.has(a.status)).length} account{accounts.filter((a) => EXPIRED_STATUSES.has(a.status)).length > 1 ? "s" : ""} need{accounts.filter((a) => EXPIRED_STATUSES.has(a.status)).length === 1 ? "s" : ""} to be reconnected to restore access.
                </span>
              </div>
            </div>
            {accounts.filter((a) => EXPIRED_STATUSES.has(a.status)).length > 1 && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-amber-500 text-amber-800 hover:bg-amber-500/20 hover:border-amber-600 font-medium text-xs"
                onClick={handleReconnectAll}
                disabled={isReconnectingAll || generateLink.isPending}
              >
                {isReconnectingAll ? (
                  <><Loader2 className="h-3 w-3 animate-spin mr-1" />Opening tabs…</>
                ) : (
                  "Reconnect all"
                )}
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2 pl-7">
            {accounts.filter((a) => EXPIRED_STATUSES.has(a.status)).map((acc) => (
              <div key={acc.unipileAccountId} className="flex items-center justify-between gap-3 rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium text-amber-900 uppercase tracking-wide">{acc.provider}</span>
                  <span className="text-amber-800 truncate">{acc.accountName || acc.unipileAccountId}</span>
                  <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 bg-amber-100 shrink-0">
                    {acc.status === "CREDENTIALS" ? "Token expired" : acc.status === "ERROR" ? "Error" : "Stopped"}
                  </Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 border-amber-500 text-amber-800 hover:bg-amber-500/20 hover:border-amber-600 font-medium"
                  onClick={() => handleReconnect(acc.unipileAccountId)}
                  disabled={generateLink.isPending}
                >
                  {generateLink.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Reconnect"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="p-6 space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          <Card className="border-violet-500/30 bg-violet-500/5">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <Wifi className="h-8 w-8 text-violet-500" />
                <div>
                  <p className="text-2xl font-bold text-violet-500">{accounts.filter(a => a.status === "OK" || a.status === "CONNECTED").length}</p>
                  <p className="text-xs text-muted-foreground">Active connections</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <Loader2 className="h-8 w-8 text-amber-500" />
                <div>
                  <p className="text-2xl font-bold text-amber-500">{accounts.filter(a => a.status === "CONNECTING" || a.status === "PENDING").length}</p>
                  <p className="text-xs text-muted-foreground">Connecting</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-red-500/30 bg-red-500/5">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <WifiOff className="h-8 w-8 text-red-500" />
                <div>
                  <p className="text-2xl font-bold text-red-500">{accounts.filter(a => a.status !== "OK" && a.status !== "CONNECTED" && a.status !== "CONNECTING" && a.status !== "PENDING").length}</p>
                  <p className="text-xs text-muted-foreground">Needs attention</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : accounts.length === 0 ? (
          <Card className="border-dashed border-2">
            <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="h-16 w-16 rounded-full bg-violet-500/10 flex items-center justify-center">
                <Plug className="h-8 w-8 text-violet-500" />
              </div>
              <div className="text-center">
                <h3 className="font-semibold text-lg">No accounts connected yet</h3>
                <p className="text-muted-foreground text-sm mt-1">
                  Connect your LinkedIn, email, and messaging accounts to start multichannel outreach.
                </p>
              </div>
              <Button
                className="bg-violet-600 hover:bg-violet-700 text-white"
                onClick={() => setConnectOpen(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Connect Your First Account
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {Object.entries(byProvider).map(([provider, provAccounts]) => {
              const meta = PROVIDERS.find((p) => p.id === provider);
              return (
                <div key={provider}>
                  <div className="flex items-center gap-2 mb-3">
                    <ProviderIcon providerId={provider} size={24} />
                    <h3 className="font-semibold">{meta?.label ?? provider}</h3>
                    <Badge variant="secondary">{provAccounts.length}</Badge>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {provAccounts.map((acc) => (
                      <Card key={acc.id} className="hover:shadow-md transition-shadow">
                        <CardHeader className={`pb-2 ${EXPIRED_STATUSES.has(acc.status) ? "border-b border-amber-400/30 bg-amber-500/5 rounded-t-lg" : ""}`}>
                          {EXPIRED_STATUSES.has(acc.status) && (
                            <div className="flex items-center gap-1.5 text-xs text-amber-700 font-medium mb-2">
                              <TriangleAlert className="h-3.5 w-3.5" />
                              This account needs to be reconnected
                            </div>
                          )}
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                              <div className="relative">
                                {acc.profilePicture ? (
                                  <img
                                    src={acc.profilePicture}
                                    alt={acc.displayName ?? ""}
                                    className="h-10 w-10 rounded-full object-cover"
                                  />
                                ) : (
                                  <ProviderIcon providerId={acc.provider} size={40} />
                                )}
                                {EXPIRED_STATUSES.has(acc.status) && (
                                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 ring-2 ring-background">
                                    <TriangleAlert className="h-2.5 w-2.5 text-white" />
                                  </span>
                                )}
                              </div>
                              <div>
                                <CardTitle className="text-sm">
                                  {acc.displayName ?? acc.unipileAccountId}
                                </CardTitle>
                                <CardDescription className="text-xs">
                                  {acc.unipileAccountId}
                                </CardDescription>
                              </div>
                            </div>
                            <StatusBadge status={acc.status} />
                          </div>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
                            <span>
                              {acc.connectedAt
                                ? `Connected ${new Date(acc.connectedAt).toLocaleDateString()}`
                                : "Not yet connected"}
                            </span>
                            {acc.lastSyncAt && (
                              <span>Synced {new Date(acc.lastSyncAt).toLocaleTimeString()}</span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className={`flex-1 ${EXPIRED_STATUSES.has(acc.status) ? "border-amber-400 text-amber-700 hover:bg-amber-500/10 hover:border-amber-500 font-medium" : ""}`}
                              onClick={() => handleReconnect(acc.unipileAccountId)}
                            >
                              <RefreshCw className="h-3 w-3 mr-1" />
                              {EXPIRED_STATUSES.has(acc.status) ? "Reconnect now" : "Reconnect"}
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="outline" size="sm" className="text-red-500 hover:text-red-600 hover:border-red-300">
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Disconnect account?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will remove the {meta?.label ?? provider} account "{acc.displayName ?? acc.unipileAccountId}" from Velocity. Your messages and activities will remain in the system.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-red-600 hover:bg-red-700"
                                    onClick={() => disconnect.mutate({ unipileAccountId: acc.unipileAccountId })}
                                  >
                                    Disconnect
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Available channels to connect */}
        {accounts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Add More Channels</CardTitle>
              <CardDescription>Connect additional platforms to expand your outreach</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.filter((p) => !byProvider[p.id]).map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => setConnectOpen(true)}
                  >
                    <ProviderIcon providerId={p.id} size={16} />
                    {p.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <ConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnecting={() => {
          setIsConnecting(true);
          if (connectingTimerRef.current) clearTimeout(connectingTimerRef.current);
          connectingTimerRef.current = setTimeout(() => setIsConnecting(false), 5 * 60 * 1000);
        }}
      />
    </Shell>
  );
}
