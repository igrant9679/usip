/**
 * Every send, spend, delete and bulk change asks first (audit 2026-10-20, U5
 * and X1.8: "about 35 actions run on one click").
 *
 * THE RULE. A client mutation that deletes, archives, removes, disconnects,
 * revokes, cancels, sends, changes many rows at once, or spends vendor
 * credits or a batch of AI calls, runs only after the person has said yes —
 * through the one confirmation component (`confirmAction` / `ConfirmButton`
 * in client/src/components/usip/Common.tsx, or a helper built on it) — or it
 * is listed in REVIEWED below with the reason it needs none.
 *
 * HOW A CALL COUNTS AS CONFIRMED, read from the source:
 *   - it sits inside the arguments of a confirm call (`confirmAction(…)`,
 *     `confirmPaidLookup(…)`, or a `const x = useConfirm…()` function), or in
 *     the opening tag of a `<ConfirmButton …>` / `<AlertDialogAction …>`;
 *   - or it sits in a named function (`const go = () => …`) every one of whose
 *     uses is itself confirmed, followed up to three levels;
 *   - or it is handed to a component prop that confirms inside the component
 *     (CONFIRMING_PROPS, each checked in its own file below).
 *
 * WHAT NEEDS NONE (REVIEWED): a composer's own Send (the person wrote the
 * message and pressed Send); a dedicated dialog the person opened to do
 * exactly this, which already says what happens (reason picker, reassign
 * picker, typed name); undoable toggles; internal bookkeeping. Each entry
 * names the file, the procedure, how many of its calls are exempt and why;
 * a count that stops matching fails, so a new one-click call cannot hide
 * behind an old exemption. A single AI call a person asked for, whose result
 * comes back for review (suggest, draft, summarise), is not in scope.
 *
 * The second half: a confirmation guarding a bulk change states its number
 * as a typed `count`, and one guarding a spend states its `cost` (U5: "nothing
 * makes a dialog state count and cost").
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { confirmFactLines, consequenceLine, countLine } from "@shared/confirmFacts";
import { costText, paidLookupText, aiCallText, enrichFullyText, areEnrichText, areGenerateText, AI_PIPELINE_CALLS_PER_CONTACT } from "@shared/spendPreview";
import { ConfirmFactList } from "../client/src/components/usip/Common";

const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client", "src");

/* ───────────────────────────── the scanner ───────────────────────────── */

/** Procedures whose last segment makes them a delete, send or bulk change. */
const DESTRUCTIVE_PROC =
  /^(delete|remove|archive|purge|clear|trash|moveToTrash|discard|disconnect|unlink|revoke|deactivate|withdraw|cancel|exit|unenroll|destroy|wipe|send(?!grid)|bulk|knowledgeRemove|sessionRemove|signOutEverywhere|disableTotp|resetMemberMfa|transferOwnership|approveAndSend)|All[A-Z]|All$|Bulk$/;
/** Procedures that spend vendor credits, or AI calls for many rows at once. */
const SPEND_PROC =
  /^(enrich|reEnrich|verify|recomputeAll|reEvaluateAll|runBulk|analyzeAll|generateDrafts|runForList|runBatch|regenerateAll|triggerReverify)/;
/** A variable named for what it destroys, whatever its procedure is called. */
const DESTRUCTIVE_VAR = /^(del|delete|remove|archive|destroy|purge|trash)([A-Z]|$)/;
/** Arguments that make an update a delete. */
const DESTRUCTIVE_ARG = /status:\s*"(removed|archived|deleted|cancelled|canceled)"|archived:\s*true|deleted:\s*true/;
/** Bulk changes: their confirmation must state a typed count. */
// `setAll…` switches a workspace setting that also sets the default for campaigns
// not made yet, so a count of today's campaigns would misstate it.
const BULK_PROC = /^bulk|^(?!setAll)[a-z]\w*All([A-Z]|$)|Bulk$|^removeMembers$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Index just past a string or comment starting at i, or -1 if there is none. */
function skipNonCode(s: string, i: number): number {
  const c = s[i];
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < s.length && s[j] !== c) { if (s[j] === "\\") j++; j++; }
    return j + 1;
  }
  if (c === "/" && s[i + 1] === "/") { let j = i; while (j < s.length && s[j] !== "\n") j++; return j; }
  if (c === "/" && s[i + 1] === "*") { const j = s.indexOf("*/", i + 2); return j < 0 ? s.length : j + 2; }
  return -1;
}

/** Index of the bracket closing the one at openIdx. */
function matchClose(s: string, openIdx: number): number {
  const open = s[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const k = skipNonCode(s, i);
    if (k >= 0) { i = k; continue; }
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** End of the JSX opening tag that starts at `<`. */
function jsxTagEnd(s: string, lt: number): number {
  let i = lt + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "{") { const e = matchClose(s, i); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '"' || c === "'") { i = skipNonCode(s, i); continue; }
    if (c === ">") return i;
    i++;
  }
  return -1;
}

type Span = { start: number; end: number; via: string };

/**
 * Components that confirm inside before calling a prop: a call handed to that
 * prop is confirmed. Each is checked in its own file by the test below.
 */
const CONFIRMING_PROPS: Array<{ component: string; prop: string; file: string }> = [
  { component: "DrawerTimeline", prop: "onDelete", file: "components/usip/detail/DrawerTimeline.tsx" },
  { component: "QuotaCard", prop: "onRemove", file: "pages/usip/Quota.tsx" },
];

function confirmSpans(src: string): Span[] {
  const spans: Span[] = [];
  const fns = new Set(["confirmAction", "confirmPaidLookup"]);
  for (const m of Array.from(src.matchAll(/const\s+(\w+)\s*=\s*use(?:Confirm|ConfirmActivate|ConfirmAutoEnrol)\(\)/g))) fns.add(m[1]);
  for (const name of Array.from(fns)) {
    const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g");
    for (const m of Array.from(src.matchAll(re))) {
      const open = src.indexOf("(", m.index! + name.length);
      const close = matchClose(src, open);
      if (close > 0) spans.push({ start: open, end: close, via: name });
    }
  }
  const tags = ["ConfirmButton", "AlertDialogAction"];
  for (const tag of tags) {
    for (const m of Array.from(src.matchAll(new RegExp(`<${tag}\\b`, "g")))) {
      const end = jsxTagEnd(src, m.index!);
      if (end > 0) spans.push({ start: m.index!, end, via: tag });
    }
  }
  // A local wrapper (`const askThen = (n, go) => { …confirmPaidLookup(…, go) }`)
  // is a confirm function when the callback it takes is only ever run inside
  // a confirm call in its own body.
  for (const f of namedFns(src)) {
    if (!/^(ask|confirm)/i.test(f.name) || fns.has(f.name)) continue;
    const body = src.slice(f.start, f.end);
    const open = body.indexOf("(", f.declAt - f.start + f.name.length);
    const params = open > 0 ? body.slice(open + 1, matchClose(body, open)) : "";
    const last = (params.split(",").pop() ?? "").trim().split(/[:\s=]/)[0];
    if (!last) continue;
    const inner = spans.filter((s) => s.start > f.start && s.end < f.end);
    const uses = Array.from(body.matchAll(new RegExp(`(?<![\\w.])${last}\\b`, "g"))).map((m) => f.start + m.index!).filter((i) => i > f.start + open + params.length + 1);
    if (uses.length && uses.every((u) => inner.some((s) => u > s.start && u < s.end))) {
      for (const m of Array.from(src.matchAll(new RegExp(`(?<![\\w.])${f.name}\\s*\\(`, "g")))) {
        if (m.index! >= f.start && m.index! < f.end) continue;
        const o = src.indexOf("(", m.index! + f.name.length);
        spans.push({ start: o, end: matchClose(src, o), via: f.name });
      }
    }
  }
  for (const { component, prop } of CONFIRMING_PROPS) {
    for (const m of Array.from(src.matchAll(new RegExp(`<${component}\\b`, "g")))) {
      const end = jsxTagEnd(src, m.index!);
      if (end < 0) continue;
      const tag = src.slice(m.index!, end);
      const at = tag.search(new RegExp(`\\b${prop}=\\{`));
      if (at < 0) continue;
      const open = m.index! + at + prop.length + 1;
      spans.push({ start: open, end: matchClose(src, open), via: `${component}.${prop}` });
    }
  }
  return spans;
}

type Fn = { name: string; start: number; end: number; declAt: number };

/** `const name = (…) => …`, `const name = useCallback(…)`, `function name(…) {…}`. */
function namedFns(src: string): Fn[] {
  const out: Fn[] = [];
  const arrow = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:useCallback\(\s*)?(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|\w+)\s*(?::\s*[^=;]+)?=>\s*/g;
  for (const m of Array.from(src.matchAll(arrow))) {
    const body = m.index! + m[0].length;
    let end: number;
    if (src[body] === "{" || src[body] === "(") end = matchClose(src, body);
    else {
      let i = body;
      let depth = 0;
      while (i < src.length) {
        const k = skipNonCode(src, i);
        if (k >= 0) { i = k; continue; }
        const c = src[i];
        if ("({[".includes(c)) depth++;
        else if (")}]".includes(c)) { if (depth === 0) break; depth--; }
        else if ((c === ";" || c === "\n") && depth === 0) break;
        i++;
      }
      end = i;
    }
    if (end > 0) out.push({ name: m[1], start: m.index!, end, declAt: src.indexOf(m[1], m.index!) });
  }
  for (const m of Array.from(src.matchAll(/function\s+(\w+)\s*\(/g))) {
    const p = src.indexOf("(", m.index!);
    const pc = matchClose(src, p);
    const b = src.indexOf("{", pc);
    const be = b > 0 ? matchClose(src, b) : -1;
    if (be > 0) out.push({ name: m[1], start: m.index!, end: be, declAt: src.indexOf(m[1], m.index!) });
  }
  return out;
}

/** The confirm a call sits behind (for a named function, the one around its first use), or null. */
function confirmedAt(src: string, at: number, spans: Span[], fns: Fn[], depth = 0): Span | null {
  const direct = spans.find((s) => at > s.start && at < s.end);
  if (direct) return direct;
  if (depth > 3) return null;
  // The innermost named function around the call; a component (Capitalised) is not one.
  const encl = fns.filter((f) => at > f.start && at < f.end && /^[a-z_]/.test(f.name)).sort((x, y) => y.start - x.start)[0];
  if (!encl) return null;
  const refs = Array.from(src.matchAll(new RegExp(`(?<![\\w.])${encl.name}\\b`, "g"))).map((m) => m.index!).filter((i) => i !== encl.declAt);
  if (refs.length === 0) return null;
  const via = refs.map((r) => confirmedAt(src, r, spans, fns, depth + 1));
  return via.every(Boolean) ? via[0] : null;
}

type Call = { rel: string; line: number; proc: string; key: string; confirmed: Span | null; spend: boolean; bulk: boolean };

function collect(): Call[] {
  const calls: Call[] = [];
  for (const file of sourceFiles(CLIENT)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(CLIENT.length + 1).split(sep).join("/");
    const spans = confirmSpans(src);
    const fns = namedFns(src);
    const decls = Array.from(src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*trpc\.([\w.]+)\.useMutation\(/g))
      .map((m) => ({ v: m[1], proc: m[2], at: m.index! }));
    for (const { v, proc, at } of decls) {
      const last = proc.split(".").pop()!;
      const spend = SPEND_PROC.test(last);
      const byName = DESTRUCTIVE_PROC.test(last) || DESTRUCTIVE_VAR.test(v) || spend;
      // Two components in one file can name their mutations alike: a call
      // belongs to the nearest declaration of its name above it.
      const same = decls.filter((d) => d.v === v);
      const owner = (i: number) => same.filter((d) => d.at < i).pop() ?? same[0];
      for (const c of Array.from(src.matchAll(new RegExp(`(?<![\\w.])${v}\\.(mutate|mutateAsync)\\b`, "g")))) {
        if (owner(c.index!).at !== at) continue;
        const open = src.indexOf("(", c.index!);
        const args = open > 0 && open <= c.index! + v.length + 13 ? src.slice(open, matchClose(src, open)) : "";
        if (!byName && !DESTRUCTIVE_ARG.test(args)) continue;
        calls.push({
          rel,
          line: src.slice(0, c.index!).split("\n").length,
          proc,
          key: `${rel}::${proc}`,
          confirmed: confirmedAt(src, c.index!, spans, fns),
          spend,
          bulk: BULK_PROC.test(last),
        });
      }
    }
  }
  return calls;
}

/* ───────────────────────── reviewed exemptions ───────────────────────── */

const COMPOSER = "a composer's own Send: the person wrote this message and pressed Send";
const OWN_DIALOG = "a dialog the person opened for exactly this, which says what happens next to its button";

/** `rel::procedure` → how many of its calls run unconfirmed, and why that is right. */
const REVIEWED: Record<string, { calls: number; reason: string }> = {
  // Sends a person wrote.
  "components/usip/RecordDrawer.tsx::leads.sendAdHocEmail": { calls: 1, reason: COMPOSER },
  "components/usip/RecordDrawer.tsx::contacts.sendAdHocEmail": { calls: 1, reason: COMPOSER },
  "components/usip/detail/LinkedInActionsPanel.tsx::unipile.sendLinkedInInvite": { calls: 1, reason: COMPOSER },
  "components/usip/detail/LinkedInActionsPanel.tsx::unipile.sendMessage": { calls: 1, reason: COMPOSER },
  "pages/usip/Mailbox.tsx::mailbox.sendNew": { calls: 2, reason: `${COMPOSER} (a new message and a forward)` },
  "pages/usip/Mailbox.tsx::mailbox.sendReply": { calls: 1, reason: COMPOSER },
  "pages/usip/UnifiedInbox.tsx::unipile.sendMessage": { calls: 1, reason: COMPOSER },
  "pages/ChatPage.tsx::chatAgents.send": { calls: 1, reason: "a website visitor's own chat message on the public chat page" },
  "pages/usip/Leads.tsx::leads.sendAdHocEmailBulk": { calls: 1, reason: `one lead is ${COMPOSER}; several go through a confirm with the count first (sendAll)` },

  // Dedicated dialogs that already say what happens.
  "components/usip/AddToMenu.tsx::sequences.bulkEnroll": { calls: 1, reason: "Confirm sits under the menu's own review, which states how many people, the sequence and what each step does (F36)" },
  "components/usip/SequenceEnrollDialog.tsx::sequences.bulkEnroll": { calls: 1, reason: `${OWN_DIALOG}: the enrol dialog shows how many are selected beside Enrol` },
  "components/usip/BatchPhotoUpload.tsx::prospects.bulkUploadProfileImages": { calls: 1, reason: `${OWN_DIALOG}: every photo is listed beside the person it goes to` },
  "components/usip/emails/DraftEditorTools.tsx::aiPipeline.runBulk": { calls: 1, reason: `${OWN_DIALOG}: AI compose lists each contact and states the AI calls (ConfirmFactList) beside Generate` },
  "components/usip/settings/GuidedMailboxSetup.tsx::sendingAccounts.bulkCreateSmtp": { calls: 1, reason: "connects the mailboxes from the CSV the wizard has just previewed; nothing is deleted or sent" },
  "components/usip/settings/SocialAccountsSection.tsx::unipile.disconnectAccount": { calls: 1, reason: `${OWN_DIALOG} (pendingDisconnect)` },
  "pages/usip/AREApprovals.tsx::are.prospects.bulkReject": { calls: 1, reason: `${OWN_DIALOG}: "Reject N prospects?" with the reason picker and how to restore them` },
  "pages/usip/EmailSuppressions.tsx::emailSuppressions.remove": { calls: 1, reason: `${OWN_DIALOG}: "Remove Suppression?" says sending to the address is re-enabled` },
  "pages/usip/ProposalDetail.tsx::proposals.sendToClient": { calls: 1, reason: `${OWN_DIALOG}: Send Proposal previews the email and says it marks the proposal Sent and emails the link` },
  "pages/usip/Proposals.tsx::proposals.bulkSetExpiry": { calls: 2, reason: `${OWN_DIALOG}: Set Expiry states how many proposals and what an expiry does (set and clear)` },
  "pages/usip/Segments.tsx::segments.delete": { calls: 1, reason: `${OWN_DIALOG}: the delete dialog says it is permanent and the people stay` },
  "pages/usip/Team.tsx::team.sendPasswordReset": { calls: 1, reason: `${OWN_DIALOG} (pwTarget)` },
  "pages/usip/Team.tsx::team.deactivate": { calls: 1, reason: `${OWN_DIALOG}, with the picker for who takes over their records` },
  "pages/usip/Team.tsx::team.delete": { calls: 1, reason: `${OWN_DIALOG}, with the picker for who takes over their records` },
  "pages/usip/Team.tsx::team.bulkDeactivate": { calls: 1, reason: `${OWN_DIALOG}, with the count and the picker for who takes over` },
  "pages/usip/Settings.tsx::dangerZone.removeSampleData": { calls: 1, reason: "the danger zone's inline panel says how many sample records are deleted for good before its Delete button" },
  "pages/usip/Settings.tsx::dangerZone.archiveWorkspace": { calls: 1, reason: "the person must type ARCHIVE first" },
  "pages/usip/SettingsHub.tsx::profile.disableTotp": { calls: 1, reason: `${OWN_DIALOG}: turning two-step sign-in off needs a current code or the password` },
  "pages/usip/SettingsPipelines.tsx::crmPipelines.deleteStage": { calls: 1, reason: `${OWN_DIALOG}: it names the deals in the stage and where they move` },
  "pages/usip/SettingsPipelines.tsx::crmPipelines.deletePipeline": { calls: 1, reason: `${OWN_DIALOG}: it names where the pipeline's deals move` },

  // Undoable, free or bookkeeping.
  "components/usip/AreBulkActionBar.tsx::are.prospects.bulk": { calls: 7, reason: "run() is reached without a dialog only for an action with neither confirm nor params; which ones those are is pinned below (skip, pause, link to People, and Pending's Generate)" },
  "components/usip/people/SelectionToolbar.tsx::tasks.bulkCreateForProspects": { calls: 1, reason: "the task form the person filled in for the rows they ticked; the all-matching path confirms with a count" },
  "pages/usip/Companies.tsx::companies.enrichSelection": { calls: 1, reason: "company enrichment calls no vendor and no AI (services/company/enrichmentService.ts): nothing is spent, nothing is lost" },
  "pages/usip/CompanyProfile.tsx::companies.enrich": { calls: 1, reason: "company enrichment calls no vendor and no AI (services/company/enrichmentService.ts): nothing is spent, nothing is lost" },
  "pages/usip/CompanyProfile.tsx::companies.removeBrandOverride": { calls: 1, reason: "Unpin is undone by the Pin… button that takes its place" },
  "pages/usip/Inbox.tsx::notifications.markAllRead": { calls: 1, reason: "marks the person's own notifications read; nothing is deleted" },
  "pages/usip/ListDetail.tsx::recordLists.removeMember": { calls: 1, reason: "takes one row off a list; nobody is deleted and Add to list puts them back" },
  "pages/usip/Mailbox.tsx::mailbox.moveToTrash": { calls: 1, reason: "moves the message to the mailbox's own Trash, from which it can be restored" },
  "pages/usip/MeetingsV2.tsx::meetings.regenerateAllProposals": { calls: 1, reason: "Continue carries on a pass the person confirmed with Rewrite all, whose confirm stated the AI calls for the whole pass" },
  "pages/usip/People.tsx::savedSearches.clearApplied": { calls: 1, reason: "bookkeeping: forgets which saved view was applied last; nothing is deleted" },
  "pages/usip/PipelineAlerts.tsx::pipelineAlerts.sendDigest": { calls: 1, reason: "an internal digest to the workspace owner; no prospect is emailed" },
  "pages/usip/WorkflowsV2.tsx::are.campaigns.setAllAutonomy": { calls: 2, reason: "both set engine autonomy DOWN to batch approval, the safe direction; Full autonomy goes through a confirm" },

  // Cancel task closes it and keeps it in the history, where Reopen brings
  // it back (CONB, R72): undoable. TasksV2 is the task page; Tasks.tsx keeps
  // RelatedTasks for record pages (its own page is unrouted since CONB).
  "pages/usip/TasksV2.tsx::tasks.setStatus": { calls: 1, reason: "Cancel task keeps it in the history and Reopen brings it back: undoable" },
  "pages/usip/Tasks.tsx::tasks.setStatus": { calls: 2, reason: "Cancel keeps the task in the history and Reopen brings it back: undoable (RelatedTasks, and the page unrouted since CONB)" },
  // Unrouted since CONB (/v2/deals → /pipeline through RetiredRedirect): its
  // survivor, Pipeline, asks before Analyze with AI, with the count and cost.
  "pages/usip/DealsV2.tsx::deals.analyzeAll": { calls: 1, reason: "DealsV2 is unrouted since CONB; Pipeline, which replaced it, confirms Analyze with AI with a typed count and cost" },
};


/**
 * The bulk bar's actions that run on one click (no confirm, no params): each
 * is undoable or adds nothing outward. Pending's Generate is the owner's ask
 * of 2026-08-19 ("mass generate sequences for those in Pending": no prompt).
 */
const ONE_CLICK_BULK_ACTIONS = ["generateSequence", "linkToPeople", "pauseSequence", "skip"];

/* ─────────────────────────────── tests ─────────────────────────────── */

describe("every send, spend, delete and bulk change asks first (U5, X1.8)", () => {
  const calls = collect();

  it("finds the destructive calls at all (guards the scanner)", () => {
    expect(calls.length).toBeGreaterThan(180);
    // Calls the 2026-10-20 audit named, found by the scanner.
    for (const k of ["pages/usip/Calendar.tsx::calendar.deleteEvent", "pages/usip/Snippets.tsx::snippets.delete", "pages/usip/PromptTemplates.tsx::promptTemplates.delete", "components/usip/MicrosoftGraph.tsx::graph.removeFile"]) {
      expect(calls.map((c) => c.key), k).toContain(k);
    }
  });

  it("every one is confirmed or reviewed", () => {
    const unconfirmed = new Map<string, Call[]>();
    for (const c of calls.filter((x) => !x.confirmed)) unconfirmed.set(c.key, [...(unconfirmed.get(c.key) ?? []), c]);
    const offenders: string[] = [];
    for (const [key, list] of Array.from(unconfirmed)) {
      const r = REVIEWED[key];
      if (!r || r.calls !== list.length) offenders.push(`${list.map((c) => `${c.rel}:${c.line}`).join(", ")}  ${list[0].proc}${r ? ` (REVIEWED says ${r.calls}, found ${list.length})` : ""}`);
    }
    expect(
      offenders,
      offenders.length
        ? `\n\n${offenders.length} destructive call(s) run on one click. Wrap each in confirmAction({ title, count, cost, consequence }, () => …) or a <ConfirmButton>, or add a reviewed entry with its reason:\n\n${offenders.join("\n")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("has no stale reviewed entries", () => {
    const live = new Set(calls.filter((c) => !c.confirmed).map((c) => c.key));
    expect(Object.keys(REVIEWED).filter((k) => !live.has(k))).toEqual([]);
  });

  it("every reviewed entry says why", () => {
    for (const [k, r] of Object.entries(REVIEWED)) expect(r.reason.length, k).toBeGreaterThan(20);
  });

  it("a component trusted to confirm a prop does confirm it", () => {
    for (const { component, prop, file } of CONFIRMING_PROPS) {
      const src = readFileSync(join(CLIENT, file), "utf8");
      const at = src.search(new RegExp(`function ${component}\\(`));
      expect(at, `${file} defines ${component}`).toBeGreaterThan(-1);
      // The component's body, after its parameter list: every use of the prop
      // (a call or a handler reference) sits inside a confirm.
      const params = src.indexOf("(", at);
      const body = src.indexOf("{", matchClose(src, params));
      const end = matchClose(src, body);
      const spans = confirmSpans(src);
      const uses = Array.from(src.slice(body, end).matchAll(new RegExp(`(?<![\\w.])${prop}\\b`, "g"))).map((m) => body + m.index!);
      expect(uses.length, `${file}: ${component} uses ${prop}`).toBeGreaterThan(0);
      for (const u of uses) expect(spans.some((s) => u > s.start && u < s.end), `${file}: ${prop} at line ${src.slice(0, u).split("\n").length} is not confirmed`).toBe(true);
    }
  });

  it("the bulk bar runs on one click only the reviewed actions", () => {
    const page = readFileSync(join(CLIENT, "pages/usip/ARECampaignDetail.tsx"), "utf8");
    const defs = Array.from(page.matchAll(/\{ key: "(\w+)", label: [^\n]*/g)).map((m) => ({ key: m[1], line: m[0] }));
    expect(defs.length).toBeGreaterThan(20);
    const oneClick = Array.from(new Set(defs.filter((d) => !/\b(confirm|params):/.test(d.line)).map((d) => d.key))).sort();
    expect(oneClick).toEqual(ONE_CLICK_BULK_ACTIONS);
    // Activate is defined over several lines, with its own confirm.
    expect(page).toMatch(/key: "activateSequence"[\s\S]{0,400}?confirm: \{/);
  });

  it("the AI pipeline's per-contact cost matches the calls it makes", () => {
    const router = readFileSync(join(ROOT, "server/routers/aiPipeline.ts"), "utf8");
    const fn = router.slice(router.indexOf("export async function runPipelineForContact("), router.indexOf("export const aiPipelineRouter"));
    expect(fn.length).toBeGreaterThan(1000);
    // Three research calls, then one draft call inside a loop over the tones.
    const calls = fn.split("await invokeLLM(").length - 1;
    const tones = (fn.match(/\{ tone: "/g) ?? []).length;
    expect(calls).toBe(4);
    expect(tones).toBe(3);
    expect(AI_PIPELINE_CALLS_PER_CONTACT).toBe(3 + tones);
  });
});

describe("a confirmation states the count of a bulk change and the cost of a spend (U5)", () => {
  const calls = collect();
  const direct = calls.filter((c): c is Call & { confirmed: Span } => !!c.confirmed);
  const spanText = (c: Call & { confirmed: Span }) => {
    const src = readFileSync(join(CLIENT, c.rel), "utf8");
    return src.slice(c.confirmed.start, c.confirmed.end);
  };

  it("a bulk change's confirmation passes a typed count", () => {
    const missing = direct
      .filter((c) => c.bulk && (c.confirmed.via === "confirmAction" || c.confirmed.via === "ConfirmButton"))
      .filter((c) => !/\bcount(:|=\{)/.test(spanText(c)))
      .map((c) => `${c.rel}:${c.line} ${c.proc}`);
    expect(missing, `\n${missing.join("\n")}\n`).toEqual([]);
  });

  it("a spend's confirmation passes a typed cost", () => {
    const missing = direct
      .filter((c) => c.spend && (c.confirmed.via === "confirmAction" || c.confirmed.via === "ConfirmButton"))
      .filter((c) => !/\bcost(:|=\{)/.test(spanText(c)))
      .map((c) => `${c.rel}:${c.line} ${c.proc}`);
    expect(missing, `\n${missing.join("\n")}\n`).toEqual([]);
  });
});

describe("the confirmation words its facts (U5)", () => {
  it("count, cost and consequence each become one sentence, in that order", () => {
    expect(confirmFactLines({
      count: { n: 12, one: "person", many: "people" },
      cost: { kind: "free" },
      consequence: { kind: "permanent" },
    })).toEqual([
      "This applies to 12 people.",
      "This spends no vendor credits and makes no AI calls.",
      "This cannot be undone.",
    ]);
    expect(confirmFactLines({})).toEqual([]);
  });

  it("a count is a number with the right noun", () => {
    expect(countLine({ n: 1, one: "draft" })).toBe("This applies to 1 draft.");
    expect(countLine({ n: 1200, one: "draft" })).toBe("This applies to 1,200 drafts.");
    expect(countLine({ n: 3, one: "person", many: "people" })).toBe("This applies to 3 people.");
  });

  it("each consequence says what happens after", () => {
    expect(consequenceLine({ kind: "permanent", what: "The event" })).toBe("The event is deleted for good. This cannot be undone.");
    expect(consequenceLine({ kind: "reversible", undo: "restore it from People → Archived." })).toBe("You can undo this: restore it from People → Archived.");
    expect(consequenceLine({ kind: "sends", channel: "email", n: 1 })).toBe("1 email goes out now, subject to the workspace's outbound pause and send caps. A sent message cannot be recalled.");
    expect(consequenceLine({ kind: "sends", channel: "report email", n: 3 })).toBe("3 report emails go out now, subject to the workspace's outbound pause and send caps. A sent message cannot be recalled.");
    expect(consequenceLine({ kind: "sends", channel: "email", n: 0 })).toBe("Nothing is sent.");
    expect(consequenceLine({ kind: "stops", what: "Re-scoring", kept: "Leads scored so far keep their new scores." })).toBe("Re-scoring stops now. Leads scored so far keep their new scores.");
    expect(consequenceLine({ kind: "access", who: "Anyone holding this link" })).toBe("Anyone holding this link loses access straight away.");
    expect(consequenceLine({ kind: "access", who: "These 3 members", many: true })).toBe("These 3 members lose access straight away.");
  });

  it("a cost is worded by the spend preview's own functions, from its price tables", () => {
    const ai = { used: 1000, cap: 50_000 };
    expect(costText({ kind: "ai", calls: 4, ai, what: "to rewrite them" })).toBe(aiCallText(4, ai, "to rewrite them"));
    expect(costText({ kind: "paidLookup", vendor: "Reoon", count: 40, unit: "bulk credit" })).toBe(paidLookupText({ vendor: "Reoon", count: 40, unit: "bulk credit" }));
    expect(costText({ kind: "enrichFully", people: 5 })).toBe(enrichFullyText(5));
    expect(costText({ kind: "areEnrich", people: 5 })).toBe(areEnrichText(5));
    expect(costText({ kind: "areGenerate" })).toBe(areGenerateText());
  });

  it("the dialog renders the facts as a list, and nothing when there are none", () => {
    const html = renderToStaticMarkup(createElement(ConfirmFactList, { count: { n: 2, one: "schedule" }, consequence: { kind: "permanent" } }));
    expect(html).toBe('<ul data-confirm-facts="" class="space-y-1 text-left text-sm text-muted-foreground"><li>This applies to 2 schedules.</li><li>This cannot be undone.</li></ul>');
    expect(renderToStaticMarkup(createElement(ConfirmFactList, {}))).toBe("");
  });

  it("both entry points take the facts and show them", () => {
    const common = readFileSync(join(CLIENT, "components/usip/Common.tsx"), "utf8");
    expect(common).toMatch(/export type ConfirmOptions = ConfirmFacts & \{/);
    expect(common).toContain("{opts && <ConfirmFactList count={opts.count} cost={opts.cost} consequence={opts.consequence} />}");
    const button = common.slice(common.indexOf("export function ConfirmButton("), common.indexOf("export function Section("));
    expect(button).toContain("}: ConfirmFacts & {");
    expect(button).toContain("<ConfirmFactList count={count} cost={cost} consequence={consequence} />");
  });
});
