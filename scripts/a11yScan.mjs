/**
 * Static accessibility check over client/src (audit 2026-10-20, X5.1–X5.3).
 *
 * Reads every .tsx file with the TypeScript parser and reports:
 *
 *   button-name   a button whose only content is icons, with no aria-label,
 *                 aria-labelledby or title — a screen reader says "button".
 *   control-label an input, textarea, select, switch, checkbox or slider with
 *                 no label: no aria-label/-labelledby, title or placeholder,
 *                 no <label> around it, and no htmlFor naming its id.
 *   click-keyboard a div, span, row, cell, list item, badge or card that
 *                 does something on click but cannot be reached or used from
 *                 the keyboard (no onKeyDown, or no role and tabIndex).
 *   tab-role      a row of buttons from .map() that switch a tab or view,
 *                 without the tab pattern (lib/tabs.ts).
 *   hover-only    a control hidden until the mouse is over its row, with no
 *                 focus variant to show it to the keyboard.
 *
 * It errs towards silence: anything it cannot read (a spread of props, a
 * variable child) counts as named. `node scripts/a11yScan.mjs` prints every
 * finding; the test (server/phase4A11y.test.ts) requires none.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const BUTTONS = new Set(["button", "Button", "DropdownMenuTrigger", "PopoverTrigger", "DialogTrigger", "SheetTrigger", "CollapsibleTrigger", "TooltipTrigger", "AlertDialogTrigger", "ToggleGroupItem", "Toggle"]);
// Triggers render a button only without asChild; with it, the child is checked.
const TRIGGERS = new Set(["DropdownMenuTrigger", "PopoverTrigger", "DialogTrigger", "SheetTrigger", "CollapsibleTrigger", "TooltipTrigger", "AlertDialogTrigger"]);
const CONTROLS = new Set(["input", "Input", "textarea", "Textarea", "select", "Switch", "Checkbox", "Slider"]);
const NOT_A_FIELD = new Set(["hidden", "submit", "button", "reset", "image", "file"]);
const CLICKABLE = new Set(["div", "span", "li", "tr", "td", "p", "img", "section", "article", "Card", "TableRow", "TableCell", "CardContent", "CardHeader", "Badge"]);
const NAMING = ["aria-label", "aria-labelledby", "title"];

function attrs(el) {
  const out = new Map();
  let spread = false;
  for (const p of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(p)) { spread = true; continue; }
    out.set(p.name.getText(), p.initializer ?? null);
  }
  return { out, spread };
}
const attrText = (init) => {
  if (!init) return "true";
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) return init.expression.getText();
  return init.getText();
};
const nonEmpty = (a, name) => a.out.has(name) && attrText(a.out.get(name)).replace(/^["'`]|["'`]$/g, "").trim() !== "";

function tagOf(node) {
  const el = ts.isJsxElement(node) ? node.openingElement : node;
  return el.tagName.getText();
}

/** Icon components: imported from lucide-react, or named *Icon. */
function iconNames(sf) {
  const names = new Set();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause?.namedBindings) continue;
    const from = s.moduleSpecifier.text;
    if (from !== "lucide-react" && !/icons?$/i.test(from)) continue;
    const nb = s.importClause.namedBindings;
    if (ts.isNamedImports(nb)) for (const e of nb.elements) names.add(e.name.text);
  }
  return names;
}

function makeChecker(sf) {
  const icons = iconNames(sf);
  const isIcon = (tag) => icons.has(tag) || /Icon$/.test(tag) || tag === "svg";
  // Does this child render readable text? "maybe" counts as yes.
  function text(node) {
    if (!node) return false;
    // "×", "✕", "+", "…" alone are read as symbols, not as what the button does
    if (ts.isJsxText(node)) return /[\p{L}\p{N}]/u.test(node.text);
    if (ts.isJsxExpression(node)) return node.expression ? exprText(node.expression) : false;
    if (ts.isJsxFragment(node)) return node.children.some(text);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagOf(node);
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const a = attrs(opening);
      if (NAMING.some((n) => nonEmpty(a, n)) && tag !== "svg") return true;
      if (tag === "img") return nonEmpty(a, "alt");
      if (isIcon(tag)) return false;
      if (ts.isJsxSelfClosingElement(node)) return !/^[a-z]/.test(tag); // <Avatar/>, <Kbd/>: can't tell
      return node.children.some(text);
    }
    return true;
  }
  function exprText(e) {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isConditionalExpression(e)) return exprText(e.whenTrue) || exprText(e.whenFalse);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      return e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? exprText(e.right) : exprText(e.left) || exprText(e.right);
    }
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return text(e);
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(e) && e.text === "undefined")) return false;
    return true; // a string, a variable, a call: assume it reads
  }
  return { text, isIcon };
}

export function scanFile(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { text } = makeChecker(sf);
  const findings = [];
  // ids that some htmlFor in this file points at (compared as source text)
  const htmlFor = new Set();
  const collect = (n) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === "htmlFor") htmlFor.add(attrText(n.initializer));
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // Field wrappers in this file that name the shared controls under them
  // through FieldLabelContext (client/src/components/ui/field-label.tsx).
  const labelling = new Set();
  // Components defined here are checked where they render their button,
  // not where they are used (a local Toggle is not Radix's).
  const local = new Set();
  // wouter's <Switch> is the router, not a toggle.
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.moduleSpecifier.text === "wouter" && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
      for (const e of s.importClause.namedBindings.elements) local.add(e.name.text);
    }
  }
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) local.add(s.name.text);
    if (ts.isFunctionDeclaration(s) && s.name && s.getText().includes("<FieldLabelContext.Provider")) labelling.add(s.name.text);
  }
  // Returned straight from a .map() callback.
  const mapped = (n) => {
    let p = n.parent;
    while (p && ts.isParenthesizedExpression(p)) p = p.parent;
    return !!p && (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isCallExpression(p.parent) && /\.map$/.test(p.parent.expression.getText());
  };
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const report = (rule, n, tag) => findings.push({ rule, file, line: line(n), tag });

  const walk = (n, inLabel, inField = false) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = opening.tagName.getText();
      const a = attrs(opening);
      if (BUTTONS.has(tag) && !local.has(tag) && !a.spread && !(TRIGGERS.has(tag) && a.out.has("asChild")) && !(tag === "Button" && a.out.has("asChild"))) {
        const named = NAMING.some((k) => nonEmpty(a, k)) || (ts.isJsxElement(n) && n.children.some(text)) || a.out.has("children");
        if (!named) report("button-name", n, tag);
      }
      // A strip of buttons from .map() that switch a tab or view is a tab list.
      if ((tag === "button" || tag === "Button") && !a.spread && a.out.has("onClick")
        && /^\(\)\s*=>\s*set\w*(Tab|View)\(/.test(attrText(a.out.get("onClick"))) && mapped(n)) {
        report("tab-role", n, tag);
      }
      if (CONTROLS.has(tag) && !local.has(tag) && !a.spread) {
        const type = a.out.has("type") ? attrText(a.out.get("type")) : "";
        const field = !NOT_A_FIELD.has(type);
        const named = NAMING.some((k) => nonEmpty(a, k))
          || inLabel
          || (inField && /^[A-Z]/.test(tag))
          || (a.out.has("id") && htmlFor.has(attrText(a.out.get("id"))));
        if (field && !named) report("control-label", n, tag);
      }
      // A backdrop that closes a drawer is aria-hidden: Escape closes it instead.
      const hidden = a.out.has("aria-hidden") && attrText(a.out.get("aria-hidden")) === "true";
      if (CLICKABLE.has(tag) && a.out.has("onClick") && !a.spread && !hidden) {
        const handler = attrText(a.out.get("onClick"));
        const onlyStops = /^\(?\w*\)?\s*=>\s*\{?\s*\w+\.stopPropagation\(\);?\s*\}?$/.test(handler.trim());
        const keyboard = a.out.has("onKeyDown") && a.out.has("tabIndex") && a.out.has("role");
        if (!onlyStops && !keyboard) report("click-keyboard", n, tag);
      }
      // Shown on hover only: a keyboard user tabs onto an invisible control.
      const cls = a.out.has("className") ? attrText(a.out.get("className")) : "";
      if (/group-hover:opacity-100/.test(cls) && /\bopacity-0\b/.test(cls) && !/(group-)?focus(-within|-visible)?:opacity-100/.test(cls)) report("hover-only", n, tag);
      const label = inLabel || tag === "label" || tag === "Label";
      const field = inField || labelling.has(tag);
      if (ts.isJsxElement(n)) { for (const c of n.children) walk(c, label, field); for (const p of opening.attributes.properties) walk(p, inLabel, inField); return; }
      for (const p of opening.attributes.properties) walk(p, inLabel, inField);
      return;
    }
    ts.forEachChild(n, (c) => walk(c, inLabel, inField));
  };
  walk(sf, false);
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

if (/a11yScan\.mjs$/.test(process.argv[1] ?? "")) {
  const root = process.argv[2] ?? process.cwd();
  const all = scan(root);
  const byRule = {};
  for (const f of all) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  for (const f of all) console.log(`${f.rule.padEnd(15)} ${f.file}:${f.line} <${f.tag}>`);
  console.log(JSON.stringify(byRule));
}
