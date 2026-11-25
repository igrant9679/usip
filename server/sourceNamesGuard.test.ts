/**
 * Anonymous source names (owner 2026-11-25): "Name the sources Source 1, 2,
 * 3 etc. and give a brief description of source but don't give the actual
 * true name of the source." Only the platform owner reads a vendor's name.
 *
 * Two kinds of check, because a name in the source is not what renders:
 *   1. GUARDS over member-facing strings: client code outside comments, the
 *      help articles and tours, Elsie's digest and her action descriptions.
 *      The allowed exceptions are the cards for a workspace's OWN key (where
 *      a member pastes that vendor's key) and the platform owner's section.
 *   2. CALL SITES: the helper the screens use, the describe router as a
 *      member and as the platform owner, and the log sink, each run.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "9".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { encryptSecret } from "./_core/crypto";
import { ARTICLES, TOURS } from "./seedHelpContent";
import { OPERATOR_ARTICLES } from "./seedHelpOperatorManual";
import { PRODUCT_KNOWLEDGE } from "./productKnowledge";
import { ACTION_DESCRIPTIONS, READ_ONLY_PATHS } from "./services/assistantActionCatalog";
import { appRouter } from "./routers";
import { forMembers, invalidatePoolCache } from "./services/prospectPool";
import { makeSourceNamer } from "../client/src/lib/sourceNames";
import { anonymizeVendorText, namesAVendor, vendorPattern } from "@shared/sourceNames";
import { describeEnrichmentError } from "@shared/enrichmentErrorLabel";
import { ARE_SOURCES } from "@shared/areSources";

const ROOT = join(__dirname, "..");
const VENDOR_WORD = /(?<![A-Za-z])(QuickEnrich|Quick Enrich|Apollo|WarmySender|Warmy Sender|LeadOcean|Lead Ocean)(?![A-Za-z])/;
const VENDORS_ANY_CASE = /apollo|quick[\s-]?enrich|warmy[\s-]?sender|lead[\s-]?ocean/i;

/** A file's code with its comments removed, and its allowed regions cut. */
function memberFacingCode(rel: string): string {
  let s = readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  // The own-key cards on ARE Settings, between their markers.
  s = s.replace(/\{\/\* own-key cards:[\s\S]*?\{\/\* end own-key cards \*\/\}/g, "");
  // The platform owner's section of the billing screen (users.role 'admin' only).
  if (rel.endsWith("SpendReport.tsx")) s = s.slice(0, s.indexOf("function SharedKeyCell("));
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(join(ROOT, d))) {
      const p = `${d}/${f}`;
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (/\.(tsx?|ts)$/.test(f)) out.push(p);
    }
  };
  walk("client/src");
  return out;
}

/** The cards where a workspace pastes its OWN key for a vendor: the vendor's name belongs there. */
const OWN_KEY_CARDS = new Set([
  "client/src/components/usip/settings/ApolloSourceCard.tsx",
  "client/src/components/usip/settings/QuickEnrichSourceCard.tsx",
  "client/src/components/usip/settings/WarmySenderSourceCard.tsx",
  "client/src/components/usip/settings/LeadOceanSourceCard.tsx",
  // Lending this workspace's own keys to another workspace of the same admin.
  "client/src/components/usip/settings/KeySharingCard.tsx",
]);

describe("guards: no member-facing string names a prospect source's vendor", () => {
  it("client screens, outside the own-key cards and the platform owner's section", () => {
    const hits: string[] = [];
    for (const rel of clientFiles()) {
      if (OWN_KEY_CARDS.has(rel)) continue;
      memberFacingCode(rel).split("\n").forEach((line, i) => {
        if (VENDOR_WORD.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits, "name the source through useSourceNames (\"Source N\") instead").toEqual([]);
  });

  it("the guard sees the shape it is for", () => {
    expect(VENDOR_WORD.test(`<span>Rows from Apollo are free</span>`)).toBe(true);
    expect(VENDOR_WORD.test(`<ApolloSourceCard />`)).toBe(false);
    expect(memberFacingCode("client/src/pages/usip/ARESettings.tsx")).not.toContain("ApolloSourceCard variant");
  });

  it("help articles, tours, the operator's manual, Elsie's digest and her action descriptions", () => {
    const texts: Array<[string, string]> = [
      ...ARTICLES.map((a) => [`article ${a.slug}`, `${a.title} ${a.summary} ${a.bodyMarkdown}`] as [string, string]),
      ...TOURS.flatMap((t) => t.steps.map((st) => [`tour ${t.name} / ${st.title}`, `${st.title} ${st.bodyMarkdown}`] as [string, string])),
      ...OPERATOR_ARTICLES.map((a) => [`manual ${a.slug}`, `${a.title} ${a.summary ?? ""} ${a.bodyMarkdown}`] as [string, string]),
      ["productKnowledge", PRODUCT_KNOWLEDGE],
      ...Object.entries(ACTION_DESCRIPTIONS).map(([k, v]) => [`action ${k}`, v] as [string, string]),
      ...Object.entries(READ_ONLY_PATHS).map(([k, v]) => [`read ${k}`, v] as [string, string]),
    ];
    const hits = texts.filter(([, t]) => VENDORS_ANY_CASE.test(t)).map(([k, t]) => `${k}: …${t.slice(Math.max(0, t.search(VENDORS_ANY_CASE) - 40), t.search(VENDORS_ANY_CASE) + 40)}…`);
    expect(hits).toEqual([]);
  });

  it("the shared labels a screen might fall back to name no vendor", () => {
    for (const s of ARE_SOURCES) expect(`${s.label} ${s.description}`, s.id).not.toMatch(VENDORS_ANY_CASE);
    expect(describeEnrichmentError("quickenrich: no_match")).toMatchObject({ label: "Not in the prospect database", detail: "prospect database: no_match" });
    expect(describeEnrichmentError("quickenrich hit failed Reoon verification (invalid)")?.label).not.toMatch(VENDORS_ANY_CASE);
  });
});

describe("the helper, at its call sites", () => {
  const POOL = 1, WS = 5;
  const rows = (t: string) => h.db.rowsOf(t) as any[];
  const caller = (role: "admin" | "user") => appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);

  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
    invalidatePoolCache();
    for (const id of [POOL, WS]) rows("workspaces").push({ id, name: `W${id}`, slug: `w${id}`, ownerUserId: 1, archivedAt: null, plan: "trial" });
    rows("workspace_settings").push({ workspaceId: POOL, quickenrichApiKeyEnc: encryptSecret("pool-qe") }, { workspaceId: WS });
    rows("platform_settings").push({ settingKey: "prospectPool", value: { workspaceId: POOL } });
    rows("prospect_pool_sources").push(
      { slug: "quickenrich", shared: true, monthlyCeiling: 9000, sourceNumber: 1, description: "B2B contact database" },
      { slug: "apollo", shared: false, monthlyCeiling: null, sourceNumber: 2, description: "People and companies" },
    );
  });

  it("the client namer: members read \"Source N\", the platform owner the vendor", () => {
    const sources = [{ slug: "quickenrich", number: 1, label: "Source 1", description: "B2B contact database" }];
    const member = makeSourceNamer({ platformOwner: false, sources });
    expect(member.label("quickenrich")).toBe("Source 1");
    expect(member.label("linkedin")).toBe("LinkedIn");
    expect(member.text("QuickEnrich returned 5 people")).toBe("Source 1 returned 5 people");
    // Before the names load, a prospect database is never its vendor.
    expect(makeSourceNamer(undefined).label("apollo")).toBe("Prospect source");
    expect(makeSourceNamer(undefined).text("Apollo's free search")).toBe("a prospect source's free search");
    const owner = makeSourceNamer({ platformOwner: true, sources: [{ ...sources[0], label: "QuickEnrich" }] });
    expect(owner.label("quickenrich")).toBe("QuickEnrich");
  });

  it("the describe router: a member reads Source N and no vendor site; the platform owner reads both", async () => {
    const asMember = await caller("user").prospectSources.describe();
    const qe = asMember.find((s) => s.slug === "quickenrich")!;
    expect(qe.displayName).toBe("Source 1");
    expect(qe.docsUrl).toBe("");
    expect(JSON.stringify(asMember.map((s) => [s.displayName, s.docsUrl, s.credential.validationError]))).not.toMatch(VENDORS_ANY_CASE);
    const asOwner = await caller("admin").prospectSources.describe();
    expect(asOwner.find((s) => s.slug === "quickenrich")!.displayName).toMatch(/QuickEnrich/);
    const names = await caller("user").prospectSources.names();
    expect(names.platformOwner).toBe(false);
    expect(names.sources.map((n) => n.label)).toEqual(expect.arrayContaining(["Source 1", "Source 2"]));
  });

  it("the sinks rewrite an adapter's own words before members read them", async () => {
    expect(await forMembers("QuickEnrich search failed: HTTP 422 from quickenrich")).toBe("Source 1 search failed: HTTP 422 from Source 1");
    expect(await forMembers("Apollo's free API search masks it")).toBe("Source 2's free API search masks it");
    // The engine's log sink, run.
    rows("are_campaigns").push({ id: 3, workspaceId: WS, name: "C", status: "active", targetProspectCount: 1, prospectSources: [], icpOverrides: {}, discoveryQueryState: null });
    const { runDiscovery } = await import("./areEngine");
    await runDiscovery({ id: 3, workspaceId: WS, name: "C", status: "active", targetProspectCount: 1, prospectSources: ["quickenrich"], icpOverrides: {}, discoveryQueryState: null } as never, 1).catch(() => 0);
    const logs = rows("are_engine_logs").map((r) => String(r.message)).join("\n");
    expect(logs).not.toMatch(VENDORS_ANY_CASE);
  });

  it("derives a pattern for a source added later from its name alone", () => {
    expect(namesAVendor("CluGTM found 3", [{ slug: "clugtm", displayName: "CluGTM" }])).toBe(true);
    expect(anonymizeVendorText("A-Leads refused the key", [{ slug: "aleads", displayName: "A-Leads", label: "Source 5" }])).toBe("Source 5 refused the key");
    expect(vendorPattern("hunter", "Hunter")).toBeNull();
    expect(anonymizeVendorText("Found email for Hunter Smith", [{ slug: "hunter", displayName: "Hunter", label: "Source 6" }])).toBe("Found email for Hunter Smith");
  });
});
