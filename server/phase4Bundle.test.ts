/**
 * Phase 4 of the 2026-10-20 audit, part 1 — the first download (X2.4).
 *
 *   App.tsx loads every page on demand, so the sign-in page downloads the
 *   shell alone (10 MB → 0.5 MB) · the rich-text editor and the Markdown
 *   renderer load when they first render, not with the 13 screens that mount
 *   them · a chunk an older deploy left behind reloads the tab once instead of
 *   failing · CI builds and measures every route against the budget
 *   (scripts/bundleBudget.mjs: entry 600 KB, any first visit 1.5 MB).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ENTRY_MAX, ROUTE_MAX, measureBuild, overBudget } from "../scripts/bundleBudget.mjs";
import { reloadForNewBuild, withReload } from "../client/src/lib/lazyChunk";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Every .ts/.tsx file under client/src. */
function clientFiles(dir = join(ROOT, "client", "src")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...clientFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("the budget is measured from the built files", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  /** A build: index.html → entry; the entry imports vendor and loads two pages on demand. */
  function fakeBuild(sizes: { entry: number; vendor: number; pageA: number; shared: number; pageB: number }) {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(dir, "assets"));
    const file = (name: string, body: string, size: number) =>
      writeFileSync(join(dir, "assets", name), body + " ".repeat(Math.max(0, size - Buffer.byteLength(body))));
    writeFileSync(join(dir, "index.html"), `<html><head><script type="module" crossorigin src="/assets/index-E.js"></script></head></html>`);
    file("index-E.js", `import{r as a}from"./vendor-V.js";const A=()=>import("./PageA-1.js"),B=()=>import("./PageB-2.js");`, sizes.entry);
    file("vendor-V.js", `export const r=1;`, sizes.vendor);
    file("PageA-1.js", `import{s}from"./shared-S.js";import"./vendor-V.js";export default s;`, sizes.pageA);
    file("shared-S.js", `export const s=2;`, sizes.shared);
    file("PageB-2.js", `export default 3;`, sizes.pageB);
    file("unrelated-U.js", `export default 4;`, 5_000_000); // never imported: not counted
    return dir;
  }

  it("counts the entry with its static imports, and each page with the entry", () => {
    const r = measureBuild(fakeBuild({ entry: 1000, vendor: 2000, pageA: 300, shared: 40, pageB: 20 }));
    expect(r.entry).toBe("assets/index-E.js");
    expect(r.entryBytes).toBe(3000);
    expect(r.routes).toEqual([
      { chunk: "assets/PageA-1.js", bytes: 3340 }, // entry + vendor (once) + page + shared
      { chunk: "assets/PageB-2.js", bytes: 3020 },
    ]);
    expect(overBudget(r)).toEqual([]);
  });

  it("names whatever is over", () => {
    const r = measureBuild(fakeBuild({ entry: 1000, vendor: 2000, pageA: 300, shared: 40, pageB: 20 }));
    expect(overBudget(r, { entryMax: 2999, routeMax: 3339 })).toEqual([
      "entry assets/index-E.js: 3 KB > 3 KB",
      "route assets/PageA-1.js: 3 KB > 3 KB",
    ]);
    expect(overBudget(r, { entryMax: 3000, routeMax: 3340 })).toEqual([]);
  });

  it("budgets are the gate's: 600 KB for the sign-in page, 1.5 MB for any first visit", () => {
    expect(ENTRY_MAX).toBe(600 * 1024);
    expect(ROUTE_MAX).toBe(1.5 * 1024 * 1024);
  });

  it("CI builds and runs it", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: pnpm exec vite build && node scripts/bundleBudget.mjs dist/public");
    const step = ci.slice(ci.indexOf("name: Build + bundle budget"));
    expect(step).not.toContain("continue-on-error");
    // The job runs with NODE_ENV=test, which builds React's development bundle.
    expect(step).toMatch(/env:\s*\n\s*NODE_ENV: production/);
  });
});

describe("pages load on demand", () => {
  const app = read("client/src/App.tsx");

  it("App.tsx imports no page up front but the 404", () => {
    const eager = [...app.matchAll(/^import .* from "@\/pages\/([^"]+)";$/gm)].map((m) => m[1]);
    expect(eager).toEqual(["NotFound"]);
    expect((app.match(/= lazyChunk\(\(\) => import\("@\/pages\//g) ?? []).length).toBeGreaterThanOrEqual(110);
  });

  it("every route renders inside one Suspense boundary", () => {
    const router = app.slice(app.indexOf("function Router()"), app.indexOf("function App()"));
    expect(router).toMatch(/<Suspense fallback=\{<PageLoading \/>\}>\s*<Switch>/);
    expect(router).toMatch(/<\/Switch>\s*<\/Suspense>/);
  });

  it("the editor and the Markdown renderer load when they render", () => {
    for (const f of clientFiles()) {
      const rel = f.slice(ROOT.length + 1).replace(/\\/g, "/");
      const src = readFileSync(f, "utf8");
      if (rel !== "client/src/components/usip/RichTextEditor.tsx") {
        expect(src, rel).not.toMatch(/from "[^"]*RichTextEditorImpl"/);
      }
      // AIChatBox is imported by nothing (audit X6.1).
      if (rel !== "client/src/components/usip/LazyStreamdown.tsx" && rel !== "client/src/components/AIChatBox.tsx") {
        expect(src, rel).not.toMatch(/from "streamdown"/);
      }
    }
    expect(read("client/src/components/usip/RichTextEditor.tsx")).toMatch(/lazyChunk\(\(\) => import\("\.\/RichTextEditorImpl"\)/);
    expect(read("client/src/components/usip/LazyStreamdown.tsx")).toMatch(/lazyChunk\(\(\) => import\("streamdown"\)/);
  });
});

describe("a chunk from an older deploy reloads the tab once", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser(storage: Record<string, string> | null) {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    vi.stubGlobal("sessionStorage", storage === null
      ? { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }
      : { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => { storage[k] = v; } });
    return reload;
  }

  it("reloads, then not again within a minute, then again after", () => {
    const reload = stubBrowser({});
    expect(reloadForNewBuild(1_000_000)).toBe(true);
    expect(reloadForNewBuild(1_000_000 + 59_999)).toBe(false);
    expect(reloadForNewBuild(1_000_000 + 60_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when it cannot remember having done so", () => {
    const reload = stubBrowser(null);
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a failed chunk waits for the reload; once reloaded, the failure shows", async () => {
    const failing = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));
    const pending = withReload(failing, () => true)();
    const settled = await Promise.race([pending.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("pending"), 20))]);
    expect(settled).toBe("pending");
    await expect(withReload(failing, () => false)()).rejects.toThrow(/dynamically imported module/);
    await expect(withReload(() => Promise.resolve({ default: 1 }), () => true)()).resolves.toEqual({ default: 1 });
  });
});
