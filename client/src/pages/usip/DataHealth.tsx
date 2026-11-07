import { Shell, PageHeader, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { isAdminRole, rankOf, ROLE_RANK } from "@shared/roleRank";
import { CONTACT_MERGE_FIELDS, hasValue, planContactMerge, type ContactMergeField } from "@/lib/contactMergePlan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/usip/Common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitMerge,
  Loader2,
  Mail,
  Phone,
  RefreshCw,
  Split,
  Link2,
  Users,
  XCircle, ShieldCheck
} from "lucide-react";

function MetricCard({
  label,
  value,
  pct,
  icon: Icon,
  tone,
  fixHref,
  fixLabel,
}: {
  label: string;
  value: number;
  pct?: number;
  icon: any;
  tone: "default" | "success" | "warning" | "danger";
  fixHref?: string;
  fixLabel?: string;
}) {
  const [, setLocation] = useLocation();
  const toneRing =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50/60"
      : tone === "warning"
      ? "border-amber-200 bg-amber-50/60"
      : tone === "danger"
      ? "border-rose-200 bg-rose-50/60"
      : "border-border bg-card";
  const iconCls =
    tone === "success"
      ? "text-emerald-600"
      : tone === "warning"
      ? "text-amber-600"
      : tone === "danger"
      ? "text-rose-600"
      : "text-muted-foreground";

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 ${toneRing}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={`size-4 ${iconCls}`} />
      </div>
      <div className="text-2xl font-bold tabular-nums">{value.toLocaleString()}</div>
      {pct !== undefined && (
        <div className="space-y-1">
          <Progress value={pct} className="h-1.5" />
          <div className="text-xs text-muted-foreground">{pct}% of contacts</div>
        </div>
      )}
      {fixHref && fixLabel && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 text-xs px-2 self-start"
          onClick={() => setLocation(fixHref)}
        >
          <ExternalLink className="size-3 mr-1" />
          {fixLabel}
        </Button>
      )}
    </div>
  );
}

function FieldCoverageBar({ label, pct }: { label: string; pct: number }) {
  const color =
    pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-sm text-muted-foreground shrink-0">{label}</div>
      <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-10 text-right text-sm font-mono tabular-nums">{pct}%</div>
    </div>
  );
}

/* ─── Merge Dialog ──────────────────────────────────────────────────────── */
type DupeGroup = { type: "email" | "name"; key: string; ids: string[]; names: string[]; count: number };

/**
 * Merge a whole duplicate group (audit 2026-10-20, P95). It showed the first
 * two records, kept the oldest, and could not choose the address. Now every
 * record is a column, the person picks the one that survives and, per field,
 * whose value it keeps (the address included), and the rest are merged into
 * it one by one through the same server merge. planContactMerge computes the
 * preview and the calls from the same choices, so they cannot disagree.
 */
function MergeDialog({
  group,
  open,
  onClose,
  onMerged,
}: {
  group: DupeGroup;
  open: boolean;
  onClose: () => void;
  onMerged: () => void;
}) {
  const ids = group.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  const recordsQuery = trpc.dataHealth.duplicateGroupRecords.useQuery({ ids }, { enabled: open && ids.length > 1 });
  const records = recordsQuery.data ?? [];
  const isLoading = recordsQuery.isLoading;

  // The oldest stays the default, as before; it is now a choice.
  const [chosenId, setChosenId] = useState<number | null>(null);
  const survivorId = chosenId ?? records[0]?.id ?? 0;
  const [picks, setPicks] = useState<Partial<Record<ContactMergeField, number>>>({});
  const plan = planContactMerge(records, survivorId, picks);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const merge = trpc.dataHealth.mergeContacts.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const run = async () => {
    const total = plan.steps.length;
    let done = 0;
    setProgress({ done, total });
    try {
      for (const step of plan.steps) {
        await merge.mutateAsync({ primaryId: survivorId, ...step });
        done++;
        setProgress({ done, total });
      }
      toast.success(`Merged ${done} duplicate${done === 1 ? "" : "s"} into #${survivorId}.`);
      onClose();
    } catch {
      // onError has said why; say how far it got.
      if (done > 0) toast.message(`${done} of ${total} merged before it stopped. The rest are unchanged.`);
    } finally {
      setProgress(null);
      onMerged();
    }
  };

  const name = (r: (typeof records)[number]) => `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "(no name)";
  const busy = progress !== null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4 text-[#14B89A]" />
            Merge {records.length || group.count} duplicate contacts
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-4">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 rounded" />)}
          </div>
        ) : recordsQuery.error ? (
          <p className="text-sm text-rose-700 py-4">Could not load these contacts: {recordsQuery.error.message}</p>
        ) : records.length < 2 ? (
          <p className="text-sm text-muted-foreground py-4">This group no longer has two contacts to merge.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose the contact that stays, and for each field whose value it keeps. Everything that points at
              the others — activity, tasks, emails, replies, suppressions, deal roles, proposals, lists, enrolments
              and their People records — moves to it, then they are deleted (each deleted record is kept in the
              audit log). If the address it keeps is not the one someone unsubscribed from, the opt-out is carried
              over to it.
            </p>
            {records.length < ids.length ? (
              <p className="text-xs text-amber-700 flex items-center gap-1">
                <AlertTriangle className="size-3" />
                {ids.length - records.length} of this group's records no longer exist and are left out.
              </p>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b">
                    <th scope="col" className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2 pr-3">Field</th>
                    {records.map((r) => (
                      <th key={r.id} scope="col" className="text-left py-2 px-2 align-top min-w-[10rem]">
                        <label className="flex items-start gap-2 cursor-pointer font-normal">
                          <input
                            type="radio"
                            name={`survivor-${group.key}`}
                            className="mt-1"
                            checked={r.id === survivorId}
                            onChange={() => setChosenId(r.id)}
                            disabled={busy}
                          />
                          <span>
                            <span className="block font-medium">{name(r)}</span>
                            <span className="block text-xs text-muted-foreground">
                              #{r.id}{r.createdAt ? ` · added ${new Date(r.createdAt).toLocaleDateString()}` : ""}
                            </span>
                            <Badge
                              variant="secondary"
                              className={`mt-1 ${r.id === survivorId ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}
                            >
                              {r.id === survivorId ? "Kept" : "Deleted"}
                            </Badge>
                          </span>
                        </label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CONTACT_MERGE_FIELDS.map(({ key, label }) => (
                    <tr key={key} className="border-b border-border/50">
                      <th scope="row" className="text-left text-muted-foreground font-normal py-2 pr-3 align-top">{label}</th>
                      {records.map((r) => {
                        const v = (r as Record<string, unknown>)[key];
                        const kept = plan.result[key].fromId === r.id;
                        return (
                          <td key={r.id} className="py-2 px-2 align-top">
                            {hasValue(v) ? (
                              <button
                                type="button"
                                disabled={busy}
                                aria-pressed={kept}
                                onClick={() => setPicks((p) => ({ ...p, [key]: r.id }))}
                                className={`text-left break-all rounded px-1.5 py-0.5 border transition-colors ${
                                  kept
                                    ? "border-[#14B89A] bg-[#14B89A]/10 font-medium"
                                    : "border-transparent text-muted-foreground hover:border-[#14B89A]"
                                }`}
                              >
                                {String(v)}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              The highlighted value in each row is what the kept contact ends up with. Click another to keep that one instead.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => void run()}
            disabled={busy || isLoading || records.length < 2}
            className="bg-[#14B89A] hover:bg-[#12a589] text-white"
          >
            {busy
              ? <><Loader2 className="size-3 animate-spin mr-1" /> Merging {Math.min(progress!.done + 1, progress!.total)} of {progress!.total}…</>
              : <><GitMerge className="size-3 mr-1" /> Merge {Math.max(records.length - 1, 0)} into #{survivorId || "—"}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── People split across People and Contacts ───────────────────────────── */
/**
 * One human, two rows: a People record and a CRM contact with no link between
 * them. Card and list read the SAME payload, so the count above can never
 * disagree with the rows below it.
 *
 * The repair LINKS — nothing is deleted and no People row is merged away.
 * It is not a pure link either, and the copy says so: the contact's curated
 * values go through the merge onto the People record.
 */
function SplitPeopleSection({ canLinkAll }: { canLinkAll: boolean }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.dataHealth.personContactDuplicates.useQuery();
  const [, setLocation] = useLocation();
  // "Link all unlinked" reads one page of contacts per click (audit
  // 2026-10-20, P93); this is where the next click carries on from.
  const [linkCursor, setLinkCursor] = useState(0);

  const invalidate = () => {
    utils.dataHealth.personContactDuplicates.invalidate();
    // A merge onto the People row can fill a field the People-duplicate count
    // keys on, so that number can move too.
    utils.dataHealth.getMetrics.invalidate();
    // Linking writes contacts.personProspectId, which is exactly what the merge
    // plan below picks its survivor on. Without this the merge card keeps
    // showing the survivor it chose BEFORE the link, the server re-plans to a
    // different one, and the confirm is refused as stale — correct, but
    // baffling to look at (2026-09-20 review, defect 12).
    utils.dataHealth.planPeopleMerge.invalidate();
  };
  const link = trpc.dataHealth.linkPersonContactPairs.useMutation({
    onSuccess: (r) => {
      const bits = [`${r.linked} linked`, `${r.relinked} re-linked`];
      if (r.refused.length) bits.push(`${r.refused.length} refused`);
      if (r.mismatched.length) bits.push(`${r.mismatched.length} landed on a different person`);
      toast.success(bits.join(" · "));
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const linkAll = trpc.dataHealth.relinkAllUnlinked.useMutation({
    onSuccess: (r) => {
      const bits = [`Checked ${r.scanned} contact${r.scanned === 1 ? "" : "s"}`, `linked ${r.linked}`, `created ${r.created}`];
      if (r.skippedNameOnly) bits.push(`${r.skippedNameOnly} left alone (no address or LinkedIn to match on)`);
      if (r.failed) bits.push(`failed ${r.failed}`);
      toast.success(bits.join(" · ") + (r.more ? ". More remain: click again to carry on." : "."));
      setLinkCursor(r.more ? r.nextAfterId : 0);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pairs = data?.pairs ?? [];
  const busy = link.isPending || linkAll.isPending;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Split across People &amp; Contacts
      </h2>
      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-sm font-medium">
                  {data?.total ? `${data.total} people exist twice` : "Nothing split"}
                </CardTitle>
                <p className="text-xs text-muted-foreground max-w-2xl">
                  The same person as a People record and a CRM contact, with no link between them.
                  Linking points the contact at its People record and merges the contact’s own values
                  into that record — it never deletes a row and never merges two People rows.
                </p>
              </div>
              {canLinkAll ? (
                <ConfirmButton
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  destructive={false}
                  disabled={busy}
                  title={linkCursor ? "Link the next contacts?" : "Link unlinked contacts?"}
                  description="Checks the next 500 contacts with no People record. A contact is linked only where its address or LinkedIn profile matches a People record, and gets a new one where nothing does; its values are merged into that record. A contact that only a name matches is left alone, so one person's details never land on someone else's. It reads only what Velocity holds and spends no credits."
                  confirmLabel="Link"
                  onConfirm={() => linkAll.mutate({ afterId: linkCursor })}
                >
                  {linkAll.isPending
                    ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                    : <Link2 className="size-3.5 mr-1.5" />}
                  {linkCursor ? "Link the next 500" : "Link all unlinked"}
                </ConfirmButton>
              ) : (
                <span className="text-xs text-muted-foreground shrink-0 max-w-[12rem]">
                  A manager can link every unlinked contact at once.
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {pairs.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm">
                <CheckCircle2 className="size-8 mx-auto mb-2 text-emerald-500" />
                {data?.capped
                  ? `No people split across People and Contacts in the first ${data.scanned} contacts scanned.`
                  : "No people split across People and Contacts."}
              </div>
            ) : (
              <div className="divide-y">
                {pairs.map((p) => (
                  <div key={p.contactId} className="py-3 flex items-start gap-3">
                    <Badge
                      variant="secondary"
                      className={`shrink-0 mt-0.5 ${
                        p.kind === "unlinked"
                          ? "bg-blue-100 text-blue-700"
                          : p.kind === "relinkable"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {p.kind === "unlinked" ? "Not linked" : p.kind === "relinkable" ? "Wrong person" : "Needs a merge"}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{p.contactName || p.email}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        {p.email} ·{" "}
                        {p.currentPersonId
                          ? <>linked to <strong>{p.currentPersonName || `#${p.currentPersonId}`}</strong></>
                          : "not linked to a People record"}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">{p.reason}</div>
                      {p.kind === "relinkable" && (
                        <div className="text-xs text-amber-700 mt-0.5">
                          Re-linking changes who a campaign “Add existing” would enrol for this contact.
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-2"
                        onClick={() => setLocation(`/prospects/${p.personId}`)}
                      >
                        <ExternalLink className="size-3 mr-1" />
                        {p.personName || `#${p.personId}`}
                      </Button>
                      {p.kind !== "needs_merge" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          disabled={busy}
                          onClick={() => link.mutate({ contactIds: [p.contactId] })}
                        >
                          <Link2 className="size-3 mr-1" />
                          {p.kind === "unlinked" ? "Link" : "Re-link"}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              Where two People rows hold the same address, the fix is the People merge below — linking
              a contact does not remove the second People row, so this count only drops once those rows
              are merged.
              {data?.skippedGeneric
                ? ` ${data.skippedGeneric} shared inbox address${data.skippedGeneric === 1 ? "" : "es"} skipped — a team mailbox is not one person.`
                : ""}
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/* ─── People merge (irreversible) ───────────────────────────────────────── */
/**
 * The repair the "Needs a merge" badge above had no button for.
 *
 * READ FIRST, ALWAYS. The plan query writes nothing, so the whole outcome —
 * which row survives, which are deleted, which blanks get filled and how many
 * references move — renders before anything happens. The confirm is the only
 * destructive step, it names the cluster it is destroying, and the server
 * re-plans from that name rather than trusting this page's copy.
 *
 * TWO PASSES, ONE MERGE (2026-09-20). `by="email"` is the original: rows that
 * share an address. `by="linkedin"` groups on the same LinkedIn profile instead
 * — LSI Media's remaining ~90 duplicates carry two enrichment-guessed addresses
 * for one human, so no address-based scan can see them. The label says which,
 * because "duplicate People" without the grouping rule is not a claim an
 * operator can check.
 */
function PeopleMergeSection({ by = "email" }: { by?: "email" | "linkedin" }) {
  const linkedinPass = by === "linkedin";
  const utils = trpc.useUtils();
  const plan = trpc.dataHealth.planPeopleMerge.useQuery({ by, limit: 50 }, { retry: false });
  const [preview, setPreview] = useState<string | null>(null);

  const merge = trpc.dataHealth.executePeopleMerge.useMutation({
    onSuccess: (r) => {
      // A refusal is the safe outcome, not a silent one: say which cluster and
      // why, because "nothing happened" and "the survivor moved underneath you"
      // look identical from a count.
      const refused = r.stale.concat(r.unrecorded);
      if (r.merged.length) {
        toast.success(`Merged ${r.merged.length} cluster${r.merged.length === 1 ? "" : "s"} · ${r.peopleDeleted} People row${r.peopleDeleted === 1 ? "" : "s"} deleted`);
        // An address the merge dropped is named once more, after the fact: the
        // row that held it no longer exists anywhere but the audit log.
        r.merged.forEach((m) => {
          if (m.discardedEmails.length) {
            toast.message(`Dropped ${m.discardedEmails.join(", ")} — kept only in the audit log for this merge.`);
          }
        });
      }
      refused.forEach((s) => toast.error(`${s.key} not merged — ${s.reason}`));
      if (!r.merged.length && refused.length === 0) toast.success("Nothing merged — those rows changed since the preview.");
      setPreview(null);
      utils.dataHealth.planPeopleMerge.invalidate();
      utils.dataHealth.personContactDuplicates.invalidate();
      utils.dataHealth.getMetrics.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const clusters = plan.data?.merge ?? [];
  // The plan returns at most 50 groups; the heading counts every group it
  // found that can be merged, and says when the list shows fewer (audit
  // 2026-10-20, P158). A scan past its cap is a floor, hence "+".
  const mergeableTotal = Math.max(clusters.length, (plan.data?.clustersFound ?? 0) - (plan.data?.skipped.length ?? 0));
  const totalLabel = `${mergeableTotal}${plan.data?.capped ? "+" : ""}`;
  const open = clusters.filter((c) => c.key === preview)[0] ?? null;
  // "Merge all shown" (owner ask 2026-09-24): one confirmed click for every
  // cluster on screen instead of one dialog each. It sends exactly the
  // survivor/loser ids rendered below, so the server's approved-ids check
  // still refuses any cluster that changed since this plan was drawn.
  const allDeleted = clusters.reduce((n, c) => n + c.loserIds.length, 0);
  const allDropped = clusters.flatMap((c) => c.discardedEmails);
  const mergeAll = () => {
    if (linkedinPass) {
      merge.mutate({ by: "linkedin", clusters: clusters.map((c) => ({ key: c.key, survivorId: c.survivorId, loserIds: c.loserIds })) });
    } else {
      const withEmail = clusters.filter((c) => !!c.email);
      if (withEmail.length) merge.mutate({ clusters: withEmail.map((c) => ({ email: c.email!, survivorId: c.survivorId, loserIds: c.loserIds })) });
    }
  };

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {linkedinPass ? "Duplicate People (same LinkedIn profile)" : "Duplicate People (merge)"}
      </h2>
      {plan.isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : plan.error ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Merging duplicate People deletes rows for good, so it is admin-only.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium">
                  {clusters.length
                    ? linkedinPass
                      ? `${totalLabel} LinkedIn profile${mergeableTotal === 1 ? "" : "s"} held by more than one People row`
                      : `${totalLabel} email${mergeableTotal === 1 ? "" : "s"} held by more than one People row`
                    : "No duplicate People to merge"}
                  {clusters.length > 0 && clusters.length < mergeableTotal ? (
                    <span className="block text-xs font-normal text-muted-foreground mt-0.5">
                      Showing the first {clusters.length}. Merge these and the next ones appear.
                    </span>
                  ) : null}
                </CardTitle>
                {clusters.length > 1 && !plan.data?.proposalsCapped && (
                  <ConfirmButton
                    variant="destructive"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={merge.isPending}
                    title={`Merge all ${clusters.length} and delete ${allDeleted} People row${allDeleted === 1 ? "" : "s"}?`}
                    description={
                      `Every group listed below keeps the row marked as its survivor; the other ${allDeleted} row${allDeleted === 1 ? " is" : "s are"} deleted for good, after everything pointing at them is repointed. ` +
                      (allDropped.length
                        ? `${allDropped.length} address${allDropped.length === 1 ? "" : "es"} will be dropped and kept only in the audit log: ${allDropped.join(", ")}. `
                        : "") +
                      "Any group that changed since this list loaded is refused, not guessed at."
                    }
                    confirmLabel={`Merge all ${clusters.length}`}
                    onConfirm={mergeAll}
                  >
                    {merge.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <GitMerge className="size-3.5 mr-1.5" />}
                    Merge all {clusters.length} shown
                  </ConfirmButton>
                )}
              </div>
              {linkedinPass ? (
                <p className="text-xs text-muted-foreground max-w-2xl">
                  This pass groups rows that name <strong>the same LinkedIn profile</strong> — the same
                  <code className="mx-1">/in/</code>slug, ignoring the protocol, <code>www.</code>,
                  capitals, a trailing slash and tracking parameters. It finds the duplicates the email pass cannot:
                  two rows for one person whose addresses were <em>guessed</em> by enrichment from
                  different patterns (<code>tyler@richeymay.com</code> and{" "}
                  <code>tyler.house@richeymay.com</code>). Rows with no LinkedIn URL are never grouped, and
                  neither are rows whose URL holds a placeholder slug (<code>/in/unknown</code>,{" "}
                  <code>/in/N/A</code>) — dozens of unrelated people can carry the same one.
                  Because the two rows hold different addresses, the merge <strong>drops one of them</strong>:
                  the survivor keeps its own, and the other is listed below and written to the audit log —
                  Velocity has no honest field to park a second personal address in, so it is not
                  invented. The row that a contact points at wins; otherwise the row whose address
                  Reoon called valid wins, an <code>invalid</code> one is never preferred, and a row holding
                  no address at all never wins on its verdict — a verdict describing no address is not a
                  better address. The verdict stays with the address it describes: a survivor keeping its own
                  address never inherits the deleted row's <code>valid</code> or <code>invalid</code>.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground max-w-2xl">
                Merging keeps one row and <strong>permanently deletes</strong> the others. The survivor
                keeps every value it already has and its blanks are filled from the rows being deleted,
                so a phone on one and a city on the other both survive. Everything pointing at a deleted
                row — contacts, enrolments, drafts, replies, campaign queues, saved lists, tasks,
                meetings, activity, scores and enrichment history — is repointed at the survivor first.
                Where only one row per person is allowed (the LinkedIn dossier, a score for one model,
                a place on one list) the rows are combined into that one and the emptied duplicate is
                deleted. This cannot be undone; the deleted rows survive only in the audit log, which
                is written before anything is destroyed.
              </p>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {clusters.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm">
                <CheckCircle2 className="size-8 mx-auto mb-2 text-emerald-500" />
                {plan.data?.capped
                  ? "No mergeable duplicates inside the bounded cluster scan."
                  : linkedinPass
                  ? "No LinkedIn profile is held by two People rows."
                  : "No email is held by two People rows."}
              </div>
            ) : (
              <div className="divide-y">
                {clusters.map((c) => (
                  <div key={c.key} className="py-3 flex items-start gap-3">
                    <Badge variant="secondary" className="shrink-0 mt-0.5 bg-rose-100 text-rose-700">
                      {c.rows.length} rows
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{c.rows[0]?.name || c.key}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">{c.key}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Keeps #{c.survivorId} ({c.survivorReason === "contact-linked"
                          ? "a contact already points at it"
                          : c.survivorReason === "email-quality"
                          ? "its address is the verified one"
                          : "lowest id"})
                        {" · deletes "}{c.loserIds.map((id) => `#${id}`).join(", ")}
                        {c.fieldsFilled.length ? ` · fills ${c.fieldsFilled.length} blank field${c.fieldsFilled.length === 1 ? "" : "s"}` : " · nothing to fill"}
                        {c.repointTotal ? ` · repoints ${c.repointTotal} reference${c.repointTotal === 1 ? "" : "s"}` : " · no references to move"}
                      </div>
                      {c.discardedEmails.length ? (
                        <div className="text-xs text-amber-700 mt-0.5">
                          Also holds {c.discardedEmails.join(", ")}, which the merge will drop.
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs px-2 shrink-0"
                      disabled={merge.isPending}
                      onClick={() => setPreview(c.key)}
                    >
                      <GitMerge className="size-3 mr-1" />
                      Preview merge
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {plan.data?.skipped.length ? (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-1">
                <div className="text-xs font-medium text-amber-800">
                  {plan.data.skipped.length} cluster{plan.data.skipped.length === 1 ? "" : "s"} not offered for merge
                </div>
                {plan.data.skipped.map((s) => (
                  <div key={s.key} className="text-xs text-amber-700">
                    {s.key} — {s.reason}
                  </div>
                ))}
              </div>
            ) : null}
            {plan.data?.proposalsCapped ? (
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-800">
                Too many campaign proposals carry a People-id list to rewrite them all, so merging is
                refused: a merge that rewrote only some of them would leave the rest naming rows that
                no longer exist.
              </div>
            ) : null}
            {plan.data?.skippedGeneric ? (
              <p className="text-xs text-muted-foreground mt-3">
                {plan.data.skippedGeneric} shared inbox address{plan.data.skippedGeneric === 1 ? "" : "es"} skipped —
                a team mailbox is not one person, and merging one would fuse several humans into one record.
              </p>
            ) : null}
            {plan.data?.skippedPlaceholderProfiles ? (
              <p className="text-xs text-muted-foreground mt-3">
                {plan.data.skippedPlaceholderProfiles} People row
                {plan.data.skippedPlaceholderProfiles === 1 ? "" : "s"} hold a placeholder LinkedIn URL
                (<code>/in/unknown</code>, <code>/in/N/A</code>) and {plan.data.skippedPlaceholderProfiles === 1 ? "is" : "are"} never
                grouped — that is what an enrichment provider stored when it had no profile to give, not a
                profile, and every row holding one would otherwise land in a single cluster of unrelated people.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Dialog open={open !== null} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        {/* Fits a phone as the contact merge dialog does (audit 2026-10-20, P160). */}
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Merge {open?.key}</DialogTitle>
          </DialogHeader>
          {open && (
            <div className="space-y-4 text-sm">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Rows</div>
                <div className="divide-y rounded-md border">
                  {open.rows.map((r) => (
                    <div key={r.id} className="px-3 py-2 flex flex-wrap items-center gap-2">
                      <Badge
                        variant="secondary"
                        className={r.id === open.survivorId ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}
                      >
                        {r.id === open.survivorId ? "Survives" : "Deleted"}
                      </Badge>
                      <span className="text-xs">#{r.id} {r.name || "(no name)"}</span>
                      {/* The address and its verdict, per row: in the LinkedIn
                          pass they are what one row keeps and the other loses. */}
                      <span className="text-xs text-muted-foreground truncate">
                        {r.email || "(no email)"}{r.emailStatus ? ` · ${r.emailStatus}` : " · no verdict"}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto shrink-0">
                        {r.contactLinkCount} linked contact{r.contactLinkCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Fields filled on the survivor</div>
                {open.fieldsFilled.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None — the survivor already holds a value for every field the others carry.</p>
                ) : (
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {open.fieldsFilled.map((f) => (
                      <li key={f.field}>{f.field} ← #{f.fromPersonId}</li>
                    ))}
                  </ul>
                )}
              </div>
              {open.discardedEmails.length ? (
                <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-amber-800 mb-1">
                    Addresses this merge drops
                  </div>
                  <ul className="text-xs text-amber-800 space-y-0.5">
                    {open.discardedEmails.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-amber-700 mt-1">
                    The survivor keeps its own address, so these stop existing in Velocity when their rows
                    are deleted. They are written to the audit log for this merge and kept nowhere else —
                    there is no second-address field on a person, and this merge does not invent one. Copy
                    one out now if you want it.
                  </p>
                </div>
              ) : null}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">References moved</div>
                {open.repoints.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None — nothing else points at the rows being deleted.</p>
                ) : (
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {open.repoints.map((r) => (
                      <li key={`${r.key}:${r.mode}`}>
                        {r.key} — {r.rows} row{r.rows === 1 ? "" : "s"}
                        {r.mode === "combine"
                          ? " · combined into one row, the duplicate deleted after its values are merged in"
                          : r.mode === "dedupe"
                          ? " · moved, or deleted where the survivor already holds an equivalent row"
                          : " · repointed at the survivor"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="text-xs text-rose-700">
                This permanently deletes {open.loserIds.length} People row{open.loserIds.length === 1 ? "" : "s"} and cannot be undone.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPreview(null)}>Cancel</Button>
            <ConfirmButton
              variant="destructive"
              size="sm"
              disabled={merge.isPending || !open}
              title="Delete these People rows?"
              description={
                open
                  ? `#${open.survivorId} survives. ${open.loserIds.map((id) => `#${id}`).join(", ")} are deleted for good, after everything pointing at them is repointed.${
                      open.discardedEmails.length
                        ? ` ${open.discardedEmails.join(", ")} goes with them — the audit log is the only place it will exist.`
                        : ""
                    }`
                  : undefined
              }
              confirmLabel="Merge and delete"
              // The ids go with the cluster key: the server merges this cluster
              // only if it still resolves to exactly the rows shown above, and
              // `by` says which key it is — an address, or a LinkedIn profile.
              onConfirm={() => {
                if (!open) return;
                if (open.by === "linkedin") merge.mutate({ by: "linkedin", clusters: [{ key: open.key, survivorId: open.survivorId, loserIds: open.loserIds }] });
                else if (open.email) merge.mutate({ clusters: [{ email: open.email, survivorId: open.survivorId, loserIds: open.loserIds }] });
              }}
            >
              {merge.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <GitMerge className="size-3.5 mr-1.5" />}
              Merge
            </ConfirmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/* ─── Main Page ─────────────────────────────────────────────────────────── */
function ProviderEffectivenessCard() {
  const { data, isLoading } = trpc.dataHealth.providerEffectiveness.useQuery();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Provider effectiveness</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">Loading…</div>
        ) : !data || data.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No provenance data yet — enrich prospects and each field's winning source lands here.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Which source holds the CURRENT value, across {data.prospectsWithLedger.toLocaleString()} prospects
              with provenance. A source that finds a lot but never wins is spending without earning.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Source</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Fields held</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Verified emails</th>
                    <th className="py-1.5 font-medium">Top fields</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sources.map((s) => (
                    <tr key={s.source} className="border-b border-border/50">
                      <td className="py-1.5 pr-2 font-medium">{s.source}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{s.total.toLocaleString()}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{s.verifiedEmails.toLocaleString()}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">
                        {Object.entries(s.fields).sort((a, b) => b[1] - a[1]).slice(0, 3)
                          .map(([f, n]) => `${f} (${n})`).join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DataHealth() {
  const utils = trpc.useUtils();
  const { data: metrics, isLoading: metricsLoading } = trpc.dataHealth.getMetrics.useQuery();
  const { data: dupes, isLoading: dupesLoading } = trpc.dataHealth.getDuplicateGroups.useQuery();
  // One payload feeds both the KPI card and the section below, so the count
  // and the list it sits above can never disagree.
  const splits = trpc.dataHealth.personContactDuplicates.useQuery();

  const [mergeGroup, setMergeGroup] = useState<DupeGroup | null>(null);
  // Merging deletes a contact, so it is an admin action (audit 2026-10-20, P9).
  const me = trpc.profile.getMe.useQuery();
  const canMerge = isAdminRole(me.data?.role);
  // The server gate for "Link all unlinked" (audit 2026-10-20, P93).
  const canLinkAll = rankOf(me.data?.role) >= ROLE_RANK.manager;

  /**
   * On demand, not on load: the audit replays every past import and scans up
   * to 50k rows per table. `enabled: false` means it runs only when the button
   * calls refetch().
   */
  const auditQuery = trpc.dataHealth.importMappingAudit.useQuery(undefined, {
    enabled: false,
    refetchOnWindowFocus: false,
  });
  const audit = auditQuery.data;

  const total = metrics?.total ?? 0;

  const accent = useAccentColor();
  return (
    <Shell title="Data Health">
      <PageHeader
        title="Data Health" pageKey="data-health"
        description="Monitor data quality across your entire CRM — surface duplicates, missing fields, and enrichment gaps. Run bulk fixes and enrichment jobs to keep your data clean and actionable."
        icon={<ShieldCheck className="size-5" />}
      >
        {/* Every card on the page, not only the first two (audit 2026-10-20,
            P158). The import audit stays on demand: invalidating a disabled
            query does not run it. */}
        <Button variant="outline" size="sm" onClick={() => { void utils.dataHealth.invalidate(); }}>
          <RefreshCw className="size-3.5 mr-1.5" />
          Refresh
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-8">
        {/* KPI Summary Row */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Overview
          </h2>
          {metricsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <MetricCard label="Total People" value={total} icon={Users} tone="default" />
              <MetricCard
                label="With Email"
                value={metrics?.withEmail ?? 0}
                pct={metrics?.pctWithEmail}
                icon={Mail}
                tone={(metrics?.pctWithEmail ?? 0) >= 80 ? "success" : (metrics?.pctWithEmail ?? 0) >= 50 ? "warning" : "danger"}
                fixHref="/v2/people?missingEmail=1"
                fixLabel="Fix Now"
              />
              <MetricCard
                label="With Phone"
                value={metrics?.withPhone ?? 0}
                pct={metrics?.pctWithPhone}
                icon={Phone}
                tone={(metrics?.pctWithPhone ?? 0) >= 60 ? "success" : (metrics?.pctWithPhone ?? 0) >= 30 ? "warning" : "danger"}
              />
              {/* Valid only: invalid, risky and accept-all addresses were
                  counted as verified, in green (audit 2026-10-20, P79). Each
                  verdict is in the breakdown below. */}
              <MetricCard
                label="Valid Emails"
                value={metrics?.verifiedValid ?? 0}
                pct={metrics?.pctVerified}
                icon={CheckCircle2}
                tone={(metrics?.pctVerified ?? 0) >= 80 ? "success" : (metrics?.pctVerified ?? 0) >= 40 ? "warning" : "danger"}
                fixHref="/v2/people?emailStatus=unknown"
                fixLabel="Verify Now"
              />
              <MetricCard
                label="Invalid Emails"
                value={metrics?.verifiedInvalid ?? 0}
                icon={XCircle}
                tone={(metrics?.verifiedInvalid ?? 0) === 0 ? "success" : "danger"}
                fixHref="/v2/people?emailStatus=invalid"
                fixLabel="View Invalid"
              />
              {/* "Duplicates" counted People and sat directly above a list of
                  duplicate CONTACTS, so merging from that list never moved the
                  number. Both now say which table they are about. */}
              {/* Groups the email merge below can act on (audit 2026-10-20,
                  P80); name + company groups, which nothing merges, are gone.
                  The LinkedIn pass counts its own groups in its section. */}
              <MetricCard
                label={metrics?.duplicatesCapped ? "Duplicate People (same email, first 2,000 groups)" : "Duplicate People (same email)"}
                value={metrics?.estimatedDuplicates ?? 0}
                icon={Copy}
                tone={(metrics?.estimatedDuplicates ?? 0) === 0 ? "success" : "warning"}
              />
              <MetricCard
                label={splits.data?.capped ? `Split People (first ${splits.data.scanned} scanned)` : "Split People & Contacts"}
                value={splits.data?.total ?? 0}
                icon={Split}
                tone={(splits.data?.total ?? 0) === 0 ? "success" : "warning"}
              />
            </div>
          )}
        </section>

        {/* Email Verification Breakdown */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Email Verification Breakdown
          </h2>
          {metricsLoading ? (
            <Skeleton className="h-24 rounded-xl" />
          ) : (
            <Card>
              <CardContent className="pt-5 pb-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {[
                    { label: "Valid", value: metrics?.verifiedValid ?? 0, color: "bg-emerald-500" },
                    { label: "Accept-All", value: metrics?.verifiedAcceptAll ?? 0, color: "bg-yellow-500" },
                    { label: "Risky", value: metrics?.verifiedRisky ?? 0, color: "bg-orange-500" },
                    { label: "Invalid", value: metrics?.verifiedInvalid ?? 0, color: "bg-rose-500" },
                    { label: "Not Verified", value: metrics?.verifiedUnknown ?? 0, color: "bg-gray-400" },
                  ].map((item) => {
                    const pct = total > 0 ? Math.round((item.value / total) * 100) : 0;
                    return (
                      <div key={item.label} className="text-center space-y-1">
                        <div className={`mx-auto size-2 rounded-full ${item.color}`} />
                        <div className="text-xl font-bold tabular-nums">{item.value.toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">{item.label}</div>
                        <div className="text-xs font-mono text-muted-foreground">{pct}%</div>
                      </div>
                    );
                  })}
                </div>
                {/* Stacked bar */}
                <div className="mt-4 h-3 rounded-full overflow-hidden flex">
                  {[
                    { value: metrics?.verifiedValid ?? 0, color: "bg-emerald-500" },
                    { value: metrics?.verifiedAcceptAll ?? 0, color: "bg-yellow-500" },
                    { value: metrics?.verifiedRisky ?? 0, color: "bg-orange-500" },
                    { value: metrics?.verifiedInvalid ?? 0, color: "bg-rose-500" },
                    { value: metrics?.verifiedUnknown ?? 0, color: "bg-gray-300" },
                  ].map((seg, i) => {
                    const pct = total > 0 ? (seg.value / total) * 100 : 0;
                    return pct > 0 ? (
                      <div key={i} className={`${seg.color} h-full`} style={{ width: `${pct}%` }} />
                    ) : null;
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </section>

        {/* Field Coverage */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Field Coverage
          </h2>
          {metricsLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : (
            <Card>
              <CardContent className="pt-5 pb-4 space-y-3">
                <FieldCoverageBar label="Email" pct={metrics?.pctWithEmail ?? 0} />
                <FieldCoverageBar label="Phone" pct={metrics?.pctWithPhone ?? 0} />
                <FieldCoverageBar label="Account" pct={total > 0 ? Math.round(((metrics?.withCompany ?? 0) / total) * 100) : 0} />
                <FieldCoverageBar label="Title" pct={total > 0 ? Math.round(((metrics?.withTitle ?? 0) / total) * 100) : 0} />
                <FieldCoverageBar label="LinkedIn URL" pct={total > 0 ? Math.round(((metrics?.withLinkedIn ?? 0) / total) * 100) : 0} />
                <FieldCoverageBar label="Enriched (90d)" pct={metrics?.pctEnriched ?? 0} />
              </CardContent>
            </Card>
          )}
        </section>

        {/* Duplicate contacts. These rows are `contacts`, and merging one has
            never moved the KPI card above — which counts People. The heading
            and that card now name their tables instead of both saying
            "Duplicates" (2026-09-20). */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Duplicate contacts
          </h2>
          {dupesLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : !dupes || dupes.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground text-sm">
                <CheckCircle2 className="size-8 mx-auto mb-2 text-emerald-500" />
                No duplicate contacts detected.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Top Duplicate Groups ({dupes.length} found)
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Contacts are no longer merged here. Link each contact to its People record (Split People, below),
                  then merge the duplicate People: one merge keeps every field and repoints everything that refers to them.
                </p>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="divide-y">
                  {dupes.map((group, i) => (
                    <div key={i} className="py-3 flex items-start gap-3">
                      <Badge
                        variant="secondary"
                        className={`shrink-0 mt-0.5 ${
                          group.type === "email"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-purple-100 text-purple-700"
                        }`}
                      >
                        {group.type === "email" ? "Email" : "Name"}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{group.key}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {group.count} records: {group.names.slice(0, 3).join(", ")}
                          {group.names.length > 3 ? ` +${group.names.length - 3} more` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline">{group.count}×</Badge>
                        {/* The contact merge is retired for the People merge
                            (audit 2026-10-20, F43): contacts are no longer the
                            record, so the fix is to link each to its person
                            (Split People below) and merge the People. The
                            dialog and dataHealth.mergeContacts stay, so this
                            button can come back in one line. */}
                        <a href="#people-merge" className="inline-flex items-center h-7 text-xs px-2 rounded-md border hover:bg-muted">
                          <GitMerge className="size-3 mr-1" aria-hidden="true" />
                          Merge the People
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </section>

        <SplitPeopleSection canLinkAll={canLinkAll} />

        <div id="people-merge" className="scroll-mt-4" />
        <PeopleMergeSection />

        {/* The same merge, keyed on the LinkedIn profile instead of the address
            — the duplicates the email pass cannot see, because enrichment
            guessed two address patterns for one human. */}
        <PeopleMergeSection by="linkedin" />

        {/* ── Import mapping audit ──
            Read-only, and run on demand rather than on page load: it replays
            every past import's stored column mapping and scans up to 50k rows
            per table, which is not work to do on every visit. */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            CSV Import Mapping Audit
          </h2>
          <Card>
            <CardContent className="pt-5 pb-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm text-muted-foreground">
                  Until August 2026 the importer matched CSV columns to fields by name similarity,
                  which could file a company website under the company <em>name</em> or let two
                  columns claim one field. This replays every past import’s stored mapping and
                  reports what it finds. It only reads — nothing is changed.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void auditQuery.refetch()}
                  disabled={auditQuery.isFetching}
                >
                  {auditQuery.isFetching
                    ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                    : <ShieldCheck className="size-3.5 mr-1.5" />}
                  {auditQuery.isFetching ? "Checking…" : "Run audit"}
                </Button>
              </div>

              {audit && (
                <div className="space-y-4">
                  {audit.clean ? (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="size-4 text-emerald-600" />
                      <span>
                        No past import stored a mapping with the defect
                        {" "}({audit.importsChecked} checked).
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm">
                        <AlertTriangle className="size-4 text-amber-600" />
                        <span>
                          <strong>{audit.affectedImports.length}</strong> of {audit.importsChecked}{" "}
                          imports used a mapping with the defect.
                        </span>
                      </div>
                      <div className="rounded-lg border divide-y">
                        {audit.affectedImports.map((imp) => (
                          <div key={imp.importId} className="p-3 space-y-1.5">
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="text-sm font-medium truncate">{imp.filename}</span>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {imp.completedAt ? new Date(imp.completedAt).toLocaleDateString() : "incomplete"}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {imp.rowsImported.toLocaleString()} rows imported ·{" "}
                              {(imp.contactsStillPresent + imp.prospectsStillPresent).toLocaleString()} still present
                            </p>
                            {imp.suspectAssignments.map((s) => (
                              <p key={s.header} className="text-xs">
                                <span className="font-mono">{s.header}</span> was filed as{" "}
                                <strong>{s.storedField}</strong>
                                {s.correctField ? <> — belongs in <strong>{s.correctField}</strong></> : <> — belongs nowhere</>}
                              </p>
                            ))}
                            {imp.duplicateClaims.map((d) => (
                              <p key={d.field} className="text-xs">
                                {d.headers.map((h) => `"${h}"`).join(" and ")} both claimed{" "}
                                <strong>{d.label}</strong> — only{" "}
                                <span className="font-mono">{d.keptHeader}</span> was kept.
                              </p>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-xs font-medium mb-1.5">Rows that still look wrong today</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      {[
                        ["Company name is a URL", audit.residue.contactsCompanyNameIsUrl + audit.residue.prospectsCompanyIsUrl],
                        ["…possibly a URL", audit.residue.contactsCompanyNameMaybeUrl + audit.residue.prospectsCompanyMaybeUrl],
                        ["LinkedIn is a company page", audit.residue.contactsLinkedInIsCompanyPage + audit.residue.prospectsLinkedInIsCompanyPage],
                        ["Email is a verdict", audit.residue.contactsEmailIsVerdict + audit.residue.prospectsEmailIsVerdict],
                      ].map(([label, n]) => (
                        <div key={label as string} className="rounded-lg border p-2">
                          <div className="text-lg font-semibold">{(n as number).toLocaleString()}</div>
                          <div className="text-muted-foreground">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {audit.notes.length > 0 && (
                    <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                      {audit.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Provider effectiveness (roadmap P4.1) — which enrichment source
            actually holds the winning values, straight from the ledger. */}
        <section>
          <ProviderEffectivenessCard />
        </section>
      </div>

      {mergeGroup && (
        <MergeDialog
          group={mergeGroup}
          open={!!mergeGroup}
          onClose={() => setMergeGroup(null)}
          onMerged={() => { void utils.dataHealth.invalidate(); }}
        />
      )}
    </Shell>
  );
}
