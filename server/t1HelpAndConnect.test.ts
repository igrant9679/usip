/**
 * T1 batch (2026-11-06), the tracker's screen items:
 *   4  — "All words with ** are not presented in bold": Help Center → Ask AI
 *        printed the assistant's answers raw, so every **bold** showed its
 *        asterisks (the drawer and the AI Assistant already rendered them).
 *   15 — "Clicking the Suggested Questions for Elsie is not working": on the
 *        Help Center page they only copied the question into the box.
 *   6  — My Calendar with nothing connected: named a Google option that does
 *        not exist and hid Velocity's own meetings behind the empty state.
 *   7  — LinkedIn search with no LinkedIn account: said nothing until after
 *        a search, and then named no place.
 * Pinned by rendering the new pieces and reading the pages, as the repo does
 * for screens that need a live tRPC client.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatMarkdown } from "../client/src/components/usip/ChatMarkdown";
import { NoCalendarConnected } from "../client/src/components/usip/NoCalendarConnected";
import { NoLinkedInConnected } from "../client/src/components/usip/NoLinkedInConnected";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const inRouter = (el: any) => renderToStaticMarkup(createElement(Router, { ssrPath: "/" }, el));

/** The full-page Ask AI tab, from its declaration to the next section. */
function askAiTab(): string {
  const src = read("client/src/pages/usip/HelpCenter.tsx");
  const start = src.indexOf("function AskAITab()");
  const end = src.indexOf("/* ─── Guided Tours Tab");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("Help Center → Ask AI renders answers and asks suggested questions (tracker 4, 15)", () => {
  it("answers go through ChatMarkdown; only the person's own messages stay plain", () => {
    const tab = askAiTab();
    expect(tab).toContain("<ChatMarkdown text={msg.body} />");
    const bubble = tab.slice(tab.indexOf("{messages.map("), tab.indexOf("{isLoading && ("));
    expect(bubble).toContain('msg.role === "user"');
    expect(bubble.match(/whitespace-pre-wrap/g)?.length).toBe(1);
  });

  it("ChatMarkdown turns **bold** into <strong>", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: "**Step 1:** open **Sequences**" }));
    expect(html).toContain("<strong");
    expect(html).not.toContain("**");
  });

  it("a suggested question is sent when pressed, not just copied into the box", () => {
    const tab = askAiTab();
    const chips = tab.slice(tab.indexOf('"How do I create a sequence?"'), tab.indexOf("{messages.map("));
    expect(chips).toContain("onClick={() => void handleSend(q)}");
    expect(chips).not.toContain("setInput(q)");
    expect(tab).toContain("async function handleSend(override?: string)");
    expect(tab).toContain("const userMsg = (override ?? input).trim();");
  });

  it("the Send button does not hand its click event to handleSend as the question", () => {
    const tab = askAiTab();
    expect(tab).not.toContain("onClick={handleSend}");
    expect(tab).toContain("onClick={() => void handleSend()}");
  });
});

describe("My Calendar with nothing connected says where to connect and still shows meetings (tracker 6)", () => {
  it("names the real options and links to Connected Accounts", () => {
    const html = inRouter(createElement(NoCalendarConnected, { viewingRep: false, onConnect: () => {} }));
    expect(html).toContain("Microsoft 365 / Outlook on Connected Accounts");
    expect(html).toContain('href="/connected-accounts"');
    expect(html).toContain("CalDAV");
    expect(html).toContain("Google Calendar can&#x27;t be connected yet");
    expect(html).toContain("Your Velocity meetings are shown below");
  });

  it("a manager viewing a rep gets no connect buttons", () => {
    const html = inRouter(createElement(NoCalendarConnected, { viewingRep: true, onConnect: () => {} }));
    expect(html).not.toContain("/connected-accounts");
    expect(html).not.toContain("Connect calendar");
  });

  it("the page puts the note above the calendar instead of replacing it", () => {
    const src = read("client/src/pages/usip/Calendar.tsx");
    const pane = src.slice(src.indexOf("{/* Calendar */}"), src.indexOf("{/* Connect calendar dialog */}"));
    expect(pane).toContain("<NoCalendarConnected viewingRep={!!repUserId}");
    expect(pane).toContain("<FullCalendar");
    expect(pane).not.toContain("<EmptyState");
    expect(src).not.toContain("Connect a Google, Outlook, or Apple calendar");
    expect(src).not.toContain("Connect your Google or Outlook calendar");
  });

  it("clicking a day only offers a new event when there is a calendar to write it to", () => {
    expect(read("client/src/pages/usip/Calendar.tsx")).toContain("dateClick={!repUserId && selectedAccountId ? handleDateClick : undefined}");
  });
});

describe("LinkedIn search with no LinkedIn account says where to connect one (tracker 7)", () => {
  it("names Connected Accounts and links there", () => {
    const html = inRouter(createElement(NoLinkedInConnected));
    expect(html).toContain("Connect your LinkedIn account to search");
    expect(html).toContain('href="/connected-accounts"');
  });

  it("the card shows it before a search and keeps Search off until one is connected", () => {
    const src = read("client/src/pages/usip/FindProspects.tsx");
    const card = src.slice(src.indexOf("function LinkedInSearchCard()"), src.indexOf("/* ─── Main panel"));
    expect(card).toContain("trpc.unipile.listConnectedAccounts.useQuery(");
    expect(card).toContain('a.provider === "LINKEDIN"');
    expect(card).toContain("{noLinkedIn && <NoLinkedInConnected />}");
    expect(card).toContain("disabled={search.isPending || noLinkedIn}");
    expect(card).not.toContain("Settings → Channels");
    // The discovery panel below needs no LinkedIn account, and has no
    // `noLinkedIn` in scope: an edit that spread the gate there broke it.
    const panel = src.slice(src.indexOf("/* ─── Main panel"));
    expect(panel).not.toContain("noLinkedIn");
  });

  it("the server's refusal names the place too", () => {
    const src = read("server/routers/unipile.ts");
    const block = src.slice(src.indexOf("searchLinkedIn: workspaceProcedure"), src.indexOf("resolveSearchParam: workspaceProcedure"));
    expect(block).toContain("Connect your LinkedIn account on Connected Accounts to search");
  });
});
