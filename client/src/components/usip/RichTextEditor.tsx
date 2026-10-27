/**
 * RichTextEditor — the shared email editor (RichTextEditorImpl.tsx), loaded
 * when it first mounts (audit 2026-10-20, Phase 4, X2.4).
 *
 * Tiptap and ProseMirror are 460 KB. Thirteen screens mount the editor, most
 * of them inside a dialog, drawer or tab a visit may never open, and every one
 * of them downloaded it with the page. Same props as before; while the chunk
 * arrives, an empty box of the editor's height stands in.
 */
import { Suspense } from "react";
import { cn } from "@/lib/utils";
import { lazyChunk } from "@/lib/lazyChunk";
import type { RichTextEditorProps } from "./RichTextEditorImpl";

export type { RichTextEditorProps };

const Editor = lazyChunk(() => import("./RichTextEditorImpl").then((m) => ({ default: m.RichTextEditor })));

export function RichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          aria-label="Loading editor"
          className={cn("rounded-md border bg-muted/20", props.className)}
          style={{ minHeight: props.minHeight ?? "200px" }}
        />
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

export default RichTextEditor;
