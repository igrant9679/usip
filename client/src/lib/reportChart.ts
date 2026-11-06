/**
 * A grouped report's rows in the shape each chart reads (audit 2026-10-20,
 * G54). Every chart was handed { label, value }: Pie and Donut read `name`, so
 * every slice was "undefined", and the funnel read `stage` and `count` and
 * then threw formatting a money column a report doesn't have.
 */
export type ReportPoint = { label: string; value: number };

export function reportChartSeries(viz: string, points: ReportPoint[]): Array<Record<string, string | number>> {
  if (viz === "pie" || viz === "donut") return points.map((p) => ({ name: p.label, value: p.value }));
  if (viz === "funnel") return points.map((p) => ({ stage: p.label, count: p.value }));
  return points;
}
