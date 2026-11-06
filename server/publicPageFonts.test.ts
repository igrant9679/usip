/**
 * A public page loads nothing from Google Fonts (audit L14, X2.7).
 *
 * index.html linked Inter and JetBrains Mono from fonts.googleapis.com on
 * every page, so a visitor opening a booking link, a form, a landing page, a
 * proposal, a meeting pick or a chat sent their IP address to Google. No
 * self-hosted font package was installable offline, so public pages use the
 * system stack --font-sans already falls back to; the signed-in app keeps Inter.
 *
 * The head script is run here in a sandbox with each kind of path.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const html = read("client/index.html");
const head = html.slice(0, html.indexOf("</head>"));

/** The hrefs the head script adds for a page at `path`. */
function linksFor(path: string): string[] {
  const scripts = Array.from(head.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]!);
  const added: string[] = [];
  const document = {
    head: { appendChild: (l: { href: string }) => added.push(l.href) },
    createElement: () => ({ rel: "", href: "", crossOrigin: null as string | null }),
  };
  for (const s of scripts) vm.runInNewContext(s, { location: { pathname: path }, document });
  return added;
}

describe("Google Fonts stay off the public pages", () => {
  it("no static link to Google in the head", () => {
    expect(head).not.toMatch(/<link[^>]+fonts\.(googleapis|gstatic)\.com/);
  });

  it.each(["/b/ann-2", "/f/abc123", "/l/spring-offer", "/p/tok", "/m/tok", "/c/support"])("%s loads none", (path) => {
    expect(linksFor(path)).toEqual([]);
  });

  it.each(["/", "/v2/home", "/proposals/4", "/people", "/b", "/mindmaps/3", "/v2/landing-pages"])("the app at %s still loads Inter", (path) => {
    const links = linksFor(path);
    expect(links.some((h) => h.startsWith("https://fonts.googleapis.com/css2?family=Inter"))).toBe(true);
  });

  it("the proposal print view drops the Outfit link its CSS never used", () => {
    const s = read("client/src/pages/usip/proposalExports/buildPrintHTML.ts");
    expect(s).not.toContain("fonts.googleapis.com");
    expect(s).not.toContain("Outfit");
  });
});
