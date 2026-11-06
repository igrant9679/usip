/**
 * The Tour Builder saves what it shows (audit 2026-10-20, G20).
 *
 *   - an edit keeps each step's id, so saving updates the steps instead of
 *     inserting a second copy of every one;
 *   - a step removed in the builder is removed from the tour;
 *   - the Trigger Page Key reaches the server as `pageKey`, and can be cleared;
 *   - status offers only draft and published, the two the table holds.
 *
 * The round trip runs the builder's own mapping (@/lib/tourDraft) against the
 * real procedures and the SQL-evaluating fake.
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
import { stepDraftsFrom, tourFormFrom, tourSavePayload, TOUR_STATUSES } from "../client/src/lib/tourDraft";

const WS = 2, FOREIGN = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("tours").push(
    { id: 1, workspaceId: WS, name: "Ours", description: null, type: "feature", status: "published", estimatedMinutes: 3, pageKey: "people" },
    { id: 2, workspaceId: FOREIGN, name: "Theirs", type: "feature", status: "draft", estimatedMinutes: 3, pageKey: null },
  );
  rows("tour_steps").push(
    { id: 10, tourId: 1, sortOrder: 0, title: "One", visualTreatment: "spotlight", advanceCondition: "next_button", skipAllowed: true, backAllowed: true },
    { id: 11, tourId: 1, sortOrder: 1, title: "Two", visualTreatment: "spotlight", advanceCondition: "next_button", skipAllowed: true, backAllowed: true },
    { id: 20, tourId: 2, sortOrder: 0, title: "Their step" },
  );
});

/** Open the tour in the builder, let `edit` change the draft, and save it. */
async function editAndSave(edit: (d: { form: ReturnType<typeof tourFormFrom>; steps: ReturnType<typeof stepDraftsFrom> }) => void = () => {}) {
  const tour = await caller().tours.get({ id: 1 });
  const draft = { form: tourFormFrom(tour), steps: stepDraftsFrom(tour) };
  edit(draft);
  await caller().tours.update({ id: 1, ...tourSavePayload(draft.form, draft.steps) } as any);
  return rows("tour_steps").filter((s) => s.tourId === 1).sort((a, b) => a.sortOrder - b.sortOrder);
}

describe("saving an edited tour", () => {
  it("saving without a change keeps the same two steps, not four", async () => {
    const steps = await editAndSave();
    expect(steps.map((s) => [s.id, s.title])).toEqual([[10, "One"], [11, "Two"]]);
  });

  it("an edited step is updated in place", async () => {
    const steps = await editAndSave((d) => { d.steps[1].title = "Two, edited"; });
    expect(steps.map((s) => [s.id, s.title])).toEqual([[10, "One"], [11, "Two, edited"]]);
  });

  it("a step removed in the builder is gone; a new one is added", async () => {
    const steps = await editAndSave((d) => {
      d.steps.splice(0, 1);
      const { id: _saved, ...unsaved } = d.steps[0];
      d.steps.push({ ...unsaved, title: "Three" });
    });
    expect(steps.map((s) => s.title)).toEqual(["Two", "Three"]);
    expect(steps[0].id).toBe(11);
  });

  it("another workspace's steps are never touched", async () => {
    await editAndSave((d) => { d.steps.push({ ...d.steps[0], id: 20, title: "Hijack" }); });
    expect(rows("tour_steps").find((s) => s.id === 20)).toMatchObject({ tourId: 2, title: "Their step" });
  });
});

describe("the tour's own fields", () => {
  it("the Trigger Page Key is saved, and clearing it clears it", async () => {
    await editAndSave((d) => { d.form.pageKey = "sequences"; });
    expect(rows("tours").find((t) => t.id === 1).pageKey).toBe("sequences");
    await editAndSave((d) => { d.form.pageKey = "  "; });
    expect(rows("tours").find((t) => t.id === 1).pageKey).toBeNull();
  });

  it("the form opens on the tour's saved page key and status", async () => {
    const form = tourFormFrom(await caller().tours.get({ id: 1 }));
    expect(form).toMatchObject({ pageKey: "people", status: "published" });
    expect(tourSavePayload(form, [])).not.toHaveProperty("triggerPageKey");
  });

  it("status offers only what the table holds", () => {
    expect([...TOUR_STATUSES]).toEqual(["draft", "published"]);
    const page = read("client/src/pages/usip/TourBuilder.tsx");
    expect(page).not.toContain('value="archived"');
    expect(page).toContain("onSave(tourSavePayload(form, steps))");
    expect(page).not.toContain("triggerPageKey");
  });
});
