/**
 * How the money flows in a sector, drawn the way Downstream draws it: where it
 * comes from, who passes it on, and who receives it. Labels wrap to two lines
 * and keep their full text in a tooltip. Nothing to draw, nothing rendered.
 *
 * Curves join only the links the research states (facts.moneyFlow.links,
 * resolved by statedMoneyLinks). It joined every node of a column to every
 * node of the next, so a picture of five sources and four intermediaries
 * claimed twenty links nobody had found (audit 2026-10-20, U30). With none
 * stated, it says so instead of drawing any.
 */
import type { SectorContent } from "@shared/researchShape";
import { statedMoneyLinks, type MoneyColumn } from "@shared/researchReports";

type Node = { label: string; sub: string };
type Flow = SectorContent["facts"]["moneyFlow"];

const NODE_H = 46;
const GAP = 12;
const COL_W = 250;
const WIDTH = 900;
const TOP = 34;

/** Up to two lines of about `max` characters, breaking between words. */
function wrap(text: string, max = 34): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if (`${cur} ${w}`.length <= max) lines[lines.length - 1] = `${cur} ${w}`;
    else if (lines.length < 2) lines.push(w);
    else { lines[1] = `${lines[1].slice(0, max - 1).trimEnd()}…`; break; }
  }
  if (lines[0].length > max) lines[0] = `${lines[0].slice(0, max - 1)}…`;
  return lines.filter(Boolean);
}

export function MoneyFlow({ flow }: { flow: Flow }) {
  const columns: { kind: MoneyColumn; title: string; nodes: Node[]; tone: string }[] = [
    { kind: 0 as const, title: "Where the money comes from", nodes: flow.sources.filter((s) => s.trim()).slice(0, 8).map((s) => ({ label: s, sub: "" })), tone: "fill-teal-600/15 stroke-teal-600/50" },
    { kind: 1 as const, title: "Who passes it on", nodes: flow.intermediaries.filter((i) => i.name.trim()).slice(0, 8).map((i) => ({ label: i.name, sub: [i.count, i.role].filter(Boolean).join(" · ") })), tone: "fill-violet-500/15 stroke-violet-500/50" },
    { kind: 2 as const, title: "Who receives it", nodes: flow.recipients.filter((r) => r.type.trim()).slice(0, 8).map((r) => ({ label: r.type, sub: [r.approxCount, r.notes].filter(Boolean).join(" · ") })), tone: "fill-amber-500/15 stroke-amber-600/50" },
  ].filter((c) => c.nodes.length > 0);
  if (columns.length === 0) return null;
  // Where each drawn node sits, by column kind and label.
  const at = (kind: MoneyColumn, label: string) => {
    const ci = columns.findIndex((c) => c.kind === kind);
    const ni = ci === -1 ? -1 : columns[ci].nodes.findIndex((n) => n.label.trim().toLowerCase() === label.trim().toLowerCase());
    return ni === -1 ? null : { ci, ni };
  };
  const edges = statedMoneyLinks(flow).links
    .map((l) => ({ a: at(l.from.col, l.from.label), b: at(l.to.col, l.to.label) }))
    .filter((e): e is { a: { ci: number; ni: number }; b: { ci: number; ni: number } } => !!e.a && !!e.b);

  const rows = Math.max(...columns.map((c) => c.nodes.length));
  const height = TOP + rows * (NODE_H + GAP) + 6;
  const step = columns.length > 1 ? (WIDTH - COL_W) / (columns.length - 1) : 0;
  const x = (ci: number) => ci * step;
  // Each column is centred vertically against the tallest.
  const y = (ci: number, ni: number) => TOP + ((rows - columns[ci].nodes.length) * (NODE_H + GAP)) / 2 + ni * (NODE_H + GAP);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full min-w-[640px] h-auto" role="img" aria-label={`How the money flows: ${edges.length} stated link${edges.length === 1 ? "" : "s"}`}>
        {/* Only the links the research states (U30). */}
        {edges.map(({ a, b }) => {
          const x1 = x(a.ci) + COL_W, y1 = y(a.ci, a.ni) + NODE_H / 2;
          const x2 = x(b.ci), y2 = y(b.ci, b.ni) + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return <path key={`${a.ci}-${a.ni}-${b.ci}-${b.ni}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} className="fill-none stroke-muted-foreground/40" strokeWidth={1.4} />;
        })}
        {columns.map((col, ci) => (
          <g key={col.title}>
            <text x={x(ci) + COL_W / 2} y={16} textAnchor="middle" className="fill-muted-foreground text-[12px] font-medium">{col.title}</text>
            {col.nodes.map((n, ni) => {
              const lines = wrap(n.label);
              return (
                <g key={ni}>
                  <title>{[n.label, n.sub].filter(Boolean).join(" — ")}</title>
                  <rect x={x(ci)} y={y(ci, ni)} width={COL_W} height={NODE_H} rx={8} className={col.tone} strokeWidth={1} />
                  {lines.map((l, li) => (
                    <text key={li} x={x(ci) + 10} y={y(ci, ni) + (n.sub ? 15 : lines.length === 1 ? 27 : 19) + li * 13} className="fill-foreground text-[11.5px]">{l}</text>
                  ))}
                  {n.sub && lines.length < 2 && (
                    <text x={x(ci) + 10} y={y(ci, ni) + 33} className="fill-muted-foreground text-[10.5px]">{wrap(n.sub, 40)[0]}</text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      {columns.length > 1 && edges.length === 0 && (
        <p className="text-xs text-muted-foreground mt-1">The research states no links between these, so none are drawn. Add the ones it states under Market facts, Money flow links.</p>
      )}
    </div>
  );
}
