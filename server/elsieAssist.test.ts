/**
 * Elsie Assist (owner 2026-11-16): the pane where Elsie suggests what to do
 * next on the page the user is on.
 *
 * What these tests hold her to:
 *   - RULES pick the suggestions, from the records. A model only orders and
 *     rewords them, cannot add one, cannot touch a button, and a reworded
 *     line with a number the facts do not hold is thrown away.
 *   - Nothing in the pane changes a record: a button opens a page or puts a
 *     request to Elsie in her chat.
 *   - It costs nothing while closed, one model pass at most per set of facts,
 *     and no more passes a day than the workspace's number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as any[],
  reply: (_p: any): any => ({ items: [] }),
  /** What every settings / ledger read returns. */
  row: { cap: null as number | null, n: 0 },
}));

vi.mock("./_core/llm", async (importActual) => ({
  ...(await importActual<typeof import("./_core/llm")>()),
  invokeLLM: async (params: any) => {
    h.calls.push(params);
    const out = h.reply(params);
    return { id: "x", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: typeof out === "string" ? out : JSON.stringify(out) }, finish_reason: "stop" }] };
  },
}));

import {
  ASSIST_DEFAULT_DAILY_CAP,
  ASSIST_KIND_IDS,
  ASSIST_MAX_SHOWN,
  applyWording,
  assistPlaceFor,
  cleanAssistPrefs,
  isAssistKind,
  numbersIn,
  rankCandidates,
  wordingIsGrounded,
  type AssistCandidate,
} from "@shared/elsieAssist";
import { AI_TASKS } from "@shared/aiTiers";
import { campaignCandidates, homeCandidates, inboxCandidates, personCandidates } from "./services/elsieAssistRules";
import { ASSIST_FEATURE, __resetAssistCacheForTests, suggestionsFor, wordingKey } from "./services/elsieAssist";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A database whose every read resolves to the one row above. */
const fakeDb = (): any => {
  const chain = (): any => {
    const c: any = { from: () => c, where: () => c, limit: () => c, then: (res: any, rej: any) => Promise.resolve([h.row]).then(res, rej) };
    return c;
  };
  return { select: () => chain() };
};

const cand = (id: string, weight: number, extra: Partial<AssistCandidate> = {}): AssistCandidate => ({
  id,
  kind: "replies_waiting",
  weight,
  title: `Answer 7 replies (${id})`,
  why: "7 replies have not been handled.",
  action: { type: "navigate", label: "Open Inbox", href: "/v2/inbox" },
  facts: { unhandledReplies: 7 },
  ...extra,
});

beforeEach(() => {
  h.calls = [];
  h.reply = () => ({ items: [] });
  h.row = { cap: null, n: 0 };
  __resetAssistCacheForTests();
});

/* ─── Where she has something to say ────────────────────────────────────── */

describe("the four pages", () => {
  it("knows Home, a campaign, Inbox and a person, and nothing else", () => {
    expect(assistPlaceFor("/")).toEqual({ place: "home", id: null });
    expect(assistPlaceFor("/v2/home")).toEqual({ place: "home", id: null });
    expect(assistPlaceFor("/v2/home?view=pipeline")).toEqual({ place: "home", id: null });
    expect(assistPlaceFor("/are/campaigns/34")).toEqual({ place: "campaign", id: 34 });
    expect(assistPlaceFor("/v2/inbox?tab=social")).toEqual({ place: "inbox", id: null });
    expect(assistPlaceFor("/v2/people?person=6842")).toEqual({ place: "person", id: 6842 });
    expect(assistPlaceFor("/prospects/12")).toEqual({ place: "person", id: 12 });
    for (const other of ["/v2/people", "/are/campaigns", "/are", "/v2/settings/workspace", "/pipeline?deal=3", "/v2/tasks"]) {
      expect(assistPlaceFor(other), other).toBeNull();
    }
    // An address that is not a plain in-app path is not a page at all.
    for (const bad of ["https://evil.example/", "//x", "/a/../b", "", null, 5]) expect(assistPlaceFor(bad)).toBeNull();
  });
});

/* ─── The rules ─────────────────────────────────────────────────────────── */

describe("Home", () => {
  it("turns each queue with something in it into a suggestion, with the count the page shows", () => {
    const out = homeCandidates({
      unhandledReplies: { count: 7 },
      digest24h: { repliesReceived: 2 },
      proposedMeetings: { count: 1 },
      areApprovals: { count: 30, byCampaign: [{ campaignId: 1, name: "Alpha", count: 5 }, { campaignId: 2, name: "Beta", count: 25 }] },
      awaitingDrafts: { count: 4 },
      socialReplies: { count: 0 },
      routingSuggestions: { count: 0 },
      campaignProposals: { count: 0 },
      pausedCampaigns: [{ id: 1, name: "Alpha" }],
    }, { activeCampaigns: 2 });
    expect(out.map((c) => c.kind)).toEqual(["replies_waiting", "meetings_to_confirm", "prospects_to_approve", "drafts_to_review"]);
    expect(out[0].title).toBe("Answer 7 replies waiting in Inbox");
    expect(out[0].why).toBe("7 replies to your outreach have not been handled; 2 arrived in the last 24 hours.");
    expect(out[0].action).toEqual({ type: "navigate", label: "Open Inbox", href: "/v2/inbox" });
    expect(out[1].title).toBe("Check 1 proposed meeting");
    // The biggest queue is named, not the first one.
    expect(out[2].why).toContain("25 of them are in Beta.");
    expect(out[3].action).toEqual({ type: "navigate", label: "Open drafts", href: "/v2/emails?status=awaiting" });
  });

  it("says nothing when nothing is waiting", () => {
    expect(homeCandidates({}, { activeCampaigns: 3 })).toEqual([]);
    expect(homeCandidates({ unhandledReplies: { count: 0 }, areApprovals: { count: 0, byCampaign: [] } }, { activeCampaigns: 0 })).toEqual([]);
  });

  it("does not nag about a paused campaign, only says when nothing at all is running", () => {
    const paused = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
    expect(homeCandidates({ pausedCampaigns: paused }, { activeCampaigns: 1 })).toEqual([]);
    const none = homeCandidates({ pausedCampaigns: paused }, { activeCampaigns: 0 });
    expect(none.map((c) => c.kind)).toEqual(["campaigns_all_paused"]);
    expect(none[0].why).toBe("2 campaigns are paused and none is active, so the Revenue Engine is sending nothing.");
    // It is the least pressing thing on Home.
    const withReplies = homeCandidates({ pausedCampaigns: paused, unhandledReplies: { count: 1 } }, { activeCampaigns: 0 });
    expect(rankCandidates(withReplies)[0].kind).toBe("replies_waiting");
  });
});

describe("a campaign's page", () => {
  const c = { id: 34, name: "Nonprofit Website Transformation", status: "paused" };

  it("a paused campaign: says so and offers to have Elsie resume it, in her chat", () => {
    const [s] = campaignCandidates(c, { topReason: "campaignNotActive" }, 0);
    expect(s.kind).toBe("campaign_blocked");
    expect(s.title).toBe("This campaign is paused, so it is sending nothing");
    expect(s.action).toEqual({ type: "ask", label: "Ask Elsie to resume it", prompt: 'Resume the campaign "Nonprofit Website Transformation" (id 34).' });
    const [draft] = campaignCandidates({ ...c, status: "draft" }, { topReason: "campaignNotActive" }, 0);
    expect(draft.action).toMatchObject({ type: "ask", label: "Ask Elsie to launch it" });
  });

  it("the workspace pause outranks everything and points at its switch", () => {
    const [s] = campaignCandidates({ ...c, status: "active" }, { topReason: "workspacePaused" }, 12);
    expect(s.title).toBe("Outbound is paused for the whole workspace");
    expect(s.action).toEqual({ type: "navigate", label: "Open Workspace overview", href: "/v2/settings/workspace" });
  });

  it("each blocker the page's own panel reports has a suggestion, with that panel's count", () => {
    const gates = {
      noEmail: 3, noDossier: 4, unusableSequence: 5, enrichmentFailed: { count: 6 }, copyHeld: { count: 9 },
      cap: { cap: 40, sentToday: 40, remaining: 0 }, paused: { prospects: 2 }, queue: { working: 150, target: 150 },
    };
    const title = (topReason: string) => campaignCandidates({ ...c, status: "active" }, { topReason, gates, sending: { dueNow: 11, windowDescription: "Mon to Fri, 9 to 5" } }, 0)[0];
    expect(title("windowClosed").title).toBe("11 steps are due and waiting for the send window");
    expect(title("windowClosed").why).toContain("(Mon to Fri, 9 to 5)");
    expect(title("capUsed").why).toBe("It has sent 40 of its 40 for today; sending picks up again tomorrow.");
    expect(title("copyHeld").title).toBe("9 prospects' sequences are held for a copy check");
    expect(title("noEmail").title).toBe("3 approved prospects have no email address");
    expect(title("unusableSequence").title).toBe("5 prospects have a sequence that cannot be sent");
    expect(title("noDossier").title).toBe("4 prospects are waiting on research before copy can be written");
    expect(title("enrichmentFailed").title).toBe("Enrichment failed for 6 prospects");
    expect(title("prospectsPaused").title).toBe("2 prospects are paused in this campaign");
    expect(title("queueFull").why).toBe("It is working 150 against a target of 150, so it has stopped looking for new people.");
    // And every reason the endpoint can give is one this file answers.
    const src = read("server/routers/are/campaigns.ts");
    const reasons = Array.from(src.slice(src.indexOf("const topReason ="), src.indexOf("return {", src.indexOf("const topReason ="))).matchAll(/\? "(\w+)"/g)).map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(11);
    for (const r of reasons) expect(campaignCandidates({ ...c, status: "active" }, { topReason: r, gates, sending: { dueNow: 1 } }, 0).length, r).toBe(1);
  });

  it("a campaign that is not blocked gets no blocker, and its approval queue is its own suggestion", () => {
    expect(campaignCandidates({ ...c, status: "active" }, { topReason: null }, 0)).toEqual([]);
    expect(campaignCandidates({ ...c, status: "active" }, null, 0)).toEqual([]);
    const [s] = campaignCandidates({ ...c, status: "active" }, { topReason: null }, 12);
    expect(s.kind).toBe("campaign_approvals");
    expect(s.title).toBe("Approve 12 prospects waiting in this campaign");
  });
});

describe("Inbox", () => {
  it("puts the replies that are willing to meet first", () => {
    const out = inboxCandidates({ unhandledReplies: { count: 9 }, socialReplies: { count: 2 } }, { willing_to_meet: 3, follow_up_question: 2, not_interested: 4 });
    const ranked = rankCandidates(out);
    expect(ranked[0].kind).toBe("interested_replies");
    expect(ranked[0].why).toBe("3 unanswered replies were classified as willing to meet, out of 9 waiting.");
    expect(ranked[1].why).toBe("Of the unanswered replies, 2 ask a question.");
    expect(ranked[2].kind).toBe("social_replies");
  });

  it("with no class that asks for anything, it is one plain line; with nothing waiting, nothing", () => {
    const out = inboxCandidates({ unhandledReplies: { count: 4 } }, { not_interested: 4 });
    expect(out.map((c) => c.title)).toEqual(["4 replies are waiting for an answer"]);
    expect(inboxCandidates({ unhandledReplies: { count: 0 } }, {})).toEqual([]);
  });
});

describe("a person's record", () => {
  const base = { id: 6842, hasEmail: true, repliesWaiting: 0, latestReplyClass: null, overdueTasks: 0, campaigns: [] as Array<{ name: string; status: string }> };

  it("a reply from them comes first, with how it was classified", () => {
    const out = personCandidates({ ...base, repliesWaiting: 1, latestReplyClass: "willing_to_meet", overdueTasks: 2, campaigns: [{ name: "Alpha", status: "replied" }] });
    expect(out.map((c) => c.kind)).toEqual(["person_reply", "person_tasks"]);
    expect(out[0].why).toBe("1 reply from them has not been handled; the latest was classified as willing to meet.");
    expect(out[1].title).toBe("2 tasks for this person are overdue");
    expect(out[1].action).toEqual({ type: "navigate", label: "Open overdue tasks", href: "/v2/tasks?view=overdue" });
  });

  it("waiting for approval is said; in no campaign is a question for Elsie that adds them to nothing", () => {
    const [w] = personCandidates({ ...base, campaigns: [{ name: "Alpha", status: "pending" }, { name: "Beta", status: "pending" }] });
    expect(w.why).toBe("They are in the approval queue of Alpha and 1 more; nothing is sent before approval.");
    const [none] = personCandidates(base);
    expect(none.title).toBe("This person is not in any campaign");
    expect(none.action).toMatchObject({ type: "ask" });
    expect((none.action as { prompt: string }).prompt).toContain("do not add them to anything yet");
    // No email, or already enrolled somewhere: nothing to say.
    expect(personCandidates({ ...base, hasEmail: false })).toEqual([]);
    expect(personCandidates({ ...base, campaigns: [{ name: "Alpha", status: "enrolled" }] })).toEqual([]);
  });
});

describe("every suggestion the rules can make", () => {
  const all: AssistCandidate[] = [
    ...homeCandidates({
      unhandledReplies: { count: 2 }, socialReplies: { count: 2 }, awaitingDrafts: { count: 2 }, proposedMeetings: { count: 2 },
      areApprovals: { count: 2, byCampaign: [{ campaignId: 1, name: "A", count: 2 }] }, routingSuggestions: { count: 2 }, campaignProposals: { count: 2 },
      pausedCampaigns: [{ id: 1, name: "A" }],
    }, { activeCampaigns: 0 }),
    ...["workspacePaused", "campaignNotActive", "windowClosed", "capUsed", "copyHeld", "noEmail", "unusableSequence", "noDossier", "enrichmentFailed", "prospectsPaused", "queueFull"]
      .flatMap((r) => campaignCandidates({ id: 1, name: "A", status: "paused" }, { topReason: r, gates: {}, sending: {} }, 2)),
    ...inboxCandidates({ unhandledReplies: { count: 5 }, socialReplies: { count: 1 } }, { willing_to_meet: 1, follow_up_question: 1, person_referral: 1 }),
    ...personCandidates({ id: 1, hasEmail: true, repliesWaiting: 1, latestReplyClass: "unsubscribe", overdueTasks: 1, campaigns: [{ name: "A", status: "pending" }] }),
    ...personCandidates({ id: 1, hasEmail: true, repliesWaiting: 0, latestReplyClass: null, overdueTasks: 0, campaigns: [] }),
  ];

  it("has a kind the pane can mute, and every kind is one the rules use", () => {
    expect(all.length).toBeGreaterThan(20);
    for (const c of all) expect(isAssistKind(c.kind), c.id).toBe(true);
    const used = new Set(all.map((c) => c.kind));
    expect(ASSIST_KIND_IDS.filter((k) => !used.has(k)), "a kind the pane offers to mute that no rule makes").toEqual([]);
  });

  it("opens a page the app has, or asks Elsie: never anything else", () => {
    const app = read("client/src/App.tsx");
    for (const c of all) {
      expect(["navigate", "ask"], c.id).toContain(c.action.type);
      expect(c.action.label.length, c.id).toBeGreaterThan(3);
      if (c.action.type === "navigate") {
        const path = c.action.href.split("?")[0];
        // A settings link must name a section the hub really has.
        const section = path.startsWith("/v2/settings/") ? path.slice("/v2/settings/".length) : null;
        const routed = section
          ? app.includes('path="/v2/settings/:section?"') && read("client/src/pages/usip/SettingsHub.tsx").includes(`{ id: "${section}", label: `)
          : app.includes(`path="${path}"`);
        expect(routed, `${c.id} → ${path}`).toBe(true);
      } else {
        expect(c.action.prompt.length, c.id).toBeGreaterThan(15);
      }
    }
  });

  it("gives a reason whose numbers are all in its facts", () => {
    for (const c of all) {
      const facts = new Set(Object.values(c.facts).flatMap((v) => (typeof v === "number" ? [v] : numbersIn(String(v)))));
      // "24 hours" is a fixed phrase, not a count.
      const loose = numbersIn(c.why).filter((x) => !facts.has(x) && !(x === 24 && c.why.includes("24 hours")));
      expect(loose, `${c.id}: "${c.why}"`).toEqual([]);
    }
  });
});

/* ─── Order, muting, and what a model may change ────────────────────────── */

describe("what is shown", () => {
  it("is the heaviest three, with muted kinds left out", () => {
    const list = [cand("a", 10), cand("b", 90), cand("c", 50, { kind: "drafts_to_review" }), cand("d", 70), cand("e", 60)];
    expect(ASSIST_MAX_SHOWN).toBe(3);
    expect(rankCandidates(list).map((c) => c.id)).toEqual(["b", "d", "e"]);
    expect(rankCandidates(list, { muted: ["replies_waiting"] }).map((c) => c.id)).toEqual(["c"]);
  });

  it("a number the facts do not hold makes a line ungrounded", () => {
    const c = cand("a", 1);
    expect(numbersIn("1,204 people and 3 more")).toEqual([1204, 3]);
    expect(wordingIsGrounded("Reply to all 7 today", c)).toBe(true);
    expect(wordingIsGrounded("Reply to the people waiting", c)).toBe(true);
    expect(wordingIsGrounded("Reply to all 12 today", c)).toBe(false);
    expect(wordingIsGrounded("7 replies, 3 of them urgent", c)).toBe(false);
  });

  it("a model's wording is used only where it is grounded, and it cannot add, drop or duplicate a suggestion", () => {
    const list = [cand("a", 3), cand("b", 2), cand("c", 1)];
    const out = applyWording(list, [
      { id: "c", title: "Clear the 7 replies first", why: "All 7 are still unanswered." },
      { id: "zzz", title: "Call your biggest customer", why: "They are about to churn, apparently." },
      { id: "a", title: "Answer 12 replies right now", why: "12 people are waiting on you today." },
      { id: "c", title: "Second take on the same 7", why: "Duplicates of an id are ignored." },
    ]);
    // The model's order, then what it left out.
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(out[0]).toMatchObject({ title: "Clear the 7 replies first", worded: true });
    // Invented number: the rule's own line.
    expect(out[1]).toMatchObject({ title: list[0].title, why: list[0].why, worded: false });
    expect(out[2].worded).toBe(false);
    // The button is the rule's, whatever came back, and no internals leak to the pane.
    for (const s of out) {
      expect(s.action).toEqual({ type: "navigate", label: "Open Inbox", href: "/v2/inbox" });
      expect(s).not.toHaveProperty("facts");
      expect(s).not.toHaveProperty("weight");
    }
    // Junk in, rules out.
    expect(applyWording(list, [null as never, { id: "a" } as never, { id: "b", title: "x", why: "y" }]).every((s) => !s.worded)).toBe(true);
  });

  it("the pane is closed until a user opens it, and stored settings are read back clean", () => {
    expect(cleanAssistPrefs(null)).toEqual({ open: false, muted: [] });
    expect(cleanAssistPrefs({ open: "yes" })).toEqual({ open: false, muted: [] });
    expect(cleanAssistPrefs({ open: true, muted: ["replies_waiting", "nonsense", "replies_waiting", 4] })).toEqual({ open: true, muted: ["replies_waiting"] });
  });
});

/* ─── The model pass: when it runs, and what it is given ────────────────── */

describe("the model pass", () => {
  const three = () => [cand("a", 3), cand("b", 2, { action: { type: "ask", label: "Ask Elsie", prompt: "SECRET PROMPT TEXT" } }), cand("c", 1)];
  const run = (candidates: AssistCandidate[], now = 1_000_000) => suggestionsFor({ db: fakeDb(), workspaceId: 7, candidates, muted: [], now });

  it("is skipped for a single suggestion and for none", async () => {
    const one = await run([cand("a", 1)]);
    expect(one.suggestions.map((s) => s.id)).toEqual(["a"]);
    expect((await run([])).suggestions).toEqual([]);
    expect(h.calls.length).toBe(0);
  });

  it("runs once for two or more, on the Fast-tier task, and is given the facts and nothing else", async () => {
    h.reply = () => ({ items: [{ id: "b", title: "Start with these 7 replies", why: "7 are waiting on you." }] });
    const out = await run(three());
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]).toMatchObject({ task: "assist", feature: ASSIST_FEATURE, workspaceId: 7 });
    expect(AI_TASKS.assist.defaultTier).toBe("fast");
    const sent = JSON.stringify(h.calls[0].messages);
    expect(sent).toContain("unhandledReplies");
    // No button, no page address, no prompt, no weight.
    for (const leak of ["SECRET PROMPT TEXT", "/v2/inbox", "Open Inbox", "weight", "navigate"]) expect(sent, leak).not.toContain(leak);
    expect(out.suggestions[0]).toMatchObject({ id: "b", title: "Start with these 7 replies", worded: true });
    expect(out.passes).toEqual({ used: 1, cap: ASSIST_DEFAULT_DAILY_CAP });
  });

  it("the same facts are never sent twice; changed facts are", async () => {
    h.reply = () => ({ items: [] });
    await run(three());
    await run(three(), 1_000_000 + 10 * 60_000);
    expect(h.calls.length).toBe(1);
    const changed = three();
    changed[0] = cand("a", 3, { facts: { unhandledReplies: 8 }, title: "Answer 8 replies (a)", why: "8 replies have not been handled." });
    expect(wordingKey(7, changed)).not.toBe(wordingKey(7, three()));
    await run(changed, 1_000_000 + 11 * 60_000);
    expect(h.calls.length).toBe(2);
    // Another workspace with the same facts is its own entry.
    expect(wordingKey(8, three())).not.toBe(wordingKey(7, three()));
  });

  it("stops at the workspace's daily number, and 0 turns it off; the rules' lines still show", async () => {
    h.row = { cap: 50, n: 50 };
    const full = await run(three());
    expect(h.calls.length).toBe(0);
    expect(full.suggestions.map((s) => s.worded)).toEqual([false, false, false]);
    expect(full.passes).toEqual({ used: 50, cap: 50 });

    h.row = { cap: 0, n: 0 };
    const off = await run(three());
    expect(h.calls.length).toBe(0);
    expect(off.suggestions.length).toBe(3);
    expect(off.passes.cap).toBe(0);
  });

  it("a model that fails or answers nonsense costs the user nothing: the rules' lines, and no retry for two minutes", async () => {
    h.reply = () => { throw new Error("This workspace has reached its monthly AI budget"); };
    const out = await run(three());
    expect(out.suggestions.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(out.suggestions.every((s) => !s.worded)).toBe(true);
    await run(three(), 1_000_000 + 60_000);
    expect(h.calls.length).toBe(1);
    await run(three(), 1_000_000 + 3 * 60_000);
    expect(h.calls.length).toBe(2);

    __resetAssistCacheForTests();
    h.calls = [];
    h.reply = () => "I would rather chat about the weather.";
    expect((await run(three())).suggestions.every((s) => !s.worded)).toBe(true);
  });
});

/* ─── What the code is allowed to do ────────────────────────────────────── */

describe("the pane changes nothing, and costs nothing while closed", () => {
  it("the endpoint that reads a page writes nothing, and the rules touch no database at all", () => {
    const svc = read("server/services/elsieAssist.ts");
    const build = svc.slice(svc.indexOf("export async function buildCandidates("), svc.indexOf("/* ─── The daily number of model passes"));
    expect(build.length).toBeGreaterThan(1500);
    expect(build).not.toMatch(/\.(insert|update|delete)\(/);
    const rules = read("server/services/elsieAssistRules.ts");
    expect(rules).not.toMatch(/getDb|drizzle|invokeLLM/);
    // Home and a campaign reuse the pages' own endpoints, so the pane and the page agree.
    expect(build).toContain("caller.attention.summary()");
    expect(build).toContain("caller.are.campaigns.stallReasons({ campaignId: id })");
    // Every read is scoped to the workspace.
    expect((build.match(/workspaceId, ws\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("only an admin sets the daily number; a user's settings are their own and not a column on users", () => {
    const r = read("server/routers/elsieAssist.ts");
    expect(r).toMatch(/\n  setDailyCap: adminWsProcedure/);
    expect(r).toMatch(/\n  get: workspaceProcedure/);
    const setPrefs = r.slice(r.indexOf("  setPrefs: workspaceProcedure"), r.indexOf("  /** `cap: null`"));
    expect(setPrefs).toContain("loadAssistPrefs(db, ctx.user.id)");
    expect(setPrefs).toContain("saveAssistPrefs(db, ctx.user.id, next)");
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('export const elsieAssistPrefs = mysqlTable("elsie_assist_prefs", {');
    const usersTable = schema.slice(schema.indexOf("export const users = mysqlTable("), schema.indexOf("export const", schema.indexOf("export const users = mysqlTable(") + 20));
    expect(usersTable).not.toMatch(/elsie_?assist/i);
    const mig = read("server/_core/rawMigrations.ts");
    const block = mig.slice(mig.indexOf('name: "0442_elsie_assist.sql"')).slice(0, 700);
    expect(block).toContain("CREATE TABLE IF NOT EXISTS `elsie_assist_prefs`");
    expect(block).toContain("ALTER TABLE `workspace_settings` ADD COLUMN `elsieAssistDailyCap` int NULL");
    expect(read("server/routers.ts")).toContain("elsieAssist: elsieAssistRouter,");
  });

  it("the pane asks for suggestions only while open on a page it knows, and its buttons only open a page or ask Elsie", () => {
    const pane = read("client/src/components/usip/ElsieAssistPane.tsx");
    expect(pane).toContain("{ enabled: open && !!here, staleTime: 60_000, retry: false, meta: { silentError: true } }");
    expect(pane).toContain("if (!open) return null;");
    const act = pane.slice(pane.indexOf("const act = (s: AssistSuggestion) => {"), pane.indexOf("return (", pane.indexOf("const act = (s: AssistSuggestion) => {")));
    expect(act).toContain('if (s.action.type === "navigate") navigate(s.action.href);');
    expect(act).toContain("else assistantStore.ask(s.action.prompt);");
    // No mutation in the pane reaches anything but its own settings.
    const mutations = Array.from(pane.matchAll(/trpc\.(\w+)\.(\w+)\.useMutation/g)).map((m) => `${m[1]}.${m[2]}`);
    expect(Array.from(new Set(mutations)).sort()).toEqual(["elsieAssist.setDailyCap", "elsieAssist.setPrefs"]);
    // It is a column of the Shell, with its button beside Elsie's.
    const shell = read("client/src/components/usip/Shell.tsx");
    expect(shell).toContain("<ElsieAssistPane />");
    expect(shell).toMatch(/<ElsieButton \/>\s*\{\/\*[^*]*\*\/\}\s*<ElsieAssistButton \/>/);
    // Closed is the starting state on a browser that has never seen it.
    const store = read("client/src/lib/assistPaneStore.ts");
    expect(store).toContain('return localStorage.getItem(STORAGE_KEY) === "1";');
  });

  it("a request handed to the chat is sent once, and still goes through the chat's own confirm cards", () => {
    const chat = read("client/src/components/usip/AssistantChat.tsx");
    const effect = chat.slice(chat.indexOf("if (!pendingPrompt || loading) return;"), chat.indexOf("async function runPending("));
    expect(effect.indexOf("assistantStore.clearPendingPrompt();")).toBeGreaterThan(-1);
    expect(effect.slice(effect.indexOf("assistantStore.clearPendingPrompt();"))).toContain("void send(pendingPrompt);");
    expect(read("client/src/lib/assistantStore.ts")).toContain("ask: (prompt: string) => set({ open: true, pendingPrompt: prompt }),");
  });
});
