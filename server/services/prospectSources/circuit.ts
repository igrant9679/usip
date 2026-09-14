/**
 * Per-vendor circuit breaker.
 *
 * Open after N consecutive failures, half-open after a cooldown that grows
 * with each further failure (15 min → 30 → 60 → 120, capped). An open
 * circuit removes the source from the waterfall's eligible set without
 * failing the run — a single vendor being down must degrade discovery, not
 * stop it.
 *
 * Table-mode sources persist the state on their credential row so a deploy
 * restart does not forget that a vendor was refusing us; legacy sources keep
 * it in memory (their credentials live in workspace_settings, which has no
 * such columns, and a restart resetting an in-memory breaker is acceptable —
 * the next failure re-opens it).
 *
 * Terminal failures (unauthorized / insufficient_scope / plan_required) do
 * NOT trip the breaker: they are configuration facts, recorded on the
 * credential as `invalid`, and a cooldown would only hide them.
 */
import { and, eq, sql } from "drizzle-orm";
import { prospectSourceCredentials } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ProspectSourceSlug } from "@shared/prospectSources";

export const CIRCUIT_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export function cooldownFor(consecutiveFailures: number): number {
  const over = Math.max(0, consecutiveFailures - CIRCUIT_THRESHOLD);
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.pow(2, over));
}

const memory = new Map<string, { failures: number; openUntil: number | null }>();

export interface CircuitState {
  open: boolean;
  failures: number;
  openUntil: Date | null;
}

export async function circuitState(workspaceId: number, slug: ProspectSourceSlug, mode: "table" | "legacy", now = new Date()): Promise<CircuitState> {
  if (mode === "legacy") {
    const m = memory.get(`${workspaceId}:${slug}`);
    const openUntil = m?.openUntil ?? null;
    return { open: openUntil != null && openUntil > now.getTime(), failures: m?.failures ?? 0, openUntil: openUntil ? new Date(openUntil) : null };
  }
  const db = await getDb();
  if (!db) return { open: false, failures: 0, openUntil: null };
  const [row] = await db
    .select({ failures: prospectSourceCredentials.consecutiveFailures, until: prospectSourceCredentials.circuitOpenUntil })
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, slug)))
    .limit(1);
  const until = row?.until ?? null;
  return { open: until != null && until.getTime() > now.getTime(), failures: row?.failures ?? 0, openUntil: until };
}

export async function recordFailure(workspaceId: number, slug: ProspectSourceSlug, mode: "table" | "legacy", now = new Date()): Promise<CircuitState> {
  if (mode === "legacy") {
    const k = `${workspaceId}:${slug}`;
    const m = memory.get(k) ?? { failures: 0, openUntil: null };
    m.failures += 1;
    if (m.failures >= CIRCUIT_THRESHOLD) m.openUntil = now.getTime() + cooldownFor(m.failures);
    memory.set(k, m);
    return circuitState(workspaceId, slug, mode, now);
  }
  const db = await getDb();
  if (!db) return { open: false, failures: 0, openUntil: null };
  await db.update(prospectSourceCredentials)
    .set({ consecutiveFailures: sql`${prospectSourceCredentials.consecutiveFailures} + 1` } as never)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, slug)));
  const st = await circuitState(workspaceId, slug, mode, now);
  if (st.failures >= CIRCUIT_THRESHOLD) {
    const until = new Date(now.getTime() + cooldownFor(st.failures));
    await db.update(prospectSourceCredentials).set({ circuitOpenUntil: until } as never)
      .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, slug)));
    return { ...st, open: true, openUntil: until };
  }
  return st;
}

export async function recordSuccess(workspaceId: number, slug: ProspectSourceSlug, mode: "table" | "legacy"): Promise<void> {
  if (mode === "legacy") { memory.delete(`${workspaceId}:${slug}`); return; }
  const db = await getDb();
  if (!db) return;
  await db.update(prospectSourceCredentials)
    .set({ consecutiveFailures: 0, circuitOpenUntil: null } as never)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, slug)));
}

/** Test seam. */
export function _resetCircuitMemory(): void { memory.clear(); }
