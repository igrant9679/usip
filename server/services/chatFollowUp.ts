/**
 * Abandoned-conversation follow-up (Migration 0137).
 *
 * A visitor who gave the agent an email address and then left without booking
 * is the most recoverable thing the chat produces, and until now it was simply
 * lost. This is the only outbound send the chat feature makes, so the guards
 * around it matter more than the feature does.
 *
 * Its own Off/Approve/Auto switch, NOT the agent's `mode`: booking a meeting a
 * visitor just asked for and emailing someone who walked away are different
 * acts with different risk. Same reasoning that gave the 0132 sweep and 0134
 * backfill their own switches.
 *
 * Three guards worth keeping:
 *
 *  - MAX_AGE_DAYS. Turning this on must not blast months of backlog. Only
 *    recently-abandoned conversations are eligible; anything older is marked
 *    handled and skipped, so enabling the switch is not a bulk-mail event.
 *  - `followUpAt` is set for EVERY outcome including skips, so no cron cadence
 *    and no later re-run can double-send to the same person.
 *  - The draft goes through `scrubUnsupportedClaims` exactly like a chat reply.
 *    An email is more durable than a chat message; a fabricated claim in one is
 *    worse, not better.
 */
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import { activities, chatAgents, chatSessions, notifications, tasks } from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import { buildBrandContext } from "./brandContext";
import { scrubUnsupportedClaims, transcriptText, type ChatMessage } from "./chatAgent";
import { isEmailSuppressed } from "../routers/emailSuppressions";
import { sendWorkspaceEmail } from "../emailDelivery";
import { resolveBookingUrl, textToHtml } from "../mergeVars";

/** Conversations older than this are never followed up — see MAX_AGE_DAYS note. */
export const MAX_AGE_DAYS = 7;
/** A one-line drive-by is not worth an email. */
export const MIN_MESSAGES = 2;
/** Per-agent ceiling per run, so a backlog drains steadily rather than at once. */
export const PER_RUN_CAP = 20;

export interface FollowUpCandidate {
  id: number;
  visitorEmail: string | null;
  meetingId: number | null;
  status: string;
  followUpAt: Date | string | null;
  updatedAt: Date | string;
  messageCount: number;
}

function ms(v: Date | string): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * Why a session is or is not eligible. Returning a REASON rather than a boolean
 * is deliberate: a counter with no failure breakdown is a rumour, and this
 * engine spends real sends.
 */
export type SkipReason =
  | "eligible"
  | "no_email"
  | "already_booked"
  | "already_followed_up"
  | "too_recent"
  | "too_old"
  | "too_short";

export function followUpEligibility(
  s: FollowUpCandidate,
  now: Date,
  delayMin: number,
): SkipReason {
  if (!s.visitorEmail) return "no_email";
  if (s.meetingId || s.status === "booked") return "already_booked";
  if (s.followUpAt) return "already_followed_up";
  if ((s.messageCount ?? 0) < MIN_MESSAGES) return "too_short";
  const silentMs = now.getTime() - ms(s.updatedAt);
  if (silentMs < delayMin * 60_000) return "too_recent";
  if (silentMs > MAX_AGE_DAYS * 24 * 60 * 60_000) return "too_old";
  return "eligible";
}

export interface SelectionResult {
  due: FollowUpCandidate[];
  /** Everything not due, by reason — this is what gets logged. */
  skipped: Record<SkipReason, number>;
  /** Stale rows to mark handled so they are never reconsidered. */
  expired: FollowUpCandidate[];
}

export function selectForFollowUp(
  sessions: FollowUpCandidate[],
  now: Date,
  delayMin: number,
  cap: number = PER_RUN_CAP,
): SelectionResult {
  const skipped = {
    eligible: 0, no_email: 0, already_booked: 0, already_followed_up: 0,
    too_recent: 0, too_old: 0, too_short: 0,
  } as Record<SkipReason, number>;
  const due: FollowUpCandidate[] = [];
  const expired: FollowUpCandidate[] = [];

  for (const s of sessions ?? []) {
    const why = followUpEligibility(s, now, delayMin);
    if (why === "eligible") {
      if (due.length < cap) due.push(s);
      continue;
    }
    skipped[why] += 1;
    // Stale-but-otherwise-valid rows get marked handled, so the same rows are
    // not re-examined on every run for the rest of time.
    if (why === "too_old") expired.push(s);
  }
  return { due, skipped, expired };
}

/* ────────────────────────────── The run ────────────────────────────────── */

export interface FollowUpRunResult {
  agentsConsidered: number;
  sent: number;
  queuedForApproval: number;
  suppressed: number;
  failed: number;
  expired: number;
  skipped: Record<SkipReason, number>;
  /** Why the run stopped early, if it did. Never report a bare count. */
  notes: string[];
}

/** Draft the follow-up. Returns null when the model gives us nothing usable. */
async function draftFollowUp(opts: {
  workspaceId: number;
  displayName: string;
  persona: string | null;
  messages: ChatMessage[];
  visitorName: string | null;
  bookingUrl: string;
}): Promise<{ subject: string; body: string } | null> {
  const brand = await buildBrandContext(opts.workspaceId).catch(() => "");
  const prompt = `You are ${opts.displayName}. A visitor chatted with you on our website, gave their email, and then left without booking a meeting. Write ONE short follow-up email to bring them back.

${brand ? `About us:\n${brand}\n` : ""}${opts.persona ? `Additional instructions:\n${opts.persona}\n` : ""}
The conversation:
${transcriptText(opts.messages, opts.displayName)}

Rules:
- Reference the SPECIFIC thing they said they were dealing with. A generic "just following up" is worse than no email.
- Under 90 words. No pleasantries padding, no bullet lists.
- State NO specifics that are not in the conversation or "About us" above — no client names, no savings figures, no prices.
- One clear ask: book a time.${opts.bookingUrl ? ` Use this exact link: ${opts.bookingUrl}` : ""}
- Plain text, no markdown, no signature block — the mail system adds that.

Return JSON: { "subject": "<short, specific, lowercase-ish>", "body": "<the email>" }`;

  try {
    const res = await invokeLLM({
      workspaceId: opts.workspaceId,
      messages: [{ role: "user", content: prompt }],
      // outputSchema forces valid JSON for Anthropic — same pattern as runChatTurn.
      outputSchema: {
        name: "chat_follow_up",
        schema: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
        },
      },
      max_tokens: 500,
    });
    const content = res.choices?.[0]?.message?.content;
    const parsed = JSON.parse(typeof content === "string" && content ? content : "{}");
    const subject = String(parsed?.subject ?? "").trim().slice(0, 200);
    const rawBody = String(parsed?.body ?? "").trim().slice(0, 4000);
    if (!subject || !rawBody) return null;
    // Same guard as a chat reply. An email is MORE durable than a chat message,
    // so a fabricated claim in one is worse, not better.
    const cleaned = scrubUnsupportedClaims(rawBody);
    if (cleaned.removed.length) {
      console.warn("[chatFollowUp] dropped claim(s) from draft:", cleaned.removed.map((r) => r.kind).join(","));
    }
    if (!cleaned.text) return null;
    return { subject, body: cleaned.text };
  } catch (e) {
    console.error("[chatFollowUp] draft failed:", (e as Error).message);
    return null;
  }
}

/**
 * One pass over every agent with follow-up enabled.
 *
 * Best-effort per agent and per session: one failure never blocks the rest.
 */
export async function runChatFollowUps(): Promise<FollowUpRunResult> {
  const out: FollowUpRunResult = {
    agentsConsidered: 0, sent: 0, queuedForApproval: 0, suppressed: 0,
    failed: 0, expired: 0,
    skipped: { eligible: 0, no_email: 0, already_booked: 0, already_followed_up: 0, too_recent: 0, too_old: 0, too_short: 0 },
    notes: [],
  };
  const db = await getDb();
  if (!db) { out.notes.push("database unavailable"); return out; }

  let agents: Array<typeof chatAgents.$inferSelect> = [];
  try {
    agents = await db.select().from(chatAgents).where(
      and(eq(chatAgents.status, "published"), isNotNull(chatAgents.followUpMode)),
    );
  } catch (e) {
    out.notes.push(`could not load agents: ${(e as Error).message}`);
    return out;
  }
  const active = agents.filter((a) => a.followUpMode === "approval" || a.followUpMode === "auto");
  out.agentsConsidered = active.length;
  if (!active.length) { out.notes.push("no agent has follow-up enabled"); return out; }

  const now = new Date();

  for (const agent of active) {
    try {
      const sessions = await db.select({
        id: chatSessions.id,
        visitorEmail: chatSessions.visitorEmail,
        visitorName: chatSessions.visitorName,
        meetingId: chatSessions.meetingId,
        status: chatSessions.status,
        followUpAt: chatSessions.followUpAt,
        updatedAt: chatSessions.updatedAt,
        messageCount: chatSessions.messageCount,
        messages: chatSessions.messages,
        leadId: chatSessions.leadId,
      }).from(chatSessions).where(
        and(eq(chatSessions.agentId, agent.id), isNull(chatSessions.followUpAt)),
      );

      const { due, skipped, expired } = selectForFollowUp(sessions, now, agent.followUpDelayMin);
      for (const k of Object.keys(skipped) as SkipReason[]) out.skipped[k] += skipped[k];

      // Retire stale rows so they are never reconsidered.
      for (const e of expired) {
        await db.update(chatSessions).set({ followUpAt: now } as never)
          .where(eq(chatSessions.id, e.id)).catch(() => {});
        out.expired += 1;
      }
      if (!due.length) continue;

      const bookingUrl = await resolveBookingUrl(
        agent.workspaceId, agent.bookingUserId ?? agent.createdByUserId,
      ).catch(() => "");

      for (const s of due) {
        const email = String(s.visitorEmail);
        try {
          if (await isEmailSuppressed(agent.workspaceId, email)) {
            await db.update(chatSessions).set({ followUpAt: now } as never)
              .where(eq(chatSessions.id, s.id));
            out.suppressed += 1;
            continue;
          }

          const messages = Array.isArray((s as any).messages) ? ((s as any).messages as ChatMessage[]) : [];
          const draft = await draftFollowUp({
            workspaceId: agent.workspaceId,
            displayName: agent.displayName,
            persona: agent.persona,
            messages,
            visitorName: (s as any).visitorName ?? null,
            bookingUrl,
          });
          if (!draft) { out.failed += 1; continue; }

          if (agent.followUpMode === "auto") {
            // No `as never` here on purpose: SendEmailOptions requires `html`,
            // and the cast is exactly what would hide that until runtime.
            const res = await sendWorkspaceEmail(agent.workspaceId, {
              to: email,
              subject: draft.subject,
              text: draft.body,
              html: textToHtml(draft.body),
            });
            if (!res.ok) {
              out.failed += 1;
              out.notes.push(`send failed: ${res.reason ?? "unknown"}`);
              continue;
            }
            await db.update(chatSessions).set({ followUpAt: now } as never)
              .where(eq(chatSessions.id, s.id));
            // activities.relatedType/relatedId are BOTH NOT NULL, so an
            // activity is only meaningful once the chat produced a lead.
            const leadId = (s as any).leadId ?? null;
            if (leadId) {
              await db.insert(activities).values({
                workspaceId: agent.workspaceId,
                type: "email",
                relatedType: "lead",
                relatedId: leadId,
                subject: `Chat follow-up: ${draft.subject}`,
                body: draft.body,
                actorUserId: agent.bookingUserId ?? agent.createdByUserId ?? null,
              } as never).catch(() => {});
            }
            out.sent += 1;
          } else {
            // approval — a human reviews the draft before anything is sent.
            const ownerId = agent.bookingUserId ?? agent.createdByUserId ?? null;
            const leadId = (s as any).leadId ?? null;
            await db.insert(tasks).values({
              workspaceId: agent.workspaceId,
              title: `Follow up: ${(s as any).visitorName || email} left chat without booking`,
              description: `Suggested email\n\nSubject: ${draft.subject}\n\n${draft.body}`,
              type: "follow_up",
              priority: "high",
              status: "open",
              ownerUserId: ownerId,
              ...(leadId ? { relatedType: "lead", relatedId: leadId } : {}),
            } as never);
            if (ownerId) {
              await db.insert(notifications).values({
                workspaceId: agent.workspaceId,
                userId: ownerId,
                kind: "approval_request",
                title: "Chat follow-up ready to review",
                body: `${(s as any).visitorName || email} left without booking. A draft is waiting.`,
              } as never).catch(() => {});
            }
            await db.update(chatSessions).set({ followUpAt: now } as never)
              .where(eq(chatSessions.id, s.id));
            out.queuedForApproval += 1;
          }
        } catch (e) {
          out.failed += 1;
          out.notes.push(`session ${s.id}: ${(e as Error).message}`);
        }
      }
      if (due.length >= PER_RUN_CAP) {
        out.notes.push(`agent ${agent.id} hit the per-run cap of ${PER_RUN_CAP}; more remain`);
      }
    } catch (e) {
      out.notes.push(`agent ${agent.id} failed: ${(e as Error).message}`);
    }
  }
  return out;
}
