/**
 * Phase 6 of the seams audit (owner: "Start phase 6", 2026-09-02): the
 * structural finish. (a) The CRM spine — Prospect → Lead → Opportunity →
 * Customer — becomes a derived, visible stage on the person record instead
 * of nine transitions nobody could see. (b) The Sequences product's one real
 * difference (one fixed message per step, the same to everyone) becomes a
 * copy MODE of the ARE campaign, so both outreach models run on one step
 * model, one dispatcher, one suppression list and one approval queue.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

describe("the CRM spine is derived and shown", () => {
  it("prospects.get derives the lifecycle from existing linkages, customer > opportunity > lead > prospect", () => {
    const r = read("routers", "prospects.ts");
    expect(r).toContain("export async function deriveLifecycle");
    const fn = r.slice(r.indexOf("export async function deriveLifecycle"), r.indexOf("export const prospectsRouter"));
    const order = ['stage: "customer"', 'stage: "opportunity"', 'stage: "lead"'].map((s) => fn.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r).toContain("const lifecycle = await deriveLifecycle(db, ctx.workspace.id, row);");
  });
  it("the Prospect page renders the stepper from the server value", () => {
    expect(client("components", "usip", "DetailShell.tsx")).toContain("export function LifecycleStepper");
    const page = client("pages", "usip", "ProspectDetail.tsx");
    expect(page).toContain("<LifecycleStepper");
    expect(page).toContain("stage={(p as any).lifecycle.stage}");
  });
});

describe("fixed copy is a mode of the one engine", () => {
  it("schema + migration 0177 carry copyMode and fixedSteps", () => {
    const schema = read("..", "drizzle", "schema.ts");
    expect(schema).toContain('copyMode: mysqlEnum("copyMode", ["per_person", "fixed"])');
    expect(schema).toContain('fixedSteps: json("fixedSteps")');
    const m = read("_core", "rawMigrations.ts");
    expect(m).toContain("0177_campaign_copy_mode");
    expect(m).toContain("ADD COLUMN `copyMode` ENUM('per_person','fixed')");
  });
  it("the sequence agent assigns fixed steps without an LLM call and before the template path", () => {
    const p = read("routers", "are", "prospects.ts");
    const fn = p.slice(p.indexOf("export async function runSequenceAgent"), p.indexOf("export async function runSequenceAgent") + 9000);
    const fixed = fn.indexOf('copyMode === "fixed"');
    const template = fn.indexOf("const template = await generateCampaignTemplate(campaign, false);");
    expect(fixed).toBeGreaterThan(-1);
    expect(fixed).toBeLessThan(template);
    expect(fn).toContain('"sequence.fixed"');
  });
  it("a campaign can be edited into fixed mode and a sequence converts into one", () => {
    const c = read("routers", "are", "campaigns.ts");
    expect(c).toContain('copyMode: z.enum(["per_person", "fixed"]).optional()');
    expect(c).toContain("if (rest.copyMode !== undefined) updates.copyMode = rest.copyMode;");
    expect(c).toContain("createFixedFromSequence: workspaceProcedure");
    expect(c).toContain('if (x.type !== "email") continue; // task/wait steps: gap only');
    expect(c).toContain('copyMode: "fixed",');
  });
  it("the UI names the choice: campaign detail Copy card, Sequences convert action, Add-to tag", () => {
    expect(client("pages", "usip", "ARECampaignDetail.tsx")).toContain('{ v: "fixed", title: "Fixed template"');
    expect(client("pages", "usip", "SequencesV2.tsx")).toContain("trpc.are.campaigns.createFixedFromSequence.useMutation");
    expect(client("components", "usip", "AddToMenu.tsx")).toContain('c.copyMode === "fixed" ? "fixed copy" : "AI copy"');
  });
});
