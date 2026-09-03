/**
 * Phase 1 of the seams audit (owner: "start with phase 1", 2026-09-02):
 * "stop the lies". Every pin here is a place the app used to say something
 * untrue — a dial that changed nothing, a rail item that launched nothing,
 * an aggregator that omitted four queues, an analytics page blind to the
 * engine that sends most of the mail. Source pins keep each truth in place.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

describe("navigation tells the product story", () => {
  const registry = client("lib", "toolRegistry.ts");
  const shell = client("components", "usip", "Shell.tsx");

  it("groups are the seven products plus the three cross-cutting groups", () => {
    for (const g of ["Prospecting", "CRM", "Outreach", "Marketing", "Proposals", "Dialer", "Customer Success", "Daily", "Analytics", "Configuration"]) {
      expect(registry).toContain(`"${g}",`);
    }
    for (const dead of ['"Engage"', '"Win deals"', '"Autopilot & AI"', '"Customer success"', '"Analytics & reporting"', '"Inbound"']) {
      expect(registry).not.toContain(dead);
    }
  });

  it("the unfinished Broadcasts product is off the rail but still reachable", () => {
    const row = registry.slice(registry.indexOf('href: "/campaigns"'), registry.indexOf("}", registry.indexOf('href: "/campaigns"')));
    expect(row).toContain('group: "Marketing"');
    expect(row).not.toContain("primary: true");
    expect(row).toContain("Not yet sending");
  });

  it("Customer Success holds Customers, Renewals and QBRs; Help Center is configuration", () => {
    for (const href of ['"/customers"', '"/renewals"', '"/qbrs"']) {
      const row = registry.slice(registry.indexOf(`href: ${href}`), registry.indexOf("}", registry.indexOf(`href: ${href}`)));
      expect(row, href).toContain('group: "Customer Success"');
    }
    const help = registry.slice(registry.indexOf('href: "/help"'), registry.indexOf("}", registry.indexOf('href: "/help"')));
    expect(help).toContain('group: "Configuration"');
  });

  it("the rail renders the product sections, in story order, with no Marketing section", () => {
    const meta = shell.slice(shell.indexOf("const GROUP_META"), shell.indexOf("const EXTRA_GROUP_COLORS"));
    const order = ["Prospecting", "CRM", "Outreach", "Proposals", "Dialer", "Customer Success"].map((g) => meta.indexOf(`group: "${g}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(meta).not.toContain('group: "Marketing"');
  });
});

describe("the Autonomy Center's engine dial is real", () => {
  const page = client("pages", "usip", "WorkflowsV2.tsx");
  const router = read("routers", "are", "campaigns.ts");

  it("one server call sets every campaign and the default", () => {
    expect(router).toContain("setAllAutonomy: adminWsProcedure");
    expect(router).toContain("db.update(areCampaigns)");
    expect(router).toContain("areDefaultAutonomyMode: input.mode");
  });

  it("the dial and both bulk setters go through it", () => {
    expect(page).toContain("trpc.are.campaigns.setAllAutonomy.useMutation");
    expect(page).toContain('onValueChange={(v) => setAllEngineAutonomy.mutate({ mode: v as "full" | "batch_approval" })}');
    const setAll = page.slice(page.indexOf("const setAll = "), page.indexOf("const turnOnFullAutonomy"));
    expect(setAll).toContain('setAllEngineAutonomy.mutate({ mode: "batch_approval" })');
    const full = page.slice(page.indexOf("const turnOnFullAutonomy"), page.indexOf("const areSettings = "));
    expect(full).toContain('setAllEngineAutonomy.mutate({ mode: "batch_approval" })');
  });

  it("review & release is offered nowhere and handled explicitly in the engine", () => {
    for (const f of [page, client("pages", "usip", "ARECampaigns.tsx"), client("pages", "usip", "ARECampaignDetail.tsx"), client("pages", "usip", "ARESettings.tsx")]) {
      expect(f).not.toMatch(/value[:=]\s*"review_release"/);
    }
    const engine = read("areEngine.ts");
    expect(engine).not.toContain("// review_release: leave everything 'pending' for individual review");
    expect(engine).toContain("rows that still carry the value get batch_approval's screening");
    expect(read("services", "assistantTools.ts")).not.toContain('"review_release"');
  });

  it("no surface promises a confidence floor that nothing enforces", () => {
    expect(page).not.toContain("score &amp; confidence");
    expect(client("pages", "usip", "EmailsV2.tsx")).not.toContain("and confidence ≥");
    expect(client("pages", "usip", "AIPipelineQueue.tsx")).not.toContain("is not yet enforced");
  });

  it("Job Change Autopilot says when it actually runs", () => {
    expect(page).toContain("no schedule of its own");
  });
});

describe("settings the engine actually reads", () => {
  it("the ARE dispatcher consults the workspace open-tracking preference", () => {
    const engine = read("areEngine.ts");
    expect(engine).toContain("workspaceSettings.emailOpenTracking");
    expect(engine).toContain("open: openTrackingPref,");
    expect(engine).not.toMatch(/open: true,\s*\n\s*click: false,/);
  });

  it("the workflow API only accepts triggers that fire", () => {
    const ops = read("routers", "operations.ts");
    expect(ops).toMatch(/import \{ LIVE_TRIGGER_IDS[^}]*\} from "@shared\/workflowTriggers"/);
    expect(ops).toContain("triggerType: z.enum(LIVE_TRIGGER_IDS as unknown as [LiveTrigger, ...LiveTrigger[]])");
    expect(ops).not.toContain('"nps_submitted", "signal_received", "field_equals", "schedule"');
  });
});

describe("numbers that used to omit the engine", () => {
  it("the attention aggregator counts all nine queues", () => {
    const att = read("routers", "attention.ts");
    for (const k of ["sequenceDrafts", "socialReplies", "optimizationRecs", "chatFollowUps"]) {
      expect(att).toContain(`${k}.count`);
    }
    expect(att).toContain('eq(emailDrafts.status, "pending_review")');
    expect(att).toContain("isNull(unipileMessages.handledAt)");
    expect(att).toContain("optimizationRecommendations.status");
    expect(att).toContain('like(tasks.title, "Follow up:%")');
    const panel = client("components", "usip", "AttentionPanel.tsx");
    for (const k of ["sequenceDrafts", "socialReplies", "optimizationRecs", "chatFollowUps"]) expect(panel).toContain(`s.${k}`);
  });

  it("Email Analytics counts campaign sends", () => {
    const smtp = read("routers", "smtpConfig.ts");
    expect(smtp).toContain("from(areExecutionQueue)");
    expect(smtp).toContain("const totalSent = allSent.length + areSent;");
  });

  it("Dashboards' two stage ratios are named as stage ratios", () => {
    const dash = client("pages", "usip", "Dashboards.tsx");
    expect(dash).toContain('label: "Opportunities with activity %"');
    expect(dash).toContain('label: "Opportunities past proposal stage %"');
    expect(dash).not.toContain('label: "Reply rate %"');
  });
});
