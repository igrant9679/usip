/**
 * ReoonVerifierCard — Reoon Email Verifier BYOK key entry.
 *
 * Sits next to ApolloSourceCard and mirrors it, because the two are halves of
 * one pipeline: Apollo supplies the company domain for free, Reoon verifies the
 * address Velocity derives from it. Apollo alone gets you a name; Reoon is what
 * turns it into something sendable.
 *
 * Shows WHERE the key resolves from, not just whether one exists. Before
 * migration 0131 this key lived only in `REOON_API_KEY`, so a workspace can be
 * working fine on a deploy-wide fallback with its own field empty — reporting
 * that as "not connected" would send someone hunting for a broken integration.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MailCheck, Loader2, ShieldCheck } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";

export function ReoonVerifierCard({
  variant = "standalone",
}: {
  /** "standalone" draws its own card chrome; "bare" assumes a host Section. */
  variant?: "standalone" | "bare";
}) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

  const status = trpc.reoon.get.useQuery();
  const configured = !!status.data?.configured;
  const masked = status.data?.masked ?? "";
  const source = status.data?.source ?? "none";

  const [key, setKey] = useState("");

  const save = trpc.reoon.upsert.useMutation({
    onSuccess: () => {
      utils.reoon.get.invalidate();
      setKey("");
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const test = trpc.reoon.test.useMutation({
    onSuccess: (r: any) =>
      toast.success(
        `Key verified — ${(r?.dailyCredits ?? 0).toLocaleString()} daily and ${(r?.instantCredits ?? 0).toLocaleString()} instant credits left`,
      ),
    onError: (e: any) => toast.error(e?.message ?? "Key test failed"),
  });

  const verificationEnabled = status.data?.verificationEnabled !== false;
  const setEnabled = trpc.reoon.setVerificationEnabled.useMutation({
    onSuccess: (r) => {
      utils.reoon.get.invalidate();
      toast.success(r.enabled ? "Reoon verification ON — it runs as the final step of every email lookup" : "Reoon verification OFF — found emails stay unverified and never auto-send");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldCheck className={cn("size-4", configured ? "text-emerald-600" : "text-muted-foreground")} />
        {source === "workspace" ? (
          <span>
            Connected <span className="text-muted-foreground">· key {masked}</span>
          </span>
        ) : source === "env" ? (
          <span>
            Connected <span className="text-muted-foreground">· using the server-wide key ({masked})</span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            Not connected — Velocity cannot verify any email address it finds.
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Reoon API key</Label>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={configured ? "Enter a new key to replace the saved one" : "Paste your Reoon API key"}
          disabled={!isAdmin}
          autoComplete="off"
        />
      </div>

      {source === "env" && (
        <p className="text-[12px] text-muted-foreground">
          This workspace is running on the key set in the server environment. Saving a key
          here overrides it for this workspace only.
        </p>
      )}

      {/* Reoon = the OPTIONAL final verification step (migration 0157). */}
      <div className="flex items-start gap-3 rounded-lg border border-border/70 p-3">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium">Verify found emails with Reoon</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            Runs as the <span className="font-medium text-foreground">final step</span> of every email
            lookup. Off: found addresses are kept but stay unverified — they are never marked valid,
            never promoted to the CRM, and never auto-sent.
          </div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 pt-0.5">
          <input
            type="checkbox"
            checked={verificationEnabled}
            disabled={!isAdmin || setEnabled.isPending}
            onChange={(e) => setEnabled.mutate({ enabled: e.target.checked })}
          />
          <span className="text-[12px]">{verificationEnabled ? "On" : "Off"}</span>
        </label>
      </div>

      <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[12px] text-muted-foreground space-y-1">
        <p>
          <span className="font-medium text-foreground">This is what turns a name into a sendable address.</span>{" "}
          Velocity scrapes the company site, derives the most likely address patterns from the
          person's name and domain, and asks Reoon which one is real.
        </p>
        <p>
          Without a key the finder still scrapes phones and social links, but every email lookup
          stops at <span className="font-medium text-foreground">reoon_key_missing</span> and no
          address is resolved.
        </p>
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={save.isPending || !key.trim()}
            onClick={() => save.mutate({ apiKey: key.trim() })}
            className="gap-1.5"
          >
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!configured || test.isPending}
            onClick={() => test.mutate()}
            className="gap-1.5"
          >
            {test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Test &amp; check credits
          </Button>
          {source === "workspace" && (
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                confirmAction(
                  {
                    title: "Remove this workspace's Reoon key?",
                    description:
                      "Email verification falls back to the server-wide key if one is set, and stops resolving addresses if not.",
                    confirmLabel: "Remove",
                  },
                  () => {
                    save.mutate({ apiKey: "" });
                  },
                );
              }}
              className="text-rose-600 hover:text-rose-600"
            >
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">Only workspace admins can change the Reoon connection.</p>
      )}
    </>
  );

  if (variant === "bare") return <div className="space-y-4">{body}</div>;

  return (
    <section data-tour-id="reoon-key-card" className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-2.5">
        <MailCheck className="size-4 mt-0.5 shrink-0 text-cyan-500" />
        <div>
          <h2 className="text-[15px] font-semibold">Reoon Email Verifier</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Verifies the email addresses Velocity finds. Stored encrypted; generate a key in
            your Reoon account under API.
          </p>
        </div>
      </div>
      {body}
    </section>
  );
}

export default ReoonVerifierCard;
