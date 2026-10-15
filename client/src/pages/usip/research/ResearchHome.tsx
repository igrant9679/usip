/**
 * Research — the markets a workspace sells into (/research).
 *
 * Owner plan 2026-10-14: a market is an industry or research area; inside it,
 * sectors are groups of organizations that buy alike. Research drives
 * targeting, the Revenue Engine and the AI writers in later phases; phase 1 is
 * the store, built by hand. The strip under the header joins Personas and the
 * ICP page, which Research absorbs.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Shell, PageHeader, QueryError, TableSkeleton, EmptyState } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Sparkles, Telescope } from "lucide-react";
import { RecentRuns, ResearchSettingsButton, StartRunDialog } from "@/components/usip/research/ResearchRuns";
import { DownstreamSection } from "@/components/usip/research/DownstreamSection";
import { ResearchSubNav, StatusBadge, reportDropped, useResearchRoles } from "@/components/usip/research/ResearchFields";

export default function ResearchHome() {
  const [, navigate] = useLocation();
  const { canEdit } = useResearchRoles();
  const markets = trpc.research.markets.list.useQuery();
  const [open, setOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const create = trpc.research.markets.create.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (r) => {
      reportDropped(r.dropped);
      setOpen(false);
      navigate(`/research/markets/${r.id}`);
    },
  });
  const submit = () => {
    if (!name.trim()) { toast.error("Give the market a name"); return; }
    create.mutate({ content: { name, tagline } });
  };
  const rows = markets.data ?? [];

  return (
    <Shell title="Research">
      <PageHeader
        icon={<Telescope className="size-5" />}
        title="Research"
        pageKey="research"
        description="The markets you sell into and the sectors inside them: who buys, what they need, and how to talk to them."
      >
        <ResearchSettingsButton />
        {canEdit && (
          <Button variant="outline" onClick={() => setAiOpen(true)}>
            <Sparkles className="size-4 mr-1" /> Research a market with AI
          </Button>
        )}
        {canEdit && (
          <Button onClick={() => { setName(""); setTagline(""); setOpen(true); }}>
            <Plus className="size-4 mr-1" /> New market
          </Button>
        )}
      </PageHeader>
      <ResearchSubNav />

      <div className="px-4 md:px-6 pb-6">
      {markets.error ? (
        <Card className="shrink-0"><CardContent className="pt-6"><QueryError message={markets.error.message} onRetry={() => markets.refetch()} /></CardContent></Card>
      ) : markets.isLoading ? (
        <Card className="shrink-0"><CardContent className="pt-6"><TableSkeleton rows={4} /></CardContent></Card>
      ) : rows.length === 0 ? (
        <Card className="shrink-0">
          <CardContent className="pt-6">
            <EmptyState
              icon={Telescope}
              title="No markets yet"
              description="A market is an industry or area you sell into, like K-12 education or regional hospitals. Inside it, add the sectors that buy alike, with their targeting, messaging and sources. Build it by hand, or let AI research it on the web and review what it finds. Only this workspace can see its research."
              action={canEdit ? (
                <div className="flex gap-2 justify-center flex-wrap">
                  <Button variant="outline" onClick={() => setAiOpen(true)}><Sparkles className="size-4 mr-1" /> Research a market with AI</Button>
                  <Button onClick={() => setOpen(true)}><Plus className="size-4 mr-1" /> New market</Button>
                </div>
              ) : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((m) => (
            // The title is the card's link, stretched over it; Reports sits above it.
            <Card key={m.id} className="relative h-full transition hover:bg-accent/40">
                <CardContent className="pt-5 space-y-2">
                  <div className="flex items-start gap-2">
                    <Link href={`/research/markets/${m.id}`} className="font-medium text-sm flex-1 min-w-0 break-words after:absolute after:inset-0">{m.name}</Link>
                    <StatusBadge status={m.status} />
                  </div>
                  {m.tagline && <p className="text-xs text-muted-foreground line-clamp-2">{m.tagline}</p>}
                  <div className="text-xs text-muted-foreground">
                    {m.sectorCount === 0
                      ? "No sectors yet"
                      : `${m.sectorCount} ${m.sectorCount === 1 ? "sector" : "sectors"}: ${m.sectorsByStatus.verified} verified, ${m.sectorsByStatus.researched} researched, ${m.sectorsByStatus.draft} draft`}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">Updated {new Date(m.updatedAt).toLocaleDateString()}</span>
                    <Link href={`/research/markets/${m.id}/report`} className="relative z-10 text-xs underline underline-offset-2">Reports</Link>
                  </div>
                </CardContent>
            </Card>
          ))}
        </div>
      )}
      <div className="mt-4"><RecentRuns /></div>
      <div className="mt-4"><DownstreamSection /></div>
      </div>

      <StartRunDialog target={{ kind: "market" }} open={aiOpen} onOpenChange={setAiOpen} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New market</DialogTitle>
            <DialogDescription>An industry or area you sell into. You add its sectors next.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="market-name">Name</Label>
              <Input id="market-name" autoFocus value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="e.g. Regional authorities" onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="market-tagline">Tagline (optional)</Label>
              <Input id="market-tagline" value={tagline} maxLength={300} onChange={(e) => setTagline(e.target.value)} placeholder="One line on why this market matters to you" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={create.isPending || !name.trim()}>Create market</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
