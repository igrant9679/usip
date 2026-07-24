/**
 * ApolloSourceCard — Apollo.io BYOK key entry, shared by two surfaces.
 *
 * Rendered both in ARE Settings (next to the scraper source toggles it feeds)
 * and in the Settings hub (next to the other third-party credentials). Both
 * read and write ONE encrypted column via the `apollo` router, so there is no
 * "which copy is authoritative" question — there is only one key.
 *
 * The copy here is deliberately explicit about cost, because Apollo's pricing
 * is the thing most likely to surprise someone: we call People Search only,
 * which is free, and never the enrichment endpoints, which are not.
 *
 * `variant` only affects the outer chrome so the card sits correctly in each
 * host page; the contents are identical.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Database, Loader2, ShieldCheck } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";

export function ApolloSourceCard({
  variant = "standalone",
}: {
  /** "standalone" draws its own card chrome (Settings hub); "bare" assumes the
   *  host already provides a Section wrapper (ARE Settings). */
  variant?: "standalone" | "bare";
}) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

  const status = trpc.apollo.get.useQuery();
  const configured = !!status.data?.configured;
  const masked = status.data?.masked ?? "";
  const savedCap = status.data?.dailyPullCap ?? 50;
  const pulledToday = status.data?.pulledToday ?? 0;

  const [key, setKey] = useState("");
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const effectiveCap = capDraft ?? String(savedCap);
  const capChanged = Number(effectiveCap) !== savedCap && effectiveCap.trim() !== "";

  const save = trpc.apollo.upsert.useMutation({
    onSuccess: () => {
      utils.apollo.get.invalidate();
      setKey("");
      setCapDraft(null);
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const test = trpc.apollo.test.useMutation({
    onSuccess: (r: any) => toast.success(r?.message ?? "Key verified"),
    onError: (e: any) => toast.error(e?.message ?? "Key test failed"),
  });

  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldCheck className={cn("size-4", configured ? "text-emerald-600" : "text-muted-foreground")} />
        {configured ? (
          <span>
            Connected <span className="text-muted-foreground">· key {masked}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            Not connected — add your Apollo API key to use it as a prospect source.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
        <div className="space-y-1.5">
          <Label>Apollo API key</Label>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? "Enter a new key to replace the saved one" : "Paste your Apollo API key"}
            disabled={!isAdmin}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Daily record cap</Label>
          <Input
            type="number"
            min={1}
            max={10000}
            value={effectiveCap}
            onChange={(e) => setCapDraft(e.target.value)}
            disabled={!isAdmin}
          />
        </div>
      </div>

      <p className="text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{pulledToday.toLocaleString()}</span> of{" "}
        <span className="font-medium text-foreground">{savedCap.toLocaleString()}</span> records pulled today.
        The cap limits how many people Apollo returns per day — it protects your API rate limit,
        not your credit balance, because searching costs no credits.
      </p>

      <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[12px] text-muted-foreground space-y-1">
        <p>
          <span className="font-medium text-foreground">Velocity uses Apollo for search only.</span>{" "}
          Apollo's People Search returns names, titles, company and{" "}
          <span className="font-medium text-foreground">company domain</span> — and consumes{" "}
          <span className="font-medium text-foreground">zero Apollo credits</span>.
        </p>
        <p>
          We never call Apollo's enrichment endpoints, which cost 1 credit per revealed email
          and 8 more per mobile number. Email addresses are resolved instead by Velocity's own
          verifier from the domain Apollo supplies, so your credit balance stays untouched.
        </p>
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={save.isPending || (!key.trim() && !capChanged)}
            onClick={() =>
              save.mutate({
                ...(key.trim() ? { apiKey: key.trim() } : {}),
                ...(capChanged ? { dailyPullCap: Number(effectiveCap) } : {}),
              })
            }
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
          {configured && (
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                confirmAction({ title: "Remove the saved Apollo API key?", description: "Campaigns using Apollo as a source stop sourcing from it.", confirmLabel: "Remove" }, () => {
                  save.mutate({ apiKey: "" });
                });
              }}
              className="text-rose-600 hover:text-rose-600"
            >
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">Only workspace admins can change the Apollo connection.</p>
      )}
    </>
  );

  if (variant === "bare") return <div className="space-y-4">{body}</div>;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-2.5">
        <Database className="size-4 mt-0.5 shrink-0 text-violet-500" />
        <div>
          <h2 className="text-[15px] font-semibold">Apollo.io</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Use your Apollo account as a prospect source. Stored encrypted; generate a key
            under Settings → Integrations → API in Apollo.
          </p>
        </div>
      </div>
      {body}
    </section>
  );
}

export default ApolloSourceCard;
