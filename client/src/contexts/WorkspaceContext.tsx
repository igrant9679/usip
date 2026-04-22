import { trpc } from "@/lib/trpc";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

type WS = { id: number; name: string; slug: string; plan: string; role: "super_admin" | "admin" | "manager" | "rep" };

type WorkspaceCtx = {
  workspaces: WS[];
  current: WS | null;
  switchTo: (id: number) => void;
  isLoading: boolean;
};

const Ctx = createContext<WorkspaceCtx>({ workspaces: [], current: null, switchTo: () => {}, isLoading: true });

const KEY = "usip:workspaceId";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.workspace.list.useQuery(undefined, { staleTime: 60_000 });
  const [currentId, setCurrentId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const v = window.localStorage.getItem(KEY);
    return v ? Number(v) : null;
  });

  useEffect(() => {
    if (!data || data.length === 0) return;
    if (currentId && data.find((w) => w.id === currentId)) return;
    const first = data[0]!;
    setCurrentId(first.id);
    window.localStorage.setItem(KEY, String(first.id));
  }, [data, currentId]);

  const switchTo = useCallback(
    (id: number) => {
      setCurrentId(id);
      window.localStorage.setItem(KEY, String(id));
      // Hard-invalidate everything so all panels reload for the new workspace
      utils.invalidate();
    },
    [utils],
  );

  const value = useMemo<WorkspaceCtx>(() => {
    const list = (data ?? []) as WS[];
    const current = list.find((w) => w.id === currentId) ?? list[0] ?? null;
    return { workspaces: list, current, switchTo, isLoading };
  }, [data, currentId, switchTo, isLoading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);
