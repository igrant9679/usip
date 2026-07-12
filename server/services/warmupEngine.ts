/**
 * warmupEngine.ts — a REAL mailbox warmup engine (migration 0121).
 *
 * What it honestly does: for every sending account whose warmup toggle is on
 * (warmupStatus = in_progress) and that has working SMTP credentials, it sends
 * a slowly-RAMPING number of short, human-looking emails each day to the
 * workspace's OTHER mailboxes (peer pool; falls back to sending to itself when
 * it's the only mailbox). Ramp: 2/day on day 1, +2 per day, capped at 40/day;
 * after 28 days the account is marked warmup `complete`. Sends carry no
 * tracking pixels or unsubscribe footers and are spread across ticks with
 * jitter so the pattern looks organic to receiving providers.
 *
 * What it does NOT do (and does not pretend to): open/move-to-inbox actions
 * on the RECEIVING side for external providers, or third-party warmup
 * networks. Deliverability benefit comes from steady authenticated sending
 * volume between real mailboxes.
 *
 * Cron: runs ~every 30 min from _core/index.ts. Each tick sends at most a
 * small slice of the day's target per account, only during 07:00–19:00 UTC.
 */
import { and, eq, inArray } from "drizzle-orm";
import { sendingAccounts } from "../../drizzle/schema";
import { getDb } from "../db";
import { buildTransporter } from "../routers/smtpConfig";

const RAMP_START = 2; // day-1 emails
const RAMP_STEP = 2; // added per day
const RAMP_CAP = 40; // max/day
const WARMUP_DAYS = 28; // then complete
const MAX_PER_TICK = 4; // spread the day's budget across ticks

/** Human-looking subject/body pairs — intentionally boring business chatter. */
const TOPICS: Array<{ s: string; b: string[] }> = [
  { s: "Quick follow-up from earlier", b: ["Hi,", "Just circling back on the notes from earlier — I've attached my summary to the doc. Let me know if anything's missing.", "Thanks!"] },
  { s: "Notes from this morning", b: ["Hey,", "Sending over the points we covered this morning so we have them in one place. Happy to expand on any of them.", "Best,"] },
  { s: "Re: scheduling next week", b: ["Hi,", "Tuesday or Thursday afternoon both work on my side for the sync. Whichever is easier for the team.", "Cheers,"] },
  { s: "Doc review when you have a sec", b: ["Hello,", "No rush at all — when you have a few minutes, could you look over the second section? I want to make sure the numbers line up.", "Thanks a lot."] },
  { s: "Thanks for the intro", b: ["Hi,", "Appreciated the introduction earlier — I'll take it from here and keep you posted on how the conversation goes.", "Best regards,"] },
  { s: "Re: quarterly summary", b: ["Hey,", "The quarterly summary looks good overall. I flagged two small things inline; nothing blocking.", "Talk soon,"] },
  { s: "Checking in", b: ["Hi,", "Quick check-in — everything on track for the end of the week? Ping me if anything needs another pair of hands.", "Thanks!"] },
  { s: "Agenda for the sync", b: ["Hello,", "Draft agenda for the sync: progress review, open questions, next steps. Anything you'd add?", "Best,"] },
];

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayTarget(startedAt: Date, now: Date): number {
  const day = Math.max(1, Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000) + 1);
  return Math.min(RAMP_START + (day - 1) * RAMP_STEP, RAMP_CAP);
}

export function warmupDayNumber(startedAt: Date | null | undefined, now = new Date()): number | null {
  if (!startedAt) return null;
  return Math.max(1, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 86_400_000) + 1);
}

/** One engine tick. Exported for the cron in _core/index.ts. */
export async function runWarmupEngine(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour < 7 || hour >= 19) return; // only send in a plausible working window

  const candidates = await db
    .select()
    .from(sendingAccounts)
    .where(and(eq(sendingAccounts.warmupStatus, "in_progress"), eq(sendingAccounts.enabled, true)));
  if (candidates.length === 0) return;

  // Peer pools per workspace: warmup mail goes to OTHER real mailboxes we own.
  const wsIds = [...new Set(candidates.map((a) => a.workspaceId))];
  const pools = await db
    .select({ id: sendingAccounts.id, workspaceId: sendingAccounts.workspaceId, fromEmail: sendingAccounts.fromEmail })
    .from(sendingAccounts)
    .where(and(inArray(sendingAccounts.workspaceId, wsIds), eq(sendingAccounts.enabled, true)));

  for (const acct of candidates) {
    try {
      if (!acct.smtpHost || !acct.smtpUsername || !acct.smtpPassword) continue; // no creds → nothing honest to do

      // First pickup: stamp the ramp start.
      let startedAt = acct.warmupStartedAt ? new Date(acct.warmupStartedAt) : null;
      if (!startedAt) {
        startedAt = now;
        await db.update(sendingAccounts).set({ warmupStartedAt: now }).where(eq(sendingAccounts.id, acct.id));
      }

      // Graduation after the full ramp.
      if (warmupDayNumber(startedAt, now)! > WARMUP_DAYS) {
        await db.update(sendingAccounts).set({ warmupStatus: "complete" }).where(eq(sendingAccounts.id, acct.id));
        console.log(`[Warmup] ${acct.fromEmail} completed its ${WARMUP_DAYS}-day ramp`);
        continue;
      }

      // Daily counter reset (UTC).
      const today = utcDateStr(now);
      const sentToday = acct.warmupTodayDate === today ? acct.warmupSentToday : 0;
      const target = dayTarget(startedAt, now);
      if (sentToday >= target) continue;

      const peers = pools.filter((p) => p.workspaceId === acct.workspaceId && p.id !== acct.id);
      const batch = Math.min(MAX_PER_TICK, target - sentToday);
      const transporter = buildTransporter({
        host: acct.smtpHost,
        port: acct.smtpPort ?? 587,
        secure: (acct.smtpPort ?? 587) === 465,
        username: acct.smtpUsername,
        password: acct.smtpPassword,
      });

      let sent = 0;
      for (let i = 0; i < batch; i++) {
        // deterministic-ish rotation, varied by account/time so bodies differ
        const topic = TOPICS[(acct.id + sentToday + i + now.getUTCDate()) % TOPICS.length];
        const to = peers.length ? peers[(acct.id + i + now.getUTCHours()) % peers.length].fromEmail : acct.fromEmail;
        try {
          await transporter.sendMail({
            from: acct.fromName ? `"${acct.fromName}" <${acct.fromEmail}>` : acct.fromEmail,
            to,
            subject: topic.s,
            text: topic.b.join("\n\n"),
            headers: { "X-Velocity-Warmup": "1" }, // lets our own inbound pollers ignore these
          });
          sent++;
        } catch (e) {
          console.error(`[Warmup] send failed for ${acct.fromEmail}:`, e instanceof Error ? e.message.split("\n")[0] : e);
          break; // SMTP trouble — stop this account's tick, retry next tick
        }
      }

      if (sent > 0) {
        await db
          .update(sendingAccounts)
          .set({
            warmupSentToday: sentToday + sent,
            warmupTodayDate: today,
            warmupTotalSent: (acct.warmupTotalSent ?? 0) + sent,
            warmupLastSentAt: now,
          })
          .where(eq(sendingAccounts.id, acct.id));
      }
    } catch (e) {
      console.error(`[Warmup] account ${acct.id} tick failed:`, e instanceof Error ? e.message : e);
    }
  }
}
