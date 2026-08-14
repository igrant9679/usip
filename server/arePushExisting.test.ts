/**
 * Pushing existing CRM people into an ARE campaign (owner ask 2026-08-14).
 *
 * The engine minting prospects itself, and a CSV import, were the only routes
 * into a campaign — someone already in People could not be put into one.
 * `addManual` existed for a hand-typed person but had no UI caller at all.
 *
 * A second way in is exactly where duplicate-identity bugs come from, so what
 * these pin is not "it inserts a row" but that it obeys the SAME rules every
 * other ingest seam does: one identity vocabulary, campaign exclusivity, no
 * identity-less rows, and enrichment before sequence generation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { queueIdentityKeys, nameOrgDedupKey } from "./services/are/queueIdentity";

const router = readFileSync("server/routers/are/prospects.ts", "utf8");
const proc = router.slice(router.indexOf("pushExisting: workspaceProcedure"), router.indexOf("addManual: workspaceProcedure"));

describe("it reuses the one identity vocabulary", () => {
  it("resolves exclusivity through queueIdentity, not a local rule", () => {
    expect(proc).toContain("workspaceQueueIdentityIndex(ctx.workspace.id)");
    expect(proc).toContain("existingClaim(index, shape)");
  });

  it("refuses a person with no identity key, as every other seam does", () => {
    expect(proc).toContain("queueIdentityKeys(shape).length === 0");
    // And the vocabulary really does reject such a row.
    expect(queueIdentityKeys({ firstName: "Jo", lastName: "Bloggs" })).toEqual([]);
    expect(queueIdentityKeys({ email: "jo@acme.com" })).toEqual(["e:jo@acme.com"]);
    // canonicalText strips punctuation, so the domain canonicalises to
    // "acme com" — noted because it looks like a typo and is not one.
    expect(nameOrgDedupKey({ firstName: "Jo", lastName: "Bloggs", companyDomain: "acme.com" })).toBe("n:jo bloggs@acme com");
  });

  it("claims each identity within the batch so one selection cannot double-add", () => {
    // The index is loaded once; without claiming as we go, the same person
    // selected twice in one push would pass the check twice.
    expect(proc).toContain("for (const k of queueIdentityKeys(shape)) if (!index.has(k)) index.set(k,");
  });

  it("names the campaign a claimed prospect already belongs to", () => {
    expect(proc).toContain("Already in this campaign");
    expect(proc).toContain("a prospect can only be in one at a time");
  });
});

describe("the queue row points back at the person", () => {
  it("stores personProspectId rather than making a queue-only copy", () => {
    expect(proc).toContain("personProspectId: p.id");
  });

  it("is scoped to the caller's workspace on both reads", () => {
    expect(proc).toContain("eq(areCampaigns.workspaceId, ctx.workspace.id)");
    expect(proc).toContain("eq(prospects.workspaceId, ctx.workspace.id)");
  });
});

describe("enrichment runs BEFORE sequence generation", () => {
  it("awaits the enrich agent, then the sequence agent", () => {
    // runSequenceAgent throws "has no enrichment data" without intelligence,
    // so the order is load-bearing, not stylistic.
    const enrich = proc.indexOf("await runEnrichAgent(");
    const seq = proc.indexOf("await runSequenceAgent(");
    expect(enrich).toBeGreaterThan(0);
    expect(seq).toBeGreaterThan(0);
    expect(enrich).toBeLessThan(seq);
  });

  it("chains them OFF the request path", () => {
    // Both are LLM-bound; awaiting them in the handler would time out the call.
    expect(proc).toContain("void (async () => {");
    expect(proc).toContain("].catch" .replace("].", ")."));
  });

  it("sequence generation is optional", () => {
    expect(proc).toContain("if (input.generateSequence)");
  });
});

describe("the surface is actually reachable", () => {
  const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");
  const dialog = readFileSync("client/src/components/usip/are/AddExistingProspectsDialog.tsx", "utf8");

  it("the campaign toolbar opens it", () => {
    // addManual shipped with no caller at all; this one is mounted.
    expect(page).toContain("<AddExistingProspectsDialog");
    expect(page).toContain("onClick={() => setAddExistingOpen(true)}");
  });

  it("the dialog calls the procedure and refreshes the list", () => {
    expect(dialog).toContain("trpc.are.prospects.pushExisting.useMutation");
    expect(page).toContain("utils.are.prospects.list.invalidate()");
  });

  it("refused prospects are shown with their reason, not swallowed", () => {
    expect(dialog).toContain("skipped.length > 0");
    expect(dialog).toContain("{s.reason}");
  });
});
