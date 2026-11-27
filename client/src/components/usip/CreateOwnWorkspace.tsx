/**
 * Sign-up from within the app (owner, 2026-11-26: "I want to be able to sign
 * up for a new workspace from the front-end website and from within the app
 * itself"). Shown on the screen someone with no workspace lands on
 * (WorkspaceAccessGate).
 *
 * When the platform owner has opened it, this is a form: name the workspace,
 * and it is made on the Trial plan (workspace.createOwn). When it is closed,
 * or the address is not confirmed yet, there is no form; the link to where
 * plans are bought is still shown when the deployment has one, so nobody is
 * left at a dead end.
 */
import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink, Loader2 } from "lucide-react";

export function CreateOwnWorkspace({ open, offer, plansUrl }: { open: boolean; offer: string; plansUrl: string | null }) {
  const [name, setName] = useState("");
  const utils = trpc.useUtils();
  const create = trpc.workspace.createOwn.useMutation({
    onSuccess: async (w) => {
      toast.success(`${w.name} is ready.`);
      // The list is what the shell waits on: with a workspace in it, the gate opens.
      await Promise.all([utils.workspace.list.invalidate(), utils.workspace.access.invalidate()]);
    },
    onError: (e) => toast.error(e.message || "The workspace could not be created. Try again."),
  });

  const plans = plansUrl ? (
    <a
      href={plansUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
      data-membership-plans-link
    >
      See membership plans <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  ) : null;

  if (!open) return plans;

  const trimmed = name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed.length < 2 || create.isPending) return;
    create.mutate({ name: trimmed });
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-create-own-workspace>
      <div className="space-y-1.5">
        <Label htmlFor="own-workspace-name">Workspace name</Label>
        <Input
          id="own-workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your company or team"
          maxLength={120}
          autoComplete="organization"
          autoFocus
        />
      </div>
      <p className="text-xs text-muted-foreground">{offer}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="submit" size="sm" disabled={trimmed.length < 2 || create.isPending}>
          {create.isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
          Create workspace
        </Button>
        {plans}
      </div>
    </form>
  );
}
