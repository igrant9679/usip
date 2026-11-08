/**
 * The stored AI fit assessment, in full, under a lead's score breakdown
 * (audit 2026-10-20, U32): the pains the model saw, the products it would
 * lead with and the objections to expect. It was saved with every Recompute
 * and only its first two pains and risks ever reached the screen, as reasons.
 */
import { fmtDate } from "./Common";

export type AiFitDetailsData = {
  fitPct: number;
  estimated: boolean;
  painPoints: string[];
  recommendedProducts: string[];
  objectionRisks: string[];
  assessedAt: Date | string | null;
} | null | undefined;

const SECTIONS: Array<{ key: "painPoints" | "recommendedProducts" | "objectionRisks"; label: string }> = [
  { key: "painPoints", label: "Pains" },
  { key: "recommendedProducts", label: "Recommended products" },
  { key: "objectionRisks", label: "Objection risks" },
];

export function AiFitDetails({ details }: { details: AiFitDetailsData }) {
  if (!details) {
    return <p className="text-[11px] text-muted-foreground">No AI fit assessment yet. Recompute asks the AI for one.</p>;
  }
  if (details.estimated) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Fit {details.fitPct}% is an estimate from the title: the AI assessment failed{details.assessedAt ? ` (${fmtDate(details.assessedAt)})` : ""}, so there are no pains, products or risks to show.
      </p>
    );
  }
  const any = SECTIONS.some((s) => details[s.key].length > 0);
  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="text-muted-foreground">AI fit {details.fitPct}%{details.assessedAt ? `, assessed ${fmtDate(details.assessedAt)}` : ""}</div>
      {!any && <div className="text-muted-foreground">The assessment named no pains, products or risks.</div>}
      {SECTIONS.filter((s) => details[s.key].length > 0).map((s) => (
        <div key={s.key}>
          <div className="font-medium">{s.label}</div>
          <ul className="text-muted-foreground space-y-0.5">{details[s.key].map((x, i) => <li key={i}>• {x}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}
