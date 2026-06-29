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
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

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

/**
 * Read an uploaded image file and return a small, centre-cropped square JPEG
 * data URL. Keeps the stored payload tiny (a few KB) so it fits inline — and
 * means we only ever store the workspace's own uploaded content.
 */
export function fileToSquareDataUrl(file: File, max = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Not a valid image"));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = max;
        canvas.height = max;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable"));
        ctx.drawImage(img, sx, sy, side, side, 0, 0, max, max);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Avatar + "Change photo" affordance. On select, the image is resized/cropped
 * client-side and stored as a user-uploaded photo via prospects.uploadProfileImage.
 * Use this on the full profile; the read-only ProspectAvatar elsewhere.
 */
export function ProfileImageUploader({
  image,
  name,
  prospectId,
  size = "lg",
}: {
  image: ProfileImage | null | undefined;
  name: string;
  prospectId: number;
  size?: AvatarSize;
}) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = trpc.prospects.uploadProfileImage.useMutation({
    onSuccess: () => {
      utils.prospects.get.invalidate({ id: prospectId });
      toast.success("Profile photo updated");
      setBusy(false);
    },
    onError: (e) => {
      toast.error(e.message || "Upload failed");
      setBusy(false);
    },
  });
  const remove = trpc.prospects.updateProfileImage.useMutation({
    onSuccess: () => {
      utils.prospects.get.invalidate({ id: prospectId });
      toast.success("Profile photo removed");
    },
    onError: (e) => toast.error(e.message || "Could not remove"),
  });

  const hasImage = !!(image && image.status === "available" && image.url);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await fileToSquareDataUrl(file, 128);
      if (dataUrl.length > 60000) {
        toast.error("Image is too large — try a smaller photo");
        setBusy(false);
        return;
      }
      upload.mutate({ id: prospectId, dataUrl });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not process image");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="group relative">
        <ProspectAvatar image={image} name={name} size={size} />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-full bg-foreground/45 text-[10px] font-medium text-background transition-opacity",
            busy ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
          aria-label={`Upload a profile photo for ${name}`}
        >
          {busy ? "…" : hasImage ? "Change" : "Add photo"}
        </button>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      </div>
      {hasImage ? (
        <button
          type="button"
          onClick={() => remove.mutate({ id: prospectId, status: "removed" })}
          className="text-[10px] text-muted-foreground hover:text-destructive"
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}
