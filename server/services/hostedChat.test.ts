import { describe, it, expect } from "vitest";
import { pickHostedAgent, type HostedAgentRow } from "./hostedChat";

const agent = (o: Partial<HostedAgentRow> = {}): HostedAgentRow => ({
  id: 1,
  slug: "site-chat",
  status: "published",
  mode: "auto",
  showOnHostedPages: true,
  ...o,
});

describe("pickHostedAgent", () => {
  it("returns the installed agent", () => {
    expect(pickHostedAgent([agent()])?.slug).toBe("site-chat");
  });

  it("returns null when nothing is installed", () => {
    expect(pickHostedAgent([agent({ showOnHostedPages: false })])).toBeNull();
    expect(pickHostedAgent([])).toBeNull();
  });

  // The failure this guards against is a bubble that opens onto "Chat
  // unavailable" — worse than no bubble, because it reads as broken.
  it("refuses an agent the public endpoint would refuse", () => {
    expect(pickHostedAgent([agent({ status: "draft" })])).toBeNull();
    expect(pickHostedAgent([agent({ mode: "off" })])).toBeNull();
    expect(pickHostedAgent([agent({ slug: "" })])).toBeNull();
  });

  it("serves an approval-mode agent — it still captures the lead", () => {
    expect(pickHostedAgent([agent({ mode: "approval" })])?.slug).toBe("site-chat");
  });

  it("is stable when a workspace installs more than one: oldest wins", () => {
    const rows = [agent({ id: 7, slug: "newer" }), agent({ id: 2, slug: "older" })];
    expect(pickHostedAgent(rows)?.slug).toBe("older");
    expect(pickHostedAgent([...rows].reverse())?.slug).toBe("older");
  });

  it("skips ineligible rows to reach an eligible one", () => {
    const rows = [
      agent({ id: 1, slug: "unpublished", status: "draft" }),
      agent({ id: 5, slug: "live" }),
    ];
    expect(pickHostedAgent(rows)?.slug).toBe("live");
  });
});
