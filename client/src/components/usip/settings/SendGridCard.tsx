/**
 * SendGridCard — the Settings entry point for SendGrid campaign sending.
 *
 * Lives in Settings → Mailboxes because that is the sending-infrastructure
 * surface in Settings, and a SendGrid account IS a sending account (migration
 * 0140): campaign sends pick it out of the same pool as every SMTP mailbox.
 * Deliberately NOT folded into the mailbox-linking wizard next to it — that
 * flow links a person's mailbox and walks through signature, IMAP and opt-out
 * steps, none of which mean anything for a bulk API key.
 *
 * One SendGrid account per workspace here, which is the shape people actually
 * want. The full /sending-accounts form can create more, set per-account send
 * caps and add them to specific sender pools; this card is the short path.
 *
 * The amber warning is the important part of this UI. An API key has no mailbox
 * behind it, so nothing polls for replies — they arrive at Reply-To and are
 * invisible to Velocity unless that address is a mailbox connected separately.
 * Someone who discovers that after a campaign has run has already lost replies.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Send, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

export function SendGridCard({
  variant = "standalone",
}: {
  /** "standalone" draws its own card chrome; "bare" assumes a host Section. */
  variant?: "standalone" | "bare";
}) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

  const accountsQ = trpc.sendingAccounts.list.useQuery();
  const existing = ((accountsQ.data as any[]) ?? []).find((a) => a.provider === "sendgrid") ?? null;

  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [apiKey, setApiKey] = useState("");

  // Reflect the saved account once it loads. The key is never echoed back —
  // only the ciphertext is stored, and the server does not return even that.
  useEffect(() => {
    if (!existing) return;
    setFromEmail(existing.fromEmail ?? "");
    setFromName(existing.fromName ?? "");
    setReplyTo(existing.replyTo ?? "");
  }, [existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaved = () => {
    utils.sendingAccounts.list.invalidate();
    setApiKey("");
    toast.success("SendGrid saved");
  };
  const create = trpc.sendingAccounts.create.useMutation({
    onSuccess: onSaved,
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const update = trpc.sendingAccounts.update.useMutation({
    onSuccess: onSaved,
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const test = trpc.sendingAccounts.testConfig.useMutation({
    onSuccess: (r: any) =>
      r?.ok
        ? toast.success("SendGrid key verified — it can send mail")
        : toast.error(r?.error ?? "Key test failed"),
    onError: (e: any) => toast.error(e?.message ?? "Key test failed"),
  });

  const busy = create.isPending || update.isPending;
  // A NEW account needs a key; an existing one may be edited without retyping it.
  const canSave = !!fromEmail.trim() && (!!existing || !!apiKey.trim());

  const save = () => {
    const payload = {
      name: "SendGrid",
      provider: "sendgrid" as const,
      fromEmail: fromEmail.trim(),
      fromName: fromName.trim() || undefined,
      replyTo: replyTo.trim() || undefined,
      sendgridApiKey: apiKey.trim() || undefined,
    };
    if (existing) update.mutate({ id: existing.id, ...payload });
    else create.mutate(payload);
  };

  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px]">
        <Send className="size-4 text-sky-600" />
        <span className="font-medium">SendGrid</span>
        {existing ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-100 rounded-full px-1.5 py-0.5">
            <CheckCircle2 className="size-3" /> Connected
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">Not connected</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Send campaigns through SendGrid's API instead of a mailbox. It joins the same sending pool,
        so sequences and campaigns can use it straight away.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[12px]">From address</Label>
          <Input
            className="h-9"
            placeholder="hello@yourdomain.com"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            disabled={!isAdmin}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px]">From name</Label>
          <Input
            className="h-9"
            placeholder="LSI Media"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            disabled={!isAdmin}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[12px]">Reply-To</Label>
        <Input
          className="h-9"
          placeholder="you@yourdomain.com"
          value={replyTo}
          onChange={(e) => setReplyTo(e.target.value)}
          disabled={!isAdmin}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[12px]">API key</Label>
        <Input
          className="h-9"
          type="password"
          placeholder={existing?.hasSendgridKey ? "••••••• (leave blank to keep the current key)" : "SG.xxxxxxxx"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={!isAdmin}
        />
        <p className="text-[11px] text-muted-foreground">
          Needs <b>Mail Send</b> permission, and the From address must be a verified sender in SendGrid.
        </p>
      </div>

      {/* The thing to understand before choosing this provider. */}
      <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-2.5 flex gap-2">
        <AlertTriangle className="size-3.5 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-[11px] text-amber-900 dark:text-amber-200">
          <b>Replies won't appear in Velocity.</b> SendGrid sends only — there's no inbox behind an
          API key. Replies go to your Reply-To address, so point it at a mailbox you've connected
          separately if you want to see them.
        </p>
      </div>

      {isAdmin && (
        <div className="flex gap-2">
          <Button size="sm" className="h-8" disabled={!canSave || busy} onClick={save}>
            {busy ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : null}
            {existing ? "Save changes" : "Connect SendGrid"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={test.isPending || (!apiKey.trim() && !existing)}
            onClick={() =>
              test.mutate({
                editId: existing?.id,
                provider: "sendgrid",
                sendgridApiKey: apiKey.trim() || undefined,
              })
            }
            title="Check the key authenticates and has Mail Send permission"
          >
            {test.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : null}
            Test key
          </Button>
        </div>
      )}
      {!isAdmin && (
        <p className="text-[11px] text-muted-foreground">Only workspace admins can change sending settings.</p>
      )}
    </>
  );

  if (variant === "bare") return <div className="space-y-3">{body}</div>;
  return <div className={cn("rounded-lg border bg-card p-4 space-y-3")}>{body}</div>;
}
