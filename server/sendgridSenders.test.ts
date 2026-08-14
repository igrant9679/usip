/**
 * SendGrid sender discovery (owner ask 2026-08-13: pull the available senders
 * in and let them be picked when linking a mailbox / added to Sender Pools).
 *
 * The two things worth pinning: the normalizer handles BOTH shapes SendGrid
 * returns, and a failed listing never disguises itself as "no senders" —
 * today's brand-search bug was exactly that mistake, and here it would tell
 * the owner their SendGrid account is empty when the key merely lacks a scope.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { listSendGridSenders } from "./services/sendgrid";

const VERIFIED = {
  results: [
    { id: 1, nickname: "Support", from_email: "Support@Acme.com", from_name: "Acme Support", reply_to: "help@acme.com", verified: true },
    { id: 2, nickname: "Sales", from_email: "sales@acme.com", from_name: "Acme Sales", reply_to: null, verified: false },
  ],
};
const LEGACY = [
  { id: 9, nickname: "Marketing", from: { email: "news@acme.com", name: "Acme News" }, reply_to: { email: "replies@acme.com" }, verified: { status: true } },
];

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errJson = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe("listSendGridSenders", () => {
  it("reads the modern verified_senders shape and lowercases the address", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("verified_senders") ? okJson(VERIFIED) : okJson([])));
    const r = await listSendGridSenders("SG.key");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.senders.map((s) => s.email)).toEqual(["sales@acme.com", "support@acme.com"]);
    const support = r.senders.find((s) => s.email === "support@acme.com")!;
    expect(support).toMatchObject({ name: "Acme Support", replyTo: "help@acme.com", nickname: "Support", verified: true });
    expect(r.senders.find((s) => s.email === "sales@acme.com")!.verified).toBe(false);
  });

  it("reads the legacy nested /v3/senders shape too, and merges both", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("verified_senders") ? okJson(VERIFIED) : okJson(LEGACY)));
    const r = await listSendGridSenders("SG.key");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.senders.map((s) => s.email)).toContain("news@acme.com");
    const news = r.senders.find((s) => s.email === "news@acme.com")!;
    expect(news).toMatchObject({ name: "Acme News", replyTo: "replies@acme.com", verified: true });
  });

  it("one endpoint 403ing is not a failure while another answers", async () => {
    // Which endpoint serves an account depends on its plan, not on the key.
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("verified_senders") ? errJson(403, { errors: [{ message: "access forbidden" }] }) : okJson(LEGACY)));
    const r = await listSendGridSenders("SG.key");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.senders).toHaveLength(1);
  });

  it("tries the Marketing senders endpoint too", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(url);
      return url.includes("marketing/senders") ? okJson({ results: LEGACY }) : errJson(403, {});
    }));
    const r = await listSendGridSenders("SG.key");
    expect(seen.some((u) => u.includes("/v3/marketing/senders"))).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("a bad key is an ERROR, never an empty sender list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errJson(401, { errors: [{ message: "authorization required" }] })));
    const r = await listSendGridSenders("SG.bad");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeTruthy();
  });

  it("when nothing answers it names the endpoints AND what the key can do", async () => {
    // The bare SendGrid text ("access forbidden, check your scopes") sends
    // people hunting for a permission they may already hold.
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/v3/scopes")
        ? okJson({ scopes: ["mail.send", "alerts.read"] })
        : errJson(403, { errors: [{ message: "access forbidden" }] })));
    const r = await listSendGridSenders("SG.key");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("verified_senders");
    expect(r.error).toContain("marketing/senders");
    expect(r.error).toContain("none of them mention senders");
  });

  it("says so when the key cannot even read its own scopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errJson(401, {})));
    const r = await listSendGridSenders("SG.revoked");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid or revoked");
  });

  it("an account with genuinely no senders is ok:true with none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ results: [] })));
    const r = await listSendGridSenders("SG.key");
    expect(r).toEqual({ ok: true, senders: [] });
  });

  it("refuses to call out without a key", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await listSendGridSenders("  ")).toEqual({ ok: false, error: "API key is required" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the picker is wired to the surfaces the owner named", () => {
  const picker = readFileSync("client/src/components/usip/settings/SendgridSenderPicker.tsx", "utf8");

  it("the Link mailbox wizard offers SendGrid and opens the picker", () => {
    const wizard = readFileSync("client/src/components/usip/settings/GuidedMailboxSetup.tsx", "utf8");
    expect(wizard).toContain("<SendgridSenderPicker");
    expect(wizard).toContain('provider === "sendgrid" ? "sendgrid"');
    expect(wizard).toContain('id: "sendgrid" as const');
  });

  it("the SendGrid settings card can import senders with a key that is not saved yet", () => {
    const card = readFileSync("client/src/components/usip/settings/SendGridCard.tsx", "utf8");
    expect(card).toContain("<SendgridSenderPicker");
    expect(card).toContain("apiKey={apiKey.trim() || undefined}");
  });

  it("links through importSendgridSenders and refreshes the mailbox list", () => {
    expect(picker).toContain("trpc.sendingAccounts.importSendgridSenders.useMutation");
    expect(picker).toContain("utils.sendingAccounts.list.invalidate()");
  });

  it("cannot re-link a sender that is already a mailbox", () => {
    expect(picker).toContain("disabled={s.alreadyLinked}");
  });

  it("opens ABOVE the guided wizard instead of behind it", () => {
    // Reported live: clicking "Link mailbox" with SendGrid chosen did nothing.
    // The dialog WAS opening — Radix portals it to <body> at z-50, and the
    // wizard shell is a z-[90] opaque full-screen surface, so it rendered
    // underneath. Every dialog reachable from that wizard needs raising, and
    // this is the assertion that a future refactor has to keep true.
    const wizard = readFileSync("client/src/components/usip/settings/GuidedMailboxSetup.tsx", "utf8");
    const shellZ = /className="fixed inset-0 z-\[(\d+)\]/.exec(wizard);
    expect(shellZ).toBeTruthy();
    const shell = Number(shellZ![1]);

    const dialogZ = (src: string) =>
      Array.from(src.matchAll(/<DialogContent[^>]*className="[^"]*\bz-\[(\d+)\]/g)).map((m) => Number(m[1]));
    const wizardDialogs = dialogZ(wizard);
    // Every <DialogContent> in the wizard file must clear the shell.
    const totalDialogs = (wizard.match(/<DialogContent/g) ?? []).length;
    expect(wizardDialogs).toHaveLength(totalDialogs);
    for (const z of wizardDialogs) expect(z).toBeGreaterThan(shell);

    const pickerZ = dialogZ(picker);
    expect(pickerZ.length).toBe(1);
    expect(pickerZ[0]).toBeGreaterThan(shell);
    expect(picker).toContain("overlayClassName=");
  });
});

describe("Domain Authentication accounts (no sender identities at all)", () => {
  it("lists the authenticated domains", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("whitelabel/domains")
        ? okJson([
            { domain: "acme.com", subdomain: "em123", valid: true },
            { domain: "old.com", subdomain: null, valid: false },
          ])
        : okJson({ results: [] })));
    const { listSendGridAuthenticatedDomains } = await import("./services/sendgrid");
    const r = await listSendGridAuthenticatedDomains("SG.key");
    expect(r).toEqual({ ok: true, domains: ["em123.acme.com"] });
  });

  it("an unvalidated domain does not count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([{ domain: "acme.com", valid: false }])));
    const { listSendGridAuthenticatedDomains } = await import("./services/sendgrid");
    const r = await listSendGridAuthenticatedDomains("SG.key");
    expect(r).toEqual({ ok: true, domains: [] });
  });

  it("the procedure only asks for domains when there are no senders", () => {
    const router = readFileSync("server/routers/sendingAccounts.ts", "utf8");
    const proc = router.slice(router.indexOf("sendgridSenders:"), router.indexOf("importSendgridSenders:"));
    expect(proc).toContain("if (result.senders.length === 0)");
    expect(proc).toContain("listSendGridAuthenticatedDomains(key)");
  });

  it("import accepts an address at an authenticated domain, checked against SendGrid", () => {
    const router = readFileSync("server/routers/sendingAccounts.ts", "utf8");
    const proc = router.slice(router.indexOf("importSendgridSenders:"), router.indexOf("create: adminWsProcedure"));
    // Verified against the DOMAIN list from SendGrid, never the client's word.
    expect(proc).toContain("listSendGridAuthenticatedDomains(key)");
    expect(proc).toContain("host === dom || host.endsWith(`.${dom}`)");
  });
});

describe("the import procedure", () => {
  const router = readFileSync("server/routers/sendingAccounts.ts", "utf8");
  const proc = router.slice(router.indexOf("importSendgridSenders:"), router.indexOf("create: adminWsProcedure"));

  it("re-reads senders from SendGrid rather than trusting the client's payload", () => {
    expect(proc).toContain("listSendGridSenders(key)");
    expect(proc).toContain("None of those addresses are a verified sender or at an authenticated domain");
  });

  it("skips addresses that are already mailboxes instead of duplicating them", () => {
    expect(proc).toContain("if (linked.has(s.email)) { skipped.push(s.email); continue; }");
  });

  it("creates them as sendgrid sending accounts — which is what makes pools work", () => {
    expect(proc).toContain('provider: "sendgrid"');
    expect(proc).toContain("sendgridApiKeyEnc: encryptSecret(key)");
  });

  it("never returns the key to a caller", () => {
    expect(proc).not.toContain("return { key");
    expect(proc).not.toMatch(/apiKey:\s*key/);
  });
});
