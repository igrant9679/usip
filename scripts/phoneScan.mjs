/**
 * Static phone-layout check over client/src (audit 2026-10-20, X5.4, X5.5,
 * U8). A phone is 375 px wide; the audit found fixed rails and panels that
 * take most of it, and boxes wider than it that push the page sideways.
 *
 * Reads every .tsx file with the TypeScript parser and reports:
 *
 *   fixed-rail  a side rail or panel (an <aside>, or a box with a side
 *               border) that does not shrink and is 240 px or wider, at every
 *               screen size. Beside a list on a phone it leaves the list a
 *               sliver. Fix: ResponsiveRail (a sheet below md), or show it
 *               from a breakpoint only ("hidden md:flex", "md:w-72").
 *   wide-box    a box wider than a phone (over 359 px) at every screen size,
 *               with no max-width to hold it in. A popover or drawer this
 *               wide runs off the screen. Fix: "w-full sm:w-[380px]", or a
 *               cap such as "max-w-[calc(100vw-1rem)]". Dialogs cap
 *               themselves.
 *   clipped-table a <table> straight inside a box that hides its overflow:
 *               on a phone the right-hand columns are cut off and cannot be
 *               reached. Fix: overflow-x-auto on the box (or the shared
 *               <Table>, which scrolls itself).
 *
 * Widths given only from a breakpoint up (sm:, md:, …) are for larger
 * screens and pass. ResponsiveRail's className is its md-and-up look, so it
 * passes too. min-w on a table inside a scroller is that table's business,
 * so min-w is not read. `node scripts/phoneScan.mjs` prints every finding;
 * the test (server/phase4Phone.test.ts) requires none.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const PHONE = 375;
// These cap their own width (max-w-[calc(100%-2rem)] in components/ui).
const CAPPED = new Set(["DialogContent", "AlertDialogContent"]);
const RAIL_MIN = 240;
const WIDE = PHONE - 16;

/**
 * Tokens of a className expression, as written (string, template, cn()).
 * Every check below matches a whole token ("w-72", "hidden", "max-w-…"), so a
 * token with a variant ("md:w-72", "sm:max-w-md", "[&_td]:w-96") never counts:
 * it applies from a breakpoint up, or to something else.
 */
function tokens(text) {
  return text.split(/[\s"'`{}(),?|&!=<>+]+/).filter(Boolean);
}

/** Pixel width of a w-* token, or null. */
export function widthPx(tok) {
  let m = tok.match(/^w-(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 4;
  m = tok.match(/^w-\[(\d+(?:\.\d+)?)px\]$/);
  if (m) return Number(m[1]);
  m = tok.match(/^w-\[(\d+(?:\.\d+)?)rem\]$/);
  if (m) return Number(m[1]) * 16;
  return null;
}

function classText(opening) {
  for (const p of opening.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === "className" && p.initializer) {
      const init = p.initializer;
      if (ts.isStringLiteral(init)) return init.text;
      if (ts.isJsxExpression(init) && init.expression) return init.expression.getText();
    }
  }
  return "";
}

export function scanFile(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  // parent: the base classes of the nearest enclosing JSX element.
  const walk = (n, parent) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = opening.tagName.getText();
      const all = tokens(classText(opening));
      // components/ui's <Table> scrolls itself; a bare <table> needs a scroller.
      if (tag === "table" && parent.includes("overflow-hidden") && !parent.some((t) => /^overflow-(x-)?(auto|scroll)$/.test(t))) {
        findings.push({ rule: "clipped-table", file, line: line(n), tag, width: 0 });
      }
      if (tag !== "ResponsiveRail") {
        const widths = all.map(widthPx).filter((w) => w != null);
        const widest = widths.length ? Math.max(...widths) : 0;
        const hiddenOnPhone = all.includes("hidden");
        const capped = CAPPED.has(tag) || all.some((t) => /^max-w-/.test(t));
        // Out of the flow (an off-canvas drawer, an overlay): it takes no room
        // from the page beside it, so only its width is read.
        const overlay = all.includes("fixed") || all.includes("absolute");
        const rigid = !overlay && (all.includes("shrink-0") || all.includes("flex-shrink-0"));
        const side = tag === "aside" || all.includes("border-r") || all.includes("border-l");
        if (!hiddenOnPhone && rigid && side && widest >= RAIL_MIN) findings.push({ rule: "fixed-rail", file, line: line(n), tag, width: widest });
        else if (!hiddenOnPhone && !capped && widest > WIDE) findings.push({ rule: "wide-box", file, line: line(n), tag, width: widest });
      }
      ts.forEachChild(n, (c) => walk(c, all));
      return;
    }
    ts.forEachChild(n, (c) => walk(c, parent));
  };
  walk(sf, []);
  return findings;
}

export function scan(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".tsx")) out.push(...scanFile(path.relative(root, p).replace(/\\/g, "/"), fs.readFileSync(p, "utf8")));
    }
  };
  visit(path.join(root, "client", "src"));
  return out;
}

if (/phoneScan\.mjs$/.test(process.argv[1] ?? "")) {
  const root = process.argv[2] ?? process.cwd();
  const all = scan(root);
  const byRule = {};
  for (const f of all) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  for (const f of all) console.log(`${f.rule.padEnd(11)} ${f.file}:${f.line} <${f.tag}> ${f.width}px`);
  console.log(JSON.stringify(byRule));
}
