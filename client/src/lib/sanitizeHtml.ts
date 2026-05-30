/**
 * sanitizeEmailHtml — neutralise untrusted HTML before rendering it via
 * dangerouslySetInnerHTML (inbound emails, AI/template draft bodies).
 *
 * Dependency-free on purpose: the repo uses pnpm with a frozen lockfile and
 * there's no local toolchain to regenerate it, so we can't add DOMPurify.
 * This runs in the browser (DOMParser) and strips the active-content vectors:
 *   - dangerous elements (script/iframe/object/embed/link/meta/base/form/svg/…)
 *   - <style> tags (they leak global CSS into the app, not just the email)
 *   - on* event-handler attributes
 *   - javascript:/vbscript: (and data: in non-image contexts) URLs
 *   - style attributes containing expression()/javascript:
 *   - srcdoc
 * and forces links to open in a new tab with rel="noopener".
 *
 * Inline style="" attributes are kept (scoped to the element) so emails still
 * render reasonably.
 */

const BLOCKED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "FRAME",
  "FRAMESET",
  "OBJECT",
  "EMBED",
  "LINK",
  "META",
  "BASE",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "NOSCRIPT",
  "SVG",
  "MATH",
  "TEMPLATE",
]);

const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "background", "poster"]);

export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return "";
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(String(html), "text/html");
  } catch {
    return "";
  }

  const elements = Array.from(doc.body.querySelectorAll("*"));
  for (const el of elements) {
    if (BLOCKED_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      // Event handlers (onclick, onerror, onload, …)
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }
      // URL-bearing attributes: kill script-y schemes; allow data: only for img src.
      if (URL_ATTRS.has(name)) {
        const v = value.trim();
        if (/^(javascript|vbscript):/i.test(v)) {
          el.removeAttribute(attr.name);
        } else if (/^data:/i.test(v) && !(name === "src" && el.tagName === "IMG" && /^data:image\//i.test(v))) {
          el.removeAttribute(attr.name);
        }
      }
      // Inline styles: strip the (legacy) CSS execution vectors.
      if (name === "style" && /expression\s*\(|javascript:|vbscript:|url\(\s*['"]?\s*(javascript|vbscript):/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
    // Make any surviving link safe to click.
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }

  return doc.body.innerHTML;
}
