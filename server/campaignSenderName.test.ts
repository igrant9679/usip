/**
 * The sender's name on a campaign email — in the From header and in the
 * signature (owner report 2026-09-03, two screenshots: the Variant A preview
 * signed "Best," / {{senderName}} / "CommunityForce", the mail in the
 * recipient's inbox arrived From "asrar.mehraj@cforcefederal.com" with no
 * display name and signed "Best," / BLANK LINE / "CommunityForce").
 *
 * Two independent defects, both on the campaign path only:
 *
 *   1. areEngine.applyMerge knew five prospect tokens and STRIPPED every
 *      other tag, senderName included. The 2026-08-14 fallback lived in
 *      mergeVars.buildVarMap — the Sequences path — and never reached the
 *      campaign dispatcher.
 *   2. The four CommunityForce SendGrid senders were linked by address:
 *      fromName NULL, name = the address. The pool passed
 *      `chosen.fromName ?? undefined` → the From header carried no name.
 *
 * The fix is one rule (senderDisplayName) feeding both the header and the
 * signature, and the engine DEFERRING sender tokens to the send boundary,
 * where the pool has chosen the mailbox and can fill them before the scrub.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeferredSenderToken, resolveSenderTokens, senderDisplayName, SENDER_TOKENS } from "./mergeVars";
import { applyMerge } from "./areEngine";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

describe("senderDisplayName — one rule for the From header and the signature", () => {
  it("reads the name off an address-linked mailbox (the CommunityForce case)", () => {
    expect(senderDisplayName({ fromName: null, name: "asrar.mehraj@cforcefederal.com", fromEmail: "asrar.mehraj@cforcefederal.com" })).toBe("Asrar Mehraj");
    expect(senderDisplayName({ fromName: null, name: "younus.shah@communityforce.com", fromEmail: "younus.shah@communityforce.com" })).toBe("Younus Shah");
  });
  it("an explicit display name always wins", () => {
    expect(senderDisplayName({ fromName: "Asrar M.", name: "x@y.com", fromEmail: "x@y.com" })).toBe("Asrar M.");
    expect(senderDisplayName({ fromName: "  ", name: "asrar.mehraj@y.com", fromEmail: "asrar.mehraj@y.com" })).toBe("Asrar Mehraj");
  });
  it("the account's label counts when it is more than the address", () => {
    expect(senderDisplayName({ fromName: null, name: "Syed Razi", fromEmail: "syed.razi@communityforce.network" })).toBe("Syed Razi");
    expect(senderDisplayName({ fromName: null, name: "SYED.RAZI@communityforce.network", fromEmail: "syed.razi@communityforce.network" })).toBe("Syed Razi");
  });
  it("refuses to sign a shared inbox with a made-up name", () => {
    expect(senderDisplayName({ fromName: null, name: "info@communityforce.com", fromEmail: "info@communityforce.com" })).toBe("");
    expect(senderDisplayName({})).toBe("");
  });
});

describe("resolveSenderTokens — filled at the send boundary from the chosen mailbox", () => {
  const acc = { fromName: null, name: "asrar.mehraj@cforcefederal.com", fromEmail: "asrar.mehraj@cforcefederal.com" };
  it("fills the four sender tokens, separator-tolerant, with fallbacks honoured", () => {
    expect(resolveSenderTokens("Best,\n{{senderName}}\nCommunityForce", acc)).toBe("Best,\nAsrar Mehraj\nCommunityForce");
    expect(resolveSenderTokens("{{sender_first_name}} / {{SenderLastName}} / {{senderEmail}}", acc)).toBe("Asrar / Mehraj / asrar.mehraj@cforcefederal.com");
    expect(resolveSenderTokens("{{senderName|The team}}", { fromEmail: "info@x.com" })).toBe("The team");
    expect(resolveSenderTokens("{{senderName}}", { fromEmail: "info@x.com" })).toBe("");
  });
  it("touches nothing else — other tokens are the scrub's business", () => {
    expect(resolveSenderTokens("Hi {{firstName}}, {{notAThing}} — {{senderName}}", acc)).toBe("Hi {{firstName}}, {{notAThing}} — Asrar Mehraj");
  });
  it("the deferred set is exactly the four sender tokens", () => {
    expect([...SENDER_TOKENS]).toEqual(["senderName", "senderFirstName", "senderLastName", "senderEmail"]);
    expect(isDeferredSenderToken("sender_name")).toBe(true);
    expect(isDeferredSenderToken("SENDERNAME")).toBe(true);
    expect(isDeferredSenderToken("senderCompany")).toBe(false);
    expect(isDeferredSenderToken("firstName")).toBe(false);
  });
});

describe("applyMerge defers the sender tokens instead of deleting them", () => {
  const prospect = { firstName: "Thelma", lastName: "R", companyName: "USDA", title: "Grants Director" } as any;
  it("leaves {{senderName}} verbatim for the send boundary, and still strips an unknown tag", () => {
    expect(applyMerge("Hi {{firstName}},\n\nBest,\n{{senderName}}\nCommunityForce", prospect))
      .toBe("Hi Thelma,\n\nBest,\n{{senderName}}\nCommunityForce");
    expect(applyMerge("Hi {{notAThing}},", prospect)).toBe("Hi ,");
  });
  it("end to end: engine merge then boundary fill gives a signed email", () => {
    const merged = applyMerge("Best,\n{{senderName}}\nCommunityForce", prospect);
    expect(resolveSenderTokens(merged, { fromName: null, name: "asrar.mehraj@cforcefederal.com", fromEmail: "asrar.mehraj@cforcefederal.com" }))
      .toBe("Best,\nAsrar Mehraj\nCommunityForce");
  });
});

describe("the send boundary fills, then scrubs, then names the sender in the From header", () => {
  const delivery = read("emailDelivery.ts");
  const adapter = read("emailAdapter.ts");

  it("the pool fills sender tokens from the CHOSEN account, before the scrub, before the send", () => {
    const pool = delivery.slice(delivery.indexOf("export async function sendCampaignEmailViaPool"), delivery.indexOf("export async function sendWorkspaceEmail"));
    const chosenAt = pool.indexOf("const pick = await choosePoolAccount(workspaceId);");
    const fillAt = pool.indexOf('scrubTemplateOpts(fillSenderTokens(opts, chosen), "emailDelivery.pool")');
    const sendAt = pool.indexOf("await adapter.sendEmail({");
    expect(chosenAt).toBeGreaterThan(-1);
    expect(fillAt).toBeGreaterThan(chosenAt);
    expect(sendAt).toBeGreaterThan(fillAt);
    // And NOT scrubbed at the top any more — that deleted the tokens before the mailbox was known.
    expect(pool).not.toContain('scrubTemplateOpts(opts, "emailDelivery.pool")');
  });

  it("the no-accounts fallback fills from the SMTP config the same way", () => {
    expect(delivery).toContain('scrubTemplateOpts(fillSenderTokens(opts, { fromName: cfg.fromName, fromEmail }), "emailDelivery.workspace")');
    expect(delivery).toContain("const fromName = senderDisplayName({ fromName: cfg.fromName, fromEmail }) || cfg.username;");
  });

  it("the From header uses the same rule as the signature — pool and SendGrid adapter", () => {
    expect(delivery).toContain("fromName: opts.fromName ?? (senderDisplayName(chosen) || undefined),");
    expect(adapter).toContain("fromName: input.fromName ?? (senderDisplayName(this.account) || null),");
    expect(adapter).toContain("fromName: decorated.fromName ?? (senderDisplayName(account) || null),");
  });

  it("a LinkedIn step, which has no mailbox, fills from the campaign owner and then scrubs", () => {
    // Deferring in applyMerge would otherwise send "{{senderName}}" in a
    // LinkedIn message — the one channel the emailDelivery boundary never sees.
    const engine = read("areEngine.ts");
    expect(engine).toContain('resolveSenderTokens(applyMerge(lmc.body ?? "", lp), { fromName: linkedinOwner?.name ?? null })');
    expect(engine).toContain('"areEngine.linkedin"');
    expect(engine).toContain("body: linkedinBody,");
  });

  it("the pool's selection is ONE exported rule, and the send uses it", () => {
    expect(delivery).toContain("export async function choosePoolAccount(workspaceId: number): Promise<PoolPick>");
    const helper = delivery.slice(delivery.indexOf("export async function choosePoolAccount"), delivery.indexOf("export async function sendWorkspaceEmail"));
    for (const s of ["senderPools", "senderPoolMembers", "dailySendLimit ?? 500", "getAccountSentLastHour", 'return { kind: "account", account: chosen };']) expect(helper).toContain(s);
    // The send itself no longer carries a private copy of the selection.
    const pool = delivery.slice(delivery.indexOf("export async function sendCampaignEmailViaPool"), delivery.indexOf("export type PoolPick"));
    expect(pool).toContain("const chosen = pick.account;");
    expect(pool).not.toContain("eligible[0]");
  });

  it("the message preview fills the sender the same way — sent mailbox, else the pool's real pick", () => {
    // Owner ask 2026-09-03: the Variant A preview showed the literal {{senderName}}.
    const exec = read("routers", "are", "execution.ts");
    const proc = exec.slice(exec.indexOf("getMessage: workspaceProcedure"), exec.indexOf("findStepMessage: workspaceProcedure"));
    expect(proc).toContain("senderDisplayName({ fromName: row.accountFromName, name: row.accountName, fromEmail: row.accountEmail })");
    expect(proc).toContain("const pick = await choosePoolAccount(ctx.workspace.id);");
    expect(proc).toContain("subject: fill(mc?.subject),");
    expect(proc).toContain("body: fill(mc?.body),");
    expect(proc).toContain("resolveSenderTokens(s, senderShape)");
    // And the dialog says whose name that is for a pending step.
    const dialog = read("..", "client", "src", "components", "usip", "are", "AreMessageDialog.tsx");
    expect(dialog).toContain('{m.status === "sent" ? "Sent from" : "Will send from"}');
    expect(dialog).toContain("(pool’s current pick)");
  });

  it("fillSenderTokens covers subject, html and text", () => {
    const fn = delivery.slice(delivery.indexOf("function fillSenderTokens"), delivery.indexOf("function fillSenderTokens") + 600);
    for (const f of ["subject: resolveSenderTokens(opts.subject", "html: resolveSenderTokens(opts.html", "text: resolveSenderTokens(opts.text"]) expect(fn).toContain(f);
  });
});
