/**
 * Cross-page CRM fixes (audit 2026-10-20, batch Rc): R31 · R79 · R98 · R105.
 *
 *   R31 · every deal and customer writer refreshes every read it changed,
 *         through one helper per family — derived from the source, so a writer
 *         added later is covered without editing this file
 *   R79 · page copy says what the features do
 *   R98 · one money formatter; no "$1500k"
 *   R105 · @mentions are picked from the team, and show as "@Name"
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { formatAmount } from "@shared/money";
import { insertMention, mentionCandidates, mentionQueryAt, mentionsAsText } from "../client/src/lib/mentions";

const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client", "src");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`end anchor not found after ${start}: ${end}`);
  return src.slice(i, j + end.length);
}
/** The argument list of the call whose "(" is at `open`, brackets balanced. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced call");
}

const DEAL_WRITER = /trpc\.(opportunities\.\w+|pipelineAlerts\.moveDealStage|oppIntelligence\.reviewStageChange|proposals\.(acceptProposal|createOpportunity|update))\.useMutation\(/g;
const CUSTOMER_WRITER = /trpc\.(cs|csAi)\.\w+\.useMutation\(/g;

function writers(re: RegExp) {
  const found: Array<{ file: string; proc: string; options: string }> = [];
  for (const abs of walk(CLIENT)) {
    const src = stripComments(readFileSync(abs, "utf8").replace(/\r\n/g, "\n"));
    for (const m of src.matchAll(re)) {
      const open = m.index! + m[0].length - 1;
      found.push({ file: relative(ROOT, abs).split(sep).join("/"), proc: m[1], options: callArgs(src, open) });
    }
  }
  return found;
}

/* ── R31 ────────────────────────────────────────────────────────────────── */

describe("R31: a deal or customer change refreshes every page that shows it", () => {
  const cache = read("client/src/lib/crmCache.ts");

  it("the deal helper names every family a deal feeds", () => {
    const fn = stripComments(block(cache, "export function invalidateDealReads(", "\n}\n"));
    for (const call of ["utils.opportunities.invalidate()", "utils.quota.progress.invalidate()", "invalidateCustomerReads(utils)", "utils.proposals.list.invalidate()", "utils.proposals.get.invalidate()", "utils.dashboards.invalidate()"]) {
      expect(fn).toContain(call);
    }
    expect(stripComments(block(cache, "export function invalidateCustomerReads(", "\n}\n"))).toContain("utils.cs.invalidate()");
  });

  it("every deal writer calls it on success", () => {
    const all = writers(DEAL_WRITER);
    // The derivation must find the known writers, or it proves nothing.
    expect(all.length).toBeGreaterThanOrEqual(10);
    const missing = all
      // The drawer passes its options at the mutate call; checked below.
      .filter((w) => !(w.file.endsWith("RecordDrawer.tsx") && w.proc === "opportunities.delete"))
      .filter((w) => !w.options.includes("invalidateDealReads(utils)"))
      .map((w) => `${w.file}: ${w.proc}`);
    expect(missing).toEqual([]);
    const drawer = stripComments(read("client/src/components/usip/RecordDrawer.tsx"));
    expect(block(drawer, "const deleteRecord = () => {", "\n  };")).toContain(`if (relatedType === "opportunity") invalidateDealReads(utils);`);
  });

  it("every customer writer calls its helper on success", () => {
    const all = writers(CUSTOMER_WRITER);
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(all.filter((w) => !w.options.includes("invalidateCustomerReads(utils)")).map((w) => `${w.file}: ${w.proc}`)).toEqual([]);
  });

  it("no customer writer refreshes a subset by hand instead", () => {
    // (Deal writers may: the Pipeline's optimistic board re-reads itself in
    // onSettled, failure included, beside the helper on success.)
    const offenders = writers(CUSTOMER_WRITER)
      .filter((w) => /utils\.cs\.\w+\.invalidate/.test(w.options))
      .map((w) => `${w.file}: ${w.proc}`);
    expect(offenders).toEqual([]);
  });

  it("a drawer delete refreshes the record's whole family; quota refreshes all quota reads", () => {
    const drawer = stripComments(block(read("client/src/components/usip/RecordDrawer.tsx"), "const deleteRecord = () => {", "\n  };"));
    expect(drawer).toContain(`if (relatedType === "contact") utils.contacts.invalidate();`);
    expect(drawer).toContain("utils.companies.invalidate();");
    const quota = stripComments(read("client/src/pages/usip/Quota.tsx"));
    expect(block(quota, "const setQuota = trpc.quota.set.useMutation({", "\n  });")).toContain("utils.quota.invalidate();");
    expect(block(quota, "const removeQuota = trpc.quota.remove.useMutation({", "\n  });")).toContain("utils.quota.invalidate();");
  });

  it("the global stale time is untouched", () => {
    expect(read("client/src/main.tsx")).toMatch(/staleTime:\s*30_?000/);
  });
});

/* ── R79 ────────────────────────────────────────────────────────────────── */

describe("R79: copy that promised what isn't there", () => {
  it("no automatic enrichment, reminders, e-signature, pricing tiers or lead routing by territory", () => {
    expect(read("client/src/pages/usip/Leads.tsx")).not.toMatch(/automatically enriched/i);
    expect(read("client/src/pages/usip/Renewals.tsx")).not.toMatch(/renewal reminders/i);
    for (const f of ["client/src/pages/usip/Proposals.tsx", "client/src/pages/usip/Quotes.tsx", "client/src/lib/toolRegistry.ts"]) {
      expect(read(f), f).not.toMatch(/e-?sign/i);
    }
    expect(read("client/src/pages/usip/Products.tsx")).not.toMatch(/pricing tiers/i);
    expect(read("client/src/pages/usip/Territories.tsx")).not.toMatch(/automatically route new leads/i);
    // "Restore later" is true since R64: Companies has an Archived filter.
    expect(read("client/src/pages/usip/Companies.tsx")).toContain("Only archived companies");
  });
});

/* ── R98 ────────────────────────────────────────────────────────────────── */

describe("R98: one money format", () => {
  it("whole amounts, cents only when there are any", () => {
    expect(formatAmount(1234)).toBe("$1,234");
    expect(formatAmount(1234.5)).toBe("$1,234.50");
    expect(formatAmount("9876543.21")).toBe("$9,876,543.21");
    expect(formatAmount(null)).toBe("$0");
    expect(formatAmount(Number.NaN)).toBe("$0");
    expect(formatAmount(-50)).toBe("-$50");
  });

  it("compact: millions are M, never thousands of k", () => {
    expect(formatAmount(1_500_000, { compact: true })).toBe("$1.5M");
    expect(formatAmount(999_999, { compact: true })).toBe("$1M");
    expect(formatAmount(150_000, { compact: true })).toBe("$150k");
    expect(formatAmount(1_500, { compact: true })).toBe("$1.5k");
    expect(formatAmount(2_000, { compact: true })).toBe("$2k");
    expect(formatAmount(2_340_000_000, { compact: true })).toBe("$2.3B");
    expect(formatAmount(950.4, { compact: true })).toBe("$950");
  });

  it("takes a currency, for when a workspace has one", () => {
    expect(formatAmount(1234.5, { currency: "EUR" })).toBe("€1,234.50");
    expect(formatAmount(1_500_000, { currency: "GBP", compact: true })).toBe("£1.5M");
  });

  it("the page-local formatters are gone", () => {
    const common = read("client/src/components/usip/Common.tsx");
    expect(block(common, "export function fmt$(", "\n}\n")).toContain("return formatAmount(n);");
    expect(block(read("client/src/pages/usip/DealsV2.tsx"), "function money(", "\n}\n")).toContain("formatAmount(v, { compact: true })");
    expect(block(read("client/src/pages/usip/AnalyticsV2.tsx"), "function money(", "\n}\n")).toContain("formatAmount(v, { compact: true })");
    expect(block(read("client/src/pages/usip/CompanyProfile.tsx"), "function fmtMoney(", "\n}\n")).toContain("formatAmount(n, { compact: true })");
    expect(block(read("client/src/pages/usip/ListDetail.tsx"), "function fmtMoney(", "\n}\n")).toContain("formatAmount(n, { compact: true })");
    expect(block(read("client/src/pages/usip/Quota.tsx"), "function fmt$(", "\n}\n")).toContain("formatAmount(n)");
  });
});

/* ── R105 ───────────────────────────────────────────────────────────────── */

describe("R105: @mentions without typing the token", () => {
  it("reads the name being typed after @, only at a word start", () => {
    expect(mentionQueryAt("Ping @an", 8)).toEqual({ start: 5, query: "an" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("mail me at me@acme", 18)).toBeNull();
    expect(mentionQueryAt("Ping @ann and", 13)).toBeNull();
  });

  it("writes the token the server notifies from, and shows it as @Name", () => {
    const r = insertMention("Ping @an please", 5, 8, { userId: 5, name: "Ann Lee" });
    expect(r.text).toBe("Ping @[Ann Lee](user:5)  please");
    expect(r.caret).toBe("Ping @[Ann Lee](user:5) ".length);
    // The same pattern crmNotes.create reads.
    expect(Array.from(r.text.matchAll(/@\[[^\]]+\]\(user:(\d+)\)/g), (m) => m[1])).toEqual(["5"]);
    // Brackets in a name can't break the token.
    expect(insertMention("@x", 0, 2, { userId: 6, name: "Sam [ops]" }).text).toBe("@[Sam ops](user:6) ");
    expect(mentionsAsText("Ping @[Ann Lee](user:5) and @[Sam](user:6)")).toBe("Ping @Ann Lee and @Sam");
  });

  it("offers members whose name starts a word with what was typed", () => {
    const team = [{ userId: 1, name: "Ann Lee" }, { userId: 2, name: "Lee Park" }, { userId: 3, name: null }, { userId: 4, name: "Bob" }];
    expect(mentionCandidates(team, "le").map((m) => m.userId)).toEqual([1, 2]);
    expect(mentionCandidates(team, "").map((m) => m.userId)).toEqual([1, 2, 4]);
  });

  it("the notes box uses it, and the drawer no longer asks for the raw token", () => {
    const notes = block(read("client/src/components/usip/EntityDetail.tsx"), "function NotesTab(", "\n}\n");
    expect(notes).toContain("const mention = mentionQueryAt(draft, caret);");
    expect(notes).toContain("insertMention(draft, mention.start, caret,");
    expect(notes).toContain("{mentionsAsText(n.body)}");
    expect(read("client/src/components/usip/RecordDrawer.tsx")).not.toContain("@[Name](user:1)");
  });
});
