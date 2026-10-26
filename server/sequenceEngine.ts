/**
 * Sequence Execution Engine (MKT-007, MKT-008)
 *
 * Responsibilities:
 *  1. processEnrollments() — runs every 5 minutes, advances active enrollments
 *     whose nextActionAt <= now. Handles email steps (creates emailDraft),
 *     wait steps (schedules next action), and task steps (creates task).
 *  2. autoEnrollByTriggers(workspaceId, event) — called when a contact status
 *     changes, a tag is applied, or a lead score crosses a threshold. Finds
 *     matching sequences with enrollmentTrigger rules and auto-enrolls.
 *  3. pauseOnReply(enrollmentId) — marks enrollment paused + creates a review task.
 *  4. enforceCapAndEnroll() — respects per-sequence dailyCap and per-workspace
 *     daily email cap (100 by default) before creating drafts.
 */

import { archivedWorkspaceIds } from "./_core/workspaceArchive";
import { inSendWindow } from "./services/sendWindow";
import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  accounts,
  activities,
  contacts,
  emailDrafts,
  enrollments,
  leads,
  prospects,
  sequences,
  sequenceAbVariants,
  tasks,
  unipileAccounts,
  unipileInvites,
  unipileMessages,
  users,
  workspaces,
} from "../drizzle/schema";
import { sendLinkedInInvitation, sendMessage } from "./lib/unipile";
import { getDb } from "./db";
import { invokeLLM } from "./_core/llm";
import type { ResearchUse } from "./services/research/context";
import { researchUseFor } from "./services/research/recipient";
import { HUMAN_COPY_RULES, humanizeAiCopy } from "./services/humanCopy";
import { describeSuppression, findSuppression, linkedinUrlVariants } from "./services/suppression";
import { affected } from "./services/draftSend";
import { getWorkspaceTimezone } from "./services/workspaceTimezone";
import { pickLinkedInAccount, toInviteNote } from "./services/are/linkedinStep";
import { renderMergeFields, resolveBookingUrl, scrubForSend } from "./mergeVars";
import { extractLinkedInIdentifier } from "./services/linkedinLookup";
import { checkLinkedInAction, recordLinkedInAction } from "./services/linkedin/activityGate";

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = {
  type: "email" | "wait" | "task" | "linkedin_dm" | "linkedin_invite";
  subject?: string;
  body?: string;
  note?: string; // linkedin_invite note
  waitDays?: number;
  taskTitle?: string;
  taskBody?: string;
  taskDueOffsetDays?: number;
  emailMode?: "typed" | "dynamic";
  aiTone?: string;
  aiLength?: string;
  aiFocus?: string;
  /**
   * False disables the step: enrollments skip straight past it without sending.
   * Written by the optimisation layer's `retire_dead_step` apply path (a step
   * with volume and zero replies) and reversible by it. Absent/true = active,
   * so every existing row keeps working untouched.
   */
  enabled?: boolean;
};

/**
 * Normalize a persisted step into the shape this engine reads.
 *
 * The engine and the storage format disagreed on field names, and the engine
 * lost silently. `sequences.steps` is validated by ONE zod schema
 * (`stepSchema` in routers/sequences.ts) which stores a wait as
 * `{type:"wait", days}` and a task as `{type:"task", body}` — but the engine
 * read `step.waitDays` and `step.taskTitle`, neither of which anything ever
 * wrote. Both fell through to their `?? 1` / `?? "Follow up"` defaults, so
 * EVERY wait step waited exactly one day regardless of the configured value,
 * and every task step became a generic "Follow up" due tomorrow with the
 * user's description discarded.
 *
 * Consequence worth remembering: a "day 1 / day 4 / day 10" sequence actually
 * sent on days 1, 2 and 3 — a spam-shaped cadence on warmed mailboxes.
 *
 * Normalizing here (one call site, where the JSON is first read) fixes all
 * downstream reads at once. Both spellings are accepted so any row already
 * carrying the engine's names keeps working.
 */
function normalizeStep(raw: Record<string, unknown>): Step {
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const str = (v: unknown): string | undefined => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : undefined;
  };

  const step: Step = {
    type: raw.type as Step["type"],
    subject: str(raw.subject),
    // The canvas names LinkedIn text linkedinMessage / linkedinNote; the step
    // format says body / note (audit 2026-10-20, O7). Either is read.
    body: str(raw.body) ?? (raw.type === "linkedin_dm" ? str(raw.linkedinMessage) : undefined),
    note: str(raw.note) ?? (raw.type === "linkedin_invite" ? str(raw.linkedinNote) : undefined),
    // `days` is what the schema stores; `waitDays` is tolerated for safety.
    waitDays: num(raw.days) ?? num(raw.waitDays),
    taskDueOffsetDays: num(raw.taskDueOffsetDays),
    emailMode: raw.emailMode === "dynamic" ? "dynamic" : undefined,
    aiTone: str(raw.aiTone),
    aiLength: str(raw.aiLength),
    aiFocus: str(raw.aiFocus),
    // Only an explicit `false` disables a step. This normaliser rebuilds a fixed
    // field list, so a flag omitted here would be silently dropped and the
    // optimisation layer's "disable step" patch would do nothing at all.
    enabled: raw.enabled === false ? false : undefined,
  };

  if (step.type === "task") {
    // The task editor produces one rich-text `body` and no title. Derive a
    // usable title from it rather than labelling every task "Follow up",
    // and keep the full text for the task description.
    const body = str(raw.body);
    step.taskBody = body;
    const plain = body?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const firstLine = plain?.split(/[.!?\n]/)[0]?.trim();
    step.taskTitle =
      str(raw.taskTitle) ??
      (firstLine && firstLine.length > 0 ? firstLine.slice(0, 240) : undefined);
  }

  return step;
}

function normalizeSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map(normalizeStep);
}

/**
 * Generate copy for an "AI-dynamic" email step at send time.
 *
 * The canvas's dynamic mode deliberately offers no subject/body inputs — it
 * promises the copy is written per-recipient at send. Nothing implemented
 * that promise, so those steps produced empty drafts.
 *
 * Personalization tokens are left as {{merge}} placeholders rather than being
 * resolved here: the send path (renderMergeFields) already substitutes them
 * per recipient, and doing it in both places would double-resolve.
 *
 * Returns null on any failure — the caller then skips the send rather than
 * mailing an empty body.
 */
async function generateDynamicEmail(
  step: Step,
  workspaceId: number,
  research?: ResearchUse,
): Promise<{ subject: string; body: string } | null> {
  const tone = step.aiTone ?? "professional";
  const length = step.aiLength ?? "medium";
  const focus = step.aiFocus?.trim();
  if (!focus) {
    console.error(
      "[SequenceEngine] dynamic email step has no focus/goal configured — nothing to generate from.",
    );
    return null;
  }

  try {
    const out = await invokeLLM({
      sendersBrand: true,
      workspaceId,
      research,
      maxTokens: 700,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            `You write short B2B outreach emails. Tone: ${tone}. Length: ${length}.\n` +
            `Use {{firstName}}, {{company}} and {{senderName}} as literal placeholder tokens — they are substituted per recipient downstream, so never invent a real name or company.\n` +
            `Do not fabricate facts, metrics, or customer names. Do not open with "I hope this email finds you well". Do not add a P.S.

${HUMAN_COPY_RULES}`,
        },
        { role: "user", content: `Write the email. Goal: ${focus}` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "email_draft",
          strict: true,
          schema: {
            type: "object",
            properties: { subject: { type: "string" }, body: { type: "string" } },
            required: ["subject", "body"],
            additionalProperties: false,
          },
        },
      },
    });
    const content = out.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const subject = humanizeAiCopy(String(parsed?.subject ?? "").trim());
    const body = humanizeAiCopy(String(parsed?.body ?? "").trim());
    if (!body) return null;
    return { subject: subject || "Following up", body };
  } catch (e) {
    console.error("[SequenceEngine] dynamic email generation failed:", e);
    return null;
  }
}

type EnrollmentTrigger = {
  type: "status_change" | "tag_applied" | "score_threshold";
  value: string; // e.g. "qualified", "hot", "75"
};

// status_change originally accepted only a contactId — but `contacts` has no
// status column; `leads.status` is the field that actually changes (new →
// working → qualified → …). That mismatch meant the trigger had no entity it
// could legitimately be fired for. Both ids are now optional on both event
// kinds so the trigger can be driven by whichever record really moved.
type AutoEnrollEvent =
  | { kind: "status_change"; workspaceId: number; contactId?: number; leadId?: number; newStatus: string }
  | { kind: "tag_applied"; workspaceId: number; contactId?: number; leadId?: number; tag: string }
  | { kind: "score_threshold"; workspaceId: number; contactId?: number; leadId?: number; score: number };

// ─── Sequence-timezone clock ──────────────────────────────────────────────────

/**
 * Wall-clock info in an IANA timezone (no deps — Intl only).
 * Falls back to UTC on a bad/missing timezone string.
 */
function nowInTz(tz: string | undefined, at: Date = new Date()): { hhmm: string; dow: number; dateKey: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      hourCycle: "h23",
      weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      hhmm: `${get("hour")}:${get("minute")}`,
      dow: dowMap[get("weekday")] ?? 1,
      dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    };
  } catch {
    return { hhmm: at.toISOString().slice(11, 16), dow: at.getUTCDay(), dateKey: at.toISOString().slice(0, 10) };
  }
}

type SequenceSendSettings = {
  timezone?: string;
  sendWindowStart?: string;
  sendWindowEnd?: string;
  skipWeekends?: boolean;
};

type ResolvedSendSettings = Required<SequenceSendSettings>;

/**
 * The send window a sequence actually runs in (audit 2026-10-20, O9).
 *
 * No screen saved a time zone and updateMeta replaced the whole settings
 * object, so every sequence ran its "08:00–18:00" in UTC — 3 to 4 AM Eastern.
 * A sequence without its own zone now uses the WORKSPACE's (Settings →
 * workspace time zone). "Skip weekends" showed as on while the engine read an
 * unset value as off; unset is now on, matching the screens.
 */
async function resolveSendSettings(seq: { settings: unknown }, workspaceId: number): Promise<ResolvedSendSettings> {
  const s = (seq.settings ?? {}) as SequenceSendSettings;
  return {
    timezone: s.timezone || (await getWorkspaceTimezone(workspaceId)),
    sendWindowStart: s.sendWindowStart || "08:00",
    sendWindowEnd: s.sendWindowEnd || "18:00",
    skipWeekends: s.skipWeekends !== false,
  };
}

function inSequenceWindow(cfg: ResolvedSendSettings, at: Date): boolean {
  const local = nowInTz(cfg.timezone, at);
  if (cfg.skipWeekends && (local.dow === 0 || local.dow === 6)) return false;
  // Zero-padded HH:MM strings compare correctly lexicographically.
  return local.hhmm >= cfg.sendWindowStart && local.hhmm < cfg.sendWindowEnd;
}

/** The next quarter-hour the window is open, looking at most 8 days ahead. */
function nextWindowOpen(cfg: ResolvedSendSettings, from: Date): Date {
  const step = 15 * 60_000;
  const start = Math.ceil((from.getTime() + 1) / step) * step;
  for (let t = start; t <= from.getTime() + 8 * 86_400_000; t += step) {
    if (inSequenceWindow(cfg, new Date(t))) return new Date(t);
  }
  return new Date(from.getTime() + HOLD_RECHECK_MS);
}

// ─── Daily email cap tracking (in-memory, resets at midnight) ─────────────────

const dailyEmailCounts: Map<string, number> = new Map();
const WORKSPACE_DAILY_CAP = 100;

function getDailyKey(workspaceId: number): string {
  // Workspace-wide cap stays on the UTC day: there is no workspace-level
  // timezone setting, and a single boundary beats per-sequence drift here.
  // Per-SEQUENCE caps + send windows use the sequence's own timezone below.
  const today = new Date().toISOString().slice(0, 10);
  return `${workspaceId}:${today}`;
}

// ─── LinkedIn copy ────────────────────────────────────────────────────────────

/** What both sequence editors allow for a connection note. */
const LINKEDIN_NOTE_MAX = 300;

type PersonFields = { firstName?: string | null; lastName?: string | null; title?: string | null; company?: string | null };

/**
 * The merge map for a LinkedIn step: the person, and the owner of the account
 * the message goes from — the same keys the email path fills, so a template
 * written once reads the same on both channels.
 */
async function linkedinMergeVars(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  person: PersonFields,
  senderUserId: number | null,
): Promise<Record<string, string>> {
  const [sender] = senderUserId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, senderUserId)).limit(1)
    : [];
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const firstName = person.firstName ?? "";
  const lastName = person.lastName ?? "";
  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" "),
    title: person.title ?? "",
    company: person.company ?? "",
    accountName: person.company ?? "",
    senderName: sender?.name ?? "",
    senderCompany: ws?.name ?? "",
    bookingLink: senderUserId ? await resolveBookingUrl(workspaceId, senderUserId) : "",
  };
}

// ─── Core processor ───────────────────────────────────────────────────────────

/** Gap after a step that does not wait, so one tick never runs two steps of one enrolment. */
const STEP_GAP_MS = 60_000;
/**
 * How far a held enrolment is pushed. A held row used to keep its past
 * nextActionAt, so it sat at the front of the unordered 200-row page every
 * tick and, once there were 200 of them, nothing behind them — in any
 * workspace — ever ran (audit 2026-10-20, O23).
 */
const HOLD_RECHECK_MS = 15 * 60_000;
/** A daily cap is not going to lift in five minutes. */
const CAP_RECHECK_MS = 60 * 60_000;

/** Drafts in these states are finished with; any other one is still on its way out. */
const SETTLED_DRAFT_STATUSES = new Set(["sent", "rejected"]);

/**
 * Process every active enrolment whose next step is due.
 * Called every 5 minutes by the server cron.
 *
 * What it guarantees (audit 2026-10-20, Phase 1):
 *
 *   • ONE SEND PER STEP. A step is claimed by a conditional UPDATE that moves
 *     currentStep on only if it still holds the value this tick read. Two
 *     overlapping ticks both see the row; one moves it, and only that one
 *     writes the draft, the task or the LinkedIn message.
 *   • ONE STEP PER PERSON PER TICK, across all their enrolments.
 *   • STEPS WAIT FOR THE EMAIL BEFORE THEM. While a draft from this enrolment
 *     is waiting for review, approval or sending, nothing after it runs, and a
 *     wait counts from the moment the email actually went out. Drafts used to
 *     pile up behind review and go out together, minutes apart (O3).
 *   • A WAIT COUNTS ONCE. The step before a wait used to schedule the wait's
 *     days, and the wait step then added them again: "day 1, wait 3, wait 4"
 *     sent on days 1, 7 and 15 (O2).
 *   • PAUSED IS HELD. A paused or draft sequence's enrolments are not touched;
 *     they continue where they were when it is reactivated. Only archiving a
 *     sequence ends them (O1).
 *   • HELD ROWS STEP ASIDE. A row that cannot go now (outside its window, over
 *     a cap, waiting on a draft or a LinkedIn limit) is pushed forward, and
 *     the page is read oldest-due first, so it cannot starve the rows behind
 *     it (O23).
 */
export async function processEnrollments(): Promise<{ processed: number; errors: number }> {
  const db = await getDb();
  if (!db) return { processed: 0, errors: 0 };

  const now = new Date();
  let processed = 0;
  let errors = 0;

  // Archived workspaces are frozen (2026-08-12) — excluded in SQL, because a
  // frozen row that is merely skipped keeps its place at the head of the page.
  const archivedWs = await archivedWorkspaceIds();
  const due = await db
    .select({ enrollment: enrollments, seq: sequences })
    .from(enrollments)
    .innerJoin(
      sequences,
      // Scoped to the ENROLMENT's workspace (audit 2026-10-20, C9): the ids on
      // an enrolment row were never checked at enrol time.
      and(eq(sequences.id, enrollments.sequenceId), eq(sequences.workspaceId, enrollments.workspaceId)),
    )
    .where(
      and(
        eq(enrollments.status, "active"),
        or(isNull(enrollments.nextActionAt), lte(enrollments.nextActionAt, now)),
        // Paused and draft sequences HOLD their enrolments; archived ones are
        // read only to end them.
        inArray(sequences.status, ["active", "archived"]),
        archivedWs.size > 0 ? notInArray(enrollments.workspaceId, Array.from(archivedWs)) : undefined,
      ),
    )
    .orderBy(asc(enrollments.nextActionAt), asc(enrollments.id))
    .limit(200); // process up to 200 per tick to avoid overload

  const people = new Set<string>();
  const sendSettings = new Map<number, ResolvedSendSettings>();
  const linkedinVerdicts = new Map<string, Awaited<ReturnType<typeof checkLinkedInAction>>>();

  for (const { enrollment, seq } of due) {
    try {
      // Every write below names the row AND the step this tick read, so a
      // row another tick has moved on is left alone.
      if (seq.status === "archived") {
        await db.update(enrollments).set({ status: "exited" }).where(and(
          eq(enrollments.id, enrollment.id),
          eq(enrollments.workspaceId, enrollment.workspaceId),
          eq(enrollments.status, "active"),
          eq(enrollments.currentStep, enrollment.currentStep),
        ));
        continue;
      }

      const person = enrollment.contactId
        ? `c:${enrollment.contactId}`
        : enrollment.leadId ? `l:${enrollment.leadId}` : `p:${enrollment.prospectId}`;
      if (people.has(person)) continue; // still due — next tick

      const hold = async (until: Date) => {
        await db.update(enrollments).set({ nextActionAt: until }).where(and(
          eq(enrollments.id, enrollment.id),
          eq(enrollments.workspaceId, enrollment.workspaceId),
          eq(enrollments.status, "active"),
          eq(enrollments.currentStep, enrollment.currentStep),
        ));
      };

      // ── Wait for this enrolment's own drafts ─────────────────────────────
      const drafts = await db
        .select({ status: emailDrafts.status, sentAt: emailDrafts.sentAt })
        .from(emailDrafts)
        .where(and(eq(emailDrafts.workspaceId, enrollment.workspaceId), eq(emailDrafts.enrollmentId, enrollment.id)));
      if (drafts.some((d) => !SETTLED_DRAFT_STATUSES.has(String(d.status)))) {
        await hold(new Date(now.getTime() + HOLD_RECHECK_MS));
        continue;
      }
      const lastSentAt = drafts.reduce<number>((max, d) => (d.sentAt ? Math.max(max, new Date(d.sentAt).getTime()) : max), 0);

      const steps = normalizeSteps(seq.steps);
      const stepIndex = enrollment.currentStep;

      if (stepIndex >= steps.length) {
        // All steps done, and the last email has gone (or been rejected).
        await db.update(enrollments).set({ status: "finished" }).where(and(
          eq(enrollments.id, enrollment.id),
          eq(enrollments.workspaceId, enrollment.workspaceId),
          eq(enrollments.status, "active"),
          eq(enrollments.currentStep, enrollment.currentStep),
        ));
        processed++;
        continue;
      }

      const step = steps[stepIndex];
      const nextStepIndex = stepIndex + 1;

      /** Take this step. False means another tick already did. */
      const claim = async (nextActionAt: Date): Promise<boolean> => {
        const res = await db.update(enrollments).set({ currentStep: nextStepIndex, nextActionAt }).where(and(
          eq(enrollments.id, enrollment.id),
          eq(enrollments.workspaceId, enrollment.workspaceId),
          eq(enrollments.status, "active"),
          eq(enrollments.currentStep, enrollment.currentStep),
        ));
        if (affected(res) !== 1) return false;
        people.add(person);
        return true;
      };
      const claimNow = () => claim(new Date(now.getTime() + STEP_GAP_MS));

      // A disabled step is skipped entirely: the enrolment rolls past it
      // instead of stalling on a retired step.
      if (step.enabled === false) {
        if (await claimNow()) processed++;
        continue;
      }

      // A LinkedIn DM or invite waits for the workspace send window (owner ask
      // 2026-09-25, see @shared/sendWindow), which stays shut while outbound
      // is paused.
      if ((step.type === "linkedin_dm" || step.type === "linkedin_invite") && !(await inSendWindow(enrollment.workspaceId))) {
        await hold(new Date(now.getTime() + HOLD_RECHECK_MS));
        continue;
      }

      if (step.type === "wait") {
        // The wait counts from when this step came due or the last email
        // actually went out, whichever is later — never from both.
        const base = Math.max(enrollment.nextActionAt ? new Date(enrollment.nextActionAt).getTime() : now.getTime(), lastSentAt);
        if (await claim(new Date(base + (step.waitDays ?? 1) * 86_400_000))) processed++;
        continue;
      }

      if (step.type === "email") {
        let cfg = sendSettings.get(seq.id);
        if (!cfg) {
          cfg = await resolveSendSettings(seq, enrollment.workspaceId);
          sendSettings.set(seq.id, cfg);
        }
        if (!inSequenceWindow(cfg, now)) {
          await hold(nextWindowOpen(cfg, now));
          continue;
        }

        // Daily caps (per-sequence key rolls at the sequence's local midnight).
        const seqKey = `seq:${seq.id}:${nowInTz(cfg.timezone, now).dateKey}`;
        const seqCount = dailyEmailCounts.get(seqKey) ?? 0;
        const wsKey = getDailyKey(enrollment.workspaceId);
        const wsCount = dailyEmailCounts.get(wsKey) ?? 0;
        if (seqCount >= (seq.dailyCap ?? Infinity) || wsCount >= WORKSPACE_DAILY_CAP) {
          await hold(new Date(now.getTime() + CAP_RECHECK_MS));
          continue;
        }

        // Resolve the recipient.
        let toEmail: string | undefined;
        let linkedinUrl: string | null = null;
        let companyDomain: string | null = null;
        let toContactId: number | undefined;
        let toLeadId: number | undefined;
        let toProspectId: number | undefined;
        if (enrollment.contactId) {
          const [contact] = await db
            .select({ email: contacts.email, linkedinUrl: contacts.linkedinUrl, companyDomain: contacts.companyDomain })
            .from(contacts)
            .where(and(eq(contacts.id, enrollment.contactId), eq(contacts.workspaceId, enrollment.workspaceId)));
          toEmail = contact?.email ?? undefined;
          linkedinUrl = contact?.linkedinUrl ?? null;
          companyDomain = contact?.companyDomain ?? null;
          toContactId = enrollment.contactId;
        } else if (enrollment.leadId) {
          const [lead] = await db
            .select({ email: leads.email })
            .from(leads)
            .where(and(eq(leads.id, enrollment.leadId), eq(leads.workspaceId, enrollment.workspaceId)));
          toEmail = lead?.email ?? undefined;
          toLeadId = enrollment.leadId;
        } else if (enrollment.prospectId) {
          // Prospect-native enrollment path (migration 0085): the email comes
          // straight from the prospects row.
          const [prospect] = await db
            .select({ email: prospects.email, linkedinUrl: prospects.linkedinUrl, companyDomain: prospects.companyDomain })
            .from(prospects)
            .where(and(eq(prospects.id, enrollment.prospectId), eq(prospects.workspaceId, enrollment.workspaceId)));
          toEmail = prospect?.email ?? undefined;
          linkedinUrl = prospect?.linkedinUrl ?? null;
          companyDomain = prospect?.companyDomain ?? null;
          toProspectId = enrollment.prospectId;
        }

        /**
         * The person must not be suppressed — the ONE check
         * (services/suppression), so the do-not-contact list, a LinkedIn
         * profile or a whole company domain stop this email too, not only the
         * email suppression list. Asked BEFORE the claim, so a failed lookup
         * leaves the step to run next tick instead of losing it.
         *
         * Skips the STEP rather than exiting the enrolment: a bounce stops
         * email, not this sequence's task steps (a rep's phone call).
         */
        let skip: string | null = toEmail ? null : "no email address";
        if (toEmail) {
          const hit = await findSuppression(enrollment.workspaceId, { email: toEmail, linkedinUrl, companyDomain }, "email");
          if (hit) skip = describeSuppression(hit);
        }

        if (!(await claimNow())) continue;
        processed++;
        if (skip || !toEmail) {
          console.log(
            `[SequenceEngine] sequence ${enrollment.sequenceId} step ${stepIndex}: ${skip} — draft SKIPPED for enrollment ${enrollment.id}.`,
          );
          continue;
        }
        dailyEmailCounts.set(seqKey, seqCount + 1);
        dailyEmailCounts.set(wsKey, wsCount + 1);

        // A/B variant assignment: pick a variant for this step if any exist
        let draftSubject = step.subject ?? "Follow-up";
        let draftBody = step.body ?? "";
        const variants = await db
          .select()
          .from(sequenceAbVariants)
          .where(
            and(
              eq(sequenceAbVariants.workspaceId, enrollment.workspaceId),
              eq(sequenceAbVariants.sequenceId, enrollment.sequenceId),
              eq(sequenceAbVariants.stepIndex, stepIndex),
            ),
          );
        let chosenVariantId: number | null = null;
        if (variants.length > 0) {
          // Weighted random selection based on splitPct. Guard against
          // all-zero weights (Math.random() * 0 = 0, loop never decrements
          // past zero, always picks variants[0] → silent unfairness). Fall
          // back to uniform random when every variant has splitPct=0.
          const totalWeight = variants.reduce((s, v) => s + v.splitPct, 0);
          let chosen = variants[0];
          if (totalWeight <= 0) {
            chosen = variants[Math.floor(Math.random() * variants.length)];
          } else {
            let rand = Math.random() * totalWeight;
            for (const v of variants) {
              rand -= v.splitPct;
              if (rand <= 0) { chosen = v; break; }
            }
          }
          draftSubject = chosen.subject;
          draftBody = chosen.body;
          chosenVariantId = chosen.id;
        }

        // AI-dynamic steps carry no static copy by design — the canvas
        // deliberately hides subject/body for them. Generate now.
        if (step.emailMode === "dynamic" && variants.length === 0) {
          const generated = await generateDynamicEmail(
            step,
            enrollment.workspaceId,
            await researchUseFor(enrollment.workspaceId, "outreach", { contactId: enrollment.contactId, leadId: enrollment.leadId, prospectId: enrollment.prospectId }),
          );
          if (generated) {
            draftSubject = generated.subject;
            draftBody = generated.body;
          }
        }

        // HARD GUARD: never create a draft with no body. A dynamic step used
        // to persist as subject:"" body:"" and land here unchanged —
        // `step.subject ?? "Follow-up"` doesn't fire on "" — so the engine
        // queued a genuinely blank email against a real prospect. The step is
        // skipped (it was claimed above) rather than mailing emptiness.
        if (draftBody.trim().length === 0) {
          console.error(
            `[SequenceEngine] sequence ${enrollment.sequenceId} step ${stepIndex}: empty body — send SKIPPED for enrollment ${enrollment.id}.` +
            (step.emailMode === "dynamic"
              ? " AI generation returned nothing (check the workspace's AI provider key)."
              : " The step has no content saved."),
          );
          continue;
        }

        // stepIndex captures which sequence step this draft was generated for,
        // since enrollment.currentStep has already advanced.
        await db.insert(emailDrafts).values({
          workspaceId: enrollment.workspaceId,
          subject: draftSubject,
          body: draftBody,
          toContactId,
          toLeadId,
          toProspectId,
          toEmail,
          sequenceId: enrollment.sequenceId,
          enrollmentId: enrollment.id,
          stepIndex,
          // Migration 0141. Without this the variant's openCount/replyCount
          // could never be attributed. NULL when the step has no variants.
          abVariantId: chosenVariantId,
          status: "pending_review",
          aiGenerated: false,
        } as never);
        /**
         * No sentCount bump. sequence_ab_variants' counters are dead columns —
         * variant performance is DERIVED from email_drafts by
         * performanceMetrics.getSequenceAbVariantStats, which counts drafts that
         * reached status 'sent'. A counter bumped here, at draft CREATION,
         * credited sends that never happened.
         */
        continue;
      }

      if (step.type === "task") {
        if (!(await claimNow())) continue;
        processed++;
        await db.insert(tasks).values({
          workspaceId: enrollment.workspaceId,
          // title is varchar(240) — normalizeStep already clamps the derived
          // title, but clamp again here so a legacy taskTitle can't overflow.
          title: (step.taskTitle ?? "Follow up").slice(0, 240),
          description: step.taskBody ?? null,
          dueAt: new Date(now.getTime() + (step.taskDueOffsetDays ?? 1) * 86_400_000),
          relatedType: enrollment.contactId ? "contact" : enrollment.leadId ? "lead" : "prospect",
          relatedId: (enrollment.contactId ?? enrollment.leadId ?? enrollment.prospectId) as number,
          status: "open",
          priority: "normal",
        });
        continue;
      }

      if (step.type === "linkedin_dm" || step.type === "linkedin_invite") {
        // ── LinkedIn outreach via Unipile ────────────────────────────────────
        let linkedinUrl: string | null | undefined;
        let email: string | null | undefined;
        let companyDomain: string | null | undefined;
        let person: PersonFields = {};
        let relatedType: "contact" | "lead" | "prospect" = "contact";
        let relatedId: number | undefined;
        if (enrollment.contactId) {
          const [contact] = await db
            .select({
              linkedinUrl: contacts.linkedinUrl, email: contacts.email, companyDomain: contacts.companyDomain,
              firstName: contacts.firstName, lastName: contacts.lastName, title: contacts.title, accountId: contacts.accountId,
            })
            .from(contacts)
            .where(and(eq(contacts.id, enrollment.contactId), eq(contacts.workspaceId, enrollment.workspaceId)));
          linkedinUrl = contact?.linkedinUrl;
          email = contact?.email;
          companyDomain = contact?.companyDomain;
          const [acct] = contact?.accountId
            ? await db.select({ name: accounts.name }).from(accounts)
                .where(and(eq(accounts.id, contact.accountId), eq(accounts.workspaceId, enrollment.workspaceId))).limit(1)
            : [];
          person = { firstName: contact?.firstName, lastName: contact?.lastName, title: contact?.title, company: acct?.name };
          relatedType = "contact";
          relatedId = enrollment.contactId;
        } else if (enrollment.leadId) {
          relatedType = "lead";
          relatedId = enrollment.leadId;
          // Leads don't have a linkedinUrl field — skip gracefully
        } else if (enrollment.prospectId) {
          const [prospect] = await db
            .select({
              linkedinUrl: prospects.linkedinUrl, email: prospects.email, companyDomain: prospects.companyDomain,
              firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title, company: prospects.company,
            })
            .from(prospects)
            .where(and(eq(prospects.id, enrollment.prospectId), eq(prospects.workspaceId, enrollment.workspaceId)));
          linkedinUrl = prospect?.linkedinUrl;
          email = prospect?.email;
          companyDomain = prospect?.companyDomain;
          person = { firstName: prospect?.firstName, lastName: prospect?.lastName, title: prospect?.title, company: prospect?.company };
          relatedType = "prospect";
          relatedId = enrollment.prospectId;
        }
        const identifier = linkedinUrl ? extractLinkedInIdentifier(linkedinUrl) : null;

        // The SEQUENCE OWNER's account, as ARE does (audit 2026-10-20, O12):
        // this used to take whichever LinkedIn account the database returned
        // first, so a rep's sequence could invite people as a colleague.
        const account = await pickLinkedInAccount(enrollment.workspaceId, seq.assignedToUserId ?? seq.ownerUserId ?? null);
        const isInvite = step.type === "linkedin_invite";
        /**
         * The step's text is a TEMPLATE (audit 2026-10-20, O10): it went out
         * raw, so a prospect read "Hi {{first_name}}" from {{company}}'s rep.
         * Rendered for this person and the sending account's owner, then
         * scrubbed, as every email path is — nothing in braces reaches
         * LinkedIn. An invite note keeps to the 300 characters both editors
         * allow once the fields are filled in.
         */
        const rendered = account
          ? scrubForSend(
              renderMergeFields((isInvite ? step.note : step.body) ?? "", await linkedinMergeVars(db, enrollment.workspaceId, person, account.userId)),
              "sequenceEngine.linkedin",
            )
          : "";
        const text = isInvite ? toInviteNote(rendered, LINKEDIN_NOTE_MAX) : rendered;

        let skip: string | null = null;
        if (!account) skip = "no Unipile LinkedIn account";
        else if (!identifier) skip = "no LinkedIn profile on the record";
        else if (!isInvite && !text.trim()) skip = "the step has no message";
        else {
          const hit = await findSuppression(enrollment.workspaceId, { email, linkedinUrl, companyDomain }, "linkedin");
          if (hit) skip = describeSuppression(hit);
        }
        if (!skip && isInvite) {
          // Never ask twice: an invitation pending or accepted is the answer.
          const [prior] = await db
            .select({ id: unipileInvites.id })
            .from(unipileInvites)
            .where(and(eq(unipileInvites.workspaceId, enrollment.workspaceId), eq(unipileInvites.recipientProviderId, identifier!)))
            .limit(1);
          if (prior) skip = "already invited";
        }
        if (skip) {
          console.warn(`[SequenceEngine] Skipping LinkedIn step for enrollment ${enrollment.id}: ${skip}`);
          if (await claimNow()) processed++;
          continue;
        }

        /**
         * THE GATE, for DMs as well as invites (O11/O12). DMs went out with no
         * check at all and counted against nothing, and an invite the gate
         * held was skipped for good. A refusal now HOLDS the step until the
         * gate says it may run; one account's verdict serves the whole tick.
         */
        const kind = isInvite ? "invite" as const : "message" as const;
        const gateKey = `${account!.unipileAccountId}:${kind}`;
        let verdict = linkedinVerdicts.get(gateKey);
        if (!verdict) {
          verdict = await checkLinkedInAction({ workspaceId: enrollment.workspaceId, unipileAccountId: account!.unipileAccountId, kind });
          linkedinVerdicts.set(gateKey, verdict);
        }
        if (!verdict.allowed) {
          const wait = Math.min(Math.max(verdict.retryAfterMs ?? HOLD_RECHECK_MS, HOLD_RECHECK_MS), 86_400_000);
          await hold(new Date(now.getTime() + wait));
          continue;
        }

        if (!(await claimNow())) continue;
        processed++;
        // One action per account per tick; the next one is re-checked.
        linkedinVerdicts.delete(gateKey);
        try {
          if (!isInvite) {
            const result = await sendMessage({
              accountId: account!.unipileAccountId,
              attendeesIds: [identifier!],
              text,
            });
            await recordLinkedInAction({ workspaceId: enrollment.workspaceId, unipileAccountId: account!.unipileAccountId, kind: "message", source: "sequence", targetIdentifier: identifier });
            // The recipient's provider id is the fact genuineSocialReplyScope()
            // matches an inbound DM against (2026-09-20).
            await db.insert(unipileMessages).values({
              workspaceId: enrollment.workspaceId,
              unipileAccountId: account!.unipileAccountId,
              provider: "LINKEDIN",
              chatId: result.chatId || result.id,
              messageId: result.id,
              direction: "outbound",
              recipientProviderId: identifier,
              text,
              linkedContactId: enrollment.contactId ?? null,
              linkedLeadId: enrollment.leadId ?? null,
            });
          } else {
            await sendLinkedInInvitation({
              accountId: account!.unipileAccountId,
              providerId: identifier!,
              message: text,
            });
            await recordLinkedInAction({ workspaceId: enrollment.workspaceId, unipileAccountId: account!.unipileAccountId, kind: "invite", source: "sequence", targetIdentifier: identifier });
            await db.insert(unipileInvites).values({
              workspaceId: enrollment.workspaceId,
              userId: account!.userId ?? 0,
              unipileAccountId: account!.unipileAccountId,
              recipientProviderId: identifier!,
              message: text,
              status: "pending",
              linkedContactId: enrollment.contactId ?? null,
              linkedLeadId: enrollment.leadId ?? null,
            } as never);
          }
          if (relatedId) {
            await db.insert(activities).values({
              workspaceId: enrollment.workspaceId,
              type: "linkedin",
              relatedType,
              relatedId,
              subject: isInvite ? "LinkedIn connection request sent" : "LinkedIn DM sent",
              body: text,
            });
          }
        } catch (liErr) {
          // The step was claimed before the call, so it is not retried: a
          // timeout after LinkedIn accepted the message would otherwise send
          // it twice.
          console.warn(`[SequenceEngine] LinkedIn step failed for enrollment ${enrollment.id}:`, liErr);
        }
        continue;
      }

      // Terminal arm. Anything the chain above does not name — a legacy row,
      // hand-written JSON, a channel this engine cannot send — used to write
      // NOTHING, so the due query re-selected it every tick forever. Advance
      // past it instead, and say which type it was (2026-09-20).
      console.warn(
        `[SequenceEngine] enrollment ${enrollment.id}: unsupported step type ` +
        `"${String(step.type)}" at index ${stepIndex} — advancing past it`,
      );
      if (await claimNow()) processed++;
    } catch (err) {
      errors++;
      console.error(`[SequenceEngine] Error processing enrollment ${enrollment.id}:`, err);
    }
  }

  if (processed > 0 || errors > 0) {
    console.log(`[SequenceEngine] Processed ${processed} enrollments, ${errors} errors`);
  }

  return { processed, errors };
}

// ─── Auto-enrollment triggers ─────────────────────────────────────────────────

/**
 * Check all active sequences in a workspace for matching enrollmentTrigger rules.
 * Auto-enroll the contact/lead if not already enrolled.
 */
export async function autoEnrollByTriggers(event: AutoEnrollEvent): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const { workspaceId } = event;

  // Get all active sequences with enrollment triggers
  const activeSeqs = await db
    .select()
    .from(sequences)
    .where(
      and(
        eq(sequences.workspaceId, workspaceId),
        eq(sequences.status, "active")
      )
    );

  for (const seq of activeSeqs) {
    const triggers = (seq.enrollmentTrigger as EnrollmentTrigger[] | null) ?? [];
    if (triggers.length === 0) continue;

    let matches = false;

    for (const trigger of triggers) {
      if (event.kind === "status_change" && trigger.type === "status_change") {
        if (trigger.value === event.newStatus) matches = true;
      } else if (event.kind === "tag_applied" && trigger.type === "tag_applied") {
        if (trigger.value === event.tag) matches = true;
      } else if (event.kind === "score_threshold" && trigger.type === "score_threshold") {
        const threshold = parseInt(trigger.value, 10);
        if (!isNaN(threshold) && event.score >= threshold) matches = true;
      }
    }

    if (!matches) continue;

    // Check if already enrolled
    // (Was a no-op ternary with identical branches, and leadId was only read
    // for score_threshold — so a lead-driven status_change had no target.)
    const contactId = event.contactId;
    const leadId = event.leadId;
    if (!contactId && !leadId) continue; // nothing to enrol

    const existing = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.sequenceId, seq.id),
          eq(enrollments.workspaceId, workspaceId),
          contactId ? eq(enrollments.contactId, contactId) : isNull(enrollments.contactId),
          leadId ? eq(enrollments.leadId, leadId) : isNull(enrollments.leadId)
        )
      )
      .limit(1);

    if (existing.length > 0) continue; // already enrolled

    // Auto-enroll
    await db.insert(enrollments).values({
      workspaceId,
      sequenceId: seq.id,
      contactId: contactId ?? null,
      leadId: leadId ?? null,
      status: "active",
      currentStep: 0,
      nextActionAt: new Date(), // process immediately
    });

    console.log(
      `[SequenceEngine] Auto-enrolled ${contactId ? `contact:${contactId}` : `lead:${leadId}`} in sequence:${seq.id} via trigger:${event.kind}`
    );
  }
}

// ─── Pause on reply ───────────────────────────────────────────────────────────

/**
 * Pause an enrollment when a reply is detected.
 * Creates a review task for the rep.
 */
export async function pauseOnReply(
  enrollmentId: number,
  workspaceId: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [enrollment] = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.id, enrollmentId),
        eq(enrollments.workspaceId, workspaceId)
      )
    );

  if (!enrollment || enrollment.status !== "active") return;

  // Pause enrollment. resumeAt: null because this pause is a human saying the
  // conversation is live — it must override any OOO snooze already stamped on
  // the row, not queue behind it (0181).
  await db
    .update(enrollments)
    .set({ status: "paused", resumeAt: null })
    .where(eq(enrollments.id, enrollmentId));

  // Create review task
  await db.insert(tasks).values({
    workspaceId,
    title: "Reply detected — review sequence enrollment",
    dueAt: new Date(Date.now() + 86400000), // due tomorrow
    relatedType: enrollment.contactId ? "contact" : "lead",
    relatedId: (enrollment.contactId ?? enrollment.leadId) as number,
    status: "open",
    priority: "high" as const,
  });

  console.log(`[SequenceEngine] Paused enrollment ${enrollmentId} due to reply`);
}

/**
 * The LinkedIn profile a DM reply answers, in every spelling a stored
 * profile URL may have: the one our outbound message in that chat was sent
 * to, else the sender's id. Shared by the sequence pause below and the
 * Revenue Engine's (unipileWebhook).
 */
export async function socialReplyProfileUrls(input: { workspaceId: number; chatId: string; senderProviderId: string | null }): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const [outbound] = await db
    .select({ recipient: unipileMessages.recipientProviderId })
    .from(unipileMessages)
    .where(and(
      eq(unipileMessages.workspaceId, input.workspaceId),
      eq(unipileMessages.chatId, input.chatId),
      eq(unipileMessages.direction, "outbound"),
    ))
    .limit(1);
  const identifier = (outbound?.recipient || input.senderProviderId || "").trim();
  return identifier ? linkedinUrlVariants(identifier) : [];
}

/**
 * A genuine LinkedIn reply stops the person's sequences, as an email reply does
 * (audit 2026-10-20, O6).
 *
 * Nothing on the LinkedIn side ever paused an enrolment: a prospect could
 * answer the sequence's DM and get its next email anyway. Called by the
 * messaging webhook for every inbound DM that answers our outreach, before any
 * classifier runs and whatever the autopilot mode — "this person replied" is a
 * fact, not a judgement for a model to make.
 *
 * The person is whoever the outbound row we wrote to them was linked to: its
 * contact or lead, and any prospect whose LinkedIn profile is the one we
 * messaged (prospect enrolments are not linked on unipile rows). Sequences
 * with "Pause enrollment on reply" switched off keep running, as on email.
 */
export async function pauseEnrollmentsForSocialReply(input: {
  workspaceId: number;
  chatId: string;
  senderProviderId: string | null;
  linkedContactId: number | null;
  linkedLeadId: number | null;
}): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const variants = await socialReplyProfileUrls(input);
  const prospectIds = variants.length
    ? (await db.select({ id: prospects.id }).from(prospects)
        .where(and(eq(prospects.workspaceId, input.workspaceId), inArray(prospects.linkedinUrl, variants)))).map((r) => r.id)
    : [];
  const who = [
    ...(input.linkedContactId ? [eq(enrollments.contactId, input.linkedContactId)] : []),
    ...(input.linkedLeadId ? [eq(enrollments.leadId, input.linkedLeadId)] : []),
    ...(prospectIds.length ? [inArray(enrollments.prospectId, prospectIds)] : []),
  ];
  if (who.length === 0) return [];
  const active = await db
    .select({ id: enrollments.id, settings: sequences.settings })
    .from(enrollments)
    .innerJoin(sequences, and(eq(sequences.id, enrollments.sequenceId), eq(sequences.workspaceId, enrollments.workspaceId)))
    .where(and(
      eq(enrollments.workspaceId, input.workspaceId),
      eq(enrollments.status, "active"),
      who.length === 1 ? who[0] : or(...who),
    ));
  const paused: number[] = [];
  for (const e of active) {
    if ((e.settings as { replyDetection?: boolean } | null)?.replyDetection === false) continue;
    await db.update(enrollments).set({ status: "paused", resumeAt: null })
      .where(and(eq(enrollments.id, e.id), eq(enrollments.status, "active")));
    paused.push(e.id);
  }
  if (paused.length) console.log(`[SequenceEngine] LinkedIn reply paused enrollment(s) ${paused.join(", ")}`);
  return paused;
}

/**
 * Resume enrollments whose out-of-office snooze has expired (migration 0181;
 * the stamp is written by services/replyClassifier's out_of_office branch).
 *
 * Runs before processEnrollments on the same 5-minute tick so a resumed row
 * gets its next step immediately. Never writes currentStep: the paused row
 * already points at the next UNSENT step, so resuming is continuation, not a
 * resend — and it files no task and bumps no counter, because none of this is
 * a reply event. Deliberately a separate function rather than a read at the
 * top of processEnrollments: that function's tests consume a queued select
 * chain in strict order.
 */
export async function resumeDueEnrollments(): Promise<{ resumed: number }> {
  const db = await getDb();
  if (!db) return { resumed: 0 };
  const now = new Date();

  const due = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.status, "paused"),
        isNotNull(enrollments.resumeAt),
        lte(enrollments.resumeAt, now)
      )
    )
    .orderBy(enrollments.resumeAt)
    .limit(200);

  const archivedWs = await archivedWorkspaceIds();
  let resumed = 0;
  for (const e of due) {
    // An archived workspace's rows keep their resumeAt and wake on un-archive;
    // archiving that keeps mailing people is not archiving (2026-08-12).
    if (archivedWs.has(e.workspaceId)) continue;
    // Claim-before-act: repeating status + isNotNull in the UPDATE makes an
    // overlapping tick idempotent (the shape inboundReplyPoller uses to claim
    // a draft's first reply). The step keeps the time it was due: waking up
    // must not cut a wait short or restart one (audit 2026-10-20).
    await db
      .update(enrollments)
      .set({ status: "active", resumeAt: null, nextActionAt: resumeNextActionAt(e.nextActionAt, now) } as never)
      .where(
        and(
          eq(enrollments.id, e.id),
          eq(enrollments.status, "paused"),
          isNotNull(enrollments.resumeAt)
        )
      );
    resumed++;
  }
  if (resumed > 0) console.log(`[SequenceEngine] resumed ${resumed} out-of-office enrollment(s)`);
  return { resumed };
}

/**
 * When a resumed enrolment's next step is due: exactly when it was due before
 * the pause (now, if it never had a time).
 *
 * Resuming used to set nextActionAt to now, which did two wrong things. A wait
 * still running was cut short, so the next email went out the moment someone
 * pressed Resume. And a wait whose time had already passed was restarted,
 * because the engine counts a wait from when its step came due (audit
 * 2026-10-20, "resume → spaced steps"). A past time is due on the next tick
 * anyway, so keeping it costs nothing. Everything after stays spaced because
 * each email must go out before the following wait starts counting.
 */
export function resumeNextActionAt(current: Date | string | null | undefined, now: Date = new Date()): Date {
  const t = current ? new Date(current).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t) : now;
}

// ─── Enrollment stats ─────────────────────────────────────────────────────────

/**
 * Get enrollment counts by status for a sequence.
 */
export async function getEnrollmentStats(
  sequenceId: number,
  workspaceId: number
): Promise<{ active: number; paused: number; finished: number; exited: number }> {
  const db = await getDb();
  if (!db) return { active: 0, paused: 0, finished: 0, exited: 0 };

  const rows = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.sequenceId, sequenceId),
        eq(enrollments.workspaceId, workspaceId)
      )
    );

  const stats = { active: 0, paused: 0, finished: 0, exited: 0 };
  for (const row of rows) {
    stats[row.status as keyof typeof stats]++;
  }
  return stats;
}
