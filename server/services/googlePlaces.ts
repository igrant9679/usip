/**
 * Google Places API client + budget enforcement.
 *
 * Uses the "Places API (New)" v1 endpoint family — Google's modern Places
 * surface that replaces the legacy Places API in 2024. Authentication is
 * via API key in the `X-Goog-Api-Key` header (NOT a query param, to avoid
 * leaking the key in URL logs).
 *
 * Pricing (as of 2026, USD per 1k requests, billed per-call):
 *   Text Search        — $17 per 1,000  (1.7 cents per call)
 *   Place Details (id) — $17 per 1,000  (1.7 cents per call, basic SKU)
 *
 * The $200/month free credit Google offers covers about 11,700 calls
 * per month at these rates. We default each workspace to a $200 cap.
 *
 * Budget enforcement model:
 *   - Each call goes through `enforceBudgetAndLog()` which:
 *       1. Lazy-rolls the period if month changed (resets usage_cents to 0)
 *       2. Refuses the call if usage ≥ budget OR `enabled=false`
 *       3. Increments usage + log on success (or "blocked" / "error" status)
 *       4. Fires the threshold notification once per period when crossing
 *
 *   - Threshold notification is in-app only here. The email-out hook is
 *     wired in Phase 1b (see TODO at bottom).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  placesBudget,
  placesSearchLog,
  notifications,
  workspaceMembers,
  users,
  workspaces,
} from "../../drizzle/schema";
import { sendWorkspaceEmail } from "../emailDelivery";

const PLACES_BASE = "https://places.googleapis.com/v1";

/* ─── Per-endpoint costs (cents) ───────────────────────────────────────── */
const COST_CENTS: Record<string, number> = {
  // Round to nearest cent; Google bills fractional but we want integer math.
  textsearch: 2, // 1.7¢ → round up to 2¢ (conservative — bills always meet/exceed actual)
  details: 2,
};

/* ─── Public API shapes ─────────────────────────────────────────────────── */

export type PlacesTextSearchInput = {
  /** Free-text query, e.g. "dentists in Leesburg, VA" */
  query: string;
  /** Optional centerpoint + radius (meters) to constrain the search. */
  locationBias?: {
    lat: number;
    lng: number;
    radiusMeters: number;
  };
  /** Place type filter, e.g. "restaurant", "law_firm", "dentist". */
  includedType?: string;
  /** Up to 20 results per call. */
  maxResultCount?: number;
};

export type PlacesResult = {
  placeId: string;
  name: string;
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  types?: string[];
  location?: { lat: number; lng: number };
  googleMapsUri?: string;
};

export type BudgetState = {
  workspaceId: number;
  monthlyBudgetCents: number;
  thresholdPct: number;
  enabled: boolean;
  usageCents: number;
  callsCount: number;
  periodStart: Date;
  thresholdAlertSentAt: Date | null;
  capReachedAt: Date | null;
  /** Derived: usage / budget — useful for the UI meter */
  usagePct: number;
  /** Derived: usage above threshold? */
  thresholdCrossed: boolean;
  /** Derived: usage at or beyond cap? */
  capReached: boolean;
};

/* ─── Env helper ───────────────────────────────────────────────────────── */

function getApiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "GOOGLE_PLACES_API_KEY is not configured.",
    });
  }
  return key;
}

/* ─── Budget lifecycle ─────────────────────────────────────────────────── */

/** Read or auto-create the per-workspace budget row, rolling the period if stale. */
async function loadBudget(workspaceId: number): Promise<BudgetState> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  let [row] = await db
    .select()
    .from(placesBudget)
    .where(eq(placesBudget.workspaceId, workspaceId))
    .limit(1);

  if (!row) {
    // onDuplicateKeyUpdate makes this safe under concurrent first-requests
    // for the same workspace (workspaceId is the PK) — a plain insert would
    // throw an uncaught dup-key error on the loser of the race.
    await db
      .insert(placesBudget)
      .values({ workspaceId } as never)
      .onDuplicateKeyUpdate({ set: { workspaceId } });
    [row] = await db
      .select()
      .from(placesBudget)
      .where(eq(placesBudget.workspaceId, workspaceId))
      .limit(1);
  }
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Budget row missing" });

  // Lazy period roll — if periodStart is in a previous calendar month,
  // reset the counters. This is cheaper than a cron and is correct from
  // the perspective of any caller (they always see the current period).
  const now = new Date();
  const ps = new Date(row.periodStart);
  if (ps.getUTCFullYear() !== now.getUTCFullYear() || ps.getUTCMonth() !== now.getUTCMonth()) {
    await db
      .update(placesBudget)
      .set({
        usageCents: 0,
        callsCount: 0,
        periodStart: now,
        thresholdAlertSentAt: null,
        capReachedAt: null,
      })
      .where(eq(placesBudget.workspaceId, workspaceId));
    row = { ...row, usageCents: 0, callsCount: 0, periodStart: now, thresholdAlertSentAt: null, capReachedAt: null };
  }

  return deriveBudgetState(row);
}

function deriveBudgetState(row: typeof placesBudget.$inferSelect): BudgetState {
  const usagePct = row.monthlyBudgetCents > 0 ? (row.usageCents / row.monthlyBudgetCents) * 100 : 0;
  return {
    workspaceId: row.workspaceId,
    monthlyBudgetCents: row.monthlyBudgetCents,
    thresholdPct: row.thresholdPct,
    enabled: row.enabled,
    usageCents: row.usageCents,
    callsCount: row.callsCount,
    periodStart: row.periodStart,
    thresholdAlertSentAt: row.thresholdAlertSentAt,
    capReachedAt: row.capReachedAt,
    usagePct,
    thresholdCrossed: usagePct >= row.thresholdPct,
    capReached: row.usageCents >= row.monthlyBudgetCents,
  };
}

export async function getBudget(workspaceId: number): Promise<BudgetState> {
  return loadBudget(workspaceId);
}

export async function setBudget(
  workspaceId: number,
  patch: { monthlyBudgetCents?: number; thresholdPct?: number; enabled?: boolean },
): Promise<BudgetState> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  await loadBudget(workspaceId); // ensures row exists + period rolled
  await db
    .update(placesBudget)
    .set({
      ...(patch.monthlyBudgetCents !== undefined ? { monthlyBudgetCents: patch.monthlyBudgetCents } : {}),
      ...(patch.thresholdPct !== undefined ? { thresholdPct: patch.thresholdPct } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    })
    .where(eq(placesBudget.workspaceId, workspaceId));
  return loadBudget(workspaceId);
}

/**
 * Charge the budget for one API call.
 *
 *   - Refuses if disabled or cap reached BEFORE the call (returns "blocked")
 *   - Otherwise increments usage and writes the audit log
 *   - Fires the in-app notification once per period when the threshold is
 *     crossed (idempotent via thresholdAlertSentAt)
 */
/**
 * Atomically reserve `cost` cents against the budget. The conditional
 * UPDATE only succeeds when the integration is enabled AND the post-charge
 * total stays within the cap — so concurrent searches at 99% can't all
 * slip past a read-only pre-check (the old TOCTOU bug). affectedRows===0
 * means refused; we then read the row once to tell disabled vs cap apart
 * for the error message.
 */
async function reserveBudget(
  workspaceId: number,
  cost: number,
): Promise<{ ok: boolean; reason?: "disabled" | "cap" }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "disabled" };
  const [res] = await db.execute(
    sql`UPDATE \`places_budget\`
        SET \`usage_cents\` = \`usage_cents\` + ${cost},
            \`calls_count\` = \`calls_count\` + 1
        WHERE \`workspaceId\` = ${workspaceId}
          AND \`enabled\` = 1
          AND \`usage_cents\` + ${cost} <= \`monthly_budget_cents\``,
  );
  const affected = (res as { affectedRows?: number })?.affectedRows ?? 0;
  if (affected > 0) return { ok: true };
  const [row] = await db
    .select({ enabled: placesBudget.enabled })
    .from(placesBudget)
    .where(eq(placesBudget.workspaceId, workspaceId))
    .limit(1);
  return { ok: false, reason: row && !row.enabled ? "disabled" : "cap" };
}

/** Reverse a reservation when the downstream Google call fails. */
async function refundBudget(workspaceId: number, cost: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(
    sql`UPDATE \`places_budget\`
        SET \`usage_cents\` = GREATEST(0, \`usage_cents\` - ${cost}),
            \`calls_count\` = GREATEST(0, \`calls_count\` - 1)
        WHERE \`workspaceId\` = ${workspaceId}`,
  );
}

/** Write one audit-log row. Never throws (logging must not break the call). */
async function logCall(opts: {
  workspaceId: number;
  userId?: number;
  endpoint: keyof typeof COST_CENTS;
  query: string | null;
  resultsCount?: number;
  status: "ok" | "blocked" | "error";
  costCents: number;
  error?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(placesSearchLog).values({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      endpoint: opts.endpoint,
      query: opts.query,
      costCents: opts.costCents,
      resultsCount: opts.resultsCount,
      status: opts.status,
      error: opts.error,
    } as never);
  } catch (e) {
    console.error("[Places] audit log insert failed:", e);
  }
}

/**
 * After a successful (reserved + charged) call, fire the threshold / cap
 * side-effects. Each is gated by a conditional UPDATE whose affectedRows
 * decides the single winner — so concurrent crossers don't double-notify.
 */
async function fireBudgetSideEffects(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const state = await loadBudget(workspaceId);

  if (state.thresholdCrossed && !state.thresholdAlertSentAt) {
    const [r] = await db.execute(
      sql`UPDATE \`places_budget\`
          SET \`threshold_alert_sent_at\` = NOW()
          WHERE \`workspaceId\` = ${workspaceId}
            AND \`threshold_alert_sent_at\` IS NULL`,
    );
    if (((r as { affectedRows?: number })?.affectedRows ?? 0) > 0) {
      await emitThresholdNotification(workspaceId, state);
    }
  }

  if (state.capReached && !state.capReachedAt) {
    await db.execute(
      sql`UPDATE \`places_budget\`
          SET \`cap_reached_at\` = NOW()
          WHERE \`workspaceId\` = ${workspaceId}
            AND \`cap_reached_at\` IS NULL`,
    );
  }
}

async function emitThresholdNotification(workspaceId: number, state: BudgetState): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const dollars = (state.usageCents / 100).toFixed(2);
  const budgetDollars = (state.monthlyBudgetCents / 100).toFixed(2);
  // Fan out one in-app notification per admin/super_admin in the workspace.
  // The notifications table enforces NOT NULL on userId + kind enum, so
  // we can't write a single workspace-wide row.
  try {
    const admins = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.role, ["admin", "super_admin"]),
          isNull(workspaceMembers.deactivatedAt),
        ),
      );
    if (admins.length === 0) return;
    await db.insert(notifications).values(
      admins.map((a) => ({
        workspaceId,
        userId: a.userId,
        kind: "system" as const,
        title: `Google Places usage at ${Math.round(state.usagePct)}%`,
        body: `Your workspace has used $${dollars} of the $${budgetDollars} monthly Google Places API budget. Searches will be blocked when usage hits 100%. Adjust the cap or threshold in Settings → Integrations.`,
        relatedType: "places_budget",
        relatedId: workspaceId,
      })) as never,
    );
  } catch (e) {
    // Don't let a notification failure block the API call
    console.error("[Places] threshold notification failed:", e);
  }
  // Phase 1b — also email all admins.
  await emitThresholdEmail(workspaceId, state).catch((e) =>
    console.error("[Places] threshold email failed:", e),
  );
}

/**
 * Send a single email to all admin/super_admin users in the workspace
 * announcing that the Places budget threshold has been crossed. Uses the
 * workspace's SMTP config (Settings → Email Delivery). Failure is logged
 * but not fatal — the in-app notification path is the primary alert.
 */
async function emitThresholdEmail(workspaceId: number, state: BudgetState): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const dollars = (state.usageCents / 100).toFixed(2);
  const budgetDollars = (state.monthlyBudgetCents / 100).toFixed(2);
  const pct = Math.round(state.usagePct);

  // Pull admin emails + workspace name for the message
  const admins = await db
    .select({ email: users.email, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.role, ["admin", "super_admin"]),
        isNull(workspaceMembers.deactivatedAt),
      ),
    );
  const recipients = admins.map((a) => a.email).filter((e): e is string => !!e);
  if (recipients.length === 0) return;

  const [ws] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const wsName = ws?.name ?? "your workspace";

  const settingsUrl = `${(process.env.MANUS_APP_URL ?? "").replace(/\/+$/, "")}/settings`;

  const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
  <div style="margin-bottom:16px;color:#B45309;font-weight:600">Velocity — Budget Alert</div>
  <h2 style="margin:0 0 8px;font-size:18px">Google Places API usage at ${pct}%</h2>
  <p style="margin:0 0 12px;color:#374151">
    The <strong>${wsName}</strong> workspace has used <strong>$${dollars}</strong> of the
    <strong>$${budgetDollars}</strong> monthly Google Places budget so far this period.
  </p>
  <p style="margin:0 0 12px;color:#374151">
    Once usage reaches 100%, new Places searches will be blocked until the budget resets
    on the 1st of next month (UTC) or you raise the cap.
  </p>
  ${settingsUrl ? `<p style="margin:24px 0"><a href="${settingsUrl}" style="display:inline-block;background:#1E55D0;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Adjust budget in Settings</a></p>` : ""}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
  <p style="color:#9ca3af;font-size:11px">
    You're receiving this because you have admin or super-admin role on the workspace.
    To stop these alerts, lower the threshold % (or disable Places integration) in
    Settings → Integrations.
  </p>
</div>`.trim();

  const text =
    `Google Places API usage at ${pct}% — ` +
    `$${dollars} of $${budgetDollars} monthly budget used. ` +
    `New searches will be blocked at 100%. Adjust in Settings → Integrations.`;

  await sendWorkspaceEmail(workspaceId, {
    to: recipients,
    subject: `[Velocity] Places API usage at ${pct}% in ${wsName}`,
    html,
    text,
  });
}

/* ─── Public: Text Search ─────────────────────────────────────────────── */

/**
 * Run a Google Places Text Search and return parsed results.
 *
 * Throws TRPCError with code "PRECONDITION_FAILED" if the budget is
 * exhausted or disabled — the caller should surface that as a clean
 * UI error rather than a 500.
 */
export async function textSearch(opts: {
  workspaceId: number;
  userId: number;
  input: PlacesTextSearchInput;
}): Promise<{ results: PlacesResult[]; budget: BudgetState }> {
  // loadBudget rolls the period if the month changed; we then reserve the
  // cost ATOMICALLY before calling Google. The conditional UPDATE is the
  // real gate — no read-then-act TOCTOU window.
  const preBudget = await loadBudget(opts.workspaceId);
  const cost = COST_CENTS["textsearch"] ?? 0;
  const reservation = await reserveBudget(opts.workspaceId, cost);
  if (!reservation.ok) {
    await logCall({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      endpoint: "textsearch",
      query: opts.input.query,
      status: "blocked",
      costCents: 0,
      error:
        reservation.reason === "disabled"
          ? "Google Places integration is disabled for this workspace."
          : "Monthly Google Places budget cap reached.",
    });
    if (reservation.reason === "disabled") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Google Places integration is disabled for this workspace. Re-enable in Settings.",
      });
    }
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Monthly Google Places budget cap reached ($${(preBudget.monthlyBudgetCents / 100).toFixed(2)}). Resets on the 1st of next month, or raise the cap in Settings.`,
    });
  }

  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    textQuery: opts.input.query,
    maxResultCount: Math.min(Math.max(opts.input.maxResultCount ?? 10, 1), 20),
  };
  if (opts.input.locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.input.locationBias.lat, longitude: opts.input.locationBias.lng },
        radius: opts.input.locationBias.radiusMeters,
      },
    };
  }
  if (opts.input.includedType) {
    body.includedType = opts.input.includedType;
  }

  // FieldMask is REQUIRED by Places API New — controls which fields are
  // returned and which SKU you're billed against. We keep it lean to stay
  // on the basic SKU.
  const fieldMask = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.websiteUri",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.rating",
    "places.userRatingCount",
    "places.primaryType",
    "places.types",
    "places.location",
    "places.googleMapsUri",
  ].join(",");

  let raw: { places?: GoogleRawPlace[] } | null = null;
  try {
    const res = await fetch(`${PLACES_BASE}/places:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      // Google rejected the call — refund the reservation so a failed
      // request doesn't eat budget.
      await refundBudget(opts.workspaceId, cost);
      await logCall({
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        endpoint: "textsearch",
        query: opts.input.query,
        status: "error",
        costCents: 0,
        error: `${res.status}: ${text.slice(0, 500)}`,
      });
      throw new TRPCError({ code: "BAD_GATEWAY", message: `Google Places error: ${text.slice(0, 200)}` });
    }
    raw = (await res.json()) as { places?: GoogleRawPlace[] };
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    await refundBudget(opts.workspaceId, cost);
    await logCall({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      endpoint: "textsearch",
      query: opts.input.query,
      status: "error",
      costCents: 0,
      error: (e as Error).message,
    });
    throw new TRPCError({ code: "BAD_GATEWAY", message: (e as Error).message });
  }

  const results: PlacesResult[] = (raw.places ?? []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text ?? "(unnamed)",
    formattedAddress: p.formattedAddress,
    websiteUri: p.websiteUri,
    nationalPhoneNumber: p.nationalPhoneNumber,
    internationalPhoneNumber: p.internationalPhoneNumber,
    rating: p.rating,
    userRatingCount: p.userRatingCount,
    primaryType: p.primaryType,
    types: p.types,
    location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
    googleMapsUri: p.googleMapsUri,
  }));

  // Budget was already reserved before the call. Just record the audit
  // row + fire threshold/cap side-effects.
  await logCall({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    endpoint: "textsearch",
    query: opts.input.query,
    resultsCount: results.length,
    status: "ok",
    costCents: cost,
  });
  await fireBudgetSideEffects(opts.workspaceId);

  const budget = await loadBudget(opts.workspaceId);
  return { results, budget };
}

/* ─── Internal: Google's raw response shape ────────────────────────────── */

type GoogleRawPlace = {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
};
