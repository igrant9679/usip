/**
 * MailboxesSection — Settings → Mailboxes (internal SettingsHub subpage).
 *
 * Empty state → "Link mailbox" opens the GuidedMailboxSetup wizard; once
 * accounts exist, a horizontally-scrollable table lists them with setup
 * progress, warmup toggle, live daily-limit usage (sentToday from
 * sending_account_daily_stats), deliverability (reputation/connection from
 * sendingAccounts.testConnection), aliases popover, header tooltips, and a
 * row action menu (refresh aliases / configure / check deliverability /
 * unlink). All data comes from the real sending-accounts backend.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Mail,
  Search,
  Info,
  Link2,
  ChevronDown,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  Activity,
  Trash2,
  Loader2,
  SearchX,
} from "lucide-react";
import {
  GuidedMailboxSetup,
  ProviderTile,
  setupProgress,
  setupComplete,
  limeBtn,
  type MailboxAccount,
} from "./GuidedMailboxSetup";

const HEADER_TIPS: Record<string, string> = {
  Setup:
    "Mailbox health encompasses the overall well-being of an email account, maintained through proper authentication, sending limits, opt-out links, and other email configurations. A healthy mailbox ensures reliable email delivery to inboxes without issues.",
  Warmup: "Warming up gradually raises sending volume so providers trust the mailbox. Learn more in the Deliverability suite.",
  Deliverability:
    'Deliverability scores enable you to monitor mailbox health based on factors such as spam rate, open rate, bounce rate, and more. Choose "Check deliverability" in the dropdown menu to generate insights and suggestions to improve your email deliverability.',
  "Last Synced": "Email last synced at",
};

const ALIAS_HELP =
  "Add alternate email addresses (email aliases) in Gmail under Account > Settings > Send mail as. After adding, you'll need to refresh the aliases here.";

export function MailboxesSection() {
  const utils = trpc.useUtils();
  const accountsQ = trpc.sendingAccounts.list.useQuery();
  const accounts = (accountsQ.data ?? []) as MailboxAccount[];

  const [query, setQuery] = useState("");
  const [wizard, setWizard] = useState<{ open: boolean; account?: MailboxAccount | null; step?: any }>({ open: false });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => {
      const aliases = Array.isArray(a.aliases) ? (a.aliases as string[]) : [];
      return (
        String(a.fromEmail).toLowerCase().includes(q) ||
        String(a.provider).toLowerCase().includes(q) ||
        String(a.fromName ?? "").toLowerCase().includes(q) ||
        aliases.some((al) => al.toLowerCase().includes(q))
      );
    });
  }, [accounts, query]);

  const openSetup = () => setWizard({ open: true, account: null, step: "provider" });
  const openConfigure = (a: MailboxAccount) =>
    setWizard({ open: true, account: a, step: setupComplete(a) ? "overview" : "overview" });

  return (
    <TooltipProvider delayDuration={200}>
      {/* header */}
      <div className="shrink-0 px-6 pt-4">
        <h1 className="text-xl font-semibold tracking-tight">Mailboxes</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40 mt-3 border-t border-border">
        <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-6">
          {accountsQ.isLoading ? (
            <div className="h-64 rounded-xl bg-card/70 animate-pulse" />
          ) : accounts.length === 0 ? (
            /* ── empty state ── */
            <div className="rounded-xl border border-border/70 bg-card px-6 py-20 text-center shadow-sm">
              <span className="relative inline-flex">
                <Mail className="size-14 text-foreground" strokeWidth={1} />
                <span className="absolute -right-4 -top-2.5 flex size-7 items-center justify-center rounded-full bg-foreground text-background">
                  <Link2 className="size-3.5" />
                </span>
              </span>
              <h2 className="mt-8 text-[17px] font-semibold">Add your mailbox to get started</h2>
              <p className="mx-auto mt-2 max-w-lg text-[13.5px] leading-relaxed text-muted-foreground">
                Connect your mailbox to scale outreach, improve deliverability, and unlock features like
                sequences, meetings, and more.
              </p>
              <button type="button" className={cn(limeBtn, "mt-6")} onClick={openSetup}>
                Link mailbox
              </button>
            </div>
          ) : (
            /* ── populated table ── */
            <div className="rounded-xl border border-border/70 bg-card shadow-sm">
              <div className="flex flex-wrap items-center gap-3 px-4 py-4">
                <h2 className="text-[16px] font-semibold">My mailboxes</h2>
                <span className="rounded-full bg-stone-200/70 px-2.5 py-1 text-[11.5px] font-medium text-stone-700 dark:bg-stone-700/50 dark:text-stone-300">
                  {accounts.length} {accounts.length === 1 ? "mailbox" : "mailboxes"} linked
                </span>
                <div className="flex-1" />
                <div className="flex h-9 w-56 items-center gap-2 rounded-md border border-border bg-background px-2.5">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search"
                    className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                  />
                </div>
                <button type="button" className={limeBtn} onClick={openSetup}>
                  Link mailbox
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      {["Mailbox", "Type", "Setup", "Warmup", "Daily Limit", "Deliverability", "Last Synced", "Hourly Limit", "Forwarding Email", "Warmup Billing", ""].map((h) => (
                        <th
                          key={h || "actions"}
                          className={cn(
                            "whitespace-nowrap border-b border-border bg-card px-3 py-2 font-semibold",
                            h === "Mailbox" && "min-w-[260px]",
                            // actions column stays pinned to the right edge under horizontal scroll
                            h === "" && "sticky right-0 z-20 w-10 border-l border-border",
                          )}
                        >
                          <span className="inline-flex items-center gap-1">
                            {h}
                            {HEADER_TIPS[h] && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button type="button" aria-label={`About ${h}`} className="text-muted-foreground/70 hover:text-foreground">
                                    <Info className="size-3" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs text-center leading-relaxed normal-case tracking-normal">
                                  {HEADER_TIPS[h]}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">
                          No mailboxes match "{query}"
                        </td>
                      </tr>
                    ) : (
                      filtered.map((a) => (
                        <MailboxRow key={a.id} a={a} onConfigure={() => openConfigure(a)} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <GuidedMailboxSetup
        open={wizard.open}
        account={wizard.account ?? null}
        initialStep={wizard.account ? "overview" : "provider"}
        onClose={() => {
          setWizard({ open: false });
          utils.sendingAccounts.list.invalidate();
        }}
      />
    </TooltipProvider>
  );
}

/* ─────────────────────────────── row ──────────────────────────────────── */

function MailboxRow({ a, onConfigure }: { a: MailboxAccount; onConfigure: () => void }) {
  const utils = trpc.useUtils();
  const aliases = Array.isArray(a.aliases) ? (a.aliases as string[]) : [];
  const progress = setupProgress(a);
  const warmupOn = a.warmupStatus === "in_progress" || a.warmupStatus === "complete";

  const update = trpc.sendingAccounts.update.useMutation({
    onSuccess: () => utils.sendingAccounts.list.invalidate(),
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const refreshAliases = trpc.sendingAccounts.refreshAliases.useMutation({
    onSuccess: (r: any) => {
      utils.sendingAccounts.list.invalidate();
      toast.info(
        r.providerSynced
          ? `Aliases refreshed — ${r.aliases.length} found`
          : "Aliases re-read — provider alias sync needs an OAuth connection (not set up yet)",
      );
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not refresh aliases"),
  });
  const checkDeliv = trpc.sendingAccounts.testConnection.useMutation({
    onSuccess: (r: any) => {
      utils.sendingAccounts.list.invalidate();
      if (r.ok) toast.success("Connection verified — reputation updated");
      else toast.error(r.error ?? "Connection check failed");
    },
    onError: (e: any) => toast.error(e?.message ?? "Deliverability check failed"),
  });
  const del = trpc.sendingAccounts.delete.useMutation({
    onSuccess: () => {
      utils.sendingAccounts.list.invalidate();
      toast.success(`${a.fromEmail} unlinked`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not unlink"),
  });

  const deliverability =
    a.connectionStatus === "untested"
      ? null
      : a.connectionStatus === "error"
        ? { label: "Connection error", cls: "text-rose-600" }
        : { label: `${String(a.reputationTier ?? "good")[0].toUpperCase()}${String(a.reputationTier ?? "good").slice(1)}`, cls: a.reputationTier === "poor" ? "text-rose-600" : a.reputationTier === "fair" ? "text-amber-600" : "text-emerald-600" };

  const cell = "border-b border-border/60 px-3 py-2.5 align-middle whitespace-nowrap";
  // Solid row bg (incl. hover) so the sticky-right actions cell's bg-inherit
  // never lets scrolled content bleed through — see People.tsx sticky note.
  return (
    <tr className="bg-background transition-colors hover:bg-muted">
      {/* Mailbox */}
      <td className={cell}>
        <div className="flex items-center gap-2.5">
          <ProviderTile provider={a.provider} email={a.fromEmail} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium">{a.fromEmail}</span>
              {a.isDefault && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10.5px] font-medium text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200">Default</span>
              )}
            </div>
            <AliasesPopover a={a} aliases={aliases} refreshing={refreshAliases.isPending} onRefresh={() => refreshAliases.mutate({ id: a.id })} />
          </div>
        </div>
      </td>
      {/* Type */}
      <td className={cell}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex rounded p-1 text-muted-foreground"><Link2 className="size-4" /></span>
          </TooltipTrigger>
          <TooltipContent side="top">{a.provider === "generic_smtp" ? "SMTP/IMAP connection" : a.provider === "google_oauth" ? "Google account" : a.provider === "outlook_oauth" ? "Outlook account" : "Amazon SES"}</TooltipContent>
        </Tooltip>
      </td>
      {/* Setup */}
      <td className={cell}>
        <div className="w-44">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", progress === 100 ? "bg-emerald-500" : "bg-foreground")}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3 text-[12px]">
            <button type="button" onClick={onConfigure} className="font-medium text-foreground hover:underline">
              See details
            </button>
            <span className="text-muted-foreground">{progress}% Completed</span>
          </div>
        </div>
      </td>
      {/* Warmup */}
      <td className={cell}>
        <label className="flex cursor-pointer items-center gap-2">
          <Switch
            checked={warmupOn}
            disabled={update.isPending}
            onCheckedChange={(v) => update.mutate({ id: a.id, warmupStatus: v ? "in_progress" : "not_started" } as any)}
          />
          <span className="text-[13px] text-foreground">{warmupOn ? "Warming up" : "Start warm up"}</span>
        </label>
      </td>
      {/* Daily limit */}
      <td className={cn(cell, "tabular-nums")}>{a.sentToday ?? 0} / {a.dailySendLimit ?? 50}</td>
      {/* Deliverability */}
      <td className={cell}>
        {deliverability ? (
          <span className={cn("text-[12.5px] font-medium", deliverability.cls)}>{deliverability.label}</span>
        ) : (
          <span className="text-[12.5px] text-muted-foreground">No data available</span>
        )}
      </td>
      {/* Last synced */}
      <td className={cn(cell, "text-muted-foreground")}>
        {a.lastTestedAt ? new Date(a.lastTestedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}
      </td>
      {/* Hourly limit */}
      <td className={cn(cell, "tabular-nums")}>{a.hourlySendLimit ?? 6}</td>
      {/* Forwarding email */}
      <td className={cn(cell, "text-muted-foreground")}>{a.forwardingEmail ?? "—"}</td>
      {/* Warmup billing */}
      <td className={cn(cell, "text-muted-foreground")}>—</td>
      {/* actions — pinned to the right edge */}
      <td className={cn(cell, "w-10 sticky right-0 z-10 bg-inherit border-l border-border/60")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Actions for ${a.fromEmail}`} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem disabled={refreshAliases.isPending} onClick={() => refreshAliases.mutate({ id: a.id })}>
              {refreshAliases.isPending ? <Loader2 className="size-4 mr-2 animate-spin" /> : <RefreshCw className="size-4 mr-2" />} Refresh aliases
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onConfigure}>
              <Settings2 className="size-4 mr-2" /> Configure mailbox
            </DropdownMenuItem>
            <DropdownMenuItem disabled={checkDeliv.isPending} onClick={() => checkDeliv.mutate({ id: a.id })}>
              {checkDeliv.isPending ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Activity className="size-4 mr-2" />} Check deliverability
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-rose-600 focus:text-rose-600"
              disabled={del.isPending}
              onClick={() => {
                if (confirm(`Unlink ${a.fromEmail}? Sequences using this mailbox will stop sending from it.`)) {
                  del.mutate({ id: a.id });
                }
              }}
            >
              <Trash2 className="size-4 mr-2" /> Unlink mailbox
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

/* ───────────────────────── aliases popover ────────────────────────────── */

function AliasesPopover({
  a, aliases, refreshing, onRefresh,
}: {
  a: MailboxAccount;
  aliases: string[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-0.5 text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-400">
              {aliases.length} email alias{aliases.length === 1 ? "" : "es"}
              <ChevronDown className="size-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-center leading-relaxed">{ALIAS_HELP}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 p-0">
        {aliases.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-7 text-center">
            <SearchX className="size-9 text-orange-500" strokeWidth={1.75} />
            <div className="mt-3 text-[13.5px] font-semibold">No email aliases found.</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{ALIAS_HELP}</p>
            <button
              type="button"
              disabled={refreshing}
              onClick={onRefresh}
              className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-sky-700 hover:underline disabled:opacity-60 dark:text-sky-400"
            >
              {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh aliases
            </button>
          </div>
        ) : (
          <div className="p-2">
            <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Aliases for {a.fromEmail}
            </div>
            {aliases.map((al) => (
              <div key={al} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
                <Mail className="size-3.5 text-muted-foreground" /> {al}
              </div>
            ))}
            <div className="border-t border-border/70 p-1.5">
              <Button variant="outline" size="sm" className="w-full gap-1.5" disabled={refreshing} onClick={onRefresh}>
                {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh aliases
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
