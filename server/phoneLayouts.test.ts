/**
 * Phone layouts, the part phase 4 left (audit 2026-10-20, U8): header actions
 * fold into an overflow menu on a phone, and the main list pages' wide tables
 * become stacked cards there, through one shared component each
 * (components/usip/HeaderActions.tsx, components/usip/RecordCards.tsx).
 * Filter rails and previews as sheets are ResponsiveRail's, pinned in
 * phase4Phone.test.ts, and kept.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fragment, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Radix renders a popover's content through a portal, which server rendering
// leaves out; a stand-in shows what HeaderActions puts in it.
vi.mock("../client/src/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => createElement("div", { "data-popover": "" }, children),
  PopoverTrigger: ({ children }: { children: ReactNode }) => createElement("div", { "data-trigger": "" }, children),
  PopoverContent: ({ children, ...rest }: { children: ReactNode }) => createElement("div", { "data-content": "", "data-header-overflow": (rest as any)["data-header-overflow"] }, children),
}));

import { HeaderActions, flatten } from "../client/src/components/usip/HeaderActions";
import { RecordCards } from "../client/src/components/usip/RecordCards";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: ReactElement) => renderToStaticMarkup(el);

/** Server-render as if on a screen this wide. */
function at<T>(width: number, fn: () => T): T {
  const g = globalThis as any;
  const had = "window" in g, prev = g.window;
  g.window = { innerWidth: width, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) };
  try { return fn(); } finally { if (had) g.window = prev; else delete g.window; }
}
afterEach(() => { delete (globalThis as any).window; });

const btn = (label: string) => createElement("button", { key: label, type: "button" }, label);

describe("header actions fold into a More menu on a phone (U8)", () => {
  const four = (extra: Record<string, unknown> = {}) =>
    createElement(HeaderActions, { keep: 1, label: "More lead actions", ...extra } as any, btn("Search"), btn("Send"), btn("Export"), btn("Import"));

  it("from md up: every action in the row, no menu", () => {
    const out = at(1280, () => html(four()));
    expect(out).not.toContain("data-popover");
    for (const l of ["Search", "Send", "Export", "Import"]) expect(out).toContain(`>${l}</button>`);
  });

  it("on a phone: the first `keep` stay, the rest are in the menu, which is named", () => {
    const out = at(375, () => html(four()));
    const menu = out.slice(out.indexOf("data-content"));
    const bar = out.slice(0, out.indexOf("data-popover"));
    expect(bar).toContain(">Search</button>");
    for (const l of ["Send", "Export", "Import"]) {
      expect(menu).toContain(`>${l}</button>`);
      expect(bar).not.toContain(`>${l}</button>`);
    }
    expect(out).toContain('aria-label="More lead actions"');
  });

  it("the page's main action is never folded, and is last in the row from md up", () => {
    const pinned = createElement("button", { type: "button" }, "New lead");
    const phone = at(375, () => html(four({ pinned })));
    expect(phone.slice(0, phone.indexOf("data-popover"))).toContain(">New lead</button>");
    expect(phone.slice(phone.indexOf("data-content"))).not.toContain("New lead");
    const desk = at(1280, () => html(four({ pinned })));
    expect(desk.indexOf(">New lead<")).toBeGreaterThan(desk.indexOf(">Import<"));
    expect(desk.indexOf(">Import<")).toBeGreaterThan(-1);
    const first = at(1280, () => html(four({ pinned, pinnedAt: "start" })));
    expect(first.indexOf(">Search<")).toBeGreaterThan(first.indexOf(">New lead<"));
    expect(first.indexOf(">New lead<")).toBeGreaterThan(-1);
  });

  it("one action over `keep` is not worth a menu; `bare` adds no wrapper from md up", () => {
    const two = createElement(HeaderActions, { keep: 1 } as any, btn("A"), btn("B"));
    expect(at(375, () => html(two))).not.toContain("data-popover");
    const bare = createElement(HeaderActions, { bare: true, keep: 0 } as any, btn("A"), btn("B"));
    expect(at(1280, () => html(bare))).toBe('<button type="button">A</button><button type="button">B</button>');
  });

  it("fragments are opened and empty slots are not counted", () => {
    const items = flatten([createElement("i", { key: 1 }), false, null, createElement("span", { key: "f" }, "x"), createElement("b", { key: 3 })]);
    expect(items.length).toBe(3);
    // A span is one action; a fragment's children are each an action.
    const span = createElement(HeaderActions, { keep: 0 } as any, createElement("span", null, btn("A"), btn("B")));
    expect(at(375, () => html(span))).not.toContain("data-popover");
    const frag = createElement(HeaderActions, { keep: 0 } as any, createElement(Fragment, null, btn("A"), btn("B"), btn("C")));
    const out = at(375, () => html(frag));
    expect(out).toContain("data-popover");
    for (const l of ["A", "B", "C"]) expect(out.slice(out.indexOf("data-content"))).toContain(`>${l}</button>`);
  });
});

describe("a list's rows become stacked cards (U8)", () => {
  type Row = { id: number; name: string; title: string };
  const rows: Row[] = [{ id: 1, name: "Ada", title: "CTO" }, { id: 2, name: "Grace", title: "VP" }];
  const cards = (extra: Record<string, unknown> = {}) => html(createElement(RecordCards<Row>, {
    label: "People",
    rows,
    rowKey: (r: Row) => r.id,
    primary: (r: Row) => r.name,
    fields: [{ key: "title", label: "Title", render: (r: Row) => r.title }],
    onOpen: () => {},
    ...extra,
  } as any));

  it("one card per row: the primary line, then label and value", () => {
    const out = cards();
    expect(out).toContain('<ul aria-label="People" data-record-cards=""');
    expect(out.split("<li").length - 1).toBe(2);
    expect(out).toContain(">Ada</div>");
    expect(out).toContain('<dt class="text-muted-foreground whitespace-nowrap">Title</dt><dd class="min-w-0 break-words">CTO</dd>');
    // A card opens from the keyboard too, without claiming to be a button around links.
    expect(out).toContain('tabindex="0"');
    expect(out).not.toContain('role="button"');
  });

  it("the bulk selection is kept, named, and the open record is marked", () => {
    const out = cards({ checked: (r: Row) => r.id === 2, onCheck: () => {}, checkLabel: "Select person", selected: (r: Row) => r.id === 1 });
    expect(out.split('aria-label="Select person"').length - 1).toBe(2);
    expect(out.split("bg-muted").length - 1).toBeGreaterThanOrEqual(1);
  });

  it("the row's own actions go under the fields", () => {
    const out = cards({ footer: (r: Row) => createElement("button", { type: "button" }, `Convert ${r.name}`) });
    expect(out).toContain(">Convert Ada</button>");
    expect(out.indexOf(">Convert Ada<")).toBeGreaterThan(out.indexOf(">CTO<"));
  });
});

describe("the main list pages use them on a phone (U8)", () => {
  const before = (src: string, a: string, b: string) => {
    const i = src.indexOf(a);
    const j = src.indexOf(b);
    expect(i, a).toBeGreaterThan(-1);
    expect(j, b).toBeGreaterThan(-1);
    return i < j;
  };

  it("People, Companies and Leads: cards on a phone, the table from md up", () => {
    const people = read("client/src/pages/usip/People.tsx");
    expect(people).toContain(") : phone ? (\n                // One card per person on a phone, from the table's own cells (audit U8).\n                <RecordCards");
    // The cards use the table's own cell renderers, so a card shows what the row does.
    expect(people).toContain("COLUMN_REGISTRY[k].cell(p, { onAction, changeSummary: liSummaryMap.get(p.id), scoreCell: scoreMap.get(p.id), enrollments: enrollmentMap })");
    expect(before(people, "<RecordCards", '<table className={cn("w-full border-separate')).toBe(true);
    const companies = read("client/src/pages/usip/Companies.tsx");
    expect(companies).toContain(") : phone ? (\n                // One card per company on a phone (audit U8): the same columns, stacked.\n                <RecordCards");
    const leads = read("client/src/pages/usip/Leads.tsx");
    expect(leads).toContain("{phone ? (\n              // One card per lead on a phone, with the row's own actions (audit U8).\n              <RecordCards");
    // One set of row actions, used by the table and the card.
    expect(leads).toContain("{renderLeadActions(l)}");
    expect(leads).toContain("footer={renderLeadActions}");
    expect(leads).toContain("const phone = useIsMobile();");
  });

  it("header actions fold on People, Companies, Leads and a campaign", () => {
    expect(read("client/src/pages/usip/People.tsx")).toContain('<HeaderActions bare keep={0} label="More people actions">');
    expect(read("client/src/pages/usip/Companies.tsx")).toContain('<HeaderActions keep={0} label="More company actions">');
    const leads = read("client/src/pages/usip/Leads.tsx");
    expect(leads).toContain('<HeaderActions keep={1} label="More lead actions"');
    expect(leads).toContain('pinned={<Button onClick={() => setCreateOpen(true)} data-tour-id="leads-new-button">');
    // The status button keeps its place, first, from md up.
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain('<HeaderActions keep={0} label="More campaign actions" pinnedAt="start" pinned={campaign.status === "active" ? (');
  });

  it("the task page folds its header and wraps its rows; the home header wraps", () => {
    const tasks = read("client/src/pages/usip/TasksV2.tsx");
    expect(tasks).toContain('<HeaderActions keep={0} label="More task actions"');
    expect(tasks).toContain('pinned={<Button size="sm" className="h-7 gap-1.5" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New task</Button>}>');
    expect(tasks).toContain('<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">');
    const home = read("client/src/pages/usip/Home.tsx");
    expect(home).toContain('className="relative shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 md:px-6 min-h-12 py-1.5 border-b border-border bg-card/40"');
    expect(home).not.toContain('flex items-center gap-2 px-4 md:px-6 h-12 border-b');
  });

  it("Proposals, Emails and campaigns were already card and row lists; they now fit a phone", () => {
    const proposals = read("client/src/pages/usip/Proposals.tsx");
    expect(proposals).toContain('className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 px-4 sm:px-6 py-4 border-b border-border shrink-0"');
    expect(proposals).not.toContain('"grid grid-cols-4 gap-4 px-6 py-4');
    expect(proposals).toContain('<div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">');
    const emails = read("client/src/pages/usip/EmailsV2.tsx");
    expect(emails).toContain('className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40 cursor-pointer"');
    expect(emails).toContain('<div className="min-w-0 flex-1 basis-[calc(100%-2.75rem)] sm:basis-0">');
  });
});
