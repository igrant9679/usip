/**
 * Batch prospect-photo upload + delegation.
 *
 * Flow (the efficient path): drop many image files → each is resized to a
 * small square client-side → auto-matched to a prospect by filename (id,
 * email, LinkedIn slug, or full name) → shown in a review grid where any
 * unmatched/incorrect rows are fixed with a searchable picker → assigned in
 * one batch. All photos are user-uploaded content (no third-party fetch).
 */
import { useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { fileToSquareDataUrl, ProspectAvatar } from "@/components/usip/ProspectAvatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ImagePlus, Check, X, Loader2, ChevronsUpDown, UploadCloud } from "lucide-react";

interface ProspectLite {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  company: string | null;
  linkedinUrl: string | null;
}

interface PhotoItem {
  key: string; // local id
  filename: string;
  dataUrl: string;
  prospectId: number | null;
  matchedBy: "id" | "email" | "linkedin" | "name" | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function linkedinSlug(url: string | null): string | null {
  if (!url) return null;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const i = segs.indexOf("in");
    return i >= 0 && segs[i + 1] ? segs[i + 1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function BatchPhotoUpload({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [reading, setReading] = useState(false);

  // Workspace prospects (lightweight) for matching + the picker.
  const listQ = trpc.prospects.list.useQuery({ page: 1, perPage: 200 }, { enabled: open });
  const prospects: ProspectLite[] = useMemo(
    () => (listQ.data?.data ?? []) as ProspectLite[],
    [listQ.data],
  );

  // Build a normalized-key → prospectId index for auto-matching.
  const matchIndex = useMemo(() => {
    const byKey = new Map<string, { id: number; by: PhotoItem["matchedBy"] }>();
    const put = (k: string | null, id: number, by: PhotoItem["matchedBy"]) => {
      if (!k) return;
      const nk = norm(k);
      if (nk && !byKey.has(nk)) byKey.set(nk, { id, by });
    };
    for (const p of prospects) {
      put(`${p.firstName} ${p.lastName}`, p.id, "name");
      if (p.email) {
        put(p.email, p.id, "email");
        put(p.email.split("@")[0], p.id, "email");
      }
      put(linkedinSlug(p.linkedinUrl), p.id, "linkedin");
      put(String(p.id), p.id, "id");
      put(`prospect${p.id}`, p.id, "id");
    }
    return byKey;
  }, [prospects]);

  const matchFilename = (stem: string): { id: number | null; by: PhotoItem["matchedBy"] } => {
    const hit = matchIndex.get(norm(stem));
    return hit ? { id: hit.id, by: hit.by } : { id: null, by: null };
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setReading(true);
    const next: PhotoItem[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const dataUrl = await fileToSquareDataUrl(file, 128);
        if (dataUrl.length > 60000) {
          toast.error(`"${file.name}" is too large after resize — skipped`);
          continue;
        }
        const stem = file.name.replace(/\.[^.]+$/, "");
        const m = matchFilename(stem);
        next.push({
          key: `${file.name}-${next.length}-${dataUrl.length}`,
          filename: file.name,
          dataUrl,
          prospectId: m.id,
          matchedBy: m.by,
        });
      } catch {
        toast.error(`Could not read "${file.name}"`);
      }
    }
    if (inputRef.current) inputRef.current.value = "";
    setItems((prev) => [...prev, ...next].slice(0, 50));
    setReading(false);
    if (next.length) {
      const matched = next.filter((n) => n.prospectId).length;
      toast.success(`Added ${next.length} · auto-matched ${matched}`);
    }
  };

  const setProspect = (key: string, id: number | null) =>
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, prospectId: id, matchedBy: it.matchedBy } : it)),
    );
  const removeItem = (key: string) => setItems((prev) => prev.filter((it) => it.key !== key));

  const bulk = trpc.prospects.bulkUploadProfileImages.useMutation({
    onSuccess: (res) => {
      utils.prospects.list.invalidate();
      toast.success(`Assigned ${res.uploaded} photo${res.uploaded === 1 ? "" : "s"}` + (res.failed.length ? ` · ${res.failed.length} failed` : ""));
      setItems([]);
      onClose();
    },
    onError: (e) => toast.error(e.message || "Assignment failed"),
  });

  const ready = items.filter((it) => it.prospectId);
  const usedIds = new Set(ready.map((it) => it.prospectId));
  const duplicateTarget = usedIds.size !== ready.length;

  const assign = () => {
    if (!ready.length) return;
    bulk.mutate({ items: ready.map((it) => ({ id: it.prospectId!, dataUrl: it.dataUrl })) });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Batch upload photos</DialogTitle>
          <DialogDescription>
            Drop images, then confirm which prospect each belongs to. Files named after a
            prospect (name, email, LinkedIn, or id) are matched automatically.
          </DialogDescription>
        </DialogHeader>

        {/* Dropzone */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFiles(e.dataTransfer.files);
          }}
          className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 py-7 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          {reading ? <Loader2 className="size-6 animate-spin" /> : <UploadCloud className="size-6" />}
          <span>Drop images here or click to choose ({items.length}/50)</span>
          <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
        </button>

        {/* Review grid */}
        {items.length > 0 && (
          <div className="max-h-[46vh] overflow-y-auto -mx-1 px-1 space-y-2">
            {items.map((it) => (
              <div key={it.key} className="flex items-center gap-3 rounded-md border border-border/70 p-2">
                <img src={it.dataUrl} alt="" className="size-10 rounded-full object-cover ring-1 ring-border/60 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{it.filename}</div>
                  {it.matchedBy ? (
                    <Badge variant="outline" className="mt-0.5 text-[10px] capitalize">matched by {it.matchedBy}</Badge>
                  ) : it.prospectId ? null : (
                    <Badge variant="secondary" className="mt-0.5 text-[10px]">needs a prospect</Badge>
                  )}
                </div>
                <ProspectPicker
                  prospects={prospects}
                  value={it.prospectId}
                  onChange={(id) => setProspect(it.key, id)}
                />
                <button onClick={() => removeItem(it.key)} className="shrink-0 p-1 text-muted-foreground hover:text-destructive" aria-label="Remove">
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {duplicateTarget && (
          <p className="text-[12px] text-amber-600">Two photos target the same prospect — only the last will stick.</p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={assign} disabled={!ready.length || bulk.isPending} className="gap-1.5">
            {bulk.isPending ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
            Assign {ready.length || ""} photo{ready.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProspectPicker({
  prospects,
  value,
  onChange,
}: {
  prospects: ProspectLite[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? prospects.find((p) => p.id === value) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-48 justify-between gap-1.5 shrink-0">
          <span className="truncate">
            {selected ? `${selected.firstName} ${selected.lastName}` : "Choose prospect"}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <Command
          filter={(val, search) => (val.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Search prospects…" />
          <CommandList>
            <CommandEmpty>No prospect found.</CommandEmpty>
            <CommandGroup>
              {prospects.map((p) => {
                const label = `${p.firstName} ${p.lastName}${p.company ? ` · ${p.company}` : ""}`;
                return (
                  <CommandItem
                    key={p.id}
                    value={`${label} ${p.email ?? ""}`}
                    onSelect={() => {
                      onChange(p.id === value ? null : p.id);
                      setOpen(false);
                    }}
                  >
                    <Check className={value === p.id ? "mr-2 size-4 opacity-100" : "mr-2 size-4 opacity-0"} />
                    <span className="truncate">{label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
