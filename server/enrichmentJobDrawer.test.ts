/**
 * The "New enrichment job" builder (Data Enrichment page, 2026-08-21).
 *
 * The pure flow rules live in client/src/components/usip/enrichment/jobFlow.ts
 * (dependency-free on purpose so this file can import them by relative path):
 * which card unlocks when, what "workflow complete" means, and what a
 * selection change invalidates. The drawer is wiring around those rules —
 * asserted from source, the same way every other client surface is.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  EMPTY_JOB, cardCompleted, cardEnabled, withSelection, workflowComplete,
} from "../client/src/components/usip/enrichment/jobFlow";

describe("card gating — each card unlocks only after its prerequisite", () => {
  it("only the object card is enabled on a fresh job", () => {
    expect(cardEnabled(EMPTY_JOB, "object")).toBe(true);
    expect(cardEnabled(EMPTY_JOB, "type")).toBe(false);
    expect(cardEnabled(EMPTY_JOB, "filters")).toBe(false);
    expect(cardEnabled(EMPTY_JOB, "cadence")).toBe(false);
  });

  it("choosing the object unlocks the type; choosing the type unlocks filters AND cadence together", () => {
    const withObject = withSelection(EMPTY_JOB, "object", "people");
    expect(cardEnabled(withObject, "type")).toBe(true);
    expect(cardEnabled(withObject, "filters")).toBe(false);
    const withType = withSelection(withObject, "type", "email");
    // Filters is OPTIONAL — cadence must not wait on it.
    expect(cardEnabled(withType, "filters")).toBe(true);
    expect(cardEnabled(withType, "cadence")).toBe(true);
  });

  it("workflow completes on object + type + cadence; the optional filter is not required", () => {
    let cfg = withSelection(EMPTY_JOB, "object", "people");
    cfg = withSelection(cfg, "type", "email");
    expect(workflowComplete(cfg)).toBe(false);
    cfg = withSelection(cfg, "cadence", "daily");
    expect(workflowComplete(cfg)).toBe(true);
    expect(cardCompleted(cfg, "filters")).toBe(false);
  });

  it("changing the object invalidates every downstream choice; re-picking the same value keeps them", () => {
    let cfg = withSelection(EMPTY_JOB, "object", "people");
    cfg = withSelection(cfg, "type", "email");
    cfg = withSelection(cfg, "filters", "missing_only");
    cfg = withSelection(cfg, "cadence", "daily");
    const same = withSelection(cfg, "object", "people");
    expect(same).toEqual(cfg);
    const changed = withSelection(cfg, "object", "companies");
    expect(changed.enrichmentType).toBeNull();
    expect(changed.filter).toBeNull();
    expect(changed.cadence).toBeNull();
  });

  it("changing the type clears the filter (it described the old type's data) but keeps the cadence", () => {
    let cfg = withSelection(EMPTY_JOB, "object", "people");
    cfg = withSelection(cfg, "type", "email");
    cfg = withSelection(cfg, "filters", "missing_only");
    cfg = withSelection(cfg, "cadence", "weekly");
    const changed = withSelection(cfg, "type", "linkedin");
    expect(changed.filter).toBeNull();
    expect(changed.cadence).toBe("weekly");
  });
});

describe("wiring — the drawer exists, is mounted, and honors the app's lessons", () => {
  const drawer = readFileSync("client/src/components/usip/enrichment/EnrichmentJobDrawer.tsx", "utf8");
  const page = readFileSync("client/src/pages/usip/DataEnrichment.tsx", "utf8");
  const card = readFileSync("client/src/components/usip/enrichment/ActionCard.tsx", "utf8");
  const nav = readFileSync("client/src/components/usip/enrichment/JobStepNav.tsx", "utf8");

  it("the Automate menu's schedule item goes somewhere real — no dangling redirect on that item", () => {
    // 2026-11-06 (audit P89): the page no longer mounts this drawer. Its
    // Create is disabled because nothing saves a job, so the menu item that
    // opened it promised a schedule it could not make. The item now opens the
    // enrichment sweep's settings, the scheduled enrichment that exists. The
    // drawer and its flow rules stay for when a job backend is built. What
    // this protected still holds: the item is no bare redirect to Data Health.
    expect(page).not.toContain("<EnrichmentJobDrawer");
    expect(page).toContain('onClick={() => setLocation(SWEEP_SETTINGS)}><Activity className="size-4 mr-2" /> Schedule the enrichment sweep');
    expect(page).toContain('const SWEEP_SETTINGS = "/v2/settings/enrichment-sweep";');
    expect(page).not.toMatch(/setLocation\("\/data-health"\)}><Activity/);
  });

  it("the shell is the app's Sheet, right side, with the sm:-prefixed width override (dialog max-w lesson)", () => {
    expect(drawer).toContain('side="right"');
    expect(drawer).toContain("sm:max-w-md");
    expect(drawer).not.toMatch(/className="[^"]*\bmax-w-(?!md)/); // no bare max-w-* competing with the sheet default
  });

  it("the canvas is a theme-token dotted grid, not a hardcoded color", () => {
    expect(drawer).toContain("radial-gradient(var(--border) 1px, transparent 1px)");
  });

  it("Next: Settings is gated on workflowComplete, and Create is honestly disabled (no backend)", () => {
    expect(drawer).toContain('label="Next: Settings"');
    expect(drawer).toContain("disabled={!complete}");
    expect(drawer).toContain("isn't wired to a backend yet");
  });

  it("cards are real buttons with platform disabled/focus semantics", () => {
    expect(card).toContain('type="button"');
    expect(card).toContain("disabled={disabled}");
    expect(card).toContain("focus-visible:ring-2");
  });

  it("the step nav gates Settings on the same completion rule the footer uses", () => {
    expect(nav).toContain('s.key === "settings" && !settingsEnabled');
    expect(drawer).toContain("settingsEnabled={complete}");
  });
});
