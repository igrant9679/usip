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

/** Which brand stands behind each sending provider. */
export const PROVIDER_BRAND: Record<string, { domain: string; label: string }> = {
  google_oauth: { domain: "google.com", label: "Google" },
  outlook_oauth: { domain: "outlook.com", label: "Outlook" },
  sendgrid: { domain: "sendgrid.com", label: "SendGrid" },
  amazon_ses: { domain: "aws.amazon.com", label: "Amazon SES" },
};

/** Consumer domains whose brand IS the provider. */
const OUTLOOK_FAMILY = /^(outlook|hotmail|live|msn|office365|microsoft)\./;

export function providerBrandDomain(provider: string, email?: string | null): { domain: string | null; label: string } {
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
  const { domain, label } = useMemo(() => providerBrandDomain(provider, email), [provider, email]);

  const src = useMemo(
    () => brandfetchLogoUrl(domain, clientId, {
      theme: theme === "dark" ? "dark" : "light",
      size: pixels * 2,
      type: "icon",
      fallback: "404",
    }),
    [domain, clientId, theme, pixels],
  );

  const [failed, setFailed] = useState(false);
  // A new identity (or a client id that arrives late) deserves a fresh try.
  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) return <>{fallback}</>;
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
        onError={() => setFailed(true)}
      />
    </span>
  );
}
