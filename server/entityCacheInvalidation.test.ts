/**
 * A write refreshes every screen that shows what it changed (audit
 * 2026-10-20, X1.7: "mutations that don't refresh sibling screens").
 *
 * Every cached read stays fresh for 30 seconds (client/src/main.tsx). Each
 * writer used to invalidate, by hand, whatever its own screen showed — about
 * 590 sites, each a different subset — so the page next door kept the old
 * rows until the 30 seconds ran out. The fix is the shape PR #33
 * (`invalidateEnrollmentReads`) and R31 (`invalidateDealReads`) set: one
 * function per entity family in client/src/lib/entityCache.ts names every
 * read that shows the family, and writers call it.
 *
 * What this guards, recomputed from the source on every run:
 *   1. each helper names the reads its family shows (the cross-screen ones
 *      especially, since those are the ones a subset forgets);
 *   2. nothing outside client/src/lib hand-invalidates a covered family's
 *      reads — a subset is the failure mode;
 *   3. every mutation on a covered family's router refreshes through that
 *      family's helper (in its options, or through a local function it
 *      calls), or is listed with the reason it changes nothing on screen.
 *
 * Covered: deals, customers, people (prospects + CRM contacts), companies
 * (companies + accounts), leads, tasks, sequences, Revenue Engine campaigns,
 * proposals, lists and segments, meetings. What is not yet covered is
 * NOT_YET_COVERED below, named, so the next pass knows where to start.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client", "src");
const read = (abs: string) => readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
/** Comments out (a ban must not trip on its own explanation), newlines kept so line numbers hold. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

const FILES = walk(CLIENT).map((abs) => ({ rel: abs.slice(CLIENT.length + 1).split(sep).join("/"), raw: read(abs) }))
  .map((f) => ({ ...f, code: stripComments(f.raw) }));
const file = (rel: string) => FILES.find((f) => f.rel === rel)!;
const LIB = new Set(["lib/entityCache.ts", "lib/crmCache.ts", "lib/enrollmentCache.ts"]);

/** Family → its routers (the writers) and the helpers that refresh it. */
const FAMILIES: Record<string, { routers: string[]; helpers: string[] }> = {
  deals: { routers: ["opportunities", "oppIntelligence"], helpers: ["invalidateDealReads"] },
  customers: { routers: ["cs"], helpers: ["invalidateCustomerReads"] },
  people: { routers: ["prospects", "contacts"], helpers: ["invalidatePeopleReads"] },
  companies: { routers: ["companies", "accounts"], helpers: ["invalidateCompanyReads"] },
  leads: { routers: ["leads"], helpers: ["invalidateLeadReads"] },
  tasks: { routers: ["tasks"], helpers: ["invalidateTaskReads"] },
  sequences: { routers: ["sequences", "sequenceAb", "sequenceTimeline"], helpers: ["invalidateSequenceReads", "invalidateEnrollmentReads"] },
  campaigns: { routers: ["are"], helpers: ["invalidateCampaignReads"] },
  proposals: { routers: ["proposals"], helpers: ["invalidateProposalReads"] },
  lists: { routers: ["recordLists", "segments", "segmentRules"], helpers: ["invalidateListReads"] },
  meetings: { routers: ["meetings", "calendar"], helpers: ["invalidateMeetingReads"] },
};
const familyOf = (proc: string) => Object.entries(FAMILIES).find(([, f]) => f.routers.includes(proc.split(".")[0]))?.[0];

/**
 * Files the CONB batch owns until it merges (one task page, one home, one
 * deal board, the settings hub, the shell). DEFERRED, not excused: each moves
 * onto the helpers after that merge.
 */
const DEFERRED_FILES = new Set([
  "pages/usip/Tasks.tsx", "pages/usip/TasksV2.tsx", "pages/usip/Dashboard.tsx", "pages/usip/Home.tsx",
  "pages/usip/Pipeline.tsx", "pages/usip/DealsV2.tsx", "pages/usip/Settings.tsx", "pages/usip/SettingsHub.tsx",
]);

/** Hand-written invalidations of a family's reads that are right where they are. */
const HAND_REVIEWED = new Set([
  // A test-callable copy of the campaign refresh (tracker 11), with no tRPC
  // import so areHubRefresh.test.ts can drive it: the same two reads the
  // campaign helper names.
  "pages/usip/areHubModel.ts",
]);

/**
 * Mutations on a covered family's router that refresh no family read, and why
 * that is right. Key: `<file>::<procedure>`.
 */
const NO_REFRESH: Record<string, string> = {
  // The public proposal portal: the client's browser holds none of the team's
  // reads, and the team's screens learn of a view, a request or a decision
  // from the server (notifications, the proposal's own activity).
  "pages/ProposalPortal.tsx::proposals.recordView": "public portal: a view is recorded for the team; the visitor holds no team reads",
  "pages/ProposalPortal.tsx::proposals.submitFeedback": "public portal: the visitor's change request; the visitor holds no team reads",
  "pages/ProposalPortal.tsx::proposals.requestExtension": "public portal: the visitor's extension request; the visitor holds no team reads",
  "pages/ProposalPortal.tsx::proposals.declineByToken": "public portal: the visitor declines; the visitor holds no team reads",
  "pages/ProposalPortal.tsx::proposals.acceptByToken": "public portal: the visitor accepts; the visitor holds no team reads",
  "pages/usip/ARECampaignDetail.tsx::are.prospects.reEvaluateAll": "starts a background job; the effect that follows the job refreshes the campaign family when it finishes",
  "pages/usip/ProposalDetail.tsx::proposals.snapshotScore": "a silent score snapshot taken when the page opens; refreshing every proposal read on each open would refetch for nothing",
  "pages/usip/SequenceCanvas.tsx::sequences.saveCanvas": "the canvas autosave: the editor holds the steps it just saved, and a refresh per keystroke would refetch every sequence read",
};

/**
 * Families not yet on a helper: their writers still invalidate by hand.
 * Named so the next pass starts here; each must still exist in the client.
 */
const NOT_YET_COVERED = [
  "sendingAccounts", "settings", "team", "workspace", "profile", "linkedinEnrichment", "discovery",
  "prospectSources", "research", "dataHealth", "dashboards", "chatAgents", "voiceAgents", "workflows",
  "emailTemplates", "emailSuppressions", "conversations", "mailbox", "unipile", "quotes", "products",
  "landingPages", "forms", "scim", "personas", "promptTemplates", "snippets", "senderPools", "reports",
  "imports", "notifications", "optimization", "leadScoring", "quota",
];

/* ── scanning ────────────────────────────────────────────────────────── */

function matchClose(s: string, open: number): number {
  const o = s[open];
  const c = o === "(" ? ")" : o === "{" ? "}" : "]";
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i++; i < s.length && s[i] !== q; i++) if (s[i] === "\\") i++;
      continue;
    }
    if (ch === o) d++;
    else if (ch === c) { d--; if (d === 0) return i; }
  }
  return -1;
}

/**
 * What a name can run, read from the file: a local function's body (`any`:
 * same-named functions in two components cannot be told apart, so one that
 * refreshes is enough), and every value passed to a callback prop of that
 * name in the file's JSX (`all`: `onRefetch={…}` counts only if every page
 * that passes one passes a refresh).
 */
type Body = { any: string[]; all: string[] };
function localBodies(code: string): Map<string, Body> {
  const out = new Map<string, Body>();
  const slot = (n: string) => { if (!out.has(n)) out.set(n, { any: [], all: [] }); return out.get(n)!; };
  for (const m of Array.from(code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:useCallback\(\s*)?(?:async\s*)?\([^()]*\)\s*(?::\s*[^=]+)?=>\s*/g))) {
    const at = m.index! + m[0].length;
    const end = code[at] === "{" || code[at] === "(" ? matchClose(code, at) : code.indexOf("\n", at);
    if (end > at) slot(m[1]).any.push(code.slice(at, end + 1));
  }
  for (const m of Array.from(code.matchAll(/function\s+(\w+)\s*\(/g))) {
    const b = code.indexOf("{", matchClose(code, code.indexOf("(", m.index!)));
    const e = b > 0 ? matchClose(code, b) : -1;
    if (e > 0) slot(m[1]).any.push(code.slice(b, e + 1));
  }
  // `const { invalidateAll } = useCampaignSync(…)` and its renames refresh the campaign family.
  for (const m of Array.from(code.matchAll(/const\s*\{\s*invalidateAll(?:\s*:\s*(\w+))?\s*\}\s*=\s*useCampaignSync\(/g))) {
    slot(m[1] ?? "invalidateAll").any.push("invalidateCampaignReads(utils)");
  }
  // Callback props: `onRefetch={refresh}`; a pass-through (`onRefetch={onRefetch}`) adds nothing.
  for (const m of Array.from(code.matchAll(/\s(on[A-Z]\w*)=\{/g))) {
    const open = m.index! + m[0].length - 1;
    const expr = code.slice(open + 1, matchClose(code, open));
    if (expr.trim() !== m[1]) slot(m[1]).all.push(expr);
  }
  return out;
}

/** Does `text` reach one of `helpers`, directly or through local functions and props (three levels)? */
function reaches(text: string, helpers: string[], bodies: Map<string, Body>, depth = 0): boolean {
  if (helpers.some((h) => new RegExp(`\\b${h}\\(`).test(text))) return true;
  if (depth > 3) return false;
  for (const [name, body] of Array.from(bodies)) {
    if (!new RegExp(`(?<![\\w.])${name}\\b`).test(text)) continue;
    if (body.any.some((b) => reaches(b, helpers, bodies, depth + 1))) return true;
    if (body.all.length && body.all.every((b) => reaches(b, helpers, bodies, depth + 1))) return true;
  }
  return false;
}

type Writer = { rel: string; line: number; proc: string; key: string; family: string; options: string; name: string };

function writers(): Writer[] {
  const out: Writer[] = [];
  for (const f of FILES) {
    if (LIB.has(f.rel)) continue;
    for (const m of Array.from(f.code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*trpc\.([\w.]+)\.useMutation\(/g))) {
      const family = familyOf(m[2]);
      if (!family) continue;
      const open = m.index! + m[0].length - 1;
      out.push({ rel: f.rel, line: f.code.slice(0, m.index!).split("\n").length, proc: m[2], key: `${f.rel}::${m[2]}`, family, options: f.code.slice(open, matchClose(f.code, open) + 1), name: m[1] });
    }
  }
  return out;
}

/**
 * A writer driven with `mutateAsync` refreshes where it is awaited: the local
 * function that awaits it (or passes onSuccess at the call) must reach the
 * helper. Read from the function bodies that contain the call.
 */
function refreshesAtCallSite(w: Writer, code: string, bodies: Map<string, Body>): boolean {
  const call = new RegExp(`(?<![\\w.])${w.name}\\.(mutate|mutateAsync)\\(`);
  for (const body of Array.from(bodies.values()).flatMap((b) => b.any)) {
    if (call.test(body) && reaches(body, FAMILIES[w.family].helpers, bodies)) return true;
  }
  for (const m of Array.from(code.matchAll(new RegExp(call.source, "g")))) {
    const open = code.indexOf("(", m.index! + w.name.length + 1);
    if (reaches(code.slice(open, matchClose(code, open) + 1), FAMILIES[w.family].helpers, bodies)) return true;
  }
  return false;
}

/* ── tests ───────────────────────────────────────────────────────────── */

describe("one refresh per entity family (X1.7)", () => {
  const helper = stripComments(file("lib/entityCache.ts").raw);
  const fn = (name: string) => {
    const at = helper.indexOf(`export function ${name}(`);
    expect(at, `${name} is defined`).toBeGreaterThan(-1);
    return helper.slice(at, matchClose(helper, helper.indexOf("{", helper.indexOf(")", at))) + 1);
  };

  it("each helper names the reads its family shows on other screens", () => {
    const expected: Record<string, string[]> = {
      invalidatePeopleReads: ["utils.prospects.invalidate()", "utils.contacts.invalidate()", "utils.recordLists.invalidate()", "utils.companies.contacts.invalidate()", "utils.accounts.getWithContacts.invalidate()", "utils.dataHealth.invalidate()", "utils.attention.summary.invalidate()"],
      invalidateCompanyReads: ["utils.companies.invalidate()", "utils.accounts.invalidate()", "utils.contacts.getWithAccount.invalidate()", "utils.prospects.list.invalidate()"],
      invalidateLeadReads: ["utils.leads.invalidate()", "utils.leadScoring.breakdown.invalidate()", "utils.attention.summary.invalidate()"],
      invalidateTaskReads: ["utils.tasks.invalidate()", "utils.attention.summary.invalidate()"],
      invalidateSequenceReads: ["utils.sequences.invalidate()", "utils.sequenceAb.invalidate()", "utils.sequenceTimeline.invalidate()", "utils.prospects.enrollmentsFor.invalidate()"],
      invalidateCampaignReads: ["utils.are.invalidate()", "utils.attention.summary.invalidate()"],
      invalidateProposalReads: ["utils.proposals.invalidate()", "utils.opportunities.getWithRelated.invalidate()"],
      invalidateListReads: ["utils.recordLists.invalidate()", "utils.segments.invalidate()", "utils.segmentRules.invalidate()"],
      invalidateMeetingReads: ["utils.meetings.invalidate()", "utils.calendar.invalidate()", "utils.attention.summary.invalidate()"],
    };
    for (const [name, reads] of Object.entries(expected)) {
      const body = fn(name);
      for (const r of reads) expect(body, `${name} names ${r}`).toContain(r);
      // Each returns its refetch, so a caller that awaited its invalidations still can.
      expect(body, `${name} returns a promise`).toMatch(/Promise<void>[\s\S]*return all\(\[/);
    }
    // The deal and customer helpers live beside R31's guard, re-exported here.
    const crm = stripComments(file("lib/crmCache.ts").raw);
    expect(crm).toContain("utils.oppIntelligence.invalidate()");
    expect(crm).toContain("utils.pipelineAlerts.invalidate()");
    expect(helper).toMatch(/export \{ invalidateCustomerReads, invalidateDealReads, invalidateEnrollmentReads \}/);
  });

  it("the campaign page's own sync is the campaign helper", () => {
    const page = stripComments(file("pages/usip/ARECampaignDetail.tsx").raw);
    const sync = page.slice(page.indexOf("function useCampaignSync("), page.indexOf("function ProspectRow("));
    expect(sync).toContain("invalidateAll: () => invalidateCampaignReads(utils)");
    expect(sync).not.toMatch(/utils\.are\./);
  });

  it("nothing outside client/src/lib hand-invalidates a covered family's reads", () => {
    const routers = Object.values(FAMILIES).flatMap((f) => f.routers);
    const re = new RegExp(`(?<![\\w.])\\w*[uU]tils\\.(${routers.join("|")})\\b[\\w.]*\\.invalidate\\(`, "g");
    const offenders: string[] = [];
    for (const f of FILES) {
      if (LIB.has(f.rel) || DEFERRED_FILES.has(f.rel) || HAND_REVIEWED.has(f.rel)) continue;
      for (const m of Array.from(f.code.matchAll(re))) offenders.push(`${f.rel}:${f.code.slice(0, m.index!).split("\n").length}  ${m[0]}`);
    }
    expect(offenders, `\nCall the family's helper from @/lib/entityCache instead:\n${offenders.join("\n")}\n`).toEqual([]);
  });

  it("every writer of a covered family refreshes through its helper, or says why not", () => {
    const missing: string[] = [];
    for (const w of writers()) {
      if (DEFERRED_FILES.has(w.rel) || NO_REFRESH[w.key]) continue;
      const code = file(w.rel).code;
      const bodies = localBodies(code);
      if (!reaches(w.options, FAMILIES[w.family].helpers, bodies) && !refreshesAtCallSite(w, code, bodies)) missing.push(`${w.rel}:${w.line}  ${w.proc}  (${w.family})`);
    }
    expect(missing, `\n${missing.length} writer(s) refresh nothing of their family:\n${missing.join("\n")}\n`).toEqual([]);
  });

  it("finds the writers at all, and every exemption still matches one", () => {
    const all = writers();
    expect(all.length).toBeGreaterThan(200);
    const keys = new Set(all.map((w) => w.key));
    expect(Object.keys(NO_REFRESH).filter((k) => !keys.has(k))).toEqual([]);
    for (const [k, why] of Object.entries(NO_REFRESH)) expect(why.length, k).toBeGreaterThan(20);
    for (const rel of Array.from(DEFERRED_FILES).concat(Array.from(HAND_REVIEWED))) expect(FILES.some((f) => f.rel === rel), rel).toBe(true);
  });

  it("names what is not covered yet, and each of those still has writers", () => {
    const procs = new Set(FILES.flatMap((f) => Array.from(f.code.matchAll(/trpc\.(\w+)\.[\w.]+\.useMutation\(/g)).map((m) => m[1])));
    for (const r of NOT_YET_COVERED) expect(procs.has(r), `${r} has no client writer: drop it from NOT_YET_COVERED`).toBe(true);
    for (const r of NOT_YET_COVERED) expect(familyOf(`${r}.x`), r).toBeUndefined();
  });
});
