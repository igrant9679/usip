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
import { trpc } from "@/lib/trpc";
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

type Confidence = "high" | "medium" | "low" | "none";
type ExtractedField<T> = { value: T | null; confidence: Confidence; source: string };
type ExtractedData = {
  url: string;
  pageTitle: string | null;
  error?: string;
  firstName: ExtractedField<string>;
  lastName: ExtractedField<string>;
  fullName: ExtractedField<string>;
  jobTitle: ExtractedField<string>;
  email: ExtractedField<string>;
  phone: ExtractedField<string>;
  bio: ExtractedField<string>;
  companyName: ExtractedField<string>;
  companyDomain: ExtractedField<string>;
  allEmails: string[];
  allPhones: string[];
  socialUrls: string[];
};

type PlacesHit = {
  placeId: string;
  name: string;
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  types?: string[];
  location?: { lat: number; lng: number };
  googleMapsUri?: string;
};

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
            <TabsTrigger value="linkedin" disabled className="gap-1.5">
              <Linkedin className="size-3.5" />
              LinkedIn
              <Badge variant="outline" className="ml-1 text-[9px] py-0">soon</Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="places" className="mt-4">
            <PlacesTab />
          </TabsContent>
          <TabsContent value="url" className="mt-4">
            <UrlScraperTab />
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
      toast.success(`Saved ${data.created} prospect${data.created === 1 ? "" : "s"}`);
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
    onSuccess: (res) => {
      if (res.ok) {
        toast.success("Saved as Prospect");
        setResult(null);
        setUrl("");
      } else {
        toast.error(res.error ?? "Save failed");
      }
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
