/**
 * Owner, 2026-11-23: "I want to be able to re-enable / disable all
 * communications from several places within the app", and "within the
 * Elsie/AI Assistant also".
 *
 * Before this, Pause all outbound could be flipped in one place (Settings →
 * Workspace overview → Send window), it left AI calls running (their own
 * switch, on another page), and Elsie could read it but not change it.
 *
 * Held here:
 *   1. one write sets BOTH flags, and the senders see it at once;
 *   2. it is admin-only, audited as itself, and a router of exactly two
 *      procedures, so opening it to Elsie opens nothing else;
 *   3. Elsie's card says what stops or starts, and a non-admin never gets one;
 *   4. the switch is drawn in the header, the status bar, the Autonomy Center
 *      and Settings, and none of them writes without asking first.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { workspaceSettings } from "../drizzle/schema";

const h = vi.hoisted(() => ({
  db: null as any,
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  inserts: 0,
  audits: [] as Record<string, unknown>[],
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (e: Record<string, unknown>) => { h.audits.push(e); } }));

import { getWorkspaceSendWindow, inSendWindow, invalidateSendWindowCache } from "./services/sendWindow";
import { isOutboundPaused } from "./services/outboundPause";
import { readCommunications, setCommunicationsPaused } from "./services/communications";
import {
  COMMUNICATIONS_PAUSE_EFFECT, COMMUNICATIONS_RESUME_EFFECT, communicationsPartialDetail, communicationsState,
} from "@shared/communications";
import {
  ALLOWED_GROUPS, COMMUNICATIONS_SWITCH_PATH, DENY_LEAF, buildCatalogFrom, describeGenericAction, searchCatalog, type CatalogEntry,
} from "./services/assistantActionCatalog";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** One workspace_settings row, read by both the send window (aliased) and the switch. */
function makeDb() {
  const rowOut = () => (h.row ? [{ ...h.row, pausedAt: h.row.outboundPausedAt ?? null, startHour: 6, endHour: 17, days: "1,2,3,4,5", timezone: "America/New_York" }] : []);
  const select = (): any => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; }, where() { return b; }, limit() { return b; },
      then(res: (v: unknown) => void) { return res(st.table === workspaceSettings ? rowOut() : []); },
    };
    return b;
  };
  return {
    select,
    insert: () => ({ values: async (v: Record<string, unknown>) => { h.inserts++; h.row = { outboundPausedAt: null, aiCallsPausedAt: null, ...v }; } }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { h.updates.push(patch); h.row = { ...(h.row ?? {}), ...patch }; } }) }),
  };
}

// Wednesday 2026-09-30, 10:00 in New York: inside the default window.
const MID_WINDOW = Date.UTC(2026, 8, 30, 14, 0);
const NOW = new Date("2026-11-23T15:00:00Z");

beforeEach(() => {
  invalidateSendWindowCache();
  h.db = makeDb();
  h.row = { outboundPausedAt: null, aiCallsPausedAt: null };
  h.updates = [];
  h.inserts = 0;
  h.audits = [];
});

describe("one state from two flags", () => {
  it("is on, paused or partial, and partial says which half", () => {
    expect(communicationsState(false, false)).toBe("on");
    expect(communicationsState(true, true)).toBe("paused");
    expect(communicationsState(true, false)).toBe("partial");
    expect(communicationsState(false, true)).toBe("partial");
    expect(communicationsPartialDetail(true, false)).toBe("Email and LinkedIn are paused. AI calls are on.");
    expect(communicationsPartialDetail(false, true)).toBe("AI calls are paused. Email and LinkedIn are on.");
    expect(communicationsPartialDetail(true, true)).toBe("");
    expect(communicationsPartialDetail(false, false)).toBe("");
  });

  it("the confirm names every channel that stops, and what still goes", () => {
    for (const word of ["Revenue Engine", "sequence emails", "LinkedIn", "meeting invites", "chat follow-ups", "by hand", "AI calls", "your own team", "booking confirmation"]) {
      expect(COMMUNICATIONS_PAUSE_EFFECT, word).toContain(word);
    }
    expect(COMMUNICATIONS_RESUME_EFFECT).toContain("send window");
    expect(COMMUNICATIONS_RESUME_EFFECT).toContain("paused on its own stays paused");
  });
});

describe("the write", () => {
  it("pausing sets both flags in one update, and every sender sees it at once", async () => {
    // The engines have just cached "open".
    expect(await inSendWindow(2, MID_WINDOW)).toBe(true);
    const r = await setCommunicationsPaused(2, true, 7, NOW);
    expect(h.updates).toEqual([{ outboundPausedAt: NOW, aiCallsPausedAt: NOW }]);
    expect(r.changed).toBe(true);
    expect(r.after).toMatchObject({ state: "paused", emailPaused: true, callsPaused: true });
    // No minute's wait: the cache went with the write.
    expect(await inSendWindow(2, MID_WINDOW)).toBe(false);
    expect((await getWorkspaceSendWindow(2, MID_WINDOW)).paused).toBe(true);
    expect(await isOutboundPaused(2)).toBe(true);
    // The dialer's own column, which is what it reads.
    expect(h.row!.aiCallsPausedAt).toBe(NOW);
    expect(read("./services/aiCallDialer.ts")).toContain("if (settings?.aiCallsPausedAt) {");
  });

  it("resuming clears both, and the senders are open again at once", async () => {
    h.row = { outboundPausedAt: new Date("2026-11-16T00:00:00Z"), aiCallsPausedAt: new Date("2026-11-17T00:00:00Z") };
    expect(await inSendWindow(2, MID_WINDOW)).toBe(false);
    const r = await setCommunicationsPaused(2, false, 7, NOW);
    expect(h.updates).toEqual([{ outboundPausedAt: null, aiCallsPausedAt: null }]);
    expect(r.before.state).toBe("paused");
    expect(r.after).toMatchObject({ state: "on", emailPaused: false, callsPaused: false, emailPausedAt: null, callsPausedAt: null });
    expect(await inSendWindow(2, MID_WINDOW)).toBe(true);
  });

  it("pausing a half-paused workspace keeps the time the first half was paused at", async () => {
    const earlier = new Date("2026-11-16T00:00:00Z");
    h.row = { outboundPausedAt: earlier, aiCallsPausedAt: null };
    expect((await readCommunications(2)).state).toBe("partial");
    const r = await setCommunicationsPaused(2, true, 7, NOW);
    expect(h.updates).toEqual([{ outboundPausedAt: earlier, aiCallsPausedAt: NOW }]);
    expect(r.after.emailPausedAt).toBe(earlier.toISOString());
    expect(r.after.state).toBe("paused");
  });

  it("resuming a half-paused workspace clears the half that was paused on its own", async () => {
    h.row = { outboundPausedAt: null, aiCallsPausedAt: new Date("2026-11-17T00:00:00Z") };
    const r = await setCommunicationsPaused(2, false, 7, NOW);
    expect(h.updates).toEqual([{ outboundPausedAt: null, aiCallsPausedAt: null }]);
    expect(r.before.state).toBe("partial");
    expect(r.after.state).toBe("on");
  });

  it("is audited as itself, with what it was and what it became", async () => {
    await setCommunicationsPaused(2, true, 7, NOW);
    expect(h.audits).toEqual([{
      workspaceId: 2, actorUserId: 7, action: "update", entityType: "communications_switch", entityId: 2,
      before: { emailPaused: false, callsPaused: false },
      after: { emailPaused: true, callsPaused: true },
    }]);
  });

  it("asking for the state it is already in writes nothing and audits nothing", async () => {
    const r = await setCommunicationsPaused(2, false, 7, NOW);
    expect(r.changed).toBe(false);
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("a workspace with no settings row gets one, then the pause", async () => {
    h.row = null;
    expect((await readCommunications(2)).state).toBe("on");
    const r = await setCommunicationsPaused(2, true, 7, NOW);
    expect(h.inserts).toBe(1);
    expect(r.after.state).toBe("paused");
    expect(h.row).toMatchObject({ workspaceId: 2, outboundPausedAt: NOW, aiCallsPausedAt: NOW });
  });

  it("the update is scoped to the workspace, where it can be read", () => {
    const src = read("./services/communications.ts");
    expect(src).toContain("await db.update(workspaceSettings).set(next).where(eq(workspaceSettings.workspaceId, workspaceId));");
  });
});

describe("the two procedures", () => {
  let procedures: Record<string, { _def?: { type?: string } }> = {};
  let catalog: CatalogEntry[] = [];
  beforeAll(async () => {
    const { appRouter } = await import("./routers");
    procedures = (appRouter as unknown as { _def: { procedures: typeof procedures } })._def.procedures;
    catalog = buildCatalogFrom(appRouter as never);
  }, 120_000);

  it("the router is exactly the read and the switch, so opening it to Elsie opens nothing else", () => {
    const mine = Object.keys(procedures).filter((p) => p.startsWith("communications.")).sort();
    expect(mine).toEqual(["communications.setPaused", "communications.status"]);
    expect(procedures["communications.status"]._def?.type).toBe("query");
    expect(procedures["communications.setPaused"]._def?.type).toBe("mutation");
    expect(COMMUNICATIONS_SWITCH_PATH).toBe("communications.setPaused");
    expect(ALLOWED_GROUPS.communications.group).toBe("Outreach");
  });

  it("the switch is an admin's, and anyone in the workspace may read it", () => {
    const src = read("./routers/communications.ts");
    expect(src).toMatch(/setPaused: adminWsProcedure\s*\.input\(z\.object\(\{ paused: z\.boolean\(\) \}\)\)/);
    expect(src).toContain("status: workspaceProcedure.query(");
    expect(src).toContain("canChange: isAdminRole(ctx.member.role)");
  });

  it("both are in Elsie's catalog under their own sentences, and neither is caught by the deny list", () => {
    const status = catalog.find((a) => a.path === "communications.status");
    const set = catalog.find((a) => a.path === COMMUNICATIONS_SWITCH_PATH);
    expect(status).toBeTruthy();
    expect(set).toBeTruthy();
    expect(status!.kind).toBe("query");
    expect(set!.kind).toBe("mutation");
    expect(set!.sends).toBe(false);
    expect(set!.description).toMatch(/^COMMUNICATIONS SWITCH \(admin only\)/);
    expect(set!.description).not.toBe(`${ALLOWED_GROUPS.communications.description}.`);
    expect(DENY_LEAF.test("setPaused")).toBe(false);
    expect(DENY_LEAF.test("status")).toBe(false);
    // Only a boolean goes in.
    expect(() => set!.parse({ paused: true })).not.toThrow();
    expect(() => set!.parse({})).toThrow();
    expect(() => set!.parse({ paused: "yes" })).toThrow();
  });

  it("Elsie finds it when asked in the owner's words", () => {
    for (const ask of ["pause all communications", "resume all communications", "disable all outbound", "turn sending back on"]) {
      expect(searchCatalog(catalog, ask).slice(0, 3).map((a) => a.path), ask).toContain(COMMUNICATIONS_SWITCH_PATH);
    }
    // And it does not push the pinned asks off their own answers.
    expect(searchCatalog(catalog, "create sequence").map((a) => a.path)).toContain("sequences.create");
    expect(searchCatalog(catalog, "add people to campaign").map((a) => a.path)).toContain("are.prospects.pushExisting");
  });

  it("the card leads with what stops or starts, in the app's own words", () => {
    const set = catalog.find((a) => a.path === COMMUNICATIONS_SWITCH_PATH)!;
    expect(describeGenericAction(set, { paused: true })).toBe(`⚠ Pauses ALL communications — ${COMMUNICATIONS_PAUSE_EFFECT}`);
    expect(describeGenericAction(set, { paused: false })).toBe(`⚠ Resumes ALL communications — ${COMMUNICATIONS_RESUME_EFFECT}`);
  });

  it("a non-admin gets no card, and a card cannot be confirmed by one", () => {
    const src = read("./routers/assistant.ts");
    expect((src.match(/entry\.path === COMMUNICATIONS_SWITCH_PATH && !isAdminRole\(ctx\.member\.role\)/g) ?? []).length).toBe(2); // propose, confirm
    const proposeAt = src.indexOf("entry.path === COMMUNICATIONS_SWITCH_PATH && !isAdminRole(ctx.member.role)");
    const describeAt = src.indexOf("description = describeGenericAction(entry, args.input);");
    expect(proposeAt).toBeGreaterThan(-1);
    expect(describeAt).toBeGreaterThan(proposeAt);
    // Refused before the card's sentence is written, with nothing in between that could skip it.
    expect(src.slice(proposeAt, describeAt)).toContain("continue;");
    expect(src).toContain('throw new TRPCError({ code: "FORBIDDEN", message: "The communications switch is admin-only." });');
  });

  it("Elsie is told when she may propose it, and that it is the one settings write", () => {
    const src = read("./routers/assistant.ts");
    expect(src).toContain("- Communications switch: communications.status says whether email, LinkedIn and AI calls are on, paused or partly paused.");
    expect(src).toContain("propose communications.setPaused with run_action");
    expect(src).toContain("Never propose resuming to get past a send that was refused");
    expect(src).toContain("You cannot change any of them (the one exception is the communications switch above)");
  });
});

describe("where the switch is", () => {
  const sw = read("../client/src/components/usip/CommunicationsSwitch.tsx");

  it("in the header of every page, the status bar, the Autonomy Center and Settings", () => {
    const shell = read("../client/src/components/usip/Shell.tsx");
    const headerAt = shell.indexOf("<header");
    const headerEnd = shell.indexOf("</header>");
    expect(headerAt).toBeGreaterThan(-1);
    expect(headerEnd).toBeGreaterThan(headerAt);
    expect(shell.slice(headerAt, headerEnd)).toContain("<CommunicationsHeaderButton />");
    expect(read("../client/src/components/usip/SendingStatusBar.tsx")).toContain('{b.key === "outbound_paused" ? <> <CommunicationsResumeLink /></> : null}');
    expect(read("../client/src/pages/usip/WorkflowsV2.tsx")).toContain("<CommunicationsCard />");
    expect(read("../client/src/pages/usip/Settings.tsx")).toContain("<CommunicationsCard />");
    // The status bar is on nine pages; it is where the resume link rides.
    const pages = ["AREHub", "ARECampaigns", "SequencesV2", "SequenceEditor", "EmailsV2", "Mailbox", "InboxWorkspace", "MeetingsV2", "Social"];
    for (const p of pages) expect(read(`../client/src/pages/usip/${p}.tsx`), p).toContain("<SendingStatusBar");
  });

  it("nothing is written without the confirm: the only writes are the dialog's two buttons", () => {
    expect((sw.match(/set\.mutate\(/g) ?? []).length).toBe(2);
    const dialogAt = sw.indexOf("<AlertDialog open={ask !== null}");
    const dialogEnd = sw.indexOf("</AlertDialog>");
    expect(dialogAt).toBeGreaterThan(-1);
    expect(dialogEnd).toBeGreaterThan(dialogAt);
    const dialog = sw.slice(dialogAt, dialogEnd);
    expect(dialog).toContain("onClick={() => set.mutate({ paused: true })}");
    expect(dialog).toContain("onClick={() => set.mutate({ paused: false })}");
    expect(dialog).toContain("{COMMUNICATIONS_PAUSE_EFFECT}");
    expect(dialog).toContain("{COMMUNICATIONS_RESUME_EFFECT}");
    // Each drawing's button only opens the dialog.
    expect((sw.match(/onClick=\{c\.open\}/g) ?? []).length).toBe(3);
  });

  it("a non-admin sees the state and is offered no write", () => {
    expect(sw).toContain('if (!canChange) return setAsk("view");');
    // The view has neither action button.
    expect(sw).toContain('{ask === "pause" || ask === "choose" ? (\n            <AlertDialogAction className="bg-rose-600');
    expect(sw).toContain('{ask === "resume" || ask === "choose" ? (\n            <AlertDialogAction onClick');
    expect(sw).toContain('if (!c.canChange || !c.state || c.state === "on") return null;');
    expect(sw).toContain("An admin can change this.");
  });

  it("paused shows its word on every width; on is a quiet icon", () => {
    expect(sw).toContain('off ? "inline" : "hidden xl:inline"');
    expect(sw).toContain('const SHORT: Record<CommunicationsState, string> = { on: "Sending on", paused: "Paused", partial: "Partly paused" };');
  });

  it("the older switches keep the header in step", () => {
    expect(read("../client/src/pages/usip/Settings.tsx")).toContain("if (vars.outboundPaused !== undefined) { utils.communications.status.invalidate(); utils.sendingStatus.current.invalidate(); }");
    expect(read("../client/src/components/usip/settings/VoiceAgentsSection.tsx")).toContain("void utils.communications.status.invalidate();");
    for (const inv of ["utils.communications.status.invalidate()", "utils.sendingStatus.current.invalidate()", "utils.settings.get.invalidate()", "utils.voiceAgents.invalidate()"]) {
      expect(sw, inv).toContain(inv);
    }
  });

  it("Elsie's manual and the Help Center say where it is and who may flip it", async () => {
    const { PRODUCT_KNOWLEDGE } = await import("./productKnowledge");
    expect(PRODUCT_KNOWLEDGE).toContain("Top bar, left to right: the workspace switcher, the communications switch, Elsie,");
    expect(PRODUCT_KNOWLEDGE).toContain("Communications switch (top bar of every page): it reads Sending on, Paused or Partly paused. An admin clicks it and confirms, and email, LinkedIn and AI calls all pause or all resume");
    expect(PRODUCT_KNOWLEDGE).toContain("a campaign or sequence paused on its own stays paused.");
    const help = read("./seedHelpContent.ts");
    expect(help).toContain("**One switch for everything.** The **communications switch** in the top bar of every page");
    expect(help).toContain("Only admins can change it; everyone else sees the state.");
  });

  it("the status bar says where the pause can be lifted", async () => {
    expect(read("./services/sendingStatus.ts")).toContain("until an admin resumes: here, with the switch in the page header, or in Settings → Workspace overview → Send window.");
  });
});
