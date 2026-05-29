/**
 * AddToSequenceButton — popover-style "enroll into sequence" trigger.
 *
 * Used in ContactDetail + LeadDetail headers so a user looking at one
 * record can enroll them into any non-archived workspace sequence
 * without bouncing back to /sequences. Calls the same bulkEnroll
 * mutation the multi-select picker uses (passing a single id) so we get
 * dedup, archived-sequence rejection, and the invalid-email guard for
 * free. Single source of truth on the server.
 *
 * Props:
 *   entityType — "contact" | "lead" — which id field to pass server-side
 *   entityId   — the database row id
 *   labelOverride — optional shorter button label (default: "Add to sequence")
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Activity, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export type SequenceEnrollEntityType = "contact" | "lead" | "prospect";

export function AddToSequenceButton({
  entityType,
  entityId,
  labelOverride,
}: {
  entityType: SequenceEnrollEntityType;
  entityId: number;
  labelOverride?: string;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);

  // Sequences the user can enroll into: anything not archived. Including
  // drafts is intentional — you might want to load a draft with test
  // recipients before activating it. The bulkEnroll mutation will still
  // reject hard cases (archived) server-side.
  const seqQ = trpc.sequences.list.useQuery(undefined, { enabled: open });
  const sequences = useMemo(
    () => ((seqQ.data ?? []) as any[]).filter((s) => s.status !== "archived"),
    [seqQ.data],
  );

  const bulkEnroll = trpc.sequences.bulkEnroll.useMutation({
    onSuccess: (r, vars) => {
      const seqName = sequences.find((s) => s.id === vars.sequenceId)?.name ?? "sequence";
      if (r.enrolled > 0) {
        toast.success(`Enrolled in "${seqName}"`);
      } else if (r.skippedAlreadyEnrolled > 0) {
        toast.info(`Already enrolled in "${seqName}"`);
      } else if (r.blockedInvalidEmail > 0) {
        toast.error("Blocked — invalid email on file");
      }
      utils.sequences.listEnrollments.invalidate({ sequenceId: vars.sequenceId });
      utils.sequences.getEnrollmentStats.invalidate({ sequenceId: vars.sequenceId });
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-3.5 mr-1" /> {labelOverride ?? "Add to sequence"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command>
          <CommandInput placeholder="Find a sequence…" />
          <CommandList>
            {seqQ.isLoading ? (
              <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {sequences.length === 0 ? "No sequences yet — create one first." : "No matches."}
                </CommandEmpty>
                <CommandGroup>
                  {sequences.map((s) => (
                    <CommandItem
                      key={s.id}
                      value={s.name}
                      disabled={bulkEnroll.isPending}
                      onSelect={() => bulkEnroll.mutate({
                        sequenceId: s.id,
                        contactIds: entityType === "contact" ? [entityId] : undefined,
                        leadIds: entityType === "lead" ? [entityId] : undefined,
                        prospectIds: entityType === "prospect" ? [entityId] : undefined,
                      })}
                    >
                      <Activity className="size-3.5 mr-2 text-muted-foreground" />
                      <span className="flex-1 truncate text-sm">{s.name}</span>
                      <Badge
                        variant="outline"
                        className={`ml-2 text-[10px] ${
                          s.status === "active" ? "text-emerald-700 border-emerald-300 dark:text-emerald-300" :
                          s.status === "paused" ? "text-amber-700 border-amber-300 dark:text-amber-300" :
                          "text-muted-foreground"
                        }`}
                      >
                        {s.status}
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
