/**
 * Mindmaps — List / Gallery Page
 * Shows all mindmaps for the workspace. Users can create, rename, and delete maps.
 * Clicking a map opens the interactive canvas at /mindmaps/:id
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { GitFork, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";

export default function Mindmaps() {
  const { data: maps = [], refetch } = trpc.mindmaps.list.useQuery();
  const createMut = trpc.mindmaps.create.useMutation({ onSuccess: () => refetch() });
  const renameMut = trpc.mindmaps.rename.useMutation({ onSuccess: () => refetch() });
  const deleteMut = trpc.mindmaps.delete.useMutation({ onSuccess: () => refetch() });

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ id: number; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function handleCreate() {
    if (!newName.trim()) return;
    createMut.mutate(
      { name: newName.trim() },
      {
        onSuccess: (data) => {
          toast.success("Mindmap created");
          setShowCreate(false);
          setNewName("");
          // Navigate to the new canvas
          window.location.href = `/mindmaps/${data.id}`;
        },
        onError: () => toast.error("Failed to create mindmap"),
      }
    );
  }

  function handleRename() {
    if (!renameTarget || !renameValue.trim()) return;
    renameMut.mutate(
      { id: renameTarget.id, name: renameValue.trim() },
      {
        onSuccess: () => { toast.success("Renamed"); setRenameTarget(null); },
        onError: () => toast.error("Failed to rename"),
      }
    );
  }

  function handleDelete(id: number) {
    confirmAction(
      { title: "Delete this mindmap?", description: "This cannot be undone.", confirmLabel: "Delete" },
      () => {
        deleteMut.mutate(
          { id },
          {
            onSuccess: () => toast.success("Mindmap deleted"),
            onError: () => toast.error("Failed to delete"),
          }
        );
      },
    );
  }

  return (
    <Shell title="Mindmaps">
    <div className="flex flex-col h-full">
      <PageHeader
        title="Mindmaps"
        description="Visually develop ideas, plan projects, and create tasks or notes directly from your maps."
        pageKey="mindmaps"
        icon={<GitFork className="size-5" />}
      >
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus className="size-4 mr-1" /> New Mindmap
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto p-6">
        {maps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center gap-4">
            <GitFork className="size-12 text-muted-foreground/40" />
            <div>
              <p className="text-lg font-medium">No mindmaps yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create your first mindmap to start developing ideas visually.
              </p>
            </div>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="size-4 mr-1" /> Create Mindmap
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {maps.map((map) => (
              <div
                key={map.id}
                className="group relative border rounded-xl bg-card hover:shadow-md transition-shadow overflow-hidden"
              >
                {/* Canvas preview placeholder */}
                <Link href={`/mindmaps/${map.id}`}>
                  <div className="h-36 bg-gradient-to-br from-violet-50 to-indigo-100 dark:from-violet-950/30 dark:to-indigo-950/30 flex items-center justify-center cursor-pointer">
                    <GitFork className="size-10 text-violet-400 dark:text-violet-500" />
                  </div>
                </Link>

                <div className="p-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/mindmaps/${map.id}`}>
                      <p className="font-medium text-sm truncate hover:underline cursor-pointer">{map.name}</p>
                    </Link>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Updated {formatDistanceToNow(new Date(map.updatedAt), { addSuffix: true })}
                    </p>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7 shrink-0">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => { setRenameTarget({ id: map.id, name: map.name }); setRenameValue(map.name); }}
                      >
                        <Pencil className="size-4 mr-2" /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => handleDelete(map.id)}
                      >
                        <Trash2 className="size-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Mindmap</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Mindmap name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || createMut.isPending}>
              {createMut.isPending ? "Creating…" : "Create & Open"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Mindmap</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button onClick={handleRename} disabled={!renameValue.trim() || renameMut.isPending}>
              {renameMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </Shell>
  );
}
