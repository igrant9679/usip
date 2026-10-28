/**
 * Phase 4 of the 2026-10-20 audit, part 5 — phone layouts (X5.4, X5.5, U8;
 * G27, O58, R78, G65, P45, P59, A65).
 *
 *   the static check (scripts/phoneScan.mjs) finds nothing in client/src: no
 *   fixed rail beside a list, no box wider than a phone, no table cut off ·
 *   the check catches each problem and passes each fix · ResponsiveRail is
 *   the rail from md up and a sheet below it, with one copy of its content ·
 *   a phone is known on the first render · Settings can switch section on a
 *   phone (G27) · Social accounts and the sequence canvas no longer push the
 *   page sideways · the audit's screens each use the fix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain ES module, no types
import { scan, scanFile, widthPx } from "../scripts/phoneScan.mjs";

// Radix renders a sheet through a portal, which server rendering leaves out;
// a stand-in shows what ResponsiveRail asks the sheet for.
vi.mock("../client/src/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => createElement("div", { "data-sheet": open ? "open" : "closed" }, children),
  SheetContent: ({ side, className, children }: { side: string; className?: string; children: ReactNode }) => createElement("div", { "data-side": side, className }, children),
  SheetTitle: ({ className, children }: { className?: string; children: ReactNode }) => createElement("h2", { className }, children),
}));

import { ResponsiveRail, PhoneRailButton } from "../client/src/components/usip/ResponsiveRail";
import { useIsMobile, MOBILE_BREAKPOINT } from "../client/src/hooks/useMobile";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: ReactElement) => renderToStaticMarkup(el);
type Finding = { rule: string; file: string; line: number; tag: string; width: number };
const rules = (src: string) => (scanFile("t.tsx", src) as Finding[]).map((f) => f.rule);

/** Server-render as if on a screen this wide. */
function at<T>(width: number, fn: () => T): T {
  const g = globalThis as any;
  const had = "window" in g, prev = g.window;
  g.window = { innerWidth: width, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) };
  try { return fn(); } finally { if (had) g.window = prev; else delete g.window; }
}
afterEach(() => { delete (globalThis as any).window; });

describe("the static check finds nothing in the app (X5.4, X5.5)", () => {
  it("no fixed rail, no box wider than a phone, no clipped table", () => {
    const found = scan(root) as Finding[];
    expect(found.map((f) => `${f.rule} ${f.file}:${f.line} <${f.tag}> ${f.width}px`)).toEqual([]);
  });
});

describe("the check catches each problem and passes each fix", () => {
  it("reads widths in Tailwind steps, pixels and rems", () => {
    expect([widthPx("w-60"), widthPx("w-72"), widthPx("w-96"), widthPx("w-[380px]"), widthPx("w-[24rem]"), widthPx("w-full"), widthPx("max-w-96")]).toEqual([240, 288, 384, 380, 384, null, null]);
  });

  it("a fixed rail beside the page is caught; a narrow one, or one shown from md, is not", () => {
    expect(rules(`const a = <aside className="w-64 shrink-0 border-r flex flex-col">x</aside>;`)).toEqual(["fixed-rail"]);
    expect(rules(`const a = <div className="w-72 shrink-0 border-l bg-background">x</div>;`)).toEqual(["fixed-rail"]);
    expect(rules(`const a = <div className="w-80 flex-shrink-0 border-r flex flex-col">x</div>;`)).toEqual(["fixed-rail"]);
    expect(rules(`const a = <aside className={cn("w-60 shrink-0", open && "border-r")}>x</aside>;`)).toEqual(["fixed-rail"]);
    // 208 px is narrow enough to leave the page its room.
    expect(rules(`const a = <aside className="w-52 shrink-0 border-r">x</aside>;`)).toEqual([]);
    expect(rules(`const a = <aside className="hidden md:flex w-60 shrink-0 border-r">x</aside>;`)).toEqual([]);
    expect(rules(`const a = <aside className="w-full md:w-72 shrink-0 border-r">x</aside>;`)).toEqual([]);
    expect(rules(`const a = <aside className={cn("w-full md:w-72 shrink-0 border-r flex-col", sel ? "hidden md:flex" : "flex")}>x</aside>;`)).toEqual([]);
    // A kanban column scrolls with its board; it has no side border.
    expect(rules(`const a = <div className="w-72 shrink-0 bg-secondary/40 border rounded-lg">x</div>;`)).toEqual([]);
    // An off-canvas drawer takes no room from the page.
    expect(rules(`const a = <aside className={cn("w-60 shrink-0 border-r", "fixed inset-y-0 left-0 md:static", open ? "translate-x-0" : "-translate-x-full")}>x</aside>;`)).toEqual([]);
    // ResponsiveRail's classes are its md-and-up look.
    expect(rules(`const a = <ResponsiveRail title="Filters" open={o} onOpenChange={s} className="w-96 shrink-0 border-l">x</ResponsiveRail>;`)).toEqual([]);
  });

  it("a box wider than a phone is caught unless it is capped or starts at a breakpoint", () => {
    expect(rules(`const a = <div className="fixed right-0 inset-y-0 w-[380px]">x</div>;`)).toEqual(["wide-box"]);
    expect(rules(`const a = <PopoverContent className="w-[420px] p-0">x</PopoverContent>;`)).toEqual(["wide-box"]);
    expect(rules(`const a = <PopoverContent className="w-96 p-0">x</PopoverContent>;`)).toEqual(["wide-box"]);
    expect(rules(`const a = <div className="fixed right-0 inset-y-0 w-full sm:w-[380px]">x</div>;`)).toEqual([]);
    expect(rules(`const a = <PopoverContent className="w-[420px] max-w-[calc(100vw-1rem)] p-0">x</PopoverContent>;`)).toEqual([]);
    expect(rules(`const a = <div className="fixed w-[440px] max-w-[100vw]">x</div>;`)).toEqual([]);
    // Dialogs cap themselves at calc(100% - 2rem).
    expect(rules(`const a = <DialogContent className="w-[400px]">x</DialogContent>;`)).toEqual([]);
    // A variant applies to something else: children, or from md up.
    expect(rules(`const a = <div className="[&_table]:w-[600px] md:w-[600px]">x</div>;`)).toEqual([]);
    expect(rules(`const a = <div className="w-80">x</div>;`)).toEqual([]);
  });

  it("a table in a box that hides overflow is cut off; a scroller or the shared Table is not", () => {
    expect(rules(`const a = <div className="rounded-lg border overflow-hidden"><table className="w-full" /></div>;`)).toEqual(["clipped-table"]);
    expect(rules(`const a = <div className="rounded-lg border overflow-hidden">{rows ? <table className="w-full" /> : null}</div>;`)).toEqual(["clipped-table"]);
    expect(rules(`const a = <div className="rounded-lg border overflow-x-auto"><table className="w-full" /></div>;`)).toEqual([]);
    expect(rules(`const a = <div className="rounded-lg border overflow-hidden"><div className="overflow-x-auto"><table /></div></div>;`)).toEqual([]);
    expect(rules(`const a = <div className="rounded-lg border overflow-hidden"><Table /></div>;`)).toEqual([]);
  });

  it("main had 14 of these (10 rails, 4 wide boxes) and 4 clipped tables", () => {
    // Recorded 2026-10-27 against c81d439: rails on People (2), Companies,
    // Sequences, Reports, Landing Pages, Home, Chat, Mindmap, Unified inbox;
    // Help drawer, two popovers at 420 px, one at 384 px; tables on Lead
    // routing, Website visitors, Deliverability, AI call queue.
    expect(read("scripts/phoneScan.mjs")).toContain('path.join(root, "client", "src")');
  });
});

describe("ResponsiveRail: the rail from md up, a sheet below (X5.5, U8)", () => {
  const rail = (extra: Record<string, unknown> = {}) =>
    createElement(ResponsiveRail, { title: "Filters", open: false, onOpenChange: () => {}, className: "w-64 shrink-0 border-r flex-col", children: createElement("p", null, "the filters"), ...extra } as any);

  it("from md up: an aside named by its title, with the page's classes, open or not", () => {
    const out = at(1280, () => html(rail()));
    expect(out).toBe('<aside aria-label="Filters" class="flex w-64 shrink-0 border-r flex-col"><p>the filters</p></aside>');
  });

  it("on a phone: a sheet with a titled header, closed until the page opens it", () => {
    const closed = at(375, () => html(rail()));
    expect(closed).toContain('data-sheet="closed"');
    expect(closed).not.toContain("<aside");
    expect(closed).toContain('data-side="left"');
    expect(closed).toMatch(/<h2 class="truncate text-sm">Filters<\/h2>/);
    expect(closed).toContain("<p>the filters</p>");
    // Covers most of the phone instead of squeezing the list beside it.
    expect(closed).toContain("w-[88vw] max-w-sm");
    expect(at(375, () => html(rail({ open: true })))).toContain('data-sheet="open"');
  });

  it("a panel with its own header keeps one: the sheet's title is for screen readers", () => {
    const out = at(375, () => html(rail({ ownHeader: true, side: "right", sheetClassName: "w-full max-w-none" })));
    expect(out).toContain('<h2 class="sr-only">Filters</h2>');
    expect(out).toContain('data-side="right"');
    expect(out).toContain("w-full max-w-none");
  });

  it("the content renders once, never in both places", () => {
    for (const w of [375, 1280]) expect(at(w, () => html(rail())).split("the filters").length - 1).toBe(1);
  });

  it("the button that opens it is hidden from md up", () => {
    const out = html(createElement(PhoneRailButton, { onClick: () => {}, children: "Filters" }));
    expect(out).toContain("md:hidden");
    expect(out).toContain("Filters");
  });
});

describe("a phone is known on the first render", () => {
  const Probe = () => createElement("i", null, String(useIsMobile()));
  it("below 768 px the first render is the phone's, so no rail flashes open and shuts", () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
    expect(at(375, () => html(createElement(Probe)))).toBe("<i>true</i>");
    expect(at(767, () => html(createElement(Probe)))).toBe("<i>true</i>");
    expect(at(768, () => html(createElement(Probe)))).toBe("<i>false</i>");
  });
  it("with no window (server render) it is the desktop", () => {
    expect(html(createElement(Probe))).toBe("<i>false</i>");
  });
});

describe("Settings can switch section on a phone (G27)", () => {
  const src = read("client/src/pages/usip/SettingsHub.tsx");
  it("the section rail is a ResponsiveRail, not an aside hidden below md", () => {
    expect(src).not.toContain('<aside className="hidden md:flex w-60');
    expect(src).toMatch(/<ResponsiveRail\s+title="Settings sections"\s+open=\{navOpen\}\s+onOpenChange=\{setNavOpen\}/);
  });
  it("the phone's top bar names the section and opens the rail", () => {
    const bar = src.slice(src.indexOf("mobile top bar"), src.indexOf("{section === \"profile\""));
    expect(bar).toContain('className="md:hidden');
    expect(bar).toMatch(/aria-expanded=\{navOpen\}\s+onClick=\{\(\) => setNavOpen\(true\)\}/);
    expect(bar).toContain("{sectionLabel}");
    expect(src).toMatch(/const sectionLabel = GROUPS\.flatMap\(\(g\) => g\.items\)\.find\(\(i\) => i\.id === section\)\?\.label/);
  });
  it("picking a section closes the rail", () => {
    expect(src).toMatch(/const go = \(it: HubItem\) => \{\n\s+setNavOpen\(false\);/);
  });
  it("section headers wrap and keep a phone's margins", () => {
    for (const f of ["client/src/pages/usip/SettingsHub.tsx", "client/src/pages/usip/Settings.tsx", "client/src/components/usip/settings/BrandingSection.tsx", "client/src/components/usip/settings/SocialAccountsSection.tsx"]) {
      const s = read(f);
      expect(s, f).toContain('className="shrink-0 px-4 sm:px-6 pt-4 flex flex-wrap items-start justify-between gap-3"');
      expect(s, f).not.toContain('"shrink-0 px-6 pt-4');
    }
  });
});

describe("Social accounts and the sequence canvas fit a phone (X5.4)", () => {
  it("Social accounts: header buttons and each account's buttons wrap under it", () => {
    const s = read("client/src/components/usip/settings/SocialAccountsSection.tsx");
    expect(s).toMatch(/<div className="min-w-0">\s+<h1 className="text-xl font-semibold tracking-tight">Social accounts<\/h1>/);
    expect(s).toMatch(/<div className="flex flex-wrap items-center gap-2">\s+<Button\s+variant="outline"\s+size="sm"\s+className="gap-1\.5"\s+onClick=\{\(\) => \{ utils\.unipile/);
    expect(s).toContain('<div className="flex flex-wrap items-start gap-3">');
    expect(s).toContain('<div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">');
    expect(s).toContain('<div className="flex flex-wrap items-start justify-between gap-3">');
  });

  it("the canvas: the palette is a sheet opened from the canvas, panels cover a phone", () => {
    const s = read("client/src/pages/usip/SequenceCanvas.tsx");
    expect(s).toMatch(/<ResponsiveRail\s+title="Node palette"\s+open=\{paletteOpen\}/);
    expect(s).toMatch(/<Panel position="top-left" className="md:hidden">\s+<PhoneRailButton onClick=\{\(\) => setPaletteOpen\(true\)\}/);
    expect(s).toMatch(/if \(readOnly\) return;\n\s+setPaletteOpen\(false\);/);
    expect(s).toContain('${anyPanelOpen ? "md:mr-80" : ""}');
    expect(s).not.toContain('"mr-80"');
    expect(s).toContain('<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b bg-card shrink-0">');
    for (const f of ["client/src/components/usip/canvas/NodeEditPanel.tsx", "client/src/components/usip/canvas/SequenceSettingsPanel.tsx"]) {
      expect(read(f), f).toContain("absolute right-0 top-0 h-full w-full sm:w-80");
    }
  });
});

describe("the audit's screens each use the fix (O58, R78, G65, P45, P59, A65)", () => {
  it("People, Companies, Sequences: the filter rail is a sheet the Filters button opens", () => {
    for (const f of ["client/src/pages/usip/People.tsx", "client/src/pages/usip/Companies.tsx", "client/src/pages/usip/SequencesV2.tsx"]) {
      const s = read(f);
      expect(s, f).toMatch(/\{\(phone \|\| !hideFilters\) && \(\s+<ResponsiveRail\s+title="Filters"\s+open=\{filtersSheet\}\s+onOpenChange=\{setFiltersSheet\}/);
      expect(s, f).toContain("onClick={() => (phone ? setFiltersSheet(true) : setHideFilters((v) => !v))}");
    }
  });

  it("People's Quick Preview covers a phone and closes through the sheet", () => {
    const s = read("client/src/pages/usip/People.tsx");
    expect(s).toMatch(/<ResponsiveRail\s+title="Quick Preview"\s+side="right"\s+open\s+onOpenChange=\{\(o\) => \{ if \(!o\) onClose\(\); \}\}/);
    expect(s).toContain('sheetClassName="w-full max-w-none sm:max-w-md"');
  });

  it("Reports' builder, Home's widget library and the mindmap's properties are sheets on a phone", () => {
    expect(read("client/src/pages/usip/Reports.tsx")).toMatch(/<ResponsiveRail\s+title="Report builder"\s+open=\{builderOpen\}/);
    expect(read("client/src/pages/usip/Reports.tsx")).toContain("<PhoneRailButton onClick={() => setBuilderOpen(true)}");
    expect(read("client/src/pages/usip/Home.tsx")).toMatch(/<ResponsiveRail\s+title="Widget library"\s+side="right"\s+open\s+onOpenChange=\{setLibOpen\}/);
    expect(read("client/src/pages/usip/MindmapCanvas.tsx")).toMatch(/<ResponsiveRail\s+title="Node properties"/);
  });

  it("Landing pages, Chat agents and Unified inbox show the list or the open one on a phone", () => {
    for (const f of ["client/src/pages/usip/LandingPages.tsx", "client/src/pages/usip/ChatAgents.tsx"]) {
      const s = read(f);
      expect(s, f).toContain('"w-full md:w-72 shrink-0 border-r border-border flex-col bg-card/40", selectedId ? "hidden md:flex" : "flex"');
      expect(s, f).toContain('cn("flex-1 min-w-0 overflow-auto", !selectedId && "hidden md:block")');
      expect(s, f).toMatch(/className="md:hidden -ml-2 h-7 gap-1" onClick=\{\(\) => setSelectedId\(null\)\}/);
    }
    const inbox = read("client/src/pages/usip/UnifiedInbox.tsx");
    expect(inbox).toContain('cn("w-full md:w-80 flex-shrink-0 border-r flex-col min-h-0", selectedChat ? "hidden md:flex" : "flex")');
    expect(inbox).toContain('cn("flex-1 min-w-0 flex-col min-h-0", selectedChat ? "flex" : "hidden md:flex")');
    expect(inbox).toMatch(/aria-label="Back to conversations" onClick=\{\(\) => setSelectedChat\(null\)\}/);
  });

  it("the Help drawer is the phone's width, 380 px from sm up (G65)", () => {
    expect(read("client/src/components/usip/HelpDrawer.tsx")).toContain("fixed right-0 top-0 bottom-0 z-[9975] w-full sm:w-[380px]");
  });

  it("title rows wrap instead of running off the screen (O58, R78) — 17 pages", () => {
    const pages = ["AIAssistant", "AnalyticsV2", "Calls", "Companies", "ConversationsV2", "DealsV2", "Deliverability", "EmailsV2", "FormsV2", "LinkedInLimits", "Lists", "MeetingsV2", "People", "Reports", "TasksV2", "WebsiteVisitors", "WorkflowsV2"];
    for (const p of pages) {
      const s = read(`client/src/pages/usip/${p}.tsx`);
      expect(s, p).toContain("shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 min-h-11 py-1.5");
      expect(s, p).not.toContain("shrink-0 flex items-center gap-2 px-4 h-11");
    }
  });

  it("List detail's header and segment rules wrap (P59)", () => {
    const list = read("client/src/pages/usip/ListDetail.tsx");
    expect(list).toMatch(/<div className="flex flex-wrap items-center gap-x-2 gap-y-1\.5">\s+\{editingName \?/);
    expect(list).toContain("max-w-[60vw] sm:max-w-[280px]");
    const seg = read("client/src/pages/usip/SegmentRules.tsx");
    expect(seg).toContain("`flex flex-wrap items-center gap-x-4 gap-y-2 border border-border rounded-lg p-4 bg-card");
    expect(seg.split('<div className="flex items-center gap-2 flex-1 min-w-[8rem]">').length - 1).toBe(2);
  });

  it("Lead routing's rules table scrolls instead of being cut off (P45)", () => {
    expect(read("client/src/pages/usip/LeadRouting.tsx")).toMatch(/<div className="rounded-lg border bg-card overflow-x-auto">\s+<table/);
  });

  it("the campaign's eight tabs scroll in their strip; log rows stack (A65)", () => {
    const s = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(s).toContain('<TabsList className="bg-muted/50 border max-w-full overflow-x-auto justify-start">');
    expect(s).toContain("w-full px-3 py-2 flex flex-wrap sm:flex-nowrap items-start");
    expect(s).toContain("basis-full sm:basis-auto min-w-0 sm:flex-1");
    expect(s).toContain('"pl-3 sm:pl-[180px] pr-3 pb-3 space-y-2"');
  });

  it("Proposals' bulk bar wraps (R78)", () => {
    expect(read("client/src/pages/usip/Proposals.tsx")).toContain('"flex flex-wrap items-center gap-3 px-4 sm:px-6 py-2.5 bg-teal-500/10');
  });
});
