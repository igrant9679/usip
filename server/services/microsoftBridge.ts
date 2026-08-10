/**
 * microsoftBridge — the ONE implementation of "a connected Microsoft
 * account appears in /mailbox and /calendar".
 *
 * A Unipile OUTLOOK/MICROSOFT account only becomes visible in the Mailbox
 * UI through a `sending_accounts` row (unipileAccountId set) and in the
 * Calendar UI through a `calendar_accounts` row. That bridging used to
 * live inline in the connect webhook — which means it ran ONLY at the
 * moment of connection. Accounts connected before the bridge code shipped
 * never got rows, and their owners saw a permanently empty Mailbox while
 * Connected Accounts said "connected" (the owner hit exactly this,
 * 2026-08-09).
 *
 * Now the webhook and a boot-time backfill sweep both call THIS function,
 * so the invariant is self-healing: every Microsoft account, whenever it
 * was connected, gets its bridges within a minute of the next deploy.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { calendarAccounts, sendingAccounts, unipileAccounts } from "../../drizzle/schema";

export async function ensureMicrosoftBridge(params: {
  workspaceId: number;
  userId: number;
  unipileAccountId: string;
  displayName: string | null;
}): Promise<{ mailBridged: boolean; calendarBridged: boolean }> {
  const db = await getDb();
  if (!db) return { mailBridged: false, calendarBridged: false };
  const { workspaceId, userId, unipileAccountId, displayName } = params;

  const looksLikeEmail = !!displayName && /@/.test(displayName);
  const fromEmail = looksLikeEmail ? displayName! : `${unipileAccountId}@unipile.local`;
  const bridgeName = displayName ?? `Microsoft (${unipileAccountId.slice(0, 8)})`;
  let mailBridged = false;
  let calendarBridged = false;

  // sending_accounts bridge — upsert by unipileAccountId.
  try {
    const [existingSend] = await db
      .select({ id: sendingAccounts.id })
      .from(sendingAccounts)
      .where(and(
        eq(sendingAccounts.workspaceId, workspaceId),
        eq(sendingAccounts.unipileAccountId, unipileAccountId),
      ))
      .limit(1);
    if (existingSend) {
      await db.update(sendingAccounts)
        .set({ name: bridgeName, fromEmail })
        .where(eq(sendingAccounts.id, existingSend.id));
    } else {
      await db.insert(sendingAccounts).values({
        workspaceId,
        name: bridgeName,
        // 'outlook_oauth' reuses an existing enum value — the
        // unipileAccountId column is the discriminator the adapter reads.
        provider: "outlook_oauth",
        fromEmail,
        unipileAccountId,
      });
      mailBridged = true;
      console.log(`[microsoftBridge] Bridged sending_accounts for Unipile ${unipileAccountId}`);
    }
  } catch (e) {
    console.error("[microsoftBridge] sending_accounts bridge failed:", e);
  }

  // calendar_accounts bridge — upsert by unipileAccountId.
  try {
    const [existingCal] = await db
      .select({ id: calendarAccounts.id })
      .from(calendarAccounts)
      .where(and(
        eq(calendarAccounts.workspaceId, workspaceId),
        eq(calendarAccounts.unipileAccountId, unipileAccountId),
      ))
      .limit(1);
    if (existingCal) {
      await db.update(calendarAccounts)
        .set({ label: bridgeName, email: looksLikeEmail ? displayName! : null })
        .where(eq(calendarAccounts.id, existingCal.id));
    } else {
      await db.insert(calendarAccounts).values({
        workspaceId,
        userId,
        provider: "outlook_oauth",
        label: bridgeName,
        email: looksLikeEmail ? displayName! : null,
        unipileAccountId,
      });
      calendarBridged = true;
      console.log(`[microsoftBridge] Bridged calendar_accounts for Unipile ${unipileAccountId}`);
    }
  } catch (e) {
    console.error("[microsoftBridge] calendar_accounts bridge failed:", e);
  }

  return { mailBridged, calendarBridged };
}

/**
 * Boot-time heal: every Microsoft-type Unipile account gets its bridges,
 * regardless of when it was connected. Idempotent — existing bridges are
 * refreshed, not duplicated. Any status is included: a briefly-errored
 * account still deserves its rows for the moment it recovers.
 */
export async function backfillMicrosoftBridges(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db
    .select({
      workspaceId: unipileAccounts.workspaceId,
      userId: unipileAccounts.userId,
      unipileAccountId: unipileAccounts.unipileAccountId,
      displayName: unipileAccounts.displayName,
      provider: unipileAccounts.provider,
    })
    .from(unipileAccounts)
    .where(inArray(unipileAccounts.provider, ["OUTLOOK", "MICROSOFT"]));
  let healed = 0;
  for (const r of rows) {
    const res = await ensureMicrosoftBridge({
      workspaceId: r.workspaceId,
      userId: r.userId,
      unipileAccountId: r.unipileAccountId,
      displayName: r.displayName,
    });
    if (res.mailBridged || res.calendarBridged) healed++;
  }
  if (healed > 0) {
    console.log(`[microsoftBridge] Backfill healed ${healed} unbridged Microsoft account(s)`);
  }
}
