/**
 * CompanyLogo — THE company-brand avatar, used anywhere a company appears.
 *
 * Renders through a tiered cascade, falling to the next tier on load error
 * with no layout shift (fixed box, object-contain):
 *
 *   1. Brandfetch Logo Link (hotlinked CDN URL built from the domain —
 *      official artwork, theme-aware, aspect preserved; `fallback/404`
 *      makes unknown brands fail instantly into tier 2)
 *   2. the stored logo (site-icon pipeline result or manual upload)
 *   3. the favicon fallback URL, when a caller supplies one
 *   4. an initials lettermark (always available)
 *
 * The Brandfetch client id is public by design (it rides in every img URL);
 * it arrives via system.brandingConfig and the whole tier disappears
 * gracefully when unset. Nothing here ever calls Brandfetch server-side.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { useTheme } from "@/contexts/ThemeContext";
import { brandfetchLogoUrl, type BrandLogoOptions } from "@shared/brandfetch";

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

const SIZE: Record<string, string> = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-14 text-lg rounded-xl",
};
const PIXELS: Record<string, number> = { xs: 20, sm: 24, md: 32, lg: 56 };

/** The public Logo Link client id, fetched once per session. */
export function useBrandfetchClientId(): string | null {
  const q = trpc.system.brandingConfig.useQuery(undefined, { staleTime: Infinity });
  return q.data?.brandfetchLogoClientId ?? null;
}

export function CompanyLogo({
  name,
  domain,
  storedLogoUrl,
  faviconUrl,
  size = "md",
  type = "icon",
  className,
}: {
  name: string;
  domain?: string | null;
  storedLogoUrl?: string | null;
  faviconUrl?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  type?: BrandLogoOptions["type"];
  className?: string;
}) {
  const clientId = useBrandfetchClientId();
  const { theme } = useTheme();

  const sources = useMemo(() => {
    const brand = brandfetchLogoUrl(domain, clientId, {
      theme: theme === "dark" ? "dark" : "light",
      size: PIXELS[size] * 2, // high-DPI: request 2×, render at box size
      type,
      fallback: "404",
    });
    return [brand, storedLogoUrl ?? null, faviconUrl ?? null].filter((s): s is string => !!s);
  }, [domain, clientId, theme, size, type, storedLogoUrl, faviconUrl]);

  const [tier, setTier] = useState(0);
  // New identity (or a newly arrived client id) restarts the cascade.
  useEffect(() => { setTier(0); }, [domain, clientId, storedLogoUrl]);

  const src = sources[tier] ?? null;
  const box = cn("shrink-0 rounded-md flex items-center justify-center overflow-hidden", SIZE[size], className);

  if (src) {
    return (
      <span className={cn(box, "border border-border bg-background")}>
        <img
          src={src}
          alt={`Logo for ${name}`}
          className="size-full object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setTier((t) => t + 1)}
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
