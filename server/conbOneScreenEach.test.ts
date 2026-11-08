/**
 * One screen per job (audit 2026-10-20, X6.3; batch CONB, 2026-11-08).
 *
 * X6.3 listed the duplicates: Tasks v1 and v2, Sequences v1 and v2, two
 * editors, two homes, four inboxes, three people lists. Each is settled:
 * batch CONA retired the sequence list and canvas and the four inboxes; this
 * batch the task page, the home and the deal board; phase 5 folded the
 * Prospects list into People. People and Leads stay two lists by design, and
 * each page says which it is.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_ROUTES, type RetiredRoute } from "../client/src/lib/retiredRoutes";
import { TOOLS } from "../client/src/lib/toolRegistry";
import { NAV_HELP } from "../client/src/lib/helpText";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP = read("client/src/App.tsx");

describe("every duplicate X6.3 named now redirects to its one screen", () => {
  const settled: Array<[RetiredRoute, string, string]> = [
    ["/tasks", "/v2/tasks", "two task pages (this batch)"],
    ["/dashboard", "/v2/home?view=pipeline", "two homes (this batch)"],
    ["/v2/deals", "/pipeline", "two deal boards (this batch)"],
    ["/sequences", "/v2/sequences", "two sequence lists (CONA)"],
    ["/sequences/:id/canvas", "/v2/sequences/:id", "two sequence editors (CONA)"],
    ["/inbox", "/v2/inbox?tab=notifications", "four inboxes (CONA)"],
    ["/mailbox", "/v2/inbox?tab=mailbox", "four inboxes (CONA)"],
    ["/unified-inbox", "/v2/inbox?tab=social&view=chats", "four inboxes (CONA)"],
    ["/v2/conversations", "/v2/inbox", "four inboxes (CONA)"],
    ["/prospects", "/v2/people", "three people lists (phase 5)"],
  ];
  it.each(settled)("%s → %s (%s)", (from, to) => {
    expect(RETIRED_ROUTES[from]).toBe(to);
    expect(APP).toContain(`<Route path="${from}"><AuthGate><RetiredRedirect from="${from}" /></AuthGate></Route>`);
  });

  it("the only v1/v2 pair still routed both ways is the one recorded as two pages over one engine", () => {
    const dead = read("server/deadCode.test.ts");
    const pairs = dead.slice(dead.indexOf("const ROUTE_PAIRS"), dead.indexOf("];", dead.indexOf("const ROUTE_PAIRS")));
    expect(pairs).toContain('["/workflows", "/v2/workflows"');
    expect(pairs).not.toContain('"/tasks"');
    expect(pairs).not.toContain('"/dashboard"');
  });
});

describe("People and Leads stay two lists, and each says which it is", () => {
  it("the reasoning is recorded beside the retirements", () => {
    const rr = read("client/src/lib/retiredRoutes.ts");
    expect(rr).toContain("People and Leads are NOT a pair, and stay two lists by design");
  });
  it("People says it is the person database and points at Leads", () => {
    const people = read("client/src/pages/usip/People.tsx");
    const purpose = people.slice(people.indexOf('data-testid="people-purpose"'), people.indexOf("</p>", people.indexOf('data-testid="people-purpose"')));
    expect(purpose).toContain("Every person you have imported or sourced: the database outreach draws on.");
    expect(purpose).toContain('setLocation("/leads")');
    expect(TOOLS.find((t) => t.href === "/v2/people")?.description).toMatch(/Inbound enquiries are Leads/);
    expect(NAV_HELP["/v2/people"]?.body).toMatch(/Leads/);
  });
  it("Leads says it is inbound enquiries to qualify, not the person database", () => {
    const leads = read("client/src/pages/usip/Leads.tsx");
    expect(leads).toContain('<PageHeader title="Leads" description="Inbound enquiries (chat, booking pages, forms) waiting to be qualified;');
    expect(leads).toContain("Every person you have imported or sourced is in People, the person database.");
    expect(TOOLS.find((t) => t.href === "/leads")?.description).toMatch(/Not the person database: that is People/);
    expect(NAV_HELP["/leads"]?.body).toMatch(/Not the person database/);
  });
});
