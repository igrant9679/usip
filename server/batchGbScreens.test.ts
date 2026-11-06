/**
 * Smaller screen fixes from audit batch Gb (2026-11-06), pinned by reading the
 * source the way the repo's other screen guards do.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

describe("Settings > Billing ships no placeholder (L11)", () => {
  it("the Invoices card that only said Placeholder is gone", () => {
    const s = read("client/src/pages/usip/Settings.tsx");
    expect(s).not.toContain("Placeholder — invoice history appears here");
    expect(s).not.toMatch(/<Section title="Invoices"/);
  });
});
