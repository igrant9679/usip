/**
 * recordLookup.ts — look a person or a company up OUTSIDE the workspace, and
 * save what was found as a record (owner, 2026-11-23: "if the search doesn't
 * find the person or company then the app should go out to the prospect
 * sources to get the info, and offer to create a record in the system").
 *
 * The Search box (CommandPalette) offers this when its own read
 * (services/recordSearch.ts) finds nobody, and Elsie has the same two doors
 * (search.lookup, search.createFromLookup).
 *
 * It builds nothing new underneath. Every vendor call goes through the door
 * the rest of the app uses, so the same keys, caps, pauses and duplicate
 * rules apply:
 *   · LinkedIn      searchLinkedInProfiles: the caller's own account (the
 *                   whole pool for an admin), the account's activity gate,
 *                   its daily search cap, and the usage meter;
 *   · the databases startRun with `only: null`: connected, enabled sources
 *                   whose preview is FREE. A source that bills its previews
 *                   is never asked from here;
 *   · saving        people go through the Find prospects consolidation
 *                   (saveFindsAsPeople / promoteResults), companies through
 *                   the company matcher, so a record already here is opened,
 *                   never made twice.
 *
 * LOOKING spends nothing but a LinkedIn search against the account's daily
 * cap. SAVING a row from a source that sells its addresses spends that
 * source's units, and the row says how many before it is saved (saveCost).
 */
import { and, desc, eq, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { prospects, prospectSearchResults, prospectSearchRuns } from "../../drizzle/schema";
import { getDb } from "../db";
import { emptyCriteria, type ProspectSourceSlug, type SearchCriteria } from "@shared/prospectSources";
import { parseRecordSearch, type RecordSearchQuery } from "@shared/recordSearch";
import {
  LOOKUP_WAIT_MS, lookupLimit, planLookup,
  type LookupKind, type LookupPlan, type LookupSave, type LookupSaveResult,
  type OutsideCompany, type OutsideLookupResult, type OutsidePerson,
} from "@shared/recordLookup";
import { searchLinkedInProfiles } from "./linkedinLookup";
import { stripNameCredentials } from "./enrichment/personName";
import { getRun, promoteResults, startRun } from "./prospectSources/searchRuns";
import { getSource, listSources } from "./prospectSources/registry";
import { credentialView, loadCredentials } from "./prospectSources/credentials";
import { alreadyInWorkspace, workspaceIdentityIndex, type KnownIdentity } from "./prospectSources/dedupe";
import type { ProspectRecord } from "./prospectSources/types";
import { queueIdentityKeys } from "./are/queueIdentity";
import { normalizeDomain } from "./company/normalize";
import { companyFromUrl } from "./company/nameRepair";
import { findWorkspaceAccountMatch, shouldAutoLink } from "./company/matchingService";
import { createWorkspaceAccount } from "./company/associationService";

export type LookupCaller = { workspaceId: number; userId: number; isAdmin: boolean };

const personHref = (id: number) => `/prospects/${id}`;
const companyHref = (id: number) => `/v2/companies/${id}`;
const lower = (v: unknown) => String(v ?? "").toLowerCase();
const clean = (v: unknown, max = 200) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, max) : null; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Is this database row about what was typed? The databases' keyword and
 * company filters are approximations ("approximatedFilters"), so a row can
 * come back for a word in a field nobody sees. The box promised THIS person
 * or THIS company; a row that does not carry the words is left out.
 */
export function matchesLookup(plan: LookupPlan, q: RecordSearchQuery, rec: Pick<ProspectRecord, "firstName" | "lastName" | "jobTitle" | "companyName" | "companyDomain" | "email">): boolean {
  if (plan.companyDomains.length) {
    const want = plan.companyDomains[0];
    const on = (d: string) => !!d && (d === want || d.endsWith(`.${want}`));
    // A masked address ("j***@acme.org") still names its domain.
    return on(normalizeDomain(rec.companyDomain)) || on(lower(rec.email).split("@")[1] ?? "");
  }
  const words = q.words.map((w) => w.toLowerCase());
  const text = plan.kind === "company"
    ? `${lower(rec.companyName)} ${lower(rec.companyDomain)}`
    : `${lower(rec.firstName)} ${lower(rec.lastName)} ${lower(rec.companyName)} ${lower(rec.jobTitle)} ${lower(rec.companyDomain)}`;
  return words.every((w) => text.includes(w));
}

function emptyResult(query: string, kind: LookupKind, notes: string[]): OutsideLookupResult {
  return { query, kind, subject: query, people: [], companies: [], searched: [], notes, pending: null };
}

async function linkedInPeople(caller: LookupCaller, plan: LookupPlan, index: Map<string, KnownIdentity>, limit: number): Promise<{ people: OutsidePerson[]; searched: boolean; note: string | null }> {
  let res: Awaited<ReturnType<typeof searchLinkedInProfiles>>;
  try {
    res = await searchLinkedInProfiles({
      workspaceId: caller.workspaceId, userId: caller.userId, isAdmin: caller.isAdmin,
      keywords: plan.subject, limit, source: "search_box",
      // NOT personInitiated: a search from this box is a search on the account
      // LinkedIn is watching, held like the one on the Social page when the
      // account's LinkedIn activity is paused.
    });
  } catch (e) {
    return { people: [], searched: false, note: `LinkedIn was not searched: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
  if (!res.ok) return { people: [], searched: false, note: `LinkedIn was not searched: ${res.message}` };
  const people: OutsidePerson[] = [];
  for (let i = 0; i < res.hits.length && people.length < limit; i++) {
    const h = res.hits[i];
    // Owner rule: LinkedIn credential suffixes never enter a name.
    const firstName = clean(stripNameCredentials(h.firstName), 80);
    const lastName = clean(stripNameCredentials(h.lastName), 80);
    const linkedinUrl = clean(h.linkedinUrl, 2048);
    // A row that could not be saved (no full name, no profile) is not offered.
    if (!firstName || !lastName || !linkedinUrl) continue;
    const company = clean(h.company);
    const known = alreadyInWorkspace(index, { firstName, lastName, companyName: company, linkedinUrl });
    people.push({
      ref: `li:${i}`, via: "LinkedIn", name: `${firstName} ${lastName}`,
      title: clean(h.headline), company, domain: null, location: clean(h.location), linkedinUrl,
      email: null, emailHidden: false,
      already: known.status === "in_people" && known.prospectId ? { href: personHref(known.prospectId) } : null,
      saveCost: 0,
      save: { type: "linkedin_person", firstName, lastName, title: clean(h.headline), company, linkedinUrl, location: clean(h.location) },
    });
  }
  return { people, searched: true, note: null };
}

type RunView = NonNullable<Awaited<ReturnType<typeof getRun>>>;

/** Units saving this staged row spends: only a source that sells its rows, and only once. */
async function saveCostOf(workspaceId: number, row: { sourceSlug: string; externalId: string; wasCharged: boolean; promotedProspectId: number | null }): Promise<number> {
  const s = getSource(row.sourceSlug as ProspectSourceSlug);
  if (s.acquisition !== "on_demand" || row.wasCharged || row.promotedProspectId) return 0;
  if (!s.estimateAcquireUnits) return 1;
  const creds = await loadCredentials(workspaceId, s);
  return creds ? s.estimateAcquireUnits(row.externalId, creds) : 1;
}

async function peopleFromRun(workspaceId: number, view: RunView, plan: LookupPlan, q: RecordSearchQuery, index: Map<string, KnownIdentity>, limit: number): Promise<{ people: OutsidePerson[]; records: ProspectRecord[] }> {
  const people: OutsidePerson[] = [];
  const records: ProspectRecord[] = [];
  for (let i = 0; i < view.results.length && people.length < limit; i++) {
    const r = view.results[i];
    const rec = r.normalized as ProspectRecord | null;
    if (!rec) continue;
    const name = `${rec.firstName ?? ""} ${rec.lastName ?? ""}`.trim();
    if (!name || !matchesLookup(plan, q, rec)) continue;
    const known = alreadyInWorkspace(index, rec);
    const prospectId = r.promotedProspectId ?? (known.status === "in_people" ? known.prospectId : null);
    const already = prospectId ? { href: personHref(prospectId) } : null;
    people.push({
      ref: `src:${r.id}`, via: getSource(r.sourceSlug as ProspectSourceSlug).displayName, name,
      title: clean(rec.jobTitle), company: clean(rec.companyName), domain: normalizeDomain(rec.companyDomain) || null,
      location: [rec.city, rec.stateProvince, rec.country].map((p) => (p ?? "").trim()).filter(Boolean).join(", ") || null,
      linkedinUrl: clean(rec.linkedinUrl, 2048),
      // A masked preview is never an address (types.ts): it is not shown as one.
      email: rec.emailIsMasked ? null : clean(rec.email, 320),
      emailHidden: !!rec.emailIsMasked,
      already,
      saveCost: already ? 0 : await saveCostOf(workspaceId, r),
      save: { type: "source_person", runId: view.run.id, resultId: r.id },
    });
    records.push(rec);
  }
  return { people, records };
}

/** The companies the found people work at, read off their rows. */
async function companiesFrom(workspaceId: number, records: ProspectRecord[]): Promise<OutsideCompany[]> {
  const groups = new Map<string, { name: string; domain: string | null; industry: string | null; size: string | null; n: number }>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const domain = normalizeDomain(rec.companyDomain) || null;
    const name = clean(rec.companyName) ?? (domain ? companyFromUrl(domain) ?? domain : null);
    if (!name) continue;
    const key = domain ?? name.toLowerCase();
    const g = groups.get(key) ?? { name, domain, industry: clean(rec.industry), size: clean(rec.headcount), n: 0 };
    g.n += 1;
    g.industry = g.industry ?? clean(rec.industry);
    g.size = g.size ?? clean(rec.headcount);
    groups.set(key, g);
  }
  const top = Array.from(groups.values()).sort((a, b) => b.n - a.n).slice(0, 3);
  const out: OutsideCompany[] = [];
  for (let i = 0; i < top.length; i++) {
    const g = top[i];
    out.push({
      ref: `co:${i}`, name: g.name, domain: g.domain, industry: g.industry,
      size: g.size ? (/employee/i.test(g.size) ? g.size : `${g.size} employees`) : null,
      peopleFound: g.n, typed: false,
      already: await existingCompany(workspaceId, g.name, g.domain),
      save: { type: "company", name: g.name, domain: g.domain },
    });
  }
  return out;
}

async function existingCompany(workspaceId: number, name: string | null, domain: string | null): Promise<{ href: string } | null> {
  const m = await findWorkspaceAccountMatch(workspaceId, { name, domain });
  return m.accountId && shouldAutoLink(m.confidence) ? { href: companyHref(m.accountId) } : null;
}

/**
 * Wait for the staged run, up to `waitMs`. The run executes in this process
 * (searchRuns.startRun), so a short poll is all there is to do; a run still
 * going at the deadline is handed back as `pending`, never abandoned.
 */
async function waitForRun(workspaceId: number, runId: number, waitMs: number): Promise<RunView | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const view = await getRun(workspaceId, runId);
    if (!view) return null;
    if (view.run.status !== "queued" && view.run.status !== "running") return view;
    if (Date.now() >= deadline) return view;
    await sleep(400);
  }
}

/**
 * Look what was typed up outside the workspace.
 *
 * `resumeRunId` asks only for the rest of a database search that had not
 * finished (result.pending): LinkedIn is NOT searched a second time.
 */
export async function lookupOutside(
  caller: LookupCaller,
  raw: string,
  kind: LookupKind,
  resumeRunId?: number | null,
  opts?: { waitMs?: number; limit?: number | null },
): Promise<OutsideLookupResult> {
  const q = parseRecordSearch(raw);
  if (!q) return emptyResult(String(raw ?? "").trim(), kind, ["Type at least two characters to look up."]);
  const plan = planLookup(q, kind);
  const notes: string[] = plan.note ? [plan.note] : [];
  const searched: string[] = [];
  const waitMs = opts?.waitMs ?? LOOKUP_WAIT_MS;
  // How many rows each source is asked for: six from the Search box, up to
  // LOOKUP_MAX from the name lookup, never more whatever a caller sends.
  const limit = lookupLimit(opts?.limit);
  const index = await workspaceIdentityIndex(caller.workspaceId);

  /* The databases: start (or pick up) the staged run. */
  const startDatabases = async (): Promise<number | null> => {
    if (resumeRunId) return resumeRunId;
    const views = await Promise.all(listSources().map((s) => credentialView(caller.workspaceId, s)));
    if (!views.some((v) => v.configured)) {
      notes.push("No prospect database is connected, so only LinkedIn could be asked. Add one under Settings → Data sources.");
      return null;
    }
    const criteria: SearchCriteria = { ...emptyCriteria(), keywords: plan.keywords, companyNames: plan.companyNames, companyDomains: plan.companyDomains };
    try {
      // `only: null` is the free door: a source that bills its previews runs
      // only when a person names it (registry.eligibleFor), never from here.
      return (await startRun(caller.workspaceId, caller.userId, criteria, limit, null)).runId;
    } catch (e) {
      notes.push(`The databases were not searched: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return null;
    }
  };

  const [li, runId] = await Promise.all([
    plan.linkedin && !resumeRunId ? linkedInPeople(caller, plan, index, limit) : Promise.resolve({ people: [] as OutsidePerson[], searched: false, note: null as string | null }),
    startDatabases(),
  ]);
  if (li.searched) searched.push("LinkedIn");
  if (li.note) notes.push(li.note);

  let people = li.people;
  let records: ProspectRecord[] = [];
  let pending: { runId: number } | null = null;
  if (runId != null) {
    const view = await waitForRun(caller.workspaceId, runId, waitMs);
    if (!view) notes.push("The database search could not be read back.");
    else if (view.run.status === "queued" || view.run.status === "running") pending = { runId };
    else {
      const per = (view.run.perSource ?? {}) as Record<string, { skipped?: string; detail?: string; error?: string; held?: boolean }>;
      const slugs = Object.keys(per);
      const unable: string[] = [];
      for (let i = 0; i < slugs.length; i++) {
        const name = getSource(slugs[i] as ProspectSourceSlug).displayName;
        const o = per[slugs[i]];
        if (o.skipped) { if (o.skipped === "cannot_honour") unable.push(name); continue; }
        searched.push(name);
        if (o.error) notes.push(`${name}: ${String(o.error).slice(0, 200)}`);
      }
      if (view.run.status !== "complete") notes.push(`The database search did not finish${view.run.error ? `: ${String(view.run.error).slice(0, 200)}` : "."}`);
      else if (searched.filter((s) => s !== "LinkedIn").length === 0) {
        notes.push(unable.length
          ? `${unable.join(", ")} cannot search by ${plan.companyDomains.length ? "company domain" : plan.kind === "company" ? "company name" : "name"}, so no database was asked.`
          : "None of the connected databases could be asked just now.");
      }
      const found = await peopleFromRun(caller.workspaceId, view, plan, q, index, limit);
      people = people.concat(found.people);
      records = found.records;
    }
  }

  let companies: OutsideCompany[] = [];
  if (plan.kind === "company") {
    companies = await companiesFrom(caller.workspaceId, records);
    if (companies.length === 0 && !pending) {
      // Nothing came back: the record can still be made from what was typed.
      const domain = q.domain;
      const name = domain ? companyFromUrl(domain) ?? domain : q.text;
      companies = [{
        ref: "co:typed", name, domain, industry: null, size: null, peopleFound: 0, typed: true,
        already: await existingCompany(caller.workspaceId, domain ? null : name, domain),
        save: { type: "company", name, domain },
      }];
      notes.push(`No source returned ${plan.subject}. It can still be created with no details yet; Enrich on its page fills them in.`);
    }
  }
  return { query: q.text, kind: plan.kind, subject: plan.subject, people, companies, searched, notes, pending };
}

/* ─── saving ─────────────────────────────────────────────────────────────── */

const fail = (message: string, code: "BAD_REQUEST" | "NOT_FOUND" | "INTERNAL_SERVER_ERROR" = "BAD_REQUEST") => new TRPCError({ code, message });

async function stagedRow(workspaceId: number, runId: number, resultId: number) {
  const db = await getDb();
  if (!db) throw fail("The database is unavailable.", "INTERNAL_SERVER_ERROR");
  // Both the run and the row must be this workspace's (X1.1): another's ids find nothing.
  const [run] = await db.select({ id: prospectSearchRuns.id }).from(prospectSearchRuns)
    .where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId))).limit(1);
  if (!run) return null;
  const [row] = await db.select().from(prospectSearchResults)
    .where(and(eq(prospectSearchResults.workspaceId, workspaceId), eq(prospectSearchResults.runId, runId), eq(prospectSearchResults.id, resultId))).limit(1);
  return row ?? null;
}

/** The People record a just-saved LinkedIn find became, read by its identity, not guessed by name alone. */
async function personSavedAs(workspaceId: number, find: { firstName: string; lastName: string; company?: string | null; linkedinUrl: string }): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: prospects.id, email: prospects.email, linkedinUrl: prospects.linkedinUrl, firstName: prospects.firstName, lastName: prospects.lastName, companyName: prospects.company, companyDomain: prospects.companyDomain })
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      or(eq(prospects.linkedinUrl, find.linkedinUrl), and(eq(prospects.firstName, find.firstName), eq(prospects.lastName, find.lastName)))!,
    ))
    .orderBy(desc(prospects.id))
    .limit(25);
  const want = new Set(queueIdentityKeys({ firstName: find.firstName, lastName: find.lastName, companyName: find.company, linkedinUrl: find.linkedinUrl }));
  for (let i = 0; i < rows.length; i++) {
    if (queueIdentityKeys(rows[i]).some((k) => want.has(k))) return rows[i].id;
  }
  return null;
}

/** Save one row a lookup handed out. A record already here is opened, never made twice. */
export async function saveFromLookup(caller: LookupCaller, save: LookupSave): Promise<LookupSaveResult> {
  const ws = caller.workspaceId;

  if (save.type === "company") {
    const domain = normalizeDomain(save.domain) || null;
    const name = clean(save.name) ?? (domain ? companyFromUrl(domain) ?? domain : null);
    if (!name) throw fail("A company needs a name or a domain.");
    const existing = await findWorkspaceAccountMatch(ws, { name, domain });
    if (existing.accountId && shouldAutoLink(existing.confidence)) {
      return { kind: "company", id: existing.accountId, href: companyHref(existing.accountId), created: false, unitsSpent: 0, message: `${name} is in Companies already.` };
    }
    const id = await createWorkspaceAccount(ws, { name, domain }, "search_lookup");
    return { kind: "company", id, href: companyHref(id), created: true, unitsSpent: 0, message: `Created ${name} in Companies. Press Enrich on its page to fill in the details.` };
  }

  if (save.type === "linkedin_person") {
    const firstName = clean(stripNameCredentials(save.firstName), 80);
    const lastName = clean(stripNameCredentials(save.lastName), 80);
    const linkedinUrl = clean(save.linkedinUrl, 2048);
    if (!firstName || !lastName || !linkedinUrl) throw fail("A person needs a first name, a last name and a LinkedIn profile.");
    const company = clean(save.company);
    const name = `${firstName} ${lastName}`;
    const known = alreadyInWorkspace(await workspaceIdentityIndex(ws), { firstName, lastName, companyName: company, linkedinUrl });
    if (known.status === "in_people" && known.prospectId) {
      return { kind: "person", id: known.prospectId, href: personHref(known.prospectId), created: false, unitsSpent: 0, message: `${name} is in People already.` };
    }
    // The same save the LinkedIn search card uses (unipile.importSearchHitsToPeople):
    // one identity match, the suppression rules, provenance and company linking.
    const { saveFindsAsPeople } = await import("./discovery");
    await saveFindsAsPeople(ws, caller.userId, "linkedin_search", [{
      firstName, lastName, title: clean(save.title), companyName: company,
      linkedinUrl, sourceUrl: linkedinUrl, geography: clean(save.location),
    }], { fromSearchBox: true, hits: 1 });
    const id = await personSavedAs(ws, { firstName, lastName, company, linkedinUrl });
    if (!id) throw fail(`${name} was not saved: they are on a suppression list, or match someone in People by name only.`);
    return { kind: "person", id, href: personHref(id), created: true, unitsSpent: 0, message: `Saved ${name} to People. Enrich on their page finds an email address.` };
  }

  const row = await stagedRow(ws, save.runId, save.resultId);
  if (!row) throw fail("That lookup row was not found. Look the name up again.", "NOT_FOUND");
  const rec = row.normalized as ProspectRecord | null;
  const name = `${rec?.firstName ?? ""} ${rec?.lastName ?? ""}`.trim() || "This person";
  if (row.promotedProspectId) {
    return { kind: "person", id: row.promotedProspectId, href: personHref(row.promotedProspectId), created: false, unitsSpent: 0, message: `${name} is in People already.` };
  }
  // The same save Source search uses: the row is claimed, the source is paid
  // only if it sells its rows, and the person goes through the consolidation.
  const r = await promoteResults(ws, caller.userId, save.runId, [save.resultId]);
  const after = await stagedRow(ws, save.runId, save.resultId);
  const id = after?.promotedProspectId ?? null;
  if (!id) throw fail(`${name} was not saved${r.errors.length ? `: ${r.errors.join("; ").slice(0, 400)}` : "."}`);
  return {
    kind: "person", id, href: personHref(id), created: true, unitsSpent: r.unitsSpent,
    message: `Saved ${name} to People${r.unitsSpent ? `, using ${r.unitsSpent} ${getSource(row.sourceSlug as ProspectSourceSlug).displayName} ${r.unitsSpent === 1 ? "credit" : "credits"}` : ""}.`,
  };
}

/** The sentence on Elsie's confirmation card: who is saved, from where, and what it spends. */
export async function describeLookupSave(workspaceId: number, save: LookupSave): Promise<string> {
  if (save.type === "company") return `Creates the company ${save.name}${save.domain ? ` (${save.domain})` : ""} in Companies, unless it is there already. Spends nothing.`;
  if (save.type === "linkedin_person") {
    return `Saves ${save.firstName} ${save.lastName}${save.company ? ` (${save.company})` : ""} to People from LinkedIn, unless they are there already. Spends nothing.`;
  }
  const row = await stagedRow(workspaceId, save.runId, save.resultId).catch(() => null);
  if (!row) return "Saves a looked-up person to People. The lookup row was not found, so this will fail; look the name up again.";
  const rec = row.normalized as ProspectRecord | null;
  const via = getSource(row.sourceSlug as ProspectSourceSlug).displayName;
  const cost = await saveCostOf(workspaceId, row);
  const who = `${rec?.firstName ?? ""} ${rec?.lastName ?? ""}`.trim() || "the looked-up person";
  return `Saves ${who}${rec?.companyName ? ` (${rec.companyName})` : ""} to People from ${via}. ${cost > 0 ? `⚠ Spends ${cost} ${via} ${cost === 1 ? "credit" : "credits"}.` : "Spends nothing."}`;
}
