/**
 * Placeholder — temporary page for the redesigned sidebar's new sections.
 *
 * Every new nav item points at a /v2/* route that renders this, so the new IA
 * is fully navigable while we build each page out one at a time. Swap a route's
 * element from <Placeholder title="..."/> to the real page when it's ready.
 */
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Construction } from "lucide-react";

export default function Placeholder({ title, description }: { title: string; description?: string }) {
  return (
    <Shell title={title}>
      <PageHeader
        title={title}
        description={description ?? "Part of the redesigned workspace — this page is being built out next."}
      />
      <div className="p-4 md:p-6">
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Construction className="size-8 mx-auto mb-3 text-muted-foreground opacity-60" />
          <div className="text-sm font-medium">{title} — coming soon</div>
          <p className="text-xs text-muted-foreground mt-1">
            The layout and navigation are in place. We'll build this page out next.
          </p>
        </div>
      </div>
    </Shell>
  );
}
