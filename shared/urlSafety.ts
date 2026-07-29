/**
 * Is this URL attribute value dangerous to render?
 *
 * Lives in shared/ rather than beside the sanitiser because it is a pure
 * security decision and the test suite only collects `server/**`. A rule this
 * consequential should not be the one piece that never runs in CI.
 *
 * The bypass this replaces: the sanitiser tested the RAW attribute value with
 * `/^(javascript|vbscript):/`. Per the URL spec a browser removes tab, newline
 * and carriage return from a URL *before* parsing its scheme, so an attacker
 * writes `href="java&#9;script:alert(1)"`, the HTML parser decodes the entity
 * into a real TAB, and the value reaching the check is `java<TAB>script:` —
 * which does not match. The browser then strips the tab and runs it. Testing
 * the raw value means testing a string no browser will ever act on.
 *
 * This matters because inbound email is attacker-controlled — anyone can send
 * one — and it renders through dangerouslySetInnerHTML inside the authenticated
 * app, so a click would run script in the user's own session.
 */

/** Remove the characters a browser ignores when resolving a scheme, then trim. */
export function normaliseUrl(value: string): string {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

/**
 * True when the value would execute script in any browser.
 *
 * `data:text/html` is included: navigating to it lands in a scriptable context,
 * so it is an execution vector even though the scheme is not `javascript:`.
 */
export function isScriptUrl(value: string): boolean {
  return /^(javascript|vbscript|data:text\/html)/i.test(normaliseUrl(value).toLowerCase());
}

/**
 * True when a `data:` URL appears anywhere other than an image source.
 *
 * Inline images are the only reason `data:` is permitted at all — emails rely
 * on them — so everything else is refused.
 */
export function isDisallowedDataUrl(value: string, tagName: string, attrName: string): boolean {
  const v = normaliseUrl(value);
  if (!/^data:/i.test(v)) return false;
  return !(attrName === "src" && tagName.toUpperCase() === "IMG" && /^data:image\//i.test(v));
}
