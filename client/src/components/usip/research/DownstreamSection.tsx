/**
 * Downstream on the Research page (Research phase 5): the Downstream
 * workspaces linked to this one, each company's own narrowing of the market,
 * and Import from Downstream — choose the export file, see what it would do,
 * tick what to bring in, import. Admins only; nothing is sent or launched.
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Download, Loader2, Pause, Play, Settings2, Unlink } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";
import { Section, TagInput, useResearchRoles } from "./ResearchFields";

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
  new: { label: "New", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  updated: { label: "Updated", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  unchanged: { label: "Unchanged", cls: "bg-muted text-muted-foreground" },
  conflict: { label: "Edited here", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  deleted: { label: "Deleted here", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
};

function StateBadge({ state }: { state: string }) {
  const s = STATE_LABEL[state] ?? STATE_LABEL.unchanged;
  return <Badge variant="outline" className={`text-[10px] border-transparent ${s.cls}`}>{s.label}</Badge>;
}

const when = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

export function DownstreamSection() {
  const { canDelete: isAdmin } = useResearchRoles();
  const links = trpc.research.downstream.links.useQuery(undefined, { enabled: isAdmin });
  const utils = trpc.useUtils();
  const [importOpen, setImportOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<any | null>(null);
  const setStatus = trpc.research.downstream.setStatus.useMutation({ onError: (e) => toast.error(e.message), onSuccess: () => links.refetch() });
  const remove = trpc.research.downstream.remove.useMutation({ onError: (e) => toast.error(e.message), onSuccess: () => { toast.success("Unlinked"); links.refetch(); } });
  if (!isAdmin) return null;
  const rows = links.data ?? [];

  return (
    <Section
      title="Downstream"
      description="Research made in Downstream, imported here. Each Downstream workspace imports only into the Velocity workspaces it is linked to, and nothing is shared between them."
      actions={<Button size="sm" variant="outline" onClick={() => setImportOpen(true)}><Download className="size-4 mr-1" /> Import from Downstream</Button>}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Downstream workspace is linked yet. Export from Downstream with Export for Velocity, then import the file here.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((l) => (
            <div key={l.id} className="p-3 flex items-start gap-3 text-sm flex-wrap">
              <div className="flex-1 min-w-[14rem] space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{l.name}</span>
                  {l.status === "paused" && <Badge variant="outline" className="text-[10px]">Paused</Badge>}
                  {l.useSellerMessaging && <Badge variant="outline" className="text-[10px]">Seller messaging on</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {l.counts.sectors} {l.counts.sectors === 1 ? "sector" : "sectors"}, {l.counts.personas} personas, {l.counts.accounts} accounts · last import {when(l.lastImportAt)}
                  {l.marketId ? <> · <Link href={`/research/markets/${l.marketId}`} className="underline">open the market</Link></> : null}
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setSettingsFor(l)}><Settings2 className="size-4 mr-1" /> Settings</Button>
                <Button size="sm" variant="ghost" className="h-8" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: l.id, status: l.status === "paused" ? "active" : "paused" })}>
                  {l.status === "paused" ? <><Play className="size-4 mr-1" /> Resume</> : <><Pause className="size-4 mr-1" /> Pause</>}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  onClick={() => confirmAction(
                    { title: `Unlink ${l.name}?`, description: "What it imported stays as ordinary research (delete the market to remove it). Its next file has to be linked again before it can import.", confirmLabel: "Unlink" },
                    () => remove.mutate({ id: l.id }),
                  )}
                >
                  <Unlink className="size-4 mr-1" /> Unlink
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Pausing keeps the imported research but stops the AI writers and targeting using it.</p>
      {importOpen && <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={async () => { await utils.research.invalidate(); }} />}
      {settingsFor && <LinkSettingsDialog link={settingsFor} onClose={() => setSettingsFor(null)} onSaved={() => links.refetch()} />}
    </Section>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => Promise<void> }) {
  const [preview, setPreview] = useState<any | null>(null);
  const [assign, setAssign] = useState(false);
  const [useSeller, setUseSeller] = useState(false);
  const [segments, setSegments] = useState<Set<string>>(new Set());
  const [orgs, setOrgs] = useState(true);
  const [take, setTake] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState(false);
  const run = trpc.research.downstream.preview.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (p) => {
      setPreview(p);
      setAssign(false);
      setUseSeller(p.link.useSellerMessaging);
      setSegments(new Set(p.segments.filter((s: any) => s.ticked).map((s: any) => s.ref)));
      setTake(new Set());
    },
  });
  const commit = trpc.research.downstream.commit.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async (r) => {
      const c = r.counts;
      toast.success(`Imported: ${c.created} new, ${c.updated} updated, ${c.unchanged} unchanged${c.keptYours ? `, ${c.keptYours} kept as edited here` : ""}; accounts ${c.accountsCreated} new, ${c.accountsMatched} matched to existing ones${c.accountsUpdated ? `, ${c.accountsUpdated} updated` : ""}.`);
      await onDone();
      onOpenChange(false);
    },
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setReading(true);
    try {
      run.mutate({ fileText: await f.text() });
    } finally {
      setReading(false);
    }
  };
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(key); else n.delete(key);
    setter(n);
  };

  const p = preview;
  const needsLink = p && p.link.state !== "assigned";
  const blocked = needsLink && !assign;
  const orgCount = p ? p.segments.filter((s: any) => segments.has(s.ref)).reduce((n: number, s: any) => n + s.organizations, 0) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from Downstream</DialogTitle>
          <DialogDescription>Choose the file from Downstream's Export for Velocity. You see what it would do before anything is imported; nothing is sent or launched.</DialogDescription>
        </DialogHeader>
        {!p ? (
          <div className="space-y-2">
            <Input type="file" accept=".json,application/json" onChange={(e) => onFile(e.target.files?.[0])} disabled={run.isPending || reading} />
            {(run.isPending || reading) && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the file…</div>}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border p-3 space-y-1">
              <div><span className="font-medium">{p.source.workspaceName}</span> <span className="text-muted-foreground">from Downstream ({p.source.url}), exported {when(p.source.exportedAt)} by {p.source.exportedBy}</span></div>
              <div className="text-xs text-muted-foreground">
                {p.segments.length} segments · {p.segments.reduce((n: number, s: any) => n + s.personas.length, 0)} personas · {p.organizationsTotal} organizations · glossary {p.knowledge.glossary}, competitors {p.knowledge.competitors}, funders {p.knowledge.funders}{p.hasStats ? " · market statistics" : ""}
              </div>
              {p.droppedPersonal > 0 && <div className="text-xs text-amber-700 dark:text-amber-300">{p.droppedPersonal} values that looked like an email address or phone number were removed.</div>}
              {p.intendedForMismatch && <div className="text-xs text-amber-700 dark:text-amber-300">This export was made for "{p.intendedFor}". Check it is meant for this workspace.</div>}
            </div>

            {needsLink && (
              <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 cursor-pointer">
                <Checkbox checked={assign} onCheckedChange={(v) => setAssign(!!v)} className="mt-0.5" />
                <span>
                  {p.link.state === "moved"
                    ? <>This is <b>{p.source.workspaceName}</b> from Downstream at a new address. Update the link and import.</>
                    : <><b>{p.source.workspaceName}</b> is not linked to this workspace yet. Link it, so its files import here (and only into workspaces it is linked to).</>}
                </span>
              </label>
            )}

            {p.audience === "seller" && (
              <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
                <Checkbox checked={useSeller} onCheckedChange={(v) => setUseSeller(!!v)} className="mt-0.5" />
                <span>
                  This file contains product messaging and fit for <b>{p.sellerName ?? "a company"}</b>. Is that your company? Only then are its lead-with lines,
                  opening lines, fit scores and organization fit imported; otherwise they are left out entirely.
                </span>
              </label>
            )}

            <div className="space-y-2">
              <div className="font-medium">Segments to import</div>
              <p className="text-xs text-muted-foreground">Each becomes a sector in the "{p.source.workspaceName}" market, with its personas. Segments you leave out stay listed on the market as suggestions.</p>
              {p.segments.map((s: any) => (
                <div key={s.ref} className="rounded-md border p-3 space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <Checkbox checked={segments.has(s.ref)} onCheckedChange={(v) => toggle(segments, setSegments, s.ref, !!v)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{s.name}</span>
                        <StateBadge state={s.state} />
                        <span className="text-xs text-muted-foreground">{s.status} · revision {s.revision} · {s.organizations} organizations</span>
                      </div>
                      {s.titles.length > 0 && <div className="text-xs text-muted-foreground mt-0.5">Titles: {s.titles.slice(0, 8).join(", ")}{s.titles.length > 8 ? "…" : ""}</div>}
                      {s.exclude.length > 0 && <div className="text-xs text-muted-foreground">Never target: {s.exclude.join(", ")}</div>}
                    </div>
                  </label>
                  {(s.state === "conflict" || s.state === "deleted") && segments.has(s.ref) && (
                    <label className="flex items-center gap-2 text-xs pl-6 cursor-pointer">
                      <Checkbox checked={take.has(s.ref)} onCheckedChange={(v) => toggle(take, setTake, s.ref, !!v)} />
                      {s.state === "conflict" ? "Someone edited this sector here since the last import. Use Downstream's version (yours stays in its history)." : "This sector was deleted here. Bring it back."}
                    </label>
                  )}
                  {segments.has(s.ref) && s.personas.length > 0 && (
                    <div className="pl-6 space-y-1">
                      {s.personas.map((pp: any) => (
                        <div key={pp.ref} className="flex items-center gap-2 text-xs flex-wrap">
                          <span>{pp.name}</span>
                          <StateBadge state={pp.state} />
                          {pp.suggested && <Badge variant="outline" className="text-[10px]">suggested</Badge>}
                          {(pp.state === "conflict" || pp.state === "deleted") && (
                            <label className="flex items-center gap-1 cursor-pointer">
                              <Checkbox checked={take.has(pp.ref)} onCheckedChange={(v) => toggle(take, setTake, pp.ref, !!v)} />
                              {pp.state === "conflict" ? "use Downstream's" : "bring back"}
                            </label>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {orgCount > 0 && (
              <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
                <Checkbox checked={orgs} onCheckedChange={(v) => setOrgs(!!v)} className="mt-0.5" />
                <span>
                  Import the {orgCount} organizations of these segments as accounts (matched to existing accounts by website, then name and state). Each keeps
                  its award, which the Revenue Engine uses as a sourced hook when it researches someone there.
                </span>
              </label>
            )}
          </div>
        )}
        <DialogFooter>
          {p && <Button variant="outline" onClick={() => setPreview(null)}>Choose another file</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {p && (
            <Button
              disabled={commit.isPending || blocked || segments.size === 0}
              onClick={() => commit.mutate({
                token: p.token,
                assign: p.link.state === "unassigned" ? assign : undefined,
                updateLinkUrl: p.link.state === "moved" ? assign : undefined,
                useSellerMessaging: useSeller,
                segments: Array.from(segments),
                importOrganizations: orgs,
                takeDownstream: Array.from(take),
              })}
            >
              {commit.isPending && <Loader2 className="size-4 mr-1 animate-spin" />} Import {segments.size} {segments.size === 1 ? "segment" : "segments"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkSettingsDialog({ link, onClose, onSaved }: { link: any; onClose: () => void; onSaved: () => void }) {
  const s = link.settings;
  const [territory, setTerritory] = useState<string[]>(s.territory);
  const [addTitles, setAddTitles] = useState<string[]>(s.addTitles);
  const [removeTitles, setRemoveTitles] = useState<string[]>(s.removeTitles);
  const [exclude, setExclude] = useState<string[]>(s.exclude);
  const [min, setMin] = useState<string>(s.employeeMin != null ? String(s.employeeMin) : "");
  const [max, setMax] = useState<string>(s.employeeMax != null ? String(s.employeeMax) : "");
  const save = trpc.research.downstream.updateSettings.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => { toast.success("Saved — applies from the next import"); onSaved(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{link.name}: your targeting</DialogTitle>
          <DialogDescription>Narrow Downstream's market to your own. These apply to every imported segment and persona from the next import.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <TagInput label="Territory" hint="Where you sell. When set, it replaces each segment's places." value={territory} onChange={setTerritory} placeholder="Kentucky, Tennessee…" />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Min employees</Label><Input type="number" min={1} value={min} onChange={(e) => setMin(e.target.value)} /></div>
            <div className="space-y-2"><Label>Max employees</Label><Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} /></div>
          </div>
          <TagInput label="Add titles" value={addTitles} onChange={setAddTitles} />
          <TagInput label="Remove titles" value={removeTitles} onChange={setRemoveTitles} />
          <TagInput label="Never target (added)" value={exclude} onChange={setExclude} placeholder="student, vendor…" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate({
              id: link.id,
              territory,
              addTitles,
              removeTitles,
              exclude,
              employeeMin: min ? Math.max(1, Math.round(Number(min))) : null,
              employeeMax: max ? Math.max(1, Math.round(Number(max))) : null,
            })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
