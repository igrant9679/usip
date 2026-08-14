/**
 * SendGrid sender picker — pull the mailboxes a SendGrid key can send from
 * and link the chosen ones (owner ask 2026-08-13: "when I add a SendGrid API
 * key you should pull all of the available SendGrid senders into Velocity…
 * when I click Link mailbox the SendGrid senders should pop up for me to
 * select").
 *
 * Each linked sender becomes an ordinary sending account, which is what puts
 * it in reach of Sender Pools — pools already accept any sending account.
 *
 * Opens with a key already saved, or with one typed here for the case where
 * nothing is saved yet. A typed key is used to list and to link; it is never
 * stored by the listing call itself.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Mail, RefreshCw, ShieldCheck, ShieldAlert, Link2 } from "lucide-react";

type Sender = {
  email: string;
  name: string | null;
  replyTo: string | null;
  nickname: string | null;
  verified: boolean;
  alreadyLinked: boolean;
};

export function SendgridSenderPicker({
  open,
  onOpenChange,
  /** Passed when the owner is entering a key that has not been saved yet. */
  apiKey,
  /** Passed to use one specific mailbox's stored key. */
  accountId,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  apiKey?: string;
  accountId?: number;
  onLinked?: (count: number) => void;
}) {
  const utils = trpc.useUtils();
  const [senders, setSenders] = useState<Sender[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [customEmail, setCustomEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const list = trpc.sendingAccounts.sendgridSenders.useMutation();
  const importSenders = trpc.sendingAccounts.importSendgridSenders.useMutation();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await list.mutateAsync({ apiKey, accountId });
      setSenders(r.senders as Sender[]);
      setDomains((r as { domains?: string[] }).domains ?? []);
      setError(r.ok ? null : r.error);
      // Pre-tick everything linkable, since linking all of them is the
      // common intent — untick is cheaper than hunting for tick.
      setChecked(new Set(r.senders.filter((s) => !s.alreadyLinked && s.verified).map((s) => s.email)));
    } catch (e) {
      setError((e as Error).message || "Could not reach SendGrid");
      setSenders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, apiKey, accountId]);

  const toggle = (email: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(email)) n.delete(email); else n.add(email);
      return n;
    });

  const linkable = senders.filter((s) => !s.alreadyLinked);
  /** Is this address at a domain SendGrid has authenticated? */
  const domainAllows = (email: string) => {
    const host = email.trim().toLowerCase().split("@")[1] ?? "";
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  };
  const link = async () => {
    const emails = customEmail.trim() ? [customEmail.trim().toLowerCase()] : Array.from(checked);
    if (emails.length === 0) { toast.error("Pick at least one sender"); return; }
    try {
      const r = await importSenders.mutateAsync({ apiKey, accountId, emails });
      toast.success(
        `Linked ${r.created.length} mailbox${r.created.length === 1 ? "" : "es"}` +
        (r.skipped.length ? ` — ${r.skipped.length} already linked` : ""),
      );
      utils.sendingAccounts.list.invalidate();
      onLinked?.(r.created.length);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || "Could not link those senders");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* z-[100] because this opens from INSIDE the guided mailbox wizard,
          whose shell is a z-[90] full-screen surface. Radix portals to
          <body>, so at the default z-50 the dialog renders behind that shell
          and the button looks dead — which is exactly what it did. Harmless
          in the Settings card, where nothing sits above it. */}
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-xl max-h-[80vh] overflow-y-auto z-[100]" overlayClassName="z-[95]">
        <DialogHeader>
          <DialogTitle>Link a SendGrid sender</DialogTitle>
          <DialogDescription>
            These are the addresses your SendGrid account is allowed to send from. Linked senders become
            mailboxes here, and can then be added to Sender Pools.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Fetching your SendGrid senders…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
            {error}
            <div className="mt-2">
              <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void load()}>
                <RefreshCw className="size-3.5" /> Try again
              </Button>
            </div>
          </div>
        ) : senders.length === 0 && domains.length > 0 ? (
          /* Domain Authentication instead of Single Sender Verification: there
             are no identities to list, but any address at these domains sends. */
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              This SendGrid account has no individual verified senders, but it authenticates{" "}
              {domains.map((d) => <b key={d} className="text-foreground">@{d}</b>).reduce((a, b) => <>{a}, {b}</> )}
              {" "}— any address there can send. Enter the one to link.
            </p>
            <div className="flex gap-2">
              <Input
                autoFocus
                placeholder={`you@${domains[0]}`}
                value={customEmail}
                onChange={(e) => setCustomEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void link(); }}
              />
            </div>
            {customEmail.trim() && !domainAllows(customEmail) && (
              <p className="text-[12px] text-amber-700 dark:text-amber-400">
                SendGrid hasn't authenticated that domain, so it will reject sends from it.
              </p>
            )}
          </div>
        ) : senders.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            SendGrid returned no sender identities and no authenticated domains. Add one in SendGrid under
            Settings → Sender Authentication — either Single Sender Verification or Domain Authentication —
            then refresh.
            <div className="mt-3">
              <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void load()}>
                <RefreshCw className="size-3.5" /> Refresh
              </Button>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border border-border">
            {senders.map((s) => (
              <label
                key={s.email}
                className={`flex items-center gap-3 px-3 py-2.5 ${s.alreadyLinked ? "opacity-60" : "cursor-pointer"}`}
              >
                <Checkbox
                  checked={checked.has(s.email)}
                  disabled={s.alreadyLinked}
                  onCheckedChange={() => toggle(s.email)}
                />
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{s.name || s.nickname || s.email}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{s.email}</span>
                </span>
                {s.alreadyLinked ? (
                  <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Already linked</span>
                ) : s.verified ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="size-3.5" /> Verified
                  </span>
                ) : (
                  <span
                    className="flex shrink-0 items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
                    title="SendGrid rejects every send from an unverified sender — finish verification in SendGrid first."
                  >
                    <ShieldAlert className="size-3.5" /> Not verified
                  </span>
                )}
              </label>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={
              loading || importSenders.isPending ||
              (customEmail.trim()
                ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customEmail.trim())
                : checked.size === 0 || linkable.length === 0)
            }
            onClick={link}
          >
            {importSenders.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Link2 className="mr-1.5 size-4" />}
            Link {customEmail.trim() ? "mailbox" : `${checked.size || ""} ${checked.size === 1 ? "mailbox" : "mailboxes"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
