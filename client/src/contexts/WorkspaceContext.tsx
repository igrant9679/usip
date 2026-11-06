import { trpc } from "@/lib/trpc";
import {
  WORKSPACE_UNAVAILABLE_EVENT,
  chooseWorkspace,
  getActiveWorkspaceId,
  keepAcrossWorkspaceSwitch,
  setActiveWorkspaceId,
} from "@/lib/activeWorkspace";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

type WS = {
  id: number; name: string; slug: string; plan: string;
  role: "super_admin" | "admin" | "manager" | "rep";
  /** Set when archived: badged in the switcher, open to super admins only (G36). */
  archivedAt?: Date | string | null;
};

type WorkspaceCtx = {
  workspaces: WS[];
  current: WS | null;
  switchTo: (id: number) => void;
  isLoading: boolean;
};

const Ctx = createContext<WorkspaceCtx>({ workspaces: [], current: null, switchTo: () => {}, isLoading: true });

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { data, isLoading } = trpc.workspace.list.useQuery(undefined, { staleTime: 60_000 });
  // Per TAB (lib/activeWorkspace.ts): switching here must not retarget the
  // requests of another open tab (audit 2026-10-20).
  const [currentId, setCurrentId] = useState<number | null>(() => {
    const v = getActiveWorkspaceId();
    return v ? Number(v) : null;
  });

  /**
   * Clear every cached query but the workspace list, and refetch what is on
   * screen. Invalidating alone kept the old workspace's rows showing until
   * each refetch landed (audit 2026-10-20, P114).
   */
  const clearWorkspaceData = useCallback(() => {
    void queryClient.resetQueries({ predicate: (q) => !keepAcrossWorkspaceSwitch(q.queryKey) });
  }, [queryClient]);

  // The server refused this tab's workspace (G11): reload the list, and the
  // effect below moves the tab somewhere the person still belongs.
  useEffect(() => {
    const onUnavailable = () => { void utils.workspace.list.invalidate(); };
    window.addEventListener(WORKSPACE_UNAVAILABLE_EVENT, onUnavailable);
    return () => window.removeEventListener(WORKSPACE_UNAVAILABLE_EVENT, onUnavailable);
  }, [utils]);

  useEffect(() => {
    if (!data || data.length === 0) return;
    const next = chooseWorkspace(data as WS[], currentId);
    if (!next || next.id === currentId) return;
    const moved = currentId != null;
    setCurrentId(next.id);
    setActiveWorkspaceId(next.id);
    // A tab moved off a workspace it lost: what it holds is that workspace's.
    if (moved) clearWorkspaceData();
  }, [data, currentId, clearWorkspaceData]);

  const switchTo = useCallback(
    (id: number) => {
      setCurrentId(id);
      setActiveWorkspaceId(id);
      // Everything reloads for the new workspace, from empty (P114).
      clearWorkspaceData();
    },
    [clearWorkspaceData],
  );

  const value = useMemo<WorkspaceCtx>(() => {
    const list = (data ?? []) as WS[];
    const current = list.find((w) => w.id === currentId) ?? chooseWorkspace(list, null) ?? list[0] ?? null;
    return { workspaces: list, current, switchTo, isLoading };
  }, [data, currentId, switchTo, isLoading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);
