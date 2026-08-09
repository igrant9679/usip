import { describe, it, expect } from "vitest";
import { isHtmlBody, htmlBodyToText } from "@shared/emailBody";
import { bodyToHtmlDocument } from "./mergeVars";

/**
 * The format decision is a SECURITY boundary as much as a rendering one: a
 * body classified as HTML is sent UNESCAPED. These tests pin the conservative
 * side — anything not unmistakably rich-editor output stays plain text, where
 * escaping renders it harmlessly visible.
 */
describe("isHtmlBody", () => {
  it("recognises what the rich editors actually emit", () => {
    expect(isHtmlBody("<p>Hi {{firstName}},</p><p>Quick question.</p>")).toBe(true);
    expect(isHtmlBody("<h2>Agenda</h2><ul><li>One</li></ul>")).toBe(true);
    expect(isHtmlBody('<p style="margin:0">styled</p>')).toBe(true);
    expect(isHtmlBody("  \n<p>leading whitespace is fine</p>")).toBe(true);
  });

  it("keeps everything else on the plain-text contract", () => {
    expect(isHtmlBody("Hi John,\nQuick question about Acme.")).toBe(false);
    // Angle brackets in prose are not markup.
    expect(isHtmlBody("<your name here> — fill this in")).toBe(false);
    // Inline tags mid-text don't reclassify the body.
    expect(isHtmlBody("Use <b>bold</b> sparingly")).toBe(false);
    // A hostile body that STARTS with script is not on the opener list —
    // it stays plain text and gets escaped into visibility.
    expect(isHtmlBody("<script>alert(1)</script>")).toBe(false);
    expect(isHtmlBody("")).toBe(false);
    expect(isHtmlBody(null)).toBe(false);
    expect(isHtmlBody(undefined)).toBe(false);
  });
});

describe("htmlBodyToText", () => {
  it("turns paragraphs and breaks into readable newlines", () => {
    expect(htmlBodyToText("<p>One</p><p>Two<br>Three</p>")).toBe("One\nTwo\nThree");
  });

  it("renders list items as dashes", () => {
    expect(htmlBodyToText("<ul><li>Alpha</li><li>Beta</li></ul>")).toBe("- Alpha\n- Beta");
  });

  it("keeps link destinations — they are the point of the email", () => {
    expect(htmlBodyToText('<p>See <a href="https://x.com/a">the deck</a></p>')).toBe(
      "See the deck (https://x.com/a)",
    );
    // …but doesn't duplicate a bare URL used as its own label.
    expect(htmlBodyToText('<p><a href="https://x.com/a">https://x.com/a</a></p>')).toBe(
      "https://x.com/a",
    );
  });

  it("decodes entities and preserves merge tags verbatim", () => {
    expect(htmlBodyToText("<p>Hi {{firstName}}, R&amp;D &lt;update&gt;</p>")).toBe(
      "Hi {{firstName}}, R&D <update>",
    );
  });

  it("drops script/style subtrees entirely", () => {
    expect(htmlBodyToText("<p>Hi</p><style>p{color:red}</style><script>x()</script>")).toBe("Hi");
  });
});

describe("bodyToHtmlDocument", () => {
  it("wraps a rich-editor fragment unescaped, with the </body> tracking anchor", () => {
    const doc = bodyToHtmlDocument("<p>Hi <strong>there</strong></p>");
    expect(doc).toContain("<p>Hi <strong>there</strong></p>");
    expect(doc).toContain("</body>");
    expect(doc).not.toContain("&lt;p&gt;");
  });

  it("still escapes plain text — including things that only look like markup", () => {
    const doc = bodyToHtmlDocument("Hi <John>,\nsee https://x.com/a");
    expect(doc).toContain("&lt;John&gt;");
    expect(doc).toContain('<a href="https://x.com/a">');
  });
});
