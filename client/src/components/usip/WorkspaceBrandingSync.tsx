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
    } else {
      for (const p of BRAND_PROPS) root.style.removeProperty(p);
    }
  }, [brand, palette]);

  return null;
}
