/**
 * What discovery uses for a campaign that has no targeting of its own
 * (Research phase 4): the ICP learned from deals (the default, and how it
 * always worked), the researched sectors, or both. Admins change it.
 */
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useResearchRoles } from "./ResearchFields";

const OPTIONS = [
  { id: "inferred", label: "This ICP (learned from your deals)" },
  { id: "research", label: "Your researched sectors" },
  { id: "merged", label: "Both" },
] as const;

export function IcpFallbackCard() {
  const { canDelete: isAdmin } = useResearchRoles();
  const utils = trpc.useUtils();
  const q = trpc.research.settings.get.useQuery();
  const set = trpc.research.settings.setIcpFallback.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async () => { toast.success("Saved"); await utils.research.settings.get.invalidate(); },
  });
  if (!q.data) return null;
  return (
    <Card>
      <CardContent className="pt-5 flex flex-col sm:flex-row sm:items-center gap-3 text-sm">
        <div className="flex-1 min-w-0">
          <div className="font-medium">When a campaign has no targeting of its own</div>
          <div className="text-xs text-muted-foreground">
            Discovery fills in any titles, industries, places, keywords or size the campaign leaves blank from this. Only
            sectors marked Researched or Verified count.
          </div>
        </div>
        <Select
          value={q.data.icpFallback}
          disabled={!isAdmin || set.isPending}
          onValueChange={(v) => set.mutate({ icpFallback: v as (typeof OPTIONS)[number]["id"] })}
        >
          <SelectTrigger className="w-full sm:w-[17rem]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {OPTIONS.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  );
}
