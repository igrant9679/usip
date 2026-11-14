/**
 * sendingStatus.ts — what is stopping sends right now, in one read (audit
 * 2026-10-20, U1), for the status bar on Sequences, Emails, Mailbox,
 * Meetings, Social and the Revenue Engine.
 *
 * Sends held by the pause, the send window, a LinkedIn limit or a cap used to
 * fail as bare toasts, or wait silently. This reads the SAME sources the
 * senders ask, and changes nothing:
 *   · the outbound pause and the workspace send window (services/sendWindow,
 *     what outboundPause and the engines read);
 *   · each LinkedIn account's gate (services/linkedin/activityGate, what every
 *     LinkedIn action asks);
 *   · the workspace daily email cap (sendLimits, what every email send asks);
 *   · Apollo's daily record cap (services/apollo) and the prospect sources'
 *     budget ledger, which hold discovery.
 * Display only: nothing here sends, schedules or spends.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { prospectSourceBudgetLedger, unipileAccounts, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { getWorkspaceSendWindow } from "./sendWindow";
import { checkLinkedInAction } from "./linkedin/activityGate";
import { getWorkspaceSentToday } from "../sendLimits";
import { apolloPulledToday, getApolloDailyCap } from "./apollo";
import { linkedKey } from "./keyShares";
import { isWithinSendWindow, nextSendWindowOpening } from "@shared/sendWindow";
import type { BlockReason } from "@shared/linkedinLimits";

export type SendingSurface = "sequences" | "emails" | "mailbox" | "meetings" | "social" | "are";
export const ALL_SURFACES: SendingSurface[] = ["sequences", "emails", "mailbox", "meetings", "social", "are"];
/** Where automatic sends live: the window holds them, not what a person sends. */
const AUTOMATIC: SendingSurface[] = ["sequences", "emails", "meetings", "social", "are"];

export type SendBlock = {
  key: string;
  /** "Outbound paused", "Outside send window (opens 6:00 AM EST)", "LinkedIn paused", "Apollo cap reached". */
  label: string;
  /** What it holds, and how it ends. */
  detail: string;
  /** stop: nothing goes until someone changes it; wait: it lifts by itself. */
  tone: "stop" | "wait";
  surfaces: SendingSurface[];
  href?: string;
};

/** The workspace's daily cap for manual and sequence email when none is set (sendLimits). */
const DEFAULT_WORKSPACE_DAILY_CAP = 100;

function opensAt(ms: number, tz: string, nowMs: number): string {
  const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms)) === new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(nowMs));
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...(sameDay ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
}

const LINKEDIN_LABEL: Record<BlockReason, string> = {
  disabled: "LinkedIn paused",
  outside_hours: "LinkedIn outside its working hours",
  outside_days: "LinkedIn outside its working days",
  spacing: "LinkedIn spacing out actions",
  daily_kind_cap: "LinkedIn daily limit reached",
  weekly_invite_cap: "LinkedIn weekly invite limit reached",
  daily_action_cap: "LinkedIn daily limit reached",
};

export async function sendingStatus(workspaceId: number, now: Date = new Date()): Promise<{ blocks: SendBlock[]; checkedAt: string; timezone: string }> {
  const nowMs = now.getTime();
  const blocks: SendBlock[] = [];
  const sw = await getWorkspaceSendWindow(workspaceId, nowMs);

  /* The pause and the window (services/sendWindow). */
  if (sw.paused) {
    blocks.push({
      key: "outbound_paused", label: "Outbound paused", tone: "stop", surfaces: [...ALL_SURFACES],
      detail: "Nothing goes to prospects, automatic or by hand, until it is switched off in Settings → Workspace overview → Send window.",
      href: "/v2/settings/workspace",
    });
  } else if (!isWithinSendWindow(nowMs, sw.timezone, sw.window)) {
    const next = nextSendWindowOpening(nowMs, sw.timezone, sw.window);
    blocks.push({
      key: "outside_window", tone: "wait", surfaces: [...AUTOMATIC],
      label: next !== null ? `Outside send window (opens ${opensAt(next, sw.timezone, nowMs)})` : "Outside send window",
      detail: "Automatic sends (Revenue Engine, sequence auto-send, LinkedIn steps, meeting invites) wait for the window; what a person sends goes now.",
      href: "/v2/settings/workspace",
    });
  }

  const db = await getDb();
  if (!db) return { blocks, checkedAt: now.toISOString(), timezone: sw.timezone };

  /* LinkedIn: held only when no connected account may invite or message now. */
  try {
    const accounts = await db.select({ id: unipileAccounts.unipileAccountId }).from(unipileAccounts)
      .where(and(eq(unipileAccounts.workspaceId, workspaceId), eq(unipileAccounts.provider, "LINKEDIN")));
    if (accounts.length) {
      let firstBlock: { reason: BlockReason; message: string } | null = null;
      let anyAllowed = false;
      for (const a of accounts) {
        for (const kind of ["invite", "message"] as const) {
          const v = await checkLinkedInAction({ workspaceId, unipileAccountId: a.id, kind, now });
          // Spacing lifts within minutes; it is not what is stopping LinkedIn.
          if (v.allowed || v.reason === "spacing") { anyAllowed = true; break; }
          if (!firstBlock && v.reason) firstBlock = { reason: v.reason, message: v.message };
        }
        if (anyAllowed) break;
      }
      if (!anyAllowed && firstBlock) {
        blocks.push({
          key: "linkedin", label: LINKEDIN_LABEL[firstBlock.reason], tone: firstBlock.reason === "disabled" ? "stop" : "wait",
          surfaces: ["sequences", "social", "are"],
          detail: `${firstBlock.message}${accounts.length > 1 ? ` (every one of ${accounts.length} accounts is held)` : ""} LinkedIn steps wait until an account may act.`,
          href: "/settings/linkedin-limits",
        });
      }
    }
  } catch (e) {
    console.warn("[sendingStatus] LinkedIn check failed:", (e as Error)?.message ?? e);
  }

  /* The workspace's daily cap for manual and sequence email (sendLimits). */
  try {
    const [s] = await db.select({ cap: workspaceSettings.areDefaultDailySendCap }).from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
    const cap = s?.cap ?? DEFAULT_WORKSPACE_DAILY_CAP;
    // The day is the one `now` falls in (2026-11-13: these read the real
    // clock, so a caller's `now` on another day counted the wrong day's sends).
    const sent = await getWorkspaceSentToday(workspaceId, now);
    if (sent >= cap) {
      blocks.push({
        key: "email_cap", label: `Daily send cap reached (${sent}/${cap})`, tone: "wait",
        surfaces: ["sequences", "emails", "mailbox"],
        detail: "Manual and sequence email stops for today; it starts again tomorrow, or raise the Daily Send Cap in Revenue Engine settings.",
        href: "/are/settings",
      });
    }
  } catch (e) {
    console.warn("[sendingStatus] cap check failed:", (e as Error)?.message ?? e);
  }

  /* Discovery caps: Apollo's daily record cap, and the source ledger's. */
  try {
    const [configured] = await db.select({ n: sql<number>`count(*)` }).from(workspaceSettings)
      .where(and(eq(workspaceSettings.workspaceId, workspaceId), isNotNull(workspaceSettings.apolloApiKeyEnc)));
    // Its own Apollo key, or one another workspace lends it (services/keyShares).
    if (Number(configured?.n ?? 0) > 0 || (await linkedKey(workspaceId, "apollo"))) {
      const [cap, used] = await Promise.all([getApolloDailyCap(workspaceId), apolloPulledToday(workspaceId, now)]);
      if (used >= cap) {
        blocks.push({
          key: "apollo_cap", label: "Apollo cap reached", tone: "wait", surfaces: ["are"],
          detail: `Apollo's daily record cap is used (${used}/${cap}); Find prospects and campaign discovery take no more Apollo records until midnight UTC.`,
          href: "/are/settings",
        });
      }
    }
    const rows = await db.select().from(prospectSourceBudgetLedger)
      .where(and(eq(prospectSourceBudgetLedger.workspaceId, workspaceId), isNotNull(prospectSourceBudgetLedger.unitsLimit)));
    const credits = new Map<string, number>();
    for (const r of rows) {
      if (r.granularity !== "credits") continue;
      const k = `${r.sourceSlug}|${r.bucket}`;
      credits.set(k, (credits.get(k) ?? 0) + Math.max(0, (r.unitsLimit ?? 0) - r.unitsConsumed - r.unitsReserved));
    }
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.granularity === "credits" || r.unitsLimit == null) continue;
      // The current period only: a row whose period has rolled is history.
      if (!r.resetsAt || new Date(r.resetsAt).getTime() <= nowMs) continue;
      if (r.unitsConsumed + r.unitsReserved < r.unitsLimit) continue;
      if ((credits.get(`${r.sourceSlug}|${r.bucket}`) ?? 0) > 0) continue;
      if (seen.has(r.sourceSlug)) continue;
      seen.add(r.sourceSlug);
      const name = SOURCE_NAMES[r.sourceSlug] ?? r.sourceSlug;
      blocks.push({
        key: `source_cap:${r.sourceSlug}`, label: `${name} cap reached`, tone: "wait", surfaces: ["are"],
        detail: `${name}'s ${r.granularity} allowance is used (${r.unitsConsumed + r.unitsReserved}/${r.unitsLimit}); it resets ${opensAt(new Date(r.resetsAt).getTime(), sw.timezone, nowMs)}.`,
        href: "/v2/settings/data-sources",
      });
    }
  } catch (e) {
    console.warn("[sendingStatus] source caps check failed:", (e as Error)?.message ?? e);
  }

  return { blocks, checkedAt: now.toISOString(), timezone: sw.timezone };
}

/** Display names for the ledger's sources (the registry's, without loading every adapter). */
const SOURCE_NAMES: Record<string, string> = {
  apollo: "Apollo", warmysender: "WarmySender", leadocean: "LeadOcean", quickenrich: "QuickEnrich",
  reoon: "Reoon", hunter: "Hunter", lemlist: "lemlist",
};

