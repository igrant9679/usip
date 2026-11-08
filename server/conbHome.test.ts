/**
 * One home page, and "Set as home" is the person's (audit 2026-10-20, U33 and
 * X6.3; batch CONB, 2026-11-08).
 *
 *   The Dashboard (/dashboard) and Home (/v2/home) were two homes. They are
 *   one page now: Home with a Today view (its own) and a Pipeline view (the
 *   Dashboard's whole body). "/" renders it; /dashboard redirects to the
 *   Pipeline view. "Set as home" picks the view, stored on the person
 *   (users.home_view, migration 0430) instead of one browser; a browser's old
 *   choice is carried to the server once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  roles: {} as Record<number, string>,
  queries: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; vars: any }>,
  buttons: [] as any[],
  search: "",
  nav: [] as string[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: () => h.queries[path] ?? { data: undefined, isLoading: false, error: null },
    useMutation: () => ({ mutate: (vars: any) => { h.calls.push({ path, vars }); }, isPending: false, variables: undefined }),
  });
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: () => {} }) }) });
  return {
    trpc: new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
      get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
    }),
  };
});
vi.mock("@/components/usip/Shell", async () => {
  const { createElement: el } = await import("react");
  return { Shell: ({ children, title }: any) => el("main", { "data-title": title }, children), useAccentColor: () => "#123456" };
});
vi.mock("wouter", async () => {
  const { createElement: el } = await import("react");
  return {
    Link: ({ href, children }: any) => el("a", { href }, children),
    useLocation: () => ["/v2/home", (to: string) => { h.nav.push(to); }],
    useSearch: () => h.search,
  };
});
vi.mock("../client/src/pages/usip/Dashboard", async () => {
  const { createElement: el } = await import("react");
  return { DashboardOverview: () => el("section", null, "PIPELINE-OVERVIEW") };
});
vi.mock("@/components/usip/AttentionPanel", async () => {
  const { createElement: el } = await import("react");
  return { AttentionPanel: () => el("section", null, "ATTENTION-PANEL") };
});
vi.mock("@/components/usip/QueryState", () => ({ FailedLoadsBanner: () => null }));
vi.mock("@/components/usip/ResponsiveRail", () => ({ ResponsiveRail: () => null }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 21, name: "Rita Rep" } }) }));
vi.mock("@/components/ui/button", async () => {
  const { createElement: el } = await import("react");
  return { Button: (props: any) => { h.buttons.push(props); return el("button", { title: props.title }, props.children); } };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import Home from "../client/src/pages/usip/Home";
import { carryOverHomeView, homeViewFrom, resolveHomeView, HOME_CHOICES, LEGACY_HOME_KEY } from "../client/src/lib/homeChoice";
import { DEFAULT_HOME_VIEW } from "@shared/homeView";
import { RETIRED_ROUTES, retiredRedirectUrl } from "../client/src/lib/retiredRoutes";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const WS = 2;
const ME = 21;

function caller() {
  h.roles[WS] = "rep";
  return appRouter.createCaller({
    user: { id: ME, openId: "u", email: "rep@lsi.example", name: "Rita Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
function render(search: string, homeView: string | null) {
  h.search = search;
  h.buttons = [];
  h.queries["profile.getMyAppearance"] = { data: { themePalette: null, elsieEnabled: true, homeView }, isLoading: false, error: null };
  return renderToStaticMarkup(createElement(Home));
}

beforeEach(() => {
  h.roles = {};
  h.db = makeSqlFakeDb({ roles: h.roles, wsId: () => WS });
  h.db.rowsOf("users").push({ id: ME, openId: "u", email: "rep@lsi.example", name: "Rita Rep", role: "user", themePalette: null, elsieEnabled: null, homeView: null });
  h.queries = {};
  h.calls = [];
  h.nav = [];
});
afterEach(() => { vi.restoreAllMocks(); });

describe("'Set as home' is stored on the person", () => {
  it("is saved and read back with the account's other appearance choices", async () => {
    expect((await caller().profile.getMyAppearance()).homeView).toBeNull();
    await caller().profile.updateMyAppearance({ homeView: "today" });
    expect(h.db.rowsOf("users")[0].homeView).toBe("today");
    expect((await caller().profile.getMyAppearance()).homeView).toBe("today");
  });
  it("leaves the other choices alone, and null forgets it", async () => {
    await caller().profile.updateMyAppearance({ themePalette: "rose" });
    expect(h.db.rowsOf("users")[0].homeView).toBeNull();
    await caller().profile.updateMyAppearance({ homeView: "pipeline" });
    await caller().profile.updateMyAppearance({ homeView: null });
    expect((await caller().profile.getMyAppearance()).homeView).toBeNull();
    expect(h.db.rowsOf("users")[0].themePalette).toBe("rose");
  });
  it("takes only a real view, and a stored stray value reads as never chosen", async () => {
    await expect(caller().profile.updateMyAppearance({ homeView: "/dashboard" as any })).rejects.toThrow();
    h.db.rowsOf("users")[0].homeView = "javascript:alert(1)";
    expect((await caller().profile.getMyAppearance()).homeView).toBeNull();
  });
  it("has its own additive migration in this batch's block", () => {
    const mig = read("server/_core/rawMigrations.ts");
    const m = mig.slice(mig.indexOf('name: "0430_user_home_view.sql"'), mig.indexOf('name: "0430_user_home_view.sql"') + 200);
    expect(m).toContain("\"ALTER TABLE `users` ADD COLUMN `home_view` varchar(16) NULL\"");
    expect(read("drizzle/schema.ts")).toContain('homeView: varchar("home_view", { length: 16 }),');
  });
});

describe("a browser's old choice is carried over once", () => {
  it("reads the old key's values as views", () => {
    expect(LEGACY_HOME_KEY).toBe("velocity_home_dashboard");
    expect(homeViewFrom("/v2/home")).toBe("today");
    expect(homeViewFrom("/dashboard")).toBe("pipeline");
    expect(homeViewFrom("/dashboard-home2")).toBeNull();
  });
  it("is carried only when the server holds none; the server's own choice wins", () => {
    expect(carryOverHomeView(null, "/v2/home")).toBe("today");
    expect(carryOverHomeView(null, null)).toBeNull();
    expect(carryOverHomeView("pipeline", "/v2/home")).toBeNull();
  });
  it("the hook drops the browser's copy whatever it carried, after the server answers", () => {
    const hook = read("client/src/hooks/useHomeView.ts");
    const effect = hook.slice(hook.indexOf("useEffect(() => {"), hook.indexOf("}, [server]);"));
    expect(effect).toContain("if (carried.current || server === undefined) return;");
    expect(effect).toContain("const carry = carryOverHomeView(server, readLegacy());");
    expect(effect).toContain("dropLegacy();");
    expect(effect).toContain("if (carry) save.mutate({ homeView: carry });");
  });
  it("no page reads or writes the browser key any more", () => {
    for (const f of ["client/src/components/usip/Shell.tsx", "client/src/pages/usip/Dashboards.tsx", "client/src/pages/usip/Home.tsx"]) {
      const src = read(f);
      expect(src, f).not.toContain("HOME_DASHBOARD_KEY");
      expect(src, f).not.toContain("velocity_home_dashboard");
    }
    expect(read("client/src/pages/usip/Dashboards.tsx")).toContain("const { homeView, setHomeView } = useHomeView();");
  });
});

describe("one home page with two views", () => {
  it("the URL's view wins; then the saved choice; then the dashboard", () => {
    expect(resolveHomeView("?view=today", "pipeline")).toBe("today");
    expect(resolveHomeView("", "today")).toBe("today");
    expect(resolveHomeView("", null)).toBe("pipeline");
    expect(resolveHomeView("?view=nope", null)).toBe(DEFAULT_HOME_VIEW);
    expect(HOME_CHOICES.map((c) => c.view)).toEqual(["today", "pipeline"]);
  });

  it("the Pipeline view renders the Dashboard's body, not the widgets", () => {
    const html = render("?view=pipeline", "today");
    expect(html).toContain("PIPELINE-OVERVIEW");
    expect(html).not.toContain("ATTENTION-PANEL");
    expect(html).toContain('data-title="Dashboard"');
  });

  it("the Today view renders the attention panel and the widgets", () => {
    const html = render("?view=today", null);
    expect(html).toContain("ATTENTION-PANEL");
    expect(html).toContain("Welcome, Rita");
    expect(html).not.toContain("PIPELINE-OVERVIEW");
    expect(html).toContain('data-title="Home"');
  });

  it("with no view in the URL it opens on the person's choice, or the dashboard", () => {
    expect(render("", "today")).toContain("ATTENTION-PANEL");
    expect(render("", null)).toContain("PIPELINE-OVERVIEW");
  });

  it("a switch between the views, as a tablist", () => {
    const html = render("?view=today", null);
    expect(html).toContain('role="tablist" aria-label="Home views"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Today<\/button>/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Pipeline<\/button>/);
  });

  it("'Set as home' saves the view on show to the server; the chosen view says it is home", () => {
    render("?view=today", "pipeline");
    const set = h.buttons.find((b) => JSON.stringify(b.children).includes("Set as home"));
    expect(set).toBeTruthy();
    set.onClick();
    expect(h.calls).toContainEqual({ path: "profile.updateMyAppearance", vars: { homeView: "today" } });
    const html = render("?view=pipeline", "pipeline");
    expect(html).toContain("Your home");
    expect(h.buttons.some((b) => JSON.stringify(b.children).includes("Set as home"))).toBe(false);
  });
});

describe("the routes: '/' is the home page, /dashboard its Pipeline view", () => {
  it("'/' renders Home, and the old chooser route is gone", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('<Route path="/"><AuthGate><Home /></AuthGate></Route>');
    expect(app).toContain('<Route path="/dashboard"><AuthGate><RetiredRedirect from="/dashboard" /></AuthGate></Route>');
    expect(app).not.toContain("HomeRoute");
    expect(existsSync(join(ROOT, "client/src/pages/usip/HomeRoute.tsx"))).toBe(false);
  });
  it("/dashboard lands on the Pipeline view", () => {
    expect(RETIRED_ROUTES["/dashboard"]).toBe("/v2/home?view=pipeline");
    expect(retiredRedirectUrl("/dashboard")).toBe("/v2/home?view=pipeline");
  });
  it("Dashboard.tsx keeps its page wrapper, unrouted, around the shared body", () => {
    const dash = read("client/src/pages/usip/Dashboard.tsx");
    expect(dash).toContain("export function DashboardOverview() {");
    const page = dash.slice(dash.indexOf("export default function Dashboard() {"));
    expect(page).toContain("<DashboardOverview />");
    expect(read("client/src/pages/usip/Home.tsx")).toContain("<DashboardOverview />");
  });
  it("the rail's Dashboard and the tours open the Pipeline view", () => {
    const seed = read("server/seedHelpContent.ts");
    expect(seed).not.toContain('route: "/dashboard"');
    expect(seed).not.toContain('routeTo: "/dashboard"');
    expect(seed).toContain('route: "/v2/home?view=pipeline"');
  });
});
