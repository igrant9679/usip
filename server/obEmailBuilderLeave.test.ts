/**
 * Audit 2026-10-20, O46: the Email Builder autosaved every 30 s and its
 * cleanup only cleared the timer, so edits made in the half-minute before
 * leaving were lost; and Archive went on one click.
 *
 * Pinned by reading the builder (the repo pins client screens that need a
 * browser this way): leaving inside the app saves what is unsaved, closing
 * or reloading the tab asks first while something is unsaved, and Archive
 * asks before it archives.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("client/src/pages/usip/EmailBuilder.tsx", "utf8").replace(/\r\n/g, "\n");
const builder = src.slice(src.indexOf("function Builder({ templateId }"), src.indexOf("export default function EmailBuilderPage"));
function block(start: string, end: string): string {
  const a = builder.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = builder.indexOf(end, a + start.length);
  expect(b, `missing after ${start}: ${end}`).toBeGreaterThan(-1);
  return builder.slice(a, b);
}

describe("leaving the builder does not lose the last edits", () => {
  it("the latest values are kept where the unmount can read them", () => {
    expect(builder).toContain("const latestDraft = useRef({ saveState, templateName, subject, blocks });");
    expect(builder).toContain("latestDraft.current = { saveState, templateName, subject, blocks };");
  });

  it("unmounting with unsaved edits saves them, through the client the component does not own", () => {
    const leave = block("useEffect(() => () => {", "}, [templateId]);");
    expect(leave).toContain('if (d.saveState !== "unsaved") return;');
    expect(leave).toContain("utils.client.emailTemplates.save");
    expect(leave).toContain(".mutate({ id: templateId, name: d.templateName, subject: d.subject, designData: d.blocks })");
    expect(leave).toContain(".catch(");
  });

  it("closing or reloading the tab with unsaved edits asks first, and only then", () => {
    const warn = block("const warn = (e: BeforeUnloadEvent) => {", 'return () => window.removeEventListener("beforeunload", warn);');
    expect(warn).toContain('if (latestDraft.current.saveState !== "unsaved") return;');
    expect(warn).toContain("e.preventDefault();");
    expect(warn).toContain('window.addEventListener("beforeunload", warn);');
  });

  it("the 30-second autosave is still there", () => {
    expect(builder).toContain("autosaveTimer.current = setTimeout(() => handleSave(), 30_000);");
  });
});

describe("Archive asks first", () => {
  it("is a confirm, and the only archive call is behind it", () => {
    expect(builder.split("archiveMutation.mutate(").length - 1).toBe(1);
    const btn = block("<ConfirmButton size=\"sm\" variant=\"outline\" className=\"h-7 px-2 text-xs text-destructive", "</ConfirmButton>");
    expect(btn).toContain("onConfirm={() => archiveMutation.mutate({ id: templateId })}");
    expect(btn).toContain('confirmLabel="Archive"');
    expect(builder).not.toContain("onClick={() => archiveMutation.mutate(");
  });
});
