/**
 * Clodura client-side rate limiter
 * Enforces: 10 req/s, 100 req/min, 2000 req/day per workspace
 * Uses in-memory sliding window counters (good enough for single-process deployments)
 */

interface WindowEntry {
  count: number;
  windowStart: number;
}

// Per-workspace counters: workspaceId → { second, minute, day }
const counters = new Map<number, { second: WindowEntry; minute: WindowEntry; day: WindowEntry }>();

function getOrCreate(workspaceId: number) {
  if (!counters.has(workspaceId)) {
    const now = Date.now();
    counters.set(workspaceId, {
      second: { count: 0, windowStart: now },
      minute: { count: 0, windowStart: now },
      day: { count: 0, windowStart: now },
    });
  }
  return counters.get(workspaceId)!;
}

function resetIfExpired(entry: WindowEntry, windowMs: number): WindowEntry {
  const now = Date.now();
  if (now - entry.windowStart >= windowMs) {
    return { count: 0, windowStart: now };
  }
  return entry;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export function checkRateLimit(workspaceId: number): RateLimitResult {
  const c = getOrCreate(workspaceId);
  const now = Date.now();

  // Reset expired windows
  c.second = resetIfExpired(c.second, 1_000);
  c.minute = resetIfExpired(c.minute, 60_000);
  c.day = resetIfExpired(c.day, 86_400_000);

  if (c.second.count >= 10) {
    return {
      allowed: false,
      retryAfterMs: 1_000 - (now - c.second.windowStart),
      reason: "Rate limit: 10 requests per second exceeded",
    };
  }
  if (c.minute.count >= 100) {
    return {
      allowed: false,
      retryAfterMs: 60_000 - (now - c.minute.windowStart),
      reason: "Rate limit: 100 requests per minute exceeded",
    };
  }
  if (c.day.count >= 2000) {
    return {
      allowed: false,
      retryAfterMs: 86_400_000 - (now - c.day.windowStart),
      reason: "Rate limit: 2000 requests per day exceeded",
    };
  }

  // Increment all windows
  c.second.count++;
  c.minute.count++;
  c.day.count++;

  return { allowed: true };
}

/** Returns remaining daily quota for a workspace */
export function getDailyRemaining(workspaceId: number): number {
  const c = getOrCreate(workspaceId);
  c.day = resetIfExpired(c.day, 86_400_000);
  return Math.max(0, 2000 - c.day.count);
}
