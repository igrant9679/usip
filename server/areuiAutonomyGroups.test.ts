/**
 * The Autonomy Center's dials, grouped by effect (audit 2026-10-20, U20):
 * sends to people, spends credits, changes records — with each dial's last
 * run still inline.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOPILOT_EFFECT, EFFECT_GROUPS, groupByEffect } from "../client/src/lib/autopilotEffects";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const page = read("client/src/pages/usip/WorkflowsV2.tsx");
const block = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `end anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
};
/** Every dial key the page defines in its autopilots list. */
const pageKeys = () => {
  const list = block(page, "const autopilots = [", "\n  ];");
  return Array.from(list.matchAll(/\{ key: "(\w+)"/g)).map((m) => m[1]);
};

describe("every dial says what it does when it acts", () => {
  it("each dial on the page has a group, and nothing is classified that is not on the page", () => {
    const keys = pageKeys();
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const k of keys) expect(AUTOPILOT_EFFECT[k], `${k} has no group`).toBeDefined();
    expect(Object.keys(AUTOPILOT_EFFECT).sort()).toEqual([...keys].sort());
  });

  it("the ones that email, invite or message are under Sends; the credit spenders under Spends", () => {
    for (const k of ["meetings", "conversations", "social", "jobChange", "chat", "chatFollowUp"]) expect(AUTOPILOT_EFFECT[k]).toBe("sends");
    for (const k of ["enrichSweep", "companyBackfill"]) expect(AUTOPILOT_EFFECT[k]).toBe("spends");
    for (const k of ["tasks", "deals", "optimization", "routing"]) expect(AUTOPILOT_EFFECT[k]).toBe("records");
  });

  it("groups come in a fixed order, empty ones left out, and an unknown dial is shown, not dropped", () => {
    const g = groupByEffect([{ key: "deals" }, { key: "meetings" }, { key: "somethingNew" }]);
    expect(g.map((x) => [x.effect, x.rows.map((r) => r.key)])).toEqual([["sends", ["meetings"]], ["records", ["deals", "somethingNew"]]]);
    expect(EFFECT_GROUPS.map((x) => x.title)).toEqual(["Sends to people", "Spends credits", "Changes records"]);
  });
});

describe("the page groups the dials and keeps the last run inline", () => {
  const section = block(page, "{/* Autopilots, grouped by what each does", "{/* ARE campaigns */}");

  it("renders one labelled group per effect, inside the tour's anchor", () => {
    expect(section).toContain('<div data-tour-id="autonomy-autopilots"');
    expect(section).toContain("{groupByEffect(autopilots).map((g) => (");
    expect(section).toContain('role="group" aria-labelledby={`autopilot-group-${g.effect}`}');
    expect(section).toContain("{g.title}</h3>");
    // The old flat grid is gone.
    expect(page).not.toContain("{autopilots.map((a) => (");
  });

  it("each dial still shows its last run, and the switch and the run button sit with their kind", () => {
    expect(section).toContain("{a.blurb} · last run {fmtWhen(a.lastRunAt)}");
    const sends = block(section, '{g.effect === "sends" && (', '{g.effect === "spends" && (');
    expect(sends).toContain('<Switch aria-label="Email auto-send"');
    const spends = section.slice(section.indexOf('{g.effect === "spends" && ('));
    expect(spends).toContain("onClick={() => runSweep.mutate({ limit: 25 })}");
  });
});
