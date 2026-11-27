/**
 * Pins for the Operator's Manual (2026-09-08) — the same knowledge in three
 * homes (the repo skill, the assistant digest, the Help Center category) that
 * can only drift apart silently. These checks make the drift loud:
 *
 *   - every href the assistant digest names is a real registry tool (or one of
 *     its documented tab/filter variants), so `navigate` targets resolve;
 *   - the digest is actually IN both AI prompts (assistant + Ask AI), not just
 *     exported;
 *   - the manual's articles are seeded, in their own category, and every
 *     internal link inside them resolves to an article or a real page;
 *   - the article renderer supports the inline set the manual uses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../client/src/lib/toolRegistry";
import { ARTICLES, CATEGORIES } from "./seedHelpContent";
import { OPERATOR_ARTICLES, OPERATOR_CATEGORY } from "./seedHelpOperatorManual";
import { PRODUCT_KNOWLEDGE, knowledgeHrefs } from "./productKnowledge";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const registryHrefs = new Set(TOOLS.map((t) => t.href));
// Paths the digest names that are deliberately not registry tools.
// /v2/library is the page that LISTS the registry, so it is not in it; the
// shell's own LIBRARY_LINK and the route are checked below.
// /are/settings is a tab of the Revenue Engine (AreSubNav), not a tool of
// its own; its route and its tab are checked where the digest names it.
const KNOWN_NON_TOOL_PATHS = new Set(["/help/articles", "/v2/library", "/are/settings"]);
/**
 * The Settings hub's sections, read from the page that renders them: its
 * `internal` rows each open at /v2/settings/<id> (2026-11-15).
 */
const hubSource = read("../client/src/pages/usip/SettingsHub.tsx");
const hubSections = Array.from(hubSource.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)", icon: \w+, internal: true/g)).map((m) => ({ id: m[1], label: m[2] }));
const hubLinkRows = Array.from(hubSource.matchAll(/\{ id: "[a-z-]+", label: "([^"]+)", icon: \w+, href: "/g)).map((m) => m[1]);
function hrefResolves(href: string): boolean {
  // "/v2/settings/ID" in the digest is the pattern; a named section must be a real one.
  if (href === "/v2/settings/") return true;
  if (href.startsWith("/v2/settings/") && hubSections.some((s) => s.id === href.slice("/v2/settings/".length))) return true;
  if (registryHrefs.has(href)) return true;
  const base = href.split("?")[0].split("#")[0];
  if (registryHrefs.has(base)) return true;
  if (KNOWN_NON_TOOL_PATHS.has(base)) return true;
  return false;
}

describe("assistant product knowledge digest", () => {
  it("names only real pages", () => {
    const hrefs = knowledgeHrefs();
    expect(hrefs.length).toBeGreaterThan(40);
    const unknown = hrefs.filter((h) => !hrefResolves(h));
    expect(unknown, "digest names a path the tool registry does not have — navigate would 404").toEqual([]);
  });

  it("covers every primary (rail) tool by href", () => {
    const missing = TOOLS.filter((t) => t.primary && !PRODUCT_KNOWLEDGE.includes(t.href)).map((t) => t.href);
    expect(missing).toEqual([]);
  });

  it("stays a digest, not a manual", () => {
    // 2026-11-15: 9000 → 10500. The digest sat at 8,968 of 9,000 and named none
    // of three areas shipped since October: Research (what the AI writers read),
    // AI phone calls, and key sharing between workspaces. Each got one terse
    // paragraph, and the routines were cut down to pay for part of it (10,158
    // now). The headroom is for the assistant's own paragraph, not for prose:
    // depth still belongs in the Operator's Manual articles, which help_lookup reads.
    //
    // 2026-11-15, later the same day: 10500 → 12500. Asked on the live site
    // where to change a key, Elsie answered "Settings (top bar…)". The digest
    // named Settings sections ("Settings → Data sources") without ever saying
    // where Settings is or what else is in it, so she guessed. It now says
    // where every control in the top bar and the sidebar is, and lists the
    // hub's sections with what each holds (about 1,900 characters). The two
    // tests below hold that text to the real shell and the real hub.
    //
    // 2026-11-16: 12500 → 13000. The digest sat at 12,497 when a live check
    // showed one of its older lines was wrong: "keys + on/off under Settings
    // → Data sources". Only the keys are there; a source is switched on and
    // ordered on the Revenue Engine's own settings tab. Elsie repeated the
    // error as "a toggle to turn the key on/off" and "drag to reorder".
    // Saying where each really is costs about 200 characters, and the
    // routines had already been cut twice to pay for earlier fixes.
    //
    // 2026-11-16, later: 13000 → 13300. Elsie Assist shipped: a second
    // button in the top bar and a pane she is asked about by name. Two
    // sentences say what it is, where it opens and what its buttons do.
    //
    // 2026-11-16, later still: 13300 → 13900. The day model tiers shipped,
    // the digest only NAMED them ("AI provider keys, model tiers and
    // webhooks"), and asked about them on the live site Elsie made up the
    // rest: tiers called Standard and Advanced, one each for email, tasks
    // and the phone agent, and model names. A bare name is an invitation.
    // The paragraph that replaces the guess costs about 600 characters.
    //
    // 2026-11-17: 13900 → 15000, owner: "raise Elsie's manual limit". The
    // digest sat at 13,899 after saying how each part of the Model tiers card
    // saves (#87), a fix that had to cut words elsewhere to fit. Every raise
    // so far was sized to one fix; this one leaves room for the next few.
    // It is still a digest: it goes into every Elsie and Help
    // answer, so each 1,000 characters is about 250 tokens on every call,
    // and depth still belongs in the Operator's Manual articles.
    //
    // 2026-11-25: 15000 → 15500. Membership plans now include a monthly
    // number of prospect records from the platform's keys (owner approved
    // 2026-11-25), and own data keys became optional on a plan. Asked "do I
    // need an Apollo key?", a digest that says only "Keys: Settings → Data
    // sources" makes Elsie answer yes. One sentence of about 360 characters
    // says the numbers, what counts and what happens when it runs out; the
    // full article is "Prospect data included with your plan".
    //
    // 2026-11-27: 15500 → 15900. OpenRouter became the fifth AI provider
    // (owner decisions 2026-11-27), with a shared platform key, a model
    // picker and a platform default: asked "do I need an OpenRouter key?" or
    // "which model does OpenRouter use?", a digest that only adds the name to
    // the tiers' provider list would leave Elsie to guess. One paragraph of
    // about 360 characters says the key order, the model list and default,
    // and who can make it the platform default; the digest sat at 15,499, so
    // the room came from here (and 23 characters cut from the Home sentence).
    // The full article is "AI providers: OpenRouter".
    expect(PRODUCT_KNOWLEDGE.length).toBeLessThan(15900);
  });

  it("says where Settings is, and names every section the hub has", () => {
    expect(hubSections.length).toBeGreaterThanOrEqual(20);
    const start = PRODUCT_KNOWLEDGE.indexOf("Settings hub (each section is at /v2/settings/ID");
    expect(start).toBeGreaterThan(-1);
    const hub = PRODUCT_KNOWLEDGE.slice(start, PRODUCT_KNOWLEDGE.indexOf("Page map (group", start));
    expect(hub.length).toBeGreaterThan(400);
    // Every section, by the id its address ends in: a section added to the hub
    // and not to the digest fails here.
    const missing = hubSections.filter((s) => !new RegExp(`(^|[\\s(:,])${s.id}([\\s,.(]|$)`).test(hub)).map((s) => s.id);
    expect(missing).toEqual([]);
    // The rows that leave the hub are named as such, by their labels.
    expect(hubLinkRows.sort()).toEqual(["Data enrichment", "Imports and exports", "Tour builder"]);
    for (const label of hubLinkRows) expect(hub, label).toContain(label);
    // Where the digest gives a section a label, it is the hub's own.
    for (const [id, label] of [["workspace", "Workspace overview"], ["knowledge", "Knowledge base"], ["data-sources", "Data sources"], ["billing", "Billing and credits"], ["system-activity", "Audit log"]]) {
      expect(hubSections.find((s) => s.id === id)?.label, id).toBe(label);
      expect(hub).toContain(`${id} (${label}`);
    }
    // What the digest says each section holds is on that section's page.
    const legacy = read("../client/src/pages/usip/Settings.tsx");
    expect(hubSource).toContain('section === "workspace" && <LegacySettingsSection tab="general"');
    const general = legacy.slice(legacy.indexOf("function GeneralTab("), legacy.indexOf("function MyProfileTab("));
    expect(general).toContain("<SendWindowSection");
    expect(legacy).toContain('aria-label="Pause all outbound"');
    // 2026-11-16: asked where the pause switch is, Elsie put it "at the top"
    // of Workspace overview. It is inside the Send window card, and flipping
    // it saves at once (no Save button). The digest says both.
    expect(hub).toContain("the Send window card, whose Pause all outbound switch holds all email, LinkedIn and invites as soon as it is flipped");
    const sendWindow = legacy.slice(legacy.indexOf("function SendWindowSection("), legacy.indexOf("function ", legacy.indexOf("function SendWindowSection(") + 10));
    expect(sendWindow).toContain('title="Send window"');
    expect(sendWindow).toMatch(/aria-label="Pause all outbound"\s*onCheckedChange=\{\(v\) => save\(\{ outboundPaused: v \}\)\}/);
    const billing = legacy.slice(legacy.indexOf("function BillingTab("), legacy.indexOf("function DangerTab("));
    expect(billing).toContain('title="Monthly AI budget"');
    // Asked where to change an Apollo key after the first version shipped,
    // Elsie said Integrations: the digest described that section and left
    // Data sources bare. Each says which keys it holds now, and the vendor
    // cards really are in the Data sources section.
    expect(hub).toContain("integrations (AI provider keys, model tiers and webhooks; NOT the data vendors)");
    // Model tiers (2026-11-16) are a card of the AI providers screen, which the Integrations section renders.
    expect(legacy.slice(legacy.indexOf("function AIProvidersSection("), legacy.indexOf("function ProposalsTab("))).toContain("<ModelTiersCard isAdmin={isAdmin} />");
    // 2026-11-25: members read every prospect source as "Source N" (owner
    // decision), so the digest names no vendor; the own-key cards still do.
    expect(hub).toContain("then a card per vendor for a key of your own, and Reoon)");
    const dataSources = hubSource.slice(hubSource.indexOf('{section === "data-sources" && ('), hubSource.indexOf('{section === "workspace" &&'));
    for (const vendor of ["Apollo", "QuickEnrich", "WarmySender", "LeadOcean", "Reoon"]) expect(dataSources.toLowerCase(), vendor).toContain(vendor.toLowerCase());
    // The same day she called Apollo's entry "a row in a table". Each vendor
    // is a card of its own with its key field, and the order is its own card.
    expect(hub).toContain("data-sources (Data sources: the plan's prospect data and its Prospect source choice, a read-only table of the sources in checking order");
    // The table at the top of that section is the registry, and it only reports.
    const registry = read("../client/src/components/usip/settings/ProspectSourceRegistryCard.tsx");
    expect(dataSources.indexOf("<ProspectSourceRegistryCard />")).toBeLessThan(dataSources.indexOf("<WarmySenderSourceCard />"));
    expect(registry).toContain("<table");
    expect(registry).not.toMatch(/<Switch\b|useMutation\(/);
    for (const card of ["<ProspectSourceRegistryCard />", "<WarmySenderSourceCard />", "<QuickEnrichSourceCard />", "<ApolloSourceCard />", "<LeadOceanSourceCard />", "<ReoonVerifierCard />"]) expect(dataSources, card).toContain(card);
    expect(read("../client/src/components/usip/settings/ApolloSourceCard.tsx")).toContain('aria-label="Apollo API key"');
    // And the rule that stops the next invented detail.
    expect(PRODUCT_KNOWLEDGE).toContain("never place a control, or describe a layout (table, row, top of the page), that this manual does not.");
    // Elsie Assist: what she is told matches the pane (four pages, three shown, one button each).
    expect(PRODUCT_KNOWLEDGE).toContain("opens a pane beside the page with up to three suggestions for Home, a campaign's page, Inbox or a person's record; each has a reason and one button, which opens a page or asks you");
    expect(read("../shared/elsieAssist.ts")).toContain("export const ASSIST_MAX_SHOWN = 3;");
    expect(read("../shared/elsieAssist.ts")).toContain('export type AssistPlace = "home" | "campaign" | "inbox" | "person";');
    const security = legacy.slice(legacy.indexOf("function SecurityTab("), legacy.indexOf("function NotificationsTab("));
    expect(security).toContain("IP allowlist");
    expect(security).toContain("Session timeout");
  });

  // 2026-11-16: the digest said "keys + on/off under Settings → Data sources"
  // from the day it was written, and Elsie told the owner the Apollo card had
  // an on/off toggle and a drag handle. Neither is on that card.
  //
  // Later the same day, two corrections to that fix. It said on/off is "NOT"
  // on Data sources at all, which is wrong for two vendors: the WarmySender
  // and LeadOcean cards each carry a Use switch that saves at once. And it
  // ended "then Save", which Elsie turned into "Save at the bottom of the
  // card": the page has one Save Settings button, in a bar under its last
  // section.
  it("sends the order and every source's on/off to the Revenue Engine's settings, and says which key cards have a switch", () => {
    const start = PRODUCT_KNOWLEDGE.indexOf("Prospect sources: ");
    expect(start).toBeGreaterThan(-1);
    const para = PRODUCT_KNOWLEDGE.slice(start, PRODUCT_KNOWLEDGE.indexOf("\n", start));
    expect(para).toContain("Keys: Settings → Data sources.");
    expect(para).toContain("The order, and on/off for every source: Revenue Engine → ARE Settings tab (/are/settings), the Prospect Sources & Checking Order card: arrows and a toggle per source; nothing saves until Save Settings, the page's one save button, in the bar under its last section.");
    expect(para).toContain("Two of the own-key cards also have a Use switch (saves at once); the other two have no on/off.");
    expect(para).toContain("never name their vendors");
    expect(para).not.toContain("NOT there");
    expect(para).not.toContain("then Save.");
    expect(PRODUCT_KNOWLEDGE).not.toContain("on/off under Settings");
    // The page, its tab, and the card with those controls.
    expect(read("../client/src/App.tsx")).toContain('<Route path="/are/settings">');
    expect(read("../client/src/components/usip/are/AreSubNav.tsx")).toContain('{ href: "/are/settings", label: "ARE Settings",');
    const are = read("../client/src/pages/usip/ARESettings.tsx");
    const card = are.slice(are.indexOf('title="Prospect Sources & Checking Order"'));
    expect(card.length).toBeGreaterThan(500);
    const body = card.slice(0, 5000);
    expect(body).toContain("aria-label={`Move ${meta.label} up`}");
    expect(body).toContain("aria-label={`Move ${meta.label} down`}");
    expect(body).toContain("<Toggle label={meta.label} checked={active}");
    // Both only mark the page as changed: nothing is saved until Save.
    expect(body).toContain("mark();");
    expect(are).toMatch(/disabled=\{save\.isPending \|\| !dirty\}/);
    // One save button for the whole page, named Save Settings, in a bar that
    // comes after every section and before the danger zone.
    expect(are.split("Save Settings").length - 1).toBe(1);
    const saveAt = are.indexOf("Save Settings");
    const lastSection = are.lastIndexOf("<Section");
    const danger = are.indexOf("Danger Zone");
    expect(lastSection).toBeGreaterThan(-1);
    expect(danger).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(lastSection);
    expect(saveAt).toBeLessThan(danger);
    expect(are.slice(saveAt - 400, saveAt)).toContain("onClick={handleSave}");
    // Which key cards carry a switch for the source, and which do not.
    const cardFile = (name: string) => read(`../client/src/components/usip/settings/${name}.tsx`);
    expect(cardFile("ApolloSourceCard")).not.toMatch(/<Switch\b|<Toggle\b|setEnabled/);
    expect(cardFile("QuickEnrichSourceCard")).not.toMatch(/<Switch\b|<Toggle\b|setEnabled/);
    expect(cardFile("WarmySenderSourceCard")).toMatch(/<Switch aria-label="Use WarmySender"[^>]*\n?\s*onCheckedChange=\{\(v\) => setEnabled\.mutate\(\{ slug: "warmysender", enabled: v \}\)\}/);
    expect(cardFile("LeadOceanSourceCard")).toMatch(/<Switch aria-label="Use LeadOcean"[^>]*\n?\s*onCheckedChange=\{\(v\) => setEnabled\.mutate\(\{ slug: "leadocean", enabled: v \}\)\}/);
  });

  // 2026-11-16: asked where to choose models, Elsie invented "Standard or
  // Advanced" tiers for "email writing, task descriptions and the phone
  // agent". The digest now says what the card has, checked against the catalog.
  it("describes model tiers as the card has them", async () => {
    const { AI_TASKS, AI_TIERS, AI_TIER_LABEL } = await import("../shared/aiTiers");
    const start = PRODUCT_KNOWLEDGE.indexOf("Model tiers (on integrations");
    expect(start).toBeGreaterThan(-1);
    const para = PRODUCT_KNOWLEDGE.slice(start, PRODUCT_KNOWLEDGE.indexOf("\n", start));
    expect(AI_TIERS.map((t) => AI_TIER_LABEL[t])).toEqual(["Fast", "Standard", "Deep"]);
    expect(para).toContain("Model tiers (on integrations, below the AI keys): Fast, Standard and Deep. For each,");
    // The providers she names are the ones the picker lists (DeepSeek joined them 2026-11-16, OpenRouter 2026-11-27).
    const { AI_PROVIDER_IDS } = await import("../shared/aiTiers");
    expect(AI_PROVIDER_IDS).toEqual(["anthropic", "openai", "gemini", "deepseek", "openrouter"]);
    expect(para).toContain("an admin picks a provider that has a key (Anthropic, OpenAI, Gemini, DeepSeek or OpenRouter) and types a model name, then that tier's Save;");
    // OpenRouter's own paragraph says what the code does: the key order, the list, the default and the filter.
    const orAt = PRODUCT_KNOWLEDGE.indexOf("OpenRouter (one key, many vendors' models):");
    expect(orAt).toBeGreaterThan(-1);
    const orPara = PRODUCT_KNOWLEDGE.slice(orAt, PRODUCT_KNOWLEDGE.indexOf("\n", orAt));
    expect(orPara).toContain("the workspace's own key first, else the platform's shared key");
    expect(orPara).toContain("default: newest Claude Sonnet");
    expect(orPara).toContain("only those that give structured answers");
    expect(orPara).toContain("The platform owner can make it the default for workspaces with no AI choice or key.");
    // Each default the paragraph states is the catalog's.
    const said: Record<string, string[]> = {
      deep: ["outreach", "targeting"],
      standard: ["elsie", "help", "chat_agent", "enrichment", "documents"],
      fast: ["replies", "scoring", "suggestions"],
    };
    for (const [tier, tasks] of Object.entries(said)) for (const t of tasks) expect(AI_TASKS[t as keyof typeof AI_TASKS].defaultTier, t).toBe(tier);
    expect(para).toContain("emails to prospects and campaign targeting default to Deep; your chat, Help answers, website chat, research and proposals to Standard; reading replies, scoring and suggestions to Fast.");
    expect(para).toContain("A tier left blank uses the default provider's model, so setting nothing changes nothing.");
    // 2026-11-17: the digest listed each row's tier and never said it can be
    // changed, and asked on the live site Elsie answered "You can't change
    // which kind of work runs on which tier". It can: that is what the row's
    // picker is for (owner 2026-11-16: "editable per workspace").
    expect(para).toContain("a row per kind of AI work with the tier it runs on, and an admin can change it there (saves at once):");
    const tierCard = read("../client/src/components/usip/settings/ModelTiersCard.tsx");
    expect(tierCard).toContain('onValueChange={(v) => setTaskTier.mutate({ task, tier: v === info.defaultTier ? "" : (v as AiTier) })}');
    expect(tierCard).toContain("aria-label={`Tier for ${info.label}`}");
    // 2026-11-17, later: the digest said "then Save" for a tier and nothing
    // about saving for a row, and on the live site Elsie added "there is no
    // separate save button for this card". Half right: a row's picker saves as
    // it is picked, but each of the three tiers has a Save button of its own.
    // The digest says both, and the card is held to both here.
    const rowsAt = tierCard.indexOf("{AI_TASK_IDS.map((task) => {");
    const tiersAt = tierCard.indexOf("{AI_TIERS.map((tier) => {");
    expect(tiersAt).toBeGreaterThan(-1);
    expect(rowsAt).toBeGreaterThan(tiersAt);
    const tierRows = tierCard.slice(tiersAt, rowsAt);
    const taskRows = tierCard.slice(rowsAt);
    // One Save in the block drawn once per tier, and it is what writes the tier's model.
    expect((tierRows.match(/>Save<\/Button>/g) ?? []).length).toBe(1);
    expect(tierRows).toMatch(/onClick=\{\(\) => setTier\.mutate\(\{ tier, provider: draft\.provider, model: draft\.model\.trim\(\) \}[^\n]*\n\s*>Save<\/Button>/);
    // Typing or picking in a tier only changes the draft: nothing is written before Save.
    expect(tierRows).toContain("onValueChange={(v) => setDraft({ provider: v as AiProviderId })}");
    expect(tierRows).toContain("onChange={(e) => setDraft({ model: e.target.value })}");
    // The rows have no Save, and the write is in the picker itself.
    expect(taskRows).not.toMatch(/>\s*Save\s*</);
    expect(taskRows).toContain("onValueChange={(v) => setTaskTier.mutate(");
    expect(para).toContain("nothing is pre-filled and Velocity names no model");
    // The model box really is empty and free text, and the card sits below the keys.
    const card = read("../client/src/components/usip/settings/ModelTiersCard.tsx");
    expect(card).toContain('placeholder="Model name, exactly as the provider lists it"');
    expect(card).not.toMatch(/claude-|gpt-|gemini-|deepseek-/);
    const settings = read("../client/src/pages/usip/Settings.tsx");
    const section = settings.slice(settings.indexOf("function AIProvidersSection("), settings.indexOf("function ProposalsTab("));
    expect(section.indexOf("{AI_PROVIDERS.map((p) => {")).toBeGreaterThan(-1);
    expect(section.slice(section.indexOf("{AI_PROVIDERS.map((p) => {"))).toContain("<ModelTiersCard isAdmin={isAdmin} />");
  });

  it("puts each control where the shell puts it", () => {
    const start = PRODUCT_KNOWLEDGE.indexOf("Where the controls are.");
    expect(start).toBeGreaterThan(-1);
    const frame = PRODUCT_KNOWLEDGE.slice(start, PRODUCT_KNOWLEDGE.indexOf("Settings hub (each section", start));
    expect(frame).toContain("Settings is NOT in the top bar.");
    expect(frame).toContain("Admin Settings at the bottom of the sidebar");
    const shell = read("../client/src/components/usip/Shell.tsx");
    // The bottom of the sidebar: these three rows, in this order.
    const bottom = shell.slice(shell.indexOf("const BOTTOM_LINKS"), shell.indexOf("// ── Route → accent colour maps"));
    const labels = Array.from(bottom.matchAll(/label: "([^"]+)"/g)).map((m) => m[1]);
    expect(labels).toEqual(["Deliverability suite", "Help Center", "Admin Settings"]);
    expect(frame).toContain("Deliverability suite, Help Center and Admin Settings");
    // The Library row, by its own label and address, and the page exists.
    expect(shell).toMatch(/const LIBRARY_LINK: NavLink = \{\s*href: "\/v2\/library",\s*label: "Library — all tools",/);
    expect(read("../client/src/App.tsx")).toContain('path="/v2/library"');
    expect(frame).toContain("Library — all tools (/v2/library)");
    // The admin menu: these rows, then All settings.
    const menu = shell.slice(shell.indexOf("const ADMIN_MENU_ITEMS"), shell.indexOf("function AdminSettingsMenu("));
    expect(Array.from(menu.matchAll(/label: "([^"]+)"/g)).map((m) => m[1])).toEqual(["Users and Teams", "Audit Log", "Security", "Integrations"]);
    expect(shell).toContain("All settings");
    expect(frame).toContain("Users and Teams, Audit Log, Security, Integrations and All settings");
    // The same answer said "click your name at the bottom of the sidebar,
    // then Settings". The name row has a help link and Sign out and nothing
    // else, and the digest gives the clicks in so many words.
    expect(frame).toContain("clicking the name opens nothing");
    expect(frame).toContain("Admin Settings → All settings → the section in the hub's left list");
    const rowStart = shell.indexOf('{(user?.name ?? "?").slice(0, 1).toUpperCase()}');
    expect(rowStart).toBeGreaterThan(-1);
    const userRow = shell.slice(rowStart, shell.indexOf("</aside>", rowStart));
    expect(userRow).toContain('<Link href="/help"');
    expect(userRow).toContain("logout()");
    expect(userRow).not.toContain("/v2/settings");
    // A member who is not an admin gets a plain Settings row there.
    expect(shell).toContain('renderNavLink({ ...l, href: "/v2/settings/profile", label: "Settings", trailingChevron: false })');
    // The top bar's controls, in the order the digest lists them.
    const bar = ["<ElsieButton />", 'title="Colour theme"', 'aria-label="Open Help Center"', 'aria-label="Notifications"'].map((needle) => {
      const at = shell.lastIndexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
    // 2026-11-16: the Assist button sits between Elsie's and Search.
    const assistAt = shell.lastIndexOf("<ElsieAssistButton />");
    expect(assistAt).toBeGreaterThan(bar[0]);
    expect(assistAt).toBeLessThan(bar[2]);
    const said = ["Elsie, Assist, Search", "colour theme", "? (help", "the bell"].map((needle) => {
      const at = frame.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
    expect(said).toEqual([...said].sort((a, b) => a - b));
    // Colour theme is rendered by a component declared after the bar; the other three are in bar order.
    expect([bar[0], bar[2], bar[3]]).toEqual([bar[0], bar[2], bar[3]].sort((a, b) => a - b));
  });

  it("is inside BOTH AI system prompts", () => {
    const assistant = read("./routers/assistant.ts");
    const help = read("./routers/helpCenter.ts");
    expect(assistant).toMatch(/import \{ PRODUCT_KNOWLEDGE \} from "\.\.\/productKnowledge"/);
    expect(assistant).toContain("${PRODUCT_KNOWLEDGE}");
    expect(assistant).toContain("whats_waiting first");
    expect(help).toMatch(/import \{ PRODUCT_KNOWLEDGE \} from "\.\.\/productKnowledge"/);
    expect(help).toContain("${PRODUCT_KNOWLEDGE}");
  });
});

describe("Operator's Manual help articles", () => {
  it("are seeded in their own category, first", () => {
    expect(CATEGORIES[0]).toBe(OPERATOR_CATEGORY);
    expect(OPERATOR_ARTICLES.length).toBeGreaterThanOrEqual(12);
    for (const a of OPERATOR_ARTICLES) {
      expect(ARTICLES).toContain(a);
      expect(a.slug.startsWith("om-")).toBe(true);
      expect(a.categorySlug).toBe(OPERATOR_CATEGORY.slug);
    }
  });

  it("cover the routines and the page directory", () => {
    const slugs = new Set(OPERATOR_ARTICLES.map((a) => a.slug));
    for (const s of ["om-how-velocity-fits-together", "om-page-directory", "om-daily-routine", "om-weekly-routine", "om-monthly-routine", "om-revenue-engine-lifecycle", "om-autopilots-and-schedules", "om-glossary", "om-troubleshooting"]) {
      expect(slugs.has(s), s).toBe(true);
    }
    // Every rail tool is named in the page directory by href.
    const dir = OPERATOR_ARTICLES.find((a) => a.slug === "om-page-directory")!.bodyMarkdown;
    const missing = TOOLS.filter((t) => t.primary && !dir.includes(t.href)).map((t) => t.href);
    expect(missing).toEqual([]);
  });

  it("only link to articles that exist and pages that exist", () => {
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    const bad: string[] = [];
    for (const a of OPERATOR_ARTICLES) {
      for (const m of a.bodyMarkdown.matchAll(/\]\((\/[^)\s]+)\)/g)) {
        const href = m[1];
        const art = href.match(/^\/help\/articles\/([a-z0-9-]+)$/);
        if (art) { if (!slugs.has(art[1])) bad.push(`${a.slug} → ${href}`); continue; }
        if (!hrefResolves(href)) bad.push(`${a.slug} → ${href}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("use only markdown the article renderer supports", () => {
    const renderer = read("../client/src/pages/usip/HelpArticle.tsx");
    // bold, code, links and pipe tables are rendered — not shown as literal asterisks.
    expect(renderer).toContain("export function renderInline");
    expect(renderer).toContain("export function splitTableRow");
    expect(renderer).toContain("flushTable()");
    for (const a of OPERATOR_ARTICLES) {
      expect(a.bodyMarkdown, a.slug).not.toMatch(/^>\s/m); // no blockquotes
      expect(a.bodyMarkdown, a.slug).not.toMatch(/!\[/); // no images
    }
  });
});
