/**
 * The Autonomy Center asks before it turns things on, and only says it worked
 * when it did (audit 2026-10-20, G62).
 *
 * "All: Autonomous" fired about thirteen mutations back to back with no
 * confirmation and toasted success before any had answered; Start (a campaign)
 * and Run now (segment enrolment) acted on one click. Off still runs at once:
 * stopping must never be slower than starting.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bulkAutopilotChanges, bulkNeedsConfirm, bulkOutcome, settleAll } from "../client/src/lib/autopilotBulk";

const page = readFileSync(join(__dirname, "..", "client", "src", "pages", "usip", "WorkflowsV2.tsx"), "utf8").replace(/\r\n/g, "\n");
const between = (a: string, b: string) => {
  const i = page.indexOf(a), j = page.indexOf(b, i + 1);
  expect(i, a).toBeGreaterThanOrEqual(0);
  expect(j, b).toBeGreaterThan(i);
  return page.slice(i, j);
};

describe("what a bulk change says it will do", () => {
  const rows = [
    { key: "tasks", label: "Task Autopilot", mode: "off" },
    { key: "meetings", label: "Meeting Autopilot", mode: "approval" },
    { key: "chat", label: "Inbound Chat Agent", mode: "auto" },
  ];

  it("names each autopilot that changes, with what it is now", () => {
    expect(bulkAutopilotChanges(rows, "auto")).toEqual([
      { key: "tasks", label: "Task Autopilot", blurb: undefined, from: "off", to: "auto" },
      { key: "meetings", label: "Meeting Autopilot", blurb: undefined, from: "approval", to: "auto" },
    ]);
  });

  it("asks before Approve or Autonomous, not before Off", () => {
    expect(bulkNeedsConfirm("auto")).toBe(true);
    expect(bulkNeedsConfirm("approval")).toBe(true);
    expect(bulkNeedsConfirm("off")).toBe(false);
  });
});

describe("it reports what happened", () => {
  it("waits for every change and names the ones that failed", async () => {
    const out = await settleAll([
      { label: "A", run: async () => 1 },
      { label: "B", run: async () => { throw new Error("FORBIDDEN"); } },
      { label: "C", run: async () => 3 },
    ]);
    expect(out).toEqual({ ok: ["A", "C"], failed: ["B"] });
  });

  it("success only when nothing failed", () => {
    expect(bulkOutcome("auto", 14, []).ok).toBe(true);
    const partial = bulkOutcome("auto", 14, ["Social Autopilot"]);
    expect(partial.ok).toBe(false);
    expect(partial.message).toContain("1 of 14 changes didn't go through: Social Autopilot");
  });
});

describe("the page uses it", () => {
  it("setAll confirms before turning anything on, and Off runs straight away", () => {
    const setAll = between("const setAll = ", "const turnOnFullAutonomy");
    expect(setAll).toContain("if (!bulkNeedsConfirm(mode)) { void runBulk(mode, successMessage); return; }");
    expect(setAll).toContain("confirmAction(");
    expect(setAll).toContain("changes.map((c) => (");
    expect(setAll).toContain("() => void runBulk(mode, successMessage),");
  });

  it("runBulk awaits every change and toasts success only when all succeeded", () => {
    const bulk = between("const runBulk = ", "const setAll = ");
    expect(bulk).toContain("const { failed } = await settleAll(tasks);");
    expect(bulk).toContain("if (out.ok) toast.success(successMessage ?? out.message);");
    expect(bulk).toContain("else toast.error(out.message);");
    expect(bulk).not.toMatch(/\.mutate\(/);
  });

  it("Turn on full autonomy goes through the same confirm", () => {
    expect(between("const turnOnFullAutonomy", "const areSettings = ")).toContain('setAll("approval"');
  });

  it("every autopilot row has an awaitable setter", () => {
    const rows = between("const autopilots = [", "const onCount = ");
    expect((rows.match(/ set: \(m: string\) => /g) ?? []).length).toBe(12);
    expect((rows.match(/ setAsync: \(m: string\) => set\w+\.mutateAsync\(/g) ?? []).length).toBe(12);
  });

  it("Start (a campaign) and Run now (enrolment) ask first", () => {
    const start = between('title="Start"', "<Play");
    expect(start).toContain("confirmAction(");
    expect(start).toContain('setCampaignStatus.mutate({ id: c.id, status: "active" })');
    const runNow = between("disabled={runSegRules.isPending}", "Run now</Button>");
    expect(runNow).toContain("confirmAction(");
    expect(runNow).toContain("() => runSegRules.mutate(),");
  });
});
