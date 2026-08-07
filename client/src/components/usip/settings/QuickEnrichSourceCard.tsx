/**
 * QuickEnrichSourceCard — QuickEnrich BYOK key entry.
 *
 * Sits beside ApolloSourceCard and ReoonVerifierCard and mirrors their shape.
 * QuickEnrich is a LinkedIn-URL-keyed contact database being evaluated as a
 * prospect SOURCE — its free contact-finder reports has_email before anything
 * is spent, and email delivery is pay-on-success.
 *
 * THE COPY BELOW SAYS EXACTLY WHAT THE KEY POWERS TODAY (the connection test
 * and the sourcing trial) and does NOT imply campaigns consume it — they don't
 * yet. A settings surface that overclaims is this product's documented defect
 * class; when the ARE source pass lands, this card grows the cap alongside it.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radar, Loader2, ShieldCheck } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";

export function QuickEnrichSourceCard({
  variant = "standalone",
}: {
  /** "standalone" draws its own card chrome; "bare" assumes a host Section. */
  variant?: "standalone" | "bare";
}) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

  const status = trpc.quickenrich.get.useQuery();
  const configured = !!status.data?.configured;
  const masked = status.data?.masked ?? "";
  const source = status.data?.source ?? "none";

  const [key, setKey] = useState("");

  const save = trpc.quickenrich.upsert.useMutation({
    onSuccess: () => {
      utils.quickenrich.get.invalidate();
      setKey("");
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const test = trpc.quickenrich.test.useMutation({
    onSuccess: (r: any) =>
      toast.success(
        r?.sampleRows != null
          ? `Key verified — their API answered with ${r.sampleRows} sample record${r.sampleRows === 1 ? "" : "s"}`
          : "Key verified — QuickEnrich accepted the connection",
      ),
    onError: (e: any) => toast.error(e?.message ?? "Key test failed"),
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
          <span className="text-muted-foreground">Not connected.</span>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>QuickEnrich API key</Label>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={configured ? "Enter a new key to replace the saved one" : "Paste your QuickEnrich API key"}
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

      <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[12px] text-muted-foreground space-y-1">
        <p>
          <span className="font-medium text-foreground">A candidate source for campaign prospecting, being trialled.</span>{" "}
          Their database is keyed on LinkedIn URLs and reports whether a contact has an email
          before anything is spent; delivery costs a credit only on success.
        </p>
        <p>
          Today the key powers the connection test and the sourcing trial —{" "}
          <span className="font-medium text-foreground">campaigns do not pull from QuickEnrich yet</span>.
          When they do, any address it supplies is still Reoon-verified before promotion, the
          same bar every found address has to clear.
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
            {test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Test connection
          </Button>
          {source === "workspace" && (
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                confirmAction(
                  {
                    title: "Remove this workspace's QuickEnrich key?",
                    description:
                      "Falls back to the server-wide key if one is set; otherwise the connection test and trial stop working.",
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
        <p className="text-[12px] text-muted-foreground">Only workspace admins can change the QuickEnrich connection.</p>
      )}
    </>
  );

  if (variant === "bare") return <div className="space-y-4">{body}</div>;

  return (
    <section data-tour-id="quickenrich-key-card" className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-2.5">
        <Radar className="size-4 mt-0.5 shrink-0 text-violet-500" />
        <div>
          <h2 className="text-[15px] font-semibold">QuickEnrich</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Contact database for prospect sourcing, keyed on LinkedIn profiles. Stored
            encrypted; find your key in the QuickEnrich dashboard under API.
          </p>
        </div>
      </div>
      {body}
    </section>
  );
}

export default QuickEnrichSourceCard;
