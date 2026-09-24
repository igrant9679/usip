/**
 * Every Settings section shows which workspace it belongs to and can switch
 * it (owner ask 2026-09-24: "most, if not all settings should have a
 * workspace switcher"). The hub renders outside the main Shell, so it had no
 * switcher at all; an admin of several workspaces edited whichever one they
 * had last picked on another page, with nothing on screen saying which.
 *
 * The hub is the only settings surface: /settings redirects into it, and the
 * stand-alone settings pages (LinkedIn Limits, Pipelines, Brand Voice,
 * Connected Accounts) render inside the Shell, which carries the switcher.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const hub = readFileSync("client/src/pages/usip/SettingsHub.tsx", "utf8");
const legacy = readFileSync("client/src/pages/usip/Settings.tsx", "utf8");

describe("the Settings hub carries the workspace switcher", () => {
  const fn = hub.slice(hub.indexOf("function SettingsWorkspaceSwitcher()"));

  it("is rendered in the desktop rail and the mobile top bar", () => {
    expect(hub.split("<SettingsWorkspaceSwitcher />").length - 1).toBe(2);
    const rail = hub.slice(hub.indexOf("{/* ── settings rail ── */}"), hub.indexOf("{/* ── content panel ── */}"));
    expect(rail).toContain("<SettingsWorkspaceSwitcher />");
    const mobile = hub.slice(hub.indexOf("{/* mobile top bar (rail is hidden below md) */}"));
    expect(mobile.slice(0, 800)).toContain("<SettingsWorkspaceSwitcher />");
  });

  it("switches through the shared context, never a second mechanism", () => {
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain("const { workspaces, current, switchTo, isLoading } = useWorkspace();");
    expect(fn).toContain("if (w.id !== current?.id) switchTo(w.id);");
    expect(fn).not.toContain("localStorage");
  });

  it("remounts the content on a switch so no draft crosses workspaces", () => {
    expect(hub).toContain("const { current: currentWorkspace } = useWorkspace();");
    expect(hub).toContain('<main key={currentWorkspace?.id ?? 0} className="flex-1 min-w-0 flex flex-col min-h-0">');
  });

  it("the old /settings route still lands in the hub", () => {
    expect(legacy).toContain("return <Redirect to={`/v2/settings/");
  });
});
