/**
 * The "Sequence #id" chip on the Emails page (audit 2026-10-20, U29) was a
 * plain span while the campaign, contact and lead chips beside it were links.
 * It now links to the sequence and shows its name when known: the drawer's
 * read carries the sequence name for a sent email and for a draft, and a sent
 * sequence email's feed row (which logs no label of its own) is labelled with
 * its sequence's name.
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

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("sequences").push(
    { id: 7, workspaceId: WS, name: "Q4 follow-up", status: "active" },
    // Another workspace's sequence with the same id must never lend its name.
    { id: 8, workspaceId: OTHER, name: "Not yours", status: "active" },
  );
  rows("email_log").push(
    { id: 1, workspaceId: WS, source: "sequence", sourceLabel: null, sequenceId: 7, draftId: null, executionQueueId: null, campaignId: null, status: "sent", subject: "Hi", toEmail: "x@example.com", sentAt: new Date("2026-11-01T12:00:00Z") },
    { id: 2, workspaceId: WS, source: "sequence", sourceLabel: null, sequenceId: 8, draftId: null, executionQueueId: null, campaignId: null, status: "sent", subject: "Hi", toEmail: "y@example.com", sentAt: new Date("2026-11-01T11:00:00Z") },
  );
  rows("email_drafts").push(
    { id: 30, workspaceId: WS, sequenceId: 7, subject: "Draft", body: "b", status: "pending_review", toEmail: "z@example.com", createdAt: new Date("2026-11-01T10:00:00Z") },
  );
});

describe("the drawer's read names the sequence (U29)", () => {
  it("a sent sequence email carries its sequence's name", async () => {
    const d = await caller().emailActivity.get({ kind: "log", id: 1 });
    expect(d.sequenceName).toBe("Q4 follow-up");
  });

  it("only this workspace's sequence is named", async () => {
    const d = await caller().emailActivity.get({ kind: "log", id: 2 });
    expect(d.sequenceName).toBeNull();
  });

  it("a draft carries its sequence's name", async () => {
    const d = await caller().emailActivity.get({ kind: "draft", id: 30 });
    expect(d.sequenceName).toBe("Q4 follow-up");
  });

  it("the feed labels a sent sequence email with its sequence's name", async () => {
    const res = await caller().emailActivity.list({ source: "sequence", status: "sent" });
    const byId = new Map(res.rows.map((r) => [r.key, r]));
    expect(byId.get("log:1")?.sourceLabel).toBe("Q4 follow-up");
    expect(byId.get("log:2")?.sourceLabel).toBeNull();
  });
});

describe("the chip is a link to the sequence (U29)", () => {
  it("links to the sequence editor, by name when known", () => {
    const src = read("client/src/pages/usip/EmailsV2.tsx");
    const start = src.indexOf("{row.sequenceId ? (");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf(") : null}", start));
    expect(block).toContain("<Link href={`/v2/sequences/${row.sequenceId}`}>");
    expect(block).toContain("d?.sequenceName");
    expect(block).toContain("`Sequence #${row.sequenceId}`");
  });
});
