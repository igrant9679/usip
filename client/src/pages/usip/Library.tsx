/**
 * Library — every tool in the product, grouped and searchable.
 *
 * This page is the other half of the slim-rail bargain: the sidebar shows
 * only the daily loop, and EVERYTHING lives here with a one-line answer to
 * "when do I come here?". Renders from lib/toolRegistry — the same single
 * source the rail and the ⌘K palette use, so the three can never disagree
 * about what exists.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Search, Command } from "lucide-react";
import { TOOL_GROUPS, searchTools } from "@/lib/toolRegistry";

export default function Library() {
  const [query, setQuery] = useState("");
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

  const results = useMemo(() => searchTools(query, { isAdmin }), [query, isAdmin]);

  return (
    <Shell title="Library">
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Library"
          description="Everything the product can do, in one place. The sidebar shows only your daily loop — the rest lives here."
        />

        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools… (or press Ctrl+K anywhere)"
            className="pl-9"
          />
        </div>

        {results.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing matches “{query}”. Configuration lives in{" "}
            <Link href="/v2/settings/profile" className="underline">Settings</Link>.
          </p>
        )}

        {TOOL_GROUPS.map((group) => {
          const items = results.filter((t) => t.group === group);
          if (items.length === 0) return null;
          return (
            <section key={group}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {group}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {items.map((t) => (
                  <Link
                    key={t.href}
                    href={t.href}
                    className="flex items-start gap-3 rounded-lg border bg-card p-3 hover:border-primary/40 hover:bg-muted/40 transition-colors"
                  >
                    <t.icon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{t.label}</span>
                      <span className="block text-xs text-muted-foreground leading-snug">{t.description}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground pt-2">
          <Command className="size-3.5" /> Tip: press <kbd className="px-1 py-0.5 rounded border bg-muted text-[10px]">Ctrl</kbd>+<kbd className="px-1 py-0.5 rounded border bg-muted text-[10px]">K</kbd> anywhere to jump to any of these.
        </p>
      </div>
    </Shell>
  );
}
