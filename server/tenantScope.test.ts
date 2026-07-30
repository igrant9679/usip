/**
 * A destructive statement must not be reachable with someone else's id.
 *
 * This guard started life inside quoteTotals.test.ts, scoped to one router,
 * written for ONE bug: `quotes.delete` ran
 * `delete(quoteLineItems).where(eq(quoteId, input.id))` first, unscoped, so any
 * authenticated user could strip every line item off any workspace's quote — and
 * the call returned ok:true, because the `quotes` delete beside it WAS scoped and
 * simply matched nothing. On its first run it immediately found a second instance
 * (`dashboards.delete`, identical shape, whose comment showed the ROLE gate had
 * been considered and the TENANT boundary had not).
 *
 * Run over all of `server/` it found FOUR more, in two flavours:
 *
 *   • **Verify parent A, delete child B, where B is a separate caller-supplied
 *     id.** `calendar.deleteEvent` verified `accountId` and then deleted
 *     `calendarEvents` by `input.dbId` — pass your own account with another
 *     workspace's event id and their row went. `proposals.deleteMilestone` did
 *     the same with `proposalId` + `milestoneId`. A parent check is only a check
 *     when the child is tied to that parent.
 *   • **The quotes.delete shape, twice more.** `tours.deleteTour` and
 *     `tours.delete` (two near-identical procedures) each deleted `tourSteps` by
 *     caller-supplied `tourId` with no filter and no ownership check, before a
 *     correctly-scoped parent delete that no-oped.
 *
 * 10 of the 14 flagged sites were false positives — a workspace-scoped ownership
 * select preceded them. Every one was read before being believed, and the four
 * real ones were the minority.
 *
 * THE RULE: a destructive statement whose WHERE is driven by caller input must
 * either filter on `workspaceId`, or be named below with the reason it is safe.
 * Deliberately not heuristic — "there seems to be a check above it" is the same
 * reasoning that wrote the bugs, so a test applying it would agree with the code
 * by construction. Where the table HAS a workspaceId column, the fix is to add
 * it rather than to earn an entry here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

interface Site {
  /** `file::table::where` — stable across line shifts, unlike a line number. */
  key: string;
  rel: string;
  table: string;
  where: string;
  /** From RAW source: line numbers taken from comment-stripped text are wrong. */
  line: number;
}

/**
 * Statement finder for both kinds.
 *
 * The WHERE is extracted by BALANCING PARENS from `.where(`, not by regex: an
 * update's `.set({...})` nests braces and parens, and a bounded regex silently
 * captured the wrong text. Updates additionally require a `.set(` in the same
 * statement — without that, `createHash().update(x).digest()` matches, which is
 * exactly what 8 of the first 530 "update" hits turned out to be.
 */
function collectSites(
  kind: "delete" | "update",
  opts: { wherelessOnly?: boolean } = {},
): { sites: Site[]; files: number; statements: number } {
  const files = sourceFiles(join(ROOT, "server"));
  const sites: Site[] = [];
  let statements = 0;
  const call = `.${kind}(`;
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).split(sep).join("/");
    const raw = readFileSync(f, "utf8");
    const src = stripComments(raw);
    const nth = new Map<string, number>();
    // Doubled escapes: this is a TEMPLATE LITERAL, where `\.` collapses to `.`
    // and `\w` to `w`. Getting that wrong made the pattern `.delete((w+))`,
    // which matched nothing at all — and a scanner that finds nothing looks
    // exactly like a codebase with no problem. The floor assertions below are
    // what caught it.
    for (const m of src.matchAll(new RegExp(`\\.${kind}\\((\\w+)\\)`, "g"))) {
      const table = m[1];
      const semi = src.indexOf(";", m.index! + m[0].length);
      const stmt = src.slice(m.index! + m[0].length, semi > 0 ? semi : m.index! + 1500).slice(0, 2500);
      if (kind === "update" && !stmt.includes(".set(")) continue; // not a Drizzle update
      statements++;
      const n = (nth.get(table) ?? 0) + 1;
      nth.set(table, n);
      let idx = -1;
      for (let k = 0; k < n; k++) idx = raw.indexOf(`${call}${table})`, idx + 1);
      const line = idx >= 0 ? raw.slice(0, idx).split(String.fromCharCode(10)).length : 0;

      const wAt = stmt.indexOf(".where(");
      if (wAt < 0) {
        if (opts.wherelessOnly) sites.push({ key: `${rel}::${table}::<no where>`, rel, table, where: "<no where>", line });
        continue;
      }
      if (opts.wherelessOnly) continue;
      let depth = 0, end = -1;
      for (let i = wAt + ".where".length; i < stmt.length; i++) {
        if (stmt[i] === "(") depth++;
        else if (stmt[i] === ")" && --depth === 0) { end = i; break; }
      }
      if (end < 0) continue;
      const where = stmt.slice(wAt + ".where(".length, end).split(/\s+/).join(" ").trim();
      // Only statements a caller can steer are interesting: one keyed on a
      // constant or an internal id cannot be aimed at another tenant.
      if (!/input\.\w+/.test(where)) continue;
      if (/workspaceId/.test(where)) continue;
      // `ctx.user.id` is session-derived, not caller input — a per-user boundary
      // (e.g. "my own profile row") is a boundary.
      if (/ctx\.user\.id/.test(where)) continue;
      sites.push({ key: `${rel}::${table}::${where}`, rel, table, where, line });
    }
  }
  return { sites, files: files.length, statements };
}

/**
 * Statements that may stay unscoped by workspace, with the reason. Every entry
 * here is a CHILD table with no workspaceId column of its own, whose parent is
 * verified against the workspace in the same procedure — so the parent id IS the
 * tenant boundary rather than a redundant second one.
 */
const ALLOWED: Record<string, string> = {
  "server/routers/proposals.ts::proposalMilestones::and( eq(proposalMilestones.id, input.milestoneId), eq(proposalMilestones.proposalId, input.proposalId), )":
    "deleteMilestone — getProposalOrThrow(proposalId, workspace) above, and the milestone is tied to that proposal. proposal_milestones has no workspaceId column.",
  "server/routers/proposals.ts::proposalMilestones::eq(proposalMilestones.proposalId, input.id)":
    "proposals.delete cascade — getProposalOrThrow(input.id, workspace) above and the cascade keys on that same verified id. No workspaceId column.",
  "server/routers/proposals.ts::proposalSections::eq(proposalSections.proposalId, input.id)":
    "Same cascade, same verified parent id. No workspaceId column.",
  "server/routers/proposals.ts::proposalFeedback::eq(proposalFeedback.proposalId, input.id)":
    "Same cascade, same verified parent id. No workspaceId column.",
  "server/routers/tours.ts::tourSteps::and(eq(tourSteps.id, input.stepId), eq(tourSteps.tourId, input.tourId))":
    "deleteStep — the tour is verified against the workspace immediately above and the step is tied to it. tour_steps has no workspaceId column.",
};

describe("no destructive statement can be aimed at another tenant", () => {
  const { sites, files, statements } = collectSites("delete");

  it("finds source and statements to scan (guards the scanner itself)", () => {
    // Three separate scans in this repo have returned ~0 hits and looked like a
    // clean codebase; all three were broken. Assert a floor on both dimensions.
    expect(files).toBeGreaterThan(150);
    expect(statements).toBeGreaterThan(100);
  });

  it("every caller-steerable delete is workspace-scoped or explicitly excused", () => {
    const offenders = sites
      .filter((s) => !(s.key in ALLOWED))
      .map((s) => `${s.rel}:${s.line} delete(${s.table}) — where: ${s.where}`);
    expect(
      offenders,
      offenders.length
        ? `\n\nDestructive statement(s) keyed on caller input with no workspace filter:\n  ${offenders.join("\n  ")}\n\n` +
            `Add eq(<table>.workspaceId, ctx.workspace.id) to the WHERE. If the table has\n` +
            `no workspaceId column, verify its parent in the same procedure, key the\n` +
            `delete on that verified parent, and add an entry to ALLOWED saying so.\n` +
            `A tenant boundary that depends on the caller passing their own id is not a\n` +
            `boundary — and the statement still returns ok.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An allowlist with no staleness check is the "attempt marker" class: entries
    // outlive the code they excuse and the next offender inherits an exemption
    // nobody granted.
    const live = new Set(sites.map((s) => s.key));
    const stale = Object.keys(ALLOWED).filter((k) => !live.has(k));
    expect(
      stale,
      stale.length
        ? `\n\nAllowlisted but no longer present (the code changed — re-verify, don't re-add):\n  ${stale.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("every allowlisted table genuinely lacks a workspaceId column", () => {
    // The excuse is "this table cannot be scoped". If someone adds the column
    // later, the excuse expires and the statement should just be scoped.
    const schema = readFileSync(join(ROOT, "drizzle", "schema.ts"), "utf8");
    const unscopable = (table: string) => {
      const start = schema.indexOf(`export const ${table} = mysqlTable`);
      expect(start, `${table} not found in schema`).toBeGreaterThan(-1);
      const block = schema.slice(start, schema.indexOf("export const", start + 50));
      expect(block.length).toBeGreaterThan(120); // floor: real block
      return !/^\s*workspaceId:/m.test(block);
    };
    const scopable = [...new Set(Object.keys(ALLOWED).map((k) => k.split("::")[1]))]
      .filter((t) => !unscopable(t));
    expect(
      scopable,
      scopable.length
        ? `\n\nAllowlisted table(s) that DO have a workspaceId column — scope the delete instead:\n  ${scopable.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("the two originally-reported bugs stay fixed", () => {
    // Named explicitly: these are the sites the guard was written for, and a
    // regression in either should say so by name rather than as a generic hit.
    const ops = stripComments(readFileSync(join(ROOT, "server/routers/operations.ts"), "utf8"));
    for (const [table, parent] of [["quoteLineItems", "quotes"], ["dashboardWidgets", "dashboards"]]) {
      const at = ops.indexOf(`delete(${table})`);
      expect(at, table).toBeGreaterThan(-1);
      const stmt = ops.slice(at, at + 260);
      expect(stmt, table).toMatch(new RegExp(`${table}\\.workspaceId`));
      // …and the ownership check must still come FIRST, not just exist.
      const check = ops.lastIndexOf(`select({ id: ${parent}.id })`, at);
      expect(check, `${table}: ownership check must precede the delete`).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(check);
    }
  });
});

/* ─── UPDATE: the same rule, one ratchet behind ──────────────────────────── */

/**
 * An UPDATE aimed at another tenant rewrites instead of deleting — same class,
 * same blast radius. Scanned the same 223 files:
 *
 *   • **522 Drizzle update statements** (of 530 raw `.update(` matches — the
 *     other 8 are `createHash().update()`, which is why this scan requires a
 *     `.set(` in the same statement).
 *   • **0 with no WHERE at all.** Worth stating plainly: there is no
 *     update-every-row bug in this codebase.
 *   • 67 caller-steerable with no workspaceId. 11 of those are keyed on
 *     `ctx.user.id`, which is a session-derived per-user boundary rather than
 *     caller input, so the rule below does not count them.
 *   • **ONE real bug: `helpCenter.rate` had no ownership check of any kind** —
 *     `articleId` went straight into a feedback row and a counter bump, so a
 *     caller could skew the helpful/not-helpful counts of any workspace's
 *     article. Every other write to help_articles in that file is scoped.
 *
 * The remaining sites are protected by a workspace-scoped ownership select
 * earlier in the same procedure. Ten of them were read individually and are now
 * scoped on the statement too — the standard opportunityIntelligence.ts already
 * sets for itself: "workspaceId on the UPDATE so a concurrent / crafted call
 * can't mutate a different workspace's opportunity even if the prior SELECT was
 * OK."
 *
 * ⚠️ THE LIST BELOW IS A RATCHET, NOT A CERTIFICATE. These entries were
 * classified by TRIAGE — the enclosing procedure contains a workspace-scoped
 * check — and were NOT each read line by line. They are recorded so that a NEW
 * unscoped update fails immediately, and so the remainder can be burned down
 * deliberately instead of being rediscovered. Do not add to it: scope the
 * statement instead.
 */
const UPDATE_BASELINE: string[] = [
  "server/routers/admin.ts::workspaceMembers::eq(workspaceMembers.id, input.memberId)",
  "server/routers/admin.ts::workspaceMembers::eq(workspaceMembers.id, input.memberId)",
  "server/routers/admin.ts::workspaceMembers::eq(workspaceMembers.id, input.memberId)",
  "server/routers/admin.ts::workspaceMembers::eq(workspaceMembers.id, input.memberId)",
  "server/routers/admin.ts::workspaceMembers::eq(workspaceMembers.id, input.memberId)",
  "server/routers/admin.ts::workspaceMembers::eq(workspaceMembers.id, input.memberId)",
  "server/routers/aiPipeline.ts::emailDrafts::eq(emailDrafts.id, input.draftId)",
  "server/routers/aiPipeline.ts::emailDrafts::eq(emailDrafts.id, input.draftId)",
  "server/routers/are/icp.ts::icpProfiles::eq(icpProfiles.id, input.id)",
  "server/routers/are/prospects.ts::prospectIntelligence::eq(prospectIntelligence.prospectQueueId, input.prospectId)",
  "server/routers/are/prospects.ts::prospectQueue::eq(prospectQueue.id, input.prospectId)",
  "server/routers/calendar.ts::calendarAccounts::eq(calendarAccounts.id, input.accountId)",
  "server/routers/calendar.ts::calendarEvents::eq(calendarEvents.id, input.dbId)",
  "server/routers/calendar.ts::calendarEvents::eq(calendarEvents.id, input.eventId)",
  "server/routers/crm.ts::contacts::eq(contacts.id, input.id)",
  "server/routers/crm.ts::opportunities::eq(opportunities.id, input.id)",
  "server/routers/crm.ts::opportunities::eq(opportunities.id, input.id)",
  "server/routers/cs.ts::customers::eq(customers.id, input.id)",
  "server/routers/cs.ts::customers::eq(customers.id, input.id)",
  "server/routers/customFields.ts::accounts::eq(accounts.id, input.entityId)",
  "server/routers/customFields.ts::contacts::eq(contacts.id, input.entityId)",
  "server/routers/customFields.ts::leads::eq(leads.id, input.entityId)",
  "server/routers/customFields.ts::opportunities::eq(opportunities.id, input.entityId)",
  "server/routers/emailVerification.ts::contacts::eq(contacts.id, input.contactId)",
  "server/routers/helpCenter.ts::aiHelpConversations::eq(aiHelpConversations.id, input.conversationId)",
  "server/routers/mailbox.ts::unipileEmailsCache::and( eq(unipileEmailsCache.unipileAccountId, acc.unipileAccountId), eq(unipileEmailsCache.emailId, input.messageId), ),",
  "server/routers/operations.ts::campaigns::eq(campaigns.id, input.campaignId)",
  "server/routers/opportunityIntelligence.ts::stageApprovals::eq(stageApprovals.id, input.approvalId)",
  "server/routers/proposals.ts::proposalMilestones::eq(proposalMilestones.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.id)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.proposalId)",
  "server/routers/proposals.ts::proposals::eq(proposals.id, input.proposalId)",
  "server/routers/prospects.ts::prospects::eq(prospects.id, input.prospectId)",
  "server/routers/reports.ts::savedReports::eq(savedReports.id, input.id)",
  "server/routers/reports.ts::savedReports::eq(savedReports.id, input.id)",
  "server/routers/savedSections.ts::emailSavedSections::eq(emailSavedSections.id, input.id)",
  "server/routers/segments.ts::audienceSegments::eq(audienceSegments.id, input.segmentId)",
  "server/routers/sendingAccounts.ts::senderPools::eq(senderPools.id, input.poolId)",
  "server/routers/sendingAccounts.ts::sendingAccounts::eq(sendingAccounts.id, input.id)",
  "server/routers/subjectAB.ts::subjectVariants::eq(subjectVariants.id, input.variantId)",
];

describe("no UPDATE can be aimed at another tenant", () => {
  const { sites, files, statements } = collectSites("update");

  it("finds source and statements to scan (guards the scanner itself)", () => {
    expect(files).toBeGreaterThan(150);
    // 522 today. A floor well under that still catches a scan that silently
    // stops matching — which is how three scans in this repo reported a clean
    // codebase while being broken.
    expect(statements).toBeGreaterThan(400);
  });

  it("no Drizzle update runs without a WHERE clause", () => {
    // An update with no where rewrites every row in the table, in every
    // workspace, and reports success.
    const whereless = collectSites("update", { wherelessOnly: true }).sites;
    expect(whereless.map((s) => `${s.rel}:${s.line} update(${s.table})`)).toEqual([]);
  });

  it("every caller-steerable update is scoped, or in the recorded baseline", () => {
    const baseline = new Set(UPDATE_BASELINE);
    const offenders = sites
      .filter((s) => !baseline.has(s.key))
      .map((s) => `${s.rel}:${s.line} update(${s.table}) — where: ${s.where}`);
    expect(
      offenders,
      offenders.length
        ? `

Update(s) keyed on caller input with no workspace filter:
  ${offenders.join("\n  ")}

` +
            `Add eq(<table>.workspaceId, ctx.workspace.id) to the WHERE — even when a
` +
            `check above it already passed. A prior SELECT does not protect a later
` +
            `statement from a crafted or concurrent call, and this is how one
` +
            `unchecked rate() ended up writing to any workspace's article.
` +
            `Do NOT add to UPDATE_BASELINE: it records what was already there.
`
        : undefined,
    ).toEqual([]);
  });

  it("no destructive statement hides its WHERE behind a variable", () => {
    // This scan reads the ARGUMENT TEXT of .where(), so `.where(scoped)` is
    // invisible to it — the clause could be anything. Found the hard way: the
    // helpCenter fix in this very commit first hoisted its clause into a
    // `const scoped = ...`, and reintroducing the bug then left the guard GREEN.
    // A statement the guard cannot read is not a statement the guard protects,
    // so the few that exist must be named here.
    const ALIASED_OK: Record<string, string> = {
      "server/routers/are/prospects.ts::areExecutionQueue":
        "queueWhere is built immediately above with eq(workspaceId, ctx.workspace.id) as its first term and is used by the count and the update together — hoisting is what keeps those two in agreement.",
    };
    const offenders: string[] = [];
    for (const f of sourceFiles(join(ROOT, "server"))) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      const src = stripComments(readFileSync(f, "utf8"));
      // No `;` between the call and its .where — without that the window runs
      // past the end of the statement and pairs a delete with a LATER
      // statement's clause. It reported two such phantoms on its first run
      // (voiceAgents.remove and an ARE update), both of which write their
      // clause out in full.
      for (const m of src.matchAll(/\.(delete|update)\((\w+)\)([^;]{0,600}?)\.where\(([A-Za-z_$][\w$]*)\)/g)) {
        const [, kind, table, mid, arg] = m;
        if (kind === "update" && !mid.includes(".set(")) continue;
        if (`${rel}::${table}` in ALIASED_OK) continue;
        offenders.push(`${rel} ${kind}(${table}).where(${arg})`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nWHERE clause hidden behind a variable — this guard cannot read it:\n  ${offenders.join("\n  ")}\n\n` +
            `Write the clause out at the statement, or name it in ALIASED_OK with the\n` +
            `reason. An unreadable statement silently passes every check above.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the baseline only shrinks", () => {
    const live = new Set(sites.map((s) => s.key));
    const stale = UPDATE_BASELINE.filter((k) => !live.has(k));
    expect(
      stale,
      stale.length
        ? `

${stale.length} baseline entr(y/ies) no longer match — good news if you scoped them.
` +
            `Delete these lines so the list keeps shrinking:
  ${stale.join("\n  ")}
`
        : undefined,
    ).toEqual([]);
  });
});
