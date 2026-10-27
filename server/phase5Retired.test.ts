/**
 * Phase 5 of the 2026-10-20 audit, item 2 — retire the v1 duplicates.
 *
 *   the retired paths redirect instead of 404ing, and land on a route that
 *   actually exists · the pages they rendered are gone, and nothing imports
 *   them · the person DETAIL page survives, because every deep link and
 *   ContactRedirect resolve to it · no sidebar, tool-registry, page-help or
 *   seeded help-article entry still points a reader at a retired path.
 *
 * The phase gate is "each retired route redirects, and its help articles are
 * updated". Help content never named /prospects or /dashboard-home2, so the
 * second half is pinned rather than performed: if an article ever starts
 * linking a retired path, this file fails instead of shipping a dead link.
 *
 * Legacy /campaigns is named by item 2 but deliberately NOT retired here; see
 * client/src/lib/retiredRoutes.ts for why (enhancement F21, the broadcast
 * fold-in, has to land first — fold, then redirect, as ContactRedirect and
 * AccountRedirect both did).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_ROUTES, retiredRedirectUrl, type RetiredRoute } from "../client/src/lib/retiredRoutes";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP = read("client/src/App.tsx");

/** Every path App.tsx registers a <Route> for. */
const routedPaths = new Set(Array.from(APP.matchAll(/<Route path="([^"]+)"/g), (m) => m[1]));

const retired = Object.keys(RETIRED_ROUTES) as RetiredRoute[];

describe("the retired v1 paths redirect (phase 5 item 2)", () => {
  it("every retired path is still a route, rendering the redirect", () => {
    for (const path of retired) {
      expect(routedPaths.has(path), `${path} must stay routed — a bookmark has to land somewhere`).toBe(true);
      expect(APP, path).toContain(`<Route path="${path}"><AuthGate><RetiredRedirect from="${path}" /></AuthGate></Route>`);
    }
  });

  it("each redirect lands on a route that exists", () => {
    for (const path of retired) {
      const target = retiredRedirectUrl(path);
      expect(routedPaths.has(target), `${path} redirects to ${target}, which App.tsx does not route`).toBe(true);
      // A retired path must not forward to another retired path.
      expect(retired as string[], target).not.toContain(target);
    }
  });

  it("the hop replaces history, so Back does not bounce the reader", () => {
    const src = read("client/src/pages/usip/RetiredRedirect.tsx");
    expect(src).toContain("setLocation(retiredRedirectUrl(from), { replace: true })");
  });

  it("the pages are deleted and nothing imports them", () => {
    for (const page of ["Prospects", "DashboardHome2", "Contacts"]) {
      expect(existsSync(join(ROOT, "client/src/pages/usip", `${page}.tsx`)), `${page}.tsx should be gone`).toBe(false);
      expect(APP, page).not.toContain(`@/pages/usip/${page}"`);
    }
  });
});

describe("retiring the list did not retire the person record", () => {
  it("/prospects/:id still renders the detail page", () => {
    expect(APP).toContain('<Route path="/prospects/:id"><AuthGate><ProspectDetail /></AuthGate></Route>');
  });

  it("ContactRedirect still resolves a contact onto that detail page", () => {
    expect(read("client/src/pages/usip/ContactRedirect.tsx")).toContain("setLocation(`/prospects/${c.personProspectId}`, { replace: true })");
  });
});

describe("nothing still sends a reader to a retired path", () => {
  // The bare quoted path only: "/prospects/${id}" is the live detail route and
  // must keep working.
  const surfaces = [
    "client/src/components/usip/Shell.tsx",
    "client/src/lib/toolRegistry.ts",
    "client/src/lib/helpText.ts",
    "client/src/pages/usip/Dashboard.tsx",
    "client/src/pages/usip/Dashboards.tsx",
    "client/src/pages/usip/ImportContacts.tsx",
  ];

  it("no sidebar, tool-registry or page-help entry points at one", () => {
    const offenders: string[] = [];
    for (const f of surfaces) {
      const src = read(f);
      for (const path of retired) if (src.includes(`"${path}"`)) offenders.push(`${f} → ${path}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the sidebar still offers People, which the prospect list folded into", () => {
    expect(read("client/src/components/usip/Shell.tsx")).toContain('{ href: "/v2/people", label: "People", icon: Users }');
  });

  it("no seeded help article or tour links a retired path", () => {
    const help = read("server/seedHelpContent.ts");
    const offenders = retired.filter((path) => help.includes(`"${path}"`) || help.includes(`(${path})`));
    expect(offenders).toEqual([]);
  });
});

describe("the detail page keeps its guidance", () => {
  /* Elsie matches ROUTE_PAGE_KEYS by PREFIX, so the "/prospects" entry is what
   * gives /prospects/:id its guidance. It reads like a leftover now that the
   * list is retired — it is not. Removing it would leave the person detail
   * page silent. */
  it("Elsie still keys the /prospects prefix, which serves /prospects/:id", () => {
    expect(read("client/src/components/usip/Elsie.tsx")).toContain('["/prospects", "prospects"],');
  });
});
