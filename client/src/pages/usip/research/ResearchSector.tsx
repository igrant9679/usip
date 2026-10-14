/**
 * One sector (/research/sectors/:id): who buys, the personas, targeting,
 * messaging, market facts and sources. Managers and admins edit; everyone in
 * the workspace reads. Every save is a version (History).
 *
 * The market facts follow Downstream's segment (money flow, programs, how they
 * buy, obligations, helpers, policy watch) but every one is optional, so a
 * sector in any industry fits.
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
import { Link2, Pencil, Plus, Sparkles, Telescope, Trash2, Unlink } from "lucide-react";
import { StartRunDialog } from "@/components/usip/research/ResearchRuns";
import { confirmAction } from "@/components/usip/Common";
import {
  Crumbs, HistoryButton, LinesInput, RowsEditor, SaveBar, Section, StatusBadge, TagInput,
  reportDropped, useResearchDraft, useResearchRoles,
} from "@/components/usip/research/ResearchFields";
import { EMPTY_PERSONA, PersonaFormFields, personaFormFrom, personaPayload, type PersonaForm } from "@/components/usip/research/PersonaFormFields";
import {
  RESEARCH_STATUSES, RESEARCH_STATUS_LABEL, SECTOR_SCORE_KEYS, SECTOR_SCORE_LABEL,
  type ResearchStatus, type SectorContent, type SectorScoreKey,
} from "@shared/researchShape";

const SCORE_HINT: Record<SectorScoreKey, string> = {
  reach: "How many organizations you could reach",
  money: "How much they can spend",
  pain: "How much the problem hurts",
  fit: "How well your offer fits",
  access: "How easy the buyer is to reach",
};

export default function ResearchSector() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const { canEdit, canDelete } = useResearchRoles();
  const q = trpc.research.sectors.get.useQuery({ id }, { enabled: Number.isFinite(id) && id > 0 });
  const sector = q.data?.sector;
  const draft = useResearchDraft<SectorContent>(sector?.content, sector?.revision);
  const c = draft.value;

  const save = trpc.research.sectors.update.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async (r) => {
      reportDropped(r.dropped);
      toast.success(r.changed.length ? `Saved as version ${r.revision}` : "Nothing changed");
      draft.discard();
      await q.refetch();
    },
  });
  const del = trpc.research.sectors.delete.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (r) => { toast.success("Sector deleted"); navigate(`/research/markets/${r.marketId}`); },
  });

  // ── Personas in this sector ────────────────────────────────────────────
  const allPersonas = trpc.personas.list.useQuery(undefined, { enabled: canEdit });
  const [pOpen, setPOpen] = useState(false);
  const [pEditing, setPEditing] = useState<number | null>(null);
  const [pForm, setPForm] = useState<PersonaForm>(EMPTY_PERSONA);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkId, setLinkId] = useState<string>("");
  const [runOpen, setRunOpen] = useState(false);
  const afterPersona = async () => { await Promise.all([q.refetch(), allPersonas.refetch()]); };
  const createPersona = trpc.personas.create.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async () => { toast.success("Persona added"); setPOpen(false); await afterPersona(); },
  });
  const updatePersona = trpc.personas.update.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async () => { setPOpen(false); setLinkOpen(false); await afterPersona(); },
  });

  if (q.error) {
    return (
      <Shell title="Research">
        <Crumbs items={[{ href: "/research", label: "Research" }, { label: "Sector" }]} />
        <div className="p-4 md:p-6"><Card><CardContent className="pt-6"><QueryError message={q.error.message} onRetry={() => q.refetch()} /></CardContent></Card></div>
      </Shell>
    );
  }
  if (!sector || !c) {
    return (
      <Shell title="Research">
        <div className="p-4 md:p-6"><Card><CardContent className="pt-6"><TableSkeleton rows={6} /></CardContent></Card></div>
      </Shell>
    );
  }

  const market = q.data!.market;
  const personas = q.data!.personas;
  const ro = !canEdit;
  const t = c.targeting;
  const m = c.messaging;
  const f = c.facts;
  const setT = (p: Partial<SectorContent["targeting"]>) => draft.patch({ targeting: { ...t, ...p } });
  const setM = (p: Partial<SectorContent["messaging"]>) => draft.patch({ messaging: { ...m, ...p } });
  const setF = (p: Partial<SectorContent["facts"]>) => draft.patch({ facts: { ...f, ...p } });
  const unlinked = (allPersonas.data ?? []).filter((p: any) => p.sectorId == null);

  const newPersona = () => {
    // Start from the sector's saved targeting and pains; the person edits from there.
    const s = sector.content;
    setPForm({
      ...EMPTY_PERSONA,
      sectorId: id,
      targetTitles: s.targeting.titles,
      targetIndustries: s.targeting.industries,
      targetGeographies: s.targeting.geographies,
      keywords: s.targeting.keywords,
      employeeMin: s.targeting.employeeMin,
      employeeMax: s.targeting.employeeMax,
      pains: s.buyers.painPoints,
    });
    setPEditing(null);
    setPOpen(true);
  };
  const savePersona = () => {
    if (pForm.name.trim().length < 2) { toast.error("Give the persona a name"); return; }
    const body = { ...personaPayload(pForm), sectorId: id };
    if (pEditing) updatePersona.mutate({ id: pEditing, ...body });
    else createPersona.mutate(body);
  };

  const remove = () => confirmAction(
    {
      title: `Delete "${sector.content.name}"?`,
      description: "This deletes the sector and all its versions. Its personas are kept but unlinked. This cannot be undone.",
      confirmLabel: "Delete sector",
    },
    () => del.mutate({ id }),
  );

  return (
    <Shell title={sector.content.name}>
      <Crumbs items={[{ href: "/research", label: "Research" }, { href: `/research/markets/${market.id}`, label: market.name }, { label: sector.content.name }]} />
      <PageHeader icon={<Telescope className="size-5" />} title={sector.content.name} description={sector.content.tagline || `A sector of ${market.name}.`}>
        <StatusBadge status={sector.content.status} />
        {sector.source !== "manual" && <Badge variant="outline" className="text-[10px]">{sector.source === "ai" ? "AI research" : "Downstream"}</Badge>}
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setRunOpen(true)}>
            <Sparkles className="size-4 mr-1" /> Refresh with AI
          </Button>
        )}
        <HistoryButton entityType="sector" entityId={id} currentRevision={sector.revision} dirty={draft.dirty} onRestored={() => q.refetch()} />
        {canDelete && (
          <Button variant="outline" size="sm" onClick={remove} disabled={del.isPending}>
            <Trash2 className="size-4 mr-1 text-destructive" /> Delete
          </Button>
        )}
      </PageHeader>

      <div className="p-4 md:p-6 space-y-4 w-full max-w-5xl">
        <Section title="Overview" description="Once the AI writers read research, they will use a sector only when it is Researched or Verified.">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem]">
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
            <div className="space-y-2">
              <Label>As of</Label>
              <Input type="date" value={c.asOf} disabled={ro} onChange={(e) => draft.patch({ asOf: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label>Short name</Label>
              <Input value={c.shortName} maxLength={60} disabled={ro} onChange={(e) => draft.patch({ shortName: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Tagline</Label>
              <Input value={c.tagline} maxLength={300} disabled={ro} onChange={(e) => draft.patch({ tagline: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Summary</Label>
            <Textarea rows={5} value={c.summary} disabled={ro} onChange={(e) => draft.patch({ summary: e.target.value })} placeholder="Who these organizations are, what they do, and why they would buy." />
          </div>
          <div className="space-y-2">
            <Label>Scores</Label>
            <p className="text-xs text-muted-foreground -mt-1">1 is low, 5 is high. Fit is against what you sell.</p>
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-5">
              {SECTOR_SCORE_KEYS.map((k) => (
                <div key={k} className="space-y-1" title={SCORE_HINT[k]}>
                  <span className="text-[11px] text-muted-foreground">{SECTOR_SCORE_LABEL[k]}</span>
                  <Select
                    value={c.scores[k] != null ? String(c.scores[k]) : "none"}
                    disabled={ro}
                    onValueChange={(v) => draft.patch({ scores: { ...c.scores, [k]: v === "none" ? null : Number(v) } })}
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not scored</SelectItem>
                      {[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Buyers and pains" description="The roles that buy or sign off, and the problems they have.">
          <TagInput label="Buyer roles" value={c.buyers.roles} disabled={ro} onChange={(v) => draft.patch({ buyers: { ...c.buyers, roles: v } })} placeholder="Finance director, Program manager…" />
          <LinesInput label="Pain points" hint="One per line." value={c.buyers.painPoints} disabled={ro} onChange={(v) => draft.patch({ buyers: { ...c.buyers, painPoints: v } })} rows={4} />
        </Section>

        <Section
          id="personas"
          title="Personas"
          description="The buyers in this sector. A new persona starts from this sector's saved targeting and pains."
          actions={canEdit ? (
            <div className="flex gap-2">
              {unlinked.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => { setLinkId(""); setLinkOpen(true); }}>
                  <Link2 className="size-4 mr-1" /> Link existing
                </Button>
              )}
              <Button size="sm" onClick={newPersona}><Plus className="size-4 mr-1" /> New persona</Button>
            </div>
          ) : undefined}
        >
          {personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">No personas in this sector yet.</p>
          ) : (
            <div className="space-y-2">
              {personas.map((p: any) => {
                const pf = personaFormFrom(p);
                return (
                  <div key={p.id} className="flex items-start gap-2 border rounded p-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="font-medium text-sm">{p.name}</div>
                      {pf.cares && <p className="text-xs text-muted-foreground">Cares about: {pf.cares}</p>}
                      {pf.angle && <p className="text-xs text-muted-foreground">Angle: {pf.angle}</p>}
                      <div className="flex flex-wrap gap-1">
                        {pf.targetTitles.slice(0, 4).map((x) => <Badge key={"t" + x} variant="secondary" className="text-[10px]">{x}</Badge>)}
                        {pf.pains.length > 0 && <Badge variant="outline" className="text-[10px]">{pf.pains.length} {pf.pains.length === 1 ? "pain" : "pains"}</Badge>}
                        {pf.objections.length > 0 && <Badge variant="outline" className="text-[10px]">{pf.objections.length} {pf.objections.length === 1 ? "objection" : "objections"}</Badge>}
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex gap-1 shrink-0">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Edit persona" onClick={() => { setPForm(pf); setPEditing(p.id); setPOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Unlink from this sector" disabled={updatePersona.isPending} onClick={() => updatePersona.mutate({ id: p.id, sectorId: null })}>
                          <Unlink className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">All personas, including those in no sector, are on the <Link href="/personas" className="underline">Personas</Link> tab.</p>
        </Section>

        <Section title="Targeting" description="Who to look for. Coming next: campaigns, discovery and screening start from this.">
          <TagInput label="Job titles" hint="Clean titles as they appear on LinkedIn." value={t.titles} disabled={ro} onChange={(v) => setT({ titles: v })} placeholder="Director of Federal Programs…" />
          <TagInput label="Industries" hint="LinkedIn industry names." value={t.industries} disabled={ro} onChange={(v) => setT({ industries: v })} placeholder="Primary and Secondary Education…" />
          <TagInput label="Geographies" value={t.geographies} disabled={ro} onChange={(v) => setT({ geographies: v })} placeholder="United States, Texas…" />
          <TagInput label="Keywords" value={t.keywords} disabled={ro} onChange={(v) => setT({ keywords: v })} placeholder="title I, federal grants…" />
          <TagInput label="Organization types" value={t.organizationTypes} disabled={ro} onChange={(v) => setT({ organizationTypes: v })} placeholder="School district, County government…" />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Min employees</Label>
              <Input type="number" min={1} value={t.employeeMin ?? ""} disabled={ro} onChange={(e) => setT({ employeeMin: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div className="space-y-2">
              <Label>Max employees</Label>
              <Input type="number" min={1} value={t.employeeMax ?? ""} disabled={ro} onChange={(e) => setT({ employeeMax: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>
          <TagInput label="Never target" hint="Short words. A title, company name or industry containing one is off target." value={t.exclude} disabled={ro} onChange={(v) => setT({ exclude: v })} placeholder="student, intern, vendor…" />
        </Section>

        <Section title="Messaging" description="How to talk to this sector. Coming next: every AI writer reads this, and copy is checked against the avoid rules.">
          <LinesInput label="Lead with" hint="One per line." value={m.leadWith} disabled={ro} onChange={(v) => setM({ leadWith: v })} rows={3} />
          <LinesInput label="Avoid" hint="Things never to say or claim. One per line." value={m.avoid} disabled={ro} onChange={(v) => setM({ avoid: v })} rows={3} />
          <TagInput label="Vocabulary" hint="Words this sector uses." value={m.vocabulary} disabled={ro} onChange={(v) => setM({ vocabulary: v })} />
          <div className="space-y-2">
            <Label>Sample opening line</Label>
            <Textarea rows={3} value={m.sampleOpening} disabled={ro} onChange={(e) => setM({ sampleOpening: e.target.value })} placeholder="An example to adapt, never to copy word for word." />
          </div>
        </Section>

        <Section title="Market facts" description="All optional. Leave a number blank rather than guess, and cite where each one came from.">
          <RowsEditor
            label="Market size"
            fields={[{ key: "value", label: "Value", placeholder: "13,000" }, { key: "label", label: "What it counts", placeholder: "public school districts" }, { key: "source", label: "Source link", wide: true }]}
            value={f.marketSize}
            onChange={(v) => setF({ marketSize: v })}
            addLabel="Add figure"
            disabled={ro}
          />
          <LinesInput label="Where the money comes from" hint="Budget sources, one per line." value={f.moneyFlow.sources} disabled={ro} onChange={(v) => setF({ moneyFlow: { ...f.moneyFlow, sources: v } })} rows={3} />
          <RowsEditor
            label="Intermediaries"
            hint="Who the money passes through."
            fields={[{ key: "name", label: "Name" }, { key: "count", label: "How many" }, { key: "role", label: "Role", wide: true }]}
            value={f.moneyFlow.intermediaries}
            onChange={(v) => setF({ moneyFlow: { ...f.moneyFlow, intermediaries: v } })}
            addLabel="Add intermediary"
            disabled={ro}
          />
          <RowsEditor
            label="Recipients"
            hint="Who ends up spending it."
            fields={[{ key: "type", label: "Type" }, { key: "approxCount", label: "About how many" }, { key: "notes", label: "Notes", wide: true }]}
            value={f.moneyFlow.recipients}
            onChange={(v) => setF({ moneyFlow: { ...f.moneyFlow, recipients: v } })}
            addLabel="Add recipient"
            disabled={ro}
          />
          <RowsEditor
            label="Programs and budget lines"
            fields={[
              { key: "name", label: "Name" },
              { key: "agency", label: "Agency or owner" },
              { key: "typicalAward", label: "Typical amount" },
              { key: "url", label: "Link", placeholder: "https://" },
              { key: "purpose", label: "Purpose", wide: true },
              { key: "flow", label: "How the money flows", wide: true },
            ]}
            value={f.programs}
            onChange={(v) => setF({ programs: v })}
            addLabel="Add program"
            disabled={ro}
          />
          <LinesInput label="How they buy" hint="Process, cycle, approvals. One per line." value={f.buying} disabled={ro} onChange={(v) => setF({ buying: v })} rows={3} />
          <LinesInput label="What they must report or comply with" hint="One per line." value={f.obligations} disabled={ro} onChange={(v) => setF({ obligations: v })} rows={3} />
          <LinesInput label="Who helps them today" hint="Consultants, incumbents, in-house teams. One per line." value={f.helpers} disabled={ro} onChange={(v) => setF({ helpers: v })} rows={3} />
          <LinesInput label="Policy watch" hint="Changes coming that matter. One per line." value={f.policyWatch} disabled={ro} onChange={(v) => setF({ policyWatch: v })} rows={3} />
        </Section>

        <Section title="Open questions and sources">
          <LinesInput label="Open questions" hint="What is still unknown. One per line." value={c.openQuestions} disabled={ro} onChange={(v) => draft.patch({ openQuestions: v })} rows={3} />
          <RowsEditor
            label="Sources"
            hint="Links must start with http:// or https://."
            fields={[{ key: "title", label: "Title" }, { key: "url", label: "Link", placeholder: "https://" }]}
            value={c.sources}
            onChange={(v) => draft.patch({ sources: v })}
            addLabel="Add source"
            disabled={ro}
          />
        </Section>
      </div>

      <SaveBar
        dirty={draft.dirty}
        stale={draft.stale}
        saving={save.isPending}
        onDiscard={draft.discard}
        onSave={() => save.mutate({ id, expectedRevision: draft.baseRevision, content: c as unknown as Record<string, unknown> })}
      />

      <StartRunDialog target={{ kind: "sector", sectorId: id, name: sector.content.name }} open={runOpen} onOpenChange={setRunOpen} />

      <Dialog open={pOpen} onOpenChange={setPOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{pEditing ? "Edit persona" : "New persona"}</DialogTitle>
            <DialogDescription>In {sector.content.name}.</DialogDescription>
          </DialogHeader>
          <PersonaFormFields form={pForm} setForm={setPForm} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPOpen(false)}>Cancel</Button>
            <Button onClick={savePersona} disabled={createPersona.isPending || updatePersona.isPending}>
              {pEditing ? "Save persona" : "Create persona"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link an existing persona</DialogTitle>
            <DialogDescription>Personas that are not in a sector yet.</DialogDescription>
          </DialogHeader>
          <Select value={linkId} onValueChange={setLinkId}>
            <SelectTrigger><SelectValue placeholder="Choose a persona" /></SelectTrigger>
            <SelectContent>
              {unlinked.map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkOpen(false)}>Cancel</Button>
            <Button disabled={!linkId || updatePersona.isPending} onClick={() => updatePersona.mutate({ id: Number(linkId), sectorId: id })}>Link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
