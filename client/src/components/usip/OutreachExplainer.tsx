/**
 * OutreachExplainer — "Sequences, Campaigns… which is which?" (owner ask
 * 2026-09-04: "add something on these pages that explains the differences
 * and the purposes of Sequences, Campaigns, etc.").
 *
 * The same word means three things across the product: the Sequences page
 * (a fixed cadence on the original engine), a Revenue Engine campaign (the
 * autonomous engine, with per-person or fixed copy), and the Sequences TAB
 * inside a campaign (each person's generated plan). ONE component, mounted
 * on all three surfaces with the current one highlighted, so the
 * explanation cannot drift between pages. Collapsed by default; the full
 * article is one click away.
 */
import { Link } from "wouter";
import { Activity, Bot, HelpCircle, ListOrdered } from "lucide-react";

export type OutreachSurface = "sequences" | "campaigns" | "campaign-sequences-tab";

const ROWS: Array<{ key: OutreachSurface; icon: typeof Bot; title: string; what: string; engine: string; use: string; href: string | null }> = [
  {
    key: "sequences",
    icon: Activity,
    title: "Sequences (Engage → Sequences)",
    what: "A fixed multi-step cadence you write once: the same emails, in the same order, to everyone you enroll.",
    engine: "The original sequence engine. One template per step; merge tags fill in names.",
    use: "Steady follow-ups where one message fits everyone. Any sequence can become a fixed-copy campaign in one click, which puts it on the Revenue Engine's dispatcher, suppression list and approval queue.",
    href: "/v2/sequences",
  },
  {
    key: "campaigns",
    icon: Bot,
    title: "Campaigns (Revenue Engine)",
    what: "An autonomous campaign: it can source people, enrich them, write each email, send on a cadence, and react to replies.",
    engine: "The Revenue Engine. Copy mode is per person (the engine writes every email) or fixed (one template per step), so a campaign can do everything a sequence does.",
    use: "Cold outreach at scale, or anything you want the engine to run under Off / Approve / Auto control. Campaign Routing puts people into the campaign that fits them and proposes new campaigns for the ones nothing fits.",
    href: "/are/campaigns",
  },
  {
    key: "campaign-sequences-tab",
    icon: ListOrdered,
    title: "A campaign's Sequences tab",
    what: "The step-by-step plan generated for each person inside one campaign: their own emails, on their own timeline.",
    engine: "Written by the campaign's Sequence Agent after enrichment; sent by the campaign dispatcher.",
    use: "Review or edit what a specific person will receive, approve batches, and pause or resume individuals.",
    href: null,
  },
];

export function OutreachExplainer({ current, className }: { current: OutreachSurface; className?: string }) {
  return (
    <details className={`rounded-lg border bg-card ${className ?? ""}`} data-tour-id="outreach-explainer">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium flex items-center gap-2 hover:bg-muted/40 select-none">
        <HelpCircle className="size-3.5 text-muted-foreground" />
        Sequences, campaigns, and a campaign's sequences — which is which?
        <span className="ml-auto text-muted-foreground font-normal">click to expand</span>
      </summary>
      <div className="border-t px-3 py-3">
        <div className="grid gap-3 md:grid-cols-3">
          {ROWS.map((r) => {
            const Icon = r.icon;
            const here = r.key === current;
            return (
              <div key={r.key} className={`rounded-md border p-3 text-xs space-y-1.5 ${here ? "border-primary/50 bg-primary/5" : "border-border"}`}>
                <div className="flex items-center gap-1.5 font-semibold text-[12.5px]">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0">{r.title}</span>
                  {here && <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">you are here</span>}
                </div>
                <p><span className="text-muted-foreground">What it is: </span>{r.what}</p>
                <p><span className="text-muted-foreground">Runs on: </span>{r.engine}</p>
                <p><span className="text-muted-foreground">Use it for: </span>{r.use}</p>
                {r.href && !here && (
                  <Link href={r.href} className="inline-block text-[11.5px] underline text-primary">Open</Link>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11.5px] text-muted-foreground">
          Rule of thumb: one message for everyone → a Sequence (or a fixed-copy campaign). A different message for each person, or anything you want the engine to source and run → a Campaign.{" "}
          <Link href="/help/sequences-vs-campaigns" className="underline">Learn more</Link>
        </p>
      </div>
    </details>
  );
}
