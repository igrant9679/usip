/**
 * /prospects/:id — full profile page for a single saved prospect.
 *
 * Sections:
 *   - Header     : name + confidence chip + verification + quick actions
 *                  (Re-enrich, Edit, Archive, back to list)
 *   - Profile    : every persisted field, editable inline via a dialog
 *   - Evidence   : every sourceUrl the discovery pipeline collected,
 *                  each one a clickable external link with its source
 *                  type. Plus the per-source LinkedIn URL if present.
 *   - Verification: the human-readable verificationNotes, score
 *                  breakdown, and the discovery run that last touched
 *                  the row.
 */
import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell } from "@/components/usip/Shell";
import { DetailHeader, DetailSection, DetailBody, LifecycleStepper } from "@/components/usip/DetailShell";
import { AddToMenu } from "@/components/usip/AddToMenu";
import { ProfileImageUploader, ProfileImageSourceBadge } from "@/components/usip/ProspectAvatar";
import { LinkedInEnrichmentFullPanel } from "@/components/usip/people/LinkedInEnrichment";
import { ProspectScoringPanel } from "@/components/usip/scoring/ProspectScoringPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  User,
  ArrowLeft,
  Pencil,
  Archive,
  RefreshCw,
  ExternalLink,
  Linkedin,
  Mail,
  Phone,
  MapPin,
  Building2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Loader2,
  Globe,
  Calendar,
} from "lucide-react";

function tierStyle(tier: string | null) {
  if (tier === "high") return { c: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", Icon: CheckCircle2 };
  if (tier === "medium") return { c: "bg-amber-500/15 text-amber-700 dark:text-amber-400", Icon: AlertTriangle };
  if (tier === "low") return { c: "bg-red-500/15 text-red-700 dark:text-red-400", Icon: AlertCircle };
  return { c: "bg-muted text-muted-foreground", Icon: AlertCircle };
}

interface EditDraft {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  companyDomain: string;
  linkedinUrl: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  industry: string;
}

export default function ProspectDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data: p, isLoading } = trpc.prospects.get.useQuery({ id }, { enabled: !Number.isNaN(id) });
  const update = trpc.prospects.update.useMutation({
    onSuccess: () => { toast.success("Saved"); utils.prospects.get.invalidate({ id }); setEditing(null); },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.prospects.archive.useMutation({
    onSuccess: () => { toast.success("Archived"); utils.prospects.get.invalidate({ id }); },
    onError: (e) => toast.error(e.message),
  });
  const reEnrich = trpc.prospects.reEnrich.useMutation({
    onSuccess: (r) => {
      toast.success(`Re-enriched — ${r.rawFindCount} new raw finds, score now ${r.highConfidenceCount} high / ${r.mediumConfidenceCount} medium / ${r.lowConfidenceCount} low`);
      utils.prospects.get.invalidate({ id });
    },
    onError: (e) => toast.error(e.message),
  });

  const [editing, setEditing] = useState<EditDraft | null>(null);

  if (isLoading) {
    return <Shell title="Prospect"><div className="p-4 md:p-5 text-center text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin inline mr-2" /> Loading…</div></Shell>;
  }
  if (!p) {
    return <Shell title="Prospect"><div className="p-4 md:p-5 text-center text-sm text-muted-foreground">Prospect not found.</div></Shell>;
  }

  const sourceUrls = (p.sourceUrls as string[] | null) ?? [];
  const fullName = `${p.firstName} ${p.lastName}`.trim();
  const { c: tierClass, Icon: TierIcon } = tierStyle(p.confidenceTier);

  const startEdit = () => setEditing({
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    title: p.title ?? "",
    company: p.company ?? "",
    companyDomain: p.companyDomain ?? "",
    linkedinUrl: p.linkedinUrl ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    country: p.country ?? "",
    industry: p.industry ?? "",
  });

  return (
    <Shell title={fullName}>
      <div className="flex flex-col h-full min-h-0">
      {/* v2 detail shell (phase 5): the avatar + identity + verification
          banner that used to be two stacked cards ARE the header now. The
          avatar appears only here, on the full profile — never in results. */}
      <DetailHeader
        back={{ href: "/v2/people", label: "People" }}
        avatar={<ProfileImageUploader image={p.profile_image} name={fullName} prospectId={id} size="lg" />}
        title={fullName}
        tourId="page-prospect-detail"
        badges={<>
          <Badge className={`text-[11px] gap-1 ${tierClass}`}><TierIcon className="size-3" /> {p.confidenceScore ?? "—"}/100 · {p.confidenceTier ?? "unscored"}</Badge>
          {p.verificationStatus === "verified" && <Badge variant="outline" className="text-[11px] border-emerald-500/40 text-emerald-700">verified</Badge>}
          {p.verificationStatus === "needs_review" && <Badge variant="outline" className="text-[11px] border-amber-500/40 text-amber-700">needs review</Badge>}
          {p.verificationStatus === "rejected" && <Badge variant="outline" className="text-[11px] border-destructive/40 text-destructive">archived</Badge>}
          {p.linkedinUrlVerified && <Badge variant="outline" className="text-[11px] border-emerald-500/40 text-emerald-700 gap-1"><Linkedin className="size-2.5" /> LinkedIn verified</Badge>}
          {p.profile_image?.url ? <ProfileImageSourceBadge source={p.profile_image.source_type} /> : null}
          {/* The CRM spine (phase 6): where this person is, derived server-side. */}
          {(p as any).lifecycle && (
            <LifecycleStepper
              stage={(p as any).lifecycle.stage}
              hrefs={{
                prospect: `/prospects/${id}`,
                lead: (p as any).lifecycle.leadId ? `/leads/${(p as any).lifecycle.leadId}` : undefined,
                opportunity: (p as any).lifecycle.opportunityId ? `/opportunities/${(p as any).lifecycle.opportunityId}` : undefined,
                customer: (p as any).lifecycle.accountId ? `/customers` : undefined,
              }}
            />
          )}
        </>}
        meta={<>
          {p.title && <span className="inline-flex items-center gap-1"><Building2 className="size-3.5" />{p.title}</span>}
          {p.company && <span className="inline-flex items-center gap-1"><Building2 className="size-3.5" />{p.company}</span>}
          {p.email && <a href={`mailto:${p.email}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Mail className="size-3.5" />{p.email}</a>}
          {p.linkedinUrl && <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Linkedin className="size-3.5" />LinkedIn</a>}
          {p.lastEnrichedAt && <span className="inline-flex items-center gap-1"><Calendar className="size-3.5" />Enriched {new Date(p.lastEnrichedAt).toLocaleDateString()}</span>}
        </>}
        actions={<>
          <AddToMenu prospectIds={[id]} />
          <Button variant="outline" size="sm" onClick={() => reEnrich.mutate({ id })} disabled={reEnrich.isPending} className="gap-1.5">
            {reEnrich.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Re-enrich
          </Button>
          <Button variant="outline" size="sm" onClick={startEdit} className="gap-1.5"><Pencil className="size-3.5" /> Edit</Button>
          <Button variant="outline" size="sm" onClick={() => archive.mutate({ id })} disabled={archive.isPending} className="gap-1.5 text-destructive">
            <Archive className="size-3.5" /> Archive
          </Button>
        </>}
      />

      <DetailBody className="max-w-5xl w-full mx-auto">
        {/* Profile fields */}
        <DetailSection title="Profile">
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <ProfileField icon={Building2} label="Title">{p.title || <Muted />}</ProfileField>
            <ProfileField icon={Building2} label="Company">{p.company || <Muted />}</ProfileField>
            <ProfileField icon={Globe} label="Company domain">
              {p.companyDomain ? <ExtLink href={p.companyDomain.startsWith("http") ? p.companyDomain : `https://${p.companyDomain}`}>{p.companyDomain}</ExtLink> : <Muted />}
            </ProfileField>
            <ProfileField icon={Building2} label="Industry">{p.industry || <Muted />}</ProfileField>
            <ProfileField icon={Mail} label="Email">
              {p.email ? <a className="hover:underline" href={`mailto:${p.email}`}>{p.email}</a> : <Muted />}
            </ProfileField>
            <ProfileField icon={Phone} label="Phone">
              {p.phone ? <a className="hover:underline" href={`tel:${p.phone}`}>{p.phone}</a> : <Muted />}
            </ProfileField>
            <ProfileField icon={Linkedin} label="LinkedIn">
              {p.linkedinUrl ? <ExtLink href={p.linkedinUrl}>{p.linkedinUrl}</ExtLink> : <Muted />}
            </ProfileField>
            <ProfileField icon={MapPin} label="Location">
              {[p.city, p.state, p.country].filter(Boolean).join(", ") || <Muted />}
            </ProfileField>
          </div>
        </DetailSection>

        {/* LinkedIn enrichment (Unipile) — optional metadata, daily-checked */}
        <LinkedInEnrichmentFullPanel prospectId={id} />

        {/* Velocity Priority Score — explainable fit + priority breakdown */}
        <DetailSection title="Velocity priority score">
          <ProspectScoringPanel objectType="person" objectId={id} />
        </DetailSection>

        {/* Evidence panel */}
        <DetailSection title="Evidence — every source URL" tag="the public pages the discovery pipeline pulled this person's data from; open any to verify the claim">
          <div>
            {sourceUrls.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No source URLs recorded — this prospect predates Discovery v2 or was created manually.</div>
            ) : (
              <ul className="space-y-1.5">
                {sourceUrls.map((u, i) => (
                  <li key={u + i} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground tabular-nums w-6 shrink-0">{i + 1}.</span>
                    <ExternalLink className="size-3 text-muted-foreground shrink-0" />
                    <ExtLink href={u} className="truncate">{u}</ExtLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DetailSection>

        {/* Verification notes */}
        {p.verificationNotes && (
          <DetailSection title="Verification notes" tag={<span className="inline-flex items-center gap-1"><AlertTriangle className="size-3 text-amber-500" /> why the pipeline flagged this person</span>}>
            <div className="text-xs whitespace-pre-wrap bg-muted/40 rounded p-3 font-mono leading-relaxed">{p.verificationNotes}</div>
          </DetailSection>
        )}

        {/* Discovery run trail */}
        {p.lastDiscoveryRunId && (
          <DetailSection title="Discovery run" tag="the pipeline run that last touched this person">
            <Link href={`/v2/data-enrichment?tab=find-prospects&runId=${p.lastDiscoveryRunId}`}>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                Run #{p.lastDiscoveryRunId} <ExternalLink className="size-3" />
              </Button>
            </Link>
          </DetailSection>
        )}
      </DetailBody>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit prospect</DialogTitle></DialogHeader>
          {editing && (
            <div className="grid gap-3 sm:grid-cols-2">
              {(["firstName","lastName","title","company","companyDomain","industry","email","phone","linkedinUrl","city","state","country"] as const).map((k) => (
                <div key={k} className="space-y-1.5">
                  <Label className="text-xs capitalize">{k.replace(/([A-Z])/g, " $1")}</Label>
                  <Input value={(editing as any)[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              onClick={() => editing && update.mutate({ id, ...editing })}
              disabled={update.isPending}
              className="gap-1.5"
            >
              {update.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

/* ─── Small helpers ─────────────────────────────────────────────────── */
function ProfileField({ icon: Icon, label, children }: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Icon className="size-3" />{label}</div>
      <div className="text-sm font-medium break-words">{children}</div>
    </div>
  );
}
function Muted() {
  return <span className="text-muted-foreground italic font-normal">—</span>;
}
function ExtLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 hover:underline ${className ?? ""}`}>
      <span className="truncate">{children}</span>
    </a>
  );
}
