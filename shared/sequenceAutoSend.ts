/**
 * sequenceAutoSend.ts — review or auto-send, decided per sequence (audit
 * 2026-10-20, F22).
 *
 * Auto-send was one workspace switch and one score threshold (Settings →
 * Email), hidden from the sequence it acts on. A sequence now says for
 * itself, in `sequences.settings`:
 *
 *   autoSend: "workspace"  (or unset) — the workspace switch decides, at the
 *                          workspace threshold. Today's behaviour, and the
 *                          default, so nothing changes until someone sets it.
 *   autoSend: "review"     — always waits for a person, even when the
 *                          workspace auto-sends.
 *   autoSend: "auto"       — auto-sends its drafts whose recipient scores at
 *                          least `autoSendScoreMin` (else the workspace's), even
 *                          when the workspace switch is off. People-addressed
 *                          drafts are scored by the person's priority score.
 *
 * The pause still wins every time (the workspace send window stays shut while
 * outbound is paused), as do the daily caps, the hold, suppression and the
 * claim in deliverEmailDraft.
 */

export type SequenceAutoSendMode = "workspace" | "review" | "auto";

export interface SequenceAutoSend {
  mode: SequenceAutoSendMode;
  /** 0–100; null = the workspace's threshold. Read only in "auto". */
  scoreMin: number | null;
  /** Send to unscored recipients too; null = the workspace's choice. Read only in "auto". */
  allowUnscored: boolean | null;
}

/** The sequence's choice, read from its settings; anything unreadable is "workspace". */
export function sequenceAutoSend(settings: unknown): SequenceAutoSend {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const mode: SequenceAutoSendMode = s.autoSend === "review" || s.autoSend === "auto" ? s.autoSend : "workspace";
  const n = Number(s.autoSendScoreMin);
  const scoreMin = s.autoSendScoreMin != null && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  const allowUnscored = typeof s.autoSendAllowUnscored === "boolean" ? s.autoSendAllowUnscored : null;
  return { mode, scoreMin, allowUnscored };
}

export interface AutoSendGroup {
  /** "workspace": every sequence that defers to the workspace, minus `exceptIds`; else this one sequence. */
  kind: "workspace" | "sequence";
  sequenceId: number | null;
  exceptIds: number[];
  scoreMin: number;
  allowUnscored: boolean;
  /** People-addressed drafts are scored by the person's priority score ("auto" sequences only). */
  scorePeople: boolean;
}

/**
 * Which drafts one auto-send tick may send in a workspace, as groups that
 * each carry their own gate. Empty when nothing in the workspace auto-sends.
 */
export function autoSendGroups(
  ws: { aiAutoSendEnabled: boolean | null; aiAutoSendScoreMin: number | null; aiAutoSendAllowUnscored: boolean | null },
  activeSequences: Array<{ id: number; settings: unknown }>,
): AutoSendGroup[] {
  const wsMin = ws.aiAutoSendScoreMin ?? 70;
  const wsUnscored = !!ws.aiAutoSendAllowUnscored;
  const explicit: number[] = [];
  const groups: AutoSendGroup[] = [];
  for (const seq of activeSequences) {
    const a = sequenceAutoSend(seq.settings);
    if (a.mode === "workspace") continue;
    explicit.push(seq.id);
    if (a.mode === "auto") {
      groups.push({
        kind: "sequence", sequenceId: seq.id, exceptIds: [],
        scoreMin: a.scoreMin ?? wsMin, allowUnscored: a.allowUnscored ?? wsUnscored, scorePeople: true,
      });
    }
  }
  if (ws.aiAutoSendEnabled) {
    groups.unshift({ kind: "workspace", sequenceId: null, exceptIds: explicit, scoreMin: wsMin, allowUnscored: wsUnscored, scorePeople: false });
  }
  return groups;
}

/** One line for the sequence's Settings tab. */
export function describeSequenceAutoSend(a: SequenceAutoSend, ws: { aiAutoSendEnabled?: boolean | null; aiAutoSendScoreMin?: number | null } | null | undefined): string {
  const wsMin = ws?.aiAutoSendScoreMin ?? 70;
  if (a.mode === "review") return "Every draft waits for a person to review and send it.";
  if (a.mode === "auto") return `Drafts to people scoring ${a.scoreMin ?? wsMin} or more send by themselves, inside the send window; the rest wait for review.`;
  return ws?.aiAutoSendEnabled
    ? `Follows the workspace: auto-send is on, at a score of ${wsMin} or more.`
    : "Follows the workspace: auto-send is off, so every draft waits for review.";
}
