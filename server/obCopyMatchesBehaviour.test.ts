/**
 * Batch Ob of the 2026-10-20 audit: screens whose words promised something the
 * code does not do. Each block reads the shipped copy and the code it
 * describes, so a sentence and its behaviour cannot drift apart again.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
/** App source files (not tests) under the given roots. */
function sourceFiles(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__fakes__") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p.replace(/\\/g, "/"));
    }
  };
  roots.forEach(walk);
  return out.sort();
}
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

describe("O45: prompt templates and snippets say they are a library", () => {
  const files = sourceFiles("server", "client/src", "shared");
  const readers = (re: RegExp) => files.filter((f) => re.test(read(f)));

  it("the behaviour it describes: nothing outside their own router and pages reads them", () => {
    expect(readers(/\b(emailPromptTemplates|emailSnippets)\b/)).toEqual(["server/routers/emailBuilder.ts"]);
    expect(readers(/trpc\.(snippets|promptTemplates)\./)).toEqual(["client/src/pages/usip/PromptTemplates.tsx", "client/src/pages/usip/Snippets.tsx"]);
  });

  it("the pages no longer claim the composer uses them", () => {
    const pt = read("client/src/pages/usip/PromptTemplates.tsx");
    const sn = read("client/src/pages/usip/Snippets.tsx");
    expect(pt).not.toContain("used across the email composer");
    expect(pt).toContain("No AI feature reads them yet");
    expect(sn).not.toContain("slash command in the email composer");
    expect(sn).toContain("no composer has a snippet menu or slash command yet");
    expect(read("client/src/lib/toolRegistry.ts")).not.toContain("Versioned prompts behind the AI generators.");
  });
});

describe("O54: the Unified Inbox is described as what it is, and a failed send is caught", () => {
  const page = read("client/src/pages/usip/UnifiedInbox.tsx");

  it("the behaviour it describes: it lists Unipile chats, not email", () => {
    expect(page).toContain("trpc.unipile.getInbox.useQuery(");
    expect(page).not.toContain("trpc.mailbox.");
  });

  it("the copy says social conversations, with no forwarding or email inbox", () => {
    expect(page).not.toContain("every connected email account");
    expect(page).not.toContain("Reply, forward");
    expect(page).toContain("LinkedIn, WhatsApp and other social conversations");
    const help = read("server/seedHelpContent.ts");
    expect(help).not.toContain("consolidates inbound replies across every connected email account");
    expect(help).not.toContain("Respond, forward, or log to a CRM record");
    expect(read("client/src/lib/helpText.ts")).not.toContain("Every reply across all your sending accounts");
  });

  it("a failed send is caught (onError says why), not left unhandled", () => {
    const send = between(page, "const handleSend = async () => {", "const handleKeyDown");
    const sent = send.indexOf("await sendMsg.mutateAsync(");
    expect(sent).toBeGreaterThan(-1);
    expect(send.slice(sent)).toMatch(/\} catch \{[\s\S]*\} finally \{/);
    expect(page).toContain('onError: (err) => toast.error("Failed to send", { description: err.message }),');
  });
});
