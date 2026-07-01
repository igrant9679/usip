/**
 * CompanyAvatar — company logo with graceful fallback.
 *
 * Renders a permitted logo URL (user upload / CRM / enrichment provider) when
 * available, else the company's website favicon, and falls back to an initials
 * lettermark (colour derived from the name) if there's no source or the image
 * fails to load. Never blocks on a missing logo. Accessible alt text.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";

const PALETTE = [
  "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04",
  "#16a34a", "#0d9488", "#0284c7", "#4f46e5", "#9333ea", "#c026d3",
];
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const SIZE: Record<string, string> = { sm: "size-6 text-[10px]", md: "size-8 text-xs", lg: "size-14 text-lg rounded-xl" };

export function CompanyAvatar({
  name, logoUrl, faviconUrl, size = "md", className,
}: {
  name: string;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? (logoUrl || faviconUrl || null) : null;
  const box = cn("shrink-0 rounded-md flex items-center justify-center overflow-hidden", SIZE[size], className);

  if (src) {
    return (
      <span className={cn(box, "border border-border bg-white")}>
        <img
          src={src}
          alt={`Logo for ${name}`}
          className="size-full object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className={cn(box, "font-bold text-white")} style={{ backgroundColor: colorFor(name) }} aria-label={`Logo for ${name}`}>
      {initials(name)}
    </span>
  );
}
