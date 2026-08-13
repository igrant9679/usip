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

  it("one endpoint 403ing is not a failure while the other answers", async () => {
    // A restricted key is commonly scoped to only one of the two.
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("verified_senders") ? errJson(403, { errors: [{ message: "access forbidden" }] }) : okJson(LEGACY)));
    const r = await listSendGridSenders("SG.key");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.senders).toHaveLength(1);
  });

  it("a bad key is an ERROR, never an empty sender list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errJson(401, { errors: [{ message: "authorization required" }] })));
    const r = await listSendGridSenders("SG.bad");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeTruthy();
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
});

describe("the import procedure", () => {
  const router = readFileSync("server/routers/sendingAccounts.ts", "utf8");
  const proc = router.slice(router.indexOf("importSendgridSenders:"), router.indexOf("create: adminWsProcedure"));

  it("re-reads senders from SendGrid rather than trusting the client's payload", () => {
    expect(proc).toContain("listSendGridSenders(key)");
    expect(proc).toContain("None of those senders exist on this SendGrid account");
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
