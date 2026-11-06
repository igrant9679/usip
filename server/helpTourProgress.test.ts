/**
 * Help and tours record what they say they do (audit 2026-10-20, G59; G65, G71).
 *
 *   G59 the Admin tab asked for the default status (published) and the first
 *       50, so a draft never showed there; and the client never called
 *       startTour, so advanceStep and completeTour updated a row that did not
 *       exist and tour progress was never recorded.
 *   G65 the step tooltip was a fixed 340 px with a left clamp that went
 *       negative on a 320 px phone.
 *   G71 Escape did not leave a tour.
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
vi.mock("@/lib/trpc", () => ({ trpc: {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { tourTooltipBox } from "../client/src/components/usip/TourEngine";

const WS = 2, ADMIN = 1, REP = 3, FOREIGN = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ADMIN) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: "U", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ADMIN, name: "Admin" }, { id: REP, name: "Rep" });
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: ADMIN, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: WS, userId: REP, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
  rows("help_articles").push(
    { id: 1, workspaceId: WS, slug: "live", title: "Live", status: "published", viewCount: 0 },
    { id: 2, workspaceId: WS, slug: "wip", title: "Work in progress", status: "draft", viewCount: 0 },
    { id: 3, workspaceId: WS, slug: "old", title: "Old", status: "archived", viewCount: 0 },
  );
  rows("tours").push(
    { id: 5, workspaceId: WS, name: "Tour", type: "feature", status: "published", estimatedMinutes: 3 },
    { id: 6, workspaceId: FOREIGN, name: "Theirs", type: "feature", status: "published", estimatedMinutes: 3 },
  );
});

describe("the Help admin list (G59)", () => {
  it("an admin asking for every status sees drafts and archived articles", async () => {
    const list = await caller(ADMIN).helpCenter.listArticles({ status: "all", limit: 500 });
    expect(list.map((a: any) => a.slug).sort()).toEqual(["live", "old", "wip"]);
  });

  it("anyone else gets published articles, whatever they ask for", async () => {
    const all = await caller(REP).helpCenter.listArticles({ status: "all" });
    const drafts = await caller(REP).helpCenter.listArticles({ status: "draft" });
    expect(all.map((a: any) => a.slug)).toEqual(["live"]);
    expect(drafts.map((a: any) => a.slug)).toEqual(["live"]);
  });

  it("the Admin tab asks for every status and every article", () => {
    const s = read("client/src/pages/usip/HelpCenter.tsx");
    const admin = s.slice(s.indexOf("function AdminTab()"));
    expect(admin).toContain('trpc.helpCenter.listArticles.useQuery({ status: "all", limit: 500 })');
  });
});

describe("tour progress is recorded (G59)", () => {
  const progress = () => rows("user_tour_progress").filter((p) => p.userId === REP && p.tourId === 5);

  it("start, advance and complete leave one row that says completed", async () => {
    await caller(REP).tours.startTour({ tourId: 5 });
    await caller(REP).tours.advanceStep({ tourId: 5, stepIndex: 2 });
    expect(progress()).toMatchObject([{ status: "in_progress", currentStep: 2 }]);
    await caller(REP).tours.completeTour({ tourId: 5 });
    expect(progress()).toMatchObject([{ status: "completed" }]);
  });

  it("advance and complete still record when start never landed", async () => {
    await caller(REP).tours.advanceStep({ tourId: 5, stepIndex: 1 });
    expect(progress()).toMatchObject([{ status: "in_progress", currentStep: 1, workspaceId: WS }]);
    rows("user_tour_progress").length = 0;
    await caller(REP).tours.completeTour({ tourId: 5 });
    expect(progress()).toMatchObject([{ status: "completed", workspaceId: WS }]);
  });

  it("another workspace's tour can't be recorded against", async () => {
    await expect(caller(REP).tours.advanceStep({ tourId: 6, stepIndex: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("user_tour_progress")).toHaveLength(0);
  });

  it("the tour engine starts the row, and Escape leaves the tour", () => {
    const s = read("client/src/components/usip/TourEngine.tsx");
    const start = s.slice(s.indexOf("const startTour = useCallback("), s.indexOf("const endTour = useCallback("));
    expect(start).toContain("startMut.mutate({ tourId: tour.id });");
    expect(s).toContain('if (e.key === "Escape") skipTour();');
  });
});

describe("the tour tooltip fits a phone (G65)", () => {
  it("on a 320 px screen it is 288 px wide and starts at the gutter", () => {
    const box = tourTooltipBox({ top: 100, bottom: 140, left: 200 }, 320, 640);
    expect(box.width).toBe(288);
    expect(box.left).toBe(16);
  });

  it("on a wide screen it keeps 340 px and sits under its target", () => {
    expect(tourTooltipBox({ top: 100, bottom: 140, left: 200 }, 1280, 800)).toEqual({ width: 340, top: 156, left: 200 });
  });

  it("near the right edge it is pulled in; near the bottom it goes above", () => {
    expect(tourTooltipBox({ top: 700, bottom: 740, left: 1200 }, 1280, 800)).toEqual({ width: 340, top: 484, left: 924 });
  });
});
