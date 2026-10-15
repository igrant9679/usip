/**
 * How the money flows in a sector, drawn the way Downstream draws it: where it
 * comes from, who passes it on, and who receives it, joined by curves. Labels
 * wrap to two lines and keep their full text in a tooltip. Nothing to draw,
 * nothing rendered.
 */
import type { SectorContent } from "@shared/researchShape";

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
  const columns: { title: string; nodes: Node[]; tone: string }[] = [
    { title: "Where the money comes from", nodes: flow.sources.filter((s) => s.trim()).slice(0, 8).map((s) => ({ label: s, sub: "" })), tone: "fill-teal-600/15 stroke-teal-600/50" },
    { title: "Who passes it on", nodes: flow.intermediaries.filter((i) => i.name.trim()).slice(0, 8).map((i) => ({ label: i.name, sub: [i.count, i.role].filter(Boolean).join(" · ") })), tone: "fill-violet-500/15 stroke-violet-500/50" },
    { title: "Who receives it", nodes: flow.recipients.filter((r) => r.type.trim()).slice(0, 8).map((r) => ({ label: r.type, sub: [r.approxCount, r.notes].filter(Boolean).join(" · ") })), tone: "fill-amber-500/15 stroke-amber-600/50" },
  ].filter((c) => c.nodes.length > 0);
  if (columns.length === 0) return null;

  const rows = Math.max(...columns.map((c) => c.nodes.length));
  const height = TOP + rows * (NODE_H + GAP) + 6;
  const step = columns.length > 1 ? (WIDTH - COL_W) / (columns.length - 1) : 0;
  const x = (ci: number) => ci * step;
  // Each column is centred vertically against the tallest.
  const y = (ci: number, ni: number) => TOP + ((rows - columns[ci].nodes.length) * (NODE_H + GAP)) / 2 + ni * (NODE_H + GAP);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full min-w-[640px] h-auto" role="img" aria-label="How the money flows">
        {columns.slice(0, -1).map((col, ci) =>
          col.nodes.map((_, a) =>
            columns[ci + 1].nodes.map((__, b) => {
              const x1 = x(ci) + COL_W, y1 = y(ci, a) + NODE_H / 2;
              const x2 = x(ci + 1), y2 = y(ci + 1, b) + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              return <path key={`${ci}-${a}-${b}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} className="fill-none stroke-muted-foreground/25" strokeWidth={1.2} />;
            }),
          ),
        )}
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
    </div>
  );
}
