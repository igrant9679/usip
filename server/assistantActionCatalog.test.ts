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
import { ALLOWED_GROUPS, DENY_LEAF, SEND_ALLOWLIST, buildCatalogFrom, describeGenericAction, searchCatalog, titleFor, type CatalogEntry } from "./services/assistantActionCatalog";
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
    for (const p of ["unipile.sendMessage", "proposals.sendToClient", "contacts.sendAdHocEmail", "dangerZone.transferOwnership", "team.setMemberPassword", "prospects.delete", "sequences.delete"]) {
      expect(paths.has(p), p).toBe(false);
    }
    // … and the approval-queue sends (owner decision 2026-09-09) are in, flagged, and say so.
    for (const p of Object.keys(SEND_ALLOWLIST)) {
      const a = cat.find((x) => x.path === p);
      expect(a, p).toBeTruthy();
      expect(a!.sends).toBe(true);
      expect(a!.description).toMatch(/SENDS EMAIL NOW/);
      expect(describeGenericAction(a!, {})).toMatch(/Sends email now/);
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
