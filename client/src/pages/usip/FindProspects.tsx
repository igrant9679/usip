/**
 * Find Prospects v2 — unified Person / Account discovery.
 *
 * Workflow:
 *   1. Pick a mode (Person or Account).
 *   2. Fill the structured form for that mode.
 *   3. Submit — fans out to every relevant scraper in parallel,
 *      consolidates the raw evidence, scores confidence, and writes
 *      verified prospects to your Prospects list (lower-confidence
 *      ones land in the "Needs Review" queue at the bottom of the page).
 *   4. Click any saved prospect to open its full profile with every
 *      source link clickable.
 */

import { useEffect, useId, useState } from "react";
import { confirmAction } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { Link, useLocation } from "wouter";
import { foldRedirectUrl } from "./dataEnrichmentTabs";
import { StartFromSector, applySectorFields } from "@/components/usip/research/StartFromSector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabelContext } from "@/components/ui/field-label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { ARE_SOURCES, type AreSourceId } from "@shared/areSources";
import { toast } from "sonner";
import {
  Search,
  User,
  Building2,
  Loader2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Linkedin,
  ChevronRight,
  Sparkles,
  RefreshCw,
  Archive,
} from "lucide-react";
import { QueryError } from "@/components/usip/Shell";
import { NoLinkedInConnected } from "@/components/usip/NoLinkedInConnected";
import { runSummary, useFollowRun } from "@/lib/discoveryRun";
import { SourceBudgetLine } from "@/components/usip/SpendPreview";

/* ─── Chip-input shared between the two forms ───────────────────────── */
function ChipInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText("");
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5 min-h-[24px]">
        {value.map((v) => (
          <Badge key={v} variant="secondary" className="text-xs gap-1">
            {v}
            <button aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="ml-0.5 hover:opacity-70">×</button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input aria-label={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="text-sm"
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>Add</Button>
      </div>
    </div>
  );
}

/* ─── Person search form ────────────────────────────────────────────── */
interface PersonForm {
  jobTitle: string;
  industry: string;
  companyName: string;
  location: string;
  keywords: string[];
  seniority: string;
  department: string;
}
const EMPTY_PERSON: PersonForm = { jobTitle: "", industry: "", companyName: "", location: "", keywords: [], seniority: "", department: "" };

function PersonForm({ value, onChange }: { value: PersonForm; onChange: (v: PersonForm) => void }) {
  const set = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Job title">
        <Input value={value.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} placeholder="VP Revenue Operations" />
      </Field>
      <Field label="Seniority">
        <Input value={value.seniority} onChange={(e) => set("seniority", e.target.value)} placeholder="VP / Director / Manager" />
      </Field>
      <Field label="Department">
        <Input value={value.department} onChange={(e) => set("department", e.target.value)} placeholder="Sales, RevOps, Engineering…" />
      </Field>
      <Field label="Industry">
        <Input value={value.industry} onChange={(e) => set("industry", e.target.value)} placeholder="SaaS, Fintech, Healthcare…" />
      </Field>
      <Field label="Company name (optional)">
        <Input value={value.companyName} onChange={(e) => set("companyName", e.target.value)} placeholder="Acme Inc" />
      </Field>
      <Field label="Location">
        <Input value={value.location} onChange={(e) => set("location", e.target.value)} placeholder="San Francisco, United States" />
      </Field>
      <div className="sm:col-span-2">
        <Label className="text-xs mb-1.5 block">Keywords (intent / triggers)</Label>
        <ChipInput value={value.keywords} onChange={(v) => set("keywords", v)} placeholder="forecasting, hubspot, salesforce…" />
      </div>
    </div>
  );
}

/* ─── Account search form ───────────────────────────────────────────── */
interface AccountForm {
  companyName: string;
  industry: string;
  location: string;
  companySize: string;
  revenueRange: string;
  keywords: string[];
  website: string;
  buyerPersona: string;
}
const EMPTY_ACCOUNT: AccountForm = { companyName: "", industry: "", location: "", companySize: "", revenueRange: "", keywords: [], website: "", buyerPersona: "" };

function AccountForm({ value, onChange }: { value: AccountForm; onChange: (v: AccountForm) => void }) {
  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Company name">
        <Input value={value.companyName} onChange={(e) => set("companyName", e.target.value)} placeholder="Acme Inc" />
      </Field>
      <Field label="Website">
        <Input value={value.website} onChange={(e) => set("website", e.target.value)} placeholder="acme.com" />
      </Field>
      <Field label="Industry">
        <Input value={value.industry} onChange={(e) => set("industry", e.target.value)} placeholder="SaaS, Fintech…" />
      </Field>
      <Field label="Location">
        <Input value={value.location} onChange={(e) => set("location", e.target.value)} placeholder="San Francisco, United States" />
      </Field>
      <Field label="Company size">
        <Input value={value.companySize} onChange={(e) => set("companySize", e.target.value)} placeholder="50–500" />
      </Field>
      <Field label="Revenue range">
        <Input value={value.revenueRange} onChange={(e) => set("revenueRange", e.target.value)} placeholder="$10M–$50M" />
      </Field>
      <Field label="Target buyer persona">
        <Input value={value.buyerPersona} onChange={(e) => set("buyerPersona", e.target.value)} placeholder="Head of RevOps" />
      </Field>
      <div className="sm:col-span-2">
        <Label className="text-xs mb-1.5 block">Keywords</Label>
        <ChipInput value={value.keywords} onChange={(v) => set("keywords", v)} placeholder="series-b, hiring, expanding…" />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label id={id} className="text-xs">{label}</Label>
      <FieldLabelContext.Provider value={id}>{children}</FieldLabelContext.Provider>
    </div>
  );
}

/* ─── Confidence chip ───────────────────────────────────────────────── */
function ConfidenceChip({ score, tier }: { score: number | null; tier: string | null }) {
  if (score == null || !tier) return null;
  const c = tier === "high" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" :
            tier === "medium" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" :
            "bg-red-500/15 text-red-700 dark:text-red-400";
  const Icon = tier === "high" ? CheckCircle2 : tier === "medium" ? AlertTriangle : AlertCircle;
  // The tier is said in words, not only by colour and icon (P152).
  return (
    <Badge className={`text-[10px] gap-1 ${c}`}>
      <Icon className="size-3" aria-hidden="true" /> {score}/100 <span className="sr-only">confidence, {tier}</span>
    </Badge>
  );
}

/* ─── Result row ────────────────────────────────────────────────────── */
function ProspectRow({ p }: { p: any }) {
  const urls = (p.sourceUrls as string[] | null) ?? [];
  // A card with a link in it, not a button with links in it (P152): the name
  // opens the person, and its overlay makes the whole card clickable, while
  // the source and LinkedIn links sit above that overlay as links of their own.
  return (
    <div className="relative border rounded-lg p-3 bg-card hover:border-primary/30 focus-within:ring-2 focus-within:ring-primary transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/prospects/${p.id}`} className="font-medium text-sm hover:underline focus:outline-none after:absolute after:inset-0 after:content-['']">{p.firstName} {p.lastName}</Link>
            <ConfidenceChip score={p.confidenceScore} tier={p.confidenceTier} />
            {p.verificationStatus === "needs_review" && (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700">Needs Review</Badge>
            )}
            {p.linkedinUrlVerified && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-700 gap-1">
                <Linkedin className="size-2.5" /> verified
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {[p.title, p.company].filter(Boolean).join(" · ") || "—"}
            {p.country || p.city ? ` · ${[p.city, p.country].filter(Boolean).join(", ")}` : ""}
          </div>
          {p.email && (
            <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{p.email}</div>
          )}
          {p.verificationNotes && (
            <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-1 line-clamp-2" title={p.verificationNotes}>
              {p.verificationNotes}
            </div>
          )}
          {urls.length > 0 && (
            <div className="relative z-10 flex flex-wrap gap-1.5 mt-2">
              {urls.slice(0, 5).map((u, i) => (
                <a key={u + i} href={u} target="_blank" rel="noopener noreferrer"
                   className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <ExternalLink className="size-2.5" aria-hidden="true" /> source {i + 1}
                </a>
              ))}
              {urls.length > 5 && <span className="text-[10px] text-muted-foreground self-center">+{urls.length - 5} more</span>}
            </div>
          )}
        </div>
        {p.linkedinUrl && (
          <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" aria-label={`${p.firstName} ${p.lastName} on LinkedIn`}
             className="relative z-10 size-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <Linkedin className="size-3.5" aria-hidden="true" />
          </a>
        )}
        <ChevronRight className="size-4 text-muted-foreground shrink-0 self-center" aria-hidden="true" />
      </div>
    </div>
  );
}

/* ─── LinkedIn / Sales Navigator search ─────────────────────────────────
 * Compliant search via the rep's OWN connected LinkedIn account (Unipile).
 * Hits save to People — the entry point to the autonomous funnel: People →
 * sequences send invites → accepts fire the Social Autopilot opener → meeting.
 */
type SearchHit = {
  provider_id?: string; public_identifier?: string; name?: string;
  first_name?: string; last_name?: string; title?: string; headline?: string;
  occupation?: string; company?: string | { name?: string }; location?: string;
  public_profile_url?: string; profile_url?: string;
};
type ParamChip = { id: string; title: string };

function hitName(h: SearchHit): string {
  return h.name || [h.first_name, h.last_name].filter(Boolean).join(" ") || "(no name)";
}
function hitCompany(h: SearchHit): string {
  return typeof h.company === "string" ? h.company : h.company?.name || "";
}
/** A hit as the duplicate check reads it (F38): name, company, profile URL. */
function hitIdentity(h: SearchHit) {
  const parts = (h.name ?? "").trim().split(/\s+/);
  return {
    firstName: (h.first_name || parts[0] || "").slice(0, 200) || null,
    lastName: (h.last_name || parts.slice(1).join(" ") || "").slice(0, 200) || null,
    companyName: hitCompany(h).slice(0, 300) || null,
    linkedinUrl: (h.public_profile_url || h.profile_url || "").slice(0, 2048) || null,
  };
}

function LinkedInSearchCard() {
  const utils = trpc.useUtils();
  const [api, setApi] = useState<"classic" | "sales_navigator">("classic");
  const [keywords, setKeywords] = useState("");
  const [locTerm, setLocTerm] = useState("");
  const [indTerm, setIndTerm] = useState("");
  const [locations, setLocations] = useState<ParamChip[]>([]);
  const [industries, setIndustries] = useState<ParamChip[]>([]);
  const [tenureMin, setTenureMin] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [resolving, setResolving] = useState<"" | "location" | "industry">("");
  // The next page (audit F43): LinkedIn hands back a cursor with each page.
  const [cursor, setCursor] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<{ api: "classic" | "sales_navigator"; keywords?: string; filters: Record<string, unknown> } | null>(null);
  // "Already in People?" per hit, from the one duplicate check (audit F38).
  const [known, setKnown] = useState<Array<{ status: string; prospectId: number | null }>>([]);

  /** Label hits from `offset` on, and leave the ones already in People unticked. */
  const checkKnown = async (items: SearchHit[], offset: number) => {
    try {
      const res = await utils.discovery.checkInPeople.fetch({ records: items.map(hitIdentity) });
      setKnown((prev) => [...prev.slice(0, offset), ...res]);
      setSelected((prev) => {
        const next = { ...prev };
        res.forEach((k, i) => { if (k.status === "in_people") next[offset + i] = false; });
        return next;
      });
    } catch {
      // A preview that failed leaves the hits unlabelled; the save still checks each one.
    }
  };

  // Whether this person has a LinkedIn account to search through (item 7):
  // known before the first search, so the card can say where to connect one.
  const connected = trpc.unipile.listConnectedAccounts.useQuery(undefined, { retry: false });
  const noLinkedIn = connected.isSuccess && !((connected.data ?? []) as Array<{ provider?: string | null }>).some((a) => a.provider === "LINKEDIN");
  const search = trpc.unipile.searchLinkedIn.useMutation({
    onSuccess: (r: any) => {
      const items: SearchHit[] = r.items ?? [];
      setHits(items);
      setCursor(r.cursor ?? null);
      setKnown([]);
      setSelected(Object.fromEntries(items.map((_: any, i: number) => [i, true])));
      if (!items.length) toast.info("No results — broaden your filters.");
      else void checkKnown(items, 0);
    },
    // The server's message says what is missing and where. The old fallback
    // matched "PRECONDITION" in the message, which never contains it, and
    // pointed at a Settings page that does not exist.
    onError: (e) => toast.error(e.message),
  });
  // The next page of the same search, added below the first (F43). Each page
  // is one search on the account, held by the same LinkedIn limits.
  const more = trpc.unipile.searchLinkedIn.useMutation({
    onSuccess: (r: any) => {
      const items: SearchHit[] = r.items ?? [];
      const offset = hits.length;
      setHits((prev) => [...prev, ...items]);
      setCursor(r.cursor ?? null);
      setSelected((prev) => ({ ...prev, ...Object.fromEntries(items.map((_: any, i: number) => [offset + i, true])) }));
      if (!items.length) toast.info("No more results for this search.");
      else void checkKnown(items, offset);
    },
    onError: (e) => toast.error(e.message),
  });
  // Saved to People like the rest of this tab (audit 2026-10-20, P76), as a
  // run of its own, so both the queues and Recent runs refresh (P142).
  const importPeople = trpc.unipile.importSearchHitsToPeople.useMutation({
    onSuccess: (r) => {
      toast.success(`Saved to People: ${r.created} new · ${r.updated} updated${r.skipped ? ` · ${r.skipped} not saved` : ""}`);
      utils.prospects.list.invalidate();
      utils.discovery.listRuns.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const resolveTerm = async (kind: "location" | "industry") => {
    const term = kind === "location" ? locTerm : indTerm;
    if (!term.trim()) return;
    setResolving(kind);
    try {
      const res: any = await utils.unipile.resolveSearchParam.fetch({ type: kind === "location" ? "LOCATION" : "INDUSTRY", keywords: term.trim() });
      const top = res?.items?.[0];
      if (!top) { toast.error(`No ${kind} match for "${term}"`); return; }
      const chip = { id: String(top.id), title: top.title };
      if (kind === "location") { setLocations((p) => p.some((c) => c.id === chip.id) ? p : [...p, chip]); setLocTerm(""); }
      else { setIndustries((p) => p.some((c) => c.id === chip.id) ? p : [...p, chip]); setIndTerm(""); }
    } catch (e: any) { toast.error(e?.message || "Resolve failed"); }
    finally { setResolving(""); }
  };

  const runSearch = () => {
    const filters: Record<string, unknown> = {};
    if (api === "sales_navigator") {
      if (locations.length) filters.location = locations.map((c) => Number(c.id));
      if (industries.length) filters.industry = industries.map((c) => Number(c.id));
      if (tenureMin) filters.tenure = [{ min: Number(tenureMin) }];
    }
    // Nothing filled in is not a search, on either API (P149): Sales Navigator
    // sent one, and it used a search from the account's daily cap.
    if (!keywords.trim() && Object.keys(filters).length === 0) {
      toast.error(api === "classic" ? "Enter keywords" : "Enter keywords, or add a location, industry or tenure");
      return;
    }
    setLastQuery({ api, keywords: keywords.trim() || undefined, filters });
    search.mutate({ api, category: "people", keywords: keywords.trim() || undefined, filters, limit: 10 });
  };
  const loadMore = () => {
    if (!cursor || !lastQuery) return;
    more.mutate({ api: lastQuery.api, category: "people", keywords: lastQuery.keywords, filters: lastQuery.filters, limit: 10, cursor });
  };

  const selectedHits = hits.filter((_, i) => selected[i]);
  const allOn = hits.length > 0 && selectedHits.length === hits.length;
  const alreadyCount = known.filter((k) => k?.status === "in_people").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Linkedin className="size-4 text-[#0A66C2]" /> LinkedIn search</CardTitle>
        <CardDescription className="text-xs">
          Search LinkedIn via your connected account and save matches to People, where the rest of this tab saves. Sales Navigator adds structured location, industry, and tenure filters. Enrol saved people in a sequence to send them invites.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {noLinkedIn && <NoLinkedInConnected />}
        <Tabs value={api} onValueChange={(v) => setApi(v as any)}>
          <TabsList className="grid grid-cols-2 max-w-sm">
            <TabsTrigger value="classic" className="gap-1.5"><Search className="size-3.5" /> Classic</TabsTrigger>
            <TabsTrigger value="sales_navigator" className="gap-1.5"><Sparkles className="size-3.5" /> Sales Navigator</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="space-y-1.5">
          <Label className="text-xs">Keywords</Label>
          <Input aria-label="Keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder='e.g. "VP Marketing SaaS" or a name/title' onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }} />
        </div>

        {api === "sales_navigator" && (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Location</Label>
              <div className="flex gap-1.5">
                <Input aria-label="Location" value={locTerm} onChange={(e) => setLocTerm(e.target.value)} placeholder="e.g. New York" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resolveTerm("location"); } }} />
                <Button type="button" variant="outline" size="sm" disabled={resolving === "location"} onClick={() => resolveTerm("location")}>{resolving === "location" ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}</Button>
              </div>
              {locations.length > 0 && <div className="flex flex-wrap gap-1">{locations.map((c) => <Badge key={c.id} asChild variant="secondary" className="gap-1 cursor-pointer"><button type="button" aria-label={`Remove ${c.title}`} onClick={() => setLocations((p) => p.filter((x) => x.id !== c.id))}>{c.title} ✕</button></Badge>)}</div>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Industry</Label>
              <div className="flex gap-1.5">
                <Input aria-label="Industry" value={indTerm} onChange={(e) => setIndTerm(e.target.value)} placeholder="e.g. Software" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resolveTerm("industry"); } }} />
                <Button type="button" variant="outline" size="sm" disabled={resolving === "industry"} onClick={() => resolveTerm("industry")}>{resolving === "industry" ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}</Button>
              </div>
              {industries.length > 0 && <div className="flex flex-wrap gap-1">{industries.map((c) => <Badge key={c.id} asChild variant="secondary" className="gap-1 cursor-pointer"><button type="button" aria-label={`Remove ${c.title}`} onClick={() => setIndustries((p) => p.filter((x) => x.id !== c.id))}>{c.title} ✕</button></Badge>)}</div>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Min years in role</Label>
              <Input aria-label="Min years in role" type="number" min={0} value={tenureMin} onChange={(e) => setTenureMin(e.target.value)} placeholder="Any" className="max-w-[120px]" />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t">
          <div className="text-[11px] text-muted-foreground">Uses your own LinkedIn account · max 10 results/search.</div>
          <Button onClick={runSearch} disabled={search.isPending || noLinkedIn} className="gap-1.5">
            {search.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            {search.isPending ? "Searching…" : "Search LinkedIn"}
          </Button>
        </div>

        {hits.length > 0 && (
          <div className="space-y-2 pt-2 border-t">
            <div className="flex items-center justify-between">
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(allOn ? {} : Object.fromEntries(hits.map((_, i) => [i, true])))}>
                {allOn ? "Deselect all" : "Select all"} · {selectedHits.length}/{hits.length}
                {alreadyCount > 0 && ` · ${alreadyCount} already in People (left unticked)`}
              </button>
              {/* The rows go as LinkedIn sent them; the server checks each one (P75). */}
              <Button size="sm" disabled={!selectedHits.length || importPeople.isPending} onClick={() => importPeople.mutate({ hits: selectedHits })} className="gap-1.5">
                {importPeople.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Save {selectedHits.length} to People
              </Button>
            </div>
            <div className="rounded-lg border divide-y">
              {hits.map((h, i) => {
                const url = h.public_profile_url || h.profile_url;
                return (
                  <label key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer">
                    <input type="checkbox" checked={!!selected[i]} onChange={(e) => setSelected((p) => ({ ...p, [i]: e.target.checked }))} className="size-4" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{hitName(h)}</div>
                      <div className="text-[12px] text-muted-foreground truncate">{[h.title || h.headline || h.occupation, hitCompany(h), h.location].filter(Boolean).join(" · ")}</div>
                    </div>
                    <KnownBadge knownAs={known[i]?.status} prospectId={known[i]?.prospectId} />
                    {url && <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`LinkedIn profile of ${hitName(h)}`}><ExternalLink className="size-3.5" aria-hidden="true" /></a>}
                  </label>
                );
              })}
            </div>
            {cursor && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" disabled={more.isPending || search.isPending} onClick={loadMore} className="gap-1.5">
                  {more.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} Load the next 10
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Main panel ────────────────────────────────────────────────────── */
/** Read a query-string param without depending on wouter's search hook,
 *  which isn't wired for this route. */
function initialParams(): { runId: number | null; q: string } {
  if (typeof window === "undefined") return { runId: null, q: "" };
  const sp = new URLSearchParams(window.location.search);
  const raw = Number(sp.get("runId"));
  return {
    runId: Number.isFinite(raw) && raw > 0 ? raw : null,
    q: (sp.get("q") ?? "").slice(0, 200),
  };
}

/**
 * The whole Find-Prospects surface as an embeddable panel. Since 2026-08-21
 * it renders inside Data Enrichment's "Find prospects" tab (owner fold ask);
 * /find-prospects is a query-preserving redirect there. The panel still reads
 * runId/q straight off the URL — the redirect carries them through
 * (dataEnrichmentTabs.foldRedirectUrl), so ProspectDetail's "Run #N" link and
 * People's typed-query link keep landing on exactly what they name.
 */
/**
 * The sources each mode fans out to — the SAME lists services/discovery runs
 * (sourcePicker.test.ts pins them equal), so the picker can never offer a
 * source the run would not use, or hide one it would. Order as the service.
 */
// No "web" (audit 2026-10-27, P62): it reads a page at a URL, and this search is text.
const PERSON_SOURCES: AreSourceId[] = ["linkedin", "news", "apollo", "quickenrich"];
const ACCOUNT_SOURCES: AreSourceId[] = ["google_business", "news", "apollo"];
const SOURCE_LABEL: Record<string, string> = Object.fromEntries(ARE_SOURCES.map((s) => [s.id, s.label]));

export function FindProspectsPanel() {
  // This page ignored its own URL params entirely, so two links elsewhere in
  // the app quietly went nowhere useful: ProspectDetail's "Run #N" link
  // (/find-prospects?runId=…) landed on a blank new-search page instead of the
  // run it named, and People's empty-state AI prompt had nowhere to send a
  // typed query. Both are honoured now.
  const params = initialParams();
  const [mode, setMode] = useState<"person" | "account">("person");
  const [personForm, setPersonForm] = useState<PersonForm>(
    params.q ? { ...EMPTY_PERSON, keywords: [params.q] } : EMPTY_PERSON,
  );
  const [accountForm, setAccountForm] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [activeRunId, setActiveRunId] = useState<number | null>(params.runId);

  // Per-run source picker (owner ask 2026-09-22). null = every source the
  // workspace has enabled for the mode, which is what the page ran before it
  // had a picker. The workspace mask still wins: a disabled source is shown
  // unticked and locked, so the user can see why it will not run.
  const { data: wsSettings } = trpc.settings.getAreSettings.useQuery();
  const sourceMask = ((wsSettings as any)?.areScraperSources ?? {}) as Record<string, boolean | undefined>;
  const sourceEnabled = (id: AreSourceId) => sourceMask[id] !== false;
  const [chosenSources, setChosenSources] = useState<Set<AreSourceId> | null>(null);
  const modeSources = mode === "person" ? PERSON_SOURCES : ACCOUNT_SOURCES;
  const runSources = modeSources.filter((id) => sourceEnabled(id) && (chosenSources === null || chosenSources.has(id)));
  const toggleSource = (id: AreSourceId) => setChosenSources((prev) => {
    const next = new Set<AreSourceId>(prev ?? [...PERSON_SOURCES, ...ACCOUNT_SOURCES].filter(sourceEnabled));
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const utils = trpc.useUtils();
  // Review before saving (audit 2026-10-20, F38): off keeps the old behaviour,
  // on keeps the finds unsaved, each labelled new or already in People.
  const [holdForReview, setHoldForReview] = useState(false);
  // The run is a background job now (P72): the request answers with its id at
  // once and this follows it; the summary toast comes when the run ends.
  const follow = useFollowRun(activeRunId, (run) => {
    // What was SAVED (P61), what was left out, and what was already in People (F38).
    const s = runSummary(run);
    if (s.ok) toast.success(s.text, { duration: 6000 }); else toast.error(s.text, { duration: 8000 });
    // The run, its trace and the history change too, not only the queues (P142).
    utils.prospects.list.invalidate();
    utils.discovery.listRuns.invalidate();
    utils.discovery.getLogs.invalidate({ runId: run.id });
    utils.discovery.getRawFinds.invalidate({ runId: run.id });
  });
  const search = trpc.discovery.search.useMutation({
    onSuccess: (r) => {
      setActiveRunId(r.runId);
      follow.arm(r.runId);
      toast.info(r.joinedRunning
        ? `That search was already running (run #${r.runId}), so it was not started again — following it below.`
        : `Discovery started (run #${r.runId}). It runs in the background; you can leave this page and come back.`);
      utils.discovery.listRuns.invalidate();
      utils.discovery.getRun.invalidate({ id: r.runId });
      utils.discovery.getLogs.invalidate({ runId: r.runId });
      utils.discovery.getRawFinds.invalidate({ runId: r.runId });
    },
    onError: (e) => {
      toast.error(e.message);
      // A lost response can leave the run going: it shows in Recent runs (P72).
      utils.discovery.listRuns.invalidate();
    },
  });
  const followed = follow.query.data as { id: number; status: string } | undefined;
  const running = followed?.status === "running" && followed.id === activeRunId;

  const runSearch = () => {
    if (runSources.length === 0) {
      toast.error("Pick at least one source");
      return;
    }
    if (mode === "person") {
      const i = personForm;
      if (![i.jobTitle, i.industry, i.companyName, i.location, i.seniority, i.department].some(Boolean) && i.keywords.length === 0) {
        toast.error("Fill at least one field");
        return;
      }
      search.mutate({ mode: "person", input: { ...i, keywords: i.keywords.length ? i.keywords : undefined }, sources: runSources, holdForReview });
    } else {
      const i = accountForm;
      if (![i.companyName, i.industry, i.location, i.companySize, i.revenueRange, i.website, i.buyerPersona].some(Boolean) && i.keywords.length === 0) {
        toast.error("Fill at least one field");
        return;
      }
      search.mutate({ mode: "account", input: { ...i, keywords: i.keywords.length ? i.keywords : undefined }, sources: runSources, holdForReview });
    }
  };

  return (
      <div className="max-w-7xl mx-auto space-y-6">
        {/* ── Search wizard ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="size-4 text-violet-500" /> New search
            </CardTitle>
            <CardDescription className="text-xs">
              Pick a mode and fill the fields you care about — anything you skip is ignored. Keywords sharpen the match.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
              <TabsList className="grid grid-cols-2 max-w-sm">
                <TabsTrigger value="person" className="gap-1.5"><User className="size-3.5" /> Person</TabsTrigger>
                <TabsTrigger value="account" className="gap-1.5"><Building2 className="size-3.5" /> Account</TabsTrigger>
              </TabsList>
              <TabsContent value="person" className="mt-4 space-y-3">
                <StartFromSector onApply={(f) => setPersonForm((prev) => applySectorFields(prev, f))} />
                <PersonForm value={personForm} onChange={setPersonForm} />
              </TabsContent>
              <TabsContent value="account" className="mt-4">
                <AccountForm value={accountForm} onChange={setAccountForm} />
              </TabsContent>
            </Tabs>
            <div className="flex items-end justify-between gap-4 pt-2 border-t">
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-foreground">Sources for this run</div>
                {/* The list IS the fan-out (services/discovery; pinned equal),
                    so this can neither under-report it, as the old copy did,
                    nor offer a source the run would ignore. */}
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {modeSources.map((id) => {
                    const enabled = sourceEnabled(id);
                    // The reason is on the page, not only in a tooltip (P152).
                    return (
                      <label
                        key={id}
                        className={enabled ? "flex items-center gap-1.5 cursor-pointer" : "flex items-center gap-1.5 cursor-not-allowed"}
                      >
                        <Checkbox className="size-3.5" disabled={!enabled} checked={enabled && runSources.includes(id)} onCheckedChange={() => toggleSource(id)} />
                        <span className={enabled ? "text-[11.5px]" : "text-[11.5px] text-muted-foreground"}>
                          {SOURCE_LABEL[id] ?? id}
                          {!enabled && <span className="ml-1 text-[10.5px]">(off in Settings → Revenue Engine)</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {runSources.length === 0
                    ? "Pick at least one source."
                    : `Fans out to ${runSources.length} of ${modeSources.length} sources. Typical run: 5–15 s, in the background.`}
                </div>
                {/* What each paid source has left today, before running (U16). */}
                <SourceBudgetLine sources={runSources} />
                <label className="flex items-center gap-1.5 cursor-pointer pt-0.5">
                  <Checkbox className="size-3.5" checked={holdForReview} onCheckedChange={(v) => setHoldForReview(v === true)} />
                  <span className="text-[11.5px]">Review before saving <span className="text-muted-foreground">(keep the finds unsaved, marked new or already in People)</span></span>
                </label>
              </div>
              <Button onClick={runSearch} disabled={search.isPending} className="gap-1.5">
                {search.isPending || running ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                {search.isPending ? "Starting…" : running ? `Run #${activeRunId} running…` : "Run discovery"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── LinkedIn / Sales Navigator search ── */}
        <LinkedInSearchCard />

        {/* ── Run details (logs + raw finds) ── */}
        {activeRunId !== null && <RunDetail runId={activeRunId} />}

        {/* ── Run history — reopen any past run without hunting for its link ── */}
        <RecentRuns activeRunId={activeRunId} onOpen={setActiveRunId} />

        {/* ── Always-on queues ── */}
        <Tabs defaultValue="needs_review">
          <TabsList>
            <TabsTrigger value="needs_review" className="gap-1.5"><AlertTriangle className="size-3.5" /> Needs Review</TabsTrigger>
            <TabsTrigger value="verified" className="gap-1.5"><CheckCircle2 className="size-3.5" /> Verified</TabsTrigger>
          </TabsList>
          <TabsContent value="needs_review" className="mt-4">
            <ProspectQueue status="needs_review" emptyText="No prospects awaiting review. Run a search above." />
          </TabsContent>
          <TabsContent value="verified" className="mt-4">
            <ProspectQueue status="verified" emptyText="No high-confidence prospects yet. Run a search above." />
          </TabsContent>
        </Tabs>
      </div>
  );
}

/**
 * The /find-prospects route since the fold: a query-preserving redirect into
 * Data Enrichment's "Find prospects" tab. A plain redirect would strip
 * ?runId=/?q= and orphan the two deep links built for this page — the URL
 * builder in dataEnrichmentTabs carries every param through.
 */
export default function FindProspectsRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(foldRedirectUrl(window.location.search), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/* ─── Per-run detail card (raw finds + logs) ─────────────────────────── */
/** What the one duplicate check said about a find when the run found it (F38). */
function KnownBadge({ knownAs, prospectId }: { knownAs?: string | null; prospectId?: number | null }) {
  if (knownAs === "in_people") {
    return prospectId
      ? <Link href={`/prospects/${prospectId}`}><span className="shrink-0 text-[10px] text-muted-foreground underline">already in People</span></Link>
      : <span className="shrink-0 text-[10px] text-muted-foreground">already in People</span>;
  }
  if (knownAs === "in_campaign") return <span className="shrink-0 text-[10px] text-muted-foreground">in a campaign</span>;
  if (knownAs === "new") return <span className="shrink-0 text-[10px] text-emerald-700 dark:text-emerald-400">new</span>;
  return null;
}

function RunDetail({ runId }: { runId: number }) {
  const utils = trpc.useUtils();
  const runQ = trpc.discovery.getRun.useQuery({ id: runId }, {
    // A run that is still going is followed until it ends.
    refetchInterval: (q) => ((q.state.data as { status?: string } | undefined)?.status === "running" ? 3000 : false),
  });
  const run = runQ.data;
  const logsQ = trpc.discovery.getLogs.useQuery({ runId }, { refetchInterval: run?.status === "running" ? 3000 : false });
  // What the sources returned, before consolidation (P147: promised, never shown).
  const findsQ = trpc.discovery.getRawFinds.useQuery({ runId });
  // The finds land when the background run ends (P72): read them again then.
  const status = run?.status;
  useEffect(() => { if (status && status !== "running") void findsQ.refetch(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const logs = logsQ.data ?? [];
  const finds = findsQ.data ?? [];
  const reprocess = trpc.discovery.reprocess.useMutation({
    onSuccess: (r) => {
      toast.success(`${held ? "Saved to People" : "Re-scored"} — ${r.prospectsCreated} new + ${r.prospectsUpdated} updated`);
      // The re-score rewrites the run's counts and the people (P142).
      utils.discovery.getRun.invalidate({ id: runId });
      utils.discovery.getLogs.invalidate({ runId });
      utils.discovery.listRuns.invalidate();
      utils.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const held = !!(run as { heldForReview?: boolean } | undefined)?.heldForReview;
  if (runQ.error && !run) return <QueryError what={`run #${runId}`} message={runQ.error.message} onRetry={() => runQ.refetch()} />;
  if (!run) return null;
  const r = run as typeof run & { prospectsUpdated?: number; prospectsSkipped?: number; accountsCreated?: number; alreadyInPeople?: number };
  const already = r.alreadyInPeople ?? 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            {run.status === "running" && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Run #{run.id} — {run.mode} · {run.status === "running" ? "running in the background" : held ? "found, not saved yet" : run.status}
          </span>
          {held ? (
            // Kept for review (F38): the finds below are labelled new or already
            // in People, and saving goes through the same consolidation.
            <Button size="sm" disabled={reprocess.isPending} className="gap-1 text-xs"
              onClick={() => confirmAction({
                title: `Save run #${run.id} to People?`,
                description: `${run.rawFindCount} finds: ${Math.max(0, run.rawFindCount - already)} not in People yet are added, and the ${already} already in People are updated where a find adds something. Nothing is spent: the finds are already paid for.`,
                confirmLabel: "Save to People",
              }, () => reprocess.mutate({ runId }))}>
              <CheckCircle2 className="size-3" /> Save to People
            </Button>
          ) : run.status !== "running" && (
          /* A re-score re-applies every raw find of the run to the people it
              matched — a whole run, so it asks first (audit 2026-10-20, P3). */
          <Button size="sm" variant="ghost" disabled={reprocess.isPending} className="gap-1 text-xs"
            onClick={() => confirmAction({
              title: `Re-score run #${run.id}?`,
              description: `This re-applies all ${run.rawFindCount} raw finds to the people they matched. People someone has reviewed — verified or rejected — keep their status.`,
              confirmLabel: "Re-score",
            }, () => reprocess.mutate({ runId }))}>
            <RefreshCw className="size-3" /> Re-score from raw finds
          </Button>
          )}
        </CardTitle>
        <CardDescription className="text-[11px]">
          {run.rawFindCount} raw{already ? ` · ${already} already in People` : ""} · {run.prospectsCreated} new · {r.prospectsUpdated ?? 0} updated
          {r.prospectsSkipped ? ` · ${r.prospectsSkipped} not saved` : ""}
          {r.accountsCreated ? ` · ${r.accountsCreated} companies` : ""}
          {" "}· {run.highConfidenceCount} high · {run.mediumConfidenceCount} med · {run.lowConfidenceCount} low · {run.durationMs}ms
        </CardDescription>
        {run.errorMessage && <div className="text-[11px] text-red-600 dark:text-red-400">{run.errorMessage}</div>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-[11px] space-y-0.5 font-mono max-h-48 overflow-y-auto border rounded p-2 bg-muted/30">
          {/* A failed load is said, not shown as "Loading" for ever (P148). */}
          {logsQ.error && !logsQ.data ? <QueryError what="this run's logs" message={logsQ.error.message} onRetry={() => logsQ.refetch()} /> :
            logsQ.isLoading ? <div className="text-muted-foreground italic">Loading logs…</div> :
            logs.length === 0 ? <div className="text-muted-foreground italic">No log lines for this run.</div> :
            logs.map((l: any) => (
              <div key={l.id} className="flex gap-2">
                <span className="text-muted-foreground shrink-0">{new Date(l.createdAt).toLocaleTimeString()}</span>
                <span className={`shrink-0 ${l.level === "error" ? "text-red-500" : l.level === "warn" ? "text-amber-500" : "text-emerald-500"}`}>[{l.phase}]</span>
                <span className="truncate" title={l.message}>{l.message}</span>
              </div>
            ))
          }
        </div>
        <div className="space-y-1">
          <div className="text-[11px] font-medium">Raw finds</div>
          {findsQ.error && !findsQ.data ? <QueryError what="this run's raw finds" message={findsQ.error.message} onRetry={() => findsQ.refetch()} /> :
            findsQ.isLoading ? <div className="text-[11px] text-muted-foreground italic">Loading raw finds…</div> :
            finds.length === 0 ? <div className="text-[11px] text-muted-foreground italic">The sources returned nothing for this run.</div> : (
              <div className="rounded border divide-y max-h-56 overflow-y-auto text-[11px]">
                {finds.map((f: any) => (
                  <div key={f.id} className="flex items-center gap-2 px-2 py-1">
                    <Badge variant="outline" className="text-[10px] shrink-0">{f.source}</Badge>
                    <span className="truncate">
                      {[[f.firstName, f.lastName].filter(Boolean).join(" ") || "(no name)", f.title, f.companyName, f.location].filter(Boolean).join(" · ")}
                    </span>
                    <KnownBadge knownAs={f.knownAs} prospectId={f.knownProspectId} />
                    {f.sourceUrl && /^https?:\/\//i.test(f.sourceUrl) && (
                      <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Source for ${[f.firstName, f.lastName].filter(Boolean).join(" ") || f.companyName || "this find"}`}>
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Run history ────────────────────────────────────────────────────── */
/**
 * Recent discovery runs, reopenable in place. discovery.listRuns existed on
 * the server with NO consumer — the only ways back to a past run were the
 * toast you dismissed or a prospect's "Run #N" link. Operators re-check runs
 * constantly; hunting for a link is the slow path this card removes.
 */
function RecentRuns({ activeRunId, onOpen }: { activeRunId: number | null; onOpen: (id: number) => void }) {
  const { data: runs = [], isLoading, error, refetch } = trpc.discovery.listRuns.useQuery({ limit: 12 }, {
    // A run still going (one whose response was lost, say) is followed until it ends.
    refetchInterval: (q) => (((q.state.data as Array<{ status?: string }> | undefined) ?? []).some((r) => r.status === "running") ? 5000 : false),
  });
  // A failed load is not "no runs yet" (P148).
  if (error && runs.length === 0) return <QueryError what="your recent discovery runs" message={error.message} onRetry={() => refetch()} />;
  if (isLoading || runs.length === 0) return null;
  const when = (d: unknown) => {
    const dt = new Date(d as string);
    return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Recent discovery runs</CardTitle>
        <CardDescription className="text-[11px]">Click a run to reopen its logs and raw finds.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border divide-y">
          {(runs as any[]).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onOpen(r.id)}
              aria-current={activeRunId === r.id ? "true" : undefined}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeRunId === r.id ? "bg-primary/5" : ""}`}
            >
              <span className="font-medium tabular-nums shrink-0">#{r.id}</span>
              <span className="shrink-0 capitalize text-muted-foreground">{r.mode}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {r.rawFindCount ?? 0} raw · {r.prospectsCreated ?? 0} new · {r.prospectsUpdated ?? 0} updated · {r.highConfidenceCount ?? 0}H {r.mediumConfidenceCount ?? 0}M {r.lowConfidenceCount ?? 0}L
              </span>
              <span className={`shrink-0 ${r.status === "failed" ? "text-red-500" : r.status === "running" ? "text-amber-600" : "text-muted-foreground"}`}>{r.status}</span>
              <span className="shrink-0 text-muted-foreground">{when(r.startedAt)}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Saved prospect queue ───────────────────────────────────────────── */
/** How many people a queue page shows; the rest are a page away, not unreachable. */
const QUEUE_PAGE_SIZE = 50;
/** Archiving asks first and says how to undo it, as the person page does (R64). */
const ARCHIVE_NOTE = "They're hidden from People and from outreach pickers. Restore them from People → Stage → Archived.";

/**
 * The Needs Review and Verified queues (audit 2026-10-20, P17). Needs Review
 * had no way to decide anything — the person page offered only Archive — and
 * both queues stopped at the first 50 while showing a larger total. Now each
 * row and any selection can be approved or archived through
 * `prospects.review`, and the queue pages through everything it counts.
 */
function ProspectQueue({ status, emptyText }: { status: "verified" | "needs_review"; emptyText: string }) {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { data, isLoading, error, refetch } = trpc.prospects.list.useQuery({ verificationStatus: status, perPage: QUEUE_PAGE_SIZE, page });
  const review = trpc.prospects.review.useMutation({
    onSuccess: (r, v) => {
      const did = v.decision === "verified" ? "Approved" : "Archived";
      toast.success(`${did} ${r.updated}${r.skipped ? ` · ${r.skipped} already decided elsewhere` : ""}`);
      setSelected(new Set());
      // Both queues and the tab's waiting count read this list.
      utils.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  // A last page emptied by decisions steps back to one that has people.
  useEffect(() => {
    if (data && page > 1 && data.data.length === 0 && data.total > 0) setPage(Math.ceil(data.total / QUEUE_PAGE_SIZE));
  }, [data, page]);

  if (isLoading) return <div className="text-sm text-muted-foreground p-6 text-center">Loading…</div>;
  if (error && !data) return <QueryError what="these prospects" message={error.message} onRetry={() => refetch()} />;
  if (!data || data.data.length === 0) {
    return <div className="text-sm text-muted-foreground p-6 text-center border rounded-lg border-dashed">{emptyText}</div>;
  }
  const reviewing = status === "needs_review";
  const pageIds = data.data.map((p: any) => p.id as number);
  const allOnPage = pageIds.length > 0 && pageIds.every((id: number) => selected.has(id));
  const pages = Math.max(1, Math.ceil(data.total / QUEUE_PAGE_SIZE));
  const first = (page - 1) * QUEUE_PAGE_SIZE + 1;
  const last = Math.min(page * QUEUE_PAGE_SIZE, data.total);
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const decide = (ids: number[], decision: "verified" | "rejected") => review.mutate({ ids, decision });
  const chosen = Array.from(selected);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {reviewing && (
          <Checkbox
            aria-label={allOnPage ? "Clear the selection on this page" : "Select everyone on this page"}
            className="size-3.5"
            checked={allOnPage}
            onCheckedChange={() => setSelected(allOnPage ? new Set() : new Set(pageIds))}
          />
        )}
        <span>{data.total > QUEUE_PAGE_SIZE ? `${first}–${last} of ${data.total}` : `${data.total}`} prospect{data.total === 1 ? "" : "s"}</span>
        {reviewing && chosen.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span>· {chosen.length} selected</span>
            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1" disabled={review.isPending} onClick={() => decide(chosen, "verified")}>
              <CheckCircle2 className="size-3" /> Approve
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1 text-destructive" disabled={review.isPending}
              onClick={() => confirmAction({
                title: `Archive ${chosen.length} prospect${chosen.length === 1 ? "" : "s"}?`,
                description: ARCHIVE_NOTE,
                confirmLabel: "Archive",
              }, () => decide(chosen, "rejected"))}>
              <Archive className="size-3" /> Archive
            </Button>
          </span>
        )}
      </div>
      {data.data.map((p: any) => (
        <div key={p.id} className="flex items-start gap-2">
          {reviewing && (
            <Checkbox
              aria-label={`Select ${p.firstName} ${p.lastName}`}
              className="size-3.5 mt-4 shrink-0"
              checked={selected.has(p.id)}
              onCheckedChange={() => toggle(p.id)}
            />
          )}
          <div className="flex-1 min-w-0"><ProspectRow p={p} /></div>
          {reviewing && (
            <div className="flex flex-col gap-1 shrink-0 pt-2">
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={review.isPending}
                aria-label={`Approve ${p.firstName} ${p.lastName}`} onClick={() => decide([p.id], "verified")}>
                <CheckCircle2 className="size-3" /> Approve
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-destructive" disabled={review.isPending}
                aria-label={`Archive ${p.firstName} ${p.lastName}`}
                onClick={() => confirmAction({ title: `Archive ${p.firstName} ${p.lastName}?`, description: ARCHIVE_NOTE, confirmLabel: "Archive", destructive: false }, () => decide([p.id], "rejected"))}>
                <Archive className="size-3" /> Archive
              </Button>
            </div>
          )}
        </div>
      ))}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1 text-xs">
          <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => { setPage(page - 1); setSelected(new Set()); }}>Previous</Button>
          <span className="text-muted-foreground tabular-nums">Page {page} of {pages}</span>
          <Button size="sm" variant="outline" className="h-7" disabled={page >= pages} onClick={() => { setPage(page + 1); setSelected(new Set()); }}>Next</Button>
        </div>
      )}
    </div>
  );
}
