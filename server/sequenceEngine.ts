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

import { and, eq, isNull, lte, or } from "drizzle-orm";
import {
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
} from "../drizzle/schema";
import { sendLinkedInInvitation, sendMessage } from "./lib/unipile";
import { getDb } from "./db";
import { invokeLLM } from "./_core/llm";

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
    body: str(raw.body),
    note: str(raw.note),
    // `days` is what the schema stores; `waitDays` is tolerated for safety.
    waitDays: num(raw.days) ?? num(raw.waitDays),
    taskDueOffsetDays: num(raw.taskDueOffsetDays),
    emailMode: raw.emailMode === "dynamic" ? "dynamic" : undefined,
    aiTone: str(raw.aiTone),
    aiLength: str(raw.aiLength),
    aiFocus: str(raw.aiFocus),
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
      workspaceId,
      maxTokens: 700,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            `You write short B2B outreach emails. Tone: ${tone}. Length: ${length}.\n` +
            `Use {{firstName}}, {{company}} and {{senderName}} as literal placeholder tokens — they are substituted per recipient downstream, so never invent a real name or company.\n` +
            `Do not fabricate facts, metrics, or customer names. Do not open with "I hope this email finds you well". Do not add a P.S.`,
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
    const subject = String(parsed?.subject ?? "").trim();
    const body = String(parsed?.body ?? "").trim();
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
 * Current wall-clock info in an IANA timezone (no deps — Intl only).
 * Falls back to UTC on a bad/missing timezone string.
 */
function nowInTz(tz: string | undefined): { hhmm: string; dow: number; dateKey: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      hourCycle: "h23",
      weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      hhmm: `${get("hour")}:${get("minute")}`,
      dow: dowMap[get("weekday")] ?? 1,
      dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    };
  } catch {
    const d = new Date();
    return { hhmm: d.toISOString().slice(11, 16), dow: d.getUTCDay(), dateKey: d.toISOString().slice(0, 10) };
  }
}

type SequenceSendSettings = {
  timezone?: string;
  sendWindowStart?: string;
  sendWindowEnd?: string;
  skipWeekends?: boolean;
};

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

function incrementDailyCount(workspaceId: number): boolean {
  const key = getDailyKey(workspaceId);
  const current = dailyEmailCounts.get(key) ?? 0;
  if (current >= WORKSPACE_DAILY_CAP) return false;
  dailyEmailCounts.set(key, current + 1);
  return true;
}

// ─── Core processor ───────────────────────────────────────────────────────────

/**
 * Process all active enrollments whose nextActionAt is in the past.
 * Called every 5 minutes by the server cron.
 */
export async function processEnrollments(): Promise<{ processed: number; errors: number }> {
  const db = await getDb();
  if (!db) return { processed: 0, errors: 0 };

  const now = new Date();
  let processed = 0;
  let errors = 0;

  // Fetch all active enrollments due for processing
  const due = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.status, "active"),
        or(
          isNull(enrollments.nextActionAt),
          lte(enrollments.nextActionAt, now)
        )
      )
    )
    .limit(200); // process up to 200 per tick to avoid overload

  for (const enrollment of due) {
    try {
      // Fetch the sequence
      const [seq] = await db
        .select()
        .from(sequences)
        .where(eq(sequences.id, enrollment.sequenceId));

      if (!seq || seq.status !== "active") {
        // Sequence is no longer active — exit enrollment
        await db
          .update(enrollments)
          .set({ status: "exited" })
          .where(eq(enrollments.id, enrollment.id));
        continue;
      }

      const steps = normalizeSteps(seq.steps);
      const stepIndex = enrollment.currentStep;

      if (stepIndex >= steps.length) {
        // All steps done — mark finished
        await db
          .update(enrollments)
          .set({ status: "finished" })
          .where(eq(enrollments.id, enrollment.id));
        processed++;
        continue;
      }

      const step = steps[stepIndex];
      const nextStepIndex = stepIndex + 1;
      const hasNextStep = nextStepIndex < steps.length;

      if (step.type === "email") {
        // Enforce the sequence's send window + weekend skip in ITS timezone.
        // These settings existed in the editor but were never consulted in
        // the send path — emails went out at any hour, any day, and the
        // daily key reset at UTC midnight regardless of the configured tz.
        const sendCfg = (seq.settings ?? {}) as SequenceSendSettings;
        const local = nowInTz(sendCfg.timezone);
        if (sendCfg.skipWeekends && (local.dow === 0 || local.dow === 6)) {
          continue; // weekend in the sequence's timezone — try next tick
        }
        const winStart = sendCfg.sendWindowStart ?? "08:00";
        const winEnd = sendCfg.sendWindowEnd ?? "18:00";
        // Zero-padded HH:MM strings compare correctly lexicographically.
        if (local.hhmm < winStart || local.hhmm >= winEnd) {
          continue; // outside the send window — try next tick
        }

        // Enforce daily caps (per-sequence key rolls at the sequence's
        // local midnight, not UTC)
        const seqDailyCap = seq.dailyCap ?? Infinity;
        const seqKey = `seq:${seq.id}:${local.dateKey}`;
        const seqCount = dailyEmailCounts.get(seqKey) ?? 0;

        if (seqCount >= seqDailyCap) {
          // Skip this tick — try again next run
          continue;
        }

        const wsCapOk = incrementDailyCount(enrollment.workspaceId);
        if (!wsCapOk) {
          // Workspace daily cap hit — skip
          continue;
        }
        dailyEmailCounts.set(seqKey, seqCount + 1);

        // Resolve recipient email
        let toEmail: string | undefined;
        let toContactId: number | undefined;
        let toLeadId: number | undefined;
        let toProspectId: number | undefined;

        if (enrollment.contactId) {
          const [contact] = await db
            .select({ email: contacts.email })
            .from(contacts)
            .where(eq(contacts.id, enrollment.contactId));
          toEmail = contact?.email ?? undefined;
          toContactId = enrollment.contactId;
        } else if (enrollment.leadId) {
          const [lead] = await db
            .select({ email: leads.email })
            .from(leads)
            .where(eq(leads.id, enrollment.leadId));
          toEmail = lead?.email ?? undefined;
          toLeadId = enrollment.leadId;
        } else if (enrollment.prospectId) {
          // Prospect-native enrollment path (migration 0085). No
          // contact-promotion happened — engine reads the email
          // straight from the prospects row.
          const [prospect] = await db
            .select({ email: prospects.email })
            .from(prospects)
            .where(eq(prospects.id, enrollment.prospectId));
          toEmail = prospect?.email ?? undefined;
          toProspectId = enrollment.prospectId;
        }

        if (toEmail) {
          // A/B variant assignment: pick a variant for this step if any exist
          let draftSubject = step.subject ?? "Follow-up";
          let draftBody = step.body ?? "";
          const variants = await db
            .select()
            .from(sequenceAbVariants)
            .where(
              and(
                eq(sequenceAbVariants.sequenceId, enrollment.sequenceId),
                eq(sequenceAbVariants.stepIndex, stepIndex),
              ),
            );
          // Pick a variant if any are configured. Increment of sentCount
          // is deferred until AFTER the draft insert succeeds — previously
          // the bump ran first, which left the variant counter wrong when
          // the insert threw (counter says "we sent 5 with variant A"
          // when only 4 drafts actually exist).
          let chosenVariantId: number | null = null;
          let chosenVariantCount: number | null = null;
          if (variants.length > 0) {
            // Weighted random selection based on splitPct. Guard against
            // all-zero weights (Math.random() * 0 = 0, loop never
            // decrements past zero, always picks variants[0] → silent
            // unfairness). Fall back to uniform random when every
            // variant has splitPct=0.
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
            chosenVariantCount = chosen.sentCount;
          }

          // AI-dynamic steps carry no static copy by design — the canvas
          // deliberately hides subject/body for them. Generate now.
          if (step.emailMode === "dynamic" && variants.length === 0) {
            const generated = await generateDynamicEmail(step, enrollment.workspaceId);
            if (generated) {
              draftSubject = generated.subject;
              draftBody = generated.body;
            }
          }

          // HARD GUARD: never create a draft with no body. A dynamic step
          // used to persist as subject:"" body:"" and land here unchanged —
          // `step.subject ?? "Follow-up"` doesn't fire on "" — so the engine
          // queued a genuinely blank email against a real prospect. If we
          // still have nothing to say, skip the send and advance rather than
          // mailing emptiness; the log names the sequence and step.
          const hasContent = draftBody.trim().length > 0;
          if (!hasContent) {
            console.error(
              `[SequenceEngine] sequence ${enrollment.sequenceId} step ${stepIndex}: empty body — send SKIPPED for enrollment ${enrollment.id}.` +
              (step.emailMode === "dynamic"
                ? " AI generation returned nothing (check the workspace's AI provider key)."
                : " The step has no content saved."),
            );
          }

          if (hasContent) {
          // Create email draft for review.
          // stepIndex captures which sequence step this draft was generated
          // for, since enrollment.currentStep will advance before the draft
          // is read by the analytics view.
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
            status: "pending_review",
            aiGenerated: false,
          });
          // Insert succeeded — NOW bump the chosen variant's sent count.
          // If we'd done this before the insert and the insert threw, the
          // variant counter would have over-counted relative to actual
          // drafts created.
          if (chosenVariantId !== null && chosenVariantCount !== null) {
            await db
              .update(sequenceAbVariants)
              .set({ sentCount: chosenVariantCount + 1 })
              .where(eq(sequenceAbVariants.id, chosenVariantId));
          }
          } // end if (hasContent)
        }

        // Advance to next step
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + 60000); // 1 min delay for immediate steps
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }

      } else if (step.type === "wait") {
        // Wait step — just advance to next step and set nextActionAt
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const waitDays = step.waitDays ?? 1;
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + waitDays * 86400000);
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }

      } else if (step.type === "task") {
        // Create a task for the rep
        const dueAt = new Date(
          now.getTime() + (step.taskDueOffsetDays ?? 1) * 86400000
        );
        await db.insert(tasks).values({
          workspaceId: enrollment.workspaceId,
          // title is varchar(240) — normalizeStep already clamps the derived
          // title, but clamp again here so a legacy taskTitle can't overflow.
          title: (step.taskTitle ?? "Follow up").slice(0, 240),
          description: step.taskBody ?? null,
          dueAt,
          relatedType: enrollment.contactId ? "contact" : enrollment.leadId ? "lead" : "prospect",
          relatedId: (enrollment.contactId ?? enrollment.leadId ?? enrollment.prospectId) as number,
          status: "open",
          priority: "normal",
        });

        // Advance to next step
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + 60000);
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }

      } else if (step.type === "linkedin_dm" || step.type === "linkedin_invite") {
        // ── LinkedIn outreach via Unipile ──────────────────────────────────────
        // Resolve the target's LinkedIn URL (used as provider ID lookup)
        let linkedinUrl: string | null | undefined;
        let relatedType: "contact" | "lead" | "prospect" = "contact";
        let relatedId: number | undefined;

        if (enrollment.contactId) {
          const [contact] = await db
            .select({ linkedinUrl: contacts.linkedinUrl })
            .from(contacts)
            .where(eq(contacts.id, enrollment.contactId));
          linkedinUrl = contact?.linkedinUrl;
          relatedType = "contact";
          relatedId = enrollment.contactId;
        } else if (enrollment.leadId) {
          relatedType = "lead";
          relatedId = enrollment.leadId;
          // Leads don't have a linkedinUrl field — skip gracefully
        } else if (enrollment.prospectId) {
          const [prospect] = await db
            .select({ linkedinUrl: prospects.linkedinUrl })
            .from(prospects)
            .where(eq(prospects.id, enrollment.prospectId));
          linkedinUrl = prospect?.linkedinUrl;
          relatedType = "prospect";
          relatedId = enrollment.prospectId;
        }

        // Find the sequence owner's Unipile LinkedIn account
        const [unipileAcct] = await db
          .select()
          .from(unipileAccounts)
          .where(
            and(
              eq(unipileAccounts.workspaceId, enrollment.workspaceId),
              eq(unipileAccounts.provider, "LINKEDIN"),
            ),
          )
          .limit(1);

        if (unipileAcct && linkedinUrl) {
          // Extract the LinkedIn member URN / profile ID from the URL
          // e.g. https://www.linkedin.com/in/john-doe → john-doe
          const profileSlug = linkedinUrl.replace(/\/+$/, "").split("/").pop() ?? linkedinUrl;

          try {
            if (step.type === "linkedin_dm") {
              const result = await sendMessage({
                accountId: unipileAcct.unipileAccountId,
                attendeesIds: [profileSlug],
                text: step.body ?? "",
              });
              // Log to unipile_messages
              await db.insert(unipileMessages).values({
                workspaceId: enrollment.workspaceId,
                unipileAccountId: unipileAcct.unipileAccountId,
                provider: "LINKEDIN",
                chatId: result.id,
                messageId: result.id,
                direction: "outbound",
                text: step.body ?? "",
                linkedContactId: enrollment.contactId ?? null,
                linkedLeadId: enrollment.leadId ?? null,
              });
              // Log activity
              if (relatedId) {
                await db.insert(activities).values({
                  workspaceId: enrollment.workspaceId,
                  type: "linkedin",
                  relatedType,
                  relatedId,
                  subject: "LinkedIn DM sent",
                  body: step.body ?? "",
                });
              }
            } else {
              // linkedin_invite
              await sendLinkedInInvitation({
                accountId: unipileAcct.unipileAccountId,
                providerId: profileSlug,
                message: step.note ?? "",
              });
              // Log to unipile_invites
              await db.insert(unipileInvites).values({
                workspaceId: enrollment.workspaceId,
                userId: unipileAcct.userId,
                unipileAccountId: unipileAcct.unipileAccountId,
                recipientProviderId: profileSlug,
                message: step.note ?? "",
                status: "pending",
                linkedContactId: enrollment.contactId ?? null,
                linkedLeadId: enrollment.leadId ?? null,
              });
              // Log activity
              if (relatedId) {
                await db.insert(activities).values({
                  workspaceId: enrollment.workspaceId,
                  type: "linkedin",
                  relatedType,
                  relatedId,
                  subject: "LinkedIn connection request sent",
                  body: step.note ?? "",
                });
              }
            }
          } catch (liErr) {
            console.warn(`[SequenceEngine] LinkedIn step failed for enrollment ${enrollment.id}:`, liErr);
            // Don't throw — advance past the step so the sequence continues
          }
        } else {
          console.warn(
            `[SequenceEngine] Skipping LinkedIn step for enrollment ${enrollment.id}: ` +
            `${!unipileAcct ? "no Unipile LinkedIn account" : "no LinkedIn URL on contact"}`
          );
        }

        // Advance to next step regardless of LinkedIn outcome
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + 60000);
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }
      }

      processed++;
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

  // Pause enrollment
  await db
    .update(enrollments)
    .set({ status: "paused" })
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
