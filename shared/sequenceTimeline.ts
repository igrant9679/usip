/**
 * sequenceTimeline.ts — when a sequence's steps really happen (audit
 * 2026-10-20, U4), and the timing rules the sequence engine itself runs on.
 *
 * The engine (server/sequenceEngine.ts) IMPORTS the rules below: the
 * sequence's own window (its zone, or the workspace's; 08:00–18:00 and
 * weekends skipped unless set), the next opening of that window, how a wait
 * counts (from when the step came due or the last email went, whichever is
 * later — never both, O2), the one-minute gap after a step and the quarter-
 * hour re-check of a held step. projectTimeline walks a sequence's steps with
 * those same functions, so the preview and the engine cannot drift apart: a
 * second copy of the rules is how the double wait (O2) and the UTC window
 * (O9) went unseen.
 *
 * What the projection assumes, and says: every email is sent as soon as it
 * may be (auto-send inside the workspace send window, or a reviewer who sends
 * at once), no daily cap is reached, and nobody replies.
 */
import { inWindowAt, recipientZone, validZone, type SequenceWindow } from "./recipientTime";
import { isWithinSendWindow, nextSendWindowOpening, type SendWindow } from "./sendWindow";

export const DAY_MS = 86_400_000;
/** Gap after a step that does not wait, so one tick never runs two steps of one enrolment. */
export const STEP_GAP_MS = 60_000;
/** How far a held enrolment is pushed before it is looked at again. */
export const HOLD_RECHECK_MS = 15 * 60_000;

export type ResolvedSequenceWindow = SequenceWindow & { timezone: string };

/**
 * The window a sequence's email steps are drafted in (audit 2026-10-20, O9):
 * its own zone, else the workspace's; 08:00–18:00 unless set; weekends skipped
 * unless switched off (unset reads as on, as the screens show it).
 */
export function sequenceWindowOf(settings: unknown, workspaceZone: string): ResolvedSequenceWindow {
  const s = (settings ?? {}) as { timezone?: string | null; sendWindowStart?: string | null; sendWindowEnd?: string | null; skipWeekends?: boolean | null };
  return {
    timezone: s.timezone || workspaceZone,
    sendWindowStart: s.sendWindowStart || "08:00",
    sendWindowEnd: s.sendWindowEnd || "18:00",
    skipWeekends: s.skipWeekends !== false,
  };
}

/** Inside the sequence's window at this instant? (Start inclusive, end exclusive, in its zone.) */
export function inSequenceWindow(cfg: ResolvedSequenceWindow, at: number | Date): boolean {
  return inWindowAt(typeof at === "number" ? at : at.getTime(), cfg.timezone, cfg);
}

/**
 * The next quarter-hour the window is open, strictly after `fromMs`, looking
 * at most eight days ahead; a window that never opens is re-checked after a
 * hold instead.
 */
export function nextSequenceWindowOpen(cfg: ResolvedSequenceWindow, fromMs: number): number {
  const step = 15 * 60_000;
  const start = Math.ceil((fromMs + 1) / step) * step;
  for (let t = start; t <= fromMs + 8 * DAY_MS; t += step) {
    if (inSequenceWindow(cfg, t)) return t;
  }
  return fromMs + HOLD_RECHECK_MS;
}

/** A stored wait's days: `days` (the schema's name) or `waitDays`, a number ≥ 0, else unset (one day). */
export function stepWaitDays(raw: { days?: unknown; waitDays?: unknown }): number | undefined {
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return num(raw.days) ?? num(raw.waitDays);
}

/** A wait counts from when it came due or the last email went out, whichever is later (O2). */
export function waitDueAt(dueAtMs: number, lastSentAtMs: number, waitDays: number | undefined): number {
  return Math.max(dueAtMs, lastSentAtMs) + (waitDays ?? 1) * DAY_MS;
}

/** The first instant, re-checking every quarter hour from `fromMs`, at which `open` holds (bounded). */
export function heldUntil(fromMs: number, open: (ms: number) => boolean, maxDays = 14): number | null {
  for (let t = fromMs, n = 0; n <= (maxDays * DAY_MS) / HOLD_RECHECK_MS; t += HOLD_RECHECK_MS, n++) {
    if (open(t)) return t;
  }
  return null;
}

export type TimelineStep = { type: string; days?: number; waitDays?: number; subject?: string; enabled?: boolean };

export type TimelineEntry = {
  index: number;
  type: string;
  label: string;
  /** When the step runs: an email is drafted, a task created, a LinkedIn step sent, a wait starts. */
  atMs: number | null;
  /** An email: when it goes out (auto-send inside the workspace window, or sent at once on review). */
  sentAtMs?: number | null;
  /** A wait: when it ends. */
  untilMs?: number | null;
  /** Why it is not when you might expect: held for a window, a weekend, the email before it. */
  notes: string[];
  skipped?: boolean;
};

export type TimelineOptions = {
  /** When the first step comes due (enrolment time). */
  startMs: number;
  /** The sequence's settings (zone, window, skip weekends, recipient time). */
  settings: unknown;
  workspaceZone: string;
  /** The workspace send window (Settings), which holds LinkedIn steps and auto-send. */
  workspaceWindow: SendWindow;
  /** The zone that window is read in, when it differs from workspaceZone (services/sendWindow reads its own). */
  workspaceWindowZone?: string;
  /** With recipient time on: the example person's place, for their zone. */
  recipient?: { timezone?: string | null; state?: string | null; country?: string | null } | null;
};

const MIN_IN_DAY = 24 * 60;
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/**
 * Walk the steps as the engine does, one enrolment, nobody replying. Returns
 * one entry per step, in order, and the zone the email steps were cut in.
 */
export function projectTimeline(steps: TimelineStep[], opts: TimelineOptions): { entries: TimelineEntry[]; emailZone: string; zoneSource: "sequence" | "workspace" | "stored" | "location" } {
  const cfg = sequenceWindowOf(opts.settings, opts.workspaceZone);
  const recipientTimeOn = !!opts.settings && typeof opts.settings === "object" && (opts.settings as { recipientTime?: unknown }).recipientTime === true;
  const rz = recipientTimeOn ? recipientZone(opts.recipient ?? null, cfg.timezone) : null;
  const emailCfg: ResolvedSequenceWindow = rz ? { ...cfg, timezone: rz.zone } : cfg;
  const ownZone = !!(opts.settings as { timezone?: string | null } | null)?.timezone && !!validZone((opts.settings as { timezone?: string }).timezone);
  const wsZone = opts.workspaceWindowZone || opts.workspaceZone;
  const wsOpen = (ms: number) => isWithinSendWindow(ms, wsZone, opts.workspaceWindow);
  const windowNeverOpens = minutes(cfg.sendWindowStart) >= minutes(cfg.sendWindowEnd) || minutes(cfg.sendWindowEnd) > MIN_IN_DAY;

  const entries: TimelineEntry[] = [];
  let t = opts.startMs;
  let lastSentAt = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const days = stepWaitDays(step);
    const label = step.type === "email" ? (step.subject || `Email step ${i + 1}`)
      : step.type === "wait" ? `Wait ${days ?? 1} day${(days ?? 1) === 1 ? "" : "s"}`
      : step.type === "task" ? "Task" : step.type === "linkedin_invite" ? "LinkedIn connection request"
      : step.type === "linkedin_dm" ? "LinkedIn message" : step.type;
    if (step.enabled === false) {
      entries.push({ index: i, type: step.type, label, atMs: t, notes: ["Retired: skipped."], skipped: true });
      t += STEP_GAP_MS;
      continue;
    }
    if (step.type === "linkedin_dm" || step.type === "linkedin_invite") {
      const at = heldUntil(t, wsOpen);
      const notes = at !== null && at > t ? ["Waits for the workspace send window."] : [];
      entries.push({ index: i, type: step.type, label, atMs: at, notes: at === null ? ["The workspace send window never opens."] : notes });
      if (at === null) break;
      t = at + STEP_GAP_MS;
      continue;
    }
    if (step.type === "wait") {
      const until = waitDueAt(t, lastSentAt, days);
      entries.push({ index: i, type: step.type, label, atMs: t, untilMs: until, notes: lastSentAt > t ? ["Counts from when the last email went out."] : [] });
      t = until;
      continue;
    }
    if (step.type === "email") {
      const notes: string[] = [];
      if (windowNeverOpens) {
        entries.push({ index: i, type: step.type, label, atMs: null, sentAtMs: null, notes: ["The sequence's window never opens: its start is not before its end."] });
        break;
      }
      let at = t;
      if (!inSequenceWindow(emailCfg, at)) {
        at = nextSequenceWindowOpen(emailCfg, at);
        const dow = new Intl.DateTimeFormat("en-US", { timeZone: emailCfg.timezone, weekday: "short" }).format(new Date(t));
        notes.push(emailCfg.skipWeekends && (dow === "Sat" || dow === "Sun") ? "Weekend: waits for Monday's window." : "Waits for the sequence's window.");
      }
      const sentAt = wsOpen(at) ? at : nextSendWindowOpening(at, wsZone, opts.workspaceWindow);
      if (sentAt !== null && sentAt > at) notes.push("Goes out when the workspace send window opens.");
      entries.push({ index: i, type: step.type, label, atMs: at, sentAtMs: sentAt, notes });
      if (sentAt === null) break;
      lastSentAt = sentAt;
      t = at + STEP_GAP_MS;
      // Steps wait for the email before them: held, re-checked every quarter hour, until it has gone.
      if (sentAt > t) t = heldUntil(t, (ms) => ms >= sentAt) ?? sentAt;
      continue;
    }
    // A task (or anything the engine advances past) runs when it comes due.
    entries.push({ index: i, type: step.type, label, atMs: t, notes: [] });
    t += STEP_GAP_MS;
  }
  return {
    entries,
    emailZone: emailCfg.timezone,
    zoneSource: rz ? rz.source === "sequence" ? (ownZone ? "sequence" : "workspace") : rz.source : ownZone ? "sequence" : "workspace",
  };
}
