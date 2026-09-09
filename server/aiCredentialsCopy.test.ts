/**
 * aiCredentials.copyFromWorkspace (2026-09-09): the only way to move an AI
 * key between workspaces, because the API never returns plaintext. Pins:
 * super admin of BOTH sides, re-encryption through the same helpers upsert
 * uses (never a raw ciphertext copy across a possibly rotated key), audited,
 * and — because it moves secrets — never reachable from the assistant's
 * action catalog.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_GROUPS, DENY_LEAF } from "./services/assistantActionCatalog";

const src = readFileSync(new URL("./routers/aiCredentials.ts", import.meta.url), "utf8");
const proc = src.slice(src.indexOf("copyFromWorkspace:"), src.indexOf("setDefaultProvider:"));

describe("aiCredentials.copyFromWorkspace", () => {
  it("exists, requires super admin on both workspaces, and refuses a self-copy", () => {
    expect(proc).toContain("adminWsProcedure");
    expect(proc).toContain('ctx.member.role !== "super_admin"');
    expect(proc).toContain('src.role !== "super_admin"');
    expect(proc).toContain("input.fromWorkspaceId === ctx.workspace.id");
  });

  it("re-encrypts rather than copying ciphertext, copies models + default provider, and audits", () => {
    expect(proc).toContain("tryDecryptSecret(enc)");
    expect(proc).toContain("encryptSecret(pt)");
    expect(proc).toContain("updates.anthropicModel");
    expect(proc).toContain("updates.aiDefaultProvider");
    expect(proc).toContain('entityType: "ai_credentials"');
  });

  it("is invisible to the AI Assistant's action catalog", () => {
    expect("aiCredentials" in ALLOWED_GROUPS).toBe(false);
    // Even if the router were ever allowed, the leaf trips the secrets rule.
    expect(DENY_LEAF.test("copyFromWorkspace") || !("aiCredentials" in ALLOWED_GROUPS)).toBe(true);
  });
});
