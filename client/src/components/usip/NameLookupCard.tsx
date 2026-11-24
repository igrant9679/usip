/**
 * NameLookupCard — find one person by name, or a company and the people who
 * work there (owner, 2026-11-24: "give me the ability to search for a company
 * (retrieving employees) and search for a name of a person in the Data
 * Enrichment screen and in the People page", and "if the person or company
 * isn't found I should be prompted to allow the app to get it from a
 * prospecting source").
 *
 * Find prospects searched by ROLE (job title, seniority, industry); there was
 * nowhere on that screen, or on People, to type who you are looking for.
 *
 * Two steps, and the second is asked for, never taken:
 *   1. Search looks in this workspace's own records (search.records).
 *   2. When nobody matches, the card ASKS: "Look it up in your prospect
 *      sources?" Only that press sends search.lookup, which asks LinkedIn (a
 *      person's name) and the connected databases' free previews. When there
 *      are matches the same button is offered underneath, for more.
 * Each row that comes back can be saved as a record, one at a time or several
 * ticked at once. A row from a source that sells its rows says what it
 * spends, and a save that spends anything is confirmed first with the total.
 *
 * The same endpoints as the Search box (CommandPalette); this is the long
 * form of it, asking for LOOKUP_MAX rows so a company comes back as a list.
 */
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Building2, Loader2, Search, User, UserSearch } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { invalidatePeopleReads } from "@/lib/entityCache";
import { confirmAction } from "@/components/usip/Common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { hitDetail, parseRecordSearch, type RecordHit } from "@shared/recordSearch";
import {
  LOOKUP_MAX, LOOKUP_RESUMES, lookupKindsFor, lookupSaveCost, mergeLookup, orderByMiddleName, outsideCompanyDetail, outsidePersonDetail, personQuery, planLookup, saveLabel,
  type LookupKind, type LookupSave, type OutsideLookupResult, type OutsidePerson,
} from "@shared/recordLookup";

type Outside = { q: string; kind: LookupKind; status: "looking" | "done" | "failed"; data?: OutsideLookupResult; error?: string };

export function NameLookupCard({ variant = "card" }: { variant?: "card" | "bare" }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<LookupKind>("person");
  /** A company's name or domain. */
  const [text, setText] = useState("");
  /** A person, field by field (owner: "first name, last name, middle name search option", "and/or company"). */
  const [first, setFirst] = useState("");
  const [middle, setMiddle] = useState("");
  const [last, setLast] = useState("");
  const [company, setCompany] = useState("");
  /** The middle name Search was pressed with. It orders the rows; it is never searched for. */
  const [askedMiddle, setAskedMiddle] = useState("");
  /** What Search was last pressed for. Typing alone searches nothing. */
  const [asked, setAsked] = useState("");
  const [outside, setOutside] = useState<Outside | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** Rows saved in this sitting: ref → where the record now is. */
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const q = parseRecordSearch(asked);
  // An email address or a domain is only ever a company (no source finds a person from an address).
  const kinds = q ? lookupKindsFor(q) : (["person", "company"] as LookupKind[]);
  const effective: LookupKind = kinds.indexOf(kind) === -1 ? kinds[0] : kind;
  const plan = q ? planLookup(q, effective) : null;

  const records = trpc.search.records.useQuery(
    { q: q?.text ?? "" },
    { enabled: !!q, staleTime: 30_000, retry: false },
  );
  const createFromLookup = trpc.search.createFromLookup.useMutation({
    onError: (e) => toast.error(e.message || "The record could not be saved."),
  });

  // What is on file for the kind asked: a person's own matches, or a company and the people there.
  const local: RecordHit[] = !records.data ? []
    : effective === "person" ? orderByMiddleName([...records.data.people, ...records.data.leads], askedMiddle)
    : [...records.data.companies, ...records.data.people];
  const found = outside && q && outside.q === q.text && outside.kind === effective ? outside : null;

  const search = () => {
    seq.current += 1;
    setOutside(null); setPicked(new Set()); setSaved({});
    // A person is searched for by first and last name and, when given, company: every word must match.
    // The middle name is kept aside: no record carries one, so it only orders what comes back.
    setAsked(kind === "person" ? personQuery({ first, last, company }) : text);
    setAskedMiddle(kind === "person" ? middle : "");
  };

  /** Ask the prospect sources. Only ever from the button that asks permission to. */
  const lookUp = async () => {
    if (!q) return;
    const mine = ++seq.current;
    const current = () => mine === seq.current;
    const args = { q: q.text, kind: effective, limit: LOOKUP_MAX };
    setPicked(new Set());
    setOutside({ q: q.text, kind: effective, status: "looking" });
    try {
      // Asked again within a minute, the same lookup is answered from memory: not a second LinkedIn search.
      let r = await utils.search.lookup.fetch(args, { staleTime: 60_000 });
      let all = r;
      for (let i = 0; r.pending && i < LOOKUP_RESUMES && current(); i++) {
        setOutside({ q: q.text, kind: effective, status: "looking", data: all });
        r = await utils.search.lookup.fetch({ ...args, runId: r.pending.runId }, { staleTime: 0 });
        all = mergeLookup(all, r);
      }
      if (current()) setOutside({ q: q.text, kind: effective, status: "done", data: all });
    } catch (e) {
      if (current()) setOutside({ q: q.text, kind: effective, status: "failed", error: (e as Error)?.message || "The lookup could not be run." });
    }
  };

  const people = orderByMiddleName(found?.data?.people ?? [], askedMiddle);
  const hrefOf = (p: { ref: string; already: { href: string } | null }) => saved[p.ref] ?? p.already?.href ?? null;
  const fresh = people.filter((p) => !hrefOf(p));
  const chosen = fresh.filter((p) => picked.has(p.ref));

  /** Save rows one after another, so one refusal does not lose the rest. */
  const saveRows = async (rows: Array<{ ref: string; save: LookupSave }>, openAfter: boolean) => {
    if (saving || rows.length === 0) return;
    setSaving(true);
    let made = 0, failed = 0, spent = 0;
    let last: string | null = null;
    for (const row of rows) {
      try {
        const r = await createFromLookup.mutateAsync({ save: row.save });
        made += 1; spent += r.unitsSpent; last = r.href;
        setSaved((s) => ({ ...s, [row.ref]: r.href }));
        setPicked((s) => { const n = new Set(s); n.delete(row.ref); return n; });
      } catch {
        failed += 1; // said by the mutation's own onError
      }
    }
    setSaving(false);
    void utils.search.records.invalidate();
    void invalidatePeopleReads(utils);
    if (made > 0) toast.success(`Saved ${made} ${made === 1 ? "record" : "records"}${spent ? `, using ${spent} ${spent === 1 ? "credit" : "credits"}` : ""}${failed ? `. ${failed} could not be saved.` : "."}`);
    if (openAfter && made === 1 && last) navigate(last);
  };

  /** A save that spends anything is confirmed first, with the total. */
  const askThenSave = (rows: OutsidePerson[], openAfter: boolean) => {
    const cost = lookupSaveCost(rows);
    const go = () => void saveRows(rows, openAfter);
    if (cost.total === 0) return go();
    confirmAction({
      title: `Create ${rows.length} ${rows.length === 1 ? "record" : "records"}?`,
      description: `This spends ${cost.text}. Rows from LinkedIn, Apollo and QuickEnrich are free.`,
      confirmLabel: `Create and spend ${cost.total}`,
    }, go);
  };

  const body = (
    <div className="space-y-3" data-name-lookup>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <div role="radiogroup" aria-label="What to look for" className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5">
          {(["person", "company"] as LookupKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setOutside(null); setPicked(new Set()); }}
              className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px]", kind === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>
              {k === "person" ? <User className="size-3.5" /> : <Building2 className="size-3.5" />} {k === "person" ? "Person" : "Company"}
            </button>
          ))}
        </div>
        {kind === "person" ? (
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-name-lookup-person-fields>
            <Input aria-label="First name" placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} data-name-lookup-first />
            <Input aria-label="Middle name (optional)" placeholder="Middle name (optional)" value={middle} onChange={(e) => setMiddle(e.target.value)} data-name-lookup-middle />
            <Input aria-label="Last name" placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} data-name-lookup-last />
            <Input aria-label="Company (optional)" placeholder="Company (optional)" value={company} onChange={(e) => setCompany(e.target.value)} data-name-lookup-company />
          </div>
        ) : (
          <Input
            aria-label="Company name or domain" className="min-w-[220px] flex-1"
            value={text} onChange={(e) => setText(e.target.value)} data-name-lookup-input
            placeholder="Company name, or its domain (acme.org)"
          />
        )}
        <Button type="submit" size="sm" className="gap-1.5" disabled={(kind === "person" ? personQuery({ first, last }) : text.trim()).length < 2}>
          <Search className="size-3.5" /> Search
        </Button>
      </form>
      {kind === "person" && middle.trim() ? (
        <p className="text-[12px] text-muted-foreground" data-name-lookup-middle-note>
          Records hold a first and a last name only, so the middle name rules nobody out: a match that carries it is listed first.
        </p>
      ) : null}

      {q && kind === "person" && effective === "company" ? (
        <p className="text-[12px] text-muted-foreground">No source finds a person from an email address or a domain, so this looks for the company at {plan?.subject}.</p>
      ) : null}

      {q && records.isFetching ? (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Searching your records…</div>
      ) : null}
      {q && records.isError ? <p className="text-[12.5px] text-rose-700 dark:text-rose-300">Your records could not be searched. Try again.</p> : null}

      {/* 1. What is already in the workspace. */}
      {q && records.data && local.length > 0 ? (
        <div className="space-y-1" data-name-lookup-local>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">In your records</div>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
            {local.map((h) => (
              <li key={`${h.kind}-${h.id}`} className="flex items-center gap-3 px-3 py-2">
                {h.kind === "company" ? <Building2 className="size-4 shrink-0 text-muted-foreground" /> : <User className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{h.name}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{hitDetail(h)}</span>
                </span>
                <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => navigate(h.href)}>Open</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 2. Not found (or not enough): ASK before going outside. */}
      {q && records.data && !records.isFetching && plan && found?.status !== "looking" && !found?.data ? (
        <div className={cn("rounded-lg border p-3", local.length === 0 ? "border-primary/40 bg-primary/5" : "border-border/70 bg-muted/30")} data-name-lookup-ask>
          <p className="text-[13px]">
            {local.length === 0
              ? <>No {effective === "person" ? "person" : "company"} in this workspace matches <span className="font-medium">“{plan.subject}”</span>. Look {effective === "person" ? "them" : "it"} up in your prospect sources?</>
              : effective === "person" ? "Not the one? Look in your prospect sources." : "Want more of the people who work there? Look in your prospect sources."}
          </p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {effective === "person" ? "Asks LinkedIn and your prospect databases." : "Asks your prospect databases for the company and the people there."} Looking is free. Nothing is saved until you choose a row, and a row that spends credits says so first.
          </p>
          <Button size="sm" className="mt-2 gap-1.5" onClick={() => void lookUp()} data-name-lookup-go>
            <UserSearch className="size-3.5" /> Look up in prospect sources
          </Button>
        </div>
      ) : null}

      {found?.status === "looking" ? (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-name-lookup-state="looking"><Loader2 className="size-3.5 animate-spin" /> Asking your prospect sources…</div>
      ) : null}
      {found?.status === "failed" ? <p className="text-[12.5px] text-rose-700 dark:text-rose-300" data-name-lookup-state="failed">{found.error}</p> : null}

      {/* 3. What the sources found. */}
      {found?.data ? (
        <div className="space-y-2" data-name-lookup-found>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            From your prospect sources{found.data.searched.length ? ` · ${found.data.searched.join(", ")}` : ""}
          </div>

          {found.data.companies.length > 0 ? (
            <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
              {found.data.companies.map((c) => {
                const href = hrefOf(c);
                return (
                  <li key={c.ref} className="flex items-center gap-3 px-3 py-2" data-outside-row="company">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{c.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">{c.typed ? "As typed, with no details yet" : outsideCompanyDetail(c)}</span>
                    </span>
                    {href
                      ? <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => navigate(href)}>In Companies · open</Button>
                      : <Button size="sm" className="h-7 shrink-0" disabled={saving} onClick={() => void saveRows([c], true)}>Create company</Button>}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {people.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-muted-foreground">
                  {people.length} {people.length === 1 ? "person" : "people"}{effective === "company" ? " who work there" : ""}{fresh.length < people.length ? `, ${people.length - fresh.length} already in People` : ""}
                </span>
                <span className="flex-1" />
                {fresh.length > 1 ? (
                  <Button variant="ghost" size="sm" className="h-7" disabled={saving}
                    onClick={() => setPicked(chosen.length === fresh.length ? new Set() : new Set(fresh.map((p) => p.ref)))}>
                    {chosen.length === fresh.length ? "Clear selection" : "Select all new"}
                  </Button>
                ) : null}
                {chosen.length > 0 ? (
                  <Button size="sm" className="h-7 gap-1.5" disabled={saving} onClick={() => askThenSave(chosen, false)} data-name-lookup-save-selected>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Create {chosen.length} {chosen.length === 1 ? "record" : "records"}{lookupSaveCost(chosen).total ? ` · ${lookupSaveCost(chosen).text}` : ""}
                  </Button>
                ) : null}
              </div>
              <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
                {people.map((p) => {
                  const href = hrefOf(p);
                  return (
                    <li key={p.ref} className="flex items-center gap-3 px-3 py-2" data-outside-row="person">
                      <Checkbox aria-label={`Select ${p.name}`} checked={picked.has(p.ref)} disabled={!!href || saving}
                        onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(p.ref); else n.delete(p.ref); return n; })} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{p.name}</span>
                        <span className="block truncate text-[12px] text-muted-foreground">{outsidePersonDetail(p)}</span>
                      </span>
                      {href
                        ? <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => navigate(href)}>In People · open</Button>
                        : <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={saving} onClick={() => askThenSave([p], true)}>{saveLabel(p)}</Button>}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {found.status === "done" && people.length === 0 && found.data.companies.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground" data-name-lookup-state="none">
              Nothing came back for “{found.data.subject}”{found.data.searched.length ? ` from ${found.data.searched.join(", ")}` : ""}.
            </p>
          ) : null}
          {found.data.notes.length > 0 ? (
            <div className="text-[12px] text-muted-foreground">{found.data.notes.map((n) => <p key={n} className="py-0.5">{n}</p>)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (variant === "bare") return body;
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-3" data-name-lookup-card>
      <div className="flex items-start gap-2.5">
        <UserSearch className="size-4 mt-0.5 shrink-0 text-violet-500" />
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold">Find a person or a company by name</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Type who you are looking for. Your own records are searched first; if they are not there, you are asked before your prospect sources are. A company comes back with the people who work there.
          </p>
        </div>
      </div>
      {body}
    </section>
  );
}
