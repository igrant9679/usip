/**
 * Settings structure and search (audit 2026-10-20, G51 and U9; batch CONB,
 * 2026-11-08; the owner delegated the call).
 *
 *   G51 · workspace items are out of Personal; the signature lives on one
 *         page and the other places link to it; one label for quota; an
 *         unknown section says so; the switch that granted nothing is gone.
 *   U9  · search matches keywords as well as labels; Profile tabs have deep
 *         links; the settings pages the hub linked out to render inside it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; vars: any }>,
  params: {} as Record<string, string | undefined>,
  search: "",
  nav: [] as Array<{ to: string; opts?: any }>,
  role: "admin",
}));

vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: () => h.queries[path] ?? { data: undefined, isLoading: false, error: null },
    useMutation: () => ({ mutate: (vars: any) => { h.calls.push({ path, vars }); }, mutateAsync: async () => ({}), isPending: false }),
  });
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: () => {} }) }) });
  return {
    trpc: new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
      get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
    }),
  };
});
vi.mock("wouter", async () => {
  const { createElement: el } = await import("react");
  return {
    Link: ({ href, children }: any) => el("a", { href }, children),
    useParams: () => h.params,
    useLocation: () => ["/v2/settings", (to: string, opts?: any) => { h.nav.push({ to, opts }); }],
    useSearch: () => h.search,
    Redirect: () => null,
  };
});
vi.mock("@/components/usip/Shell", async () => {
  const { createContext, createElement: el } = await import("react");
  return { ShellEmbedContext: createContext(false), QueryError: ({ what }: any) => el("div", null, `Couldn't load ${what}`) };
});
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaces: [], current: { id: 2, name: "LSI", role: h.role }, switchTo: () => {}, isLoading: false }) }));
vi.mock("@/hooks/usePermissions", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/components/usip/ResponsiveRail", async () => {
  const { createElement: el } = await import("react");
  return { ResponsiveRail: ({ children }: any) => el("aside", null, children) };
});
vi.mock("@/pages/usip/Settings", async () => {
  const { createElement: el } = await import("react");
  return { LegacySettingsSection: ({ title }: any) => el("section", null, `LEGACY:${title}`) };
});
vi.mock("@/components/usip/settings/MailboxesSection", () => ({ MailboxesSection: () => "MAILBOXES" }));
vi.mock("@/components/usip/settings/VoiceAgentsSection", () => ({ VoiceAgentsSection: () => "VOICE-AGENTS" }));

import SettingsHub, { SETTINGS_GROUPS } from "../client/src/pages/usip/SettingsHub";
import { SignatureSection } from "../client/src/components/usip/settings/SignatureSection";
import { HUB_SECTION_ALIASES, profileTabFrom, settingsMatches } from "../client/src/lib/settingsSearch";
import { PERMISSION_KEYS } from "@shared/permissions";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const items = () => SETTINGS_GROUPS.flatMap((g) => g.items);
const find = (q: string) => items().filter((i) => settingsMatches(q, i.label, i.keywords)).map((i) => i.id);
const group = (label: string) => SETTINGS_GROUPS.find((g) => g.label === label)!.items.map((i) => i.id);

function render(section?: string, search = ""): string {
  h.params = { section };
  h.search = search;
  return renderToStaticMarkup(createElement(SettingsHub));
}

beforeEach(() => {
  h.calls = [];
  h.nav = [];
  h.role = "admin";
  h.queries = {
    "profile.getMe": { data: { name: "Rita Rep", email: "rita@lsi.example", title: "AE", quota: 250000, role: "admin", hasPassword: true }, isLoading: false, error: null },
    "settings.get": { data: { emailSignature: "Thanks,\nLSI" }, isLoading: false },
    "profile.getMfaStatus": { data: { totp: { connected: false }, backupCodes: { left: 0 } }, isLoading: false },
    "profile.getMySignature": { data: { emailSignature: "" } },
    "sendingAccounts.list": { data: [{ id: 1, fromEmail: "a@lsi.example", signature: "A" }, { id: 2, fromEmail: "b@lsi.example", signature: null }] },
  };
});

describe("U9: search finds a setting by what it is called, not only its label", () => {
  it.each([
    ["mfa", ["profile", "security"]],
    ["2fa", ["profile", "security"]],
    ["smtp", ["mailboxes", "email-delivery"]],
    ["webhook", ["integrations"]],
    ["signature", ["signature"]],
    ["api key", ["integrations", "data-sources"]],
    ["phone numbers", ["voice-agents"]],
    ["invite", ["users-teams"]],
    ["dark mode", ["appearance"]],
  ])("%s", (q, expected) => {
    const got = find(q);
    for (const id of expected) expect(got, q).toContain(id);
  });
  it("labels still match, and nonsense matches nothing", () => {
    expect(find("Branding")).toEqual(["branding"]);
    expect(find("zzqx")).toEqual([]);
  });
  it("the box filters on keywords through the shared matcher", () => {
    const hub = read("client/src/pages/usip/SettingsHub.tsx");
    expect(hub).toContain("items: g.items.filter((i) => settingsMatches(q, i.label, i.keywords))");
    expect(hub).not.toContain("g.items.filter((i) => i.label.toLowerCase().includes(q))");
  });
});

describe("U9: Profile tabs have deep links", () => {
  it("?tab=mfa opens Security, and ?tab=security says the same", () => {
    expect(render("profile", "?tab=mfa")).toMatch(/aria-selected="true"[^>]*>Security<\/button>/);
    expect(render("profile", "?tab=security")).toMatch(/aria-selected="true"[^>]*>Security<\/button>/);
    expect(render("profile", "?tab=email-settings")).toMatch(/aria-selected="true"[^>]*>Email settings<\/button>/);
    expect(render("profile", "?tab=bogus")).toMatch(/aria-selected="true"[^>]*>General<\/button>/);
  });
  it("a search that names a tab lands on it", () => {
    expect(profileTabFrom("mfa")).toBe("mfa");
    expect(profileTabFrom("backup codes")).toBe("mfa");
    expect(profileTabFrom("click tracking")).toBe("email-settings");
    expect(profileTabFrom("password")).toBe("general");
    expect(profileTabFrom("x")).toBeNull();
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain("navigate(`/v2/settings/profile?tab=${tabHit}`)");
  });
  it("picking a tab writes it back to the address", () => {
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain('navigateTab(t === "general" ? "/v2/settings/profile" : `/v2/settings/profile?tab=${t}`, { replace: true });');
  });
});

describe("U9: the settings pages render inside the hub", () => {
  it("Users and teams, Audit log, Custom fields and Notifications are internal sections now", () => {
    for (const id of ["users-teams", "system-activity", "custom-fields", "notifications"]) {
      const it = items().find((i) => i.id === id)!;
      expect(it.internal, id).toBe(true);
      expect(it.href, id).toBeUndefined();
    }
    const hub = read("client/src/pages/usip/SettingsHub.tsx");
    expect(hub).toContain('{section === "users-teams" && <Embedded><EmbeddedTeam /></Embedded>}');
    expect(hub).toContain('const EmbeddedTeam = lazy(() => import("@/pages/usip/Team"));');
    expect(hub).toContain("<ShellEmbedContext.Provider value={true}>");
  });
  it("an embedded page renders in the panel, not Profile", () => {
    const html = render("users-teams");
    expect(html).not.toContain(">Profile</h1>");
    expect(html).toContain("animate-pulse");
  });
  it("Shell drops its own frame inside the hub, after every hook", () => {
    const shell = read("client/src/components/usip/Shell.tsx");
    expect(shell).toContain("export const ShellEmbedContext = createContext(false);");
    expect(shell).toContain("const embedded = useContext(ShellEmbedContext);");
    const tail = shell.slice(shell.indexOf("// close dropdowns/drawers on route change"));
    expect(tail.indexOf("if (embedded) {")).toBeGreaterThan(-1);
    expect(tail.indexOf("if (embedded) {")).toBeLessThan(tail.indexOf("<CommandPalette"));
  });
  it("what stays outside is the three that are not settings", () => {
    const out = items().filter((i) => !i.internal).map((i) => i.id).sort();
    expect(out).toEqual(["enrichment", "imports", "tour-builder"]);
  });
  it("the admin menu and Add Teammates open the hub's sections", () => {
    const shell = read("client/src/components/usip/Shell.tsx");
    expect(shell).toContain('{ label: "Users and Teams", icon: Users, href: "/v2/settings/users-teams" },');
    expect(shell).toContain('{ label: "Audit Log", icon: Activity, href: "/v2/settings/system-activity" },');
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain('onClick={() => navigate("/v2/settings/users-teams")}');
  });
});

describe("G51: workspace settings are under Workspace", () => {
  it("Personal holds only what is yours; Mailboxes moved to Workspace", () => {
    expect(group("Personal settings")).toEqual(["profile", "appearance", "signature", "notifications", "social-accounts"]);
    expect(group("Workspace settings")).toContain("mailboxes");
    expect(group("Workspace settings")).toContain("voice-agents");
    expect(items().some((i) => i.id === "phone-numbers")).toBe(false);
  });
  it("an old link to Phone numbers lands on Voice agents, where numbers are set", () => {
    expect(HUB_SECTION_ALIASES["phone-numbers"]).toBe("voice-agents");
    const html = render("phone-numbers");
    expect(html).toContain("VOICE-AGENTS");
    // And the address is corrected to the section it now is (an effect, so read from the source).
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain("else if (askedItem && params.section && askedItem.id !== params.section) navigate(`/v2/settings/${askedItem.id}`, { replace: true });");
  });
  it("an unknown section says so instead of showing Profile", () => {
    const html = render("no-such-thing");
    expect(html).toContain("There is no settings section called “no-such-thing”");
    expect(html).not.toContain(">Profile</h1>");
  });
});

describe("G51: one label for quota", () => {
  it("Profile calls workspace_members.quota what Team calls it", () => {
    const html = render("profile");
    expect(html).toContain("Annual quota ($)");
    expect(html).not.toContain("Credit Limit");
    expect(read("client/src/pages/usip/Team.tsx")).toContain('<Label htmlFor="edit-quota">Annual quota ($)</Label>');
  });
});

describe("G51: the signature lives in one place", () => {
  it("one page holds yours, the workspace default and each mailbox's", () => {
    const html = renderToStaticMarkup(createElement(SignatureSection, { isAdmin: true }));
    expect(html).toContain("Your signature");
    expect(html).toContain("Workspace default");
    expect(html).toContain("Mailbox signatures");
    expect(html).toContain("a@lsi.example");
    expect(html).toContain("Has its own signature");
    expect(html).toContain("No signature of its own");
    expect(html).toContain("Thanks,\nLSI");
  });
  it("only an admin can change the workspace default", () => {
    const html = renderToStaticMarkup(createElement(SignatureSection, { isAdmin: false }));
    expect(html).toMatch(/<textarea id="sig-workspace"[^>]*disabled=""/);
    expect(html).toContain("Only workspace admins can change it.");
  });
  it("the other places link to it instead of editing", () => {
    const settings = read("client/src/pages/usip/Settings.tsx");
    const myProfile = settings.slice(settings.indexOf("function MyProfileTab()"), settings.indexOf("/** Per-user appearance"));
    expect(myProfile).toContain('<SignaturePointer what="Your email signature" />');
    expect(myProfile).not.toContain("updateMySignature");
    const branding = settings.slice(settings.indexOf("function BrandingTab("), settings.indexOf("function SecurityTab("));
    expect(branding).not.toContain('aria-label="Default signature"');
    expect(branding).not.toContain("emailSignature: sig");
    expect(branding).toContain('<Link href="/v2/settings/signature"');
    const html = render("profile", "?tab=email-settings");
    expect(html).not.toContain("Your signature is set per mailbox");
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain('onClick={() => navigate("/v2/settings/signature")}');
  });
  it("is its own Personal section", () => {
    expect(items().find((i) => i.id === "signature")).toMatchObject({ internal: true, label: "Email signature" });
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain('{section === "signature" && <SignatureSectionForMe />}');
  });
});

describe("G51: a switch that granted nothing is removed", () => {
  it("View all leads is no longer a switch", () => {
    expect(PERMISSION_KEYS as readonly string[]).not.toContain("view_all_leads");
    expect(read("client/src/pages/usip/Team.tsx")).not.toContain('view_all_leads: { label: "View all leads"');
  });
});

describe("the hub names its section in the tab title", () => {
  it("uses the page-title hook", () => {
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain('usePageTitle(unknownSection ? "Settings" : `${sectionLabel} · Settings`);');
  });
});
