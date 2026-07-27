import { describe, it, expect } from "vitest";
import { WIDGET_JS } from "./chatWidget";

/**
 * The launcher ships as a STRING, so the compiler never looks at it and a typo
 * would only surface on a customer's website. `new Function` compiles without
 * executing, which is exactly the check that is otherwise missing.
 */
describe("/v/chat.js", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(WIDGET_JS)).not.toThrow();
  });

  it("reads the attribute the admin snippet writes", () => {
    // ChatAgents.tsx emits <script src=".../v/chat.js" data-agent="…">.
    // Renaming either side without the other is a silent no-op on live sites.
    expect(WIDGET_JS).toContain("data-agent");
    // It derives its own origin by stripping its src path, so the route name is
    // baked into this regex and has to track app.get("/v/chat.js").
    expect(WIDGET_JS).toContain("\\/v\\/chat\\.js");
  });

  it("checks availability before rendering anything", () => {
    // The bubble must not exist for a draft/off agent, so the probe has to come
    // before mount() — a bubble opening onto "Chat unavailable" reads as broken.
    expect(WIDGET_JS).toContain("/v/chat/");
    expect(WIDGET_JS.indexOf("c.ok")).toBeLessThan(WIDGET_JS.lastIndexOf("mount("));
  });

  it("loads the chat only once a visitor opens it", () => {
    // frame.src is assigned inside render(), guarded by `loaded`, not at mount.
    expect(WIDGET_JS).toContain("if(!loaded){loaded=true;frame.src=");
    // and it hands the HOST page over, which the iframe cannot read itself (0138).
    expect(WIDGET_JS).toContain("pu=");
    expect(WIDGET_JS).toContain("pt=");
  });

  it("never lets a failure escape onto the host page", () => {
    expect(WIDGET_JS.startsWith("(function(){try{")).toBe(true);
    expect(WIDGET_JS.trimEnd().endsWith("}catch(e){}})();")).toBe(true);
  });

  it("gives the panel an explicit width on small screens", () => {
    // Measured on a 375px viewport: `width:auto` rendered a 300px panel with a
    // 63px gap beside it, because an iframe is a replaced element and falls back
    // to its intrinsic width rather than to left/right.
    expect(WIDGET_JS).not.toContain("width:auto");
    expect(WIDGET_JS).toContain("width:calc(100% - 24px)");
  });

  it("guards against being pasted twice", () => {
    expect(WIDGET_JS).toContain("window.__velocityChat");
  });
});
