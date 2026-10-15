/**
 * One market (/research/markets/:id): its sectors, overview, glossary,
 * competitors and sources. Managers and admins edit; everyone in the
 * workspace reads. Every save is a version (History).
 */
import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Shell, PageHeader, QueryError, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Sparkles, Telescope, Trash2, Users } from "lucide-react";
import { RunsForRecord, StartRunDialog, type RunTarget } from "@/components/usip/research/ResearchRuns";
import { MarketExtras } from "@/components/usip/research/MarketExtras";
import { confirmAction } from "@/components/usip/Common";
import {
  Crumbs, HistoryButton, LinesInput, RowsEditor, SaveBar, Section, StatusBadge,
  reportDropped, useResearchDraft, useResearchRoles,
} from "@/components/usip/research/ResearchFields";
import {
  RESEARCH_PART_LABEL, RESEARCH_STATUSES, RESEARCH_STATUS_LABEL, SECTOR_SCORE_KEYS, SECTOR_SCORE_LABEL,
  type MarketContent, type ResearchStatus,
} from "@shared/researchShape";

export default function ResearchMarket() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const { canEdit, canDelete } = useResearchRoles();
  const q = trpc.research.markets.get.useQuery({ id }, { enabled: Number.isFinite(id) && id > 0 });
  const market = q.data?.market;
  const draft = useResearchDraft<MarketContent>(market?.content, market?.revision);
  const c = draft.value;

  const save = trpc.research.markets.update.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async (r) => {
      reportDropped(r.dropped);
      toast.success(r.changed.length ? `Saved as version ${r.revision}` : "Nothing changed");
      draft.discard();
      await q.refetch();
    },
  });
  const del = trpc.research.markets.delete.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => { toast.success("Market deleted"); navigate("/research"); },
  });

  const [sectorOpen, setSectorOpen] = useState(false);
  const [sectorName, setSectorName] = useState("");
  const [sectorShort, setSectorShort] = useState("");
  const createSector = trpc.research.sectors.create.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (r) => { reportDropped(r.dropped); setSectorOpen(false); navigate(`/research/sectors/${r.id}`); },
  });
  const openSector = (name = "") => { setSectorName(name); setSectorShort(""); setSectorOpen(true); };
  const [runTarget, setRunTarget] = useState<RunTarget | null>(null);

  if (q.error) {
    return (
      <Shell title="Research">
        <Crumbs items={[{ href: "/research", label: "Research" }, { label: "Market" }]} />
        <div className="p-4 md:p-6"><Card><CardContent className="pt-6"><QueryError message={q.error.message} onRetry={() => q.refetch()} /></CardContent></Card></div>
      </Shell>
    );
  }
  if (!market || !c) {
    return (
      <Shell title="Research">
        <div className="p-4 md:p-6"><Card><CardContent className="pt-6"><TableSkeleton rows={6} /></CardContent></Card></div>
      </Shell>
    );
  }

  const sectors = q.data!.sectors;
  const sectorNames = new Set(sectors.map((s) => s.name.toLowerCase()));
  const suggestions = c.suggestedSectors.filter((s) => s.name.trim() && !sectorNames.has(s.name.trim().toLowerCase()));
  const ro = !canEdit;

  const remove = () => confirmAction(
    {
      title: `Delete "${market.content.name}"?`,
      description: `This deletes the market, its ${sectors.length} ${sectors.length === 1 ? "sector" : "sectors"} and all their versions. Personas linked to those sectors are kept but unlinked. This cannot be undone.`,
      confirmLabel: "Delete market",
    },
    () => del.mutate({ id }),
  );

  return (
    <Shell title={market.content.name}>
      <Crumbs items={[{ href: "/research", label: "Research" }, { label: market.content.name }]} />
      <PageHeader icon={<Telescope className="size-5" />} title={market.content.name} description={market.content.tagline || "A market you sell into."}>
        <StatusBadge status={market.content.status} />
        {market.source !== "manual" && <Badge variant="outline" className="text-[10px]">{market.source === "ai" ? "AI research" : "Downstream"}</Badge>}
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setRunTarget({ kind: "market", marketId: id, name: market.content.name })}>
            <Sparkles className="size-4 mr-1" /> Refresh with AI
          </Button>
        )}
        <HistoryButton entityType="market" entityId={id} currentRevision={market.revision} dirty={draft.dirty} onRestored={() => q.refetch()} />
        {canDelete && (
          <Button variant="outline" size="sm" onClick={remove} disabled={del.isPending}>
            <Trash2 className="size-4 mr-1 text-destructive" /> Delete
          </Button>
        )}
      </PageHeader>

      <div className="p-4 md:p-6 space-y-4 w-full max-w-5xl">
        <Section
          title="Sectors"
          description="Groups of organizations in this market that buy alike. Each has its own targeting, messaging, personas and sources."
          actions={canEdit ? (
            <div className="flex gap-2 flex-wrap justify-end">
              <Button size="sm" variant="outline" onClick={() => setRunTarget({ kind: "sector", marketId: id, marketName: market.content.name })}>
                <Sparkles className="size-4 mr-1" /> Research a sector with AI
              </Button>
              <Button size="sm" onClick={() => openSector()}><Plus className="size-4 mr-1" /> New sector</Button>
            </div>
          ) : undefined}
        >
          {sectors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sectors yet.{canEdit ? " Add the first one to start researching who buys." : ""}</p>
          ) : (
            <div className="divide-y rounded-md border">
              {sectors.map((s) => {
                const scores = (s.scores ?? {}) as Record<string, number | null>;
                const scored = SECTOR_SCORE_KEYS.filter((k) => scores[k] != null);
                return (
                  <Link key={s.id} href={`/research/sectors/${s.id}`} className="flex items-start gap-3 p-3 hover:bg-accent/40">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{s.name}</span>
                        {s.shortName && s.shortName !== s.name && <span className="text-xs text-muted-foreground">({s.shortName})</span>}
                        <StatusBadge status={s.status} />
                      </div>
                      {s.tagline && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.tagline}</p>}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {scored.map((k) => (
                          <Badge key={k} variant="outline" className="text-[10px]">{SECTOR_SCORE_LABEL[k]} {scores[k]}/5</Badge>
                        ))}
                        <Badge variant="outline" className="text-[10px] gap-1"><Users className="size-3" /> {s.personaCount}</Badge>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Suggested next (research one with AI):</div>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <Button key={s.name} size="sm" variant="outline" className="h-7 text-xs" title={s.why || undefined} disabled={!canEdit}
                    onClick={() => setRunTarget({ kind: "sector", marketId: id, marketName: market.content.name, subject: s.name })}>
                    <Sparkles className="size-3 mr-1" /> {s.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Section>

        <Section title="Overview" description="What this market is and why it matters to you.">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={c.name} maxLength={160} disabled={ro} onChange={(e) => draft.patch({ name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={c.status} disabled={ro} onValueChange={(v) => draft.patch({ status: v as ResearchStatus })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RESEARCH_STATUSES.map((s) => <SelectItem key={s} value={s}>{RESEARCH_STATUS_LABEL[s]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Tagline</Label>
            <Input value={c.tagline} maxLength={300} disabled={ro} onChange={(e) => draft.patch({ tagline: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Headline</Label>
            <Input value={c.overview.headline} disabled={ro} onChange={(e) => draft.patch({ overview: { ...c.overview, headline: e.target.value } })} placeholder="The one thing to know about this market" />
          </div>
          <div className="space-y-2">
            <Label>Overview</Label>
            <Textarea rows={5} value={c.overview.lede} disabled={ro} onChange={(e) => draft.patch({ overview: { ...c.overview, lede: e.target.value } })} placeholder="How the market works, who is in it, where the money comes from." />
          </div>
          <LinesInput label="Open questions" hint="What is still unknown. One per line." value={c.openQuestions} disabled={ro} onChange={(v) => draft.patch({ openQuestions: v })} rows={3} />
        </Section>

        <MarketExtras extras={market.extras} />

        <Section title={RESEARCH_PART_LABEL.suggestedSectors} description="Sectors worth researching next. Each one not yet added shows a button above.">
          <RowsEditor
            label="Suggestions"
            fields={[{ key: "name", label: "Sector" }, { key: "why", label: "Why it is worth researching", wide: true }]}
            value={c.suggestedSectors}
            onChange={(v) => draft.patch({ suggestedSectors: v })}
            addLabel="Add suggestion"
            disabled={ro}
          />
        </Section>

        <Section title={RESEARCH_PART_LABEL.glossary} description="Terms this market uses. Coming next: the AI writers, the phone agent and chat use these.">
          <RowsEditor
            label="Terms"
            fields={[{ key: "term", label: "Term" }, { key: "source", label: "Source link (optional)" }, { key: "definition", label: "Definition", multiline: true }]}
            value={c.glossary}
            onChange={(v) => draft.patch({ glossary: v })}
            addLabel="Add term"
            disabled={ro}
          />
        </Section>

        <Section title={RESEARCH_PART_LABEL.competitors} description="Who else sells into this market.">
          <RowsEditor
            label="Competitors"
            fields={[
              { key: "name", label: "Name" },
              { key: "category", label: "Category" },
              { key: "pricing", label: "Pricing" },
              { key: "url", label: "Website", placeholder: "https://" },
              { key: "positioning", label: "Positioning", multiline: true },
            ]}
            value={c.competitors}
            onChange={(v) => draft.patch({ competitors: v })}
            addLabel="Add competitor"
            disabled={ro}
          />
        </Section>

        <Section title={RESEARCH_PART_LABEL.sources} description="Where this came from. Links must start with http:// or https://.">
          <RowsEditor
            label="Sources"
            fields={[{ key: "title", label: "Title" }, { key: "url", label: "Link", placeholder: "https://" }]}
            value={c.sources}
            onChange={(v) => draft.patch({ sources: v })}
            addLabel="Add source"
            disabled={ro}
          />
        </Section>

        <RunsForRecord kind="market" id={id} />
      </div>

      <SaveBar
        dirty={draft.dirty}
        stale={draft.stale}
        saving={save.isPending}
        onDiscard={draft.discard}
        onSave={() => save.mutate({ id, expectedRevision: draft.baseRevision, content: c as unknown as Record<string, unknown> })}
      />

      {runTarget && <StartRunDialog target={runTarget} open={!!runTarget} onOpenChange={(v) => { if (!v) setRunTarget(null); }} />}

      <Dialog open={sectorOpen} onOpenChange={setSectorOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New sector</DialogTitle>
            <DialogDescription>A group of organizations in {market.content.name} that buy alike.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="sector-name">Name</Label>
              <Input id="sector-name" autoFocus value={sectorName} maxLength={160} onChange={(e) => setSectorName(e.target.value)} placeholder="e.g. K-12 school districts" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sector-short">Short name (optional)</Label>
              <Input id="sector-short" value={sectorShort} maxLength={60} onChange={(e) => setSectorShort(e.target.value)} placeholder="e.g. K-12" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSectorOpen(false)}>Cancel</Button>
            <Button
              disabled={createSector.isPending || !sectorName.trim()}
              onClick={() => createSector.mutate({ marketId: id, content: { name: sectorName, shortName: sectorShort } })}
            >
              Create sector
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
