/**
 * One stage of the workflow canvas: a small rounded blue pill naming the
 * stage ("When this happens" / "Then do this action") above its cards, with
 * thin vertical connector lines between consecutive cards. The canvas itself
 * (dotted grid) belongs to the drawer body; a stage only owns its column.
 */
import { Children, type ReactNode } from "react";

export function StageConnector() {
  return <span aria-hidden className="mx-auto block h-5 w-px bg-border" />;
}

export function WorkflowStage({ pill, children }: { pill: string; children: ReactNode }) {
  const cards = Children.toArray(children);
  return (
    <section aria-label={pill} className="flex flex-col">
      <span className="mb-2 self-start rounded-full bg-sky-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">
        {pill}
      </span>
      {cards.map((card, i) => (
        <div key={i} className="flex flex-col">
          {i > 0 && <StageConnector />}
          {card}
        </div>
      ))}
    </section>
  );
}
