/**
 * Phase 4 of the 2026-10-20 audit, part 7 — type errors 285 → 0, and the
 * type check blocks CI (X3).
 *
 *   tsc checks for ES2022 (it assumed ES5: 73 iteration errors) and CI fails
 *   on any error · the bugs the errors hid, each fixed: Help Center insights
 *   (X3.2), the opportunity's AI summary (X3.3), Tour builder's New button,
 *   step counts and steps on edit (X3.4), the proposal activity feed (X3.5),
 *   call outcome and author (X3.6), the duplicate's log line (X3.7), IMAP
 *   search answering false (X3.8), a Leads send that never sent, a reconnect
 *   link Unipile rejected, an error code tRPC does not have, clearing
 *   bounced drafts, a feedback count that was ignored · LLM content read as
 *   text · a missing database says so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, wsId: 2 };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { contentText } from "./_core/llm";
import { activities, emailDrafts, helpArticles, helpSearchLog, opportunities, tourSteps, tours } from "../drizzle/schema";

const LSI = 2, OTHER = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];

function caller(ws = LSI) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [LSI]: "admin", [OTHER]: "admin" }, wsId: () => h.wsId });
});

describe("the type check is clean and blocking (X3)", () => {
  it("tsc checks for ES2022, not ES5", () => {
    expect(read("tsconfig.json")).toMatch(/"target": "ES2022",/);
  });
  it("CI fails on a type error: the step has no continue-on-error", () => {
    const ci = read(".github/workflows/ci.yml");
    const step = ci.slice(ci.indexOf("- name: Typecheck"), ci.indexOf("- name: Tests"));
    expect(step).toContain("run: pnpm check");
    expect(step).not.toContain("continue-on-error");
    expect(read("package.json")).toContain('"check": "tsc --noEmit"');
  });
});

describe("LLM content is read as text", () => {
  it("a string as is; content parts joined; nothing is empty", () => {
    expect(contentText('{"a":1}')).toBe('{"a":1}');
    expect(contentText([{ type: "text", text: "Hello " }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: "there" }])).toBe("Hello there");
    expect(contentText({ type: "text", text: "one" })).toBe("one");
    expect(contentText(null)).toBe("");
    expect(contentText(undefined)).toBe("");
  });
  it("the call sites parse text, and the meeting summary saved is text", () => {
    for (const f of ["server/routers/aiFeatures.ts", "server/services/dealAutopilot.ts", "server/services/meetingScheduler.ts", "server/services/replyClassifier.ts", "server/services/taskAutopilot.ts"]) {
      const s = read(f);
      expect(s, f).toContain('JSON.parse(contentText(res.choices?.[0]?.message?.content) || "{}")');
      expect(s, f).not.toContain('JSON.parse(res.choices?.[0]?.message?.content ?? "{}")');
    }
    expect(read("server/routers/calendar.ts")).toContain('const summary = contentText(llmResult.choices?.[0]?.message?.content) || "(no summary generated)";');
  });
});

describe("Help Center insights have their four cards (X3.2)", () => {
  it("top and unanswered searches by count; most helpful and needs improvement by vote share", async () => {
    const log = (query: string, resultsCount: number, workspaceId = LSI) => T(helpSearchLog).push({ id: T(helpSearchLog).length + 1, workspaceId, userId: 1, query, resultsCount, createdAt: new Date() });
    log("sequences", 3); log("sequences", 2); log("sequences", 5); log("billing", 0); log("billing", 0); log("sso", 0); log("sso", 0, OTHER);
    const art = (id: number, helpfulCount: number, notHelpfulCount: number) => T(helpArticles).push({ id, workspaceId: LSI, slug: `a${id}`, title: `A${id}`, status: "published", viewCount: id, helpfulCount, notHelpfulCount, createdAt: new Date(), updatedAt: new Date() });
    art(1, 9, 1); art(2, 1, 3); art(3, 0, 0); art(4, 2, 2);
    const r = await caller().helpCenter.getInsights();
    expect(new Map(r.topSearches.map((s) => [s.query, s.count]))).toEqual(new Map([["sequences", 3], ["billing", 2], ["sso", 1]]));
    expect(new Map(r.unansweredQuestions.map((s) => [s.query, s.count]))).toEqual(new Map([["billing", 2], ["sso", 1]]));
    expect(r.mostHelpful.map((a) => [a.title, a.helpfulPct])).toEqual([["A1", 90], ["A4", 50]]);
    expect(r.needsImprovement.map((a) => [a.title, a.unhelpfulPct])).toEqual([["A2", 75]]);
    // The page reads exactly these names.
    const page = read("client/src/pages/usip/HelpCenter.tsx");
    for (const k of ["topSearches", "unansweredQuestions", "mostHelpful", "needsImprovement", "helpfulPct", "unhelpfulPct"]) expect(page, k).toContain(k);
  });
});

describe("Tour builder: a New button, step counts, and steps on edit (X3.4)", () => {
  it("the list carries each tour's step count and its page", async () => {
    T(tours).push({ id: 1, workspaceId: LSI, name: "A", type: "feature", status: "draft", estimatedMinutes: 3, pageKey: "people" }, { id: 2, workspaceId: LSI, name: "B", type: "feature", status: "draft", estimatedMinutes: 3, pageKey: null });
    T(tourSteps).push({ id: 1, tourId: 1, sortOrder: 0 }, { id: 2, tourId: 1, sortOrder: 1 });
    const list = await caller().tours.list({ type: "all", status: "all" });
    expect(list.map((t) => [t.id, t.stepCount, t.pageKey])).toEqual([[1, 2, "people"], [2, 0, null]]);
  });
  it("the New button is inside the header; an edit loads the whole tour", () => {
    const s = read("client/src/pages/usip/TourBuilder.tsx");
    expect(s).not.toMatch(/\n\s+actions=\{/);
    expect(s).toMatch(/pageKey="tour-builder"\n\s+>\n[\s\S]{0,200}<Button[\s\S]{0,200}New Tour\n\s+<\/Button>\n\s+<\/PageHeader>/);
    expect(s).toContain("trpc.tours.get.useQuery({ id: editing?.id ?? 0 }, { enabled: !!editing })");
    expect(s).toContain("initial={editing ? fullTour.data : null}");
    expect(s).toContain("{tour.stepCount} step");
    expect(s).toContain("{tour.pageKey && (");
  });
});

describe("the bugs behind the other errors are fixed", () => {
  it("the opportunity shows the AI's reasoning (X3.3); the proposal feed loads (X3.5)", () => {
    expect(read("client/src/pages/usip/OpportunityDetail.tsx")).toContain("{intel.winProbabilityRationale && <div");
    const p = read("client/src/pages/usip/ProposalDetail.tsx");
    expect(p).toContain("const { current } = useWorkspace();\n  const [activeFilter");
    expect(p).toContain("{ proposalId },\n    { enabled: !!current },");
  });

  it("a call's outcome and author come from callDisposition and actorUserId (X3.6)", async () => {
    T(opportunities).push({ id: 5, workspaceId: LSI, name: "D", stage: "discovery" });
    T(activities).push({ id: 1, workspaceId: LSI, type: "call", relatedType: "opportunity", relatedId: 5, subject: "Call", body: null, callDisposition: "connected", actorUserId: 7, occurredAt: new Date(), createdAt: new Date() });
    const [a] = await caller().opportunities.getTimeline({ id: 5 });
    expect(a).toMatchObject({ disposition: "connected", createdByUserId: 7 });
  });

  it("a duplicate says what it was copied from (X3.7); the score counts feedback", () => {
    const s = read("server/routers/proposals.ts");
    expect(s).toContain('subject: `Proposal duplicated from "${src.title}"`');
    expect(s).toContain("computeEngagementScore({ ...proposal, feedbackCount: feedbackRows.length })");
    expect(s).not.toContain("computeEngagementScore(proposal, feedbackRows.length)");
  });

  it("IMAP search answering false is no match, not a crash (X3.8)", () => {
    expect(read("server/inboundReplyPoller.ts")).toContain("const uids = (await client.search({ seen: false }, { uid: true })) || [];");
    expect(read("server/emailAdapter.ts")).toContain("const uids = (await client.search({ text: query }, { uid: true })) || [];");
    for (const f of ["server/inboundReplyPoller.ts", "server/emailAdapter.ts"]) {
      expect(read(f).match(/if \(!msg\.source\) continue;\n\s+const parsed = await simpleParser\(msg\.source\);/g)?.length, f).toBe(f.includes("Poller") ? 1 : 2);
    }
  });

  it("Leads' Send Email sends one per lead, the input the server takes", () => {
    const s = read("client/src/pages/usip/Leads.tsx");
    expect(s).toContain("for (const leadId of leadIds) {\n      try { await send.mutateAsync({ leadId, subject, body }); }");
    expect(s).not.toContain("send.mutate({ leadIds, subject, body })");
    expect(s).toContain("compose.mutate({ prompt: aiPrompt, toLeadId: leadIds.length === 1 ? leadIds[0] : undefined })");
  });

  it("a reconnect link names one provider; the precondition code is tRPC's", () => {
    expect(read("server/unipileWebhook.ts")).toMatch(/type: "reconnect",\n[\s\S]{0,200}providers: row\.provider,/);
    const li = read("server/routers/linkedinEnrichment.ts");
    expect(li).not.toContain("FAILED_PRECONDITION");
    expect(li.split('code: "PRECONDITION_FAILED"').length - 1).toBe(3);
  });

  it("clearing bounced drafts clears the bounced ones", async () => {
    T(emailDrafts).push(
      { id: 1, workspaceId: LSI, status: "sent", bouncedAt: new Date() }, { id: 2, workspaceId: LSI, status: "sent", bouncedAt: null },
      { id: 3, workspaceId: OTHER, status: "sent", bouncedAt: new Date() },
    );
    await caller().aiPipeline.clearDrafts({ status: "bounced" });
    expect(T(emailDrafts).map((d) => d.id)).toEqual([2, 3]);
  });

  it("Discover prospects is not handed the click event as a query", () => {
    expect(read("client/src/pages/usip/People.tsx")).toContain("onClick={() => onDiscover()}");
  });
});

describe("a missing database says so", () => {
  it("routers that read it unguarded now check it first", () => {
    for (const f of ["server/routers/mindmaps.ts", "server/routers/unipile.ts", "server/routers/voiceAgents.ts", "server/routers/proposals.ts", "server/routers/reports.ts", "server/unipileWebhook.ts"]) {
      const s = read(f);
      const decls = (s.match(/const db = await getDb\(\);\n/g) ?? []).length;
      // Guarded on the next line, or by getProposalOrThrow, which checks it first.
      const guarded = (s.match(/const db = await getDb\(\);\n\s+(if \(!db\)|(const proposal = )?await getProposalOrThrow\(db,)/g) ?? []).length;
      expect(guarded, f).toBe(decls);
    }
  });
  it("credentials fall back to the environment, as they did, without throwing", () => {
    for (const f of ["server/_core/llm.ts", "server/_core/llmStream.ts"]) expect(read(f), f).toContain("    const db = await getDb();\n    if (!db) return ENV_CREDS;");
  });
});
