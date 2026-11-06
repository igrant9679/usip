/**
 * Smaller faults on a campaign's page (audit 2026-10-20, batch E2).
 *
 *   A53 an edited step body is HTML, rendered sanitised, not shown as markup
 *   A54 a CSV import sends every row, in chunks, and reports every count
 *   A55 "From a list" offers People lists, the only kind it can add from
 *   A56 the discovery launcher reads targeting through the shared reader and
 *       says which values its one run searches
 *   A74 the generate timer counts seconds, rejections show their title, and
 *       the Rejections tab does not say "none" while loading
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { IMPORT_CHUNK, addImportTotals, emptyImportTotals, importSummary } from "../client/src/pages/usip/areImportModel";
import { targetingFromOverrides } from "@shared/campaignTargeting";

const WS = 2;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "Counties", status: "active" }, { id: 8, workspaceId: WS, name: "Cities", status: "active" });
});

describe("an edited step body renders as HTML (A53)", () => {
  it("the dossier sanitises and renders an HTML body, and keeps plain text as text", () => {
    const dossier = read("client/src/components/usip/are/IntelligenceDossier.tsx");
    const block = dossier.slice(dossier.indexOf("{isHtmlBody(step.body)"), dossier.indexOf("{isHtmlBody(step.body)") + 500);
    expect(block).toContain("dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(step.body) }}");
    expect(block).toContain('whitespace-pre-wrap">{step.body}</p>}');
  });
});

describe("CSV import (A54)", () => {
  it("every chunk's counts add up, and the summary names each kind of skip", () => {
    const t = emptyImportTotals();
    addImportTotals(t, { imported: 1990, withEmail: 1500, skippedDuplicates: 5, skippedEmpty: 3, skippedOtherCampaign: 2, failed: 0 });
    addImportTotals(t, { imported: 400, withEmail: 10, skippedOtherCampaign: 1, failed: 2 });
    expect(t).toEqual({ imported: 2390, withEmail: 1510, skippedDuplicates: 5, skippedEmpty: 3, skippedOtherCampaign: 3, failed: 2 });
    expect(importSummary(t)).toBe(
      "Imported 2390 prospects (1510 with email) · 5 duplicates already in this campaign · 3 people already in another campaign · 3 rows with no name or email · 2 rows the database refused",
    );
  });

  it("the page sends the whole file in chunks the server accepts, not the first 2,000", () => {
    expect(IMPORT_CHUNK).toBe(2000);
    expect(detail).not.toContain("rows: importParsed.slice(0, 2000)");
    expect(detail).toContain("for (let i = 0; i < importParsed.length; i += IMPORT_CHUNK) {");
    expect(detail).toContain("addImportTotals(totals, await importRowsMut.mutateAsync({ campaignId, rows: importParsed.slice(i, i + IMPORT_CHUNK) }));");
    expect(detail).toContain("toast.success(importSummary(totals)");
    expect(detail).toContain("disabled={importParsed.length === 0 || importing}");
  });

  it("the server reports skips by kind, and rows it could not insert", async () => {
    rows("prospect_queue").push({ id: 1, workspaceId: WS, campaignId: 8, email: "taken@example.com", sequenceStatus: "enrolled" });
    const r = await caller().are.prospects.importRows({
      campaignId: 7,
      rows: [{ firstName: "Ann", email: "ann@example.com" }, { email: "taken@example.com" }, { title: "No name" }],
    });
    expect(r).toMatchObject({ imported: 1, skippedOtherCampaign: 1, skippedEmpty: 1, skippedDuplicates: 0, failed: 0 });
  });
});

describe("From a list offers People lists (A55)", () => {
  it("Companies lists are left out and said to be, and members are not re-filtered", () => {
    const dialog = read("client/src/components/usip/are/AddExistingProspectsDialog.tsx");
    expect(dialog).toContain('lists={((lists.data ?? []) as any[]).filter((l) => (l.entityType ?? "people") === "people")}');
    expect(dialog).toContain("they hold companies, not people.");
    expect(dialog).not.toContain('.filter((m) => m.recordType === "prospect" && m.record)');
  });
});

describe("the discovery launcher (A56)", () => {
  it("reads weighted targeting as labels, through the shared reader", () => {
    const t = targetingFromOverrides({
      targetTitles: [{ title: "County Administrator", weight: 40 }, "IT Director"],
      targetIndustries: [{ industry: "Government", weight: 60 }],
      targetGeographies: [{ country: "United States", region: "Virginia", weight: 50 }],
    });
    expect(t.titles).toEqual(["County Administrator", "IT Director"]);
    expect(t.industries).toEqual(["Government"]);
    expect(t.places.length).toBe(1);
    expect(typeof t.places[0]).toBe("string");
  });

  it("the launcher uses it, and says which values its one run searches", () => {
    const launcher = detail.slice(detail.indexOf("function CampaignDiscoveryLauncher("), detail.indexOf("function LogsTab("));
    expect(launcher).toContain("const t = targetingFromOverrides(campaign?.icpOverrides);");
    expect(launcher).not.toContain("o.targetTitles ?? []");
    expect(launcher).toContain("This run searches:");
    expect(launcher).toContain("the campaign's own discovery uses all of them.");
  });
});

describe("campaign page details (A74)", () => {
  it("the generate timer counts from its own start, once a second of real time", () => {
    expect(detail).not.toContain("generatingStartedAt ? Math.round((Date.now() - generatingStartedAt) / 1000) : prev + 1");
    expect(detail).toContain("const id = setInterval(() => setGenElapsed(Math.round((Date.now() - started) / 1000)), 500);");
  });

  it("a rejection shows its title, and the tab does not say none while loading or failed", () => {
    expect(detail).not.toContain("item.contactTitle");
    expect(detail).toContain("{item.title && (");
    const tab = detail.slice(detail.indexOf('<TabsContent value="rejections"'), detail.indexOf('<TabsContent value="rejections"') + 1400);
    expect(tab).toContain('title="No rejections yet"');
    // Everything before the empty state: loading and the error come first.
    const before = tab.slice(0, tab.indexOf('title="No rejections yet"'));
    expect(before).toContain("{rejectionQ.isLoading ? (");
    expect(before).toContain('<QueryError compact what="the rejections"');
  });
});
