/**
 * CommandPalette — ⌘K / Ctrl+K jump-anywhere.
 *
 * The registry (lib/toolRegistry) is the only data source, so the palette
 * always knows every page — including the ~40 that no longer occupy a rail
 * slot. This is the pressure valve that makes the slim rail safe: anything
 * demoted from the sidebar is still one keystroke away.
 *
 * Opens on the hotkey from anywhere, and on the "velocity:open-palette"
 * window event so the rail's Search row (or any other button) can open it
 * without threading state through the Shell.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TOOLS, TOOL_GROUPS } from "@/lib/toolRegistry";

export const OPEN_PALETTE_EVENT = "velocity:open-palette";
export const openCommandPalette = () =>
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));

export function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  const visible = TOOLS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to a page… (try “sender pools” or “approve”)" />
      <CommandList>
        <CommandEmpty>Nothing matches — it may live in Settings.</CommandEmpty>
        {TOOL_GROUPS.map((group) => {
          const items = visible.filter((t) => t.group === group);
          if (items.length === 0) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {items.map((t) => (
                <CommandItem
                  key={t.href}
                  // cmdk matches against `value`; folding keywords + group in
                  // makes "smtp" find Sending Accounts and "queue" find the
                  // AI Pipeline without the labels having to say so.
                  value={`${t.label} ${t.group} ${(t.keywords ?? []).join(" ")}`}
                  onSelect={() => go(t.href)}
                  className="gap-2.5"
                >
                  <t.icon className="size-4 text-muted-foreground" />
                  <span>{t.label}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-[45%]">
                    {t.description}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
