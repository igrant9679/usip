/**
 * EmailVerificationBadge
 * Renders a color-coded pill for email verification status.
 * Mirrors the VERIFICATION_BADGE map from server/routers/emailVerification.ts.
 */
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type VerificationStatus = "valid" | "accept_all" | "risky" | "invalid" | "unknown";

const BADGE: Record<
  VerificationStatus,
  { label: string; dot: string; text: string; bg: string; border: string; description: string }
> = {
  valid: {
    label: "Valid",
    dot: "bg-green-500",
    text: "text-green-700",
    bg: "bg-green-50",
    border: "border-green-200",
    description: "Email address is safe to send to.",
  },
  accept_all: {
    label: "Accept-All",
    dot: "bg-yellow-500",
    text: "text-yellow-700",
    bg: "bg-yellow-50",
    border: "border-yellow-200",
    description: "Domain accepts all emails. Deliverability cannot be guaranteed.",
  },
  risky: {
    label: "Risky",
    dot: "bg-orange-500",
    text: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
    description: "Role address, disposable domain, or full inbox. Send with caution.",
  },
  invalid: {
    label: "Invalid",
    dot: "bg-red-500",
    text: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-200",
    description: "Email is invalid or disabled. Do not send.",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-gray-400",
    text: "text-gray-500",
    bg: "bg-gray-50",
    border: "border-gray-200",
    description: "Not yet verified.",
  },
};

interface Props {
  status: string | null | undefined;
  verifiedAt?: Date | string | null;
  /** compact = dot only, default = dot + label */
  compact?: boolean;
}

export function EmailVerificationBadge({ status, verifiedAt, compact = false }: Props) {
  const key = (status as VerificationStatus) ?? "unknown";
  const b = BADGE[key] ?? BADGE.unknown;

  const verifiedAtStr = verifiedAt
    ? new Date(verifiedAt).toLocaleString()
    : null;

  const badge = (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${b.bg} ${b.border} ${b.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${b.dot} shrink-0`} />
      {!compact && b.label}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {badge}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <p className="font-semibold">{b.label}</p>
        <p className="text-muted-foreground mt-0.5">{b.description}</p>
        {verifiedAtStr && (
          <p className="text-muted-foreground mt-1">Last verified: {verifiedAtStr}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Dot-only compact variant for use in tight table cells */
export function EmailVerificationDot({ status }: { status: string | null | undefined }) {
  const key = (status as VerificationStatus) ?? "unknown";
  const b = BADGE[key] ?? BADGE.unknown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block h-2 w-2 rounded-full ${b.dot} cursor-default`} />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {b.label} — {b.description}
      </TooltipContent>
    </Tooltip>
  );
}
