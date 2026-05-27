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
import { Link } from "wouter";
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
  return (
    <div className="border rounded-lg p-3 bg-card hover:border-primary/30 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/prospects/${p.id}`}>
              <span className="font-medium text-sm hover:underline cursor-pointer">{p.firstName} {p.lastName}</span>
            </Link>
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
                <a key={u + i} href={u} target="_blank" rel="noopener noreferrer"
                   className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <ExternalLink className="size-2.5" /> source {i + 1}
                </a>
              ))}
              {urls.length > 5 && <span className="text-[10px] text-muted-foreground self-center">+{urls.length - 5} more</span>}
            </div>
          )}
        </div>
        {p.linkedinUrl && (
          <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer"
             className="size-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <Linkedin className="size-3.5" />
          </a>
        )}
        <ChevronRight className="size-4 text-muted-foreground shrink-0 self-center" />
      </div>
    </div>
  );
}

/* ─── Main page ─────────────────────────────────────────────────────── */
export default function FindProspectsPage() {
  const [mode, setMode] = useState<"person" | "account">("person");
  const [personForm, setPersonForm] = useState<PersonForm>(EMPTY_PERSON);
  const [accountForm, setAccountForm] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

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
