/**
 * Pins for the AI Assistant's comprehensive action catalog (2026-09-08).
 *
 * The catalog is derived from the app router, so its safety is the POLICY,
 * not a hand-written list. These tests build it from the real appRouter and
 * check the policy holds on the real surface: it is large (comprehensive),
 * every entry carries a usable schema, the things a chat must never do are
 * absent (sends, deletes, secrets, admin/team/danger-zone routers), and the
 * actions the owner asked for by name are present.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALLOWED_GROUPS, AUTONOMY_DIALS, DENY_LEAF, SEND_ALLOWLIST, buildCatalogFrom, describeGenericAction, refusesUnattended, searchCatalog, titleFor, type CatalogEntry } from "./services/assistantActionCatalog";
import { MUTATING_TOOLS, READ_TOOLS, TOOL_ARGS } from "./services/assistantTools";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

let cached: CatalogEntry[] | null = null;
async function realCatalog() {
  if (cached) return cached;
  const { appRouter } = await import("./routers");
  cached = buildCatalogFrom(appRouter as never);
  return cached;
}
// The app router is a cold import of every server module — well over the
// default 5 s once. Warm it once for the file.
beforeAll(async () => { await realCatalog(); }, 120_000);

describe("action catalog policy on the real router", () => {
  it("is comprehensive: hundreds of actions across the allowed groups", async () => {
    const cat = await realCatalog();
    expect(cat.length).toBeGreaterThan(200);
    const groups = new Set(cat.map((a) => a.group));
    for (const g of ["CRM", "Outreach", "Revenue Engine", "Lists", "Analytics", "Inbound", "Automation", "Proposals"]) expect(groups.has(g), g).toBe(true);
    expect(cat.filter((a) => a.kind === "mutation").length).toBeGreaterThan(80);
  });

  it("never lists a compose-and-send, delete, wipe, secret, admin, team, billing or danger-zone procedure", async () => {
    const cat = await realCatalog();
    const bad = cat.filter((a) => {
      if (a.sends) return !(a.path in SEND_ALLOWLIST);
      const root = a.path.split(".")[0];
      const leaf = a.path.split(".").pop() ?? "";
      return DENY_LEAF.test(leaf)
        || /^(dangerZone|team|settings|usage|scim|aiCredentials|integrations|smtpConfig|sendingAccounts|senderPools|mailbox|unipile|auth|workspace|audit|system|profile|quota|imports)$/.test(root)
        || /send|dispatch|delete|remove|purge|password|invite|apiKey|secret|transfer/i.test(leaf);
    });
    expect(bad.map((a) => a.path)).toEqual([]);
    // Belt and braces: composed sends and admin by name stay out …
    const paths = new Set(cat.map((a) => a.path));
    // 2026-09-20: the three dials the assistant must NEVER reach stay out by
    // root absence from ALLOWED_GROUPS (unipile / linkedinEnrichment /
    // emailAutoSend / settings). The model is told to navigate to the Autonomy
    // Center for these instead — pinned in the prompt test below.
    for (const p of ["unipile.sendMessage", "proposals.sendToClient", "contacts.sendAdHocEmail", "dangerZone.transferOwnership", "team.setMemberPassword", "prospects.delete", "sequences.delete", "unipile.setSocialAutopilotSettings", "linkedinEnrichment.setJobChangeSettings", "emailAutoSend.updateAutoSendSettings", "settings.updateAreSettings"]) {
      expect(paths.has(p), p).toBe(false);
    }
    // … and the approval-queue sends (owner decision 2026-09-09) are in, flagged, and say so.
    for (const p of Object.keys(SEND_ALLOWLIST)) {
      const a = cat.find((x) => x.path === p);
      expect(a, p).toBeTruthy();
      expect(a!.sends).toBe(true);
      expect(a!.description).toMatch(/^SENDS .*NOW/);
      expect(describeGenericAction(a!, {})).toMatch(/^⚠ Sends now/);
    }
  });

  it("carries the actions the owner asked for by name", async () => {
    const paths = new Set((await realCatalog()).map((a) => a.path));
    for (const p of ["sequences.create", "sequences.bulkEnroll", "are.campaigns.create", "are.campaigns.update", "are.campaigns.setStatus", "are.prospects.pushExisting", "recordLists.create", "recordLists.addMembers", "reports.run", "reports.save", "reports.setSchedule", "tasks.create", "activities.logCall", "opportunities.create", "opportunities.update", "leads.convert", "proposals.create", "quotes.create", "workflows.create", "segments.create", "personas.create"]) {
      expect(paths.has(p), p).toBe(true);
    }
  });

  it("every entry has a JSON schema the model can fill and a zod gate the confirm path re-runs", async () => {
    const cat = await realCatalog();
    for (const a of cat) {
      expect(typeof a.inputSchema, a.path).toBe("object");
      expect(typeof a.parse, a.path).toBe("function");
    }
    const create = cat.find((a) => a.path === "sequences.create")!;
    expect(JSON.stringify(create.inputSchema)).toContain("steps");
    expect(() => create.parse({})).toThrow(); // name is required
  });

  it("search finds the obvious things", async () => {
    const cat = await realCatalog();
    expect(searchCatalog(cat, "create sequence").map((a) => a.path)).toContain("sequences.create");
    expect(searchCatalog(cat, "add people to campaign").map((a) => a.path)).toContain("are.prospects.pushExisting");
    expect(searchCatalog(cat, "save report", "Analytics").map((a) => a.path)).toContain("reports.save");
    expect(searchCatalog(cat, undefined, "Lists").every((a) => a.group === "Lists")).toBe(true);
  });

  it("titles are humanised", () => {
    expect(titleFor("are.prospects.pushExisting")).toBe("Push existing (are › prospects)");
    expect(Object.keys(ALLOWED_GROUPS).length).toBeGreaterThan(30);
  });
});

describe("the assistant's tool surface", () => {
  it("has the comprehensive tools, partitioned read/mutating, plus ask_user", () => {
    for (const t of ["list_actions", "run_read_action", "run_report", "list_report_fields"]) expect(READ_TOOLS).toContain(t);
    for (const t of ["run_action", "add_to_campaign", "add_to_campaign_by_filter", "enroll_by_filter", "add_to_list_by_filter", "create_sequence", "log_call", "queue_calls", "save_report"]) expect(MUTATING_TOOLS).toContain(t);
    expect("ask_user" in TOOL_ARGS).toBe(true);
  });

  it("the router gates run_action on the catalog at proposal time AND confirm time, and allows up to three cards per turn", () => {
    const src = read("./routers/assistant.ts");
    expect(src).toContain("const MAX_PROPOSALS_PER_TURN = 3;");
    expect(src).toContain('if (name === "run_action") {');
    expect(src).toContain('entry.kind !== "mutation"');
    expect((src.match(/getAction\(String\(args\.path\)\)/g) ?? []).length).toBe(3); // read, propose, confirm
    expect(src).toContain("pendingActions, question");
    expect(src).toContain('if (name === "ask_user")');
  });

  it("is consultative by prompt: asks focused questions, recommends with numbers, walks through", () => {
    const src = read("./routers/assistant.ts");
    for (const s of ["Be consultative", "Make recommendations", "Walk the user through", "ask_user", "never be lost"]) {
      expect(src.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  it("tells the model the assistant-only dial rules and where the three missing dials live", () => {
    const src = read("./routers/assistant.ts");
    expect(src).toContain("Social Autopilot, Job Change Autopilot and Email AI auto-send are NOT in the catalog");
  });

  it("is reachable from anywhere: the Shell mounts the drawer, a top-bar button and Ctrl/Cmd+J", () => {
    const shell = read("../client/src/components/usip/Shell.tsx");
    expect(shell).toContain("<AssistantDrawer />");
    expect(shell).toContain('data-tour-id="assistant-button"');
    expect(shell).toMatch(/key\.toLowerCase\(\) === "j"/);
    const page = read("../client/src/pages/usip/AIAssistant.tsx");
    const drawer = read("../client/src/components/usip/AssistantDrawer.tsx");
    expect(page).toContain("<AssistantChat");
    expect(drawer).toContain("<AssistantChat");
    // One conversation across page and drawer.
    expect(read("../client/src/components/usip/AssistantChat.tsx")).toContain("useAssistantStore()");
  });
});

/**
 * 2026-09-20: the catalog really does reach the Autonomy Center's setters —
 * they are the same adminWsProcedure the /v2/workflows page calls — so the
 * question is no longer "does it work" but "does the card say what arming it
 * means", and "can chat reach the one mode a human has to acknowledge in
 * person". Both are pinned here.
 */
describe("autonomy dials through the assistant", () => {
  it("every dial the catalog exposes names itself and its blast radius", async () => {
    const cat = await realCatalog();
    for (const path of Object.keys(AUTONOMY_DIALS)) {
      const entry = cat.find((a) => a.path === path);
      expect(entry, path).toBeTruthy();
      // The dial sentence wins over the router's group boilerplate.
      expect(entry!.description, path).toBe(AUTONOMY_DIALS[path]);
      expect(entry!.description, path).toMatch(/^AUTONOMY DIAL/);
      expect(describeGenericAction(entry!, { mode: "approval" }), path).toMatch(/^⚠ Changes an autonomy dial — /);
    }
  });

  it("arming Auto is marked louder than arming Approve", async () => {
    const cat = await realCatalog();
    for (const path of ["tasks.setAutopilotSettings", "are.campaigns.setRoutingSettings"]) {
      const entry = cat.find((a) => a.path === path)!;
      expect(describeGenericAction(entry, { mode: "auto" }), path).toMatch(/^⚠⚠ Turns on UNATTENDED action — /);
    }
    const all = cat.find((a) => a.path === "are.campaigns.setAllAutonomy")!;
    expect(describeGenericAction(all, { mode: "full" })).toMatch(/^⚠⚠ Turns on UNATTENDED action — /);
  });

  it("no dial setter reaches the model as router boilerplate", async () => {
    // Catches a new dial router being added to ALLOWED_GROUPS later without a
    // sentence: the card would say "Tasks: create, complete, snooze…" and
    // never mention that the workspace starts acting on its own.
    const cat = await realCatalog();
    const dialish = cat.filter((a) => {
      const leaf = a.path.split(".").pop() ?? "";
      return /^set.*(Autopilot|FollowUp|Sweep|Backfill|Routing)Settings$/.test(leaf)
        || a.path === "optimization.setSettings"
        || a.path === "are.campaigns.setAllAutonomy";
    });
    expect(dialish.length).toBeGreaterThanOrEqual(11);
    for (const a of dialish) expect(a.path in AUTONOMY_DIALS, a.path).toBe(true);
  });

  it("the two unattended-adjacent rows that are not dials still say what they cost", async () => {
    // workflows.toggle is a per-rule switch (there are many rules) and
    // prospects.runSweep is a one-shot, so neither belongs in AUTONOMY_DIALS —
    // but an enabled rule fires with no human, and a sweep spends credits.
    const cat = await realCatalog();
    const toggle = cat.find((a) => a.path === "workflows.toggle");
    expect(toggle).toBeTruthy();
    expect(toggle!.description).toContain("no human in between");
    expect(("workflows.toggle" in AUTONOMY_DIALS)).toBe(false);
    const sweep = cat.find((a) => a.path === "prospects.runSweep");
    expect(sweep).toBeTruthy();
    expect(sweep!.description).toContain("SPENDS Reoon");
  });

  it("the assistant cannot reach fully unattended autonomy by ANY catalog path", () => {
    // are.campaigns.create is a workspaceProcedure — before this gate a REP
    // could mint a live, fully-unattended campaign in one confirm through
    // run_action, walking around every guard on the create_campaign tool.
    expect(refusesUnattended("are.campaigns.create", { autonomyMode: "full" })).toBeTruthy();
    expect(refusesUnattended("are.campaigns.create", { launch: true })).toBeTruthy();
    expect(refusesUnattended("are.campaigns.update", { id: 1, autonomyMode: "full" })).toBeTruthy();
    expect(refusesUnattended("are.campaigns.update", { id: 1, autonomyMode: "review_release" })).toBeTruthy();
    expect(refusesUnattended("are.campaigns.setAllAutonomy", { mode: "full" })).toBeTruthy();
    // The human-in-the-loop values, and the dials that are not campaign
    // autonomy, are left alone — this is a refusal, not a blanket block.
    expect(refusesUnattended("are.campaigns.create", { autonomyMode: "batch_approval", launch: false })).toBeNull();
    expect(refusesUnattended("are.campaigns.setAllAutonomy", { mode: "batch_approval" })).toBeNull();
    expect(refusesUnattended("tasks.setAutopilotSettings", { mode: "auto" })).toBeNull();
    expect(refusesUnattended("are.campaigns.update", { id: 1, name: "x" })).toBeNull();
  });

  it("both run_action legs apply the refusal and the admin gate", () => {
    const src = read("./routers/assistant.ts");
    expect((src.match(/refusesUnattended\(/g) ?? []).length).toBe(2); // propose, confirm
    expect((src.match(/AUTONOMY_DIALS\[entry\.path\]/g) ?? []).length).toBe(2);
  });

  it("a rep cannot arm a dial through chat", () => {
    const src = read("./routers/assistant.ts");
    expect(src).toMatch(/import \{[^}]*isAdminRole[^}]*\} from "\.\.\/_core\/workspace"/);
    expect(src).toContain("!isAdminRole(ctx.member.role)");
  });
});
