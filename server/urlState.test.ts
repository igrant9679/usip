/**
 * A view survives a refresh and can be shared (audit 2026-10-20, U6):
 * filters, sort, page, tab and the open record live in the address on People,
 * Companies, Proposals and the Revenue Engine campaign page, through one
 * small hook (client/src/lib/urlState.ts) instead of each page parsing the
 * query string its own way.
 *
 *   1. the hook's pure half: each kind of parameter reads, writes, leaves its
 *      default out of the address and keeps every other parameter;
 *   2. each page keeps the listed parts of its view through the hook, and the
 *      links that already worked still do (People's Data Health deep links,
 *      the dashboard's ?expiryFilter= and ?window=, ?prospect=, ?reason=,
 *      ?kind=);
 *   3. a restored page number is not reset to 1 by a page's own debounce on
 *      its first render, which would have undone the restore a moment later.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasAnyParam, readParam, urlParam, writeParam } from "../client/src/lib/urlState";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `start anchor: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end anchor: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

describe("the hook's parameters (U6)", () => {
  it("text: absent is the default, and the default is left out", () => {
    const p = urlParam.string();
    expect(readParam("", "q", p)).toBe("");
    expect(readParam("?q=jane%20doe", "q", p)).toBe("jane doe");
    expect(writeParam("?page=2", "q", "jane doe", p)).toBe("?page=2&q=jane+doe");
    expect(writeParam("?q=jane&page=2", "q", "", p)).toBe("?page=2");
    expect(writeParam("?sort=name", "sort", "contactCount", urlParam.string("contactCount"))).toBe("");
  });

  it("a page number: whole and at least 1, anything else is page 1", () => {
    const p = urlParam.int(1);
    expect(readParam("?page=3", "page", p)).toBe(3);
    for (const bad of ["?page=0", "?page=-2", "?page=2.5", "?page=abc", ""]) expect(readParam(bad, "page", p)).toBe(1);
    expect(writeParam("?q=x&page=3", "page", 1, p)).toBe("?q=x");
    expect(writeParam("?q=x", "page", 4, p)).toBe("?q=x&page=4");
  });

  it("a record id: positive and whole, or none", () => {
    const p = urlParam.id();
    expect(readParam("?person=42", "person", p)).toBe(42);
    expect(readParam("?person=0", "person", p)).toBeNull();
    expect(readParam("?person=x", "person", p)).toBeNull();
    expect(writeParam("?person=42&q=a", "person", null, p)).toBe("?q=a");
  });

  it("a switch is \"1\" or absent", () => {
    const p = urlParam.bool();
    expect(readParam("?hasEmail=1", "hasEmail", p)).toBe(true);
    expect(readParam("?hasEmail=true", "hasEmail", p)).toBe(false);
    expect(writeParam("", "hasEmail", true, p)).toBe("?hasEmail=1");
    expect(writeParam("?hasEmail=1", "hasEmail", false, p)).toBe("");
  });

  it("one of a set: an unknown value reads as the default", () => {
    const p = urlParam.oneOf(["asc", "desc"] as const, "desc");
    expect(readParam("?dir=asc", "dir", p)).toBe("asc");
    expect(readParam("?dir=sideways", "dir", p)).toBe("desc");
    expect(writeParam("?dir=asc", "dir", "desc", p)).toBe("");
  });

  it("a set: comma-separated, empty left out, order kept", () => {
    const p = urlParam.set();
    expect(Array.from(readParam("?tier=high,low", "tier", p))).toEqual(["high", "low"]);
    expect(readParam("", "tier", p).size).toBe(0);
    expect(writeParam("", "tier", new Set(["high", "medium"]), p)).toBe("?tier=high%2Cmedium");
    expect(writeParam("?tier=high", "tier", new Set(), p)).toBe("");
  });

  it("every other parameter is kept, so existing links keep working beside these", () => {
    expect(writeParam("?reply=12&tab=inbox", "page", 2, urlParam.int(1))).toBe("?reply=12&tab=inbox&page=2");
    expect(hasAnyParam("?emailStatus=invalid", ["q", "emailStatus"])).toBe(true);
    expect(hasAnyParam("?reply=1", ["q", "emailStatus"])).toBe(false);
  });

  it("the hook writes with a replace, from the address as it is when the setter runs", () => {
    const hook = read("client/src/lib/urlState.ts");
    const fn = block(hook, "export function useUrlState<T>(", "\n}\n");
    expect(fn).toContain("const current = typeof window === \"undefined\" ? \"\" : window.location.search;");
    expect(fn).toContain("{ replace: true }");
    // Parsed per raw value: a set keeps its identity until its own key changes.
    expect(fn).toContain("useMemo(() => p.parse(raw), [raw])");
  });
});

describe("each page keeps its view in the address (U6)", () => {
  const keysOf = (src: string) => new Set(Array.from(src.matchAll(/useUrlState(?:<[^>]+>)?\("(\w+)"/g)).map((m) => m[1]));

  it("People: every filter, the sort, the page and the open person", () => {
    const src = read("client/src/pages/usip/People.tsx");
    const keys = keysOf(src);
    for (const k of ["emailStatus", "hasEmail", "missingEmail", "verification", "promoted", "companyId", "page", "q", "title", "company", "location", "industry", "education", "linkedin", "enrolled", "hasPhone", "hasLinkedin", "tier", "seniority", "sort", "dir", "person"]) {
      expect(keys, k).toContain(k);
    }
    // The list of keys the page names is the list it uses.
    const listed = block(src, "const PEOPLE_URL_KEYS = [", "] as const;");
    for (const k of Array.from(keys)) expect(listed, k).toContain(`"${k}"`);
    // A deep link or a shared view wins over the remembered saved search.
    expect(src).toContain("hasAnyParam(urlParams?.toString() ?? \"\", VIEW_FILTER_KEYS)");
    // A ?person= link opens that person even when they are not on the page.
    expect(src).toContain("trpc.prospects.get.useQuery({ id: selectedId ?? 0 }, { enabled: selectedId != null && !onPage })");
  });

  it("Companies: every filter, the sort and the page", () => {
    const keys = keysOf(read("client/src/pages/usip/Companies.tsx"));
    for (const k of ["q", "industry", "location", "hasContacts", "archived", "rating", "empMin", "empMax", "research", "sector", "sort", "dir", "page"]) expect(keys, k).toContain(k);
  });

  it("Proposals: search, status, the expiry window and the sort; the dashboard's links still land", () => {
    const src = read("client/src/pages/usip/Proposals.tsx");
    const keys = keysOf(src);
    for (const k of ["q", "status", "expiryFilter", "window", "sort"]) expect(keys, k).toContain(k);
    expect(src).toContain("const statusFilter = statusParam || LEGACY_EXPIRY_STATUS[legacyExpiry] || \"all\";");
    expect(src).toContain('const LEGACY_EXPIRY_STATUS: Record<string, string> = { expired: "expired_cohort", accepted: "accepted_cohort", active: "active_cohort" };');
    // Picking a status here replaces the dashboard's, rather than falling back to it.
    expect(src).toContain('const setStatusFilter = (s: string) => { setLegacyExpiry(""); setStatusParam(s === "all" ? "" : s); };');
  });

  it("the campaign page: tab, view, enrichment, search, page, the open dossier, rejections and the Sequences tab", () => {
    const src = read("client/src/pages/usip/ARECampaignDetail.tsx");
    const keys = keysOf(src);
    for (const k of ["tab", "view", "enrich", "q", "page", "prospect", "reason", "kind", "rpage", "seq", "seqq", "seqpage"]) expect(keys, k).toContain(k);
    // The open dossier is the parameter: opening writes it, closing removes it.
    expect(src).toContain("const dossierOpen = linkedProspectId !== null;");
    expect(src).toContain("const setDossierOpen = (open: boolean) => setLinkedProspectId(open ? selectedProspectId : null);");
    // Every tab the strip offers is a value ?tab= takes.
    const strip = Array.from(src.matchAll(/<TabsTrigger value="([a-z_-]+)"/g)).map((m) => m[1]);
    const tabs = block(src, "const CAMPAIGN_TABS = [", "] as const;");
    for (const t of strip) expect(tabs, t).toContain(`"${t}"`);
  });

  it("no page parses the query string for its view by hand any more", () => {
    for (const f of ["Companies", "Proposals", "ARECampaignDetail"]) {
      expect(read(`client/src/pages/usip/${f}.tsx`), f).not.toContain("new URLSearchParams(");
    }
    // People reads it once, only to tell a deep link from a plain visit.
    expect(read("client/src/pages/usip/People.tsx").split("new URLSearchParams(").length - 1).toBe(1);
  });
});

describe("a restored page is not reset by the page's own debounce (U6)", () => {
  it("People's text-filter debounce does nothing when the filters are what it already applied", () => {
    const src = read("client/src/pages/usip/People.tsx");
    const eff = block(src, "const [qText, setQText] = useState(() => ({", "// ── server query ──");
    expect(eff).toContain("if (JSON.stringify(next) === JSON.stringify(qText)) return;");
    // The guard sits before the timer that resets the page.
    expect(block(eff, "if (JSON.stringify(next)", "setPage(1);")).toContain("setTimeout(");
  });

  it("Companies' search debounce does nothing when the box already says what the address does", () => {
    const src = read("client/src/pages/usip/Companies.tsx");
    expect(src).toContain("useEffect(() => { if (searchInput === q) return; const t = setTimeout(() => { setQ(searchInput); setPage(1); }, 300);");
    expect(src).toContain("const [searchInput, setSearchInput] = useState(q);");
  });
});
