/**
 * The no-email door (owner rule 2026-09-16): "If a prospect doesn't have an
 * email they should never be added to a queue of a campaign."
 *
 * Chosen shape (owner: "find email first, then admit"): every insert path
 * stages email-less candidates as sequenceStatus 'sourcing' — outside the
 * Prospects tab and every counter — while the enrich phase hunts an address.
 * The engine's ADMIT step promotes them to 'pending' off the row's own email
 * column (one place, so no email writer can forget to admit) and rejects the
 * rows enrichment exhausted.
 *
 * Source-scanner pins on the decisive expressions: each guards a seam where
 * a refactor could silently reopen the door (the dead-wiring class — the
 * enrolment email-gate of 08-20 already covers the send side).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

describe("the no-email door — staging on every insert path", () => {
  it("migration 0180 widens the enum and the drizzle schema agrees", () => {
    const mig = read("_core", "rawMigrations.ts");
    expect(mig).toContain("0180_prospect_queue_sourcing_status.sql");
    expect(mig).toContain("'canceled','sourcing') NOT NULL DEFAULT 'pending'");
    expect(read("..", "drizzle", "schema.ts")).toContain('"canceled", "sourcing"]');
  });

  it("discovery, single add, CSV import and People-push all stage email-less rows", () => {
    expect(read("routers", "are", "scraper.ts"))
      .toContain('sequenceStatus: (email ? "pending" : "sourcing")');
    const prospects = read("routers", "are", "prospects.ts");
    expect(prospects).toContain('sequenceStatus: rest.email && String(rest.email).trim() ? "pending" : "sourcing"');
    expect(prospects).toContain('sequenceStatus: email ? "pending" : "sourcing"');
    expect(read("services", "are", "pushPeople.ts"))
      .toContain('sequenceStatus: p.email ? "pending" : "sourcing"');
  });

  it("the engine admits on a found email and rejects when enrichment exhausts", () => {
    const engine = read("areEngine.ts");
    // ADMIT: sourcing → pending, keyed on the row's own email column.
    const admitAt = engine.indexOf("THE NO-EMAIL DOOR — ADMIT + GIVE-UP");
    expect(admitAt).toBeGreaterThan(-1);
    const block = engine.slice(admitAt, admitAt + 2600);
    expect(block).toContain("SET \\`sequenceStatus\\` = 'pending'");
    expect(block).toContain("AND \\`sequenceStatus\\` = 'sourcing'");
    expect(block).toContain("AND \\`email\\` IS NOT NULL AND \\`email\\` <> ''");
    // GIVE-UP: only after enrichment actually finished without an address.
    expect(block).toContain("AND \\`enrichmentStatus\\` IN ('complete', 'failed')");
    expect(block).toContain("No verifiable email address found");
  });

  it("low-ICP staged rows cannot sediment: the gate-reject covers 'sourcing'", () => {
    expect(read("areEngine.ts")).toContain("AND \\`sequenceStatus\\` IN ('pending', 'sourcing')");
  });

  it("the Prospects tab default listing excludes staged rows", () => {
    const prospects = read("routers", "are", "prospects.ts");
    expect(prospects).toContain('conditions.push(ne(prospectQueue.sequenceStatus, "sourcing"));');
  });

  it("the enrichment picker still reaches staged rows (no sequenceStatus exclusion)", () => {
    // The global picker selects by enrichmentStatus alone; if someone adds a
    // sequenceStatus filter there, staged rows would never get their email
    // and the door becomes a trap. Pin the picker's WHERE shape.
    const engine = read("areEngine.ts");
    const pickerAt = engine.indexOf('inArray(prospectQueue.enrichmentStatus, ["pending", "enriching"])');
    expect(pickerAt).toBeGreaterThan(-1);
    const around = engine.slice(Math.max(0, pickerAt - 600), pickerAt + 600);
    expect(around).not.toContain('ne(prospectQueue.sequenceStatus, "sourcing")');
    expect(around).not.toContain("sequenceStatus, \"pending\"");
  });
});
