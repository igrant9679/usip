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
    for (const page of ["Prospects", "DashboardHome2", "Contacts", "Campaigns"]) {
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

describe("the legacy Broadcasts page is retired without a fold (2026-10-27)", () => {
  const help = read("server/seedHelpContent.ts");

  /* Deleting a TourSeed is NOT enough: seedHelpContent's own comment says a
   * dropped seed leaves its row, and its steps, alive in every workspace
   * already seeded — naming it in RETIRED_LEGACY_TOURS is the only thing that
   * removes it. The Campaigns tour spotlighted `page-campaigns`, an anchor
   * that only existed on the deleted page, so leaving it seeded would strand
   * a tour that routes to /campaigns and is redirected straight back out. */
  it("the Campaigns tour is named as retired, not merely deleted", () => {
    const retiredList = help.slice(help.indexOf("const RETIRED_LEGACY_TOURS = ["), help.indexOf("];", help.indexOf("const RETIRED_LEGACY_TOURS = [")));
    expect(retiredList).toContain('"Campaigns",');
    expect(help).not.toContain('    name: "Campaigns",');
    // The engine's own tour is a different tour and must survive.
    expect(help).toContain('name: "ARE: Autonomous Campaigns"');
  });

  it("no page help, palette row or sidebar item offers Broadcasts", () => {
    expect(read("client/src/lib/toolRegistry.ts")).not.toContain('label: "Broadcasts"');
    expect(read("client/src/lib/helpText.ts")).not.toContain('"/campaigns"');
    expect(read("client/src/components/usip/Shell.tsx")).not.toContain('label: "Campaigns"');
  });

  /* The asymmetry with /prospects is deliberate: that prefix keeps its Elsie
   * entry because /prospects/:id still renders. /campaigns had no detail route
   * at all — selection was component state, never a URL — so nothing survives
   * under this prefix and the entry would only key guidance to a redirect. */
  it("Elsie drops the /campaigns prefix, having no page left under it", () => {
    const elsie = read("client/src/components/usip/Elsie.tsx");
    expect(elsie).not.toContain('["/campaigns", "campaigns"]');
    expect(elsie).toContain('["/prospects", "prospects"],');
  });

  /* The rows were deliberately NOT migrated and NOT deleted. Two things have
   * to stay true for that to be recoverable rather than merely invisible: the
   * tables still exist, and the sample-data remover can still find the seeded
   * ones by name. */
  it("the legacy rows are left in place and still findable", () => {
    const schema = read("drizzle/schema.ts");
    for (const t of ["campaigns", "campaignComponents", "campaignStepStats"]) {
      expect(schema, t).toContain(`export const ${t} = mysqlTable(`);
    }
    const seed = read("server/seed.ts");
    expect(seed).toContain('const SEED_CAMPAIGN_NAMES = ["Q2 Renewal Push", "Mid-market expansion", "Spring brand refresh"] as const;');
    expect(seed).toContain("campaignNames: [...SEED_CAMPAIGN_NAMES],");
    expect(read("server/services/sampleData.ts")).toContain("inArray(campaigns.name, SEED_FINGERPRINT.campaignNames as unknown as string[])");
  });

  it("the demo seeder no longer creates rows nothing can display", () => {
    const seed = read("server/seed.ts");
    expect(seed).not.toMatch(/db\.insert\(campaigns\)/);
  });
});

describe("the assistant and the manuals do not name a retired path", () => {
  /* The 2026-10-27 retirement was caught here by productKnowledge.test.ts:
   * knowledgeHrefs() still named /campaigns, so the assistant would describe
   * a page and then `navigate` straight into a redirect out of it. That check
   * only covers the digest, and this knowledge lives in three homes that
   * "can only drift apart silently" (productKnowledge.test.ts's own words).
   * So pin all three against every retired path, not just the digest. */
  const HOMES = [
    "server/productKnowledge.ts",
    "server/seedHelpOperatorManual.ts",
    ".claude/skills/velocity-operator/SKILL.md",
    ".claude/skills/velocity-operator/references/pages.md",
    ".claude/skills/velocity-operator/references/revenue-engine.md",
    ".claude/skills/velocity-operator/references/data-model.md",
    ".claude/skills/velocity-operator/references/routines.md",
  ];

  // The path as its own token: "/are/campaigns" must not count as "/campaigns",
  // and "/prospects/${id}" is the live detail route, not the retired list.
  // Index logic rather than an escaped character class — the class is the kind
  // of thing that silently loses a backslash on its way into this file and
  // then matches nothing.
  const PATHISH = /[A-Za-z0-9_/-]/;
  const names = (src: string, path: string) => {
    for (let i = src.indexOf(path); i !== -1; i = src.indexOf(path, i + 1)) {
      const before = i === 0 ? "\n" : src[i - 1];
      const after = src[i + path.length] ?? "\n";
      if (!PATHISH.test(before) && !PATHISH.test(after)) return true;
    }
    return false;
  };

  /* A retirement note is allowed to name the path; live prose is not. The
   * granularity matters: an earlier version of this check skipped whole LINES
   * that said "retired", which let a re-added live mention hide on the same
   * line as the note — a mutant walked straight through it. So the unit is the
   * SENTENCE: wherever a retired path appears, that sentence has to be the one
   * saying it is retired. */
  const sentences = (src: string) => src.split(/\n|(?<=\.)\s+/);

  it("no retired path is presented as a live page in any knowledge home", () => {
    const offenders: string[] = [];
    for (const f of HOMES) {
      for (const chunk of sentences(read(f))) {
        if (/retired|Retired/.test(chunk)) continue;
        for (const path of retired) if (names(chunk, path)) offenders.push(`${f} → ${path}: ${chunk.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the token match is strict enough to be worth trusting", () => {
    // Guards the regex itself: the live ARE path and the live detail route must
    // not read as retired, or this whole check passes by being blind.
    expect(names("Campaigns /are/campaigns, Sequences", "/campaigns")).toBe(false);
    expect(names("resolves to /prospects/${id} always", "/prospects")).toBe(false);
    expect(names("Find Prospects /find-prospects here", "/prospects")).toBe(false);
    expect(names("Marketing → Broadcasts /campaigns, Segments", "/campaigns")).toBe(true);
    expect(names("Broadcasts (/campaigns) prepare one message", "/campaigns")).toBe(true);
  });
});
