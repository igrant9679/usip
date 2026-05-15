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
} from "lucide-react";
import { toast } from "sonner";

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
            <TabsTrigger value="url" disabled className="gap-1.5">
              <Globe className="size-3.5" />
              URL Scraper
              <Badge variant="outline" className="ml-1 text-[9px] py-0">soon</Badge>
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
