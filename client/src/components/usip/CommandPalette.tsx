/**
 * CommandPalette — the one search box (Ctrl+K / ⌘K, the header's "Search…"
 * and the rail's Search row).
 *
 * Until 2026-11-23 it only jumped to pages: typing a person's name into a box
 * labelled "Search…" found nothing, and nothing in the app searched people,
 * companies and leads together (owner: "the search is confusing the way it is
 * now"; "a simple way to type in a company name, person's name or email
 * address and see their enriched info"). Now what you type is looked up in
 * the workspace's own records first (search.records), each match showing the
 * facts on file, and the pages follow underneath as before.
 *
 * The page list is still the registry (lib/toolRegistry), so the palette
 * knows every page, including the ones with no rail slot.
 *
 * Opens on the hotkey from anywhere, and on the "velocity:open-palette"
 * window event so the rail's Search row (or any other button) can open it
 * without threading state through the Shell.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Building2, Loader2, Target, User } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { trpc } from "@/lib/trpc";
import { TOOLS, TOOL_GROUPS } from "@/lib/toolRegistry";
import { RECORD_SEARCH_MIN, hitDetail, parseRecordSearch, type RecordHit } from "@shared/recordSearch";

export const OPEN_PALETTE_EVENT = "velocity:open-palette";
export const openCommandPalette = () =>
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));

/** How long typing must pause before the records are asked for. */
const SEARCH_DEBOUNCE_MS = 250;

const KIND = {
  person: { label: "Person", icon: User },
  company: { label: "Company", icon: Building2 },
  lead: { label: "Lead", icon: Target },
} as const;

function RecordRow({ hit, onGo }: { hit: RecordHit; onGo: (href: string) => void }) {
  const k = KIND[hit.kind];
  const detail = hitDetail(hit);
  return (
    <CommandItem value={`${hit.kind}-${hit.id}`} onSelect={() => onGo(hit.href)} className="gap-2.5 items-start" data-record-hit={hit.kind}>
      <k.icon className="size-4 mt-0.5 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{hit.name}</span>
        {detail ? <span className="block truncate text-[12px] text-muted-foreground">{detail}</span> : null}
      </span>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{k.label}</span>
    </CommandItem>
  );
}

export function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
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

  // Each opening starts empty: yesterday's search is not today's question.
  useEffect(() => { if (!open) { setText(""); setAsked(""); } }, [open]);

  // The records are asked for once typing pauses, not on every key.
  useEffect(() => {
    const t = window.setTimeout(() => setAsked(text), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [text]);

  const parsed = parseRecordSearch(asked);
  const records = trpc.search.records.useQuery(
    { q: parsed?.text ?? "" },
    { enabled: open && !!parsed, staleTime: 30_000, retry: false, placeholderData: (prev) => prev },
  );
  // Results belong to what is in the box now; an emptied box shows none.
  const typed = parseRecordSearch(text);
  const data = typed && parsed ? records.data : undefined;
  const waiting = !!typed && (asked !== text || records.isFetching);
  const hits: RecordHit[] = data ? [...data.people, ...data.companies, ...data.leads] : [];

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  // The pages: every word typed must appear in a page's name, group, keywords or description.
  const pages = useMemo(() => {
    const visible = TOOLS.filter((t) => !t.adminOnly || isAdmin);
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return visible;
    return visible.filter((t) => {
      const hay = `${t.label} ${t.group} ${(t.keywords ?? []).join(" ")} ${t.description ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [text, isAdmin]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Search</DialogTitle>
        <DialogDescription>Find a person, a company or a lead by name, company or email address, or jump to a page.</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0" showCloseButton>
        {/* shouldFilter off: the server decides which records match, and the
            pages are matched above. cmdk's own fuzzy filter would hide a
            record whose match is on a field the row does not print. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <CommandInput
            value={text}
            onValueChange={setText}
            placeholder="A name, a company or an email address — or a page"
            data-record-search-input
          />
          <CommandList>
            {typed ? (
              <>
                {data && data.people.length > 0 ? (
                  <CommandGroup heading="People">
                    {data.people.map((h) => <RecordRow key={`p${h.id}`} hit={h} onGo={go} />)}
                    {data.more.people ? (
                      <CommandItem value="more-people" onSelect={() => go(`/v2/people?q=${encodeURIComponent(data.query)}`)} className="text-[12px] text-muted-foreground">
                        More people match. Open them in People
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                ) : null}
                {data && data.companies.length > 0 ? (
                  <CommandGroup heading="Companies">
                    {data.companies.map((h) => <RecordRow key={`c${h.id}`} hit={h} onGo={go} />)}
                    {data.more.companies ? <div className="px-2 py-1.5 text-[12px] text-muted-foreground">More companies match. Type more of the name to narrow it.</div> : null}
                  </CommandGroup>
                ) : null}
                {data && data.leads.length > 0 ? (
                  <CommandGroup heading="Leads">
                    {data.leads.map((h) => <RecordRow key={`l${h.id}`} hit={h} onGo={go} />)}
                    {data.more.leads ? <div className="px-2 py-1.5 text-[12px] text-muted-foreground">More leads match. Type more of the name to narrow it.</div> : null}
                  </CommandGroup>
                ) : null}
                {waiting && hits.length === 0 ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-muted-foreground" data-record-search-state="searching">
                    <Loader2 className="size-3.5 animate-spin" /> Searching your records…
                  </div>
                ) : null}
                {!waiting && data && hits.length === 0 ? (
                  <div className="px-4 py-3 text-[12.5px] text-muted-foreground" data-record-search-state="none">
                    No person, company or lead in this workspace matches “{data.query}”.
                  </div>
                ) : null}
                {records.isError && !waiting ? (
                  <div className="px-4 py-3 text-[12.5px] text-rose-700 dark:text-rose-300" data-record-search-state="error">
                    The search could not be run. Try again.
                  </div>
                ) : null}
              </>
            ) : text.trim().length > 0 && text.trim().length < RECORD_SEARCH_MIN ? (
              <div className="px-4 py-3 text-[12.5px] text-muted-foreground">Type at least {RECORD_SEARCH_MIN} characters to search your records.</div>
            ) : null}

            {pages.length === 0 && !typed ? <CommandEmpty>Nothing matches — it may live in Settings.</CommandEmpty> : null}
            {TOOL_GROUPS.map((group) => {
              const items = pages.filter((t) => t.group === group);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={group} heading={typed ? `Pages · ${group}` : group}>
                  {items.map((t) => (
                    <CommandItem key={t.href} value={`page-${t.href}`} onSelect={() => go(t.href)} className="gap-2.5">
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
        </Command>
      </DialogContent>
    </Dialog>
  );
}
