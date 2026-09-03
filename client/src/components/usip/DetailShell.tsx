/**
 * DetailShell — the v2 detail-page vocabulary, shared (phase 5, 2026-09-02).
 *
 * Every v2 list page (People, Companies, Deals, Leads…) uses the compact,
 * accent-topped shell — and every detail page they opened (Prospect,
 * Lead, Opportunity, Account) still used the old banner header and
 * card-grid layout, so the design language flipped on nearly every click
 * (seams audit, cause 5). This file is the ONE definition of a v2 detail
 * page's header and sections; CompanyProfile is its reference design.
 *
 *   <DetailHeader back={{ href: "/leads", label: "Leads" }} icon={…}
 *     title="Ada Lovelace" badges={…} meta={…} actions={…} />
 *   <DetailSection title="Profile">…</DetailSection>
 */
import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useAccentColor } from "@/components/usip/Shell";
import { cn } from "@/lib/utils";

export function DetailHeader({
  back, icon, avatar, title, badges, meta, actions, tourId,
}: {
  back: { href: string; label: string };
  /** A lucide icon element — rendered in an accent tile when no avatar. */
  icon?: ReactNode;
  /** A ready avatar element (person / company) — wins over `icon`. */
  avatar?: ReactNode;
  title: string;
  badges?: ReactNode;
  /** One line of facts under the title: links, title, company, location. */
  meta?: ReactNode;
  actions?: ReactNode;
  tourId?: string;
}) {
  const accent = useAccentColor();
  const [, setLocation] = useLocation();
  return (
    <div className="relative shrink-0 border-b border-border bg-card/40 px-5 py-4" data-tour-id={tourId}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
      <button type="button" onClick={() => setLocation(back.href)} className="text-[12px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-3">
        <ArrowLeft className="size-3.5" /> {back.label}
      </button>
      <div className="flex items-start gap-4">
        {avatar ?? (icon ? (
          <span className="shrink-0 size-12 rounded-xl flex items-center justify-center [&_svg]:size-6" style={{ backgroundColor: `${accent}1f`, color: accent }}>{icon}</span>
        ) : null)}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight truncate">{title}</h1>
            {badges}
          </div>
          {meta && <div className="mt-1 flex items-center gap-3 text-[13px] text-muted-foreground flex-wrap">{meta}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">{actions}</div>}
      </div>
    </div>
  );
}

/** A titled panel — the uppercase-label section every v2 profile uses. */
export function DetailSection({ title, tag, action, children, className }: { title: string; tag?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border p-4", className)}>
      <div className="flex items-center gap-2 mb-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
        {tag && <span className="text-[11px] text-muted-foreground">{tag}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label / value pair for a details grid. */
export function DetailFact({ icon: Icon, label, value }: { icon?: any; label: string; value: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground flex items-center gap-1">{Icon ? <Icon className="size-3" /> : null}{label}</div>
      <div className="text-[13px] truncate">{value}</div>
    </div>
  );
}

/** The scrolling body under a DetailHeader. */
export function DetailBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex-1 min-h-0 overflow-y-auto p-5 space-y-5", className)}>{children}</div>;
}
