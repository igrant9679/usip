/**
 * Owner, 2026-11-24: "I'd like for each workspace to pick which leads/prospect
 * source to use as a primary source (the unselected option will be
 * fallback/secondary). They should be able to do this in settings."
 *
 * The workspace already had one checking order (areSourceOrder), set with
 * up/down arrows on Revenue Engine settings. The primary is not a second
 * setting beside it: it is whichever source that order checks first.
 *
 * Held here:
 *   1. the primary is read from the one order, and picking one moves it to
 *      the front while every other source keeps its place;
 *   2. the searches really do try it first (the waterfall's own ordering);
 *   3. the write is admin-only, takes only a real choice, audits, and
 *      touches nothing but the order;
 *   4. the card is in Settings, reads the same order, and warns when the
 *      primary cannot run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ARE_DEFAULT_SOURCE_ORDER, ARE_SOURCE_IDS, PRIMARY_SOURCE_CHOICES,
  fallbackSourcesOf, fullSourceOrder, isPrimarySourceChoice, orderWithPrimary, primarySourceOf, resolveSourceOrder,
} from "@shared/areSources";
import { workspaceSettings } from "../drizzle/schema";

const h = vi.hoisted(() => ({
  db: null as any,
  row: { workspaceId: 2, areSourceOrder: null as unknown, areScraperSources: null as unknown },
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  audits: [] as Record<string, unknown>[],
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (e: Record<string, unknown>) => { h.audits.push(e); } }));

import { setPrimarySource } from "./services/primarySource";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

function makeDb() {
  return {
    select: () => {
      const b: any = {
        // The service reads the one column, under the name `order`.
        from() { return b; }, where() { return b; }, limit() { return Promise.resolve([{ order: h.row.areSourceOrder }]); },
        then(res: (v: unknown) => void) { return res([{ order: h.row.areSourceOrder }]); },
      };
      return b;
    },
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => { h.updates.push({ table, set }); Object.assign(h.row, set); },
      }),
    }),
    insert: () => ({ values: async () => {} }),
  };
}

beforeEach(() => {
  h.db = makeDb();
  h.row = { workspaceId: 2, areSourceOrder: null, areScraperSources: null };
  h.updates = []; h.audits = [];
});

describe("the primary is the front of the one order", () => {
  it("with nothing stored it is the default order's first choice, and the rest are fallbacks in order", () => {
    expect(primarySourceOf(null)).toBe("quickenrich");
    expect(fallbackSourcesOf(null)).toEqual(["warmysender", "linkedin", "apollo", "leadocean"]);
    // Every choice is a real source, and the default order holds them all.
    for (const c of PRIMARY_SOURCE_CHOICES) expect(ARE_DEFAULT_SOURCE_ORDER).toContain(c);
  });

  it("it follows the stored order, skipping what is not a vendor choice", () => {
    // The workspace's own contacts come first here, and they are not a choice.
    expect(primarySourceOf(["internal", "apollo", "quickenrich"])).toBe("apollo");
    expect(fallbackSourcesOf(["internal", "apollo", "quickenrich"])).toEqual(["quickenrich", "warmysender", "linkedin", "leadocean"]);
    expect(isPrimarySourceChoice("internal")).toBe(false);
    expect(isPrimarySourceChoice("news")).toBe(false);
    expect(isPrimarySourceChoice("apollo")).toBe(true);
  });

  it("picking one moves it to the very front and leaves every other source where it was", () => {
    const stored = ["internal", "apollo", "quickenrich", "news"];
    const before = fullSourceOrder(stored);
    const after = orderWithPrimary(stored, "warmysender");
    expect(after[0]).toBe("warmysender");
    expect(after.slice(1)).toEqual(before.filter((s) => s !== "warmysender"));
    // Nothing lost, nothing doubled.
    expect(after.slice().sort()).toEqual(ARE_SOURCE_IDS.slice().sort());
    expect(primarySourceOf(after)).toBe("warmysender");
    expect(fallbackSourcesOf(after)[0]).toBe("apollo");
  });

  it("picking the current primary changes nothing but puts it ahead of non-vendor sources", () => {
    const after = orderWithPrimary(["internal", "apollo"], "apollo");
    expect(after.slice(0, 2)).toEqual(["apollo", "internal"]);
    expect(orderWithPrimary(after, "apollo")).toEqual(after);
  });

  it("the engine runs the picked source first among a campaign's sources, and a switched-off primary is skipped", () => {
    const order = orderWithPrimary(null, "apollo");
    expect(resolveSourceOrder(order, {}, ["quickenrich", "apollo", "warmysender"])).toEqual(["apollo", "quickenrich", "warmysender"]);
    expect(resolveSourceOrder(order, { apollo: false }, ["quickenrich", "apollo", "warmysender"])).toEqual(["quickenrich", "warmysender"]);
    // Being primary does not add a source to a campaign that did not tick it.
    expect(resolveSourceOrder(orderWithPrimary(null, "leadocean"), {}, ["quickenrich", "apollo"])).toEqual(["quickenrich", "apollo"]);
  });

  it("Source search and the lookup read the same order, and never opt a billed preview in", () => {
    const src = read("./services/prospectSources/registry.ts");
    const fn = src.slice(src.indexOf("export async function eligibleFor("));
    expect(fn).toContain("const { order, mask } = await workspaceOrder(workspaceId);");
    expect(fn).toContain("for (let i = 0; i < order.length; i++) pos.set(order[i], i);");
    expect(fn).toContain("if (!only && !s.capabilities().supportsFreePreview) {");
    expect(src).toContain(".select({ order: workspaceSettings.areSourceOrder, mask: workspaceSettings.areScraperSources })");
  });
});

describe("the write", () => {
  it("moves the choice to the front of the stored order, and audits who it was before and after", async () => {
    h.row.areSourceOrder = ["internal", "quickenrich", "apollo"];
    const r = await setPrimarySource(2, 9, "apollo");
    expect(r).toMatchObject({ ok: true, primary: "apollo", changed: true });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].table).toBe(workspaceSettings);
    // Only the order is written: no switch, no key, no mask.
    expect(Object.keys(h.updates[0].set)).toEqual(["areSourceOrder"]);
    expect((h.updates[0].set.areSourceOrder as string[]).slice(0, 3)).toEqual(["apollo", "internal", "quickenrich"]);
    expect(h.audits).toEqual([expect.objectContaining({
      workspaceId: 2, actorUserId: 9, action: "update", entityType: "primary_prospect_source",
      before: { primary: "quickenrich" }, after: expect.objectContaining({ primary: "apollo" }),
    })]);
  });

  it("picking what is already first writes nothing", async () => {
    h.row.areSourceOrder = ["apollo", "quickenrich"];
    const r = await setPrimarySource(2, 9, "apollo");
    expect(r.changed).toBe(false);
    expect(h.updates).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("the default primary, never stored, is written when picked", async () => {
    const r = await setPrimarySource(2, 9, "quickenrich");
    expect(r.changed).toBe(true);
    expect((h.updates[0].set.areSourceOrder as string[])[0]).toBe("quickenrich");
  });

  it("a primary that sits behind the workspace's own contacts is still moved to the front", async () => {
    h.row.areSourceOrder = ["internal", "apollo"];
    const r = await setPrimarySource(2, 9, "apollo");
    expect(r.changed).toBe(true);
    expect((h.updates[0].set.areSourceOrder as string[])[0]).toBe("apollo");
  });

  it("only an admin, and only a real choice", async () => {
    const src = read("./routers/admin.ts");
    const at = src.indexOf("  setPrimarySource: adminWsProcedure\n    .input(z.object({ source: z.enum(PRIMARY_SOURCE_CHOICES) }))");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 420);
    expect(block).toContain("await getOrSeedSettings(ctx.workspace.id);");
    expect(block).toContain("return setPrimarySource(ctx.workspace.id, ctx.user.id, input.source);");
    const { settingsRouter } = await import("./routers/admin");
    const def = (settingsRouter as unknown as { _def: { procedures: Record<string, { _def: { type: string; inputs: Array<{ safeParse: (v: unknown) => { success: boolean } }> } }> } })._def.procedures.setPrimarySource._def;
    expect(def.type).toBe("mutation");
    expect(def.inputs[0].safeParse({ source: "apollo" }).success).toBe(true);
    // The workspace's own contacts, and a vendor that is only a stub, are not choices.
    expect(def.inputs[0].safeParse({ source: "internal" }).success).toBe(false);
    expect(def.inputs[0].safeParse({ source: "hunter" }).success).toBe(false);
  });
});

describe("the card in Settings", () => {
  const src = read("../client/src/components/usip/settings/PrimarySourceCard.tsx");

  it("is at the top of Settings → Data sources, and findable by its words", () => {
    const hub = read("../client/src/pages/usip/SettingsHub.tsx");
    const section = hub.slice(hub.indexOf('{section === "data-sources" && ('), hub.indexOf("<KeySharingCard kinds={SOURCE_KEY_KINDS} />"));
    expect(section).toContain("<PrimarySourceCard />");
    expect(section.indexOf("<PrimarySourceCard />")).toBeLessThan(section.indexOf("<ProspectSourceRegistryCard />"));
    expect(hub).toContain('"primary source", "fallback", "source order"');
  });

  it("reads the primary and the fallbacks from the same order the searches use", () => {
    expect(src).toContain("const order = settings.data?.areSourceOrder ?? null;");
    expect(src).toContain("const primary = primarySourceOf(order);");
    expect(src).toContain("const fallbacks = fallbackSourcesOf(order);");
    // Listed as they are tried: the primary, then Fallback 1, 2, 3…
    expect(src).toContain("{[primary, ...fallbacks].map((id) => {");
    expect(src).toContain("{chosen ? \"Primary\" : `Fallback ${place + 1}`}");
  });

  it("only an admin can pick, a pick is one write, and the lists it feeds are refreshed", () => {
    expect(src).toContain("disabled={!isAdmin || setPrimary.isPending || chosen}");
    expect(src).toContain("onClick={() => setPrimary.mutate({ source: id })}");
    expect(src).toContain("void utils.settings.getAreSettings.invalidate();");
    expect(src).toContain("onError: (e) => toast.error(");
  });

  it("says when the primary cannot run, and that LeadOcean still needs ticking", () => {
    expect(src).toContain('if (mask[id] === false) return "Switched off";');
    expect(src).toContain('if (!s.credential.configured) return "Not connected";');
    expect(src).toContain("{primaryBlocker ? (");
    expect(src).toContain("Searches skip it and go straight to the fallbacks until that is fixed");
    expect(src).toContain("it still runs only where a campaign or search ticks it");
  });
});
