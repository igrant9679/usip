/**
 * Pins for the demo EXTRAS seeder (2026-09-07). Source-level: the seeder
 * must be reachable from a super-admin-only procedure, must be idempotent,
 * must never leave anything that can SEND, and must cover every page the
 * owner listed as empty.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const seeder = readFileSync(new URL("./demoSeedExtras.ts", import.meta.url), "utf8");
const admin = readFileSync(new URL("./routers/admin.ts", import.meta.url), "utf8");

describe("demo extras seeder", () => {
  it("is wired to a super-admin-only admin procedure that runs the ARE demo seeder first", () => {
    const proc = admin.slice(admin.indexOf("seedDemoExtras: adminWsProcedure"), admin.indexOf("sampleDataStatus: adminWsProcedure"));
    expect(proc).toContain('ctx.member.role !== "super_admin"');
    expect(proc.indexOf("seedAreDemoForAllWorkspaces()")).toBeLessThan(proc.indexOf("seedDemoExtras(ctx.workspace.id"));
    expect(seeder).toContain("export async function seedDemoExtras(");
  });

  it("is idempotent via an audit marker and never leaves a live sender or campaign", () => {
    expect(seeder).toContain('eq(auditLog.entityType, "demo_extras")');
    expect(seeder).toContain('note: "already seeded"');
    expect(seeder).toContain('entityType: "demo_extras", entityId: workspaceId');
    // the demo mailbox cannot send, and the demo campaign is parked
    expect(seeder).toMatch(/enabled: false, isDefault: true/);
    expect(seeder).toContain('set({ status: "paused" } as never).where(and(eq(areCampaigns.id, camp.id)');
    // future steps are never scheduled in the past (dispatcher would grab them if unpaused)
    expect(seeder).toContain("Math.max(when.getTime(), Date.now() + 86400000)");
  });

  it("covers every page the base seed leaves empty", () => {
    for (const t of ["prospects", "scoreResults", "recordLists", "audienceSegments", "personas", "icpProfiles", "brandVoiceProfiles", "bookingLinks", "meetings", "areExecutionQueue", "emailLog", "emailReplies", "voiceCalls", "websiteVisits", "forms", "formSubmissions", "landingPages", "chatAgents", "chatSessions", "activities", "proposals", "quotes", "savedReports", "notifications"]) {
      expect(seeder, t).toContain(`db.insert(${t})`);
    }
    // People rows link back to the contacts they mirror (both directions)
    expect(seeder).toContain("linkedContactId: p.linkedContactId");
    expect(seeder).toContain("set({ personProspectId: pid }");
  });
});
