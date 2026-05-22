/**
 * Find Prospects — unified prospect-sourcing page.
 *
 * Tabs (Phase 1 ships only the first; URL + LinkedIn come in Phases 2-3):
 *   - Places   — Google Places text search
 *   - URL      — arbitrary URL scraper (coming soon)
 *   - LinkedIn — Unipile-bridged LinkedIn search (coming soon)
 *
 * Results land in a shared review table where the user picks which hits
 * to save as Prospect rows or Account rows.
 *
 * Budget meter for Places sits in the page header — shows daily / instant
 * credit pools so the user always knows what they're spending.
 */

import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MapPin,
  Search,
  Loader2,
  Globe,
  Linkedin,
  ExternalLink,
  Phone,
  Building2,
  UserPlus,
  Save,
  Star,
  AlertCircle,
  Eye,
} from "lucide-react";
import { toast } from "sonner";

// Server-derived — these stay in lockstep with the routers (see trpc.ts).
// A shape change on the server is now a compile error here, not a silent
// runtime mismatch.
type Confidence = "high" | "medium" | "low" | "none";
type ExtractedData = RouterOutputs["urlScraper"]["scrapeOne"];
type PlacesHit = RouterOutputs["placesSearch"]["textSearch"]["results"][number];
type LinkedInLookupResult = RouterOutputs["linkedinFinder"]["lookup"];

export default function FindProspectsPage() {
  return (
    <Shell title="Find Prospects">
      <PageHeader
        title="Find Prospects"
        description="Search Google Places, scrape arbitrary URLs, or look up LinkedIn profiles. Results can be saved straight to your Prospects or Accounts."
        pageKey="find-prospects"
        icon={<Search className="size-5" />}
      >
        <PlacesBudgetMeter />
      </PageHeader>

      <div className="p-6">
        <Tabs defaultValue="places" className="w-full">
          <TabsList>
            <TabsTrigger value="places" className="gap-1.5">
              <MapPin className="size-3.5" />
              Google Places
            </TabsTrigger>
            <TabsTrigger value="url" className="gap-1.5">
              <Globe className="size-3.5" />
              URL Scraper
            </TabsTrigger>
            <TabsTrigger value="linkedin" className="gap-1.5">
              <Linkedin className="size-3.5" />
              LinkedIn
            </TabsTrigger>
          </TabsList>
          <TabsContent value="places" className="mt-4">
            <PlacesTab />
          </TabsContent>
          <TabsContent value="url" className="mt-4">
            <UrlScraperTab />
          </TabsContent>
          <TabsContent value="linkedin" className="mt-4">
            <LinkedInTab />
          </TabsContent>
        </Tabs>
      </div>
    </Shell>
  );
}

/* ─── Budget meter in the page header ──────────────────────────────────── */
function PlacesBudgetMeter() {
  const { data } = trpc.placesSearch.getBudget.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const pct = Math.min(100, Math.round(data.usagePct));
  const usedDollars = (data.usageCents / 100).toFixed(2);
  const budgetDollars = (data.monthlyBudgetCents / 100).toFixed(2);
  const barColor =
    pct >= 100
      ? "bg-red-500"
      : pct >= data.thresholdPct
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div
      className="hidden md:flex flex-col items-end gap-1 mr-2"
      title={`${data.callsCount} calls this period · resets monthly`}
    >
      <div className="text-[10px] text-muted-foreground">
        Places budget · ${usedDollars} of ${budgetDollars}
      </div>
      <div className="w-32 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {data.capReached && (
        <div className="text-[10px] text-red-600 flex items-center gap-0.5">
          <AlertCircle className="size-2.5" /> Cap reached
        </div>
      )}
    </div>
  );
}

/* ─── Places tab content ──────────────────────────────────────────────── */
function PlacesTab() {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [includedType, setIncludedType] = useState("");
  const [maxResults, setMaxResults] = useState(10);
  const [results, setResults] = useState<PlacesHit[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const search = trpc.placesSearch.textSearch.useMutation({
    onSuccess: (data) => {
      setResults(data.results);
      setSelected(new Set());
      void utils.placesSearch.getBudget.invalidate();
      if (data.results.length === 0) {
        toast("No results found", { description: "Try a different query or broaden the area" });
      } else {
        toast.success(`Found ${data.results.length} place${data.results.length === 1 ? "" : "s"}`);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const saveAsProspects = trpc.placesSearch.saveAsProspects.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Saved ${data.created} prospect${data.created === 1 ? "" : "s"}` +
          (data.skipped ? ` (${data.skipped} already existed)` : ""),
      );
      setSelected(new Set());
    },
    onError: (e) => toast.error(e.message),
  });

  const saveAsAccounts = trpc.placesSearch.saveAsAccounts.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Saved ${data.created} account${data.created === 1 ? "" : "s"}${
          data.skipped ? ` (${data.skipped} already existed)` : ""
        }`,
      );
      setSelected(new Set());
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    if (query.trim().length < 2) {
      toast.error("Enter a search query (e.g. 'dentists in Leesburg, VA')");
      return;
    }
    search.mutate({
      query: query.trim(),
      includedType: includedType.trim() || undefined,
      maxResultCount: maxResults,
    });
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === results.length) setSelected(new Set());
    else setSelected(new Set(results.map((r) => r.placeId)));
  };

  const selectedHits = results.filter((r) => selected.has(r.placeId));

  return (
    <div className="space-y-5">
      {/* Search form */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_120px_auto] gap-3 items-end">
          <div className="space-y-1">
            <Label htmlFor="places-q" className="text-xs">Query</Label>
            <Input
              id="places-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. dentists in Leesburg, VA"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="places-type" className="text-xs">
              Place type <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="places-type"
              value={includedType}
              onChange={(e) => setIncludedType(e.target.value)}
              placeholder="e.g. restaurant, law_firm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="places-max" className="text-xs">Max results</Label>
            <Input
              id="places-max"
              type="number"
              min={1}
              max={20}
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value) || 10)}
            />
          </div>
          <Button onClick={submit} disabled={search.isPending}>
            {search.isPending ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <Search className="size-4 mr-2" />
            )}
            Search
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Costs ~1.7¢ per search against the monthly budget. Free Google credit covers ~11,700
          searches/month at the default $200 cap.
        </p>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
            <div className="text-sm text-muted-foreground">
              {results.length} result{results.length === 1 ? "" : "s"} ·{" "}
              {selected.size} selected
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveAsAccounts.mutate({ hits: selectedHits })}
                disabled={selected.size === 0 || saveAsAccounts.isPending}
              >
                <Building2 className="size-3.5 mr-1.5" />
                Save as Accounts ({selected.size})
              </Button>
              <Button
                size="sm"
                onClick={() => saveAsProspects.mutate({ hits: selectedHits })}
                disabled={selected.size === 0 || saveAsProspects.isPending}
              >
                <UserPlus className="size-3.5 mr-1.5" />
                Save as Prospects ({selected.size})
              </Button>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={results.length > 0 && selected.size === results.length}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow
                  key={r.placeId}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => toggle(r.placeId)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(r.placeId)}
                      onCheckedChange={() => toggle(r.placeId)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div>{r.name}</div>
                    {r.googleMapsUri && (
                      <a
                        href={r.googleMapsUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="size-2.5" /> Maps
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.formattedAddress ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.websiteUri ? (
                      <a
                        href={r.websiteUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate inline-block max-w-[180px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.websiteUri.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.nationalPhoneNumber ?? r.internationalPhoneNumber ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.rating !== undefined ? (
                      <div className="flex items-center gap-1">
                        <Star className="size-3 text-amber-500 fill-amber-500" />
                        {r.rating.toFixed(1)}
                        <span className="text-muted-foreground">
                          ({r.userRatingCount ?? 0})
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-[10px] text-muted-foreground capitalize">
                    {(r.primaryType ?? "").replace(/_/g, " ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {results.length === 0 && !search.isPending && (
        <div className="rounded-lg border border-dashed bg-card/40 p-8 text-center text-muted-foreground">
          <MapPin className="size-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Enter a search above to find businesses via Google Places.</p>
          <p className="text-xs mt-1">
            Each search uses ~1.7¢ of your monthly Places budget.
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── URL scraper tab content ─────────────────────────────────────────── */
function UrlScraperTab() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ExtractedData | null>(null);
  // Editable form state — seeded from extraction, user can fix before saving
  const [edit, setEdit] = useState<{
    firstName: string;
    lastName: string;
    jobTitle: string;
    email: string;
    phone: string;
    companyName: string;
    companyDomain: string;
    bio: string;
    linkedinUrl: string;
  }>({
    firstName: "",
    lastName: "",
    jobTitle: "",
    email: "",
    phone: "",
    companyName: "",
    companyDomain: "",
    bio: "",
    linkedinUrl: "",
  });

  const scrape = trpc.urlScraper.scrapeOne.useMutation({
    onSuccess: (data) => {
      setResult(data);
      // Seed the editable form from extraction
      const li = data.socialUrls.find((u) => /linkedin\.com\/in\//i.test(u)) ?? "";
      setEdit({
        firstName: data.firstName.value ?? "",
        lastName: data.lastName.value ?? "",
        jobTitle: data.jobTitle.value ?? "",
        email: data.email.value ?? "",
        phone: data.phone.value ?? "",
        companyName: data.companyName.value ?? "",
        companyDomain: data.companyDomain.value ?? "",
        bio: data.bio.value ?? "",
        linkedinUrl: li,
      });
      if (data.error) {
        toast.error(`Could not scrape: ${data.error}`);
      } else {
        toast.success("URL scraped — review the extracted data below");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const save = trpc.urlScraper.saveAsProspect.useMutation({
    onSuccess: () => {
      toast.success("Saved as Prospect");
      setResult(null);
      setUrl("");
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    if (url.trim().length < 3) {
      toast.error("Paste a URL to scrape (e.g. https://example.com/about)");
      return;
    }
    scrape.mutate({ url: url.trim() });
  };

  const handleSave = () => {
    if (!result) return;
    save.mutate({
      url: result.url,
      firstName: edit.firstName || undefined,
      lastName: edit.lastName || undefined,
      jobTitle: edit.jobTitle || undefined,
      email: edit.email || undefined,
      phone: edit.phone || undefined,
      companyName: edit.companyName || undefined,
      companyDomain: edit.companyDomain || undefined,
      bio: edit.bio || undefined,
      linkedinUrl: edit.linkedinUrl || undefined,
    });
  };

  return (
    <div className="space-y-5">
      {/* URL input */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
          <div className="space-y-1">
            <Label htmlFor="url-input" className="text-xs">URL</Label>
            <Input
              id="url-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/team/jane-smith"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <Button onClick={submit} disabled={scrape.isPending}>
            {scrape.isPending ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <Eye className="size-4 mr-2" />
            )}
            Scrape
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Paste any URL — a blog post, company About page, LinkedIn-style profile, or
          conference speaker page. Velocity will extract names, contact info, and social
          URLs using structured data (JSON-LD, OpenGraph) plus heuristic fallbacks.
        </p>
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{result.pageTitle ?? "(no title)"}</div>
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline truncate inline-flex items-center gap-1"
              >
                <ExternalLink className="size-3" />
                {result.url}
              </a>
              {result.error && (
                <div className="text-xs text-red-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="size-3" /> {result.error}
                </div>
              )}
            </div>
          </div>

          {!result.error && (
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
              <EditableField
                label="First name"
                value={edit.firstName}
                onChange={(v) => setEdit((e) => ({ ...e, firstName: v }))}
                conf={result.firstName.confidence}
                source={result.firstName.source}
              />
              <EditableField
                label="Last name"
                value={edit.lastName}
                onChange={(v) => setEdit((e) => ({ ...e, lastName: v }))}
                conf={result.lastName.confidence}
                source={result.lastName.source}
              />
              <EditableField
                label="Job title"
                value={edit.jobTitle}
                onChange={(v) => setEdit((e) => ({ ...e, jobTitle: v }))}
                conf={result.jobTitle.confidence}
                source={result.jobTitle.source}
              />
              <EditableField
                label="Email"
                value={edit.email}
                onChange={(v) => setEdit((e) => ({ ...e, email: v }))}
                conf={result.email.confidence}
                source={result.email.source}
              />
              <EditableField
                label="Phone"
                value={edit.phone}
                onChange={(v) => setEdit((e) => ({ ...e, phone: v }))}
                conf={result.phone.confidence}
                source={result.phone.source}
              />
              <EditableField
                label="LinkedIn URL"
                value={edit.linkedinUrl}
                onChange={(v) => setEdit((e) => ({ ...e, linkedinUrl: v }))}
                conf={edit.linkedinUrl ? "medium" : "none"}
                source="extracted from page links"
              />
              <EditableField
                label="Company name"
                value={edit.companyName}
                onChange={(v) => setEdit((e) => ({ ...e, companyName: v }))}
                conf={result.companyName.confidence}
                source={result.companyName.source}
              />
              <EditableField
                label="Company domain"
                value={edit.companyDomain}
                onChange={(v) => setEdit((e) => ({ ...e, companyDomain: v }))}
                conf={result.companyDomain.confidence}
                source={result.companyDomain.source}
              />
              <div className="md:col-span-2">
                <EditableField
                  label="Bio"
                  value={edit.bio}
                  onChange={(v) => setEdit((e) => ({ ...e, bio: v }))}
                  conf={result.bio.confidence}
                  source={result.bio.source}
                  textarea
                />
              </div>

              {/* Aggregate sets (info-only, not editable) */}
              {(result.allEmails.length > 1 ||
                result.allPhones.length > 1 ||
                result.socialUrls.length > 0) && (
                <div className="md:col-span-2 border-t pt-3 mt-1 space-y-1.5">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Other things found on the page
                  </div>
                  {result.allEmails.length > 1 && (
                    <div className="text-xs flex flex-wrap gap-1 items-center">
                      <span className="text-muted-foreground">Other emails:</span>
                      {result.allEmails.slice(0, 8).map((e) => (
                        <code
                          key={e}
                          className="px-1.5 py-0.5 rounded bg-muted text-[10px] cursor-pointer hover:bg-muted-foreground/10"
                          onClick={() => setEdit((s) => ({ ...s, email: e }))}
                          title="Click to use this address"
                        >
                          {e}
                        </code>
                      ))}
                    </div>
                  )}
                  {result.socialUrls.length > 0 && (
                    <div className="text-xs flex flex-wrap gap-1 items-center">
                      <span className="text-muted-foreground">Socials:</span>
                      {result.socialUrls.slice(0, 8).map((u) => (
                        <a
                          key={u}
                          href={u}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline text-[10px] truncate max-w-[200px]"
                        >
                          {u.replace(/^https?:\/\//, "")}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="border-t bg-muted/30 px-4 py-3 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setResult(null);
                setUrl("");
              }}
              disabled={save.isPending}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={save.isPending || !!result.error}
            >
              {save.isPending ? (
                <Loader2 className="size-3.5 mr-1.5 animate-spin" />
              ) : (
                <UserPlus className="size-3.5 mr-1.5" />
              )}
              Save as Prospect
            </Button>
          </div>
        </div>
      )}

      {!result && !scrape.isPending && (
        <div className="rounded-lg border border-dashed bg-card/40 p-8 text-center text-muted-foreground">
          <Globe className="size-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Paste any URL above to extract person + company data.</p>
          <p className="text-xs mt-1">
            Works best on pages with structured data (Schema.org JSON-LD, OpenGraph).
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── Editable field with confidence pill ─────────────────────────────── */
function EditableField({
  label,
  value,
  onChange,
  conf,
  source,
  textarea = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  conf: Confidence;
  source: string;
  textarea?: boolean;
}) {
  const dotColor =
    conf === "high"
      ? "bg-emerald-500"
      : conf === "medium"
        ? "bg-amber-500"
        : conf === "low"
          ? "bg-slate-400"
          : "bg-transparent border border-muted-foreground/30";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {conf !== "none" && (
          <span
            className={`size-1.5 rounded-full ${dotColor}`}
            title={`${conf} confidence — ${source}`}
          />
        )}
      </div>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="w-full text-sm rounded-md border bg-background px-2 py-1.5 resize-y"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="text-sm h-8"
        />
      )}
    </div>
  );
}

/* ─── LinkedIn people search ──────────────────────────────────────────── */
type LinkedInAccount =
  RouterOutputs["linkedinFinder"]["listAccounts"]["accounts"][number];
type LinkedInSearchHit = RouterOutputs["linkedinFinder"]["search"]["hits"][number];

const COMPANY_SIZES = [
  "any",
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
];

function LinkedInSearch({
  accounts,
  isAdmin,
}: {
  accounts: LinkedInAccount[];
  isAdmin: boolean;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [industry, setIndustry] = useState("");
  const [companySize, setCompanySize] = useState("any");
  const [keywords, setKeywords] = useState("");
  const [maxResults, setMaxResults] = useState(10);
  const [accountId, setAccountId] = useState("auto");
  const [hits, setHits] = useState<LinkedInSearchHit[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const search = trpc.linkedinFinder.search.useMutation({
    onSuccess: (data) => {
      setSelected(new Set());
      if (data.ok) {
        setHits(data.hits);
        if (data.hits.length === 0) toast(data.message);
        else toast.success(data.message);
      } else {
        setHits([]);
        toast.error(data.message);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const save = trpc.linkedinFinder.saveSearchHits.useMutation({
    onSuccess: (data) => {
      const skipped = data.total - data.created;
      toast.success(
        `Saved ${data.created} prospect${data.created === 1 ? "" : "s"}` +
          (skipped > 0 ? ` (${skipped} skipped)` : ""),
      );
      setSelected(new Set());
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    const hasCriterion = [name, title, location, industry, keywords].some(
      (s) => s.trim().length > 0,
    );
    if (!hasCriterion) {
      toast.error(
        "Enter at least one criterion (name, title, location, industry, or keywords)",
      );
      return;
    }
    search.mutate({
      name: name.trim() || undefined,
      title: title.trim() || undefined,
      location: location.trim() || undefined,
      industry: industry.trim() || undefined,
      companySize: companySize !== "any" ? companySize : undefined,
      keywords: keywords.trim() || undefined,
      limit: maxResults,
      accountId: isAdmin && accountId !== "auto" ? accountId : undefined,
    });
  };

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === hits.length) setSelected(new Set());
    else setSelected(new Set(hits.map((_, i) => i)));
  };

  const selectedHits = hits
    .filter((_, i) => selected.has(i))
    .filter((h) => h.linkedinUrl);

  return (
    <div className="space-y-4">
      {/* Search form */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Search LinkedIn people
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jane Smith"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Job title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. VP of Sales"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Location</Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Boston, MA"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Industry</Label>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="e.g. SaaS, Fintech"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Company size</Label>
            <select
              value={companySize}
              onChange={(e) => setCompanySize(e.target.value)}
              className="w-full text-sm h-9 rounded-md border bg-background px-2"
            >
              {COMPANY_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s === "any" ? "Any size" : `${s} employees`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              Keywords <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="e.g. revenue operations"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
        </div>
        <div
          className={`grid grid-cols-1 gap-3 items-end ${
            isAdmin ? "md:grid-cols-[120px_220px_auto]" : "md:grid-cols-[120px_auto]"
          }`}
        >
          <div className="space-y-1">
            <Label className="text-xs">Max results</Label>
            <Input
              type="number"
              min={1}
              max={25}
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value) || 10)}
            />
          </div>
          {isAdmin && (
            <div className="space-y-1">
              <Label className="text-xs">Route through</Label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full text-sm h-9 rounded-md border bg-background px-2"
              >
                <option value="auto">Auto (most headroom)</option>
                {accounts.map((a) => (
                  <option key={a.unipileAccountId} value={a.unipileAccountId}>
                    {(a.displayName ?? a.ownerName ?? a.unipileAccountId) +
                      ` (${a.remainingToday} left)`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button onClick={submit} disabled={search.isPending}>
            {search.isPending ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <Search className="size-4 mr-2" />
            )}
            Search LinkedIn
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Runs a real LinkedIn people search through your bridged account via
          Unipile. Filters are matched as keywords — exact company-size
          filtering needs a Sales Navigator seat and isn&apos;t applied here.
        </p>
      </div>

      {/* Results */}
      {hits.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
            <div className="text-sm text-muted-foreground">
              {hits.length} result{hits.length === 1 ? "" : "s"} ·{" "}
              {selected.size} selected
            </div>
            <Button
              size="sm"
              onClick={() =>
                save.mutate({
                  hits: selectedHits.map((h) => ({
                    firstName: h.firstName || undefined,
                    lastName: h.lastName || undefined,
                    title: h.headline || undefined,
                    company: h.company || undefined,
                    linkedinUrl: h.linkedinUrl,
                  })),
                })
              }
              disabled={selectedHits.length === 0 || save.isPending}
            >
              {save.isPending ? (
                <Loader2 className="size-3.5 mr-1.5 animate-spin" />
              ) : (
                <UserPlus className="size-3.5 mr-1.5" />
              )}
              Save as Prospects ({selectedHits.length})
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={hits.length > 0 && selected.size === hits.length}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Company</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hits.map((h, i) => (
                <TableRow
                  key={h.linkedinUrl || `hit-${i}`}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => toggle(i)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(i)}
                      onCheckedChange={() => toggle(i)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{h.name}</div>
                    {h.headline && (
                      <div className="text-[11px] text-muted-foreground">
                        {h.headline}
                      </div>
                    )}
                    {h.linkedinUrl && (
                      <a
                        href={h.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="size-2.5" /> Profile
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {h.location || "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {h.company || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ─── LinkedIn tab content ────────────────────────────────────────────── */
function LinkedInTab() {
  const accountsQ = trpc.linkedinFinder.listAccounts.useQuery();
  const utils = trpc.useUtils();

  const [url, setUrl] = useState("");
  const [accountId, setAccountId] = useState<string>("auto");
  const [result, setResult] = useState<LinkedInLookupResult | null>(null);
  const [edit, setEdit] = useState({
    firstName: "",
    lastName: "",
    title: "",
    company: "",
    companyDomain: "",
  });

  const lookup = trpc.linkedinFinder.lookup.useMutation({
    onSuccess: (data) => {
      setResult(data);
      void utils.linkedinFinder.listAccounts.invalidate();
      if (data.ok && data.profile) {
        const name = data.profile.name ?? "";
        const sp = name.lastIndexOf(" ");
        setEdit({
          firstName: sp === -1 ? name : name.slice(0, sp),
          lastName: sp === -1 ? "" : name.slice(sp + 1),
          title: data.profile.headline ?? "",
          company: "",
          companyDomain: "",
        });
        toast.success(data.message);
      } else {
        toast.error(data.message);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const save = trpc.linkedinFinder.saveAsProspect.useMutation({
    onSuccess: () => {
      toast.success("Saved as Prospect");
      setResult(null);
      setUrl("");
    },
    onError: (e) => toast.error(e.message),
  });

  if (accountsQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const data = accountsQ.data;
  const accounts = data?.accounts ?? [];
  const cap = data?.dailyCap ?? 100;
  const isAdmin = data?.isAdmin ?? false;

  // No bridged LinkedIn account → onboarding CTA
  if (accounts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card/40 p-10 text-center">
        <Linkedin className="size-10 mx-auto mb-3 text-[#0A66C2] opacity-60" />
        <p className="text-sm font-medium">No LinkedIn account bridged yet</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          {isAdmin
            ? "Nobody in this workspace has connected a LinkedIn account. LinkedIn lookups run through a team member's authenticated session via Unipile."
            : "Connect your LinkedIn account so lookups run through your own authenticated session. LinkedIn caps each account at ~" +
              cap +
              " profile views/day."}
        </p>
        <a
          href="/connected-accounts"
          className="inline-flex items-center gap-1.5 mt-4 text-sm text-blue-600 hover:underline"
        >
          <ExternalLink className="size-3.5" />
          Connect a LinkedIn account
        </a>
      </div>
    );
  }

  const submit = () => {
    if (url.trim().length < 3) {
      toast.error("Paste a LinkedIn profile URL (https://linkedin.com/in/…)");
      return;
    }
    lookup.mutate({
      linkedinUrl: url.trim(),
      accountId: isAdmin && accountId !== "auto" ? accountId : undefined,
    });
  };

  const handleSave = () => {
    if (!result?.profile) return;
    save.mutate({
      firstName: edit.firstName || undefined,
      lastName: edit.lastName || undefined,
      title: edit.title || undefined,
      company: edit.company || undefined,
      companyDomain: edit.companyDomain || undefined,
      linkedinUrl: result.profile.public_profile_url || url.trim(),
    });
  };

  return (
    <div className="space-y-5">
      {/* Account pool meter */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {isAdmin ? "Workspace LinkedIn pool" : "Your LinkedIn account"}
          </div>
          <a
            href="/connected-accounts"
            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="size-3" />
            Manage
          </a>
        </div>
        <div className="space-y-1.5">
          {accounts.map((a) => {
            const pct = Math.min(100, Math.round((a.usedToday / cap) * 100));
            const bar =
              pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
            return (
              <div key={a.unipileAccountId} className="flex items-center gap-3 text-xs">
                <div className="w-40 truncate">
                  {a.displayName ?? a.ownerName ?? a.ownerEmail ?? a.unipileAccountId}
                  {isAdmin && a.ownerName && (
                    <span className="text-muted-foreground"> · {a.ownerName}</span>
                  )}
                </div>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="tabular-nums text-muted-foreground w-16 text-right">
                  {a.usedToday}/{cap}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          LinkedIn throttles each account at roughly {cap} profile views/day. Usage resets at
          midnight UTC. {isAdmin ? "Lookups auto-route to the account with the most headroom unless you pick one below." : ""}
        </p>
      </div>

      {/* People search */}
      <LinkedInSearch accounts={accounts} isAdmin={isAdmin} />

      {/* Lookup form */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Or look up one profile by URL
        </div>
        <div
          className={`grid grid-cols-1 gap-3 items-end ${
            isAdmin ? "md:grid-cols-[1fr_220px_auto]" : "md:grid-cols-[1fr_auto]"
          }`}
        >
          <div className="space-y-1">
            <Label htmlFor="li-url" className="text-xs">LinkedIn profile URL</Label>
            <Input
              id="li-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://linkedin.com/in/jane-smith"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          {isAdmin && (
            <div className="space-y-1">
              <Label className="text-xs">Route through</Label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full text-sm h-9 rounded-md border bg-background px-2"
              >
                <option value="auto">Auto (most headroom)</option>
                {accounts.map((a) => (
                  <option key={a.unipileAccountId} value={a.unipileAccountId}>
                    {(a.displayName ?? a.ownerName ?? a.unipileAccountId) +
                      ` (${a.remainingToday} left)`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button onClick={submit} disabled={lookup.isPending}>
            {lookup.isPending ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <Search className="size-4 mr-2" />
            )}
            Look up
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Uses one of your bridged LinkedIn sessions via Unipile. Public profile URLs only —
          Sales Navigator links aren&apos;t supported. Counts against the daily cap above.
        </p>
      </div>

      {/* Result */}
      {result?.ok && result.profile && (
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3 flex items-center gap-3">
            {result.profile.profile_picture_url && (
              <img
                src={result.profile.profile_picture_url}
                alt=""
                className="size-10 rounded-full object-cover"
              />
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">
                {result.profile.name ?? "(no name)"}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {result.profile.headline ?? ""}
              </div>
            </div>
            {result.profile.public_profile_url && (
              <a
                href={result.profile.public_profile_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="size-3" /> Profile
              </a>
            )}
          </div>
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
            <EditableField label="First name" value={edit.firstName} onChange={(v) => setEdit((e) => ({ ...e, firstName: v }))} conf="high" source="LinkedIn name" />
            <EditableField label="Last name" value={edit.lastName} onChange={(v) => setEdit((e) => ({ ...e, lastName: v }))} conf="high" source="LinkedIn name" />
            <EditableField label="Title / headline" value={edit.title} onChange={(v) => setEdit((e) => ({ ...e, title: v }))} conf="high" source="LinkedIn headline" />
            <EditableField label="Company" value={edit.company} onChange={(v) => setEdit((e) => ({ ...e, company: v }))} conf="none" source="" />
            <EditableField label="Company domain" value={edit.companyDomain} onChange={(v) => setEdit((e) => ({ ...e, companyDomain: v }))} conf="none" source="" />
          </div>
          <div className="border-t bg-muted/30 px-4 py-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{result.message}</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setResult(null);
                  setUrl("");
                }}
                disabled={save.isPending}
              >
                Discard
              </Button>
              <Button size="sm" onClick={handleSave} disabled={save.isPending}>
                {save.isPending ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <UserPlus className="size-3.5 mr-1.5" />
                )}
                Save as Prospect
              </Button>
            </div>
          </div>
        </div>
      )}

      {result && !result.ok && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <div>{result.message}</div>
        </div>
      )}
    </div>
  );
}
