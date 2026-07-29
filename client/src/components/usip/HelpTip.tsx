/**
 * HelpTip — the shared hover-help control.
 *
 * There was already an `InfoTip` for this, private to GuidedMailboxSetup and
 * used on three fields. This is that idea, extracted, given keyboard and touch
 * behaviour, and pointed at the central copy registry in lib/helpText.ts.
 *
 * Design decisions worth keeping:
 *
 *  - **A visible ⓘ, not a bare hover target.** Help nobody can see is help
 *    nobody finds. The icon is muted until hovered so it stays out of the way.
 *  - **A real <button>.** Keyboard users get it on Tab, screen readers announce
 *    it, and — the part a div would break — tapping works on touch, where
 *    "hover" does not exist at all.
 *  - **Timing is set ONCE, at the app root.** These used to declare a nested
 *    TooltipProvider each, which silently defeated Radix's shared hover state:
 *    every item re-waited the full delay, so scanning down the sidebar — the
 *    main way someone learns this app — stuttered at every row. The single
 *    provider in App.tsx delays the first tooltip and shows the rest instantly.
 *  - **`type="button"`.** Inside a form — which is where most of these live —
 *    the default `submit` would save the form on click.
 */
import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FIELD_HELP, type HelpEntry } from "@/lib/helpText";

export function HelpTip({
  id,
  text,
  article,
  side = "top",
  className,
  children,
}: {
  /** Key into FIELD_HELP. Ignored when `text` is given. */
  id?: string;
  /** Literal copy, for one-offs that don't earn a registry entry. */
  text?: string;
  /** Help-article slug for a "Learn more" link. */
  article?: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  /** Custom trigger. Defaults to the ⓘ icon. */
  children?: ReactNode;
}) {
  const entry: HelpEntry | undefined = text ? { body: text, article } : id ? FIELD_HELP[id] : undefined;
  // A missing registry key must not render a tooltip with nothing in it — an
  // empty bubble reads as a bug and teaches people to ignore the icon.
  if (!entry?.body) return null;
  const slug = article ?? entry.article;

  return (
    <Tooltip>
        <TooltipTrigger asChild>
          {children ?? (
            <button
              type="button"
              aria-label="What's this?"
              className={cn(
                "inline-flex items-center justify-center align-middle text-muted-foreground/60",
                "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring rounded-full transition-colors",
                className,
              )}
              // Never let the ⓘ submit, navigate, or toggle the control it sits beside.
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <HelpCircle className="size-3.5" />
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-[280px] text-[12px] leading-relaxed">
          <p>{entry.body}</p>
          {slug && (
            <Link
              href={`/help/${slug}`}
              className="mt-1.5 inline-block underline underline-offset-2 opacity-80 hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              Learn more
            </Link>
          )}
        </TooltipContent>
    </Tooltip>
  );
}

/**
 * Wrap any element so hovering IT (not a separate icon) shows the tip.
 *
 * For things that are already their own target — a nav link, a mode button —
 * where adding a second clickable ⓘ inside would be both ugly and a nested
 * interactive element.
 */
export function HelpHover({
  body,
  side = "right",
  children,
}: {
  body?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  if (!body) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[260px] text-[12px] leading-relaxed">
        {body}
      </TooltipContent>
    </Tooltip>
  );
}
