/**
 * Phase 4 of the 2026-10-20 audit, part 4 — accessibility (X5.1–X5.3, X5.6;
 * A64, R77, P30, P58, P122, G64, G70, L13).
 *
 *   the static check (scripts/a11yScan.mjs) finds nothing in client/src:
 *   every icon button and field has a name, clickable rows and cards work
 *   from the keyboard, tab strips are tab lists, no control shows on hover
 *   only · the check itself catches each problem and passes each fix · the
 *   shared pieces: field labels through context, pressable rows, tab lists,
 *   readable text on a brand colour · contrast fixes measured · public pages
 *   have a heading and a title; zoom works; password toggles take focus.
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain ES module, no types
import { scan, scanFile } from "../scripts/a11yScan.mjs";
import { FieldLabelContext } from "../client/src/components/ui/field-label";
import { Input } from "../client/src/components/ui/input";
import { Textarea } from "../client/src/components/ui/textarea";
import { Switch } from "../client/src/components/ui/switch";
import { pressable } from "../client/src/lib/pressable";
import { tablistProps, tabProps } from "../client/src/lib/tabs";
import { readableOn } from "../client/src/components/usip/WorkspaceBrandingSync";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: ReactElement) => renderToStaticMarkup(el);
type Finding = { rule: string; file: string; line: number; tag: string };
const rules = (src: string) => (scanFile("t.tsx", src) as Finding[]).map((f) => f.rule);

describe("the static check finds nothing in the app (X5.1–X5.3)", () => {
  it("every icon button and field is named, every click works from the keyboard", () => {
    const found = scan(root) as Finding[];
    expect(found.map((f) => `${f.rule} ${f.file}:${f.line} <${f.tag}>`)).toEqual([]);
  });
});

describe("the check catches each problem and passes each fix", () => {
  const icons = `import { X, Trash2 } from "lucide-react";\n`;
  it("an icon-only button has no name; aria-label, text or a title gives it one", () => {
    expect(rules(icons + `const a = <Button size="icon"><Trash2 /></Button>;`)).toEqual(["button-name"]);
    expect(rules(icons + `const a = <button>{busy ? <X /> : <Trash2 />}</button>;`)).toEqual(["button-name"]);
    expect(rules(icons + `const a = <button>×</button>;`)).toEqual(["button-name"]);
    expect(rules(icons + `const a = <Button aria-label="Delete"><Trash2 /></Button>;`)).toEqual([]);
    expect(rules(icons + `const a = <Button><Trash2 /> Delete</Button>;`)).toEqual([]);
    expect(rules(icons + `const a = <button title="Delete"><Trash2 /></button>;`)).toEqual([]);
    expect(rules(icons + `const a = <Button><Trash2 /><span className="sr-only">Delete</span></Button>;`)).toEqual([]);
    // A trigger with asChild is named by its child; a local component where it renders.
    expect(rules(icons + `const a = <DropdownMenuTrigger asChild><Button aria-label="More"><X /></Button></DropdownMenuTrigger>;`)).toEqual([]);
    expect(rules(`function Toggle({ label }: any) { return <button aria-label={label} />; }\nconst a = <Toggle label="On" />;`)).toEqual([]);
  });

  it("a field needs a label; a placeholder is not one", () => {
    expect(rules(`const a = <Input placeholder="Name" />;`)).toEqual(["control-label"]);
    expect(rules(`const a = <><Label>Name</Label><Input /></>;`)).toEqual(["control-label"]);
    expect(rules(`const a = <Input aria-label="Name" />;`)).toEqual([]);
    expect(rules(`const a = <><Label htmlFor="n">Name</Label><Input id="n" /></>;`)).toEqual([]);
    expect(rules(`const a = <label>Name <input /></label>;`)).toEqual([]);
    expect(rules(`const a = <input type="hidden" />;`)).toEqual([]);
    expect(rules(`const a = <Switch checked />;`)).toEqual(["control-label"]);
    // wouter's <Switch> is the router.
    expect(rules(`import { Route, Switch } from "wouter";
const a = <Switch><Route path="/" /></Switch>;`)).toEqual([]);
  });

  it("a wrapper that provides the label names shared controls, not raw inputs", () => {
    const wrapper = `function Field({ label, children }: any) { const id = "x"; return <div><Label id={id}>{label}</Label><FieldLabelContext.Provider value={id}>{children}</FieldLabelContext.Provider></div>; }\n`;
    expect(rules(wrapper + `const a = <Field label="Name"><Input /></Field>;`)).toEqual([]);
    expect(rules(wrapper + `const a = <Field label="Name"><input /></Field>;`)).toEqual(["control-label"]);
  });

  it("a clickable div needs the keyboard; a backdrop or a click-stopper does not", () => {
    expect(rules(`const a = <div onClick={open}>Row</div>;`)).toEqual(["click-keyboard"]);
    expect(rules(`const a = <Badge onClick={open}>3</Badge>;`)).toEqual(["click-keyboard"]);
    expect(rules(`const a = <div {...pressable(open)}>Row</div>;`)).toEqual([]);
    expect(rules(`const a = <div role="button" tabIndex={0} onKeyDown={k} onClick={open}>Row</div>;`)).toEqual([]);
    expect(rules(`const a = <div aria-hidden="true" onClick={close} />;`)).toEqual([]);
    expect(rules(`const a = <td onClick={(e) => e.stopPropagation()}><input aria-label="Select" type="checkbox" /></td>;`)).toEqual([]);
  });

  it("a mapped strip of tab buttons needs the tab pattern", () => {
    expect(rules(`const a = <div>{TABS.map((t) => <button key={t} onClick={() => setTab(t)}>{t}</button>)}</div>;`)).toEqual(["tab-role"]);
    expect(rules(`const a = <div {...tablistProps()}>{TABS.map((t) => <button {...tabProps(tab === t)} key={t} onClick={() => setTab(t)}>{t}</button>)}</div>;`)).toEqual([]);
    // One button that jumps to a tab is not a strip.
    expect(rules(`const a = <Button onClick={() => setTab("scraper")}>Go to Scraper</Button>;`)).toEqual([]);
  });

  it("a control hidden until hover needs a focus variant", () => {
    expect(rules(`const a = <button aria-label="Delete" className="opacity-0 group-hover:opacity-100">x</button>;`)).toEqual(["hover-only"]);
    expect(rules(`const a = <button aria-label="Delete" className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">x</button>;`)).toEqual([]);
  });

  it("main had 853 of these; the scan reads the same files", () => {
    // Recorded 2026-10-27 against origin/main 4c020cb: 128 button-name,
    // 652 control-label, 37 click-keyboard, 16 tab-role, 20 hover-only.
    expect(read("scripts/a11yScan.mjs")).toContain('path.join(root, "client", "src")');
  });
});

describe("a field label reaches the shared controls (X5.1, P30, P122)", () => {
  const inField = (el: ReactElement) => html(createElement(FieldLabelContext.Provider, { value: "lbl-1" }, el));
  it("inside a labelled field, Input, Textarea and Switch are labelled by it", () => {
    expect(inField(createElement(Input))).toContain('aria-labelledby="lbl-1"');
    expect(inField(createElement(Textarea))).toContain('aria-labelledby="lbl-1"');
    expect(inField(createElement(Switch))).toContain('aria-labelledby="lbl-1"');
  });
  it("a control's own name wins, and outside a field nothing is added", () => {
    const own = inField(createElement(Input, { "aria-label": "Search" }));
    expect(own).toContain('aria-label="Search"');
    expect(own).not.toContain("aria-labelledby");
    expect(html(createElement(Input))).not.toContain("aria-labelledby");
  });
  it("the field wrappers provide it", () => {
    for (const f of ["client/src/components/usip/canvas/NodeEditPanel.tsx", "client/src/components/usip/canvas/SequenceSettingsPanel.tsx", "client/src/pages/usip/ChatAgents.tsx", "client/src/pages/usip/EmailBuilder.tsx", "client/src/pages/usip/FindProspects.tsx", "client/src/pages/usip/LandingPages.tsx"]) {
      expect(read(f), f).toMatch(/<FieldLabelContext\.Provider value=\{id\}>\{children\}<\/FieldLabelContext\.Provider>/);
    }
  });
  it("a slider's name goes on its thumb, the part a screen reader reaches", () => {
    const s = read("client/src/components/ui/slider.tsx");
    expect(s).toMatch(/<SliderPrimitive\.Thumb[\s\S]*aria-label=\{ariaLabel\}[\s\S]*aria-labelledby=\{ariaLabelledBy \?\? fieldLabel\}/);
  });
});

describe("rows, cards and tab strips work from the keyboard (X5.2, X5.3)", () => {
  const key = (k: string, same = true) => {
    const el = {};
    let prevented = false;
    return { e: { key: k, target: el, currentTarget: same ? el : {}, preventDefault: () => { prevented = true; } } as any, prevented: () => prevented };
  };

  it("pressable: focusable, a button, Enter and Space do the click", () => {
    const calls: string[] = [];
    const p = pressable(() => calls.push("open"));
    expect(p).toMatchObject({ role: "button", tabIndex: 0 });
    for (const k of ["Enter", " "]) { const { e, prevented } = key(k); p.onKeyDown(e); expect(prevented()).toBe(true); }
    p.onKeyDown(key("a").e);
    expect(calls).toEqual(["open", "open"]);
  });

  it("pressable: a key pressed in a control inside is that control's", () => {
    const calls: string[] = [];
    pressable(() => calls.push("open")).onKeyDown(key("Enter", false).e);
    expect(calls).toEqual([]);
  });

  it("pressable rows keep their row role", () => {
    expect(pressable(() => {}, { row: true })).not.toHaveProperty("role");
    expect(pressable(() => {}, { row: true })).toMatchObject({ tabIndex: 0 });
  });

  it("tabs: only the selected tab is in the Tab order, and it says it is selected", () => {
    expect(tabProps(true)).toEqual({ role: "tab", "aria-selected": true, tabIndex: 0 });
    expect(tabProps(false)).toEqual({ role: "tab", "aria-selected": false, tabIndex: -1 });
    expect(tablistProps("Sections")).toMatchObject({ role: "tablist", "aria-label": "Sections" });
  });

  it("tabs: arrows, Home and End move between tabs and open them", () => {
    const clicked: number[] = [];
    let strip: any;
    const tabs = [0, 1, 2].map((i) => ({ i, focus() { (globalThis as any).document.activeElement = this; }, click() { clicked.push(i); }, closest: () => strip }));
    strip = { querySelectorAll: () => tabs };
    (globalThis as any).document = { activeElement: tabs[0] };
    const press = (k: string) => tablistProps().onKeyDown({ key: k, currentTarget: strip, preventDefault() {} } as any);
    press("ArrowRight"); press("ArrowRight"); press("ArrowRight"); press("ArrowLeft"); press("End"); press("Home"); press("x");
    expect(clicked).toEqual([1, 2, 0, 2, 2, 0]);
    delete (globalThis as any).document;
  });

  it("the audit's rows and cards use it", () => {
    for (const [f, re] of [
      ["client/src/pages/usip/Companies.tsx", /\{\.\.\.pressable\(\(\) => setLocation\(`\/v2\/companies\/\$\{a\.id\}`\), \{ row: true \}\)\}/],
      ["client/src/pages/usip/Lists.tsx", /\{\.\.\.pressable\(onOpen\)\}/],
      ["client/src/pages/usip/ARECampaignDetail.tsx", /\{\.\.\.pressable\(\(\) => onSelect\(p\.id\)\)\}/],
      ["client/src/pages/usip/Sequences.tsx", /\{\.\.\.pressable\(\(\) => toggleContact\(c\.id\)\)\}/],
      ["client/src/pages/usip/Team.tsx", /\{\.\.\.tablistProps\("Team sections"\)\}/],
    ] as const) expect(read(f), f).toMatch(re);
  });
});

describe("checkbox cells: the checkbox toggles, once (X5.3)", () => {
  // Contacts.tsx was deleted on 2026-10-27 (phase 5 item 2, the dead page the
  // audit names). It was orphaned already — nothing imported it — so the box
  // it declared never reached a reader. Leads is the reachable one.
  it("Leads: the box has the change handler and a name; the cell only stops the row", () => {
    for (const f of ["client/src/pages/usip/Leads.tsx"]) {
      const s = read(f);
      expect(s, f).toMatch(/type="checkbox"[\s\S]{0,120}aria-label=\{`Select \$\{\w\.firstName\} \$\{\w\.lastName\}`\}[\s\S]{0,200}onChange=\{\(\) => toggleOne\(\w\.id\)\}/);
      expect(s, f).not.toMatch(/readOnly\s*className="rounded border-gray-300 cursor-pointer"/);
    }
  });
  it("campaign signals and Proposals no longer toggle twice from the box", () => {
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain(`<span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="mt-0.5 shrink-0">`);
    expect(read("client/src/pages/usip/Proposals.tsx")).toMatch(/onCheckedChange=\{\(\) => toggleSelect\(p\.id\)\}/);
  });
});

describe("overlays (R77, G64)", () => {
  it("the call log is the shared Dialog: focus trapped, Escape closes it", () => {
    const s = read("client/src/components/usip/EntityDetail.tsx");
    expect(s).toContain("<Dialog open={callOpen} onOpenChange={setCallOpen}>");
    expect(s).not.toContain('className="fixed inset-0 bg-black/40');
  });
  it("the Help drawer is a named dialog that Escape closes", () => {
    const s = read("client/src/components/usip/HelpDrawer.tsx");
    expect(s).toContain('role="dialog" aria-label="Help Center"');
    expect(s).toMatch(/if \(e\.key === "Escape"\) onClose\(\)/);
  });
  it("the campaign funnel has a keyboard list beside the chart (A64)", () => {
    expect(read("client/src/components/usip/are/StepFunnelSankey.tsx")).toMatch(/<ul aria-label="Where prospects went, box by box" className="sr-only focus-within:not-sr-only/);
  });
});

/* ── contrast ── */
const hex = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v * t + b[i] * (1 - t));
const hsl = (h: number, s: number, l: number) => { s /= 100; l /= 100; const k = (n: number) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return [0, 8, 4].map((n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))); };

describe("text reaches 4.5:1 where axe found it short (G64, A64)", () => {
  it("company initials: white on every palette colour", () => {
    const palette = [...read("client/src/components/usip/company/CompanyLogo.tsx").match(/const PALETTE = \[([\s\S]*?)\];/)![1].matchAll(/"(#[0-9a-f]{6})"/gi)].map((m) => m[1]);
    expect(palette).toHaveLength(12);
    for (const c of palette) expect(ratio(hex(c), [1, 1, 1]), c).toBeGreaterThanOrEqual(4.5);
  });
  it("avatar initials: every hue", () => {
    const l = Number(read("client/src/components/usip/ProspectAvatar.tsx").match(/color: `hsl\(\$\{hue\} 55% (\d+)%\)`/)![1]);
    for (let h = 0; h < 360; h++) expect(ratio(hsl(h, 55, l), hsl(h, 45, 92)), `hue ${h}`).toBeGreaterThanOrEqual(4.5);
  });
  it("campaign chips: each status colour, mixed with the ink, on its own tint", () => {
    const s = read("client/src/pages/usip/ARECampaignDetail.tsx");
    const t = Number(s.match(/color-mix\(in srgb, \$\{c\} (\d+)%, var\(--foreground\)\)/)![1]) / 100;
    const card = hex("#fdfcf9"), ink = hex("#2a3132");
    const colours = [...s.matchAll(/^\s+\w+: "(#[0-9A-F]{6})",$/gm)].map((m) => m[1]);
    expect(colours.length).toBeGreaterThanOrEqual(8);
    for (const c of colours) expect(ratio(mix(hex(c), ink, t), mix(hex(c), card, 0x22 / 255)), c).toBeGreaterThanOrEqual(4.5);
    expect(s).toContain("color: chipText(enrichColor)");
    expect(s).toContain("color: chipText(seqColor)");
  });
  it("the rose theme's primary is dark enough for white text", () => {
    expect(read("client/src/index.css")).toMatch(/\[data-theme="rose"\] \{\n[^\n]*\n  --primary: oklch\(0\.56 0\.19 10\)/);
  });
  it("text on a workspace brand colour is ink or white, whichever reads", () => {
    expect(readableOn("#0b1f4d")).toBe("#ffffff"); // navy: dark-on-dark before
    expect(readableOn("#14b89a")).toBe("#1f2a2b");
    expect(readableOn("#fde047")).toBe("#1f2a2b");
    expect(readableOn("#7c3aed")).toBe("#ffffff");
    expect(read("client/src/components/usip/WorkspaceBrandingSync.tsx")).toContain("root.style.setProperty(p, readableOn(brand!))");
  });
});

describe("public pages and the shell (L13, G70, X5.6)", () => {
  it("every public page has a heading and sets its title", () => {
    for (const f of ["pages/ChatPage.tsx", "pages/PublicForm.tsx", "pages/BookingPage.tsx", "pages/MeetingPickPage.tsx", "pages/LandingPage.tsx", "pages/ProposalPortal.tsx", "pages/ResetPassword.tsx", "pages/InviteAccept.tsx", "pages/JoinViaLink.tsx", "pages/NotFound.tsx"]) {
      const s = read(`client/src/${f}`);
      expect(s, f).toMatch(/usePageTitle\(/);
      expect(s, f).toMatch(/<h1|role="heading" aria-level=\{1\}/);
    }
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/usePageTitle\(mode === "signup" \? "Create account"/);
    expect(app).toContain('<h1 className="text-3xl font-bold tracking-tight text-white">Velocity</h1>');
  });
  it("every app page's title is its Shell title", () => {
    expect(read("client/src/components/usip/Shell.tsx")).toMatch(/export function Shell\(\{ children, title, actions \}[^\n]*\n  const \[location\] = useLocation\(\);\n  usePageTitle\(title\);/);
  });
  it("the chat transcript is announced", () => {
    expect(read("client/src/pages/ChatPage.tsx")).toContain('role="log" aria-live="polite" aria-label="Conversation"');
  });
  it("pinch zoom works, and show/hide password takes focus", () => {
    expect(read("client/index.html")).not.toContain("maximum-scale");
    for (const f of ["client/src/App.tsx", "client/src/pages/InviteAccept.tsx", "client/src/pages/JoinViaLink.tsx", "client/src/pages/ResetPassword.tsx", "client/src/components/usip/settings/GuidedMailboxSetup.tsx"]) {
      expect(read(f), f).not.toContain("tabIndex={-1}");
    }
  });
});

describe("the Settings workspace switcher is a real disclosure (a11y 2026-10-28)", () => {
  // It is hand-rolled, not a Radix menu, so the semantics Radix supplies for
  // free are written out by hand and nothing but this test keeps them there.
  // Part 4 named the trigger ("Switch workspace") but left it mute about the
  // popup. Same attribute pair as Shell's AdminSettingsMenu, same keydown
  // shape as ChatLauncher. These are source pins, not behaviour: there is no
  // jsdom and no testing-library here, so nothing in this suite can press
  // Escape or read a computed accessible name. The behaviour belongs to a
  // browser and is checked against the running app.
  const switcher = () => {
    const s = read("client/src/pages/usip/SettingsHub.tsx");
    const from = s.indexOf("function SettingsWorkspaceSwitcher");
    const to = s.indexOf("{open && (", from);
    expect(from, "SettingsWorkspaceSwitcher").toBeGreaterThan(-1);
    expect(to, "the switcher's panel").toBeGreaterThan(from);
    return s.slice(from, to);
  };

  it("the trigger says it opens a popup, and says whether it is open", () => {
    const t = switcher();
    expect(t).toContain('aria-haspopup="menu"');
    // Bound to the state, not a constant: a hardcoded value is worse than none.
    expect(t).toContain("aria-expanded={open}");
  });

  it("Escape closes the menu and puts focus back on the trigger", () => {
    const t = switcher();
    // Positions, not a regex: a character class written through a shell
    // heredoc loses a backslash level and then matches nothing at all, which
    // is how a check here went blind once (2026-10-27).
    const guard = t.indexOf('if (e.key !== "Escape") return;');
    const close = t.indexOf("setOpen(false);", guard);
    const refocus = t.indexOf("triggerRef.current?.focus();", close);
    expect(guard, "the Escape guard").toBeGreaterThan(-1);
    expect(close, "Escape closes the menu").toBeGreaterThan(guard);
    expect(refocus, "focus goes back to the trigger").toBeGreaterThan(close);
    expect(t).toContain('window.addEventListener("keydown", onKey)');
    // Listener removed when it closes, or every open leaves one behind.
    expect(t).toContain('window.removeEventListener("keydown", onKey)');
    // The focus call needs something to focus.
    expect(t).toContain("ref={triggerRef}");
  });
});
