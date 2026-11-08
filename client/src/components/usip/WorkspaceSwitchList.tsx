/**
 * The list inside both workspace switchers, the Shell's and the Settings
 * hub's (audit 2026-10-20, U10 and G36; batch CONB, 2026-11-08).
 *
 * A search box once there are enough workspaces to need one (a platform owner
 * can belong to dozens), the current one ticked, and an archived one badged
 * and open to super admins only (canOpenWorkspace). One list, so the two
 * switchers cannot drift apart again.
 */
import { Check } from "lucide-react";
import { canOpenWorkspace } from "@/lib/activeWorkspace";
import { WORKSPACE_SEARCH_MIN, filterWorkspaces } from "@/lib/workspaceSwitcher";

export type SwitchableWorkspace = {
  id: number;
  name: string;
  slug?: string | null;
  role: string;
  plan?: string;
  logoUrl?: string | null;
  archivedAt?: Date | string | null;
};

export function WorkspaceSwitchList({
  workspaces, currentId, query, onQuery, onPick, detailed = false,
}: {
  workspaces: readonly SwitchableWorkspace[];
  currentId: number | null | undefined;
  query: string;
  onQuery: (q: string) => void;
  onPick: (id: number) => void;
  /** The Shell's richer rows: logo, and role · plan under the name. */
  detailed?: boolean;
}) {
  const searchable = workspaces.length >= WORKSPACE_SEARCH_MIN;
  const shown = searchable ? filterWorkspaces(workspaces, query) : workspaces;
  return (
    <>
      {searchable && (
        <div className="p-1 pb-1.5">
          <input
            aria-label="Find a workspace"
            placeholder="Find a workspace"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            autoFocus
            className="w-full rounded-sm border border-border bg-background px-2 py-1 text-[13px] outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}
      <div className="max-h-72 overflow-y-auto">
        {shown.map((w) => (
          <button
            key={w.id}
            type="button"
            disabled={!canOpenWorkspace(w)}
            onClick={() => onPick(w.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-[13px] hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
          >
            {currentId === w.id ? <Check className="size-3.5 shrink-0 text-primary" /> : <span className="size-3.5 shrink-0" />}
            {detailed && w.logoUrl && (
              <img src={w.logoUrl} alt="" className="size-5 rounded-sm object-contain shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{w.name}</span>
              {detailed && (w.role || w.plan) && <span className="block text-[11px] text-muted-foreground">{[w.role, w.plan].filter(Boolean).join(" · ")}</span>}
            </span>
            {w.archivedAt && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">Archived</span>
            )}
          </button>
        ))}
        {searchable && shown.length === 0 && (
          <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">No workspace matches “{query}”</p>
        )}
      </div>
    </>
  );
}
