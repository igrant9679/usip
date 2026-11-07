/**
 * Signed visitor links, added to outreach automatically (audit 2026-10-20,
 * P5, P88, F40). The beacon could identify a visitor from a signed `vid` in
 * the page's link, but nothing put one there, so no visit was ever known to
 * be anyone's. Outreach now adds a signed id to links to the workspace's own
 * site(s), only while click tracking is on, never to a third-party link; the
 * beacon checks the signature and records whether it held.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  process.env.PUBLIC_APP_URL = "https://app.velocity.test";
  return { db: null as any, sent: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "" }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: async (input: unknown) => { h.sent.push(input); return { messageId: "m1" }; } }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { deliverEmailDraft } from "./routers/sequences";
import { addVisitorIdsToEmail, decorateVisitorLinks, siteHost, trackedHostsFrom, visitorIdFor } from "./services/visitorLinks";
import { isSignedVid, parseVid, registerWebsiteTrackingRoutes, signVisitorId } from "./websiteTracking";

const WS = 2;
const OTHER = 4;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const vidOf = (url: string) => new URL(url).searchParams.get("vid");
const caller = () => {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
};

function fresh(role = "admin", settings: Record<string, unknown> = {}) {
  h.db = makeSqlFakeDb({ roles: { [WS]: role }, wsId: () => WS });
  h.sent = [];
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null }, { id: OTHER, name: "O", slug: "other", ownerUserId: 9, archivedAt: null });
  rows("users").push({ id: 1, name: "Rep", email: "rep@lsi.example", emailSignature: null });
  rows("workspace_settings").push({ workspaceId: WS, emailClickTracking: true, emailOpenTracking: true, companyWebsite: "https://www.acme-site.example/", trackedSiteDomains: null, ...settings });
  rows("sending_accounts").push({ id: 1, workspaceId: WS, name: "Box", fromEmail: "rep@lsi.example", fromName: "Rep", enabled: true, provider: "smtp", unipileAccountId: null });
  rows("prospects").push(
    { id: 301, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@client.example", company: "Client" },
    { id: 901, workspaceId: OTHER, firstName: "X", lastName: "Y", email: "x@y.example" },
  );
}
beforeEach(() => fresh());

/* ── which links ────────────────────────────────────────────────────────── */

describe("a signed id goes on links to the workspace's own site, and nowhere else (F40)", () => {
  const vid = "p301.abcdefghijklmnop";
  const hosts = ["acme-site.example"];

  it("adds it to the site and its subdomains, in HTML and in text, keeping everything else", () => {
    const out = decorateVisitorLinks({
      html: `<p><a href="https://acme-site.example/pricing?utm=x&amp;b=2">Pricing</a> <a href='https://blog.acme-site.example/post'>Blog</a> <a href="https://www.acme-site.example/?vid=l9&vlid=3">Home</a></p>`,
      text: "See https://acme-site.example/demo. And https://acme-site.example/pricing?x=1, too.",
    }, { hosts, vid, appHost: "app.velocity.test" });
    expect(out.changed).toBe(5);
    expect(out.html).toContain(`href="https://acme-site.example/pricing?utm=x&amp;b=2&amp;vid=${vid}"`);
    expect(out.html).toContain(`href='https://blog.acme-site.example/post?vid=${vid}'`);
    expect(out.html).toContain(`href="https://www.acme-site.example/?vid=${vid}"`); // old vid replaced, vlid dropped
    expect(out.text).toContain(`https://acme-site.example/demo?vid=${vid}. And`);
    expect(out.text).toContain(`https://acme-site.example/pricing?x=1&vid=${vid}, too.`);
  });

  it("leaves third-party links, look-alike hosts, mailto, our own app and tracking redirects alone", () => {
    const html = [
      `<a href="https://google.example/search">g</a>`,
      `<a href="https://acme-site.example.evil.example/">look-alike</a>`,
      `<a href="https://notacme-site.example/">suffix</a>`,
      `<a href="mailto:ann@acme-site.example">mail</a>`,
      `<a href="https://app.velocity.test/api/unsubscribe/tok">unsub</a>`,
      `<a href="https://acme-site.example/api/track/click/t?url=x">tracked</a>`,
    ].join(" ");
    const out = decorateVisitorLinks({ html, text: "https://google.example/x" }, { hosts, vid, appHost: "app.velocity.test" });
    expect(out).toEqual({ html, text: "https://google.example/x", changed: 0 });
  });

  it("the site comes from the company website and the listed sites", () => {
    expect(trackedHostsFrom("https://www.Acme-Site.example/about", "shop.acme.example, acme.co.uk; nonsense, acme-site.example")).toEqual(["acme-site.example", "shop.acme.example", "acme.co.uk"]);
    expect(siteHost("nonsense")).toBeNull();
    expect(trackedHostsFrom(null, "")).toEqual([]);
  });

  it("names the record the email went to, signed for this workspace", () => {
    for (const [who, kind] of [[{ prospectId: 301 }, "p"], [{ contactId: 7 }, "c"], [{ leadId: 8 }, "l"]] as const) {
      const id = visitorIdFor(WS, who)!;
      expect(id.startsWith(kind)).toBe(true);
      expect(isSignedVid(WS, id)).toBe(true);
      expect(isSignedVid(OTHER, id)).toBe(false);
    }
    expect(visitorIdFor(WS, {})).toBeNull();
    expect(parseVid(signVisitorId(WS, "p", 301))).toEqual({ contactId: null, leadId: null, prospectId: 301 });
  });
});

/* ── when ───────────────────────────────────────────────────────────────── */

describe("only while click tracking is on, and only with a site to add it to (F40)", () => {
  const parts = { html: `<a href="https://acme-site.example/pricing">p</a>`, text: "https://acme-site.example/pricing" };

  it("on, with the company website set: added", async () => {
    const out = await addVisitorIdsToEmail(WS, { prospectId: 301 }, parts);
    expect(out.changed).toBe(2);
    expect(isSignedVid(WS, vidOf(out.text)!)).toBe(true);
  });

  it("click tracking off, no site, or no record: the email goes as written", async () => {
    fresh("admin", { emailClickTracking: false });
    expect(await addVisitorIdsToEmail(WS, { prospectId: 301 }, parts)).toEqual({ ...parts, changed: 0 });
    fresh("admin", { companyWebsite: null });
    expect(await addVisitorIdsToEmail(WS, { prospectId: 301 }, parts)).toEqual({ ...parts, changed: 0 });
    fresh();
    expect(await addVisitorIdsToEmail(WS, {}, parts)).toEqual({ ...parts, changed: 0 });
  });

  it("a draft send carries it on the site's links only, and the stored draft keeps the text as written", async () => {
    rows("email_drafts").push({
      id: 70, workspaceId: WS, subject: "Hi", toProspectId: 301, toEmail: "ann@client.example", status: "approved",
      body: "Pricing: https://acme-site.example/pricing\nOther: https://google.example/x", createdByUserId: 1, sequenceId: null, enrollmentId: null, aiGenerated: false,
    });
    await deliverEmailDraft({ workspaceId: WS, userId: 1, draftId: 70, claimFrom: ["approved"] });
    const sent = h.sent[0];
    expect(sent.bodyText).toMatch(/https:\/\/acme-site\.example\/pricing\?vid=p301\.[A-Za-z0-9_-]{16}/);
    expect(sent.bodyText).toContain("https://google.example/x\n");
    expect(sent.bodyHtml).toMatch(/href="https:\/\/acme-site\.example\/pricing\?vid=p301\./);
    expect(sent.bodyHtml).not.toMatch(/google\.example\/x\?vid/);
    expect(rows("email_drafts")[0].body).not.toContain("vid=");
  });

  it("campaign and record sends add it too", () => {
    const are = read("server/areEngine.ts");
    expect(are).toContain("await addVisitorIdsToEmail(wsId, { prospectId: p.personProspectId }, { html, text: textOut });");
    const crm = read("server/routers/crm.ts");
    expect(crm).toContain("addVisitorIdsToEmail(ctx.workspace.id, { contactId: contact.id }, { html: fullBodyHtml, text: fullBodyText })");
    expect(crm).toContain("addVisitorIdsToEmail(ctx.workspace.id, { leadId: lead.id }, { html: fullBodyHtml, text: fullBodyText })");
    expect(crm.split("bodyHtml: withVisitorIds.html,").length - 1).toBe(2);
  });
});

/* ── the beacon ─────────────────────────────────────────────────────────── */

describe("the beacon believes only a signature it made, and says which visits it believed (P5, P88)", () => {
  const beacon = async (body: Record<string, unknown>) => {
    let handler: any;
    registerWebsiteTrackingRoutes({ get: () => {}, options: () => {}, post: (_p: string, h2: any) => { handler = h2; } } as any);
    const res: any = { setHeader: () => {}, status: () => res, json: () => res, end: () => res };
    await handler({ body, headers: {} }, res);
  };
  const tasks = () => rows("tasks").filter((t) => String(t.title).startsWith("High-intent website visit"));

  it("a signed People id identifies the visit and files the high-intent task", async () => {
    await beacon({ slug: "lsi", visitorId: "v1", path: "/pricing", vid: signVisitorId(WS, "p", 301) });
    expect(rows("website_visits")[0]).toMatchObject({ prospectId: 301, signed: true });
    expect(tasks().map((t) => [t.relatedType, t.relatedId])).toEqual([["prospect", 301]]);
  });

  it("an unsigned or foreign id is recorded as a claim, or not at all, and files nothing", async () => {
    await beacon({ slug: "lsi", visitorId: "v2", path: "/pricing", vid: "p301" });
    await beacon({ slug: "lsi", visitorId: "v3", path: "/pricing", vid: signVisitorId(WS, "p", 901) }); // another workspace's person
    await beacon({ slug: "lsi", visitorId: "v4", path: "/pricing", vid: signVisitorId(OTHER, "p", 301) }); // signed elsewhere
    expect(rows("website_visits").map((v) => [v.prospectId, v.signed])).toEqual([[301, false], [null, false], [301, false]]);
    expect(tasks()).toHaveLength(0);
  });

  it("the visitors page lists People visits and marks which were verified", async () => {
    rows("website_visits").push(
      { id: 1, workspaceId: WS, visitorId: "a", path: "/pricing", prospectId: 301, contactId: null, leadId: null, signed: true, intent: "high", createdAt: new Date() },
      { id: 2, workspaceId: WS, visitorId: "b", path: "/", prospectId: 301, contactId: null, leadId: null, signed: false, intent: "low", createdAt: new Date(Date.now() - 1000) },
    );
    const list = await caller().websiteVisitors.listKnown({ limit: 10 });
    expect(list.map((r: any) => [r.recordType, r.recordId, r.name, r.verified])).toEqual([["prospect", 301, "Ann Lee", true], ["prospect", 301, "Ann Lee", false]]);
    const page = read("client/src/pages/usip/WebsiteVisitors.tsx");
    expect(page).toContain('r.recordType === "prospect" ? `/prospects/${r.recordId}`');
    expect(page).toContain(">Verified</span>");
    expect(page).toContain(">Unverified claim</span>");
  });
});

/* ── where it is set ────────────────────────────────────────────────────── */

describe("the visitors page says where the id goes, and admins can list more sites (F40)", () => {
  it("reports the sites and the switch", async () => {
    expect(await caller().websiteVisitors.trackedSites()).toMatchObject({ hosts: ["acme-site.example"], clickTracking: true });
  });

  it("saves more sites as hosts, refuses a non-address, and is admin-only", async () => {
    const r = await caller().websiteVisitors.setTrackedSites({ domains: "https://Shop.Acme.example/x, acme.co.uk" });
    expect(r.hosts).toEqual(["shop.acme.example", "acme.co.uk"]);
    expect(rows("workspace_settings")[0].trackedSiteDomains).toBe("shop.acme.example, acme.co.uk");
    expect((await caller().websiteVisitors.trackedSites()).hosts).toEqual(["acme-site.example", "shop.acme.example", "acme.co.uk"]);
    await expect(caller().websiteVisitors.setTrackedSites({ domains: "not a site" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    fresh("rep");
    await expect(caller().websiteVisitors.setTrackedSites({ domains: "acme.co.uk" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the page, tour, help article and manual no longer say Velocity adds no id", () => {
    const page = read("client/src/pages/usip/WebsiteVisitors.tsx");
    expect(page).not.toContain("nothing in Velocity adds one to your emails");
    expect(page).toContain("carry a signed id");
    expect(page).toContain("trpc.websiteVisitors.setTrackedSites.useMutation");
    const help = read("server/seedHelpContent.ts");
    expect(help).not.toContain("Velocity does not add those to outgoing links yet");
    expect(help).not.toContain("which nothing adds for you");
    expect(read("server/seedHelpOperatorManual.ts")).not.toContain("match visits to prospects.");
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `website_visits` ADD COLUMN `signed` boolean NOT NULL DEFAULT false");
  });
});
