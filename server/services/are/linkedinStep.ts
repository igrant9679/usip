/**
 * linkedinStep.ts — dispatching a campaign's LinkedIn steps.
 *
 * Until now `areEngine` skipped every non-email step with "Channel 'linkedin'
 * not wired — ARE engine v1 sends email only". That was honest but expensive:
 * on campaign 13, 57 of 126 steps were skipped, so a sequence designed as a
 * multi-channel cadence ran as email-only and roughly 45% of it never happened.
 *
 * ⚠️ EVERY send here goes through the LinkedIn activity gate (migration 0167).
 * That is the whole reason this is safe to wire now and was not before: the
 * gate holds the weekly invite ceiling, the shared per-account daily budget,
 * the spacing between actions and the working-hours window. Without it, adding
 * a second automated source of LinkedIn activity to an account that already
 * has Social Autopilot on it is how accounts get restricted.
 *
 * INVITE OR MESSAGE. You cannot message someone you are not connected to, so
 * the step's meaning depends on the relationship, not on the sequence:
 *   • no invitation on record  → send the connection request
 *   • invitation still pending → wait; the step fires when they accept
 *   • invitation accepted      → send the message
 * The state comes from `unipile_invites`, which the accept webhook already
 * maintains.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  prospectQueue,
  unipileAccounts,
  unipileInvites,
  unipileMessages,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { sendLinkedInInvitation, sendMessage } from "../../lib/unipile";
import { extractLinkedInIdentifier } from "../linkedinLookup";
import { checkLinkedInAction, recordLinkedInAction } from "../linkedin/activityGate";

/** LinkedIn caps a connection note well below any email body's length. */
export const INVITE_NOTE_MAX = 195;

/** A prospect with no LinkedIn URL yet — healable once enrichment finds one. */
export const HEALABLE_NO_LINKEDIN = "Prospect has no LinkedIn profile";

export type LinkedInStepOutcome =
  | { kind: "sent"; via: "invite" | "message"; note: string }
  /** Terminal for this step. */
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string }
  /**
   * Leave the row SCHEDULED and try again later. `stopChannel` means every
   * remaining LinkedIn step this tick would hit the same wall (throttled, or
   * no account connected), so the caller should stop rather than re-ask once
   * per queued step.
   */
  | { kind: "deferred"; reason: string; stopChannel: boolean };

/**
 * Trim a step body down to a connection note.
 *
 * ANY sentence boundary inside the limit wins, even an early one that spends
 * far less of the allowance. The first draft required the break to use at
 * least half the budget, on the reasoning that a 40-character note wastes 155
 * available characters — but that trades a visible "…" for a few more words,
 * and a trailing ellipsis in a connection request is exactly what an automated
 * request looks like to the person receiving it. A short complete thought
 * reads as a person being brief. The word-boundary fallback is only for copy
 * with no sentence break at all.
 *
 * No LLM call: the engine already paid for this copy, and generating a second
 * version here would put a model round-trip inside every LinkedIn step.
 */
export function toInviteNote(body: string, max = INVITE_NOTE_MAX): string {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > 0) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

/**
 * Which LinkedIn account should carry this step: the campaign owner's own,
 * else any connected one in the workspace.
 *
 * Owner-first matters for more than attribution — an invitation arrives from a
 * person, and a prospect researched by one rep receiving a request from
 * another is a worse first impression than the sequence is worth.
 */
export async function pickLinkedInAccount(
  workspaceId: number,
  ownerUserId: number | null,
): Promise<{ unipileAccountId: string; userId: number | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const accts = await db
    .select({ id: unipileAccounts.unipileAccountId, userId: unipileAccounts.userId })
    .from(unipileAccounts)
    .where(and(
      eq(unipileAccounts.workspaceId, workspaceId),
      eq(unipileAccounts.provider, "LINKEDIN"),
    ));
  if (!accts.length) return null;
  const own = ownerUserId ? accts.find((a) => a.userId === ownerUserId) : undefined;
  const chosen = own ?? accts[0];
  return { unipileAccountId: chosen.id, userId: chosen.userId ?? null };
}

/**
 * Send one LinkedIn step. Returns what happened; the caller owns the row
 * update, so this module never writes execution state.
 */
export async function dispatchLinkedInStep(input: {
  workspaceId: number;
  campaignId: number;
  campaignOwnerUserId: number | null;
  prospect: typeof prospectQueue.$inferSelect;
  /** The step's rendered copy. Subject is meaningless on this channel. */
  body: string;
  stepIndex: number;
}): Promise<LinkedInStepOutcome> {
  const db = await getDb();
  if (!db) return { kind: "deferred", reason: "Database unavailable", stopChannel: true };

  const identifier = input.prospect.linkedinUrl
    ? extractLinkedInIdentifier(input.prospect.linkedinUrl)
    : null;
  if (!identifier) {
    // Healable: enrichment adds LinkedIn URLs continuously, and the heal in
    // areEngine re-schedules these once one appears.
    return { kind: "failed", reason: HEALABLE_NO_LINKEDIN };
  }

  const account = await pickLinkedInAccount(input.workspaceId, input.campaignOwnerUserId);
  if (!account) {
    // A configuration gap, not a fact about this prospect — so the step waits
    // rather than dying, and every other LinkedIn step this tick would hit it.
    return { kind: "deferred", reason: "No LinkedIn account connected", stopChannel: true };
  }

  // Where are we with this person? The accept webhook maintains this row.
  const [invite] = await db
    .select({ status: unipileInvites.status, sentAt: unipileInvites.sentAt })
    .from(unipileInvites)
    .where(and(
      eq(unipileInvites.workspaceId, input.workspaceId),
      eq(unipileInvites.recipientProviderId, identifier),
    ))
    .orderBy(desc(unipileInvites.sentAt))
    .limit(1);

  const wantsMessage = invite?.status === "accepted";
  if (invite && !wantsMessage) {
    // Pending. Re-inviting is a duplicate request and a real risk signal, and
    // messaging is impossible until they accept — so the step waits for them.
    return {
      kind: "deferred",
      reason: "Connection request still pending — this step fires when it is accepted",
      stopChannel: false,
    };
  }

  const kind = wantsMessage ? "message" as const : "invite" as const;

  /**
   * THE GATE. Weekly invite ceiling, shared daily budget across every action
   * type on this account, spacing, working hours, warm-up. A refusal defers
   * the step and stops the channel for this tick — the next step would get the
   * identical verdict.
   */
  const gate = await checkLinkedInAction({
    workspaceId: input.workspaceId,
    unipileAccountId: account.unipileAccountId,
    kind,
  });
  if (!gate.allowed) {
    return { kind: "deferred", reason: gate.message, stopChannel: true };
  }

  const name = [input.prospect.firstName, input.prospect.lastName].filter(Boolean).join(" ").trim()
    || input.prospect.email
    || identifier;

  try {
    if (kind === "invite") {
      const note = toInviteNote(input.body);
      await sendLinkedInInvitation({
        accountId: account.unipileAccountId,
        providerId: identifier,
        message: note,
      });
      await recordLinkedInAction({
        workspaceId: input.workspaceId,
        unipileAccountId: account.unipileAccountId,
        kind: "invite",
        source: "are_engine",
        targetIdentifier: identifier,
      });
      // Recorded so the accept webhook can find it, the next step knows the
      // state, and Social Autopilot does not invite the same person again.
      await db.insert(unipileInvites).values({
        workspaceId: input.workspaceId,
        userId: account.userId ?? 0,
        unipileAccountId: account.unipileAccountId,
        recipientProviderId: identifier,
        recipientName: name,
        message: note,
        status: "pending",
      } as never);
      return { kind: "sent", via: "invite", note };
    }

    const text = String(input.body ?? "").trim();
    if (!text) return { kind: "skipped", reason: "Step has no message body" };
    const sent = await sendMessage({
      accountId: account.unipileAccountId,
      attendeesIds: [identifier],
      text,
    });
    await recordLinkedInAction({
      workspaceId: input.workspaceId,
      unipileAccountId: account.unipileAccountId,
      kind: "message",
      source: "are_engine",
      targetIdentifier: identifier,
    });
    await db.insert(unipileMessages).values({
      workspaceId: input.workspaceId,
      unipileAccountId: account.unipileAccountId,
      provider: "linkedin",
      chatId: sent.id || identifier,
      messageId: sent.id || `are-${input.campaignId}-${input.stepIndex}-${identifier}`,
      direction: "outbound",
      recipientName: name,
      recipientProviderId: identifier,
      text,
    } as never);
    return { kind: "sent", via: "message", note: text };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // Provider failures are about this moment or this account, not about the
    // prospect — but they are not auto-healed, because a repeated invite is a
    // reputation cost rather than a retryable no-op.
    return { kind: "failed", reason: `LinkedIn ${kind} failed: ${msg}`.slice(0, 500) };
  }
}
