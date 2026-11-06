/**
 * Batch Ob of the 2026-10-20 audit: screens whose words promised something the
 * code does not do. Each block reads the shipped copy and the code it
 * describes, so a sentence and its behaviour cannot drift apart again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
/** The text from `start` up to `end` (exclusive), failing loudly if either is missing. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b, `missing after ${start}: ${end}`).toBeGreaterThan(-1);
  return src.slice(a, b);
}

describe("O51: the pause copy says what happens to held sends", () => {
  const settings = read("client/src/pages/usip/Settings.tsx");
  const card = between(settings, "function SendWindowSection(", "<Label>From</Label>");

  it("the behaviour it describes: a held Social Autopilot opener becomes a task, not a later send", () => {
    const svc = read("server/services/socialAutopilot.ts");
    const held = between(svc, "const hold = await autoSendHold(workspaceId);", 'return "held_task";');
    expect(held).toContain("db.insert(tasks)");
    expect(held).not.toContain("sendMessage(");
  });

  it("neither state of the switch says everything held goes later", () => {
    expect(card).not.toContain("nothing is dropped");
    expect(card).not.toContain("waits and goes once you switch this off (inside the window below), and what a person sends is refused");
    // Both the on and the off wording name the exception.
    const on = between(card, "? `Paused since", "`\n");
    const off = between(card, ': "Stops everything', '"}');
    for (const s of [on, off]) {
      expect(s).toContain("Social Autopilot opener");
      expect(s).toContain("becomes a task for you to send instead");
      expect(s).toContain("booking-link reply held more than a week is dropped");
    }
  });

  it("the window's own description names the opener too", () => {
    expect(card).toContain("A Social Autopilot opener that comes due outside it becomes a task for you to send instead.");
  });

  it("the help articles no longer promise that nothing is dropped", () => {
    const help = read("server/seedHelpContent.ts");
    expect(help).not.toContain("Nothing is dropped; held work goes once you switch it off");
    expect(help).not.toContain("**Nothing is dropped.**");
    expect(help).toContain("a Social Autopilot opener held by the pause becomes a task for the rep and is not sent later");
    expect(read("server/seedHelpOperatorManual.ts")).not.toContain("nothing is dropped");
  });
});
