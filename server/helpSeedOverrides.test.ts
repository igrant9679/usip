/**
 * The boot seed leaves alone what an admin changed in Help (audit 2026-10-20, G21).
 *
 * seedHelpContent re-applies its articles and tours on every deploy, which is
 * how shipped help updates reach workspaces that already have them. It used to
 * revert every admin edit 20 s after each deploy and re-create whatever an
 * admin had deleted. Now an admin write records the key in help_seed_overrides
 * and both seeds skip it, while still updating what nobody touched.
 *
 * The real procedures and the real seeds run against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, unreadable: false };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/helpSeedOverrides", async (a) => {
  const real = await a<typeof import("./services/helpSeedOverrides")>();
  return { ...real, helpOverrideKeys: (...args: Parameters<typeof real.helpOverrideKeys>) => (h.unreadable ? Promise.resolve(null) : real.helpOverrideKeys(...args)) };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { ARTICLES, TOURS, seedHelpContent } from "./seedHelpContent";
import { seedToursForAllWorkspaces } from "./seedTours";

// Each test seeds the whole help corpus into the SQL fake two or three times
// (about 1.5 s each here), which the default 5 s can't hold on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const article = (slug: string) => rows("help_articles").find((a) => a.workspaceId === WS && a.slug === slug);
const tour = (name: string) => rows("tours").find((t) => t.workspaceId === WS && t.name === name);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const seed = () => seedHelpContent(h.db, WS);

const [A, B] = [ARTICLES[0]!, ARTICLES[1]!];
const T1 = TOURS[0]!;

beforeEach(async () => {
  h.unreadable = false;
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  await seed();
});

describe("articles", () => {
  it("an admin's edit survives the next deploy's seed", async () => {
    await caller().helpCenter.updateArticle({ id: article(A.slug).id, title: "Our own title", status: "draft" });
    await seed();
    expect(article(A.slug)).toMatchObject({ title: "Our own title", status: "draft" });
  });

  it("an edit through upsertArticle counts too", async () => {
    const a = article(A.slug);
    await caller().helpCenter.upsertArticle({ id: a.id, slug: a.slug, title: "Rewritten", status: "published" });
    await seed();
    expect(article(A.slug).title).toBe("Rewritten");
  });

  it("an article the admin deleted stays deleted", async () => {
    await caller().helpCenter.deleteArticle({ id: article(A.slug).id });
    await seed();
    expect(article(A.slug)).toBeUndefined();
  });

  it("a renamed slug does not bring the original back beside it", async () => {
    await caller().helpCenter.updateArticle({ id: article(A.slug).id, slug: "our-slug" });
    await seed();
    expect(article(A.slug)).toBeUndefined();
    expect(article("our-slug")).toBeDefined();
  });

  it("an article nobody touched still gets the shipped update", async () => {
    // Stand in for an older seed version still in the row.
    article(B.slug).title = "Old shipped title";
    await caller().helpCenter.updateArticle({ id: article(A.slug).id, title: "Ours" });
    await seed();
    expect(article(B.slug).title).toBe(B.title);
    expect(article(A.slug).title).toBe("Ours");
  });

  it("if the record of changes can't be read, the seed adds what is missing and overwrites nothing", async () => {
    article(B.slug).title = "Possibly an admin's";
    rows("help_articles").splice(rows("help_articles").indexOf(article(A.slug)), 1);
    h.unreadable = true;
    await seed();
    h.unreadable = false;
    expect(article(A.slug)).toBeDefined();
    expect(article(B.slug).title).toBe("Possibly an admin's");
  });
});

describe("tours", () => {
  it("an admin's edit to a seeded tour, steps included, survives the seed", async () => {
    const id = tour(T1.name).id;
    await caller().tours.update({ id, description: "Ours", steps: [{ sortOrder: 0, title: "Our only step" }] });
    await seed();
    expect(tour(T1.name).description).toBe("Ours");
    expect(rows("tour_steps").filter((s) => s.tourId === id).map((s) => s.title)).toEqual(["Our only step"]);
  });

  it("a seeded tour the admin deleted stays deleted", async () => {
    await caller().tours.delete({ id: tour(T1.name).id });
    await seed();
    expect(tour(T1.name)).toBeUndefined();
  });

  it("the legacy demo-tour seed obeys the same record", async () => {
    await seedToursForAllWorkspaces();
    const demo = rows("tours").find((t) => t.workspaceId === WS && !TOURS.some((s) => s.name === t.name));
    expect(demo).toBeDefined();
    await caller().tours.update({ id: demo.id, description: "Ours" });
    await seedToursForAllWorkspaces();
    expect(rows("tours").find((t) => t.id === demo.id).description).toBe("Ours");
    await caller().tours.delete({ id: demo.id });
    await seedToursForAllWorkspaces();
    expect(rows("tours").find((t) => t.workspaceId === WS && t.name === demo.name)).toBeUndefined();
  });
});
