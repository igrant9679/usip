/**
 * emailBody.ts — the ONE answer to "is this email body HTML or plain text?"
 *
 * The product's editors produce two body formats: Tiptap-based rich editors
 * emit HTML fragments ("<p>Hi {{firstName}},</p>"), plain textareas and every
 * AI generator emit newline-separated plain text. The send paths historically
 * assumed plain text and ESCAPED whatever they got — so a body written in a
 * rich editor reached the recipient with its markup visible as literal text.
 *
 * Every send path now asks THIS module which contract a body follows and
 * renders accordingly. The detection is deliberately conservative: only a
 * body that STARTS with a block-level tag a rich editor actually emits is
 * treated as HTML. A plain-text body that merely mentions "<script>" in prose
 * or starts with "<your name here>" must keep the plain-text contract, where
 * escaping renders it harmlessly visible.
 */

import { escapeHtml } from "./escapeHtml";

/** Block-level openers the rich editors emit. Nothing else counts. */
const HTML_OPENER =
  /^<(p|h[1-6]|ul|ol|li|blockquote|div|table|pre|hr)(\s[^>]*)?\/?>/i;

export function isHtmlBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return HTML_OPENER.test(body.trimStart());
}

/**
 * "Did the user actually write anything?" — an empty rich editor emits
 * "<p></p>", which a naive .trim() check counts as content. Send buttons
 * gate on THIS, not on string length.
 */
export function isEmptyEmailBody(body: string | null | undefined): boolean {
  if (!body) return true;
  return (isHtmlBody(body) ? htmlBodyToText(body) : body).trim().length === 0;
}

/**
 * Plain text → the HTML a rich editor would hold for it. Used when a legacy
 * plain-text body (AI-generated, or written in an old textarea) is loaded
 * into a Tiptap editor — fed in raw, Tiptap would parse it as HTML and
 * collapse every newline. Blank-line-separated chunks become paragraphs,
 * single newlines become <br>, markup-looking text is escaped visible.
 */
export function plainTextToHtml(text: string): string {
  if (!text.trim()) return "";
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Plain-text rendering of an HTML body — the text/plain alternative part,
 * activity-log bodies, and anywhere else a human reads the body outside an
 * HTML renderer. Regex-based on purpose: it runs server-side (no DOM), the
 * input is editor-produced markup rather than arbitrary web pages, and the
 * output only has to read naturally.
 */
export function htmlBodyToText(html: string): string {
  let s = html;
  // Drop non-content subtrees entirely.
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "");
  // Line-break-ish elements → newlines BEFORE tags are stripped.
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "- ");
  s = s.replace(/<hr\s*\/?\s*>/gi, "\n----------\n");
  // Keep link destinations: "text (url)" — but not when the text IS the url.
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      if (!text) return href;
      return text === href ? text : `${text} (${href})`;
    },
  );
  // Everything else: tags vanish, entities decode.
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'");
  // Collapse the whitespace the tag-stripping leaves behind.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
