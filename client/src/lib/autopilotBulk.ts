/**
 * "Set all autopilots" on the Autonomy Center (audit 2026-10-20, G62).
 *
 * It fired about thirteen mutations back to back, with no confirmation, and
 * said "All autopilots set to Autonomous" before any of them had answered, so
 * a refusal or a failure still read as success. Now the screen names what will
 * change and asks first (except for Off, which only stops things), runs every
 * change to completion, and reports success only when all of them succeeded.
 */

export type AutopilotMode = "off" | "approval" | "auto";
export const MODE_NAME: Record<string, string> = { off: "Off", approval: "Approve", auto: "Autonomous" };

export type BulkChange = { key: string; label: string; blurb?: string; from: string; to: AutopilotMode };

/** The autopilots that `mode` would change, with what each is now. */
export function bulkAutopilotChanges(
  rows: { key: string; label: string; blurb?: string; mode: string }[],
  mode: AutopilotMode,
): BulkChange[] {
  return rows.filter((r) => r.mode !== mode).map((r) => ({ key: r.key, label: r.label, blurb: r.blurb, from: r.mode, to: mode }));
}

/** Turning things on is confirmed; turning them all off is not, so stopping is never slower. */
export function bulkNeedsConfirm(mode: AutopilotMode): boolean {
  return mode !== "off";
}

/** Run every change to completion and say which failed (by label). */
export async function settleAll(tasks: { label: string; run: () => Promise<unknown> }[]): Promise<{ ok: string[]; failed: string[] }> {
  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  const ok: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? ok : failed).push(tasks[i]!.label));
  return { ok, failed };
}

/** The toast after a bulk change: success only when nothing failed. */
export function bulkOutcome(mode: AutopilotMode, total: number, failed: string[]): { ok: boolean; message: string } {
  if (failed.length === 0) {
    return {
      ok: true,
      message: mode === "off"
        ? "All autopilots turned off · engine set to batch approval (its safest mode — pause a campaign to stop its sends)"
        : `All autopilots set to ${MODE_NAME[mode]} · engine set to batch approval`,
    };
  }
  return {
    ok: false,
    message: `${failed.length} of ${total} changes didn't go through: ${failed.join(", ")}. The others did.`,
  };
}
