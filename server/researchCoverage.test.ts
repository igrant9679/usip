/**
 * Research reaches every AI writer (Research module, phase 3; owner,
 * 2026-10-14). Done when every writer is wired or excluded with a reason, and
 * workspaces without research behave exactly as today.
 *
 * Every invokeLLM / streamLLM call in the server either passes `research`
 * (the composer in services/research/context picks the sector and persona)
 * or is listed below with the reason it does not. A new AI call fails this
 * test until someone decides which it is. The list is checked both ways: an
 * entry whose call has gone, or that is now wired, fails too, so it cannot rot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findLlmCallSites } from "./__fakes__/llmCallSites";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const passesResearch = (args: string) => /\bresearch\b\s*[:,}]/.test(args);

const INTERNAL = "Internal: classifies, scores, extracts or summarises for the rep; it does not write for or about a prospect's market.";
const ANON = "Website visitors are anonymous: no title or record to match, and the chat agent's own knowledge covers the product.";

const EXCLUDED: Record<string, string> = {
  "server/llmStreamRoute.ts::/api/llm/stream": "Generic passthrough with no client callers; a caller can pass research in its own body.",
  "server/services/chatAgent.ts::runChatTurn": ANON,
  "server/services/chatFollowUp.ts::draftFollowUp": ANON,
  "server/routers/cs.ts::generateQbrPrep": "QBR prep for existing customers, not research on a prospect's market.",
  "server/routers/are/signalEnhancement.ts::runSignalEnhancement": "Its output (prospect_intelligence.enhancedHook) is not read anywhere.",
  "server/services/replyClassifier.ts::classifyAndHandleSocialMessage": "Its suggested reply is generated but never saved or shown; the classification is internal.",
  "server/routers/are/prospects.ts::evaluateSequenceQuality": "Quality score. The research's avoid rules are checked separately, by the brief check in services/research/avoidCheck.",
  "server/services/research/avoidCheck.ts::checkBrief": "The brief check: it is given the avoid rules, pains and lead-with points themselves, not the selling block.",
  "server/routers/assistant.ts::chat": "The assistant answers the rep through its tools; research reaches it through them, not a prompt block.",
  "server/routers/assistant.ts::chat#2": "The assistant answers the rep through its tools; research reaches it through them, not a prompt block.",
  "server/routers/are/icp.ts::runIcpInference": "Takes ALL the workspace's researched sectors as prior knowledge through its own prompt section (phase 4), not the per-prospect block.",
  "server/routers/are/campaigns.ts::generateTargeting": "Turns a typed description into targeting before any campaign or prospect exists; a sector's targeting is used directly by Create campaign from sector instead.",
  "server/services/campaignProposals.ts::proposeForCluster": "Proposes campaigns from clusters of existing people; follow-up: suggest the matching research sector.",
  "server/services/campaignRouter.ts::routeProspects": INTERNAL + " (Picks which campaign a person belongs in.)",
  "server/routers/aiCredentials.ts::test": "A key test that asks the model for 'pong'.",
  "server/routers/helpCenter.ts::askAI": "Answers questions about Velocity itself.",
  "server/routers/helpCenter.ts::generateArticleDraft": "Writes help articles about Velocity itself.",
  "server/services/knowledgeBase.ts::generateKnowledgeSummary": "Summarises the workspace's own documents.",
  "server/routers/aiFeatures.ts::scoreChurnRisk": INTERNAL,
  "server/routers/aiFeatures.ts::bulkScoreChurnRisk": INTERNAL,
  "server/routers/aiFeatures.ts::suggestNextAction": INTERNAL,
  "server/routers/aiFeatures.ts::scoreRelStrength": INTERNAL,
  "server/routers/aiFeatures.ts::suggestPricing": INTERNAL,
  "server/routers/aiFeatures.ts::generateSuggestions": INTERNAL,
  "server/routers/aiFeatures.ts::generateCommentary": INTERNAL,
  "server/routers/aiFeatures.ts::triageThread": INTERNAL,
  "server/routers/aiFeatures.ts::bulkTriage": INTERNAL,
  "server/routers/aiPipeline.ts::scoreDraft": INTERNAL,
  "server/routers/are/execution.ts::processSignal": INTERNAL,
  "server/routers/are/scraper.ts::scrapeGoogleBusiness": INTERNAL,
  "server/routers/are/scraper.ts::scrapeWeb": INTERNAL,
  "server/routers/are/scraper.ts::scrapeNews": INTERNAL,
  "server/routers/calendar.ts::summarizeMeeting": INTERNAL,
  "server/routers/crm.ts::enrich": INTERNAL,
  "server/routers/crm.ts::rescore": INTERNAL,
  "server/services/company/nameVerification.ts::extractOfficialName": INTERNAL,
  "server/services/firmographicInference.ts::inferOne": INTERNAL,
  "server/services/dealAutopilot.ts::runDealAutopilotForWorkspace": INTERNAL,
  "server/services/taskAutopilot.ts::generateTasksForWorkspace": INTERNAL,
  "server/services/referralHandler.ts::handleReferralReply": INTERNAL + " (Extracts the referred person; the intro email after it is wired.)",
};

/** The writers this phase wired, so losing one is a failure, not a quiet exclusion. */
const WIRED = [
  "server/routers/are/prospects.ts::runEnrichAgent",
  "server/routers/are/prospects.ts::generateCampaignTemplate",
  "server/routers/are/prospects.ts::personalizeForProspect",
  "server/routers/aiPipeline.ts::runPipelineForContact",
  "server/routers/aiPipeline.ts::runPipelineForContact#2",
  "server/routers/aiPipeline.ts::runPipelineForContact#3",
  "server/routers/aiPipeline.ts::runPipelineForContact#4",
  "server/routers/aiPipeline.ts::regenerateDraft",
  "server/routers/researchPipeline.ts::llmJson",
  "server/routers/accountBriefs.ts::generate",
  "server/accountBriefsStreamRoute.ts::/api/accounts/:id/brief/stream",
  "server/routers/opportunityIntelligence.ts::generateIntelligence",
  "server/routers/sequences.ts::compose",
  "server/routers/subjectAB.ts::generate",
  "server/sequenceEngine.ts::generateDynamicEmail",
  "server/services/meetingScheduler.ts::draftProposalText",
  "server/services/referralHandler.ts::handleReferralReply#2",
  "server/services/replyClassifier.ts::classifyReply",
  "server/services/socialAutopilot.ts::generateOpener",
  "server/services/socialAutopilot.ts::generateInviteNote",
  "server/services/workflowEngine.ts::send_email_draft",
  "server/routers/are/prospects.ts::scoreIcpMatch",
  "server/routers/leadScoring.ts::fetchAiFit",
  // The four writers left after phase 3 (owner, 2026-10-15: "wire research into the remaining four writers").
  // Mailbox: the other party by email address (researchUseForRecipient + threadCounterparty).
  "server/_core/streamHelpers.ts::runSSEStream",
  "server/routers/mailbox.ts::aiDraftReply",
  "server/routers/mailbox.ts::aiDraftForward",
  // Email Builder and snippets: the sector the writer picks ("Write for").
  "server/emailBuilderStreamRoute.ts::/api/email-builder/rewrite/stream",
  "server/routers/emailBuilder.ts::generate",
  "server/routers/emailBuilder.ts::generateTemplate",
  "server/routers/emailBuilder.ts::rewriteBlock",
  "server/routers/emailBuilder.ts::suggestSubjects",
  // The editor assistant: the recipient the editor knows (record, draft or To address).
  "server/routers/emailAssist.ts::assist",
  // Proposals: the client through the proposal's contact, account or client email.
  "server/proposalsStreamRoute.ts::/api/proposals/:id/section/:key/stream",
  "server/routers/proposals.ts::generateSectionContent",
];

describe("every AI writer is wired to research, or excluded with a reason", () => {
  const sites = findLlmCallSites();

  it("the scan finds the calls (a scanner that finds nothing would pass everything)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(70);
    expect(sites.filter((s) => passesResearch(s.args)).length).toBeGreaterThanOrEqual(WIRED.length);
  });

  it("no call is left undecided", () => {
    const undecided = sites.filter((s) => !passesResearch(s.args) && !(s.key in EXCLUDED)).map((s) => `${s.key} (line ${s.line})`);
    expect(
      undecided,
      "\n\nAn AI call that neither passes `research` nor is listed in EXCLUDED with a reason.\n" +
        "If it writes for or about a prospect, pass research: { surface, campaignId?, prospectTitle?, industry? }\n" +
        "(services/research/recipient.researchUseFor turns a contact/lead/prospect id into one).\n" +
        "Otherwise add it to EXCLUDED and say why.\n",
    ).toEqual([]);
  });

  it("every exclusion still names a real call that is still not wired", () => {
    const keys = new Map(sites.map((s) => [s.key, s]));
    const stale = Object.keys(EXCLUDED).filter((k) => !keys.has(k) || passesResearch(keys.get(k)!.args));
    expect(stale).toEqual([]);
  });

  it("the wired writers stay wired", () => {
    const keys = new Map(sites.map((s) => [s.key, s]));
    expect(WIRED.filter((k) => !keys.get(k) || !passesResearch(keys.get(k)!.args))).toEqual([]);
  });

  it("every exclusion has a reason", () => {
    for (const [k, why] of Object.entries(EXCLUDED)) expect(why.length, k).toBeGreaterThan(20);
  });
});

describe("the research option itself", () => {
  it("invokeLLM and streamLLM add the block for the resolved workspace, beside the brand", () => {
    const llm = read("server/_core/llm.ts");
    const fn = llm.slice(llm.indexOf("export async function invokeLLM("));
    expect(fn).toContain("if (params.research && workspaceId) {");
    expect(fn).toContain("messages: await withResearch(workspaceId, params.research, params.messages)");
    const stream = read("server/_core/llmStream.ts");
    expect(stream).toContain("if (params.research && params.workspaceId) {");
    expect(stream).toContain("messages: await withResearch(params.workspaceId, params.research, params.messages)");
  });

  it("the phone agent gets the short spoken brief", () => {
    const relay = read("server/services/voiceRelay.ts");
    expect(relay).toContain('await researchUseFor(wsId, "voice", refFromRelated(row.relatedType, row.relatedId))');
    expect(relay).toMatch(/brand,\n\s+research,\n/);
    expect(read("server/services/voiceCallScript.ts")).toContain("if (s.research?.trim()) parts.push(s.research.trim());");
  });

  it("background writers name their workspace, or the option would do nothing there", () => {
    const pipe = read("server/routers/aiPipeline.ts");
    for (const stage of ["const orgResearchRes = await invokeLLM({", "const contactResearchRes = await invokeLLM({", "const fitAnalysisRes = await invokeLLM({"]) {
      const at = pipe.indexOf(stage);
      expect(pipe.slice(at, at + 160), stage).toContain("workspaceId,");
    }
  });
});
