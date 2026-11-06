/**
 * Find prospects › LinkedIn search with no LinkedIn account connected
 * (tracker 2026-11-06, item 7: "can't be tested without a connected LinkedIn
 * account"). In its own file so tests render it.
 *
 * The card showed its form as though it would work, and only after a search
 * said "Connect a LinkedIn account to search." — no place named. The page's
 * own fallback said "Settings → Channels", which does not exist. Search runs
 * through the rep's own account (unipile.searchLinkedIn), connected on
 * Connected Accounts.
 */
import { Link } from "wouter";
import { Linkedin } from "lucide-react";

export function NoLinkedInConnected() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-[#0A66C2]/30 bg-[#0A66C2]/5 p-3 text-xs">
      <Linkedin className="size-4 shrink-0 mt-0.5 text-[#0A66C2]" />
      <div className="space-y-1">
        <p className="font-medium text-foreground">Connect your LinkedIn account to search</p>
        <p className="text-muted-foreground">
          Searches run through your own LinkedIn account. Connect it on Connected Accounts (Connect Account →
          LinkedIn); a Sales Navigator subscription on it adds the location, industry and tenure filters.
        </p>
        <Link href="/connected-accounts" className="inline-block font-medium text-[#0A66C2] underline underline-offset-2">
          Go to Connected Accounts
        </Link>
      </div>
    </div>
  );
}
