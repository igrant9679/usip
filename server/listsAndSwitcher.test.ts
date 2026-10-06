/**
 * Owner, 2026-10-06: "when I select a different workspace to switch the
 * dropdown stays open even after the switch. In addition, there is no way to
 * rename a List or assign a name to a List during its creation."
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

describe("the workspace switcher", () => {
  const shell = read("client/src/components/usip/Shell.tsx");

  it("is a Popover, so an outside click or Esc closes it", () => {
    expect(shell).toContain("<Popover open={wsOpen} onOpenChange={setWsOpen}>");
    // The hand-rolled menu it replaced only closed on a route change.
    expect(shell).not.toContain("{wsOpen && (");
  });

  it("closes as soon as a workspace is picked, and picking the current one does not reload everything", () => {
    expect(shell).toContain("onClick={() => { setWsOpen(false); if (current?.id !== w.id) switchTo(w.id); }}");
  });
});

describe("naming and renaming lists", () => {
  const router = read("server/routers/recordLists.ts");

  it("a list can be renamed, in its own workspace only, and never to a blank name", () => {
    const update = router.slice(router.indexOf("  update: workspaceProcedure"), router.indexOf("  delete: workspaceProcedure"));
    expect(update).toContain('name: z.string().trim().min(1, "Give the list a name").max(200).optional(),');
    expect(update).toContain(".where(and(eq(recordLists.id, input.id), eq(recordLists.workspaceId, ctx.workspace.id)));");
    expect(update).toContain('throw new TRPCError({ code: "NOT_FOUND"');
  });

  it("a new list needs a real name (spaces alone are refused)", () => {
    const create = router.slice(router.indexOf("  create: workspaceProcedure"), router.indexOf("  update: workspaceProcedure"));
    expect(create).toContain('name: z.string().trim().min(1, "Give the list a name").max(200),');
  });

  it("Add to list → Create new list asks for the name, then adds the selection to it", () => {
    const menu = read("client/src/components/usip/people/SelectionToolbar.tsx");
    expect(menu).not.toContain('q.trim() || "New list"');
    expect(menu).toContain('placeholder="Name the new list"');
    expect(menu).toContain('const r = await createList.mutateAsync({ name, entityType: "people" });');
    expect(menu).toContain('await addMembers.mutateAsync({ listId: r.id, recordType: "prospect", recordIds: selectedIds });');
  });

  it("Rename is on the Lists page menu and on the list's own page", () => {
    const lists = read("client/src/pages/usip/Lists.tsx");
    expect(lists).toContain('<DropdownMenuItem onClick={onRename}><Pencil className="size-4 mr-2" /> Rename</DropdownMenuItem>');
    expect(lists).toContain("renameMut.mutate({ id: renaming.id, name: renameTo.trim() });");
    const detail = read("client/src/pages/usip/ListDetail.tsx");
    expect(detail).toContain('aria-label="Rename list"');
    expect(detail).toContain("renameMut.mutate({ id: list.id, name });");
  });
});
