/**
 * Import-wizard fidelity (owner ask 2026-08-21: "show the user as much useful
 * information as possible" at every stage).
 *
 * The additions follow one rule: information comes from the server's ONE
 * parse and ONE classifier — a client-side profile would be a second parser,
 * and two parsers is how a preview drifts from the import it describes (this
 * file's history: the mapping mismap of 8c967cc, the preview/commit dedupe
 * drift). Pure helpers tested directly; the rest is wiring.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildColumnStats, summarizeErrorReasons } from "./routers/imports";

describe("buildColumnStats — the mapping step's column profiles", () => {
  const rows = [
    { Email: "a@x.com", Name: "Ann", Notes: "" },
    { Email: "", Name: "Bob", Notes: "" },
    { Email: "c@x.com", Name: "Cy", Notes: "" },
  ];
  it("counts filled cells and captures up to two distinct samples", () => {
    const stats = buildColumnStats(["Email", "Name", "Notes"], rows);
    expect(stats[0]).toEqual({ header: "Email", filled: 2, samples: ["a@x.com", "c@x.com"] });
    expect(stats[1].filled).toBe(3);
    expect(stats[1].samples).toHaveLength(2);
    expect(stats[2]).toEqual({ header: "Notes", filled: 0, samples: [] });
  });
  it("whitespace-only cells are empty, long samples are clipped, duplicates not repeated", () => {
    const stats = buildColumnStats(["A"], [{ A: "  " }, { A: "x".repeat(80) }, { A: "x".repeat(80) }]);
    expect(stats[0].filled).toBe(2);
    expect(stats[0].samples).toHaveLength(1);
    expect(stats[0].samples[0].length).toBeLessThanOrEqual(58);
    expect(stats[0].samples[0].endsWith("…")).toBe(true);
  });
});

describe("summarizeErrorReasons — grouped over ALL rows, ranked, capped", () => {
  it("ranks by count and keeps at most 8 reasons", () => {
    const rowsIn = [
      ...Array.from({ length: 5 }, (_, i) => ({ rowIndex: i, reason: "Missing email" })),
      ...Array.from({ length: 2 }, (_, i) => ({ rowIndex: 10 + i, reason: "Invalid phone" })),
      ...Array.from({ length: 9 }, (_, i) => ({ rowIndex: 20 + i, reason: `unique ${i}` })),
    ];
    const out = summarizeErrorReasons(rowsIn);
    expect(out[0]).toEqual({ reason: "Missing email", count: 5 });
    expect(out[1]).toEqual({ reason: "Invalid phone", count: 2 });
    expect(out).toHaveLength(8);
  });
});

describe("wiring — every stage renders what the server now returns", () => {
  const router = readFileSync("server/routers/imports.ts", "utf8");
  const page = readFileSync("client/src/pages/usip/ImportContacts.tsx", "utf8");

  it("parseCSV returns column profiles; the mapping step renders fill % + samples + the parsed preview", () => {
    expect(router).toContain("columnStats: buildColumnStats(headers, rows)");
    expect(page).toContain("% filled");
    expect(page).toContain("Preview first {previewRows.length} rows (as parsed)");
    expect(page).toContain("Required-field coverage");
  });

  it("validateRows names WHO duplicates matched, and the client shows the pairs", () => {
    expect(router).toContain("duplicateSamples");
    expect(router).toContain("errorReasonSummary: summarizeErrorReasons(errorRows)");
    expect(page).toContain("Who they matched");
    expect(page).toContain("duplicateSamples.map((d)");
  });

  it("error reasons are the server's whole-file tally, not a client count of the capped list", () => {
    expect(page).toContain("errorReasonSummary.map((r)");
    expect(page).not.toMatch(/errorRows\.(reduce|filter)\([^)]*reason/);
  });

  it("the confirm summary states destination and dedupe rule; the done step's CTA follows the destination", () => {
    expect(page).toContain('{destination === "prospects" ? "Prospects — cleaned by the sweeper first" : "CRM Contacts — usable immediately"}');
    expect(page).toContain('{matchOnNameCompany ? "email, or name + company" : "email only"}');
    expect(page).toContain('href={destination === "prospects" ? "/prospects" : "/v2/people"}');
  });

  it("every imported contact reaches the People tab — awaited, batch-scoped, reported", () => {
    // Owner directive 2026-08-21. The old pass was fire-and-forget with the
    // daily backfill as the guarantee — i.e., no guarantee the user could see.
    const personLink = readFileSync("server/services/personLink.ts", "utf8");
    // The seam can start its keyset scan AT the batch, so an older backlog of
    // unlinked contacts cannot exhaust the page budget first.
    expect(personLink).toContain("afterId?: number");
    expect(personLink).toContain("let lastId = opts.afterId ?? 0");
    // Awaited under the threshold, with the batch's own keyset start; the
    // large-import path is scoped the same way and the result names its mode.
    expect(router).toContain("await linkUnlinkedContacts({ workspaceId: wsId, limit: 500, maxPages, afterId })");
    expect(router).toContain("void linkUnlinkedContacts({ workspaceId: wsId, limit: 500, maxPages, afterId })");
    expect(router).toContain("peopleLinkMode,");
    // The Done step SAYS where the rows are, in both modes and for prospects.
    expect(page).toContain("are on the People tab");
    expect(page).toContain("linking to the People tab is finishing in the background");
  });

  it("imports.getHistory finally has a consumer, refreshed after each commit", () => {
    expect(page).toContain("trpc.imports.getHistory.useQuery({ limit: 8 })");
    expect(page).toContain("utils.imports.getHistory.invalidate()");
    // Step 3's copy has referred users to "the import history" since before it
    // existed on the page — the card must actually be mounted.
    expect(page).toContain("{step === 1 && <ImportHistoryCard />}");
  });
});
