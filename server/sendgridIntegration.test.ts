/**
 * One workspace SendGrid API key, in Settings → Integrations (owner ask
 * 2026-08-14).
 *
 * The thing that needs pinning is not that the row exists — it is that the key
 * never leaves the server. `integrations.list` is a workspaceProcedure, so any
 * MEMBER reaches it, and `workspace_integrations.config` is plain JSON. A key
 * written there the ordinary way would be readable by the whole workspace.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { redactIntegrationConfig, SENDGRID_KEY_FIELD, SENDGRID_PROVIDER } from "./services/sendgridKey";

describe("redactIntegrationConfig", () => {
  it("replaces a stored secret with a boolean", () => {
    const out = redactIntegrationConfig({ apiKeyEnc: "ciphertext", region: "us" });
    expect(out).toEqual({ hasApiKey: true, region: "us" });
    expect(JSON.stringify(out)).not.toContain("ciphertext");
  });

  it("reports false for an empty secret rather than dropping the field", () => {
    // The UI decides between "saved — leave blank to keep it" and a plain
    // placeholder off this flag, so absent and empty must not look alike.
    expect(redactIntegrationConfig({ apiKeyEnc: "" })).toEqual({ hasApiKey: false });
  });

  it("catches the other credential shapes already in this table", () => {
    const out = redactIntegrationConfig({
      secretKey: "sk_live_x", publishableKey: "pk_live_x",
      bearerToken: "t", secret: "s", password: "p", url: "https://example.com",
    });
    expect(out.publishableKey).toBe("pk_live_x"); // not a secret
    expect(out.url).toBe("https://example.com");
    const serialized = JSON.stringify(out);
    for (const leaked of ["sk_live_x", '"t"', '"s"', '"p"']) expect(serialized).not.toContain(leaked);
  });

  it("survives a null/blank config", () => {
    expect(redactIntegrationConfig(null)).toEqual({});
    expect(redactIntegrationConfig(undefined)).toEqual({});
  });
});

describe("the integrations router treats the key as a credential", () => {
  const src = readFileSync("server/routers/integrations.ts", "utf8");

  it("lists it redacted — every row, not just SendGrid's", () => {
    expect(src).toContain("rows.map((r) => ({ ...r, config: redactIntegrationConfig(r.config) }))");
  });

  it("never writes the plaintext key into the generic config column", () => {
    const save = src.slice(src.indexOf("save: adminWsProcedure"), src.indexOf("test: adminWsProcedure"));
    expect(save).toContain("setWorkspaceSendgridKey(ctx.workspace.id");
    // The SendGrid branch must return before reaching the generic config write.
    const branch = save.slice(save.indexOf("if (input.provider === SENDGRID_PROVIDER)"));
    expect(branch.slice(0, branch.indexOf("const [existing]"))).toContain("return { ok: true };");
  });

  it("leaves a stored key alone when the form is saved without retyping it", () => {
    // The field is never populated, so a save that omits apiKey must be a
    // no-op for the key — otherwise opening the dialog and clicking Save
    // silently wipes it.
    const save = src.slice(src.indexOf("save: adminWsProcedure"), src.indexOf("test: adminWsProcedure"));
    expect(save).toContain('if ("apiKey" in raw)');
  });

  it("tests the key by authenticating, not by checking one is present", () => {
    const test = src.slice(src.indexOf("test: adminWsProcedure"));
    const branch = test.slice(test.indexOf("input.provider === SENDGRID_PROVIDER"));
    expect(branch).toContain("verifySendGridKey(key)");
  });
});

describe("one key, one place to rotate it", () => {
  it("the send path falls back to the workspace key", () => {
    const adapter = readFileSync("server/emailAdapter.ts", "utf8");
    const sg = adapter.slice(adapter.indexOf("export class SendGridAdapter"));
    expect(sg).toContain("getWorkspaceSendgridKey(this.account.workspaceId)");
  });

  it("linked mailboxes do NOT copy the key when the workspace owns it", () => {
    // A copy would take precedence over the workspace key in the send path,
    // so rotating in Settings would leave every linked mailbox on the old key.
    const router = readFileSync("server/routers/sendingAccounts.ts", "utf8");
    const proc = router.slice(router.indexOf("importSendgridSenders:"), router.indexOf("create: adminWsProcedure"));
    expect(proc).toContain("workspaceKeyOwnsIt");
    expect(proc).toContain("...(workspaceKeyOwnsIt ? {} : { sendgridApiKeyEnc: encryptSecret(key) })");
  });

  it("the sender picker can use the workspace key with no mailbox saved yet", () => {
    const router = readFileSync("server/routers/sendingAccounts.ts", "utf8");
    const resolver = router.slice(router.indexOf("async function resolveSendgridKey"));
    expect(resolver.slice(0, resolver.indexOf("export const sendingAccountsRouter"))).toContain("getWorkspaceSendgridKey(workspaceId)");
  });

  it("is offered in the Integrations tab", () => {
    const settings = readFileSync("client/src/pages/usip/Settings.tsx", "utf8");
    expect(settings).toContain("sendgrid: {");
    expect(settings).toContain('{ key: "apiKey", label: "API Key", type: "password" }');
    expect(SENDGRID_PROVIDER).toBe("sendgrid");
    expect(SENDGRID_KEY_FIELD).toBe("apiKeyEnc");
  });
});
