/**
 * Logo pipeline — the invariants that make "official, clean, consistent"
 * true rather than aspirational:
 *
 *  - discovery ranks the company's own manifest/apple-touch assets above
 *    generic icons and the favicon service dead last;
 *  - background-to-transparency triggers ONLY on a solid background —
 *    photos and gradients must pass through untouched;
 *  - output is a consistently sized square PNG data URI inside the same
 *    inline budget avatars use, with aspect ratio preserved by containment;
 *  - relative hrefs resolve against the right origin and http(-only) or
 *    garbage URLs are refused.
 */
import { describe, it, expect } from "vitest";
import Jimp from "jimp";
import {
  LOGO_CANVAS,
  detectSolidBackground,
  extractIconLinks,
  extractManifestHref,
  processLogoBytes,
  resolveUrl,
} from "./company/logoPipeline";

describe("extractIconLinks / extractManifestHref", () => {
  const HTML = `
    <html><head>
      <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
      <link rel="icon" href="/favicon.ico">
      <link rel="manifest" href="/site.webmanifest">
      <link rel="stylesheet" href="/styles.css">
    </head></html>`;

  it("finds png/apple-touch icons and skips .ico and stylesheets", () => {
    const links = extractIconLinks(HTML, "https://acme.com");
    expect(links.map((l) => l.kind).sort()).toEqual(["apple_touch", "icon_png"]);
    expect(links.find((l) => l.kind === "apple_touch")?.url).toBe("https://acme.com/apple-touch-icon.png");
    expect(links.find((l) => l.kind === "apple_touch")?.size).toBe(180);
  });

  it("resolves the manifest href", () => {
    expect(extractManifestHref(HTML, "https://acme.com")).toBe("https://acme.com/site.webmanifest");
  });

  it("resolveUrl refuses non-https and garbage", () => {
    expect(resolveUrl("/icon.png", "https://acme.com")).toBe("https://acme.com/icon.png");
    expect(resolveUrl("http://acme.com/icon.png", "https://acme.com")).toBeNull();
    expect(resolveUrl("::::", "not a url")).toBeNull();
  });
});

describe("detectSolidBackground", () => {
  it("detects a uniform opaque background", async () => {
    const img = new Jimp(64, 64, 0xffffffff); // solid white
    expect(detectSolidBackground(img)).toBe(0xffffffff);
  });

  it("refuses when corners disagree — gradients and photos pass through", async () => {
    const img = new Jimp(64, 64, 0xffffffff);
    img.setPixelColor(0xff0000ff, 0, 0); // one red corner
    expect(detectSolidBackground(img)).toBeNull();
  });

  it("refuses when corners are already transparent", async () => {
    const img = new Jimp(64, 64, 0x00000000);
    expect(detectSolidBackground(img)).toBeNull();
  });
});

describe("processLogoBytes", () => {
  /** A WIDE red mark (2:1) on a solid white background — after background
   *  removal and cropping, containment must letterbox it, proving both the
   *  transparency conversion and the preserved aspect ratio. */
  async function markOnWhite(): Promise<Buffer> {
    const img = new Jimp(200, 100, 0xffffffff);
    for (let x = 60; x < 140; x++) for (let y = 30; y < 70; y++) img.setPixelColor(0xff0000ff, x, y);
    return img.getBufferAsync(Jimp.MIME_PNG);
  }

  it("emits a consistent square PNG data URI with transparent background and preserved aspect", async () => {
    const uri = await processLogoBytes(await markOnWhite());
    expect(uri).toMatch(/^data:image\/png;base64,/);
    const out = await Jimp.read(Buffer.from(uri!.split(",")[1], "base64"));
    expect(out.getWidth()).toBe(LOGO_CANVAS);
    expect(out.getHeight()).toBe(LOGO_CANVAS);
    // The 2:1 mark was contained, not stretched: the letterboxed top-left
    // corner is transparent (white background became alpha 0, and the wide
    // mark cannot cover the square canvas's top edge).
    expect(Jimp.intToRGBA(out.getPixelColor(0, 0)).a).toBe(0);
    // The mark survived: the canvas centre is opaque red.
    const mid = Jimp.intToRGBA(out.getPixelColor(LOGO_CANVAS / 2, LOGO_CANVAS / 2));
    expect(mid.a).toBeGreaterThan(200);
    expect(mid.r).toBeGreaterThan(200);
  });

  it("refuses tiny favicon-sized noise", async () => {
    const img = new Jimp(16, 16, 0xff0000ff);
    expect(await processLogoBytes(await img.getBufferAsync(Jimp.MIME_PNG))).toBeNull();
  });

  it("refuses images that vanish after background removal", async () => {
    const img = new Jimp(64, 64, 0xffffffff); // pure background, no mark
    expect(await processLogoBytes(await img.getBufferAsync(Jimp.MIME_PNG))).toBeNull();
  });
});
