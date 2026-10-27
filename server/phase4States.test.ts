/**
 * Phase 4 of the 2026-10-20 audit, part 3 — loading, failed, empty and not
 * found are four answers, not one (U2, X1.6, G37).
 *
 *   a 4xx is not retried, so a missing record says so at once instead of
 *   spinning (L4, L5) · QueryState / QueryError / NotFoundState render each
 *   outcome, and a failed refresh keeps the data on screen · Home and
 *   Analytics say how many parts did not load instead of showing zeros (G57)
 *   · a page that breaks takes only itself down, says so plainly, and leaving
 *   it clears the error (G37) · the audit's screens each have the branch.
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_QUERY_RETRIES, shouldRetryQuery } from "../client/src/lib/queryRetry";
import { QueryState, NotFoundState, failedActiveQueries, isNotFoundError } from "../client/src/components/usip/QueryState";
import ErrorBoundary, { isStaleChunkError } from "../client/src/components/ErrorBoundary";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: ReactElement) => renderToStaticMarkup(el);
const err = (httpStatus: number, code: string, message = `${code} happened`) => ({ message, data: { httpStatus, code } });

describe("a 4xx is the server's final answer (L4, L5)", () => {
  it("not found, forbidden, bad input, signed out, rate limited: no retry", () => {
    for (const [s, c] of [[404, "NOT_FOUND"], [403, "FORBIDDEN"], [400, "BAD_REQUEST"], [401, "UNAUTHORIZED"], [429, "TOO_MANY_REQUESTS"]] as const) {
      expect(shouldRetryQuery(0, err(s, c)), c).toBe(false);
    }
  });

  it("a server error or a dropped connection is retried, three times", () => {
    expect(MAX_QUERY_RETRIES).toBe(3);
    expect(shouldRetryQuery(0, err(500, "INTERNAL_SERVER_ERROR"))).toBe(true);
    expect(shouldRetryQuery(2, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(3, new TypeError("Failed to fetch"))).toBe(false);
  });

  it("is every query's default", () => {
    expect(read("client/src/main.tsx")).toContain("queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetryQuery }");
  });
});

describe("QueryState keeps the four outcomes apart (U2)", () => {
  const q = (o: Partial<{ data: unknown; error: unknown; isLoading: boolean }>) => ({ data: undefined, error: null, isLoading: false, refetch: () => {}, ...o });
  const render = (query: ReturnType<typeof q>, extra: Record<string, unknown> = {}) =>
    html(createElement(QueryState as any, { query, what: "routing rules", children: (d: any) => createElement("p", null, `rows:${d.length}`), ...extra }));

  it("loading shows the skeleton", () => {
    expect(render(q({ isLoading: true }))).toContain('aria-busy="true"');
  });

  it("a failure says what failed and why, with Retry, never the empty state", () => {
    const out = render(q({ error: err(500, "INTERNAL_SERVER_ERROR", "Database unavailable") }), { isEmpty: (d: any) => d.length === 0 });
    expect(out).toContain('role="alert"');
    expect(out).toContain("Couldn’t load routing rules");
    expect(out).toContain("Database unavailable");
    expect(out).toContain("Retry");
    expect(out).not.toContain("No routing rules yet");
  });

  it("not found is its own answer, from the error or from a lookup that returned nothing", () => {
    expect(render(q({ error: err(404, "NOT_FOUND") }), { what: "campaign" })).toContain("Campaign not found");
    expect(render(q({ data: null }), { what: "list" })).toContain("List not found");
    expect(isNotFoundError(err(404, "NOT_FOUND"))).toBe(true);
    expect(isNotFoundError({ data: { code: "NOT_FOUND" } })).toBe(true);
    expect(isNotFoundError({ data: { httpStatus: 404 } })).toBe(true);
    expect(isNotFoundError(err(500, "INTERNAL_SERVER_ERROR"))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it("empty is empty only when the data loaded", () => {
    expect(render(q({ data: [] }), { isEmpty: (d: any) => d.length === 0 })).toContain("No routing rules yet");
    expect(render(q({ data: [1, 2] }), { isEmpty: (d: any) => d.length === 0 })).toContain("rows:2");
  });

  it("a refresh that fails keeps what is on screen and says so", () => {
    const out = render(q({ data: [1], error: err(500, "INTERNAL_SERVER_ERROR", "timeout") }));
    expect(out).toContain("rows:1");
    expect(out).toContain("Couldn’t load the latest routing rules");
  });

  it("not found offers the way back", () => {
    const out = html(createElement(Router, { ssrPath: "/are/campaigns/2" }, createElement(NotFoundState, { what: "campaign", backHref: "/are/campaigns", backLabel: "All campaigns" })));
    expect(out).toContain('href="/are/campaigns"');
    expect(out).toContain("another workspace");
  });
});

describe("Home and Analytics say what did not load, instead of zeros (G57)", () => {
  const query = (observers: number, status: string, data?: unknown) => ({ getObserversCount: () => observers, state: { status, data } }) as any;

  it("counts this page's failed queries that have nothing to show", () => {
    const failed = query(1, "error");
    expect(failedActiveQueries([failed, query(1, "success", 1), query(0, "error"), query(2, "error", { stale: true })])).toEqual([failed]);
  });

  it("both pages carry the banner", () => {
    expect(read("client/src/pages/usip/Home.tsx")).toContain("<FailedLoadsBanner />");
    expect(read("client/src/pages/usip/AnalyticsV2.tsx")).toContain("<FailedLoadsBanner />");
  });
});

describe("a broken page takes only itself down (G37)", () => {
  const boom = Object.assign(new Error("Cannot read properties of undefined (reading 'name')"), { stack: "Error: at Widget (Widget.tsx:12)" });

  it("says so plainly, with the details folded away", () => {
    const b = new ErrorBoundary({ children: null, inline: true });
    b.state = { hasError: true, error: boom };
    const out = html(b.render() as ReactElement);
    expect(out).toContain("This page hit a problem");
    expect(out).toContain("Go back");
    expect(out).toMatch(/<details[^>]*>.*Widget\.tsx:12.*<\/details>/s);
    expect(out.slice(0, out.indexOf("<details"))).not.toContain("Widget.tsx:12");
  });

  it("a chunk from an old deploy reads as a new version, not a crash", () => {
    const stale = new TypeError("Failed to fetch dynamically imported module: https://x/assets/Page-1.js");
    expect(isStaleChunkError(stale)).toBe(true);
    expect(isStaleChunkError(boom)).toBe(false);
    const b = new ErrorBoundary({ children: null });
    b.state = { hasError: true, error: stale };
    expect(html(b.render() as ReactElement)).toContain("A new version of Velocity is available");
  });

  it("leaving the page clears the error", () => {
    const b = new ErrorBoundary({ children: null, resetKey: "/a" });
    b.state = { hasError: true, error: boom };
    b.setState = ((s: any) => { b.state = { ...b.state, ...s }; }) as any;
    (b as any).props = { children: null, resetKey: "/a" };
    b.componentDidUpdate({ children: null, resetKey: "/a" });
    expect(b.state.hasError).toBe(true);
    (b as any).props = { children: null, resetKey: "/b" };
    b.componentDidUpdate({ children: null, resetKey: "/a" });
    expect(b.state.hasError).toBe(false);
  });

  it("App puts one around the routes, keyed by the path", () => {
    const app = read("client/src/App.tsx");
    const router = app.slice(app.indexOf("function Router()"), app.indexOf("function App()"));
    expect(router).toContain("const [path] = useLocation();");
    expect(router).toMatch(/<ErrorBoundary resetKey=\{path\} inline>\s*<Suspense/);
    expect(router).toMatch(/<\/Suspense>\s*<\/ErrorBoundary>/);
  });
});

describe("the audit's screens each tell a failure from nothing (X1.6)", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["L4 ARE campaign", "client/src/pages/usip/ARECampaignDetail.tsx", /campaignQ\.error && !isNotFoundError\(campaignQ\.error\)\s*\?\s*<QueryError what="this campaign"/],
    ["L4 ARE campaign id", "client/src/pages/usip/ARECampaignDetail.tsx", /useQuery\(\{ id: campaignId \}, \{ enabled: validId \}\)/],
    ["P40 lead routing", "client/src/pages/usip/LeadRouting.tsx", /rulesQ\.error && !rules \? \(\s*<QueryError what="routing rules"/],
    ["P136 lists", "client/src/pages/usip/Lists.tsx", /error && !data \? \(\s*<QueryError compact what="lists"/],
    ["P136 segments", "client/src/pages/usip/Segments.tsx", /error && !segments \? \(\s*<QueryError what="segments"/],
    ["P148 source search", "client/src/pages/usip/SourceSearch.tsx", /if \(describe\.error && !describe\.data\) return <QueryError/],
    ["P148 find prospects", "client/src/pages/usip/FindProspects.tsx", /if \(error && !data\) return <QueryError what="these prospects"/],
    ["P51 list detail", "client/src/pages/usip/ListDetail.tsx", /if \(!Number\.isFinite\(id\) \|\| listQ\.error \|\| \(listQ\.isFetched && !list\)\)/],
    ["P154 job changes", "client/src/pages/usip/DataEnrichment.tsx", /jobChangesQ\.error && !jobChangesQ\.data \? \(\s*<QueryError what="job changes"/],
    ["P154 visitors", "client/src/pages/usip/WebsiteVisitors.tsx", /known\.error && !known\.data \? \(\s*<tr><td colSpan=\{4\}><QueryError what="visits"/],
    ["A60 ARE settings", "client/src/pages/usip/ARESettings.tsx", /if \(!settings\) \{\s*return \(\s*<Shell title="ARE Settings">\s*<QueryError what="ARE settings"/],
    ["P118 scoring weights", "client/src/pages/usip/LeadScoring.tsx", /\) : !serverCfg \? \(\s*\/\/[^\n]*\n\s*<QueryError what="the scoring weights"/],
    ["P118 breakdown", "client/src/pages/usip/LeadScoring.tsx", /bdError && !isFetching \? \(\s*<QueryError compact what="this lead's breakdown"/],
    ["R62 enrich job", "client/src/components/usip/people/LinkedInEnrichment.tsx", /jobQ\.data\?\.status === "failed" \|\| jobQ\.data\?\.status === "canceled"/],
    ["P113 research runs", "client/src/components/usip/research/ResearchRuns.tsx", /if \(q\.error && !q\.data\) return <Section title="AI research runs"><QueryError/],
    ["A63 what's working", "client/src/pages/usip/AREPerformance.tsx", /!loading && !metricsError && stepRows\.length === 0/],
    ["R88 prospects", "client/src/pages/usip/Prospects.tsx", /!isLoading && error && !data && \(/],
    ["R88 filters", "client/src/pages/usip/Prospects.tsx", /No prospects match these filters\./],
    ["R88 page clamp", "client/src/pages/usip/Prospects.tsx", /if \(data && page > lastPage\) setPage\(lastPage\)/],
    ["R70 proposals", "client/src/pages/usip/Proposals.tsx", /listError && !list \? \(\s*<QueryError what="proposals"/],
  ];
  for (const [name, file, re] of cases) {
    it(name, () => { expect(read(file)).toMatch(re); });
  }

  it("P104 research pages answer an impossible id with not found", () => {
    for (const f of ["ResearchMarket", "ResearchSector", "ResearchReport", "ResearchSectorReport"]) {
      expect(read(`client/src/pages/usip/research/${f}.tsx`), f).toMatch(/if \(!\(Number\.isFinite\(id\) && id > 0\)\) return <Shell title="Research"><NotFoundState/);
    }
  });
});
