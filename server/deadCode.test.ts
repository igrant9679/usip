/**
 * Dead code stays dead, and what is kept says why (audit 2026-10-20, X6.1,
 * X6.2, G67; final pass 2026-11-07).
 *
 * Three registries, each recomputed from the tree on every run:
 *
 *   1. MODULES. Every module under client/src, server and shared is imported
 *      by something that is not a test, or is in KEPT_MODULES with its reason.
 *      The Manus template helpers (dataApi, imageGeneration, map,
 *      voiceTranscription, manusTypes, the Map component), useStreamLLM and
 *      shared/types.ts were imported by nothing and are deleted.
 *
 *   2. PROCEDURES. Every tRPC procedure with no call site in client/src is in
 *      NO_CLIENT_CALLER with the reason it stays: something else calls it (the
 *      assistant's catalog, a stream route), it is an operator API, it is the
 *      back end of a screen not built yet, or it sits in an area another batch
 *      had in flight. 66 procedures with no caller anywhere were deleted on
 *      2026-11-07 (the legacy Broadcasts writes, dashboardLayouts, the URL
 *      scraper, workspace.switch and others). A new procedure nobody calls
 *      fails here until it is wired or recorded; an entry that gains a caller
 *      or loses its procedure fails too, so the record cannot go stale.
 *
 *   3. ROUTES. Where a v1 and a v2 page both still route, the pair is in
 *      ROUTE_PAIRS with why both stay. A retired one must leave the list.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { appRouter } from "./routers";

const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const posix = (p: string) => p.split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name)) out.push(rel);
  }
  return out;
}

/* ─── 1. modules ─────────────────────────────────────────────────────────── */

const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes("/__fakes__/");

/** Modules nothing imports, kept on purpose. A key ending in "/" covers a folder. */
const KEPT_MODULES: Record<string, string> = {
  "client/src/main.tsx": "the client entry point (index.html loads it)",
  "server/_core/index.ts": "the server entry point",
  "server/_core/types/cookie.d.ts": "ambient types, read by the compiler, never imported",
  "drizzle/relations.ts": "drizzle-kit's generated output, beside schema.ts",
  "client/src/components/ui/": "the vendored shadcn kit: an unused piece costs nothing (tree-shaken) and its CLI adds pieces back by name",
  "client/src/components/usip/enrichment/EnrichmentJobDrawer.tsx":
    "unmounted on purpose (audit P89, 2026-11-06) until a job backend can save what it builds; enrichmentJobDrawer.test.ts pins its flow rules",
  // ProspectImportDialog was listed here until batch CRMP deleted it with its router (merged 2026-11-07).
  "server/routers/are/signalEnhancement.ts":
    "only a test imports it (its output is not read: researchCoverage.test.ts); batch ARES kept it when it landed on 2026-11-07, so it is recorded rather than deleted over that batch's decision",
};

function unimportedModules(): string[] {
  const files = [...walk("client/src"), ...walk("server"), ...walk("shared"), ...walk("drizzle")];
  const importers = [...files, ...walk("scripts"), "vite.config.ts", "vitest.config.ts", "drizzle.config.ts"].filter((f) => existsSync(join(ROOT, f)));
  const known = new Set(files);
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = `client/src/${spec.slice(2)}`;
    else if (spec.startsWith("@shared/")) base = `shared/${spec.slice(8)}`;
    else if (spec.startsWith(".")) base = posix(normalize(join(dirname(from), spec)));
    else return null;
    base = base.replace(/\.js$/, "");
    for (const ext of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]) if (known.has(base + ext)) return base + ext;
    return null;
  };
  const used = new Set<string>();
  const SPEC = /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of importers) {
    if (isTest(f)) continue;
    const src = readFileSync(join(ROOT, f), "latin1");
    for (const m of Array.from(src.matchAll(SPEC))) {
      const spec = m[1] || m[2] || m[3];
      const r = spec ? resolve(f, spec) : null;
      if (r && r !== f) used.add(r);
    }
  }
  return files.filter((f) => !isTest(f) && !used.has(f));
}

describe("modules nothing imports (X6.1)", () => {
  const orphans = unimportedModules();
  const kept = (f: string) => Object.keys(KEPT_MODULES).some((k) => (k.endsWith("/") ? f.startsWith(k) : f === k));

  it("every module is imported by something, or kept with its reason", () => {
    expect(orphans.filter((f) => !kept(f)), "imported by nothing: delete it, wire it, or add it to KEPT_MODULES with why").toEqual([]);
  });

  it("every file kept by name is still here and still unimported", () => {
    for (const k of Object.keys(KEPT_MODULES).filter((k) => !k.endsWith("/"))) {
      expect(existsSync(join(ROOT, k)), `${k} is gone: drop it from KEPT_MODULES`).toBe(true);
      expect(orphans, `${k} is imported now: drop it from KEPT_MODULES`).toContain(k);
    }
  });

  it.each([
    "server/_core/dataApi.ts", "server/_core/imageGeneration.ts", "server/_core/map.ts", "server/_core/voiceTranscription.ts",
    "server/_core/types/manusTypes.ts", "client/src/components/Map.tsx", "client/src/hooks/useStreamLLM.ts", "shared/types.ts",
    "server/routers/dashboardLayouts.ts", "server/routers/urlScraper.ts", "server/services/scraper/urlScraper.ts",
  ])("%s is deleted", (f) => {
    expect(existsSync(join(ROOT, f))).toBe(false);
  });
});

/* ─── 2. procedures ──────────────────────────────────────────────────────── */

const ASSISTANT = "named in the assistant's action catalog (services/assistantActionCatalog.ts)";
const STREAM = (route: string) => `non-streaming twin of ${route}, which the page calls`;
const OPERATOR = "operator API, documented in .claude/skills/velocity-operator/references (api-cookbook.md, pages.md)";
const OWNER_TOOL = (what: string) => `owner clean-up run over the API: ${what}`;
const NO_SCREEN = (what: string) => `back end of ${what}, whose screen is not built; kept to be wired, not rebuilt`;
const WIRE = (gap: string) => `wire candidate: ${gap}`;
const ARES = "Revenue Engine area (batch ARES, which landed while this sweep ran on 2026-11-07): not swept here, left to that area";
const CRMP = "People, companies, leads and import area (batch CRMP, which landed while this sweep ran on 2026-11-07; crm.ts is its router): not swept here, left to that area";
const THIS_WEEK = (sha: string, why: string) => `changed this week (${sha}); ${why}`;

const NO_CLIENT_CALLER: Record<string, string> = {
  "system.health": "public uptime probe from the bootstrap; an outside monitor may poll it (GET /api/health is the deploy check)",
  // Priority Score model editor.
  ...Object.fromEntries([
    "getModel", "createModel", "updateModel", "activateModel", "archiveModel", "setPrimary", "installDefaults", "createGroup", "updateGroup",
    "deleteGroup", "createCriterion", "updateCriterion", "deleteCriterion", "previewDistribution", "calculateBulk", "topPriority",
    "recalcModel", "recalcWorkspace", "getRecalcJob",
  ].map((p) => [`scoring.${p}`, NO_SCREEN("the Priority Score model editor (the scores themselves are shown)")])),
  ...Object.fromEntries([
    "companies.inferFirmographics", "companies.firmographicStatus", "companies.normalizeNames", "companies.runLogoBackfill", "companies.runNameVerification",
    "companies.undoAssociation", "companies.repairBrandVerification", "accounts.hierarchy", "accounts.create", "accounts.update", "accounts.bulkDelete",
    "contacts.create", "contacts.update", "contacts.bulkDelete", "contacts.bulkAddToSequence", "opportunities.get", "opportunities.listRoles",
    "territories.update", "crmTerritoryRules.update", "prospects.normalizeNames", "prospects.normalizeCompanyNames",
    "prospects.delete", "prospects.promoteToContact", "prospects.promoteToLead", "prospects.findContactInfo", "prospects.backfillCompanies",
    "prospects.reoonBalance",
  ].map((p) => [p, CRMP])),
  ...Object.fromEntries([
    "campaigns.rewriteNotStartedSequences", "campaigns.rewriteNotStartedStatus", "campaigns.runEngine", "prospects.repairSequenceQualityTotals",
    "prospects.skip", "prospects.setSequenceTimeline", "prospects.addManual", "prospects.bulkUnapprove", "prospects.bulkApprove", "prospects.bulkReject",
    "execution.getQueue", "execution.pause", "execution.resume", "execution.reviveSkippedSteps", "execution.ingestSignal", "execution.getSuppressionList",
    "execution.addSuppression", "scraper.scrapeGoogleBusiness", "scraper.scrapeLinkedInCompany", "scraper.scrapeLinkedInPeople", "scraper.scrapeWeb",
    "scraper.scrapeNews", "scraper.scrapeIndustryEvents", "scraper.runFullScrape", "engine.enrollOnly", "metrics.abVariants", "metrics.thresholds",
  ].map((p) => [`are.${p}`, ARES])),
  "tasks.update": WIRE("TasksV2's row menu has Complete, Snooze and Delete but no Edit"),
  // Batch CRMP's, merged 2026-11-07.
  "imports.discard": THIS_WEEK("f504f4dd", "batch CRMP added it to throw away a pending upload; its control is that pipeline's to wire"),
  "prospects.findContactInfoBatch": "called slice by slice by the bulk job, as the person who started it (services/bulkByFilter.ts runChunk)",
  "meetings.propose": ASSISTANT,
  "meetings.reschedule": ASSISTANT,
  "meetings.cancelSentInvites": OWNER_TOOL("admin only, dry run by default (2026-10-06)"),
  "meetings.removeBookings": OWNER_TOOL("admin only, dry run by default, never touches the provider's calendar"),
  "meetings.undoInviteBookingSignals": OWNER_TOOL("admin only (2026-09-24)"),
  "activities.addNote": ASSISTANT,
  "sequences.setVisibility": WIRE("SequencesV2 has no Share / Private toggle, so a forked sequence stays private"),
  "sequences.enroll": OPERATOR,
  "emailDrafts.list": "the one draft listing the assistant can read; assistant.ts points it at emailDrafts.approve and send",
  "emailDrafts.count": THIS_WEEK("f07075a8", "bounded by batch Ob; the Dashboard badge reads attention.summary now"),
  "linkedinLimits.history": WIRE("the LinkedIn limits page's Recent activity has no per-day chart"),
  "cs.listTickets": NO_SCREEN("support tickets (only the demo seed creates them)"),
  "workflows.checkDealAging": THIS_WEEK("c3b8aef2", "a manual run of the nightly checkDealAging"),
  "quotes.get": "the only read of a quote with its line items (list leaves them out); the assistant can reach it",
  "leadRouting.applyToLead": "the only way to re-route an existing lead; the assistant can reach it",
  "team.setQuota": "lets an admin set their own quota, which team.updateMember refuses (allowSelf)",
  "team.setTitle": "lets an admin set their own title, which team.updateMember refuses (allowSelf)",
  "team.markInviteAccepted": OPERATOR,
  "team.getLoginHistory": THIS_WEEK("dd5a2258", "batch SEC's sessions work"),
  "dangerZone.tableStatus": "ops read for checking migrations before destructive DDL (rawMigrations.ts says to use it)",
  "dangerZone.seedDemoExtras": OPERATOR,
  "subjectAB.analyze": WIRE("the draft editor's Subject A/B panel scores generated variants only, not the subject typed"),
  "oppIntelligence.requestStageChange": NO_SCREEN("deal stage approvals, parked until a reviewer screen exists (Pipeline.tsx)"),
  "oppIntelligence.reviewStageChange": NO_SCREEN("deal stage approvals, parked until a reviewer screen exists (Pipeline.tsx)"),
  "oppIntelligence.listPendingApprovals": NO_SCREEN("deal stage approvals, parked until a reviewer screen exists (Pipeline.tsx)"),
  "optimization.reopen": WIRE("Dismiss on the Revenue Engine's recommendations has no undo; this is it"),
  "optimization.dismissAll": WIRE("AREPerformance has Apply all but no Dismiss all"),
  "emailTemplates.setVisibility": WIRE("EmailBuilder has no Private / Team toggle for a template"),
  "emailTemplates.rewriteBlock": STREAM("POST /api/email-builder/rewrite/stream (emailBuilderStreamRoute.ts)"),
  "snippets.setVisibility": WIRE("Snippets has no Private / Team toggle"),
  "savedSections.update": WIRE("EmailBuilder's saved sections can be created and deleted, not renamed"),
  "emailVerification.verifyBulk": NO_SCREEN("bulk contact verification (its screen went with Contacts.tsx; the cron still runs queued jobs)"),
  "emailVerification.getBulkJobStatus": NO_SCREEN("bulk contact verification (its screen went with Contacts.tsx)"),
  "emailVerification.getHealthTrend": NO_SCREEN("the verification health trend, read from the nightly snapshots"),
  "dataHealth.syncContactsFromPeople": OWNER_TOOL("a one-shot admin backfill, dry run by default"),
  "dataHealth.syncPeopleFromQueue": OWNER_TOOL("a one-shot admin backfill, dry run by default"),
  "segments.addContacts": "the only way to add chosen contacts to a live segment; leadsSegmentPlumbing.test.ts pins it",
  "aiPipeline.approveAllPending": "kept as an API and assistant surface when /ai-pipeline was retired (e34cde5e)",
  "aiPipeline.clearDrafts": "kept as an API surface when /ai-pipeline was retired (e34cde5e)",
  "pipelineAlerts.dismissAllForOpp": WIRE("DealsV2's alert strip has no per-deal Dismiss all"),
  "pipelineAlerts.dismissAll": WIRE("PipelineAlerts has the admin Clear all but not a manager's Dismiss all"),
  "accountBriefs.generate": STREAM("accountBriefsStreamRoute.ts"),
  "smtpConfig.sendDraft": ASSISTANT,
  "sendingAccounts.getDomainAuthDns": OPERATOR,
  "sendingAccounts.getDailyStats": "the only reader of the daily bounce and spam series emailDelivery.ts keeps writing",
  "mailbox.aiDraftReply": STREAM("POST /api/mailbox/draft-reply/stream (mailboxStreamRoute.ts)"),
  "mailbox.aiDraftForward": STREAM("POST /api/mailbox/draft-forward/stream (mailboxStreamRoute.ts)"),
  "unipile.getStoredMessages": NO_SCREEN("a record's LinkedIn message history"),
  "unipile.getStoredInvites": NO_SCREEN("a record's LinkedIn invite history"),
  "proposals.generateSectionContent": STREAM("proposalsStreamRoute.ts"),
  "csAi.bulkScoreChurnRisk": WIRE("Renewals scores churn one row at a time; Score all spends AI, so it needs the count-and-cost confirmation first"),
  "contactsAi.scoreRelStrength": "the only writer of contacts.relStrengthScore, which gates auto-send for contact drafts; its button went with Contacts.tsx and needs a new home, not deletion",
  "mailboxAi.triageThread": WIRE("Mailbox renders an AI triage badge nothing fills; triage spends AI, so it needs the confirmation first"),
  "mailboxAi.bulkTriage": WIRE("Mailbox renders an AI triage badge nothing fills; triage spends AI, so it needs the confirmation first"),
  "mailboxAi.getTriageLabels": WIRE("the Mailbox triage badge would read these"),
  "helpCenter.upsertCategory": OPERATOR,
  "helpCenter.deleteCategory": OPERATOR,
  "helpCenter.getConversationMessages": NO_SCREEN("saved help-chat history"),
  "helpCenter.generateArticleDraft": WIRE("the help article editor has no Draft with AI; it spends AI, so it needs the confirmation first"),
  "tours.getMyAchievements": NO_SCREEN("tour achievements (completeTour writes them)"),
  "tours.getAnalytics": NO_SCREEN("tour completion stats for the tour builder"),
  "aiCredentials.copyFromWorkspace": OWNER_TOOL("copies one workspace's AI key to another; keys never leave the server any other way"),
  "aiCalls.suppressions": NO_SCREEN("the voice do-not-call list (voiceRelay adds numbers to it automatically)"),
  "aiCalls.addSuppression": NO_SCREEN("the voice do-not-call list"),
  "aiCalls.removeSuppression": NO_SCREEN("the voice do-not-call list"),
  "placesSearch.textSearch": "the Google Places integration: its Find Prospects tab was removed but Settings still sets a Places budget; retire both or wire it back (owner's call)",
  "placesSearch.saveAsProspects": "the Google Places integration (see textSearch)",
  "placesSearch.saveAsAccounts": "the Google Places integration (see textSearch)",
  "linkedinFinder.saveSearchHits": THIS_WEEK("589121d0", "batch RESB added its duplicate check"),
  "linkedinFinder.saveAsProspect": THIS_WEEK("589121d0", "batch RESB added its duplicate check"),
  "linkedinEnrichment.deleteBatch": OWNER_TOOL("audited admin clean-up of a test or a bad enrichment"),
  "linkedinEnrichment.deleteJob": OWNER_TOOL("audited admin clean-up of a test or a bad enrichment"),
  "linkedinEnrichment.deleteProspectEnrichment": OWNER_TOOL("audited admin clean-up of a test or a bad enrichment"),
};

/** The client's ways of calling a procedure: trpc.x.y.useQuery, utils.client.x.y.query, utils.x.y.fetch. */
const CALLS = "(useQuery|useMutation|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery|query|mutate|fetch|prefetch|ensureData)";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("procedures with no caller (X6.2, G67)", () => {
  const client = walk("client/src").map((f) => read(f)).join("\n");
  const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
  const uncalled = Object.keys(procs).filter((p) => !new RegExp(`(?:\\btrpc|\\butils\\w*|\\b\\w+Utils)(?:\\.client)?\\.${escapeRe(p)}\\.${CALLS}\\b`).test(client));

  it("every procedure the client never calls is recorded with its reason", () => {
    expect(uncalled.filter((p) => !(p in NO_CLIENT_CALLER)), "no caller: wire it, delete it, or record why it stays").toEqual([]);
  });

  it("every record still names a real procedure the client does not call", () => {
    expect(Object.keys(NO_CLIENT_CALLER).filter((p) => !(p in procs)), "deleted: drop the entry").toEqual([]);
    expect(Object.keys(NO_CLIENT_CALLER).filter((p) => p in procs && !uncalled.includes(p)), "called now: drop the entry").toEqual([]);
    for (const [p, why] of Object.entries(NO_CLIENT_CALLER)) expect(why.length, `${p} says why`).toBeGreaterThan(20);
  });

  it("the ones the audit named are wired or gone", () => {
    for (const p of ["workspace.switch", "dashboardLayouts.getLayout", "dashboardLayouts.saveLayout", "leads.rescore", "system.notifyOwner"]) {
      expect(p in procs, `${p} is back`).toBe(false);
    }
    // Wired: rename a widget, pause a schedule, read a reply.
    expect(client).toContain("trpc.dashboards.updateWidget.useMutation(");
    expect(client).toContain("trpc.dashboards.toggleSchedule.useMutation(");
    expect(client).toContain("trpc.segments.getContacts.useQuery(");
    expect(client).toContain("trpc.team.resetMemberMfa.useMutation(");
    expect(client).toContain("trpc.conversations.markRead.useMutation(");
    expect(client).toContain("trpc.conversations.markSocialRead.useMutation(");
  });

  it("the legacy campaigns router keeps only its list (the Broadcasts page was retired on 2026-10-27)", () => {
    expect(Object.keys(procs).filter((p) => p.startsWith("campaigns."))).toEqual(["campaigns.list"]);
  });
});

describe("the wired controls work from their screens", () => {
  const dash = read("client/src/pages/usip/Dashboards.tsx");
  const conv = read("client/src/pages/usip/ConversationsV2.tsx");

  it("a widget can be renamed in customize mode", () => {
    const card = dash.slice(dash.indexOf("function WidgetCard("), dash.indexOf("/* ─── Add Widget dialog"));
    expect(card).toContain("onClick={() => onRename(data.title)}");
    expect(card).toContain('aria-label="Rename widget"');
    expect(dash).toContain("renameW.mutate({ id: renamingWidget.id, patch: { title: String(f.get(\"title\")).trim() } })");
  });

  it("a schedule can be paused and resumed, and says when it is paused", () => {
    const row = dash.slice(dash.indexOf("(schedules.data ?? []).map("), dash.indexOf("{/* Main canvas */}"));
    expect(row).toContain("toggleSched.mutate({ id: s.id, enabled: s.enabled === false })");
    expect(row).toContain('{s.enabled === false ? "Resume" : "Pause"}');
    expect(row).toContain("Paused</Badge>");
  });

  it("opening an unread reply marks it read, on its own channel", () => {
    expect(conv).toContain("if (!r.readAt) (isEmail ? markRead : markSocialRead).mutate({ id: r.id });");
    expect(conv).toContain("onClick={() => openReply(r)}");
    expect(conv).not.toContain("onClick={() => setSelected(r)}");
  });
});

/* ─── 3. routes ─────────────────────────────────────────────────────────── */

/**
 * v1 and v2 pages that both still route, and why (G67's naming drift). The
 * /v2 prefix itself is kept: renaming breaks bookmarks, emailed links, help
 * articles and tour anchors for a cosmetic gain.
 */
const ROUTE_PAIRS: Array<[string, string, string]> = [
  ["/tasks", "/v2/tasks", "which task page to keep is the owner's decision (R72)"],
  ["/dashboard", "/v2/home", "two homes, chosen per person with Set as home (G56, owner decision)"],
  ["/sequences", "/v2/sequences", "legacy /sequences still holds capabilities the v2 editor lacks (HANDOFF, sequence editor inventory)"],
  ["/workflows", "/v2/workflows", "the rule builder and the Autonomy Center: different pages over one engine"],
  ["/inbox", "/v2/conversations", "notifications inbox and the reply queue: different things that share a word"],
];

describe("routes", () => {
  const app = read("client/src/App.tsx");
  const routed = (p: string) => app.includes(`<Route path="${p}">`);

  it("every recorded pair still routes both ways; retire one and its entry goes", () => {
    for (const [a, b] of ROUTE_PAIRS) {
      expect(routed(a), `${a} is gone: drop the pair`).toBe(true);
      expect(routed(b), `${b} is gone: drop the pair`).toBe(true);
    }
  });

  it("no orphan auth helper: /api/auth/set-return wrote a cookie nothing read", () => {
    const oauth = read("server/_core/oauth.ts");
    expect(oauth).not.toContain('app.get("/api/auth/set-return"');
    expect(oauth).toContain('app.get("/api/oauth/callback"');
    expect(app).not.toContain("function InviteReturnRedirect(");
  });

  it("the comment over the v2 routes no longer calls them placeholders", () => {
    expect(app).not.toContain("they render placeholders so the new pages can be built fresh");
  });

  it("every route's page is a file that exists", () => {
    const lazy = Array.from(app.matchAll(/lazyChunk\(\(\) => import\("@\/([^"]+)"\)/g)).map((m) => m[1]);
    expect(lazy.length).toBeGreaterThan(100);
    for (const p of lazy) expect(existsSync(join(ROOT, "client/src", `${p}.tsx`)), p).toBe(true);
  });
});

