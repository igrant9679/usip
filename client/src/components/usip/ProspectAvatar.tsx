/**
 * Prospect profile avatar — shown ONLY inside the full prospect profile.
 *
 * Renders a permitted profile image when one is available, and gracefully
 * falls back to an initials avatar when there is no image OR the image fails
 * to load. Never used in the People Search table, bulk modals, or exports.
 *
 * The image URL is decided server-side by resolveProspectProfileImage
 * (server/services/profileImage.ts) — this component trusts `image.url` and
 * only adds the runtime load-failure fallback.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type ProfileImageStatus =
  | "unknown"
  | "available"
  | "unavailable"
  | "failed_to_load"
  | "removed"
  | "blocked_by_policy";

export type ProfileImageSource =
  | "enrichment_provider"
  | "crm_import"
  | "user_uploaded"
  | "public_authorized_url";

export interface ProfileImage {
  url: string | null;
  source_type: ProfileImageSource | string | null;
  status: ProfileImageStatus | string;
  last_verified_at?: string | null;
}

/** Up to two initials from a full name, e.g. "Jane Smith" → "JS". */
export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic, muted background hue derived from the name (original — not
 *  a copy of any third-party palette). Keeps avatars visually distinct. */
function hueForName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

const SIZES = {
  sm: "size-8 text-xs",
  md: "size-12 text-sm",
  lg: "size-16 text-lg",
} as const;
type AvatarSize = keyof typeof SIZES;

/** Initials-only avatar. The always-available fallback. */
export function InitialsAvatar({
  name,
  size = "lg",
  className,
}: {
  name: string;
  size?: AvatarSize;
  className?: string;
}) {
  const hue = hueForName(name || "?");
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-border/60 select-none",
        SIZES[size],
        className,
      )}
      style={{
        backgroundColor: `hsl(${hue} 45% 92%)`,
        color: `hsl(${hue} 55% 32%)`,
      }}
    >
      {initialsFromName(name)}
    </div>
  );
}

/** Tracks image load failure so we can swap to initials at runtime. Resets
 *  whenever the URL changes. */
export function useProfileImageFallback(url: string | null | undefined) {
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [url]);
  return { errored, onError: () => setErrored(true) };
}

/**
 * The full-profile avatar. Shows the image only when a permitted URL exists
 * and it hasn't failed to load; otherwise shows initials.
 */
export function ProspectAvatar({
  image,
  name,
  size = "lg",
  className,
}: {
  image: ProfileImage | null | undefined;
  name: string;
  size?: AvatarSize;
  className?: string;
}) {
  const url = image && image.status === "available" ? image.url : null;
  const { errored, onError } = useProfileImageFallback(url);

  if (!url || errored) {
    return <InitialsAvatar name={name} size={size} className={className} />;
  }

  return (
    <img
      src={url}
      alt={`Profile image for ${name}`}
      onError={onError}
      loading="lazy"
      className={cn(
        "shrink-0 rounded-full object-cover ring-1 ring-border/60 bg-muted",
        SIZES[size],
        className,
      )}
    />
  );
}

const SOURCE_LABELS: Record<string, string> = {
  enrichment_provider: "Enrichment provider",
  crm_import: "CRM import",
  user_uploaded: "User uploaded",
  public_authorized_url: "Authorized URL",
};

/** Optional small label noting where a displayed image came from. */
export function ProfileImageSourceBadge({
  source,
  className,
}: {
  source: ProfileImageSource | string | null | undefined;
  className?: string;
}) {
  if (!source || !SOURCE_LABELS[source]) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground",
        className,
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}
