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

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Link, useLocation } from "wouter";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
} from "lucide-react";

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
            <button onClick={() => onChange(value.filter((x) => x !== v))} className="ml-0.5 hover:opacity-70">×</button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
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
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
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
  return (
    <Badge className={`text-[10px] gap-1 ${c}`}>
      <Icon className="size-3" /> {score}/100
    </Badge>
  );
}

/* ─── Result row ────────────────────────────────────────────────────── */
function ProspectRow({ p }: { p: any }) {
  const urls = (p.sourceUrls as string[] | null) ?? [];
  const [, setLocation] = useLocation();
  const open = () => setLocation(`/prospects/${p.id}`);
  return (
    <div
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${p.firstName} ${p.lastName}`}
      className="border rounded-lg p-3 bg-card hover:border-primary/30 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm hover:underline">{p.firstName} {p.lastName}</span>
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
            <div className="flex flex-wrap gap-1.5 mt-2">
              {urls.slice(0, 5).map((u, i) => (
                <a key={u + i} href={u} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                   className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <ExternalLink className="size-2.5" /> source {i + 1}
                </a>
              ))}
              {urls.length > 5 && <span className="text-[10px] text-muted-foreground self-center">+{urls.length - 5} more</span>}
            </div>
          )}
        </div>
        {p.linkedinUrl && (
          <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
             className="size-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <Linkedin className="size-3.5" />
          </a>
        )}
        <ChevronRight className="size-4 text-muted-foreground shrink-0 self-center" />
      </div>
    </div>
  );
}

/* ─── LinkedIn / Sales Navigator search ─────────────────────────────────
 * Compliant search via the rep's OWN connected LinkedIn account (Unipile).
 * Hits import as leads — the entry point to the autonomous funnel: leads →
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

  const search = trpc.unipile.searchLinkedIn.useMutation({
    onSuccess: (r: any) => {
      setHits(r.items ?? []);
      setSelected(Object.fromEntries((r.items ?? []).map((_: any, i: number) => [i, true])));
      if (!r.items?.length) toast.info("No results — broaden your filters.");
    },
    onError: (e) => toast.error(e.message.includes("PRECONDITION") ? "Connect a LinkedIn account first (Settings → Channels)." : e.message),
  });
  const importLeads = trpc.unipile.importSearchHitsAsLeads.useMutation({
    onSuccess: (r) => { toast.success(`Imported ${r.created} lead${r.created === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} skipped` : ""}`); utils.prospects?.list?.invalidate?.(); },
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
    if (!keywords.trim() && api === "classic") { toast.error("Enter keywords"); return; }
    const filters: Record<string, unknown> = {};
    if (api === "sales_navigator") {
      if (locations.length) filters.location = locations.map((c) => Number(c.id));
      if (industries.length) filters.industry = industries.map((c) => Number(c.id));
      if (tenureMin) filters.tenure = [{ min: Number(tenureMin) }];
    }
    search.mutate({ api, category: "people", keywords: keywords.trim() || undefined, filters, limit: 10 });
  };

  const selectedHits = hits.filter((_, i) => selected[i]);
  const allOn = hits.length > 0 && selectedHits.length === hits.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Linkedin className="size-4 text-[#0A66C2]" /> LinkedIn search</CardTitle>
        <CardDescription className="text-xs">
          Search LinkedIn via your connected account and import matches as leads. Sales Navigator adds structured location, industry, and tenure filters. Imported leads feed sequences → invites → the Social Autopilot opener on accept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={api} onValueChange={(v) => setApi(v as any)}>
          <TabsList className="grid grid-cols-2 max-w-sm">
            <TabsTrigger value="classic" className="gap-1.5"><Search className="size-3.5" /> Classic</TabsTrigger>
            <TabsTrigger value="sales_navigator" className="gap-1.5"><Sparkles className="size-3.5" /> Sales Navigator</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="space-y-1.5">
          <Label className="text-xs">Keywords</Label>
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder='e.g. "VP Marketing SaaS" or a name/title' onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }} />
        </div>

        {api === "sales_navigator" && (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Location</Label>
              <div className="flex gap-1.5">
                <Input value={locTerm} onChange={(e) => setLocTerm(e.target.value)} placeholder="e.g. New York" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resolveTerm("location"); } }} />
                <Button type="button" variant="outline" size="sm" disabled={resolving === "location"} onClick={() => resolveTerm("location")}>{resolving === "location" ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}</Button>
              </div>
              {locations.length > 0 && <div className="flex flex-wrap gap-1">{locations.map((c) => <Badge key={c.id} variant="secondary" className="gap-1 cursor-pointer" onClick={() => setLocations((p) => p.filter((x) => x.id !== c.id))}>{c.title} ✕</Badge>)}</div>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Industry</Label>
              <div className="flex gap-1.5">
                <Input value={indTerm} onChange={(e) => setIndTerm(e.target.value)} placeholder="e.g. Software" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resolveTerm("industry"); } }} />
                <Button type="button" variant="outline" size="sm" disabled={resolving === "industry"} onClick={() => resolveTerm("industry")}>{resolving === "industry" ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}</Button>
              </div>
              {industries.length > 0 && <div className="flex flex-wrap gap-1">{industries.map((c) => <Badge key={c.id} variant="secondary" className="gap-1 cursor-pointer" onClick={() => setIndustries((p) => p.filter((x) => x.id !== c.id))}>{c.title} ✕</Badge>)}</div>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Min years in role</Label>
              <Input type="number" min={0} value={tenureMin} onChange={(e) => setTenureMin(e.target.value)} placeholder="Any" className="max-w-[120px]" />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t">
          <div className="text-[11px] text-muted-foreground">Uses your own LinkedIn account · max 10 results/search.</div>
          <Button onClick={runSearch} disabled={search.isPending} className="gap-1.5">
            {search.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            {search.isPending ? "Searching…" : "Search LinkedIn"}
          </Button>
        </div>

        {hits.length > 0 && (
          <div className="space-y-2 pt-2 border-t">
            <div className="flex items-center justify-between">
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(allOn ? {} : Object.fromEntries(hits.map((_, i) => [i, true])))}>
                {allOn ? "Deselect all" : "Select all"} · {selectedHits.length}/{hits.length}
              </button>
              <Button size="sm" disabled={!selectedHits.length || importLeads.isPending} onClick={() => importLeads.mutate({ hits: selectedHits as any })} className="gap-1.5">
                {importLeads.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Import {selectedHits.length} as leads
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
                    {url && <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Main page ─────────────────────────────────────────────────────── */
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

export default function FindProspectsPage() {
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

  const utils = trpc.useUtils();
  const search = trpc.discovery.search.useMutation({
    onSuccess: (r) => {
      setActiveRunId(r.runId);
      toast.success(
        `Discovery complete — ${r.rawFindCount} raw / ${r.prospectsCreated} new + ${r.prospectsUpdated} updated / ` +
        `${r.highConfidenceCount} high · ${r.mediumConfidenceCount} medium · ${r.lowConfidenceCount} low`,
        { duration: 6000 },
      );
      utils.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const runSearch = () => {
    if (mode === "person") {
      const i = personForm;
      if (![i.jobTitle, i.industry, i.companyName, i.location, i.seniority, i.department].some(Boolean) && i.keywords.length === 0) {
        toast.error("Fill at least one field");
        return;
      }
      search.mutate({ mode: "person", input: { ...i, keywords: i.keywords.length ? i.keywords : undefined } });
    } else {
      const i = accountForm;
      if (![i.companyName, i.industry, i.location, i.companySize, i.revenueRange, i.website, i.buyerPersona].some(Boolean) && i.keywords.length === 0) {
        toast.error("Fill at least one field");
        return;
      }
      search.mutate({ mode: "account", input: { ...i, keywords: i.keywords.length ? i.keywords : undefined } });
    }
  };

  return (
    <Shell title="Find Prospects">
      <PageHeader
        title="Find Prospects"
        description="Search for individual prospects or business accounts. Results fan out across LinkedIn, web pages, news, and business directories — then get consolidated, verified, and scored before landing in your Prospects list."
        pageKey="find-prospects"
        icon={<Search className="size-5" />}
      />

      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
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
              <TabsContent value="person" className="mt-4">
                <PersonForm value={personForm} onChange={setPersonForm} />
              </TabsContent>
              <TabsContent value="account" className="mt-4">
                <AccountForm value={accountForm} onChange={setAccountForm} />
              </TabsContent>
            </Tabs>
            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-[11px] text-muted-foreground">
                Fans out to LinkedIn · Web · News{mode === "account" ? " · Google Business" : ""}. Typical run: 5–15 s.
              </div>
              <Button onClick={runSearch} disabled={search.isPending} className="gap-1.5">
                {search.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                {search.isPending ? "Searching…" : "Run discovery"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── LinkedIn / Sales Navigator search ── */}
        <LinkedInSearchCard />

        {/* ── Run details (logs + raw finds) ── */}
        {activeRunId !== null && <RunDetail runId={activeRunId} />}

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
    </Shell>
  );
}

/* ─── Per-run detail card (raw finds + logs) ─────────────────────────── */
function RunDetail({ runId }: { runId: number }) {
  const { data: run } = trpc.discovery.getRun.useQuery({ id: runId });
  const { data: logs = [] } = trpc.discovery.getLogs.useQuery({ runId });
  const reprocess = trpc.discovery.reprocess.useMutation({ onSuccess: () => toast.success("Reprocessed"), onError: (e) => toast.error(e.message) });
  if (!run) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>Run #{run.id} — {run.mode} · {run.status}</span>
          <Button size="sm" variant="ghost" onClick={() => reprocess.mutate({ runId })} disabled={reprocess.isPending} className="gap-1 text-xs">
            <RefreshCw className="size-3" /> Re-score from raw finds
          </Button>
        </CardTitle>
        <CardDescription className="text-[11px]">
          {run.rawFindCount} raw · {run.prospectsCreated} new prospects · {run.highConfidenceCount} high · {run.mediumConfidenceCount} med · {run.lowConfidenceCount} low · {run.durationMs}ms
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-[11px] space-y-0.5 font-mono max-h-48 overflow-y-auto border rounded p-2 bg-muted/30">
          {logs.length === 0 ? <div className="text-muted-foreground italic">Loading logs…</div> :
            logs.map((l: any) => (
              <div key={l.id} className="flex gap-2">
                <span className="text-muted-foreground shrink-0">{new Date(l.createdAt).toLocaleTimeString()}</span>
                <span className={`shrink-0 ${l.level === "error" ? "text-red-500" : l.level === "warn" ? "text-amber-500" : "text-emerald-500"}`}>[{l.phase}]</span>
                <span className="truncate" title={l.message}>{l.message}</span>
              </div>
            ))
          }
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Saved prospect queue ───────────────────────────────────────────── */
function ProspectQueue({ status, emptyText }: { status: "verified" | "needs_review"; emptyText: string }) {
  const { data, isLoading } = trpc.prospects.list.useQuery({ verificationStatus: status, perPage: 50, page: 1 });
  if (isLoading) return <div className="text-sm text-muted-foreground p-6 text-center">Loading…</div>;
  if (!data || data.data.length === 0) {
    return <div className="text-sm text-muted-foreground p-6 text-center border rounded-lg border-dashed">{emptyText}</div>;
  }
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">{data.total} prospect{data.total === 1 ? "" : "s"}</div>
      {data.data.map((p: any) => <ProspectRow key={p.id} p={p} />)}
    </div>
  );
}
