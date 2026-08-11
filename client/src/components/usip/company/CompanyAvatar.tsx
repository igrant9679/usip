/**
 * CompanyAvatar — thin compatibility wrapper over CompanyLogo, the one
 * company-brand component. Kept so existing call sites keep their names;
 * new surfaces should use CompanyLogo directly. Passing `domain` unlocks
 * the Brandfetch tier; without it the cascade starts at the stored logo.
 */
import { CompanyLogo } from "./CompanyLogo";

export function CompanyAvatar({
  name, domain, logoUrl, faviconUrl, size = "md", className,
}: {
  name: string;
  domain?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <CompanyLogo
      name={name}
      domain={domain}
      storedLogoUrl={logoUrl}
      faviconUrl={faviconUrl}
      size={size}
      className={className}
    />
  );
}
