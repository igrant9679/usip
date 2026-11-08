import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/lib/utils";

/**
 * A page header's actions (audit 2026-10-20, U8): in a row from md up; on a
 * phone the first `keep` stay in the header and the rest fold into a More
 * menu, so four or five buttons no longer wrap into a block that pushes the
 * list off the first screen.
 *
 *   <PageHeader title="Leads">
 *     <HeaderActions>
 *       <Button>New lead</Button>        ← stays on a phone
 *       <Button>Import</Button>          ← folded
 *       <Button>Export</Button>          ← folded
 *     </HeaderActions>
 *   </PageHeader>
 *
 * The folded actions render as they are, stacked full width in a popover, so
 * a button that opens its own menu, dialog or confirm keeps working. The
 * children render once, in one place or the other. Fragments are flattened,
 * and empty slots (`cond && <Button/>` that is false) are not counted.
 */
export function HeaderActions({
  children,
  keep = 1,
  label = "More actions",
  className,
  bare = false,
  pinned,
  pinnedAt = "end",
}: {
  children: ReactNode;
  /** How many actions stay in the header on a phone (the primary ones, first). */
  keep?: number;
  label?: string;
  className?: string;
  /** From md up, render the actions with no wrapper, inside a toolbar that lays them out itself. */
  bare?: boolean;
  /** The page's main action ("New lead"): last in the row from md up, never folded on a phone. */
  pinned?: ReactNode;
  /** Where the pinned action sits in the row from md up: after the others (default) or before them. */
  pinnedAt?: "start" | "end";
}) {
  const phone = useIsMobile();
  const items = flatten(children);
  if (!phone || items.length <= keep + 1) {
    const row = pinnedAt === "start" ? <>{pinned}{items}</> : <>{items}{pinned}</>;
    if (bare) return row;
    return <div className={cn("flex flex-wrap items-center gap-2", className)}>{row}</div>;
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {items.slice(0, keep)}
      {pinned}
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="icon" className="size-8 shrink-0" aria-label={label} title={label}>
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          data-header-overflow=""
          className="w-64 max-w-[calc(100vw-1rem)] p-2 flex flex-col gap-1.5 [&>*]:w-full [&>button]:justify-start"
        >
          {items.slice(keep)}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Children as a flat list: fragments opened, empty slots dropped. */
export function flatten(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  for (const c of Children.toArray(children)) {
    if (isValidElement(c) && c.type === Fragment) out.push(...flatten((c as ReactElement<{ children?: ReactNode }>).props.children));
    // Children.toArray already drops null, undefined and booleans.
    else if (c !== "") out.push(c);
  }
  return out;
}
