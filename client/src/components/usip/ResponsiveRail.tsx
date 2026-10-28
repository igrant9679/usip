import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/lib/utils";

/**
 * A side rail or panel from md up; below md the same content in a sheet
 * (audit 2026-10-20, X5.5, U8). A fixed 240–384 px rail beside a table leaves
 * a phone a sliver of the screen, so on a phone the rail is closed until the
 * page's button opens it, and it covers the screen instead of squeezing it.
 *
 *   <PhoneRailButton onClick={() => setRailOpen(true)}>Filters</PhoneRailButton>
 *   <ResponsiveRail title="Filters" open={railOpen} onOpenChange={setRailOpen}
 *     className="w-64 shrink-0 border-r ...">…</ResponsiveRail>
 *
 * The children render once, in one place or the other, so their state and
 * queries are not doubled. `open` only matters on a phone; from md up the
 * rail shows as it always has. A panel that is shown only while something is
 * selected (a preview) passes open={true} and closes through onOpenChange.
 * On a phone the sheet gets a header with the title and the close button; a
 * panel that has its own header and close button passes ownHeader.
 */
export function ResponsiveRail({
  title,
  open,
  onOpenChange,
  side = "left",
  className,
  sheetClassName,
  ownHeader = false,
  children,
  ...rest
}: {
  /** Names the rail for a screen reader, and the sheet's title. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  /** The rail's classes from md up (its width, border, background). */
  className?: string;
  sheetClassName?: string;
  ownHeader?: boolean;
  children: ReactNode;
  "data-tour-id"?: string;
}) {
  const phone = useIsMobile();
  if (phone) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={side}
          aria-describedby={undefined}
          className={cn("w-[88vw] max-w-sm gap-0 p-0 flex flex-col min-h-0", sheetClassName)}
          {...rest}
        >
          {ownHeader ? (
            <SheetTitle className="sr-only">{title}</SheetTitle>
          ) : (
            <div className="shrink-0 flex h-12 items-center border-b border-border pl-4 pr-12">
              <SheetTitle className="truncate text-sm">{title}</SheetTitle>
            </div>
          )}
          {children}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside aria-label={title} className={cn("flex", className)} {...rest}>
      {children}
    </aside>
  );
}

/** The button that opens a ResponsiveRail on a phone; hidden from md up. */
export function PhoneRailButton({
  onClick,
  children,
  icon,
  className,
}: {
  onClick: () => void;
  children: ReactNode;
  icon?: typeof PanelLeft;
  className?: string;
}) {
  const Icon = icon ?? PanelLeft;
  return (
    <Button variant="outline" size="sm" className={cn("md:hidden h-7 gap-1.5 shrink-0", className)} onClick={onClick}>
      <Icon className="size-3.5" /> {children}
    </Button>
  );
}
