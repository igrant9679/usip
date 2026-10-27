/**
 * Streamdown, loaded when it first renders (audit 2026-10-20, Phase 4, X2.4).
 *
 * The Markdown renderer brings its maths, diagram and code-highlighting
 * libraries with it, about 860 KB, and Calendar and the public proposal page
 * downloaded all of it to show a few paragraphs. Until it arrives the text
 * shows as it is, line breaks kept, so nothing is hidden while it loads.
 */
import { Suspense } from "react";
import { lazyChunk } from "@/lib/lazyChunk";

const Renderer = lazyChunk(() => import("streamdown").then((m) => ({ default: m.Streamdown })));

export function Streamdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap">{children}</div>}>
      <Renderer>{children}</Renderer>
    </Suspense>
  );
}
