/**
 * A "stuck drafts" health card (audit 2026-10-20, F23): approved but unsent,
 * failed sends, drafts auto-send held for their sender, and drafts held by a
 * paused or ended enrolment were each visible only by filtering the Emails
 * page for them. One card counts all four, each linking to the Emails page
 * filtered to exactly those rows.
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
import { EMAIL_STATUS_GROUPS, feedSourceApplies } from "@shared/emailActivity";

const WS = 2;
const OTHER = 4;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

let nextId = 1;
function draft(over: Record<string, unknown>) {
  rows("email_drafts").push({
    id: nextId++, workspaceId: WS, subject: "s", body: "b", status: "pending_review", sequenceId: null, enrollmentId: null,
    sendError: null, createdAt: new Date("2026-11-01T00:00:00Z"), ...over,
  });
}

beforeEach(() => {
  nextId = 1;
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("sequences").push(
    { id: 1, workspaceId: WS, status: "active" },
    { id: 2, workspaceId: WS, status: "paused" },
  );
  rows("enrollments").push(
    { id: 10, workspaceId: WS, sequenceId: 1, status: "active" },
    { id: 11, workspaceId: WS, sequenceId: 1, status: "paused" },
    { id: 12, workspaceId: WS, sequenceId: 1, status: "exited" },
  );
  draft({ status: "approved", createdAt: new Date("2026-10-20T00:00:00Z") });
  draft({ status: "approved", sequenceId: 1, enrollmentId: 10 });
  draft({ status: "failed", sequenceId: 1, enrollmentId: 10 });
  draft({ status: "failed" });
  draft({ status: "pending_review", sequenceId: 1, enrollmentId: 10, sendError: "Not sent automatically: Rep has no mailbox of their own connected." });
  draft({ status: "pending_review", sequenceId: 1, enrollmentId: 11 }); // paused enrolment
  draft({ status: "approved", sequenceId: 1, enrollmentId: 12 }); // ended enrolment (also approved)
  draft({ status: "pending_review", sequenceId: 2, enrollmentId: null }); // paused sequence
  draft({ status: "pending_review", sequenceId: 1, enrollmentId: 10 }); // fine: on its way
  draft({ status: "sent", sequenceId: 1, enrollmentId: 11 }); // sent: not stuck
  draft({ status: "approved", workspaceId: OTHER }); // another workspace
  draft({ status: "failed", workspaceId: OTHER });
});

describe("the stuck-drafts card counts what will not go by itself (F23)", () => {
  it("approved and unsent, failed, held for the sender, and held by a pause — in this workspace only", async () => {
    const d = await caller().emailActivity.stuckDrafts();
    expect(d.approvedUnsent).toMatchObject({ count: 3, href: "/v2/emails?status=approved" });
    expect(new Date(d.approvedUnsent.oldestAt!).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(d.failedSends).toMatchObject({ count: 2, sequenceCount: 1, href: "/v2/emails?status=failed" });
    expect(d.autoSendHeld).toMatchObject({ count: 1, href: "/v2/emails?status=awaiting&source=sequence" });
    expect(d.heldByPause).toMatchObject({ count: 3, href: "/v2/emails?status=held" });
  });

  it("is all zeros when nothing is stuck", async () => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    const d = await caller().emailActivity.stuckDrafts();
    expect([d.approvedUnsent.count, d.failedSends.count, d.autoSendHeld.count, d.heldByPause.count]).toEqual([0, 0, 0, 0]);
  });
});

describe("each line opens the Emails page filtered to those drafts (F23)", () => {
  it("the feed knows the two new filters, and only drafts can match them", () => {
    expect(EMAIL_STATUS_GROUPS.approved).toEqual(["approved"]);
    for (const status of ["approved", "held"]) {
      expect(feedSourceApplies({ direction: "all", source: "all", status }, "draft")).toBe(true);
      for (const kind of ["log", "queued", "inbound"] as const) expect(feedSourceApplies({ direction: "all", source: "all", status }, kind)).toBe(false);
    }
  });

  it("the list and its chips filter with the same predicates the card counts with", () => {
    const src = read("server/routers/emailActivity.ts");
    const list = src.slice(src.indexOf("/* ── 2. email_drafts not yet sent"), src.indexOf("return rows.map((r): EmailFeedRow => ({", src.indexOf("/* ── 2. email_drafts not yet sent")));
    expect(list).toContain('if (input.status === "approved") conds.push(eq(emailDrafts.status, "approved"));');
    expect(list).toContain("conds.push(heldDraft()!);");
    expect(list).toContain(".leftJoin(enrollments, and(eq(enrollments.id, emailDrafts.enrollmentId), eq(enrollments.workspaceId, emailDrafts.workspaceId)))");
    const chips = src.slice(src.indexOf('} else if (stFilter === "approved" || stFilter === "held") {'), src.indexOf('} else if (stFilter === "sent"'));
    expect(chips).toContain('stFilter === "held" ? heldDraft() : undefined');
    const card = src.slice(src.indexOf("stuckDrafts: workspaceProcedure"), src.indexOf("stats: workspaceProcedure"));
    expect(card).toContain("heldDraft()");
  });

  it("the Emails page offers them and Data Health shows the card", () => {
    const emails = read("client/src/pages/usip/EmailsV2.tsx");
    expect(emails).toContain('{ value: "approved", label: "Approved, not sent" }');
    expect(emails).toContain('{ value: "held", label: "Held (paused or ended)" }');
    expect(emails).toContain('const [status, setStatus] = useState(initial.get("status") || "all");');
    const health = read("client/src/pages/usip/DataHealth.tsx");
    expect(health).toContain("<StuckDraftsCard />");
    const card = read("client/src/components/usip/StuckDraftsCard.tsx");
    expect(card).toContain("trpc.emailActivity.stuckDrafts.useQuery");
    expect(card).toContain("<Link href={l.href}");
  });
});
