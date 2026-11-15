/**
 * A dialog's contents stay inside the dialog (owner screenshot, 2026-11-14:
 * AI research settings, where the model dropdown, the description and the
 * buttons ran about 35px past the right edge).
 *
 * The cause was in the shared components, not that dialog. DialogContent is a
 * one-column grid, and a grid column is never narrower than its widest item
 * unless told it may be. One long unbreakable item (a dropdown showing
 * "Claude Opus 5.5 ($4 in / $20 out). Most thorough. The default.") widened
 * the column, and every row in the dialog followed it out. Three classes
 * hold the line; a local copy of the layout with the live stylesheet showed
 * the overflow without them and none with them:
 *
 *   - the dialog's column may shrink to the dialog:  grid-cols-[minmax(0,1fr)]
 *   - a dropdown is never wider than its container:  max-w-full
 *   - its value may shrink, so it clips before the chevron:  min-w-0
 *
 * Source pins, because the suite has no browser. If a class is renamed,
 * re-check the layout at a 640px-wide window before changing the pin.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

/** The class string that carries `marker`, so a pin reads one element's classes and not the whole file. */
function classesWith(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `"${marker}" not found`).toBeGreaterThan(-1);
  const start = src.lastIndexOf('"', at);
  const end = src.indexOf('"', at);
  return src.slice(start + 1, end);
}

describe("a dialog's contents stay inside it", () => {
  it("the dialog and the alert dialog let their one column shrink to their width", () => {
    for (const f of ["client/src/components/ui/dialog.tsx", "client/src/components/ui/alert-dialog.tsx"]) {
      const cls = classesWith(read(f), "max-w-[calc(100%-2rem)]").split(/\s+/);
      expect(cls, f).toContain("grid");
      expect(cls, f).toContain("grid-cols-[minmax(0,1fr)]");
    }
  });

  it("a dropdown is never wider than what holds it, and its value clips first", () => {
    const cls = classesWith(read("client/src/components/ui/select.tsx"), "w-fit").split(/\s+/);
    expect(cls).toContain("max-w-full");
    expect(cls).toContain("*:data-[slot=select-value]:min-w-0");
  });

  // Owner ask 2026-11-15: a label that is cut short ends in "…". The value used to be a flex box
  // (for options that pair an icon with text; the app has none), and a flex box clips its text
  // with no ellipsis whatever text-overflow says. As a block it truncates properly. Seen on the
  // live dialog at a 375px-wide window before the change.
  it("a dropdown value that is cut short ends in an ellipsis", () => {
    const cls = classesWith(read("client/src/components/ui/select.tsx"), "w-fit").split(/\s+/);
    expect(cls).toContain("*:data-[slot=select-value]:block");
    expect(cls).toContain("*:data-[slot=select-value]:truncate");
    expect(cls).not.toContain("*:data-[slot=select-value]:flex");
    expect(cls).not.toContain("*:data-[slot=select-value]:line-clamp-1");
  });

  it("the AI research settings dropdown fills the dialog, which is wide enough for its longest label", () => {
    const src = read("client/src/components/usip/research/ResearchRuns.tsx");
    const from = src.indexOf("<DialogTitle>AI research settings</DialogTitle>");
    expect(from).toBeGreaterThan(-1);
    const head = src.slice(src.lastIndexOf("<DialogContent", from), from);
    expect(head).toContain('className="max-w-[calc(100%-2rem)] sm:max-w-lg"');
    const body = src.slice(from, src.indexOf("</DialogContent>", from));
    expect(body).toContain('<SelectTrigger className="w-full"><SelectValue placeholder="Choose a model" /></SelectTrigger>');
  });
});
