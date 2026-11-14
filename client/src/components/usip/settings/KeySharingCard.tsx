/**
 * KeySharingCard — an admin lends this workspace's keys to other workspaces
 * (owner ask 2026-11-13: "give admins (only Admins) the ability to share API
 * keys and tokens ... with other Spaces").
 *
 * A live link, not a copy (server/services/keyShares): the borrowing workspace
 * uses this workspace's key while the box is ticked and never holds or sees
 * it. Rotate or remove the key here and it changes everywhere; untick and the
 * other workspace stops using it at once.
 *
 * Admins only. Everyone else gets nothing rendered here, and the server
 * refuses them whatever the page shows (routers/keyShares).
 *
 * `kinds` narrows the card to the keys its host page is about, so the AI
 * providers are shared next to the AI providers and the sources next to the
 * sources. Left out, it lists every shareable key.
 */
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Share2 } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { useWorkspace } from "@/contexts/WorkspaceContext";

export type ShareableKind = "anthropic" | "openai" | "gemini" | "xai" | "apollo" | "reoon" | "quickenrich" | "warmysender" | "leadocean";

export const AI_KEY_KINDS: ShareableKind[] = ["anthropic", "openai", "gemini"];
export const SOURCE_KEY_KINDS: ShareableKind[] = ["apollo", "quickenrich", "warmysender", "leadocean", "reoon"];
export const VOICE_KEY_KINDS: ShareableKind[] = ["xai"];

/** Every read that says whether a key is set, so a share shows up at once. */
function useRefreshKeyStatus() {
  const utils = trpc.useUtils();
  return () =>
    Promise.all([
      utils.keyShares.invalidate(),
      utils.aiCredentials.invalidate(),
      utils.apollo.invalidate(),
      utils.reoon.invalidate(),
      utils.quickenrich.invalidate(),
      utils.prospectSources.invalidate(),
      utils.voiceAgents.getSettings.invalidate(),
    ]);
}

export function KeySharingCard({ kinds }: { kinds?: ShareableKind[] }) {
  const { isAdmin } = useWorkspaceRole();
  const { current } = useWorkspace();
  const here = current?.name ?? "This workspace";
  const overview = trpc.keyShares.overview.useQuery(undefined, { enabled: isAdmin });
  const refresh = useRefreshKeyStatus();
  const fail = (e: { message?: string }) => toast.error(e?.message ?? "Could not change the share");

  const share = trpc.keyShares.share.useMutation({ onSuccess: () => { void refresh(); toast.success("Key shared"); }, onError: fail });
  const unshare = trpc.keyShares.unshare.useMutation({ onSuccess: () => { void refresh(); toast.success("Sharing stopped"); }, onError: fail });
  const stopUsing = trpc.keyShares.stopUsing.useMutation({ onSuccess: () => { void refresh(); toast.success("No longer using the shared key"); }, onError: fail });

  if (!isAdmin) return null;
  const data = overview.data;
  const keys = (data?.keys ?? []).filter((k) => !kinds || kinds.includes(k.kind as ShareableKind));
  const others = data?.workspaces ?? [];
  const canManage = !!data?.canManage;
  const busy = share.isPending || unshare.isPending || stopUsing.isPending;

  const toggle = (k: (typeof keys)[number], target: { id: number; name: string }, on: boolean) => {
    if (on) {
      confirmAction(
        {
          title: `Share the ${k.label} key with ${target.name}?`,
          description: `${target.name} will use ${here}'s key wherever it has none of its own, and what it uses is charged to this key's account. Nobody in ${target.name} can see the key.`,
          consequence: { kind: "reversible", undo: "untick the box to stop sharing" },
          confirmLabel: "Share key",
        },
        () => share.mutate({ kind: k.kind, targetWorkspaceId: target.id }),
      );
    } else {
      confirmAction(
        {
          title: `Stop sharing the ${k.label} key with ${target.name}?`,
          description: `${target.name} goes back to its own ${k.label} key, if it has one.`,
          consequence: { kind: "access", who: target.name },
          confirmLabel: "Stop sharing",
        },
        () => unshare.mutate({ kind: k.kind, targetWorkspaceId: target.id }),
      );
    }
  };

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4" data-tour-id="settings-key-sharing">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary"><Share2 className="size-4" /></div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Share keys with other workspaces</h3>
          <p className="text-[12px] text-muted-foreground">
            Tick a workspace to let it use {here}'s key. It is a live link, not a copy: the other workspace never sees the
            key, a change to the key here applies there too, and unticking stops its use at once. A workspace's own key
            always comes first. Only admins of both workspaces can share.
          </p>
        </div>
      </div>

      {overview.isLoading ? (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading keys</p>
      ) : overview.error ? (
        <p className="text-[12px] text-destructive">Could not load key sharing: {overview.error.message}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Key</th>
                <th className="py-2 pr-3 font-medium">In {here}</th>
                {others.map((w) => (
                  <th key={w.id} className="py-2 px-3 font-medium text-center whitespace-nowrap">{w.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const borrowing = !k.hasOwnKey && k.borrowedFrom;
                return (
                  <tr key={k.kind} className="border-b last:border-0 align-middle">
                    <td className="py-2 pr-3 font-medium whitespace-nowrap">{k.label}</td>
                    <td className="py-2 pr-3 text-[12px] text-muted-foreground">
                      {k.hasOwnKey ? (
                        <span className="text-foreground">Own key</span>
                      ) : borrowing ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span>
                            {k.borrowedFrom!.usable
                              ? `Using ${k.borrowedFrom!.name}'s key`
                              : `Shared by ${k.borrowedFrom!.name}, which has no key set now`}
                          </span>
                          {canManage && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={busy}
                              onClick={() =>
                                confirmAction(
                                  {
                                    title: `Stop using ${k.borrowedFrom!.name}'s ${k.label} key?`,
                                    description: `${here} goes back to its own ${k.label} key, if it has one.`,
                                    consequence: { kind: "access", who: here },
                                    confirmLabel: "Stop using",
                                  },
                                  () => stopUsing.mutate({ kind: k.kind }),
                                )
                              }
                            >
                              Stop using
                            </Button>
                          )}
                        </span>
                      ) : (
                        "No key"
                      )}
                    </td>
                    {others.map((w) => {
                      const on = k.sharedWith.some((s) => s.workspaceId === w.id);
                      return (
                        <td key={w.id} className="py-2 px-3 text-center">
                          <Checkbox
                            aria-label={`Share the ${k.label} key with ${w.name}`}
                            checked={on}
                            disabled={busy || !canManage || (!k.hasOwnKey && !on)}
                            onCheckedChange={(v) => toggle(k, w, v === true)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {others.length === 0 && (
            <p className="pt-2 text-[12px] text-muted-foreground">
              You are not an admin of any other workspace, so there is nowhere to share a key yet.
            </p>
          )}
          {!canManage && (
            <p className="pt-2 text-[12px] text-muted-foreground">
              Your account has the Manage API keys permission switched off, so these are read-only.
            </p>
          )}
          {keys.some((k) => !k.hasOwnKey && k.sharedWith.length > 0) && (
            <p className="pt-2 text-[12px] text-muted-foreground">
              A ticked key with no key set here lends nothing until a key is entered again.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
