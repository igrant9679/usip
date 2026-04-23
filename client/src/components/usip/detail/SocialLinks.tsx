/**
 * SocialLinks — icon-only row of social profile links (LinkedIn, Twitter/X, website).
 * Renders nothing if all links are empty.
 */
import { Globe } from "lucide-react";

interface SocialLinksProps {
  linkedinUrl?: string | null;
  twitterUrl?: string | null;
  websiteUrl?: string | null;
  /** Additional custom links */
  extras?: Array<{ label: string; url: string; icon?: React.ReactNode }>;
  className?: string;
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function SocialLinks({
  linkedinUrl,
  twitterUrl,
  websiteUrl,
  extras = [],
  className = "",
}: SocialLinksProps) {
  const links: Array<{ url: string; icon: React.ReactNode; label: string }> = [];

  if (linkedinUrl) {
    links.push({
      url: linkedinUrl.startsWith("http") ? linkedinUrl : `https://${linkedinUrl}`,
      icon: <LinkedInIcon className="size-4" />,
      label: "LinkedIn",
    });
  }
  if (twitterUrl) {
    links.push({
      url: twitterUrl.startsWith("http") ? twitterUrl : `https://${twitterUrl}`,
      icon: <XIcon className="size-4" />,
      label: "Twitter / X",
    });
  }
  if (websiteUrl) {
    links.push({
      url: websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`,
      icon: <Globe className="size-4" />,
      label: "Website",
    });
  }
  for (const e of extras) {
    links.push({ url: e.url, icon: e.icon ?? <Globe className="size-4" />, label: e.label });
  }

  if (links.length === 0) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {links.map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer noopener"
          title={l.label}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {l.icon}
        </a>
      ))}
    </div>
  );
}
