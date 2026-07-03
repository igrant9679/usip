/**
 * SavedRecordsV2 — the Saved → "People" / "Companies" surfaces
 * (/v2/saved-people, /v2/saved-companies).
 *
 * Saved lists of people or companies, backed by the existing `recordLists`
 * router (filtered by entityType). Clicking a list opens the shared list detail
 * (/v2/lists/:id). One component, two routes via the `entityType` prop.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Users, Building2, Plus, ChevronRight, FolderOpen } from "lucide-react";

function fmt(d?: string | Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function SavedRecordsV2({ entityType }: { entityType: "people" | "companies" }) {
  const accent = useAccentColor();
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const isPeople = entityType === "people";
  const title = isPeople ? "Saved · People" : "Saved · Companies";
  const Icon = isPeople ? Users : Building2;

  const lists = trpc.recordLists.list.useQuery(undefined as any, { retry: false });
  const create = trpc.recordLists.create.useMutation({
    onSuccess: (r: any) => {
      utils.recordLists.list.invalidate();
      toast.success("List created");
      setOpen(false); setName("");
      if (r?.id) setLocation(`/v2/lists/${r.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const mine = ((lists.data as any[]) ?? []).filter((l) => l.entityType === entityType);

  return (
    <Shell title={title}>
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Icon className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
          <div className="flex-1" />
          <Button size="sm" className="h-7 gap-1.5" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New list</Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
          {lists.isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-20 rounded-xl bg-muted/50 animate-pulse" />)}</div>
          ) : lists.error ? (
            <div className="rounded-xl border bg-card text-center py-12 px-4">
              <p className="text-sm text-muted-foreground">Couldn’t load lists. {lists.error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => lists.refetch()}>Retry</Button>
            </div>
          ) : mine.length === 0 ? (
            <div className="rounded-xl border bg-card text-center py-14 px-4">
              <FolderOpen className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
              <div className="text-sm font-medium">No saved {isPeople ? "people" : "company"} lists yet</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">Save a search or select records on the {isPeople ? "People" : "Companies"} page and add them to a list to build a targeted audience.</p>
              <Button size="sm" className="mt-3 gap-1.5" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New list</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {mine.map((l: any) => (
                <button key={l.id} onClick={() => setLocation(`/v2/lists/${l.id}`)}
                  className="text-left rounded-xl border bg-card p-3.5 shadow-sm hover:shadow transition-shadow group">
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 size-9 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}><Icon className="size-5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate flex items-center gap-1">{l.name} <ChevronRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{l.memberCount ?? 0} {isPeople ? "people" : "companies"}{l.updatedAt ? ` · updated ${fmt(l.updatedAt)}` : ""}</div>
                      {l.description && <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{l.description}</div>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New {isPeople ? "people" : "company"} list</DialogTitle>
            <DialogDescription>Create a saved list you can add records to.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="list-name">List name</Label>
            <Input id="list-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={isPeople ? "e.g. VP Sales — West" : "e.g. Target accounts Q3"} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create.mutate({ name: name.trim(), entityType } as any); }} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={create.isPending || !name.trim()} onClick={() => create.mutate({ name: name.trim(), entityType } as any)}>{create.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
