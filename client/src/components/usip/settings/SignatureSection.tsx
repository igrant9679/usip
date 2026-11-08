/**
 * Settings → Email signature: the one place signatures live (audit
 * 2026-10-20, G51; batch CONB, 2026-11-08).
 *
 * There are three signatures and each does something different, but they
 * were edited in three places that told three stories: "My email signature"
 * sat under Appearance, the workspace default under Email delivery, and
 * Profile → Email settings said "your signature is set per mailbox", which is
 * only true of mail sent through a mailbox. They are on this one page now,
 * with what each is for, and the other places link here:
 *
 *   · Yours (users.emailSignature): emails you write yourself — inbox
 *     replies, CRM emails, meeting proposals.
 *   · The workspace default (workspace_settings.emailSignature, admins):
 *     used when yours is blank.
 *   · Each mailbox's own (sending_accounts.signature): added to everything
 *     sent through that mailbox (services/sending/accountDefaults.ts). It is
 *     part of the mailbox's setup, so it is listed here and edited there.
 *
 * Nothing about which signature a send uses changed; only where you edit it.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/usip/Common";

export function SignatureSection({ isAdmin }: { isAdmin: boolean }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // Yours.
  const mine = trpc.profile.getMySignature.useQuery();
  const [sig, setSig] = useState("");
  useEffect(() => { if (mine.data) setSig(mine.data.emailSignature ?? ""); }, [mine.data]);
  const saveMine = trpc.profile.updateMySignature.useMutation({
    onSuccess: () => { utils.profile.getMySignature.invalidate(); toast.success("Your signature is saved"); },
    onError: (e) => toast.error(e.message),
  });

  // The workspace default.
  const settings = trpc.settings.get.useQuery();
  const [wsSig, setWsSig] = useState("");
  useEffect(() => { if (settings.data) setWsSig((settings.data as { emailSignature?: string | null }).emailSignature ?? ""); }, [settings.data]);
  const saveWs = trpc.settings.save.useMutation({
    onSuccess: () => { utils.settings.get.invalidate(); toast.success("Workspace default saved"); },
    onError: (e) => toast.error(e.message),
  });
  const workspaceSignature = ((settings.data as { emailSignature?: string | null } | undefined)?.emailSignature ?? "").trim();

  // Each mailbox's own, listed (edited in the mailbox's setup).
  const mailboxes = trpc.sendingAccounts.list.useQuery();
  const boxes = ((mailboxes.data ?? []) as Array<{ id: number; name?: string | null; fromEmail?: string | null; signature?: string | null }>);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
      <div className="mx-auto w-full max-w-[820px] px-4 sm:px-6 py-6 space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Email signature</h1>
        <p className="text-[13px] text-muted-foreground">
          Emails you write yourself (inbox replies, CRM emails, meeting proposals) end with your signature, or the workspace
          default when yours is blank. A mailbox's own signature is added to everything sent through that mailbox.
        </p>

        <Section
          title="Your signature"
          description="Overrides the workspace default for emails you send. Leave it blank to use the workspace default."
          right={
            <Button size="sm" onClick={() => saveMine.mutate({ emailSignature: sig })} disabled={saveMine.isPending}>
              {saveMine.isPending ? <Loader2 className="size-3 mr-1 animate-spin" /> : null} Save
            </Button>
          }
        >
          <div className="p-4 space-y-1">
            <Label htmlFor="sig-mine">Your signature</Label>
            <textarea id="sig-mine"
              className="w-full min-h-32 rounded-md border bg-transparent px-3 py-2 text-sm font-mono"
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              placeholder={workspaceSignature || "Best,\nYour Name\nYour Title, Your Company"}
            />
            <p className="text-xs text-muted-foreground">
              {sig.trim() ? "Emails you send use this signature." : workspaceSignature ? "Using the workspace default, shown as the placeholder." : "No workspace default is set either, so your emails go without one."}
            </p>
          </div>
        </Section>

        <Section
          title="Workspace default"
          description={isAdmin ? "Used by anyone in this workspace who has not set their own." : "Used when you have not set your own. Only workspace admins can change it."}
          right={isAdmin ? (
            <Button size="sm" onClick={() => saveWs.mutate({ emailSignature: wsSig.trim() || null })} disabled={saveWs.isPending}>
              {saveWs.isPending ? <Loader2 className="size-3 mr-1 animate-spin" /> : null} Save
            </Button>
          ) : null}
        >
          <div className="p-4 space-y-1">
            <Label htmlFor="sig-workspace">Default signature</Label>
            <textarea id="sig-workspace"
              className="w-full min-h-28 rounded-md border bg-transparent px-3 py-2 text-sm"
              value={wsSig}
              onChange={(e) => setWsSig(e.target.value)}
              disabled={!isAdmin}
              placeholder={"Best,\nJane Doe\nAE, Acme Inc."}
            />
          </div>
        </Section>

        <Section title="Mailbox signatures" description="Set in each mailbox's setup, and added to everything sent through that mailbox.">
          <div className="p-4 space-y-2">
            {boxes.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No mailboxes are linked yet.</p>
            ) : (
              <ul className="divide-y rounded-md border bg-card">
                {boxes.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">{b.fromEmail ?? b.name ?? `Mailbox ${b.id}`}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{(b.signature ?? "").trim() ? "Has its own signature" : "No signature of its own"}</span>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" size="sm" onClick={() => navigate("/v2/settings/mailboxes")}>Edit in Mailboxes</Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Where the signature used to be edited: a pointer here instead (G51). */
export function SignaturePointer({ what }: { what: string }) {
  const [, navigate] = useLocation();
  return (
    <Section title="Email signature" description={`${what} lives on one page now, with your own signature and each mailbox's.`}>
      <div className="p-4">
        <Button variant="outline" size="sm" onClick={() => navigate("/v2/settings/signature")}>Open Email signature</Button>
      </div>
    </Section>
  );
}
