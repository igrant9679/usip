import { describe, it, expect } from "vitest";

describe("ARE Router — unit checks", () => {
  it("icpRouter export exists", async () => {
    const { icpRouter } = await import("./routers/are/icp");
    expect(icpRouter).toBeDefined();
  });

  it("campaignsRouter export exists", async () => {
    const { campaignsRouter } = await import("./routers/are/campaigns");
    expect(campaignsRouter).toBeDefined();
  });

  it("prospectsRouter export exists", async () => {
    const { prospectsRouter } = await import("./routers/are/prospects");
    expect(prospectsRouter).toBeDefined();
  });

  it("executionRouter export exists", async () => {
    const { executionRouter } = await import("./routers/are/execution");
    expect(executionRouter).toBeDefined();
  });

  it("scraperRouter export exists and has run procedure", async () => {
    const { scraperRouter } = await import("./routers/are/scraper");
    expect(scraperRouter).toBeDefined();
    // tRPC v11 router — check _def.record for sub-procedures
    const def = (scraperRouter as any)._def;
    const hasRun = def.record?.run !== undefined || def.procedures?.run !== undefined;
    expect(hasRun).toBe(true);
  });

  it("areRouter assembles all sub-routers", async () => {
    const { areRouter } = await import("./routers/are");
    expect(areRouter).toBeDefined();
    // tRPC v11 routers store sub-routers in _def.record
    const def = (areRouter as any)._def;
    const record = def.record ?? def.procedures ?? {};
    expect(Object.keys(record)).toContain("icp");
    expect(Object.keys(record)).toContain("campaigns");
    expect(Object.keys(record)).toContain("prospects");
    expect(Object.keys(record)).toContain("execution");
    expect(Object.keys(record)).toContain("scraper");
  });
});
