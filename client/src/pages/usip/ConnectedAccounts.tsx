import { useState } from "react";
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

function StatusBadge({ status }: { status: string }) {
  if (status === "OK" || status === "CONNECTED") {
    return <Badge className="bg-green-500/15 text-green-600 border-green-500/30 gap-1"><CheckCircle2 className="h-3 w-3" />Connected</Badge>;
  }
  if (status === "CONNECTING" || status === "PENDING") {
    return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 gap-1"><Loader2 className="h-3 w-3 animate-spin" />Connecting</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 gap-1"><AlertCircle className="h-3 w-3" />Error</Badge>;
}

// ─── Connect Dialog ───────────────────────────────────────────────────────────

function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
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
      });
      // Open Unipile Hosted Auth Wizard in a new tab
      window.open(url, "_blank", "noopener,noreferrer");
      onOpenChange(false);
      toast.success("Auth window opened", { description: "Complete the connection in the new tab, then refresh this page." });
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
  const utils = trpc.useUtils();

  const { data: accounts = [], isLoading, refetch } = trpc.unipile.listConnectedAccounts.useQuery();
  const disconnect = trpc.unipile.disconnectAccount.useMutation({
    onSuccess: () => {
      utils.unipile.listConnectedAccounts.invalidate();
      toast.success("Account disconnected");
    },
    onError: (err) => toast.error("Failed to disconnect", { description: err.message }),
  });
  const generateLink = trpc.unipile.generateConnectLink.useMutation();

  const handleReconnect = async (unipileAccountId: string) => {
    try {
      const { url } = await generateLink.mutateAsync({ reconnectAccountId: unipileAccountId });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error("Failed to generate reconnect link", { description: String(err) });
    }
  };

  // Group accounts by provider
  const byProvider = accounts.reduce<Record<string, typeof accounts>>((acc, a) => {
    if (!acc[a.provider]) acc[a.provider] = [];
    acc[a.provider].push(a);
    return acc;
  }, {});

  return (
    <Shell>
      <PageHeader
        title="Connected Accounts"
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
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                              {acc.profilePicture ? (
                                <img
                                  src={acc.profilePicture}
                                  alt={acc.displayName ?? ""}
                                  className="h-10 w-10 rounded-full object-cover"
                                />
                              ) : (
                                <ProviderIcon providerId={acc.provider} size={40} />
                              )}
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
                              className="flex-1"
                              onClick={() => handleReconnect(acc.unipileAccountId)}
                            >
                              <RefreshCw className="h-3 w-3 mr-1" />
                              Reconnect
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

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </Shell>
  );
}
