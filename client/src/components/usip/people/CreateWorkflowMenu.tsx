/**
 * CreateWorkflowMenu + WorkflowSelectionMenu — the two workflow entry points.
 *
 * Velocity has no workflows backend yet (no router), so both surfaces are
 * faithful UI placeholders that hand off to the /v2/workflows page:
 *
 *  - CreateWorkflowMenu: the lightning-icon toolbar button + dropdown
 *    (Auto-add to sequence · Auto-add to lists · Auto-update records ·
 *    Create from scratch). Each option opens a modal titled for that option
 *    with a description, Cancel, and a primary "Create workflow".
 *  - WorkflowSelectionMenu: the compact popover shown in the selected-rows
 *    toolbar — search active workflows, All/My/Team tabs, an empty-state
 *    illustration, "Get started with workflows" copy, and Learn more /
 *    Create workflow buttons.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Zap, ChevronDown, Search, User, Users } from "lucide-react";

const OPTIONS = [
  { id: "sequence", label: "Auto-add to sequence", blurb: "Automatically enroll matching people into a sequence as they enter this view." },
  { id: "lists", label: "Auto-add to lists", blurb: "Keep a list in sync — people who match these filters are added automatically." },
  { id: "records", label: "Auto-update records", blurb: "Apply field updates or stage changes to people who match this view." },
  { id: "scratch", label: "Create from scratch", blurb: "Start with a blank workflow and build your own automation step by step." },
];

/** Small inline illustration for the workflow empty state (no brand assets). */
function WorkflowGlyph() {
  return (
    <svg width="92" height="64" viewBox="0 0 92 64" fill="none" className="mx-auto" aria-hidden>
      <circle cx="24" cy="20" r="14" className="fill-violet-100 dark:fill-violet-950/50" />
      <path d="M24 13l1.8 4.2L30 19l-4.2 1.8L24 25l-1.8-4.2L18 19l4.2-1.8L24 13z" className="fill-violet-500" />
      <path d="M24 34v10a6 6 0 006 6h12" className="stroke-muted-foreground/40" strokeWidth="2" fill="none" />
      <circle cx="66" cy="50" r="11" className="fill-foreground" />
      <path d="M61 50l3.5 3.5L72 46" stroke="white" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CreateWorkflowMenu() {
  const [, setLocation] = useLocation();
  const [modal, setModal] = useState<(typeof OPTIONS)[number] | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Zap className="size-4" /> Create workflow <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {OPTIONS.slice(0, 3).map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => setModal(o)}>{o.label}</DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setModal(OPTIONS[3])}>{OPTIONS[3].label}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Zap className="size-4 text-amber-500" /> {modal?.label}</DialogTitle>
            <DialogDescription>{modal?.blurb}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModal(null)}>Cancel</Button>
            <Button onClick={() => { setLocation("/v2/workflows"); setModal(null); }}>Create workflow</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const WF_TABS = [
  { id: "all", label: "All", icon: Zap },
  { id: "my", label: "My", icon: User },
  { id: "team", label: "Team", icon: Users },
] as const;

/** Compact workflow picker used by the selection toolbar (empty for now). */
export function WorkflowSelectionMenu({ trigger }: { trigger: React.ReactNode }) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<(typeof WF_TABS)[number]["id"]>("all");
  const [q, setQ] = useState("");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="p-2.5 border-b">
          <div className="flex items-center gap-2 px-2 h-8 rounded-md border bg-background">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search active workflows"
              className="flex-1 bg-transparent outline-none text-[13px] min-w-0"
            />
          </div>
        </div>
        <div className="flex items-center gap-4 px-3 pt-2 border-b text-[13px]">
          {WF_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "pb-2 -mb-px border-b-2 inline-flex items-center gap-1.5 transition-colors",
                tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="size-3.5" /> {t.label}
            </button>
          ))}
        </div>
        <div className="px-5 py-6 text-center">
          <WorkflowGlyph />
          <h4 className="mt-3 text-sm font-semibold">Get started with workflows</h4>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Create a workflow to automatically find, enrich, and engage prospects.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setLocation("/v2/workflows")}>Learn more</Button>
            <Button size="sm" onClick={() => { setOpen(false); setLocation("/v2/workflows"); }}>Create workflow</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
