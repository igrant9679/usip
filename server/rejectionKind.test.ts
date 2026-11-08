/**
 * Who or what rejected each campaign prospect (audit 2026-10-20, F19).
 *
 * prospect_queue had a free-text reason and a person-or-engine split, so a
 * re-score or a restore could not act on "only the score rejections" or "only
 * the duplicates" without matching text. Every rejecting path now writes a
 * kind; the Rejections tab counts, shows and filters by it; Re-evaluate All
 * re-scores only `screen`; migration 0331 backfilled old rows from the reason
 * only where it is unambiguous.
 *
 * Executed against the SQL-evaluating fake; the engine's raw SQL writers and
 * the screen are pinned by source, and a scan holds every writer to it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => { throw new Error("no AI in tests"); } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { REJECTION_KINDS, REJECTION_REASON_PATTERNS, rejectionKindFromReason } from "@shared/rejectionKind";
import { isScoreRejection } from "./routers/are/prospects";

const WS = 2, ME = 20;
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "me@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const q = (id: number, over: Record<string, unknown>) => ({
  id, workspaceId: WS, campaignId: 5, firstName: "P", lastName: String(id), companyName: "Co", title: "CFO", email: `p${id}@example.com`,
  sequenceStatus: "skipped", rejectedAt: new Date(Date.UTC(2026, 9, 1, 0, id)), rejectedByUserId: null, rejectionReason: null, rejectionKind: null, ...over,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "manager" }, wsId: () => WS });
  rows("are_campaigns").push({ id: 5, workspaceId: WS, name: "C", status: "active", autoApproveThreshold: 60, icpOverrides: { targetTitles: ["CFO"] } });
});

describe("a person's reject and skip are kind 'person'; restore clears the kind", () => {
  it("reject, skip, restore", async () => {
    rows("prospect_queue").push(q(1, { sequenceStatus: "pending" }), q(2, { sequenceStatus: "pending" }));
    await caller().are.prospects.reject({ prospectId: 1, reason: "Wrong fit" });
    await caller().are.prospects.skip({ prospectId: 2 });
    expect(rows("prospect_queue").map((r) => [r.id, r.sequenceStatus, r.rejectionKind])).toEqual([[1, "skipped", "person"], [2, "skipped", "person"]]);
    await caller().are.prospects.restore({ prospectId: 1 });
    expect(rows("prospect_queue")[0]).toMatchObject({ sequenceStatus: "pending", rejectionKind: null });
  });
});

describe("the Rejections tab counts and filters by kind", () => {
  beforeEach(() => {
    rows("prospect_queue").push(
      q(1, { rejectionKind: "screen", rejectionReason: "Auto-screened: ICP match 20/100 below floor 30" }),
      q(2, { rejectionKind: "screen", rejectionReason: "Auto-screened: ICP match 25/100 below floor 30" }),
      q(3, { rejectionKind: "dedupe", rejectionReason: "Already in a sequence as prospect #9 (same email or LinkedIn profile) — not enrolled twice" }),
      q(4, { rejectionKind: "person", rejectedByUserId: ME, rejectionReason: "Wrong fit" }),
      q(5, { rejectionKind: null, rejectionReason: "something old" }),
      q(6, { rejectionKind: "other", rejectionReason: "older still" }),
      q(7, { sequenceStatus: "pending", rejectionKind: "screen" }),
    );
  });

  it("byKind counts every rejected row once, no kind reading as Other", async () => {
    const r = await caller().are.prospects.getRejectionStats({ campaignId: 5 });
    expect(r.byKind).toEqual([
      { kind: "other", label: "Other", count: 2 },
      { kind: "screen", label: "ICP score screen", count: 2 },
      { kind: "dedupe", label: "Duplicate", count: 1 },
      { kind: "person", label: "Rejected by a person", count: 1 },
    ]);
    expect(r.items.find((i: any) => i.id === 3)?.rejectionKind).toBe("dedupe");
  });

  it("a kind filter returns only that kind; Other includes rows with none", async () => {
    const screen = await caller().are.prospects.getRejectionStats({ campaignId: 5, kind: "screen" });
    expect(screen.items.map((i: any) => i.id).sort()).toEqual([1, 2]);
    expect(screen.itemsTotal).toBe(2);
    const other = await caller().are.prospects.getRejectionStats({ campaignId: 5, kind: "other" });
    expect(other.items.map((i: any) => i.id).sort()).toEqual([5, 6]);
  });

  it("the export names who or what rejected each row", async () => {
    const r = await caller().are.prospects.exportRejections({ campaignId: 5 });
    expect(r.csv.split("\n")[0]).toContain("\"Rejected By\"".replace(/"/g, "") );
    expect(r.csv).toContain("Duplicate");
    expect(r.csv).toContain("ICP score screen");
  });
});

describe("Re-evaluate All re-scores only the score screen's rejections", () => {
  it("queues the screen rows and the legacy unkinded score rows, never a duplicate or a person's", async () => {
    rows("prospect_queue").push(
      q(1, { rejectionKind: "screen", rejectionReason: "Auto-screened: ICP match 20/100 below floor 30" }),
      // A suppression whose reason someone edited to look like a score: the kind decides.
      q(2, { rejectionKind: "suppression", rejectionReason: "Auto-screened: ICP match (edited)" }),
      q(3, { rejectionKind: "dedupe", rejectionReason: "Already in a sequence as prospect #9" }),
      q(4, { rejectionKind: "person", rejectedByUserId: ME, rejectionReason: "Auto-screened: ICP match 10/100" }),
      // Written before the kind existed and not yet backfilled.
      q(5, { rejectionKind: null, rejectionReason: "Auto-screened: ICP match 15/100 below floor 30" }),
    );
    const r = await caller().are.prospects.reEvaluateAll({ campaignId: 5 });
    expect(r.total).toBe(2);
    expect((rows("bulk_jobs")[0].payload as { prospectIds: number[] }).prospectIds).toEqual([1, 5]);
  });

  it("the per-row check agrees", () => {
    expect(isScoreRejection({ rejectionKind: "screen" })).toBe(true);
    expect(isScoreRejection({ rejectionKind: "suppression", rejectionReason: "Auto-screened: ICP match 1/100" })).toBe(false);
    expect(isScoreRejection({ rejectionKind: null, rejectedByUserId: null, rejectionReason: "Auto-screened: ICP match 1/100" })).toBe(true);
    expect(isScoreRejection({ rejectionKind: null, rejectedByUserId: 3, rejectionReason: "Auto-screened: ICP match 1/100" })).toBe(false);
  });
});

describe("every rejecting writer names a kind", () => {
  /** Server source files, no tests or fakes. */
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__fakes__" || f === "node_modules" ? [] : files(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !/seed/i.test(f) ? [p] : [];
  });
  it("each `sequenceStatus: \"skipped\"` write and each SQL `= 'skipped'` SET carries rejectionKind within its statement", () => {
    const offenders: string[] = [];
    for (const f of files(join(ROOT, "server"))) {
      const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      if (f.endsWith("rawMigrations.ts")) continue;
      const re = /\.set\(\{[^}]*sequenceStatus: "skipped"[^}]*\}|SET \\`sequenceStatus\\` = 'skipped',[\s\S]{0,300}?WHERE/g;
      for (const m of src.match(re) ?? []) if (!m.includes("rejectionKind")) offenders.push(`${relative(ROOT, f)}: ${m.slice(0, 120)}`);
      // The multi-line object form: "sequenceStatus: \"skipped\"," then rejectedAt on the next lines.
      const multi = /sequenceStatus: "skipped",\n\s+rejectedAt: new Date\(\),\n(\s+[^\n]*\n){0,2}/g;
      for (const m of src.match(multi) ?? []) if (!m.includes("rejectionKind")) offenders.push(`${relative(ROOT, f)}: ${m.slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });
  it("the territory reject at discovery and Audit & fix name theirs", () => {
    const scraper = read("server/routers/are/scraper.ts");
    expect(scraper).toContain('rejectionKind: "territory" as const,');
    const rec = read("server/services/are/prospectReconcile.ts");
    expect(rec).toContain('`Audit & fix: the same person as row ${keeper.id} ${where}`, "dedupe")');
    expect(rec).toContain('"Audit & fix: no name, email or LinkedIn profile to identify this person", "unidentifiable")');
    expect(rec).toContain("rejectedByUserId: userId, rejectionKind: kind, rejectionReason: reason");
  });
  it("the engine's raw SQL rejections name theirs", () => {
    const eng = read("server/areEngine.ts");
    expect(eng).toContain("\\`rejectionKind\\` = 'screen',\n          \\`rejectionReason\\` = CONCAT('Auto-screened: ICP match ',");
    expect(eng).toContain("\\`rejectionKind\\` = 'no_email',\n          \\`rejectionReason\\` = 'No verifiable email address found");
  });
});

describe("the backfill reads a reason only where it names one writer", () => {
  it("each writer's reason maps to its kind; anything else is Other", () => {
    expect(rejectionKindFromReason("Auto-screened: ICP match 20/100 below floor 30", null)).toBe("screen");
    expect(rejectionKindFromReason("Auto-screened: ICP match 12/100 is below this campaign's enrichment gate of 40 — never eligible", null)).toBe("screen");
    expect(rejectionKindFromReason("On suppression list — not enrolled (unsubscribed)", null)).toBe("suppression");
    expect(rejectionKindFromReason("Already in a sequence as prospect #12 (same email or LinkedIn profile) — not enrolled twice", null)).toBe("dedupe");
    expect(rejectionKindFromReason("No verifiable email address found — enrichment exhausted every source", null)).toBe("no_email");
    expect(rejectionKindFromReason("Downstream: the organization is in financial distress — do not contact now", null)).toBe("distress");
    expect(rejectionKindFromReason('Never-target word "intern" in title', null)).toBe("never_target");
    expect(rejectionKindFromReason("Outside target geography", null)).toBe("territory");
    expect(rejectionKindFromReason("Enrichment failed 3 times: timeout", null)).toBe("enrichment_failed");
    expect(rejectionKindFromReason("Generated sequence has no usable steps", null)).toBe("no_steps");
    expect(rejectionKindFromReason("Audit & fix: the same person as row 4 (same email)", 7)).toBe("dedupe");
    expect(rejectionKindFromReason("Audit & fix: no name, email or LinkedIn profile to identify this person", 7)).toBe("unidentifiable");
    expect(rejectionKindFromReason("Wrong fit", 7)).toBe("person");
    expect(rejectionKindFromReason("Auto-screened: ICP match 5/100", 7)).toBe("person");
    expect(rejectionKindFromReason("Out of ICP", null)).toBe("other");
    expect(rejectionKindFromReason(null, null)).toBe("other");
  });

  it("migration 0331 runs the same patterns in the same order, only on rejected rows without a kind, then Other", () => {
    const m = read("server/_core/rawMigrations.ts");
    const i = m.indexOf('name: "0331_rejection_kind.sql"');
    expect(i).toBeGreaterThan(0);
    const block = m.slice(i, m.indexOf("\n  },", i));
    const updates = Array.from(block.matchAll(/"UPDATE `prospect_queue` SET `rejectionKind` = '(\w+)' WHERE `sequenceStatus` = 'skipped' AND `rejectionKind` IS NULL(?: AND ([^"]+))?"/g))
      .map((x) => ({ kind: x[1], cond: x[2] ?? null }));
    const expected = REJECTION_REASON_PATTERNS.map((p) => ({
      kind: p.kind,
      cond: p.byUser ? "`rejectedByUserId` IS NOT NULL" : p.exact != null ? `\`rejectionReason\` = '${p.exact}'` : `\`rejectionReason\` LIKE '${p.prefix}%'`,
    }));
    expect(updates).toEqual([...expected, { kind: "other", cond: null }]);
    expect(block).toContain("ALTER TABLE `prospect_queue` ADD COLUMN `rejectionKind` varchar(24) NULL");
    for (const k of updates.map((u) => u.kind)) expect(REJECTION_KINDS).toContain(k);
  });
});

describe("the Rejections tab shows and filters by kind", () => {
  it("chips per kind filter the list, and each row says who or what rejected it", () => {
    const src = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(src).toContain("{ campaignId, reason: reasonFilter, kind: kindFilter, page: rejPage, perPage: REJECTION_PAGE }");
    const i = src.indexOf('aria-label="Filter by who or what rejected them"');
    expect(i).toBeGreaterThan(0);
    const chips = src.slice(i, src.indexOf("{/* ── Rejection reason bar chart ── */}", i));
    expect(chips).toContain("rejectionStats?.byKind");
    expect(chips).toContain("onClick={() => setKindFilter(isActive ? null : k.kind)}");
    expect(chips).toContain("aria-pressed={isActive}");
    expect(src).toContain("{rejectionKindLabel(item.rejectionKind)}");
  });
});
