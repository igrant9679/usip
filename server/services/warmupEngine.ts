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
 * Cron: runs ~every 30 min from _core/index.ts (overlap-guarded). Each tick
 * sends at most a small slice of the day's target per account, only during
 * 07:00–19:00 IN THE WORKSPACE'S OWN TIMEZONE.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { sendingAccounts } from "../../drizzle/schema";
import { getDb } from "../db";
import { buildTransporter } from "../routers/smtpConfig";
import { utcDayStart } from "@shared/timeWindows";
import { zonedDowHour } from "@shared/availability";
import { getWorkspaceTimezone } from "./workspaceTimezone";

const RAMP_START = 2; // day-1 emails
const RAMP_STEP = 2; // added per day
const RAMP_CAP = 40; // max/day
const WARMUP_DAYS = 28; // then complete
const MAX_PER_TICK = 4; // spread the day's budget across ticks
/** Working-hours window, in the WORKSPACE's timezone (not the container's). */
const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 19;

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

/**
 * Which day of the ramp we are on, counted in UTC CALENDAR days.
 *
 * ⚠️ This used to be `floor((now - startedAt) / 86_400_000) + 1` — a rolling
 * 24-hour window from whenever the engine first picked the account up. The daily
 * counter beside it (`warmupTodayDate`) has always been a UTC calendar day, so
 * the same cap was measured against TWO DIFFERENT CLOCKS:
 *
 *   account first seen 18:00 UTC → day 1, target 2, sends 2
 *   00:00 UTC          → warmupTodayDate rolls over, warmupSentToday resets to 0
 *   00:00–18:00 UTC    → the rolling clock still says day 1, so target is still 2
 *                        ⇒ another 2 sends. Day 1 delivers 4, not 2.
 *
 * Same shape as the cadence sweep's finding (fa246a5): one budget, two
 * boundaries. The ramp is a rate limit, so it must advance on the same boundary
 * the counter resets on — utcDayStart from @shared/timeWindows, the repo's one
 * definition of a UTC day.
 */
export function warmupDayNumber(startedAt: Date | null | undefined, now = new Date()): number | null {
  if (!startedAt) return null;
  const from = utcDayStart(new Date(startedAt).getTime()).getTime();
  const to = utcDayStart(now.getTime()).getTime();
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

export function dayTarget(startedAt: Date, now: Date): number {
  const day = warmupDayNumber(startedAt, now) ?? 1;
  return Math.min(RAMP_START + (day - 1) * RAMP_STEP, RAMP_CAP);
}

/** One engine tick. Exported for the cron in _core/index.ts. */
export async function runWarmupEngine(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date();

  const candidates = await db
    .select()
    .from(sendingAccounts)
    .where(and(eq(sendingAccounts.warmupStatus, "in_progress"), eq(sendingAccounts.enabled, true)));
  if (candidates.length === 0) return;

  // Peer pools per workspace: warmup mail goes to OTHER mailboxes we own —
  // but ONLY connection-VERIFIED ones. CSV-imported accounts can carry fake
  // addresses; bouncing warmup mail at those would hurt reputation, the exact
  // opposite of warming. Unverified-peer workspaces fall back to self-send.
  const wsIds = [...new Set(candidates.map((a) => a.workspaceId))];
  const pools = await db
    .select({ id: sendingAccounts.id, workspaceId: sendingAccounts.workspaceId, fromEmail: sendingAccounts.fromEmail })
    .from(sendingAccounts)
    .where(and(
      inArray(sendingAccounts.workspaceId, wsIds),
      eq(sendingAccounts.enabled, true),
      eq(sendingAccounts.connectionStatus, "connected"),
    ));

  // Working-hours check, per WORKSPACE rather than per process.
  //
  // ⚠️ This was a single `now.getUTCHours() < 7 || >= 19` gate at the top of the
  // tick, commented "a plausible working window". Plausible in whose timezone?
  // The container runs on UTC, so for an Eastern mailbox that window is
  // 03:00–15:00 local: warmup mail arriving at 3am from a business address is
  // the opposite of the "looks organic to receiving providers" this file's own
  // header claims. workspace_settings.timezone is now read (see
  // services/workspaceTimezone.ts), so the window can mean what it says.
  const tzByWorkspace = new Map<number, string>();
  for (const wsId of wsIds) tzByWorkspace.set(wsId, await getWorkspaceTimezone(wsId));

  for (const acct of candidates) {
    try {
      const tz = tzByWorkspace.get(acct.workspaceId) ?? "UTC";
      const localHour = zonedDowHour(now, tz).hour;
      if (localHour < WINDOW_START_HOUR || localHour >= WINDOW_END_HOUR) continue;
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
        // Incremented in SQL, not in JS. `sentToday` and `warmupTotalSent` come
        // from a row read at the top of this tick, so `x + sent` is a lost
        // update the moment two ticks overlap — and this engine had no overlap
        // guard until now. Same fix as sendingAccountDailyStats (72aa576),
        // bookingLinks.bookingCount (9bb4f3d) and sequenceAbVariants (899ca52).
        //
        // warmupSentToday resets rather than accumulates when the UTC date has
        // rolled, which is why it cannot be a bare `+ sent`: on a new day the
        // stored value belongs to yesterday.
        await db
          .update(sendingAccounts)
          .set({
            warmupSentToday: acct.warmupTodayDate === today
              ? sql`${sendingAccounts.warmupSentToday} + ${sent}`
              : sent,
            warmupTodayDate: today,
            warmupTotalSent: sql`${sendingAccounts.warmupTotalSent} + ${sent}`,
            warmupLastSentAt: now,
          } as never)
          .where(eq(sendingAccounts.id, acct.id));
      }
    } catch (e) {
      console.error(`[Warmup] account ${acct.id} tick failed:`, e instanceof Error ? e.message : e);
    }
  }
}
