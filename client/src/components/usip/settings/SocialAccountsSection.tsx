/**
 * SocialAccountsSection — connect + manage the social accounts used for
 * LEAD GENERATION (/v2/settings/social-accounts).
 *
 * Scope (user-directed): these accounts exist to TARGET PROSPECTS and SEND
 * DIRECT MESSAGES. They are deliberately NOT a content-publishing surface —
 * the post/share tooling lives on /social and is out of scope here.
 *
 * This reuses the working Unipile hosted-auth flow rather than adding a second
 * one: generateConnectLink → hosted wizard → account-webhook upserts the row
 * (owned by whoever clicked Connect) → we poll listConnectedAccounts. Connect,
 * reconnect and disconnect are all existing procs.
 *
 * What this adds over the standalone /connected-accounts page:
 *   - lives in Settings, filtered to SOCIAL providers only (mailbox providers
 *     MICROSOFT/IMAP belong in Settings › Mailboxes and are pointed there)
 *   - a per-account CAPABILITY view — which lead-gen features each account
 *     actually switches on (that mapping existed only server-side)
 *   - the enrichment rate meter (used/remaining of the 100/day per-account cap)
 *   - an admin view of the WORKSPACE POOL, because the sequence engine and
 *     Social Autopilot draw from any LinkedIn account in the workspace, not
 *     just the caller's own.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Send,
  MessageSquare,
  Sparkles,
  UserPlus,
  Mail,
  Users,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

/** Providers that serve lead-gen (search / invite / DM). Everything NOT in this
 *  allowlist is treated as a non-social (email) account and listed separately
 *  rather than filtered away — the stored provider string is whatever Unipile
 *  wrote, and it does NOT always match the label constants (a live Outlook row
 *  stores "OUTLOOK", not "MICROSOFT"). Using an allowlist for social + a
 *  catch-all for the rest means no connected account can silently disappear. */
const SOCIAL_PROVIDERS = ["LINKEDIN", "WHATSAPP", "INSTAGRAM", "MESSENGER", "TELEGRAM", "TWITTER"] as const;
const isSocial = (p: unknown) => SOCIAL_PROVIDERS.includes(String(p ?? "").toUpperCase() as any);

const PROVIDER_META: Record<string, { label: string; color: string }> = {
  LINKEDIN: { label: "LinkedIn", color: "#0A66C2" },
  WHATSAPP: { label: "WhatsApp", color: "#25D366" },
  INSTAGRAM: { label: "Instagram", color: "#E1306C" },
  MESSENGER: { label: "Messenger", color: "#0084FF" },
  TELEGRAM: { label: "Telegram", color: "#2AABEE" },
  TWITTER: { label: "X (Twitter)", color: "#000000" },
  MICROSOFT: { label: "Outlook", color: "#0078D4" },
  OUTLOOK: { label: "Outlook", color: "#0078D4" },
  GOOGLE: { label: "Gmail", color: "#EA4335" },
  GMAIL: { label: "Gmail", color: "#EA4335" },
  IMAP: { label: "IMAP Email", color: "#6B7280" },
};

/** Statuses Unipile reports when an account has stopped working and the owner
 *  must re-authorise. Anything else that isn't OK/CONNECTING is shown as-is. */
const NEEDS_REAUTH = ["CREDENTIALS", "ERROR", "STOPPED"];

/**
 * What a connected account actually powers, per provider. LinkedIn is the only
 * provider wired to search / invites / enrichment in this codebase; the other
 * social providers are messaging-only (DMs + unified inbox). Kept honest —
 * every chip here maps to a real server-side consumer.
 */
function capabilitiesFor(provider: string): Array<{ icon: any; label: string }> {
  if (provider === "LINKEDIN") {
    return [
      { icon: Search, label: "Prospect search & targeting" },
      { icon: UserPlus, label: "Connection invites" },
      { icon: MessageSquare, label: "Direct messages" },
      { icon: Sparkles, label: "Profile enrichment" },
    ];
  }
  return [
    { icon: MessageSquare, label: "Direct messages" },
    { icon: Send, label: "Unified inbox" },
  ];
}

function StatusPill({ status }: { status: string }) {
  const s = (status || "").toUpperCase();
  const ok = s === "OK";
  const connecting = s === "CONNECTING";
  const reauth = NEEDS_REAUTH.includes(s);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        ok && "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
        connecting && "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
        reauth && "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200",
        !ok && !connecting && !reauth && "bg-muted text-muted-foreground",
      )}
    >
      {ok ? "Connected" : connecting ? "Connecting…" : reauth ? "Needs reconnect" : s || "Unknown"}
    </span>
  );
}

function Card({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 sm:p-6 space-y-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SocialAccountsSection() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // Poll while a hosted-auth window is open — the account row only appears once
  // Unipile calls our webhook back, which is a few seconds after the user
  // finishes the wizard in the other tab.
  const [awaitingConnect, setAwaitingConnect] = useState(false);
  const accountsQ = trpc.unipile.listConnectedAccounts.useQuery(undefined, {
    refetchInterval: awaitingConnect ? 8000 : false,
  });
  // Admin-only workspace pool + per-account enrichment usage. For reps this
  // returns just their own accounts, which we use for the rate meter.
  const poolQ = trpc.linkedinFinder.listAccounts.useQuery();

  const connectLink = trpc.unipile.generateConnectLink.useMutation();
  const disconnect = trpc.unipile.disconnectAccount.useMutation();

  // Land back here after the hosted wizard (returnTo: "settings").
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      setAwaitingConnect(true);
      toast.success("Account connected — finishing sync…");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Stop polling once something actually lands.
  const accounts = (accountsQ.data ?? []) as any[];
  const social = useMemo(() => accounts.filter((a) => isSocial(a.provider)), [accounts]);
  // Catch-all so an unrecognised provider is still shown somewhere.
  const mailboxes = useMemo(() => accounts.filter((a) => !isSocial(a.provider)), [accounts]);
  useEffect(() => {
    if (awaitingConnect && social.length > 0) setAwaitingConnect(false);
  }, [social.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const usageByAccount = useMemo(() => {
    const m = new Map<string, { usedToday: number; remainingToday: number }>();
    for (const a of (poolQ.data?.accounts ?? []) as any[]) {
      m.set(a.unipileAccountId, { usedToday: a.usedToday ?? 0, remainingToday: a.remainingToday ?? 0 });
    }
    return m;
  }, [poolQ.data]);

  const openConnect = async (reconnectAccountId?: string) => {
    try {
      const res = await connectLink.mutateAsync({
        origin: window.location.origin,
        returnTo: "settings",
        ...(reconnectAccountId ? { reconnectAccountId } : {}),
      } as any);
      if (!res?.url) { toast.error("Could not start the connect flow"); return; }
      setAwaitingConnect(true);
      window.open(res.url, "_blank", "noopener,noreferrer");
      toast.info("Finish connecting in the new tab — this page updates automatically.");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start the connect flow");
    }
  };

  const [pendingDisconnect, setPendingDisconnect] = useState<any | null>(null);
  const doDisconnect = async () => {
    if (!pendingDisconnect) return;
    try {
      await disconnect.mutateAsync({ unipileAccountId: pendingDisconnect.unipileAccountId });
      await Promise.all([utils.unipile.listConnectedAccounts.invalidate(), utils.linkedinFinder.listAccounts.invalidate()]);
      toast.success("Account disconnected");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not disconnect the account");
    } finally {
      setPendingDisconnect(null);
    }
  };

  const dailyCap = poolQ.data?.dailyCap ?? 100;
  const isAdmin = poolQ.data?.isAdmin === true;
  // Accounts owned by OTHER members (admins only — listAccounts returns the
  // whole pool for them). These matter because the sequence engine and Social
  // Autopilot can send from any LinkedIn account in the workspace.
  const teamPool = useMemo(() => {
    if (!isAdmin) return [];
    const mine = new Set(social.map((a) => a.unipileAccountId));
    return ((poolQ.data?.accounts ?? []) as any[]).filter((a) => !mine.has(a.unipileAccountId));
  }, [isAdmin, poolQ.data, social]);

  return (
    <>
      <div className="shrink-0 px-6 pt-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Social accounts</h1>
          <p className="text-[12.5px] text-muted-foreground">
            Connect the accounts used to find prospects and send direct messages.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { utils.unipile.listConnectedAccounts.invalidate(); utils.linkedinFinder.listAccounts.invalidate(); }}
            title="Refresh"
          >
            <RefreshCw className={cn("size-3.5", accountsQ.isFetching && "animate-spin")} /> Refresh
          </Button>
          <Button size="sm" className="gap-1.5" disabled={connectLink.isPending} onClick={() => openConnect()}>
            {connectLink.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Connect account
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto w-full max-w-[820px] px-4 sm:px-6 py-6 space-y-5">
          {awaitingConnect && (
            <div className="flex items-center gap-2.5 rounded-lg border border-sky-300/60 bg-sky-50 px-4 py-2.5 text-[13px] text-sky-900 dark:border-sky-800/50 dark:bg-sky-950/30 dark:text-sky-200">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              Waiting for the account to finish connecting…
            </div>
          )}

          {/* Connected social accounts */}
          <Card
            title="Your connected accounts"
            description="These belong to you. Each one lets Velocity search for prospects and send messages as you."
          >
            {accountsQ.isLoading ? (
              <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-20 rounded-lg bg-muted/60 animate-pulse" />)}</div>
            ) : social.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center">
                <p className="text-[13px] font-medium">No social accounts connected yet</p>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted-foreground">
                  Connect LinkedIn to search for prospects, send connection invites, and message leads
                  automatically. Your account is used on your behalf — nothing is posted publicly.
                </p>
                <Button size="sm" className="mt-3 gap-1.5" disabled={connectLink.isPending} onClick={() => openConnect()}>
                  <Plus className="size-3.5" /> Connect an account
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {social.map((a) => {
                  const provider = String(a.provider).toUpperCase();
                  const meta = PROVIDER_META[provider] ?? { label: provider, color: "#6B7280" };
                  const status = String(a.status ?? "").toUpperCase();
                  const reauth = NEEDS_REAUTH.includes(status);
                  const usage = usageByAccount.get(a.unipileAccountId);
                  return (
                    <div key={a.id ?? a.unipileAccountId} className="rounded-lg border border-border/70 bg-background p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <span
                          className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[12px] font-bold text-white"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden
                        >
                          {meta.label.slice(0, 2)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13.5px] font-medium">{a.displayName || meta.label}</span>
                            <StatusPill status={status} />
                          </div>
                          <div className="text-[11.5px] text-muted-foreground">
                            {meta.label}
                            {a.connectedAt ? ` · connected ${new Date(a.connectedAt).toLocaleDateString()}` : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {reauth && (
                            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openConnect(a.unipileAccountId)}>
                              <RefreshCw className="size-3.5" /> Reconnect
                            </Button>
                          )}
                          <Button variant="outline" size="sm" onClick={() => setPendingDisconnect(a)}>Disconnect</Button>
                        </div>
                      </div>

                      {reauth && (
                        <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          This account stopped working and can't search or send until you reconnect it.
                        </div>
                      )}

                      {/* What this account powers */}
                      <div className="flex flex-wrap gap-1.5">
                        {capabilitiesFor(provider).map((c) => (
                          <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11.5px] text-foreground/80">
                            <c.icon className="size-3" /> {c.label}
                          </span>
                        ))}
                      </div>

                      {/* Enrichment rate meter (LinkedIn only — 100 lookups/day/account) */}
                      {provider === "LINKEDIN" && usage && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
                            <span>Profile lookups today</span>
                            <span>{usage.usedToday} / {dailyCap}</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${Math.min(100, Math.round((usage.usedToday / Math.max(1, dailyCap)) * 100))}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Admin: the pool the autonomous engines actually draw from */}
          {isAdmin && teamPool.length > 0 && (
            <Card
              title="Team accounts"
              description="LinkedIn accounts connected by other members. Sequences and Social Autopilot can send from any of these, so their health affects workspace-wide outreach."
            >
              <div className="space-y-2">
                {teamPool.map((a) => {
                  const status = String(a.status ?? "").toUpperCase();
                  return (
                    <div key={a.unipileAccountId} className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-4 py-2.5">
                      <Users className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{a.displayName || a.ownerName || "LinkedIn account"}</div>
                        <div className="truncate text-[11.5px] text-muted-foreground">
                          {a.ownerName ?? a.ownerEmail ?? "Unknown owner"} · {a.usedToday ?? 0}/{dailyCap} lookups today
                        </div>
                      </div>
                      <StatusPill status={status} />
                    </div>
                  );
                })}
              </div>
              <p className="text-[12px] text-muted-foreground">
                Only the account's owner can reconnect or disconnect it.
              </p>
            </Card>
          )}

          {/* Where these accounts get used */}
          <Card title="Where these accounts are used" description="Connecting an account switches these on — no extra setup needed.">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/find-prospects")}>
                <Search className="size-3.5" /> Find prospects <ExternalLink className="size-3 opacity-60" />
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/unified-inbox")}>
                <MessageSquare className="size-3.5" /> Unified inbox <ExternalLink className="size-3 opacity-60" />
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/v2/workflows")}>
                <Sparkles className="size-3.5" /> Social autopilot <ExternalLink className="size-3 opacity-60" />
              </Button>
            </div>
          </Card>

          {/* Mailbox providers land in the same Unipile table — point them home */}
          {mailboxes.length > 0 && (
            <Card title="Other connected accounts" description="Also connected through the same wizard. Email accounts are managed under Mailboxes.">
              <div className="space-y-2">
                {mailboxes.map((a) => (
                  <div key={a.id ?? a.unipileAccountId} className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-4 py-2.5">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {a.displayName || (PROVIDER_META[String(a.provider).toUpperCase()]?.label ?? a.provider)}
                      <span className="ml-1.5 text-[11.5px] text-muted-foreground">
                        {PROVIDER_META[String(a.provider).toUpperCase()]?.label ?? String(a.provider)}
                      </span>
                    </span>
                    <StatusPill status={String(a.status ?? "").toUpperCase()} />
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/v2/settings/mailboxes")}>
                <Mail className="size-3.5" /> Go to Mailboxes
              </Button>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={!!pendingDisconnect} onOpenChange={(o) => !o && setPendingDisconnect(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect this account?</DialogTitle>
            <DialogDescription>
              {pendingDisconnect?.displayName || "This account"} will stop being used for prospect search,
              invites, direct messages, and enrichment. Sequences that send from it will fail until another
              account is connected. You can reconnect at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setPendingDisconnect(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={disconnect.isPending} onClick={doDisconnect} className="gap-1.5">
              {disconnect.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
