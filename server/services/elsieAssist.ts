/**
 * Elsie Assist, server side: read the records a page is about, hand them to
 * the rules (elsieAssistRules.ts), and optionally have a model order and
 * reword what the rules picked. shared/elsieAssist.ts has the why.
 *
 * Three costs are held down here, because a pane that is open all day asks
 * on every page:
 *
 *   - The records come from counts and the endpoints the pages already use.
 *   - The model is asked only when there are two or more suggestions to order
 *     and word, on the workspace's Fast tier (task "assist").
 *   - Its answer is cached against the facts it was given, so going back to a
 *     page whose facts have not changed asks nothing, and a workspace has a
 *     daily number of model passes (workspace_settings.elsieAssistDailyCap).
 *     Past it, or when the model fails, the rules' own lines are shown.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { areCampaigns, elsieAssistPrefs, emailReplies, prospectQueue, prospects, spendLedger, tasks, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { contentText, invokeLLM, jsonFromText } from "../_core/llm";
import { genuineReplyScope } from "./replyScope";
import { spendDay } from "./spend";
import { WORKABLE_TASK_STATUSES } from "@shared/taskRules";
import {
  ASSIST_DAILY_CAP_MAX,
  ASSIST_DEFAULT_DAILY_CAP,
  ASSIST_MAX_SHOWN,
  applyWording,
  cleanAssistPrefs,
  rankCandidates,
  type AssistCandidate,
  type AssistPlace,
  type AssistPrefs,
  type AssistSuggestion,
  type AssistWording,
} from "@shared/elsieAssist";
import {
  campaignCandidates,
  homeCandidates,
  inboxCandidates,
  personCandidates,
  type AttentionFacts,
  type StallFacts,
} from "./elsieAssistRules";

export const ASSIST_FEATURE = "elsieAssist";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The two endpoints the pane reuses, so it can never disagree with Home or a campaign's own page. */
export type AssistCaller = {
  attention: { summary: () => Promise<unknown> };
  are: { campaigns: { stallReasons: (input: { campaignId: number }) => Promise<unknown> } };
};

const num = (v: unknown) => Number(v ?? 0) || 0;

/* ─── Candidates ────────────────────────────────────────────────────────── */

export async function buildCandidates(args: {
  db: Db;
  workspaceId: number;
  /** Whose pane this is: a person's overdue tasks are counted as the Tasks page counts them, the user's own. */
  userId: number;
  caller: AssistCaller;
  place: AssistPlace;
  id: number | null;
  now?: Date;
}): Promise<AssistCandidate[]> {
  const { db, workspaceId: ws, caller, place, id } = args;

  if (place === "home") {
    const [summary, [active]] = await Promise.all([
      caller.attention.summary() as Promise<AttentionFacts>,
      db.select({ n: sql<number>`count(*)` }).from(areCampaigns)
        .where(and(eq(areCampaigns.workspaceId, ws), eq(areCampaigns.status, "active"), isNull(areCampaigns.archivedAt))),
    ]);
    return homeCandidates(summary, { activeCampaigns: num(active?.n) });
  }

  if (place === "inbox") {
    const [summary, classes] = await Promise.all([
      caller.attention.summary() as Promise<AttentionFacts>,
      db.select({ cls: emailReplies.replyClass, n: sql<number>`count(*)` }).from(emailReplies)
        .where(and(eq(emailReplies.workspaceId, ws), genuineReplyScope(), isNull(emailReplies.handledAt)))
        .groupBy(emailReplies.replyClass),
    ]);
    const byClass: Record<string, number> = {};
    for (const r of classes) if (r.cls) byClass[r.cls] = num(r.n);
    return inboxCandidates(summary, byClass);
  }

  if (place === "campaign" && id) {
    const [campaign] = await db
      .select({ id: areCampaigns.id, name: areCampaigns.name, status: areCampaigns.status })
      .from(areCampaigns)
      .where(and(eq(areCampaigns.id, id), eq(areCampaigns.workspaceId, ws)))
      .limit(1);
    if (!campaign) return [];
    const [stall, [approvals]] = await Promise.all([
      // The page's own panel reads this; if it fails the page says so, and the
      // pane simply has nothing to add about what blocks the campaign.
      (caller.are.campaigns.stallReasons({ campaignId: id }) as Promise<StallFacts>).catch(() => null),
      db.select({ n: sql<number>`count(*)` }).from(prospectQueue)
        .where(and(
          eq(prospectQueue.workspaceId, ws),
          eq(prospectQueue.campaignId, id),
          eq(prospectQueue.sequenceStatus, "pending"),
          eq(prospectQueue.enrichmentStatus, "complete"),
        )),
    ]);
    return campaignCandidates(campaign, stall, num(approvals?.n));
  }

  if (place === "person" && id) {
    const [person] = await db
      .select({ id: prospects.id, email: prospects.email })
      .from(prospects)
      .where(and(eq(prospects.id, id), eq(prospects.workspaceId, ws)))
      .limit(1);
    if (!person) return [];
    const email = (person.email ?? "").trim();
    const waiting = and(eq(emailReplies.workspaceId, ws), eq(emailReplies.prospectId, id), genuineReplyScope(), isNull(emailReplies.handledAt));
    const [[replyAgg], [latest], [overdue], campaigns] = await Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(emailReplies).where(waiting),
      db.select({ cls: emailReplies.replyClass }).from(emailReplies).where(waiting).orderBy(desc(emailReplies.receivedAt)).limit(1),
      db.select({ n: sql<number>`count(*)` }).from(tasks)
        .where(and(
          eq(tasks.workspaceId, ws),
          eq(tasks.ownerUserId, args.userId),
          eq(tasks.relatedType, "prospect"),
          eq(tasks.relatedId, id),
          // Overdue as the Tasks page's Overdue view has it (shared/taskRules):
          // still to be done, and due before now.
          inArray(tasks.status, [...WORKABLE_TASK_STATUSES]),
          lt(tasks.dueAt, args.now ?? new Date()),
        )),
      email
        ? db.select({ name: areCampaigns.name, status: prospectQueue.sequenceStatus })
            .from(prospectQueue)
            .innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId)))
            .where(and(
              eq(prospectQueue.workspaceId, ws),
              eq(prospectQueue.email, email),
              notInArray(prospectQueue.sequenceStatus, ["skipped", "canceled"]),
            ))
            .limit(10)
        : Promise.resolve([] as Array<{ name: string; status: string }>),
    ]);
    return personCandidates({
      id,
      hasEmail: !!email,
      repliesWaiting: num(replyAgg?.n),
      latestReplyClass: latest?.cls ?? null,
      overdueTasks: num(overdue?.n),
      campaigns: campaigns.map((c) => ({ name: c.name, status: String(c.status) })),
    });
  }

  return [];
}

/* ─── The daily number of model passes ──────────────────────────────────── */

/** The workspace's own number, else the default. Fails to the default: a missing column must not stop the pane. */
export async function assistDailyCap(db: Db, workspaceId: number): Promise<number> {
  try {
    const [row] = await db
      .select({ cap: workspaceSettings.elsieAssistDailyCap })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    const cap = row?.cap;
    if (cap === null || cap === undefined) return ASSIST_DEFAULT_DAILY_CAP;
    return Math.max(0, Math.min(ASSIST_DAILY_CAP_MAX, Math.floor(Number(cap) || 0)));
  } catch {
    return ASSIST_DEFAULT_DAILY_CAP;
  }
}

/** Model passes the pane has made for this workspace today (UTC), from the spend ledger every call is recorded in. */
export async function assistPassesToday(db: Db, workspaceId: number): Promise<number> {
  try {
    const [row] = await db
      .select({ n: sql<number>`coalesce(sum(${spendLedger.calls}), 0)` })
      .from(spendLedger)
      .where(and(
        eq(spendLedger.workspaceId, workspaceId),
        eq(spendLedger.day, spendDay()),
        eq(spendLedger.feature, ASSIST_FEATURE),
        // One row per meter per call; every call has input tokens.
        eq(spendLedger.meter, "input_tokens"),
      ));
    return num(row?.n);
  } catch {
    return 0;
  }
}

/* ─── Wording ───────────────────────────────────────────────────────────── */

const WORDING_TTL_MS = 30 * 60_000;
const FAILED_TTL_MS = 2 * 60_000;
const wordingCache = new Map<string, { at: number; ttl: number; wording: AssistWording[] }>();

export function __resetAssistCacheForTests(): void {
  wordingCache.clear();
}

/** The same facts, the same key: titles, reasons and facts of the candidates shown, in order. */
export function wordingKey(workspaceId: number, shown: AssistCandidate[]): string {
  const body = JSON.stringify(shown.map((c) => [c.id, c.title, c.why, c.facts]));
  return `${workspaceId}:${createHash("sha1").update(body).digest("hex")}`;
}

const SYSTEM = `You are Elsie, the guide inside a B2B sales app. You are given a short list of things the user could do next. Each has an id, a title, a reason and the facts the reason rests on.

Put them in the order the user should do them, and rewrite each title and reason in plain, direct words.

Rules:
- Use only what is in the item. Do not add a number, a name, a date or a claim that is not in its title, reason or facts.
- Keep every number exactly as given.
- Title: what to do, under 90 characters. Reason: why, from the facts, one sentence under 180 characters.
- Do not describe where anything is on a page, and do not mention buttons.
- Return every id you were given, once.`;

const SCHEMA = {
  name: "assist_wording",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string" }, why: { type: "string" } },
          required: ["id", "title", "why"],
        },
      },
    },
    required: ["items"],
  },
};

export type WordedResult = { suggestions: AssistSuggestion[]; passes: { used: number; cap: number } };

/**
 * The suggestions to show: the rules' top few, ordered and reworded by a
 * model when that is allowed and worth a call, and the rules' own lines
 * otherwise.
 */
export async function suggestionsFor(args: {
  db: Db;
  workspaceId: number;
  candidates: AssistCandidate[];
  muted: readonly string[];
  now?: number;
}): Promise<WordedResult> {
  const { db, workspaceId } = args;
  const now = args.now ?? Date.now();
  const shown = rankCandidates(args.candidates, { muted: args.muted, max: ASSIST_MAX_SHOWN });
  const [cap, usedBefore] = await Promise.all([assistDailyCap(db, workspaceId), assistPassesToday(db, workspaceId)]);
  const plain = (used: number): WordedResult => ({ suggestions: applyWording(shown, []), passes: { used, cap } });

  // One suggestion needs no ordering, and its own line is already plain.
  if (shown.length < 2) return plain(usedBefore);

  const key = wordingKey(workspaceId, shown);
  const hit = wordingCache.get(key);
  if (hit && now - hit.at < hit.ttl) return { suggestions: applyWording(shown, hit.wording), passes: { used: usedBefore, cap } };
  if (cap <= 0 || usedBefore >= cap) return plain(usedBefore);

  let wording: AssistWording[] = [];
  let ttl = WORDING_TTL_MS;
  try {
    const res = await invokeLLM({
      task: "assist",
      feature: ASSIST_FEATURE,
      workspaceId,
      maxTokens: 500,
      outputSchema: SCHEMA,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(shown.map((c) => ({ id: c.id, title: c.title, reason: c.why, facts: c.facts }))) },
      ],
    });
    const json = jsonFromText(contentText(res.choices[0]?.message?.content as never));
    const items = json ? (JSON.parse(json) as { items?: unknown }).items : null;
    if (Array.isArray(items)) wording = items as AssistWording[];
    else ttl = FAILED_TTL_MS;
  } catch (err) {
    // Budget reached, rate limit, provider down: the rules' lines are shown, and
    // the same facts are not sent again for a couple of minutes.
    console.warn(`[elsieAssist] wording failed for workspace ${workspaceId}; showing the rules' own lines:`, err instanceof Error ? err.message : String(err));
    ttl = FAILED_TTL_MS;
  }
  wordingCache.set(key, { at: now, ttl, wording });
  if (wordingCache.size > 500) {
    for (const [k, v] of Array.from(wordingCache.entries())) if (now - v.at >= v.ttl) wordingCache.delete(k);
  }
  return { suggestions: applyWording(shown, wording), passes: { used: usedBefore + 1, cap } };
}

/* ─── A user's own settings for the pane ────────────────────────────────── */

/** Fails to "closed, nothing muted": a missing column must not break the shell that asks. */
export async function loadAssistPrefs(db: Db, userId: number): Promise<AssistPrefs> {
  try {
    const [row] = await db.select({ prefs: elsieAssistPrefs.prefs }).from(elsieAssistPrefs).where(eq(elsieAssistPrefs.userId, userId)).limit(1);
    return cleanAssistPrefs(row?.prefs);
  } catch {
    return cleanAssistPrefs(null);
  }
}

export async function saveAssistPrefs(db: Db, userId: number, prefs: AssistPrefs): Promise<void> {
  const clean = cleanAssistPrefs(prefs);
  await db.insert(elsieAssistPrefs).values({ userId, prefs: clean }).onDuplicateKeyUpdate({ set: { prefs: clean } });
}
