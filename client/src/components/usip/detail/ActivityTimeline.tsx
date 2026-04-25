/**
 * ActivityTimeline — Apollo-style chronological activity feed.
 * Groups activities by month, shows icon + subject + notes + timestamp.
 * Supports provider channel icon badges for Unipile multichannel activities
 * (LinkedIn, WhatsApp, Instagram, Telegram, X/Twitter, Email, etc.).
 */
import { Calendar, MessageSquare, Phone, FileText, Mail, Link2, UserPlus } from "lucide-react";

export interface TimelineActivity {
  id: number;
  kind: "call" | "meeting" | "note" | "linkedin_dm" | "linkedin_invite" | "email" | string;
  /** Unipile provider: linkedin | whatsapp | instagram | messenger | telegram | twitter | imap | outlook */
  provider?: string | null;
  subject?: string | null;
  notes?: string | null;
  disposition?: string | null;
  createdAt: Date | string | number;
}

interface ActivityTimelineProps {
  activities: TimelineActivity[];
  isLoading?: boolean;
  emptyMessage?: string;
  className?: string;
}

function fmtDate(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtMonth(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/* ─── Provider channel badge ─────────────────────────────────────────────── */
/**
 * Renders a small colored circular badge representing the messaging channel.
 * Uses SVG paths for brand logos (LinkedIn, WhatsApp, etc.) to avoid
 * external image dependencies.
 */
function ProviderBadge({ provider }: { provider: string }) {
  const p = provider.toLowerCase();

  if (p === "linkedin") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background"
        style={{ background: "#0A66C2" }}
        title="LinkedIn"
      >
        <svg viewBox="0 0 24 24" className="size-2 fill-white">
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
        </svg>
      </span>
    );
  }

  if (p === "whatsapp") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background"
        style={{ background: "#25D366" }}
        title="WhatsApp"
      >
        <svg viewBox="0 0 24 24" className="size-2 fill-white">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
        </svg>
      </span>
    );
  }

  if (p === "instagram") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background"
        style={{ background: "radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285AEB 90%)" }}
        title="Instagram"
      >
        <svg viewBox="0 0 24 24" className="size-2 fill-white">
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
        </svg>
      </span>
    );
  }

  if (p === "messenger") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background"
        style={{ background: "#0084FF" }}
        title="Messenger"
      >
        <svg viewBox="0 0 24 24" className="size-2 fill-white">
          <path d="M12 0C5.373 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.654V24l4.088-2.242c1.092.3 2.246.464 3.443.464 6.627 0 12-4.975 12-11.111S18.627 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26L10.732 8l3.131 3.259L19.752 8l-6.561 6.963z" />
        </svg>
      </span>
    );
  }

  if (p === "telegram") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background"
        style={{ background: "#2AABEE" }}
        title="Telegram"
      >
        <svg viewBox="0 0 24 24" className="size-2 fill-white">
          <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
        </svg>
      </span>
    );
  }

  if (p === "twitter" || p === "x") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background bg-black"
        title="X / Twitter"
      >
        <svg viewBox="0 0 24 24" className="size-2 fill-white">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </span>
    );
  }

  if (p === "imap" || p === "outlook" || p === "email") {
    return (
      <span
        className="absolute -bottom-1 -right-1 size-3.5 rounded-full flex items-center justify-center ring-1 ring-background bg-slate-500"
        title="Email"
      >
        <Mail className="size-2 text-white" />
      </span>
    );
  }

  return null;
}

/* ─── Activity kind icon ─────────────────────────────────────────────────── */
function KindIcon({ kind, provider }: { kind: string; provider?: string | null }) {
  // LinkedIn step types
  if (kind === "linkedin_dm") {
    return (
      <div className="relative shrink-0">
        <div className="size-7 rounded-full flex items-center justify-center" style={{ background: "#0A66C2" }}>
          <Link2 className="size-3.5 text-white" />
        </div>
      </div>
    );
  }
  if (kind === "linkedin_invite") {
    return (
      <div className="relative shrink-0">
        <div className="size-7 rounded-full flex items-center justify-center" style={{ background: "#0A66C2" }}>
          <UserPlus className="size-3.5 text-white" />
        </div>
      </div>
    );
  }

  // Standard CRM activity types with optional provider badge
  const baseIcon = (() => {
    if (kind === "call") return <Phone className="size-3.5 text-[#14B89A]" />;
    if (kind === "meeting") return <Calendar className="size-3.5 text-blue-500" />;
    if (kind === "note") return <MessageSquare className="size-3.5 text-amber-500" />;
    if (kind === "email") return <Mail className="size-3.5 text-slate-500" />;
    return <FileText className="size-3.5 text-muted-foreground" />;
  })();

  if (provider) {
    return (
      <div className="relative shrink-0 mt-0.5">
        {baseIcon}
        <ProviderBadge provider={provider} />
      </div>
    );
  }

  return <div className="mt-0.5 shrink-0">{baseIcon}</div>;
}

/* ─── Kind label ─────────────────────────────────────────────────────────── */
function kindLabel(kind: string, provider?: string | null): string {
  if (kind === "linkedin_dm") return "LinkedIn DM";
  if (kind === "linkedin_invite") return "LinkedIn Invite";
  if (provider) return `${provider.charAt(0).toUpperCase() + provider.slice(1)} ${kind}`;
  return kind.replace(/_/g, " ");
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export function ActivityTimeline({
  activities,
  isLoading,
  emptyMessage = "No activity logged yet.",
  className = "",
}: ActivityTimelineProps) {
  if (isLoading) {
    return (
      <div className={`space-y-2 ${className}`}>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <p className={`text-[12px] text-muted-foreground py-4 text-center ${className}`}>
        {emptyMessage}
      </p>
    );
  }

  // Group by month
  const groups = new Map<string, TimelineActivity[]>();
  for (const a of activities) {
    const key = fmtMonth(a.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  return (
    <div className={`space-y-4 ${className}`}>
      {Array.from(groups.entries()).map(([month, items]) => (
        <div key={month}>
          {/* Month header */}
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-1">
            {month}
          </div>
          <div className="space-y-2">
            {items.map((a) => (
              <div
                key={a.id}
                className="border rounded-lg bg-card px-3 py-2.5 flex gap-3"
              >
                {/* Icon column */}
                <KindIcon kind={a.kind} provider={a.provider} />
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-widest font-medium text-muted-foreground">
                      {kindLabel(a.kind, a.provider)}
                    </span>
                    {a.disposition && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                        {a.disposition.replace(/_/g, " ")}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
                      {fmtDate(a.createdAt)}
                    </span>
                  </div>
                  {a.subject && (
                    <div className="text-[13px] font-medium text-foreground mt-0.5 leading-snug">
                      {a.subject}
                    </div>
                  )}
                  {a.notes && (
                    <div className="text-[12px] text-foreground/80 mt-1 whitespace-pre-wrap line-clamp-3">
                      {a.notes}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
