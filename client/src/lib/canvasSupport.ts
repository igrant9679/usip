/**
 * What on a sequence canvas the send engine does not run (audit 2026-10-20,
 * O21), so the canvas can say so instead of looking like it works.
 *
 * The engine reads `sequences.steps`, which saveCanvas derives by walking from
 * the start node (`canvasToSteps` in server/routers/sequences.ts). That walk
 * skips condition and goal nodes, follows only a condition's TRUE edge, and
 * turns every action node into a plain task whatever action it names. Building
 * branching, goals and actions is engine work; until then these say plainly
 * that they do not run.
 */

/** Node types offered on the canvas that the engine cannot run yet. */
export const NOT_RUN_NODE_TYPES = ["condition", "goal"] as const;

/** An action node does exactly one thing: it creates a task for the rep. */
export const ACTION_RUNS_AS = "create_task";

type NodeLike = { id: string; type?: string | null; data?: Record<string, unknown> | null };
type EdgeLike = { source: string; target: string; sourceHandle?: string | null };

/** One plain sentence per kind of thing on this canvas that will not run as drawn. */
export function canvasNotRunNotes(nodes: readonly NodeLike[], edges: readonly EdgeLike[]): string[] {
  const notes: string[] = [];
  const conditions = nodes.filter((n) => n.type === "condition");
  const goals = nodes.filter((n) => n.type === "goal");
  const actions = nodes.filter((n) => {
    if (n.type !== "action") return false;
    const kind = n.data?.actionType;
    return typeof kind === "string" && kind !== "" && kind !== ACTION_RUNS_AS;
  });
  const falseBranches = edges.filter((e) => e.sourceHandle === "false" && conditions.some((c) => c.id === e.source));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (conditions.length) {
    notes.push(
      `${plural(conditions.length, "condition", "conditions")} on this canvas ${conditions.length === 1 ? "doesn't" : "don't"} branch yet: everyone follows the TRUE path` +
        (falseBranches.length ? `, and the steps on ${falseBranches.length === 1 ? "the FALSE path never run" : "FALSE paths never run"}.` : "."),
    );
  }
  if (goals.length) {
    notes.push(`${plural(goals.length, "goal", "goals")} ${goals.length === 1 ? "isn't" : "aren't"} available yet: nothing watches for ${goals.length === 1 ? "it" : "them"}, so nobody leaves the sequence when one is met.`);
  }
  if (actions.length) {
    notes.push(`${plural(actions.length, "action", "actions")} ${actions.length === 1 ? "is" : "are"} set to change a status, tag, owner or enrolment, which isn't available yet: each one only creates a task for the rep.`);
  }
  return notes;
}

/**
 * What a sequence's stored canvas holds that its steps do not (audit
 * 2026-10-20, U14). The canvas is retired: the v2 editor shows the steps the
 * engine runs, and saving them redraws the canvas as a straight line. Anything
 * drawn beyond that line never ran, and is said here before it is redrawn
 * away: the not-run notes above, and how many nodes the walk from the start
 * never reaches (the same walk `canvasToSteps` makes: the start node, or the
 * first node, then each node's TRUE edge, else its first edge).
 */
export function canvasLeftovers(nodes: readonly NodeLike[], edges: readonly EdgeLike[]): { notes: string[]; unreached: number } {
  if (nodes.length === 0) return { notes: [], unreached: 0 };
  const out = new Map<string, EdgeLike[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e]);
  const start = nodes.find((n) => n.type === "start") ?? nodes[0];
  const seen = new Set<string>();
  let cur: string | null = start.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const outs: EdgeLike[] = out.get(cur) ?? [];
    const next: EdgeLike | undefined = outs.find((e) => e.sourceHandle === "true") ?? outs[0];
    cur = next ? next.target : null;
  }
  const unreached = nodes.filter((n) => !seen.has(n.id) && n.type !== "start").length;
  return { notes: canvasNotRunNotes(nodes, edges), unreached };
}
