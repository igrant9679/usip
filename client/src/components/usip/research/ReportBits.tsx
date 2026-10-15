/** Small pieces the research reports share. */
import type { ReactNode } from "react";

/** A 1 to 5 score as five squares; an unset score reads "not scored". */
export function ScoreDots({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-[11px] text-muted-foreground">not scored</span>;
  return (
    <span className="inline-flex gap-0.5" aria-label={`${value} of 5`} title={`${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={`size-2.5 rounded-[2px] ${i <= value ? "bg-teal-700 dark:bg-teal-400" : "bg-muted"}`} />)}
    </span>
  );
}

/** A headline figure: the number, what it counts, and an optional line under it. */
export function StatTile({ value, label, note }: { value: ReactNode; label: string; note?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3.5">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {note ? <div className="text-[11px] text-muted-foreground mt-1">{note}</div> : null}
    </div>
  );
}

/** A plain report table: a header row and the rows given. */
export function ReportTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr className="text-left text-muted-foreground">
            {head.map((h, i) => <th key={i} className="px-3 py-2 font-medium uppercase tracking-wide text-[10.5px] whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;

export const ExtLink = ({ url, children }: { url?: string; children: ReactNode }) =>
  url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{children}</a> : <>{children}</>;
