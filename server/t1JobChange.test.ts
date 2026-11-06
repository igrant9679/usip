/**
 * Job change alerts → Re-engage, T1 batch (2026-11-06): tracker items 8 and
 * 14 ("could not create the re-engagement task", "you couldn't re-engage")
 * and audit row P97 (the empty state's claim and its button).
 *
 * The cause: the feed lists every company_changed row, and a FIRST SIGHTING
 * (the first employer Velocity saw for someone, recorded with no previous
 * value) is one. Re-engage was offered on it, the task writer refused it as
 * an incomplete change, and the router turned every refusal but three into a
 * 500 reading "Could not create the re-engagement task."
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import { reengageBlocker } from "./services/linkedinEnrichment/jobChangeReengagement";
import { JobChangeAction, JobChangeEmptyState } from "../client/src/components/usip/JobChangeAlerts";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "rep@velocity.test", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}
function change(prospectId: number, oldValue: string | null, newValue: string | null, id = prospectId) {
  rows("prospect_linkedin_field_changes").push({
    id, workspaceId: WS, prospectId, enrichmentId: 1, fieldName: "current_company_name",
    changeType: "company_changed", oldValue, newValue, detectedAt: new Date(Date.now() - id * 1000), acknowledgedAt: null,
  });
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("workspace_settings").push({ workspaceId: WS, jobChangeAutopilotMode: "off", jobChangeAutopilotDailyCap: 25 });
  for (const id of [1, 2, 3, 4]) {
    rows("prospects").push({ id, workspaceId: WS, firstName: `P${id}`, lastName: "Doe", title: "VP", company: "NewCo", verificationStatus: id === 4 ? "rejected" : "pending" });
  }
});

describe("Re-engage says why it can't, instead of a server error (tracker 8, 14)", () => {
  it("a first sighting — no previous employer — is refused as not a move, with a 400", async () => {
    change(1, null, "NewCo");
    const e = await refusal(caller().linkedinEnrichment.reengage({ prospectId: 1 }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("first company Velocity has seen");
    expect(e.message).not.toContain("Could not create");
    expect(rows("tasks")).toEqual([]);
  });

  it("a life change in the company field is refused as not an employer", async () => {
    change(2, "OldCo", "Retired");
    const e = await refusal(caller().linkedinEnrichment.reengage({ prospectId: 2 }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("not an employer");
  });

  it("a rejected person is refused as rejected", async () => {
    change(4, "OldCo", "NewCo");
    const e = await refusal(caller().linkedinEnrichment.reengage({ prospectId: 4 }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("marked rejected");
  });

  it("a real move still makes the task", async () => {
    change(3, "OldCo", "NewCo");
    const r = await caller().linkedinEnrichment.reengage({ prospectId: 3 });
    expect(r).toMatchObject({ ok: true, taskStatus: "open" });
    expect(rows("tasks").map((t) => t.title)).toEqual(["Re-engage: P3 Doe moved to NewCo"]);
  });
});

describe("the feed offers Re-engage only where it will work (tracker 8, 14)", () => {
  it("marks each company change with the reason Re-engage would refuse it, or null", async () => {
    change(1, null, "NewCo");
    change(2, "OldCo", "Retired");
    change(3, "OldCo", "NewCo");
    const feed = await caller().linkedinEnrichment.jobChanges({ limit: 60 });
    const byProspect = Object.fromEntries(feed.map((r: any) => [r.prospectId, r.reengageBlocked]));
    expect(byProspect).toEqual({ 1: "incomplete_company_change", 2: "new_company_not_an_employer", 3: null });
  });

  it("is the same rule the task writer applies", () => {
    expect(reengageBlocker(null, "NewCo")).toBe("incomplete_company_change");
    expect(reengageBlocker("  ", "NewCo")).toBe("incomplete_company_change");
    expect(reengageBlocker("OldCo", "Retired.")).toBe("new_company_not_an_employer");
    expect(reengageBlocker("OldCo", "Retired Brands Inc")).toBeNull();
  });

  const action = (jc: any) => renderToStaticMarkup(createElement(JobChangeAction, { jc, accent: "#123456", pending: false, onReengage: () => {} }));

  it("a first sighting shows what it is, with no Re-engage button", () => {
    const html = action({ prospectId: 1, changeType: "company_changed", hasReengagementTask: false, reengageBlocked: "incomplete_company_change" });
    expect(html).toContain("First seen, not a move");
    expect(html).not.toContain("Re-engage");
  });

  it("a real move keeps the button, and a queued one says Queued", () => {
    expect(action({ prospectId: 3, changeType: "company_changed", hasReengagementTask: false, reengageBlocked: null })).toContain("Re-engage");
    expect(action({ prospectId: 3, changeType: "company_changed", hasReengagementTask: true, reengageBlocked: null })).toContain("Queued");
    expect(action({ prospectId: 3, changeType: "title_changed", hasReengagementTask: false, reengageBlocked: null })).toBe("");
  });

  it("the page renders the row's action through it, and doesn't count first sightings on the tab", () => {
    const src = read("client/src/pages/usip/DataEnrichment.tsx");
    expect(src).toContain("<JobChangeAction jc={jc}");
    expect(src).toContain("!j.hasReengagementTask && !j.reengageBlocked");
  });
});

describe("the empty state says what is checked, and the button goes to LinkedIn enrichment (P97)", () => {
  it("no longer claims daily monitoring of every enriched prospect", () => {
    const html = renderToStaticMarkup(createElement(JobChangeEmptyState, { accent: "#123456", onEnrich: () => {} }));
    expect(html).toContain("enriched through LinkedIn");
    expect(html).toContain("up to 250 a day");
    expect(html).not.toContain("monitors your enriched prospects");
    expect(html).toContain("Enrich people from LinkedIn");
  });

  it("the page's button opens LinkedIn enrichment, not prospect discovery", () => {
    const src = read("client/src/pages/usip/DataEnrichment.tsx");
    expect(src).toContain('<JobChangeEmptyState accent={accent} onEnrich={() => setLocation("/v2/data-enrichment/linkedin")} />');
    expect(src).not.toContain("Velocity monitors your enriched prospects");
  });
});
