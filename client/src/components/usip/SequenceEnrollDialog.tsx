/**
 * The bulk enrol picker: Contacts / Leads / Prospects tabs, each searched and
 * paged on the server, with multi-select (audit 2026-10-20, O40).
 *
 * Moved here from the legacy /sequences page on 2026-11-07 (U14, one sequence
 * editor) so the v2 editor's "Add contacts" opens it. The code is the legacy
 * dialog's, unchanged: enrolling goes through `sequences.bulkEnroll`, which
 * screens duplicates, invalid emails, suppressions and Revenue Engine overlap,
 * and holds new enrolments while the sequence is paused or a draft.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { pressable } from "@/lib/pressable";
import { tablistProps, tabProps } from "@/lib/tabs";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Prospects the enrol dialog shows a page; the server searches and counts all of them. */
const ENROLL_PROSPECTS_PER_PAGE = 50;

/**
 * Picker for bulk-enrolling contacts and/or leads into a sequence.
 * Two tabs (Contacts, Leads), each with a search box and multi-select
 * checkboxes. The "Enroll N selected" CTA submits one bulkEnroll
 * mutation per dialog confirm — server handles dedup + invalid-email
 * gating and returns granular counts that flow into the toast.
 */
export function SequenceEnrollDialog({ sequenceId, open, onClose, onEnrolled }: {
  sequenceId: number;
  open: boolean;
  onClose: () => void;
  onEnrolled?: () => void;
}) {
  const [tab, setTab] = useState<"contacts" | "leads" | "prospects">("contacts");
  const [search, setSearch] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<number>>(new Set());
  const [selectedProspectIds, setSelectedProspectIds] = useState<Set<number>>(new Set());

  // Reset on every fresh open.
  useEffect(() => {
    if (open) {
      setTab("contacts");
      setSearch("");
      setSelectedContactIds(new Set());
      setSelectedLeadIds(new Set());
      setSelectedProspectIds(new Set());
    }
  }, [open]);

  /**
   * Searched and paged ON THE SERVER (audit 2026-10-20, O40). This loaded the
   * first 200 prospects and searched them in the browser, so anyone past the
   * 200th could not be found at all. Contacts and leads take the server's
   * `search` too; prospects come a page at a time with the total.
   *
   * Important: don't gate these on `enabled: open` — that pattern was
   * returning empty data on first dialog open in some cases.
   */
  const debounced = useDebouncedValue(search.trim());
  const [prospectPage, setProspectPage] = useState(1);
  useEffect(() => { setProspectPage(1); }, [debounced]);
  const contactsQ = trpc.contacts.list.useQuery({ search: debounced || undefined });
  const leadsQ = trpc.leads.list.useQuery({ search: debounced || undefined });
  // Prospects: every non-rejected one. No verificationStatus filter, so
  // CSV-imported rows (NULL status) are included alongside Discovery v2's
  // verified/needs_review rows; rejected ones are dropped below. The
  // engine's per-message suppression check handles outright-bad addresses.
  const prospectsAllQ = trpc.prospects.list.useQuery({ page: prospectPage, perPage: ENROLL_PROSPECTS_PER_PAGE, search: debounced || undefined });
  const prospectTotal = Number((prospectsAllQ.data as any)?.total ?? 0);
  const prospectPages = Math.max(1, Math.ceil(prospectTotal / ENROLL_PROSPECTS_PER_PAGE));

  // Already enrolled in this sequence — show a disabled checkbox + "already enrolled" label.
  const { data: existingEnrollments = [] } = trpc.sequences.listEnrollments.useQuery({ sequenceId }, { enabled: open });
  const alreadyContactIds = new Set<number>();
  const alreadyLeadIds = new Set<number>();
  const alreadyProspectIds = new Set<number>();
  for (const e of existingEnrollments as any[]) {
    if (e.status === "exited") continue;
    if (e.contactId) alreadyContactIds.add(e.contactId);
    if (e.leadId) alreadyLeadIds.add(e.leadId);
    // Most enrolments are prospect enrolments; this id was never read, so
    // the people already in the sequence looked selectable (O40).
    if (e.prospectId) alreadyProspectIds.add(e.prospectId);
  }

  const filteredContacts = (contactsQ.data ?? []) as any[];
  const filteredLeads = (leadsQ.data ?? []) as any[];
  // prospects.list returns { data, total, page, perPage }. Drop only
  // rejected (soft-archived) rows; keep verified, needs_review, AND
  // NULL-status rows (the CSV-import path doesn't set verificationStatus).
  const prospectsCombined: any[] = (((prospectsAllQ.data as any)?.data ?? []) as any[])
    .filter((p) => p.verificationStatus !== "rejected");
  const filteredProspects = prospectsCombined;

  const utils = trpc.useUtils();
  const bulkEnroll = trpc.sequences.bulkEnroll.useMutation({
    onSuccess: (r) => {
      // Every enrolment-derived read, wherever this dialog is opened from.
      invalidateEnrollmentReads(utils, sequenceId);
      const parts = [`Enrolled ${r.enrolled}`];
      if (r.skippedAlreadyEnrolled > 0) parts.push(`${r.skippedAlreadyEnrolled} already enrolled`);
      if (r.blockedInvalidEmail > 0) parts.push(`${r.blockedInvalidEmail} blocked (invalid email)`);
      if (r.skippedSuppressed > 0) parts.push(`${r.skippedSuppressed} skipped (suppressed)`);
      if (r.skippedInCampaign > 0) parts.push(`${r.skippedInCampaign} skipped (in a Revenue Engine campaign)`);
      toast.success(parts.join(" · "));
      // A paused or draft sequence holds new enrolments (audit 2026-10-20, O1).
      if (r.enrolled > 0 && r.heldUntilActive) toast.info("This sequence is not active — nothing is sent until it is activated");
      onEnrolled?.();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const totalSelected = selectedContactIds.size + selectedLeadIds.size + selectedProspectIds.size;

  /** A prospect is "already enrolled" by its own enrolment, or through the contact it is linked to. */
  function isProspectAlreadyEnrolled(p: any): boolean {
    return alreadyProspectIds.has(p.id) || (typeof p.linkedContactId === "number" && alreadyContactIds.has(p.linkedContactId));
  }

  function toggleContact(id: number) {
    if (alreadyContactIds.has(id)) return;
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleLead(id: number) {
    if (alreadyLeadIds.has(id)) return;
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleProspect(p: any) {
    if (isProspectAlreadyEnrolled(p)) return;
    setSelectedProspectIds((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
      return next;
    });
  }
  function selectAllVisible() {
    if (tab === "contacts") {
      setSelectedContactIds((prev) => {
        const next = new Set(prev);
        for (const c of filteredContacts) if (!alreadyContactIds.has(c.id)) next.add(c.id);
        return next;
      });
    } else if (tab === "leads") {
      setSelectedLeadIds((prev) => {
        const next = new Set(prev);
        for (const l of filteredLeads) if (!alreadyLeadIds.has(l.id)) next.add(l.id);
        return next;
      });
    } else {
      setSelectedProspectIds((prev) => {
        const next = new Set(prev);
        for (const p of filteredProspects) if (!isProspectAlreadyEnrolled(p)) next.add(p.id);
        return next;
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      {/* sm:max-w-* (not bare max-w-*): DialogContent's default className ends
          with sm:max-w-lg which wins at ≥640px and squeezes the dialog. */}
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Enroll prospects into sequence</DialogTitle>
        </DialogHeader>

        <div {...tablistProps("Recipients")} className="flex border-b shrink-0">
          {([
            { k: "contacts", label: "Contacts", count: filteredContacts.length },
            { k: "leads", label: "Leads", count: filteredLeads.length },
            { k: "prospects", label: "Prospects", count: prospectTotal },
          ] as const).map((t) => (
            <button {...tabProps(tab === t.k)} key={t.k} onClick={() => setTab(t.k)}
              className={`px-4 py-2 text-sm ${tab === t.k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
              {t.label} <span className="text-xs text-muted-foreground">({t.count})</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-3 shrink-0">
          <Input aria-label={`Search ${tab}`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${tab}…`}
            className="h-8 text-sm"
          />
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={selectAllVisible}>
            Select all visible
          </Button>
        </div>

        {tab === "prospects" && (
          <p className="text-[11px] text-muted-foreground mt-2 px-1">
            Prospects are enrolled as-is — no auto-promotion to contacts. Shows
            verified + needs-review prospects from your workspace; status appears
            as a per-row badge. Prospects without an email are not selectable.
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto border rounded-md mt-2">
          {tab === "contacts" ? (
            contactsQ.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading contacts…</div>
            ) : contactsQ.error ? (
              <div className="p-4 text-sm text-destructive">Couldn't load contacts: {contactsQ.error.message}</div>
            ) : filteredContacts.length === 0 && !debounced ? (
              <div className="p-4 text-sm text-muted-foreground">No contacts in this workspace yet.</div>
            ) : filteredContacts.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No contacts match your search.</div>
            ) : (
              <ul className="divide-y">
                {filteredContacts.map((c: any) => {
                  const already = alreadyContactIds.has(c.id);
                  const checked = selectedContactIds.has(c.id);
                  return (
                    <li key={c.id} className={`flex items-center gap-3 p-2.5 text-sm ${already ? "opacity-50" : "hover:bg-muted/40 cursor-pointer"}`} {...pressable(() => toggleContact(c.id))}>
                      <input aria-label={`Select ${c.firstName} ${c.lastName}`}
                        type="checkbox"
                        checked={checked || already}
                        disabled={already}
                        onChange={() => toggleContact(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-gray-300 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{c.firstName} {c.lastName}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {c.email ?? "(no email)"}{c.title ? ` · ${c.title}` : ""}{(c as any).accountName ? ` · ${(c as any).accountName}` : ""}
                        </div>
                      </div>
                      {already && <span className="text-[10px] text-muted-foreground shrink-0">already enrolled</span>}
                    </li>
                  );
                })}
              </ul>
            )
          ) : tab === "leads" ? (
            leadsQ.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading leads…</div>
            ) : leadsQ.error ? (
              <div className="p-4 text-sm text-destructive">Couldn't load leads: {leadsQ.error.message}</div>
            ) : filteredLeads.length === 0 && !debounced ? (
              <div className="p-4 text-sm text-muted-foreground">No leads in this workspace yet.</div>
            ) : filteredLeads.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No leads match your search.</div>
            ) : (
              <ul className="divide-y">
                {filteredLeads.map((l: any) => {
                  const already = alreadyLeadIds.has(l.id);
                  const checked = selectedLeadIds.has(l.id);
                  return (
                    <li key={l.id} className={`flex items-center gap-3 p-2.5 text-sm ${already ? "opacity-50" : "hover:bg-muted/40 cursor-pointer"}`} {...pressable(() => toggleLead(l.id))}>
                      <input aria-label={`Select ${l.firstName} ${l.lastName}`}
                        type="checkbox"
                        checked={checked || already}
                        disabled={already}
                        onChange={() => toggleLead(l.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-gray-300 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{l.firstName} {l.lastName}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {l.email ?? "(no email)"}{l.title ? ` · ${l.title}` : ""}{l.company ? ` · ${l.company}` : ""}
                        </div>
                      </div>
                      {already && <span className="text-[10px] text-muted-foreground shrink-0">already enrolled</span>}
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            prospectsAllQ.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading prospects…</div>
            ) : prospectsAllQ.error ? (
              <div className="p-4 text-sm text-destructive">
                Couldn't load prospects: {prospectsAllQ.error.message}
              </div>
            ) : prospectsCombined.length === 0 && !debounced && prospectPage === 1 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No prospects in this workspace yet. Run discovery from <strong>Find Prospects</strong> or an ARE campaign first.
              </div>
            ) : filteredProspects.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No prospects match your search.</div>
            ) : (
              <ul className="divide-y">
                {filteredProspects.map((p: any) => {
                  const already = isProspectAlreadyEnrolled(p);
                  const noEmail = !p.email;
                  const disabled = already || noEmail;
                  const checked = selectedProspectIds.has(p.id);
                  const company = p.companyName ?? p.company ?? "";
                  const status = p.verificationStatus as string | undefined;
                  return (
                    <li key={p.id} className={`flex items-center gap-3 p-2.5 text-sm ${disabled ? "opacity-50" : "hover:bg-muted/40 cursor-pointer"}`} {...pressable(() => !disabled && toggleProspect(p))}>
                      <input aria-label={`Select ${p.firstName} ${p.lastName}`}
                        type="checkbox"
                        checked={checked || already}
                        disabled={disabled}
                        onChange={() => !disabled && toggleProspect(p)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-gray-300 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate flex items-center gap-1.5">
                          {p.firstName} {p.lastName}
                          {status === "needs_review" && (
                            <span className="text-[9px] px-1 py-0 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                              needs review
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {p.email ?? "(no email)"}{p.title ? ` · ${p.title}` : ""}{company ? ` · ${company}` : ""}
                        </div>
                      </div>
                      {already && <span className="text-[10px] text-muted-foreground shrink-0">already enrolled</span>}
                      {!already && noEmail && <span className="text-[10px] text-muted-foreground shrink-0">no email</span>}
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </div>

        {tab === "prospects" && prospectTotal > ENROLL_PROSPECTS_PER_PAGE && (
          <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground shrink-0">
            <span className="mr-auto">
              {(prospectPage - 1) * ENROLL_PROSPECTS_PER_PAGE + 1}–{Math.min(prospectPage * ENROLL_PROSPECTS_PER_PAGE, prospectTotal)} of {prospectTotal.toLocaleString()}
              {" "}— search to narrow it down; your selection is kept across pages.
            </span>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={prospectPage <= 1} onClick={() => setProspectPage((n) => n - 1)}>Previous</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={prospectPage >= prospectPages} onClick={() => setProspectPage((n) => n + 1)}>Next</Button>
          </div>
        )}

        <DialogFooter className="shrink-0 pt-2 border-t">
          <span className="text-xs text-muted-foreground self-center mr-auto">
            {totalSelected} selected
          </span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={totalSelected === 0 || bulkEnroll.isPending}
            onClick={() => bulkEnroll.mutate({
              sequenceId,
              contactIds: Array.from(selectedContactIds),
              leadIds: Array.from(selectedLeadIds),
              prospectIds: Array.from(selectedProspectIds),
            })}
          >
            {bulkEnroll.isPending ? "Enrolling…" : `Enroll ${totalSelected}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
