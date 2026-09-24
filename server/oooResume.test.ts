/**
 * Out-of-office = a bounded pause, not a permanent one (migration 0181).
 *
 * THE BUG THIS CLOSES: inboundReplyPoller pauses every active enrollment for a
 * person the instant ANY reply lands — before anything knows it was a robot —
 * and processEnrollments only ever selects status='active'. So an auto-
 * responder took that person out of outreach forever, while two shipped
 * documents promised the opposite ("out-of-offices pause and resume later").
 *
 * THE SHAPE, and what these pins exist to protect:
 *   · the poller records WHICH enrollment ids a given reply paused;
 *   · the classifier stamps resumeAt on exactly those ids — never a row a rep
 *     paused by hand, never one an older genuine reply stopped;
 *   · a sweep on the 5-minute sequence tick flips due rows back to active.
 *
 * The dead-wiring class is the reason for pin 6 in particular: `reply` inside
 * applyReplyAction is the row read BEFORE classification, so the extracted
 * return date is only reachable if both call sites carry it forward.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const repo = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

// ─── db + archive harness (this file only) ───────────────────────────────────
// Deliberately its OWN harness rather than a new case in sequenceEngine.test.ts:
// six tests in that file's processEnrollments describe consume a shared
// mockSelect queue in strict call order, and an extra queued chain shifts all
// of them. drizzle-orm and drizzle/schema are the REAL modules here, so the
// sweep builds real conditions; only the db and the archive freeze are faked.

const mockUpdateSet = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockDb = { select: mockSelect, update: mockUpdate, insert: vi.fn() };

vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(mockDb) }));
vi.mock("./_core/workspaceArchive", () => ({
  archivedWorkspaceIds: vi.fn().mockResolvedValue(new Set<number>()),
  invalidateArchivedWorkspaceCache: vi.fn(),
  isWorkspaceArchived: vi.fn().mockResolvedValue(false),
}));

function selectChain(rows: any[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.then = (resolve: any) => Promise.resolve(rows).then(resolve);
  return chain;
}

// ─── 1-2. The pure helpers, executed ─────────────────────────────────────────

describe("oooResumeAt", () => {
  const received = new Date("2026-09-20T10:00:00Z");
  const now = new Date("2026-09-20T10:00:00Z");
  const DAY = 86400000;

  it("honours a stated return date", async () => {
    const { oooResumeAt } = await import("./services/replyClassifier");
    expect(oooResumeAt("2026-10-18", received, now).toISOString()).toBe("2026-10-18T09:00:00.000Z");
  });

  it("falls back to receivedAt + 7 days when no date was stated", async () => {
    const { oooResumeAt, OOO_DEFAULT_DAYS } = await import("./services/replyClassifier");
    expect(oooResumeAt("", received, now).getTime()).toBe(received.getTime() + OOO_DEFAULT_DAYS * DAY);
    expect(oooResumeAt(null, received, now).getTime()).toBe(received.getTime() + OOO_DEFAULT_DAYS * DAY);
    expect(oooResumeAt(undefined, received, now).getTime()).toBe(received.getTime() + OOO_DEFAULT_DAYS * DAY);
  });

  it("rejects free text and anything that is not exactly YYYY-MM-DD", async () => {
    const { oooResumeAt, OOO_DEFAULT_DAYS } = await import("./services/replyClassifier");
    // Date.parse would happily turn "18/10/2026" into something; a wrong date
    // here is a send at a wrong time, so only the exact shape is trusted.
    for (const junk of ["next Monday", "18/10/2026", "2026-10", "Oct 18 2026", "20261018"]) {
      expect(oooResumeAt(junk, received, now).getTime()).toBe(received.getTime() + OOO_DEFAULT_DAYS * DAY);
    }
  });

  it("ignores a return date at or before the reply itself", async () => {
    const { oooResumeAt, OOO_DEFAULT_DAYS } = await import("./services/replyClassifier");
    expect(oooResumeAt("2026-09-01", received, now).getTime()).toBe(received.getTime() + OOO_DEFAULT_DAYS * DAY);
  });

  it("caps a far-future date at 90 days after the reply", async () => {
    const { oooResumeAt, OOO_MAX_DAYS } = await import("./services/replyClassifier");
    // receivedAt + ~400d — a sabbatical auto-reply must not park someone for
    // over a year.
    const at = oooResumeAt("2027-10-25", received, now);
    expect(at.getTime()).toBe(received.getTime() + OOO_MAX_DAYS * DAY);
  });

  it("never resumes sooner than 12 hours from now", async () => {
    const { oooResumeAt } = await import("./services/replyClassifier");
    // A backlog classified two weeks late: receivedAt + 7d is already past, and
    // resuming into the live auto-responder is how the loop runs away.
    const old = new Date("2026-09-01T10:00:00Z");
    const at = oooResumeAt("", old, now);
    expect(at.getTime()).toBe(now.getTime() + 12 * 3600000);
    expect(at.getTime()).toBeGreaterThanOrEqual(now.getTime() + 12 * 3600000);
  });

  it("accepts a Date, which is what the approval path re-reads from mysql", async () => {
    const { oooResumeAt } = await import("./services/replyClassifier");
    const stored = new Date("2026-10-18T09:00:00Z");
    expect(oooResumeAt(stored, received, now).getTime()).toBe(stored.getTime());
  });
});

describe("pausedIdsOf", () => {
  it("reads an array, a json string, and nothing at all", async () => {
    const { pausedIdsOf } = await import("./services/replyClassifier");
    expect(pausedIdsOf({ pausedEnrollmentIds: [4, 9] })).toEqual([4, 9]);
    // mysql2 hands a json column back as text under some configurations.
    expect(pausedIdsOf({ pausedEnrollmentIds: "[4,9]" })).toEqual([4, 9]);
    expect(pausedIdsOf({ pausedEnrollmentIds: null })).toEqual([]);
    expect(pausedIdsOf({})).toEqual([]);
    expect(pausedIdsOf(null)).toEqual([]);
    expect(pausedIdsOf({ pausedEnrollmentIds: "not json" })).toEqual([]);
    expect(pausedIdsOf({ pausedEnrollmentIds: [3, "x", null, 0, -1, "7"] })).toEqual([3, 7]);
  });
});

// ─── 3-6. The classifier ─────────────────────────────────────────────────────

describe("the classifier's out_of_office branch schedules a resume", () => {
  const rc = () => read("services", "replyClassifier.ts");

  it("stamps resumeAt on exactly the enrollment ids this reply paused", () => {
    const src = rc();
    const start = src.indexOf('case "out_of_office"');
    expect(start, "the out_of_office branch is gone").toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf("default:", start));
    expect(branch).toContain("resumeAt");
    // By ID, never by re-deriving the person: a person-based predicate also
    // hits the row a rep paused on purpose months ago.
    expect(branch).toContain("inArray(enrollments.id");
    // In approval mode the rep may Apply days later, having already resumed or
    // exited the row by hand — then this must be a no-op.
    expect(branch).toContain('eq(enrollments.status, "paused")');
    // No task: Conversations plus the "Resumes <date>" hint IS the surface, and
    // a fifth place to look is the thing phase4FewerSurfaces removed.
    expect(branch).not.toContain("db.insert(tasks)");
    expect(branch).not.toContain("createReplyTask");
  });

  it("clears a pending resume when any OTHER class of reply arrives", () => {
    const src = rc();
    const fn = src.indexOf("export async function applyReplyAction");
    const body = src.slice(fn);
    const clear = body.indexOf("resumeAt: null");
    const sw = body.indexOf("switch (cls)");
    expect(clear, "the stale-stamp clear is gone — the sweep would restart outreach into a live conversation").toBeGreaterThan(-1);
    expect(sw).toBeGreaterThan(-1);
    // BEFORE the switch: the poller's re-pause matches status='active' only, so
    // it is a no-op on an already-snoozed row and cannot clear this itself.
    expect(clear).toBeLessThan(sw);
  });

  it("still makes exactly one LLM call, and asks for the return date", () => {
    const src = rc();
    const fn = src.indexOf("export async function classifyReply");
    const body = src.slice(fn, src.indexOf("function replyRelated"));
    expect(body.split("invokeLLM(").length - 1).toBe(1);
    expect(body).toContain('returnsAt: { type: "string" }');
    expect(body).toContain('"returnsAt"');
    // Anchored on receivedAt, not now(): a backlog classified two weeks later
    // must resolve "back Monday" against when the mail actually arrived.
    expect(body).toContain("Received: ");
    expect(body).toContain("oooReturnsAt: cls.returnsAt");
  });

  it("carries the extracted date past the pre-classification row (the dead-wiring pin)", () => {
    // `reply` inside applyReplyAction is the row read BEFORE classifyReply
    // wrote oooReturnsAt. Without these two hand-offs the whole extraction is
    // unreachable and every OOO silently takes the 7-day fallback.
    expect(rc()).toContain("oooReturnsAt: cls.returnsAt");
    const conv = read("routers", "conversations.ts");
    expect(conv).toContain("cls.returnsAt");
  });

  it("leaves the social branch as ooo_noted, with the reason written down", () => {
    const src = rc();
    const social = src.indexOf("export async function classifyAndHandleSocialMessage");
    const body = src.slice(social, src.indexOf("export async function runConversationAutopilotForWorkspace"));
    const branch = body.slice(body.indexOf('case "out_of_office"'));
    expect(branch).toContain('action = "ooo_noted"');
    // Nothing on the Unipile path ever pauses an enrollment, so there is
    // nothing to resume there — the branch says so, because the next reader's
    // instinct is to "finish" it by mirroring the email side and stamp a
    // resume with no paused ids behind it.
    expect(branch).toContain("nothing here to schedule");
    expect(body).not.toContain("db.update(enrollments)");
  });
});

// ─── 7. The poller ───────────────────────────────────────────────────────────

describe("the poller records what it paused", () => {
  it("writes the paused ids onto the reply without regressing the replyDetection toggle", () => {
    const src = read("inboundReplyPoller.ts");
    const at = src.indexOf("pausedEnrollmentIds: pausedIds");
    expect(at, "the reply→enrollment link is gone; the classifier has nothing to act on").toBeGreaterThan(-1);
    // The toggle lives in the same window: only sequences that did NOT opt out
    // of pause-on-reply contribute ids, so only those are ever resumed.
    const win = src.slice(Math.max(0, at - 1600), at);
    expect(win).toContain("pauseBySeq.get(");
    expect(src).toContain("settings.replyDetection");
  });
});

// ─── 8-9. The sweep ──────────────────────────────────────────────────────────

describe("resumeDueEnrollments", () => {
  const se = () => read("sequenceEngine.ts");

  it("selects only snoozed rows, and skips archived workspaces per-row", () => {
    const src = se();
    const at = src.indexOf("export async function resumeDueEnrollments");
    expect(at, "the sweep is gone — nothing flips a snoozed row back").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toContain('eq(enrollments.status, "paused")');
    expect(body).toContain("isNotNull(enrollments.resumeAt)");
    expect(body).toContain("lte(enrollments.resumeAt");
    // PER-FUNCTION, because archiveEnforcement.test.ts is file-level and
    // sequenceEngine.ts already satisfied it from processEnrollments — a sweep
    // that forgot the freeze would have passed that test.
    expect(body).toContain("archivedWs.has(");
    const set = body.slice(body.indexOf(".set("));
    expect(set).toContain('status: "active"');
    expect(set).toContain("resumeAt: null");
  });

  it("resumes rather than resends, and stays out of the reply accounting", () => {
    const src = se();
    const at = src.indexOf("export async function resumeDueEnrollments");
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    // The paused row already points at the next UNSENT step.
    expect(body).not.toContain("currentStep");
    // None of this is a reply event.
    expect(body).not.toContain("bumpCampaignCounter");
    expect(body).not.toContain("classifiedAt");
    expect(body).not.toContain("handledAt");
    expect(body).not.toContain("firstReplyAt");
    // A second timer on `enrollments` would be a second overlap surface.
    expect(body).not.toContain("setInterval");
    // es5 target: a spread over a Set is a 326th tsc error.
    expect(body).not.toContain("[...new Set");
  });

  it("imports isNotNull, and the sibling suite's drizzle mock exports it", () => {
    // A missing import is a free identifier to esbuild: compiles, ships, throws
    // on first call. Same class as the replyScope import pin.
    expect(se()).toMatch(/import\s*\{[^}]*\bisNotNull\b[^}]*\}\s*from\s*"drizzle-orm"/);
    expect(read("sequenceEngine.test.ts")).toContain("isNotNull:");
  });
});

// ─── 10. The cron owner ──────────────────────────────────────────────────────

describe("the sweep runs on the existing sequence tick", () => {
  it("sits inside the SequenceEngine guard, before processEnrollments", () => {
    const src = read("_core", "index.ts");
    const guard = src.indexOf('guardOverlap("SequenceEngine"');
    expect(guard).toBeGreaterThan(-1);
    const closure = src.slice(guard, src.indexOf("setTimeout(runSequenceEngine", guard));
    const sweep = closure.indexOf("resumeDueEnrollments()");
    const process = closure.indexOf("processEnrollments()");
    expect(sweep, "the sweep is not wired into any cron").toBeGreaterThan(-1);
    // Before, so a row that just woke gets its next step on the same tick.
    expect(sweep).toBeLessThan(process);
  });

  it("adds no new timer", () => {
    // 38 as of 2026-09-20. The sweep touches the same table the sequence tick
    // does; a timer of its own would be a second overlap surface.
    // 39 since 2026-09-24: the meeting-invite answer sync (meetingResponses),
    // which touches only meetings, not the sequence tables.
    expect(read("_core", "index.ts").split("setInterval(").length - 1).toBe(39);
  });
});

// ─── 11. Migration parity ────────────────────────────────────────────────────

describe("migration parity", () => {
  it("0181 adds every column drizzle/schema.ts declares", () => {
    const migrations = read("_core", "rawMigrations.ts");
    const at = migrations.indexOf("0181_enrollment_ooo_resume.sql");
    expect(at, "migration 0181 missing from rawMigrations — schema-only columns break prod silently").toBeGreaterThan(-1);
    const block = migrations.slice(at, at + 800);
    expect(block).toContain("`resumeAt`");
    expect(block).toContain("`ix_enr_resume`");
    expect(block).toContain("`pausedEnrollmentIds`");
    expect(block).toContain("`oooReturnsAt`");

    const schema = repo("drizzle", "schema.ts");
    expect(schema).toContain('resumeAt: timestamp("resumeAt")');
    expect(schema).toContain('pausedEnrollmentIds: json("pausedEnrollmentIds")');
    expect(schema).toContain('oooReturnsAt: timestamp("oooReturnsAt")');
  });

  it("does not add a fifth enrollment status", () => {
    // crossEngineEnrollment, the dedupe gate and two routers enumerate the
    // statuses literally; a "snoozed" value would drop these people out of
    // every one of them.
    expect(repo("drizzle", "schema.ts")).toContain('mysqlEnum("status", ["active", "paused", "finished", "exited"])');
  });
});

// ─── 12. Behaviour ───────────────────────────────────────────────────────────

describe("the sweep, executed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
  });

  it("flips a due row back to active and clears the stamp", async () => {
    mockSelect.mockReturnValueOnce(selectChain([
      { id: 7, workspaceId: 1, status: "paused", resumeAt: new Date(Date.now() - 60000) },
    ]));
    const { archivedWorkspaceIds } = await import("./_core/workspaceArchive");
    (archivedWorkspaceIds as any).mockResolvedValue(new Set<number>());

    const { resumeDueEnrollments } = await import("./sequenceEngine");
    const res = await resumeDueEnrollments();

    expect(res.resumed).toBe(1);
    const payload = mockUpdateSet.mock.calls[0][0];
    expect(payload.status).toBe("active");
    expect(payload.resumeAt).toBeNull();
    expect(payload.nextActionAt).toBeInstanceOf(Date);
    // Continuation, not a resend: the paused row already points at the next
    // unsent step.
    expect(payload.currentStep).toBeUndefined();
  });

  it("skips a row in an archived workspace without touching it", async () => {
    mockSelect.mockReturnValueOnce(selectChain([
      { id: 8, workspaceId: 42, status: "paused", resumeAt: new Date(Date.now() - 60000) },
    ]));
    const { archivedWorkspaceIds } = await import("./_core/workspaceArchive");
    (archivedWorkspaceIds as any).mockResolvedValue(new Set<number>([42]));

    const { resumeDueEnrollments } = await import("./sequenceEngine");
    const res = await resumeDueEnrollments();

    expect(res.resumed).toBe(0);
    // The stamp survives, so the row wakes on un-archive — that is the freeze
    // semantics, not a lost enrollment.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing when nothing is due", async () => {
    mockSelect.mockReturnValueOnce(selectChain([]));
    const { archivedWorkspaceIds } = await import("./_core/workspaceArchive");
    (archivedWorkspaceIds as any).mockResolvedValue(new Set<number>());

    const { resumeDueEnrollments } = await import("./sequenceEngine");
    expect((await resumeDueEnrollments()).resumed).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─── The reachable side-effect 0181 creates ──────────────────────────────────

describe("bulk enroll does not double-enrol a snoozed person", () => {
  it("the already-enrolled gate counts paused, and is workspace-scoped", () => {
    const src = read("routers", "crm.ts");
    const at = src.indexOf("// Check if already enrolled");
    expect(at).toBeGreaterThan(-1);
    const stmt = src.slice(at, src.indexOf(".limit(1)", at));
    // Active-only was survivable while a paused row never woke by itself.
    // With a resume sweep it is two live enrollments mailing one human.
    expect(stmt).toContain("ACTIVE_ENROLLMENT_STATUSES");
    expect(stmt).not.toContain('eq(enrollments.status, "active")');
    expect(stmt).toContain("eq(enrollments.workspaceId, ctx.workspace.id)");
  });
});

// ─── 13. Doc truth ───────────────────────────────────────────────────────────

describe("the shipped documents match the code", () => {
  it("the Help Center's resume promise is now backed by a sweep", () => {
    expect(read("seedHelpContent.ts")).toContain("Out-of-offices genuinely pause and resume");
    expect(read("sequenceEngine.ts")).toContain("resumeDueEnrollments");
  });

  it("the operator manual names the fallback, the cap and the Off caveat", () => {
    const manual = read("seedHelpOperatorManual.ts");
    const row = manual.slice(manual.indexOf("| Out of office |"));
    const cell = row.slice(0, row.indexOf("\\n"));
    expect(cell).toContain("7 days");
    expect(cell).toContain("90 days");
    expect(cell).toContain("Off never classifies");
  });
});
