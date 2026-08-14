/**
 * Real provider logos for mailboxes (owner ask 2026-08-14: "use Brandfetch to
 * retrieve proper logos for Google, Outlook, and SendGrid… after an inbox is
 * imported I'd like the provider logo to appear next to the inbox name and
 * domain. Basically replace the 'S' symbol").
 *
 * Hotlinks Brandfetch's CDN by domain, exactly as CompanyLogo does — same
 * public logo client id, same no-store rule (we never copy their bytes), and
 * the SAME cascade discipline: if the CDN has nothing, or the client id is
 * absent, fall through to the hand-drawn glyph rather than showing a hole.
 *
 * An SMTP mailbox has no provider brand, so it falls back to the mailbox's OWN
 * domain — a company running its own mail server is better represented by its
 * own logo than by a generic envelope.
 */
import React, { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { brandfetchLogoUrl } from "@shared/brandfetch";
import { useTheme } from "@/contexts/ThemeContext";
import { useBrandfetchClientId } from "@/components/usip/company/CompanyLogo";

/**
 * Which brand stands behind each sending provider, and which CDN asset types
 * are worth asking for.
 *
 * Measured against the live CDN 2026-08-14 (64px, dark theme, alpha sampled):
 *   symbol → corner alpha 0, ~45% transparent pixels — the standalone mark.
 *   icon   → corner alpha 255, 0% transparent — a favicon-style square with a
 *            solid background baked in. This is the white box that survived
 *            making the wrapper transparent: the opacity was in the IMAGE.
 * So `symbol` first, `icon` only as a last resort.
 *
 * Outlook is the exception: cdn.brandfetch.io has NO symbol for outlook.com
 * (404), its icon is the opaque Microsoft-style square, and its logo is a
 * 64×14 wordmark — none of which is the Outlook app mark. `types: []` skips
 * the CDN entirely so the caller's own Outlook glyph renders: transparent SVG,
 * and actually Outlook rather than Microsoft's main logo (owner ask).
 */
export const PROVIDER_BRAND: Record<string, { domain: string; label: string; types?: Array<"symbol" | "icon" | "logo"> }> = {
  google_oauth: { domain: "google.com", label: "Google" },
  outlook_oauth: { domain: "outlook.com", label: "Outlook", types: [] },
  sendgrid: { domain: "sendgrid.com", label: "SendGrid" },
  amazon_ses: { domain: "aws.amazon.com", label: "Amazon SES" },
};

/** Transparent mark first; the opaque favicon square only if there is no mark. */
const DEFAULT_TYPES: Array<"symbol" | "icon" | "logo"> = ["symbol", "icon"];

/** Consumer domains whose brand IS the provider. */
const OUTLOOK_FAMILY = /^(outlook|hotmail|live|msn|office365|microsoft)\./;

export function providerBrandDomain(provider: string, email?: string | null): { domain: string | null; label: string; types?: Array<"symbol" | "icon" | "logo"> } {
  const known = PROVIDER_BRAND[provider];
  if (known) return known;
  const host = (email ?? "").split("@")[1]?.toLowerCase() ?? "";
  if (!host) return { domain: null, label: "Mailbox" };
  if (OUTLOOK_FAMILY.test(`${host}.`)) return PROVIDER_BRAND.outlook_oauth;
  if (/^(gmail|googlemail)\./.test(`${host}.`)) return PROVIDER_BRAND.google_oauth;
  // Their own mail server: their own logo.
  return { domain: host, label: host };
}

/**
 * The logo, or `fallback` when there is nothing real to show — no client id,
 * no resolvable domain, or the CDN has no icon for it. Rendering the fallback
 * HERE (rather than asking the caller to detect emptiness) is what keeps the
 * cascade honest: an <img> that 404s swaps to the glyph on its error event.
 */
export function ProviderLogo({
  provider,
  email,
  className,
  pixels = 24,
  fallback = null,
}: {
  provider: string;
  email?: string | null;
  className?: string;
  /** Rendered box size in px; the CDN is asked for 2× for high-DPI screens. */
  pixels?: number;
  fallback?: React.ReactNode;
}) {
  const clientId = useBrandfetchClientId();
  const { theme } = useTheme();
  const { domain, label, types } = useMemo(() => providerBrandDomain(provider, email), [provider, email]);

  // One URL per asset type, best first. An empty list means "never ask the
  // CDN" — the caller's glyph is already the better answer.
  const sources = useMemo(() => {
    const wanted = types ?? DEFAULT_TYPES;
    return wanted
      .map((type) => brandfetchLogoUrl(domain, clientId, {
        theme: theme === "dark" ? "dark" : "light",
        size: pixels * 2,
        type,
        fallback: "404",
      }))
      .filter((u): u is string => !!u);
  }, [domain, clientId, theme, pixels, types]);

  const [tier, setTier] = useState(0);
  // A new identity (or a client id that arrives late) restarts the cascade.
  useEffect(() => { setTier(0); }, [sources.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = sources[tier] ?? null;
  if (!src) return <>{fallback}</>;
  return (
    <span
      // No background and no border: the mark keeps its own transparency, so
      // it sits cleanly on the dark shell instead of inside a light card
      // (owner ask 2026-08-14). The CDN is asked for the theme-matched variant
      // above, which is what makes a dark-on-transparent logo readable.
      className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-transparent", className)}
      title={label}
    >
      <img
        src={src}
        alt={`${label} logo`}
        className="size-full object-contain"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setTier((t) => t + 1)}
      />
    </span>
  );
}
