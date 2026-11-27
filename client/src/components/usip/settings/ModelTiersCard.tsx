/**
 * ModelTiersCard — which AI model does which kind of work (owner ask
 * 2026-11-16: "have her use a low cost model … based on the level of
 * complexity", and "the tier-to-feature should be editable per workspace").
 *
 * Three tiers, each a provider and model the admin picks, then one row per
 * kind of work saying which tier it runs on. The kinds of work and their
 * default tiers are code (shared/aiTiers.ts); a workspace may move any of
 * them, and Reset puts one back.
 *
 * A tier left blank uses the workspace's default provider and model, which is
 * what every AI call did before this card existed. So a workspace that never
 * touches it behaves exactly as before.
 *
 * Everyone can read it; only admins can change it (the server refuses the
 * rest whatever the page shows).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Layers, Loader2, TestTube2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OpenRouterModelPicker } from "./OpenRouterModelPicker";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_LABEL as PROVIDER_NAME,
  AI_TASKS,
  AI_TASK_IDS,
  AI_TIERS,
  AI_TIER_HINT,
  AI_TIER_LABEL,
  tierForTask,
  type AiProviderId,
  type AiTier,
} from "@shared/aiTiers";

type Draft = { provider: AiProviderId; model: string };

export function ModelTiersCard({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const tiersQ = trpc.aiCredentials.getTiers.useQuery();
  const credsQ = trpc.aiCredentials.get.useQuery();
  const refresh = () => utils.aiCredentials.getTiers.invalidate();
  const fail = (e: { message?: string }) => toast.error(e?.message ?? "Could not save");

  const setTier = trpc.aiCredentials.setTier.useMutation({ onSuccess: () => { void refresh(); toast.success("Tier saved"); }, onError: fail });
  const setTaskTier = trpc.aiCredentials.setTaskTier.useMutation({ onSuccess: () => { void refresh(); toast.success("Saved"); }, onError: fail });
  const testTier = trpc.aiCredentials.testTier.useMutation({
    onSuccess: (d) => toast.success(`OK: ${d.model} (${d.latencyMs}ms)`),
    onError: fail,
  });

  const [drafts, setDrafts] = useState<Partial<Record<AiTier, Draft>>>({});

  const tiers = tiersQ.data?.tiers ?? {};
  const taskTiers = tiersQ.data?.taskTiers ?? {};
  // OpenRouter also runs on the platform's shared key when the workspace has none of its own.
  const hasKey = (p: AiProviderId) => !!credsQ.data?.[p]?.configured || (p === "openrouter" && !!credsQ.data?.openrouter.platformKey);
  const defaultProvider = (credsQ.data?.defaultProvider || "") as AiProviderId | "";
  const firstUsable: AiProviderId = (defaultProvider && hasKey(defaultProvider) ? defaultProvider : AI_PROVIDER_IDS.find(hasKey)) ?? "anthropic";
  const anySet = AI_TIERS.some((t) => !!tiers[t]);

  /** What a tier resolves to right now, in words. */
  const modelOf = (tier: AiTier): string => {
    const set = tiers[tier];
    if (!set) return "the default model";
    if (!hasKey(set.provider)) return `the default model (no ${PROVIDER_NAME[set.provider]} key)`;
    return set.model;
  };

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4" data-tour-id="settings-model-tiers">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary"><Layers className="size-4" /></div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Model tiers</h3>
          <p className="text-[12px] text-muted-foreground">
            Use a cheaper model for simple work and a stronger one where it matters. Set a model for each tier, then choose
            which tier each kind of work runs on. A tier left blank uses the default provider's model above, so nothing
            changes until you set one.
          </p>
        </div>
      </div>

      {tiersQ.isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="divide-y rounded-lg border">
            {AI_TIERS.map((tier) => {
              const saved = tiers[tier];
              const draft: Draft = drafts[tier] ?? { provider: saved?.provider ?? firstUsable, model: saved?.model ?? "" };
              const setDraft = (patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [tier]: { ...draft, ...patch } }));
              const changed = draft.model.trim() !== (saved?.model ?? "") || (!!draft.model.trim() && draft.provider !== saved?.provider);
              const noKey = !!saved && !hasKey(saved.provider);
              return (
                <div key={tier} className="px-3 py-3 space-y-2">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium">{AI_TIER_LABEL[tier]}</span>
                    <span className="text-[12px] text-muted-foreground">{AI_TIER_HINT[tier]}</span>
                  </div>
                  {isAdmin ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Select value={draft.provider} onValueChange={(v) => setDraft({ provider: v as AiProviderId })}>
                        <SelectTrigger className="h-8 w-44 text-xs" aria-label={`${AI_TIER_LABEL[tier]} tier provider`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {AI_PROVIDER_IDS.map((p) => (
                            <SelectItem key={p} value={p} disabled={!hasKey(p)}>
                              {PROVIDER_NAME[p]}{hasKey(p) ? "" : " (no key)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        aria-label={`${AI_TIER_LABEL[tier]} tier model`}
                        value={draft.model}
                        onChange={(e) => setDraft({ model: e.target.value })}
                        placeholder="Model name, exactly as the provider lists it"
                        className="h-8 text-xs flex-1 min-w-48 font-mono"
                      />
                      {draft.provider === "openrouter" && (
                        <OpenRouterModelPicker
                          label={`${AI_TIER_LABEL[tier]} tier OpenRouter model`}
                          value={draft.model.trim()}
                          onChange={(id) => setDraft({ model: id })}
                          className="w-56"
                        />
                      )}
                      <Button
                        size="sm"
                        disabled={setTier.isPending || !changed || !draft.model.trim()}
                        onClick={() => setTier.mutate({ tier, provider: draft.provider, model: draft.model.trim() }, { onSuccess: () => setDrafts((d) => ({ ...d, [tier]: undefined })) })}
                      >Save</Button>
                      {saved && (
                        <>
                          <Button size="sm" variant="ghost" disabled={testTier.isPending} onClick={() => testTier.mutate({ tier })}>
                            {testTier.isPending && testTier.variables?.tier === tier ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 className="size-3.5" />}
                            Test
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="text-destructive" disabled={setTier.isPending}
                            onClick={() => setTier.mutate({ tier, provider: saved.provider, model: "" }, { onSuccess: () => setDrafts((d) => ({ ...d, [tier]: undefined })) })}
                          >Clear</Button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs">
                      {saved ? <><span className="text-muted-foreground">{PROVIDER_NAME[saved.provider]}: </span><span className="font-mono">{saved.model}</span></> : <span className="text-muted-foreground">Not set: uses the default model.</span>}
                    </div>
                  )}
                  {noKey && (
                    <p className="text-[12px] text-amber-700">
                      This workspace has no {PROVIDER_NAME[saved.provider]} key, so this tier is using the default model. Add the key above or pick another provider.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div>
            <h4 className="text-xs font-semibold mb-1">Which tier each kind of work uses</h4>
            <p className="text-[12px] text-muted-foreground mb-2">
              {anySet
                ? "A change here applies to the next AI call of that kind."
                : "These take effect once at least one tier above has a model."}
            </p>
            <div className="divide-y rounded-lg border">
              {AI_TASK_IDS.map((task) => {
                const info = AI_TASKS[task];
                const tier = tierForTask(task, taskTiers);
                const moved = !!taskTiers[task];
                return (
                  <div key={task} className="px-3 py-2 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-56">
                      <div className="text-xs font-medium">{info.label}</div>
                      <div className="text-[12px] text-muted-foreground">{info.detail}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">Runs on <span className="font-mono">{modelOf(tier)}</span></div>
                    </div>
                    {isAdmin ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <Select value={tier} onValueChange={(v) => setTaskTier.mutate({ task, tier: v === info.defaultTier ? "" : (v as AiTier) })} disabled={setTaskTier.isPending}>
                          <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Tier for ${info.label}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {AI_TIERS.map((t) => (
                              <SelectItem key={t} value={t}>{AI_TIER_LABEL[t]}{t === info.defaultTier ? " (default)" : ""}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {moved && (
                          <Button size="sm" variant="ghost" className="text-xs" disabled={setTaskTier.isPending} onClick={() => setTaskTier.mutate({ task, tier: "" })}>
                            Reset
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs shrink-0">{AI_TIER_LABEL[tier]}{moved ? "" : " (default)"}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default ModelTiersCard;
