/**
 * PlatformAiDefaultCard — the platform's default AI provider, for the
 * platform owner only (users.role 'admin'; owner decision 2026-11-27).
 *
 * It decides for workspaces that have made no AI choice and hold no AI key of
 * their own. "Not set" is what happened before this card existed: the
 * deployment's AI_DEFAULT_PROVIDER, then Anthropic first. A provider the
 * deployment has no shared key for cannot be picked (the server refuses it
 * too). Also checks the platform's shared OpenRouter key with OpenRouter and
 * shows its credit; the key itself never reaches the browser.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Globe, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AI_PROVIDER_IDS, AI_PROVIDER_LABEL, type AiProviderId } from "@shared/aiTiers";

const NOT_SET = "none";

function creditText(c: { limit: number | null; limitRemaining: number | null; usage: number | null }): string {
  if (c.limitRemaining !== null && c.limit !== null) return `$${c.limitRemaining.toFixed(2)} of $${c.limit.toFixed(2)} credit left on the key`;
  return `no credit limit set on the key${c.usage !== null ? `; $${c.usage.toFixed(2)} used so far` : ""}`;
}

export function PlatformAiDefaultCard() {
  const utils = trpc.useUtils();
  const q = trpc.aiCredentials.platformAi.useQuery();
  const [draft, setDraft] = useState<string | null>(null);
  const save = trpc.aiCredentials.setPlatformDefault.useMutation({
    onSuccess: (r) => {
      void utils.aiCredentials.platformAi.invalidate();
      setDraft(null);
      toast.success(r.defaultProvider ? `Platform default set to ${AI_PROVIDER_LABEL[r.defaultProvider]}` : "Platform default cleared");
    },
    onError: (e) => toast.error(e.message),
  });
  const check = trpc.aiCredentials.checkSharedOpenRouterKey.useMutation({
    onSuccess: (r) => toast.success(`OpenRouter accepted the shared key: ${creditText(r)}`),
    onError: (e) => toast.error(e.message),
  });
  if (!q.data) return null;
  const saved = q.data.defaultProvider ?? NOT_SET;
  const value = draft ?? saved;
  const keys = q.data.deploymentKeys;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-3" data-tour-id="settings-platform-ai-default">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary"><Globe className="size-4" /></div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Platform default provider (platform owner)</h3>
          <p className="text-[12px] text-muted-foreground">
            The AI provider for every workspace that has not picked one and has no AI key of its own. A workspace&apos;s own
            choice or own key always comes first. Not set: the server&apos;s AI_DEFAULT_PROVIDER{q.data.envDefaultProvider ? ` (${q.data.envDefaultProvider})` : ""}, then Anthropic first, as before.
            Shared-key use counts against each workspace&apos;s monthly AI budget like any other.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={value} onValueChange={setDraft}>
          <SelectTrigger className="h-8 w-60 text-xs" aria-label="Platform default provider"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NOT_SET}>Not set (as before)</SelectItem>
            {AI_PROVIDER_IDS.map((p) => (
              <SelectItem key={p} value={p} disabled={!keys[p]}>
                {AI_PROVIDER_LABEL[p]}{keys[p] ? "" : " (no shared key on the server)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={save.isPending || value === saved}
          onClick={() => save.mutate({ provider: value === NOT_SET ? "" : (value as AiProviderId) })}
        >
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save
        </Button>
        {keys.openrouter && (
          <Button size="sm" variant="ghost" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Check shared OpenRouter key
          </Button>
        )}
      </div>
      {!keys.openrouter && (
        <p className="text-[12px] text-muted-foreground">
          No shared OpenRouter key yet: set OPENROUTER_API_KEY on Railway, and OpenRouter becomes available to every workspace
          that picks it, and as a choice here.
        </p>
      )}
    </section>
  );
}

export default PlatformAiDefaultCard;
