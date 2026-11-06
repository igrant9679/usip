/**
 * /are/prospects/:id — a link to one Revenue Engine prospect (audit 2026-10-20,
 * A57). A notice about a person carries only the person's id; this finds their
 * campaign and opens its page with their dossier (the page reads ?prospect=).
 */
import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Loader2 } from "lucide-react";
import { Shell, QueryError } from "@/components/usip/Shell";
import { NotFoundState, isNotFoundError } from "@/components/usip/QueryState";
import { trpc } from "@/lib/trpc";

export default function AREProspectRedirect() {
  const { id } = useParams<{ id: string }>();
  const prospectId = Number(id);
  const valid = Number.isInteger(prospectId) && prospectId > 0;
  const [, navigate] = useLocation();
  const q = trpc.are.prospects.locate.useQuery({ prospectId }, { enabled: valid, retry: false });
  useEffect(() => {
    if (q.data) navigate(`/are/campaigns/${q.data.campaignId}?prospect=${prospectId}`, { replace: true });
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!valid || (q.error && isNotFoundError(q.error))) {
    return <Shell title="Prospect"><NotFoundState what="prospect" backHref="/are/campaigns" backLabel="All campaigns" /></Shell>;
  }
  if (q.error) {
    return <Shell title="Prospect"><QueryError what="this prospect" message={q.error.message} onRetry={() => q.refetch()} /></Shell>;
  }
  return (
    <Shell title="Prospect">
      <div className="flex items-center gap-2 text-muted-foreground py-24 justify-center">
        <Loader2 className="size-5 animate-spin" /> Opening prospect…
      </div>
    </Shell>
  );
}
