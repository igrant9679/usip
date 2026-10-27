/**
 * WorkspaceBrandingSync — applies the workspace brand colour app-wide.
 *
 * Mounted once inside AuthGate (which wraps every authenticated route in
 * WorkspaceProvider), NOT inside Shell. That distinction is the whole point:
 * this logic originally lived in Shell.tsx, but the settings hub
 * (/v2/settings/*) deliberately renders WITHOUT Shell, so brand colours never
 * reached any settings page — including the Branding page itself, where you go
 * specifically to set them. Anything that must apply to the entire app belongs
 * here, above the Shell/no-Shell split.
 *
 * Model (user-chosen): the workspace brand colour is the DEFAULT. It drives the
 * primary token family only while the user is on the default "teal" palette;
 * the moment someone picks a personal palette, that wins and we clear the
 * override. Inline properties on <html> outrank the [data-theme] attribute
 * rules from index.css, so they MUST be removed for a named palette to work.
 */
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useTheme } from "@/contexts/ThemeContext";

/** Tokens the brand colour drives. --accent is deliberately NOT included: in
 *  this design system it's a light hover tint, not a brand accent, and
 *  overriding it with a saturated brand colour breaks every hover state. */
const BRAND_PROPS = ["--primary", "--ring", "--sidebar-primary", "--chart-1"];
/** Text on the brand colour. The default palette's is dark ink, so a dark
 *  brand colour put dark text on dark buttons (audit 2026-10-20, G64). */
const FOREGROUND_PROPS = ["--primary-foreground", "--sidebar-primary-foreground"];
const INK = "#1f2a2b";
const WHITE = "#ffffff";

const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function luminance(hex: string): number {
  let h = hex.replace("#", "").slice(0, 6);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** Ink or white, whichever reads better on this colour. */
export function readableOn(hex: string): string {
  const l = luminance(hex);
  return contrast(l, luminance(INK)) >= contrast(l, 1) ? INK : WHITE;
}
/** The stock default; treated as "no custom brand" so we leave the base sheet alone. */
const DEFAULT_BRAND = "#14b89a";

export function WorkspaceBrandingSync() {
  const { palette } = useTheme();
  const { data } = trpc.workspace.getBranding.useQuery(undefined, { staleTime: 60_000 });
  const brand = data?.brandPrimary;

  useEffect(() => {
    const root = document.documentElement;
    const isDefaultPalette = palette === "teal";
    const isCustomBrand =
      !!brand &&
      /^#([0-9A-Fa-f]{3})([0-9A-Fa-f]{3})?([0-9A-Fa-f]{2})?$/.test(brand) &&
      brand.toLowerCase() !== DEFAULT_BRAND;

    if (isDefaultPalette && isCustomBrand) {
      for (const p of BRAND_PROPS) root.style.setProperty(p, brand!);
      for (const p of FOREGROUND_PROPS) root.style.setProperty(p, readableOn(brand!));
    } else {
      for (const p of [...BRAND_PROPS, ...FOREGROUND_PROPS]) root.style.removeProperty(p);
    }
  }, [brand, palette]);

  return null;
}
