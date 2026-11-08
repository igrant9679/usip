/**
 * The dossier's action bar (audit 2026-10-20, U23): approve, reject with a
 * reason, enrich, generate and open in Sequences, from the dossier.
 *
 * The bar reuses the row's procedures and offers each on the row's states;
 * the two that spend say what they can spend first, with counts pinned to the
 * agents they run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARE_ENRICH_MAX, ARE_GENERATE_MAX_AI_CALLS, areEnrichText, areGenerateText, type SourceBudgets } from "@shared/spendPreview";
import { dossierActions } from "../client/src/components/usip/are/DossierActionBar";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const block = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `end anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
};
const calls = (src: string) => (src.match(/invokeLLM\(/g) ?? []).length;

describe("the spend the confirms state is what the agents can spend", () => {
  const p = read("server/routers/are/prospects.ts");

  it("Enrich: the ICP score and the dossier — two AI calls", () => {
    const score = block(p, "async function scoreIcpMatch(", "function scoreRejectionWhere()");
    const agent = block(p, "export async function runEnrichAgent(", "function clampTemplateChannels(");
    expect(calls(score) + calls(agent)).toBe(ARE_ENRICH_MAX.aiCalls);
    expect(agent).toContain("scoreIcpMatch(prospect, effectiveIcp, workspaceId)");
    // The vendor lookups it can make when no email is on file.
    expect(agent).toContain("quickenrichFindEmailByLinkedIn(");
    expect(agent).toContain("reoonVerifySingle(qe.email, reoonKey, \"power\"");
    expect(agent).toContain("resolveVerifiedEmail({");
  });

  it("Generate: the template, the steps and the quality check — three AI calls at most", () => {
    const template = block(p, "export async function generateCampaignTemplate(", "async function personalizeForProspect(");
    const personal = block(p, "async function personalizeForProspect(", "async function evaluateSequenceQuality(");
    const quality = block(p, "async function evaluateSequenceQuality(", "async function emitSeqLog(");
    expect(calls(template) + calls(personal) + calls(quality)).toBe(ARE_GENERATE_MAX_AI_CALLS);
  });

  it("the sentences carry the counts and what is left", () => {
    const b: SourceBudgets = {
      apollo: { configured: false, allowance: null },
      quickenrich: { configured: true, allowance: { used: 10, cap: 100 } },
      linkedin: { accounts: 0, left: 0, cap: 0 },
      reoon: { configured: true, keySource: "shared", allowance: { used: 40, cap: 500 } },
      ai: { used: 120000, cap: 2000000 },
    };
    const one = areEnrichText(1, b);
    expect(one).toContain("2 AI calls");
    expect(one).toContain("1 QuickEnrich credit");
    expect(one).toContain("3 Reoon instant and 4 Reoon daily credits");
    expect(one).toContain("QuickEnrich pulls: 90 of 100 left today");
    expect(one).toContain("Reoon shared key: 460 of 500 left today");
    expect(one).toContain("AI tokens this month: 120,000 of 2,000,000");
    expect(areEnrichText(5)).toContain("For 5 people that is 10 AI calls");
    const g = areGenerateText(b.ai);
    expect(g).toContain("up to 3 AI calls");
    expect(g).toContain("Nothing is sent");
    expect(g).toContain("120,000 of 2,000,000 tokens used");
  });
});

describe("the bar offers the row's actions on the row's states", () => {
  it("approve and generate only for an enriched prospect still to be decided", () => {
    expect(dossierActions({ enrichmentStatus: "complete", sequenceStatus: "pending" })).toMatchObject({ approve: true, generate: true, enrich: false, reject: true });
    expect(dossierActions({ enrichmentStatus: "complete", sequenceStatus: "canceled" })).toMatchObject({ approve: true, generate: true });
    expect(dossierActions({ enrichmentStatus: "pending", sequenceStatus: "pending" })).toMatchObject({ approve: false, generate: false, enrich: true });
    expect(dossierActions({ enrichmentStatus: "failed", sequenceStatus: "pending" })).toMatchObject({ enrich: true });
    expect(dossierActions({ enrichmentStatus: "complete", sequenceStatus: "enrolled" })).toMatchObject({ approve: false, generate: false, reject: true, openInSequences: true });
  });

  it("a replied, finished or rejected prospect is not rejectable; a rejected one is not in Sequences", () => {
    for (const s of ["replied", "completed", "skipped"]) expect(dossierActions({ enrichmentStatus: "complete", sequenceStatus: s }).reject).toBe(false);
    expect(dossierActions({ enrichmentStatus: "complete", sequenceStatus: "skipped" }).openInSequences).toBe(false);
  });
});

describe("the bar is wired into the dossier", () => {
  const bar = read("client/src/components/usip/are/DossierActionBar.tsx");
  const page = read("client/src/pages/usip/ARECampaignDetail.tsx");

  it("reuses the row's procedures, and enrich and generate confirm their spend first", () => {
    expect(bar).toContain("trpc.are.prospects.approve.useMutation(");
    expect(bar).toContain("trpc.are.prospects.enrich.useMutation(");
    expect(bar).toContain("trpc.are.prospects.generateSequence.useMutation(");
    const enrich = block(bar, "const askEnrich = () => {", "};");
    expect(enrich).toContain("description: areEnrichText(1, budgets.data)");
    expect(enrich).toContain("}, () => enrich.mutate({ prospectId: prospect.id }));");
    const gen = block(bar, "const askGenerate = () => {", "};");
    expect(gen).toContain("description: areGenerateText(budgets.data?.ai)");
    expect(gen).toContain("}, () => generate.mutate({ prospectId: prospect.id, campaignId }));");
    // No path spends without the confirm.
    expect(bar.match(/enrich\.mutate\(/g)?.length).toBe(1);
    expect(bar.match(/generate\.mutate\(/g)?.length).toBe(1);
  });

  it("sits in the dossier's header, rejects through the tab's dialog and its presets, and refreshes every tab", () => {
    const sheet = block(page, "{/* ── Intelligence Dossier Sheet ── */}", "</SheetHeader>");
    expect(sheet).toContain("<DossierActionBar");
    expect(sheet).toContain("onReject={setRejectTarget}");
    expect(sheet).toContain("onOpenInSequences={openInSequences}");
    expect(sheet).toContain("onChanged={invalidateCampaign}");
    expect(page).toContain("<RejectProspectDialog target={rejectTarget} presets={REJECT_TEMPLATES}");
  });

  it("Open in Sequences switches tab and opens that prospect's sequence", () => {
    const open = block(page, "const openInSequences = (p: DossierProspect) => {", "};\n");
    expect(open).toContain('setTab("sequences");');
    expect(open).toContain("setSeqFocus({ prospectId: p.id, search: p.email || nm, nonce: Date.now() });");
    expect(page).toContain("<SequencesTab campaignId={campaignId} campaign={campaign} focus={seqFocus}");
    const tab = block(page, "function SequencesTab(", "function SequenceDrawer(");
    const effect = block(tab, "useEffect(() => {\n    if (!focus) return;", "}, [focus?.nonce]);");
    expect(effect).toContain('setFilter("all");');
    expect(effect).toContain("setSearch(focus.search);");
    expect(effect).toContain("setDrawerProspectId(focus.prospectId);");
  });
});
