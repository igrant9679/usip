/**
 * The sender tokens in a signature.
 *
 * Owner report 2026-08-14: "the signature syntax isn't working." Traced on
 * live data — CommunityForce campaign 21's promptSignature is
 * "Best,\n{{senderName}}\nCommunityForce", and the sent email read
 * "Best," / blank line / "CommunityForce". The token resolved to an EMPTY
 * STRING, because every one of that workspace's four mailboxes has
 * fromName: null — they were linked by address through the SendGrid sender
 * picker, which has no display name to store.
 *
 * A merge token that silently becomes "" is worse than one left verbatim: the
 * sign-off still renders, just anonymous, so nothing looks broken until you
 * read the mail you sent.
 */
import { describe, it, expect } from "vitest";
import { personNameFromEmailLocal, resolveMergeVars } from "./mergeVars";

describe("personNameFromEmailLocal", () => {
  it("reads a name out of a work address", () => {
    expect(personNameFromEmailLocal("asrar.mehraj@cforcefederal.com")).toBe("Asrar Mehraj");
    expect(personNameFromEmailLocal("younus.shah@communityforce.com")).toBe("Younus Shah");
    expect(personNameFromEmailLocal("syed_razi@communityforce.network")).toBe("Syed Razi");
    expect(personNameFromEmailLocal("waqas-bhat@communityforce.solutions")).toBe("Waqas Bhat");
  });

  it("refuses shared mailboxes — nobody is called Info", () => {
    for (const box of ["info@acme.com", "sales@acme.com", "no-reply@acme.com", "support@acme.com"]) {
      expect(personNameFromEmailLocal(box), box).toBe("");
    }
  });

  it("drops disambiguating digits and single letters", () => {
    expect(personNameFromEmailLocal("jsmith2@acme.com")).toBe("Jsmith");
    expect(personNameFromEmailLocal("j.smith@acme.com")).toBe("Smith");
  });

  it("is empty for nothing at all", () => {
    expect(personNameFromEmailLocal("")).toBe("");
    expect(personNameFromEmailLocal(null)).toBe("");
    expect(personNameFromEmailLocal(undefined)).toBe("");
  });
});

describe("the sender tokens", () => {
  // Through the public renderer, not an internal map — this is the path a
  // real send takes.
  const render = (tpl: string, sender: { name?: string | null; email?: string | null }) =>
    resolveMergeVars(tpl, { sender } as never);

  it("uses the mailbox's display name when it has one", () => {
    expect(render("{{senderName}}|{{senderFirstName}}|{{senderLastName}}", { name: "Dana Reed", email: "dana@acme.com" }))
      .toBe("Dana Reed|Dana|Reed");
  });

  it("falls back to the address when fromName is null — the reported bug", () => {
    expect(render("{{senderName}}|{{senderFirstName}}|{{senderLastName}}", { name: null, email: "asrar.mehraj@cforcefederal.com" }))
      .toBe("Asrar Mehraj|Asrar|Mehraj");
  });

  it("the live signature now renders a name instead of a hole", () => {
    const signature = "Best,\n{{senderName}}\nCommunityForce";
    const before = resolveMergeVars(signature, { sender: { name: null, email: "asrar.mehraj@cforcefederal.com" } } as never);
    expect(before).toBe("Best,\nAsrar Mehraj\nCommunityForce");
    expect(before).not.toContain("\n\nCommunityForce");
  });

  it("{{senderFirstName}} works in a signature", () => {
    const out = resolveMergeVars("Best,\n{{senderFirstName}}", { sender: { name: null, email: "younus.shah@communityforce.com" } } as never);
    expect(out).toBe("Best,\nYounus");
  });

  it("a shared mailbox still yields nothing rather than a wrong name", () => {
    expect(render("[{{senderName}}][{{senderFirstName}}]", { name: null, email: "info@acme.com" })).toBe("[][]");
  });
});
