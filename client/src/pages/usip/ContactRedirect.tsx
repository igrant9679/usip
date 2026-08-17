/**
 * /contacts and /contacts/:id → People.
 *
 * Owner directive (2026-08-17): ONE location for every person record. The
 * scrapers, the ARE Hub, enrichment — everything contributes to and reads
 * from People (prospects) and Companies (accounts); there are no duplicate
 * pages. The standalone Contacts list is retired.
 *
 * This is safe because the 0160 fold-in is complete: every contact row in
 * both workspaces carries `personProspectId` (1,520/1,520 LSI, 983/983 CF on
 * the day this shipped). No person exists only on the Contacts page.
 *
 * Deep links keep working. A `/contacts/:id` URL — from an old draft, an
 * activity, a brief, a bookmark — resolves the contact's linked person and
 * lands on THAT record. If a contact somehow has no person (a future import
 * that bypasses the fold), it falls back to the People list with a search
 * on the name rather than a 404, so nothing is unreachable.
 *
 * The `contacts` TABLE is untouched. Deal roles, drafts, replies, activities
 * and tasks still point at contact rows; retiring the storage is a separate,
 * deliberate migration (see SESSION_STATUS day 13). This retires the PAGE.
 */
import { useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";

export default function ContactRedirect() {
  const { id: idStr } = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  const id = idStr ? Number(idStr) : NaN;
  const hasId = Number.isFinite(id);

  const { data, isLoading, isError } = trpc.contacts.getWithAccount.useQuery(
    { id },
    { enabled: hasId, retry: false },
  );

  useEffect(() => {
    if (!hasId) { setLocation("/v2/people", { replace: true }); return; }
    if (isLoading) return;
    const c = data?.contact as { personProspectId?: number | null; firstName?: string | null; lastName?: string | null } | undefined;
    if (c?.personProspectId) {
      setLocation(`/prospects/${c.personProspectId}`, { replace: true });
      return;
    }
    // No linked person (or the contact is gone): land on People with the name
    // as a search rather than dead-ending. Empty name → plain list.
    const q = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();
    setLocation(q ? `/v2/people?q=${encodeURIComponent(q)}` : "/v2/people", { replace: true });
  }, [hasId, isLoading, isError, data, setLocation]);

  return (
    <div className="flex items-center justify-center h-64 text-sm text-muted-foreground gap-2">
      <Loader2 className="size-4 animate-spin" /> Opening this person in People…
    </div>
  );
}
