/**
 * Automated company-logo workflow: official assets in, clean consistent
 * images out.
 *
 * Source authority is structural: candidates come from the company's OWN
 * website (web-app manifest icons, apple-touch-icons, high-res PNG icons) —
 * the most official logo assets a company publishes — with Google's favicon
 * service as the last-resort fallback the logo service already permits.
 * Nothing is scraped from access-controlled surfaces.
 *
 * Processing (jimp, pure JS — no native deps to break the deploy):
 *  - validate the bytes are really an image;
 *  - when the image sits on a SOLID background (all four corners agree and
 *    the image has no meaningful transparency), convert that background to
 *    transparency — but only then: photos and gradient art pass through;
 *  - trim uniform margins, then CONTAIN into a square canvas, preserving
 *    aspect ratio, so every logo renders at a consistent size platform-wide;
 *  - emit a PNG data URI under the same 60k-char inline budget the avatar
 *    mirror uses. SVG assets are stored as-is (already scalable + clean).
 */
import Jimp from "jimp";

export const LOGO_CANVAS = 256;
export const MAX_LOGO_DATA_URI_CHARS = 60_000;
const MAX_ASSET_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 10_000;

/* ─── candidate discovery (company's own site first) ─────────────────────── */

export interface LogoCandidate { url: string; kind: "manifest" | "apple_touch" | "icon_png" | "favicon_service"; size: number }

/** Parse <link rel=…> icon candidates out of homepage HTML (CRLF-safe, no DOM). */
export function extractIconLinks(html: string, origin: string): LogoCandidate[] {
  const out: LogoCandidate[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  for (const tag of html.match(linkRe) ?? []) {
    const rel = /rel=["']?([^"'>\s]+(?:\s[^"']*)?)["']?/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /href=["']?([^"'>\s]+)["']?/i.exec(tag)?.[1];
    if (!href) continue;
    const sizes = /sizes=["']?(\d+)x\d+["']?/i.exec(tag)?.[1];
    const size = sizes ? Number(sizes) : 0;
    const abs = resolveUrl(href, origin);
    if (!abs) continue;
    if (rel.includes("apple-touch-icon")) {
      out.push({ url: abs, kind: "apple_touch", size: size || 180 });
    } else if (rel.includes("icon") && /\.(png|svg)(\?|$)/i.test(abs)) {
      out.push({ url: abs, kind: "icon_png", size });
    }
  }
  return out;
}

/** Manifest href from homepage HTML, absolute, or null. */
export function extractManifestHref(html: string, origin: string): string | null {
  const tag = (html.match(/<link\b[^>]*>/gi) ?? []).find((t) => /rel=["']?manifest["']?/i.test(t));
  const href = tag ? /href=["']?([^"'>\s]+)["']?/i.exec(tag)?.[1] : null;
  return href ? resolveUrl(href, origin) : null;
}

export function resolveUrl(href: string, origin: string): string | null {
  try {
    const u = new URL(href, origin);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, accept?: string): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: accept ? { accept } : undefined });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Ordered logo candidates for a domain — most official + highest-res first. */
export async function discoverLogoCandidates(domain: string): Promise<LogoCandidate[]> {
  const origin = `https://${domain}`;
  const out: LogoCandidate[] = [];

  const page = await fetchWithTimeout(origin, "text/html");
  const html = page?.ok ? (await page.text()).slice(0, 400_000) : "";

  if (html) {
    // Web-app manifest icons — the highest-res official assets most sites have.
    const manifestUrl = extractManifestHref(html, origin);
    if (manifestUrl) {
      const mres = await fetchWithTimeout(manifestUrl, "application/json");
      if (mres?.ok) {
        try {
          const manifest = JSON.parse((await mres.text()).slice(0, 100_000)) as { icons?: Array<{ src?: string; sizes?: string; type?: string }> };
          for (const icon of manifest.icons ?? []) {
            if (!icon.src) continue;
            const abs = resolveUrl(icon.src, manifestUrl);
            if (!abs || /\.ico(\?|$)/i.test(abs)) continue;
            const size = Number(/(\d+)x\d+/.exec(icon.sizes ?? "")?.[1] ?? 0);
            out.push({ url: abs, kind: "manifest", size });
          }
        } catch { /* malformed manifest — other candidates remain */ }
      }
    }
    out.push(...extractIconLinks(html, origin));
  }

  // Conventional locations exist on many sites without any <link> tag.
  out.push({ url: `${origin}/apple-touch-icon.png`, kind: "apple_touch", size: 180 });

  // Last resort: the favicon service the logo layer already permits (128px).
  out.push({ url: `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`, kind: "favicon_service", size: 128 });

  // Most official first, then largest.
  const rank: Record<LogoCandidate["kind"], number> = { manifest: 0, apple_touch: 1, icon_png: 2, favicon_service: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.size - a.size);
}

/* ─── raster processing ──────────────────────────────────────────────────── */

/** Do all four corners agree on one opaque color? Returns it, or null. */
export function detectSolidBackground(img: InstanceType<typeof Jimp>): number | null {
  const w = img.getWidth(), h = img.getHeight();
  const corners = [
    img.getPixelColor(0, 0), img.getPixelColor(w - 1, 0),
    img.getPixelColor(0, h - 1), img.getPixelColor(w - 1, h - 1),
  ];
  const rgba = corners.map((c) => Jimp.intToRGBA(c));
  if (rgba.some((c) => c.a < 250)) return null; // already transparent-ish
  const [first] = rgba;
  const near = (a: number, b: number) => Math.abs(a - b) <= 12;
  const agree = rgba.every((c) => near(c.r, first.r) && near(c.g, first.g) && near(c.b, first.b));
  return agree ? corners[0] : null;
}

/** Convert a solid background to transparency, trim margins, contain-resize
 *  to a consistent square, and emit a PNG data URI (or null if oversized). */
export async function processLogoBytes(bytes: Buffer): Promise<string | null> {
  const img = await Jimp.read(bytes);
  if (img.getWidth() < 32 || img.getHeight() < 32) return null; // too small to be a usable logo

  const bg = detectSolidBackground(img);
  if (bg != null) {
    const target = Jimp.intToRGBA(bg);
    const threshold = 24;
    img.scan(0, 0, img.getWidth(), img.getHeight(), function (this: InstanceType<typeof Jimp>, _x, _y, idx) {
      const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
      if (Math.abs(r - target.r) <= threshold && Math.abs(g - target.g) <= threshold && Math.abs(b - target.b) <= threshold) {
        this.bitmap.data[idx + 3] = 0;
      }
    });
  }

  try { img.autocrop({ tolerance: 0.01, cropOnlyFrames: false }); } catch { /* nothing croppable */ }
  if (img.getWidth() < 16 || img.getHeight() < 16) return null; // background removal ate it — not a logo shape

  for (const canvas of [LOGO_CANVAS, 128]) {
    const framed = new Jimp(canvas, canvas, 0x00000000);
    const copy = img.clone();
    copy.contain(canvas, canvas); // preserves aspect ratio on a transparent frame
    framed.composite(copy, 0, 0);
    const base64 = await framed.getBase64Async(Jimp.MIME_PNG);
    if (base64.length <= MAX_LOGO_DATA_URI_CHARS) return base64;
  }
  return null;
}

/* ─── the workflow ───────────────────────────────────────────────────────── */

export interface LogoResult { ok: boolean; dataUri?: string; sourceUrl?: string; kind?: string; reason?: string }

/** Discover, fetch, validate, and process the best available logo. */
export async function fetchAndProcessLogo(domain: string): Promise<LogoResult> {
  const candidates = await discoverLogoCandidates(domain);
  for (const cand of candidates) {
    const res = await fetchWithTimeout(cand.url, "image/*");
    if (!res?.ok) continue;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_ASSET_BYTES) continue;

    if (contentType === "image/svg+xml" || /\.svg(\?|$)/i.test(cand.url)) {
      // Scalable and (almost always) transparent already — store as-is when
      // it fits the inline budget. Rendered via <img>, where scripts don't run.
      const uri = `data:image/svg+xml;base64,${buf.toString("base64")}`;
      if (uri.length <= MAX_LOGO_DATA_URI_CHARS) return { ok: true, dataUri: uri, sourceUrl: cand.url, kind: cand.kind };
      continue;
    }
    if (!contentType.startsWith("image/")) continue;
    try {
      const dataUri = await processLogoBytes(buf);
      if (dataUri) return { ok: true, dataUri, sourceUrl: cand.url, kind: cand.kind };
    } catch { /* unreadable image — next candidate */ }
  }
  return { ok: false, reason: "no usable asset" };
}
