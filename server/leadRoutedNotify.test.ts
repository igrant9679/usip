/**
 * A notification switch is a promise, and these five were decorative.
 *
 * `workspace_settings.notifyPolicy` was written by Settings → Notifications and
 * read straight back to render the same switches. NO SEND PATH CONSULTED IT.
 * For "New lead routed to me" both halves were missing: nothing read the policy
 * AND nothing raised the notification — so a public form or landing page could
 * capture a lead, route it to a rep, and tell them nothing, under a toggle that
 * said it would.
 *
 * ⚠️ The two copies of the defaults also disagreed. admin.ts seeded
 * `salesReadyCrossed` and `mention` with `email: true`; the Settings tab
 * defaulted every unset key to `email: false`. Invisible only because the value
 * was inert — which is the condition under which drift accumulates.
 *
 * This wires ONE of the five. The honest part is `wired`, asserted BOTH WAYS
 * below: an event that claims a dispatch site must have one, and an event that
 * does not must not be silently referenced as though it did.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  NOTIFY_EVENTS,
  defaultNotifyPolicy,
  isInAppEnabled,
  wiredNotifyEventKeys,
} from "@shared/notifyPolicy";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      out.push(rel);
    }
  };
  walk("server");
  return out;
}

/* ── The policy helpers, run for real ────────────────────────────────────── */

describe("the policy helpers", () => {
  it("seeds every event, and keeps the defaults that disagreed", () => {
    const p = defaultNotifyPolicy();
    expect(Object.keys(p).sort()).toEqual(NOTIFY_EVENTS.map((e) => e.key).sort());
    // The two the client used to contradict.
    expect(p.salesReadyCrossed).toEqual({ inApp: true, email: true });
    expect(p.mention).toEqual({ inApp: true, email: true });
    expect(p.newLeadRouted).toEqual({ inApp: true, email: false });
  });

  it("returns a fresh object each time", () => {
    // A shared mutable default would let one workspace's edit leak into the next.
    const a = defaultNotifyPolicy();
    a.newLeadRouted!.inApp = false;
    expect(defaultNotifyPolicy().newLeadRouted).toEqual({ inApp: true, email: false });
  });

  it("FAILS OPEN on a missing or malformed policy", () => {
    /**
     * Asymmetric failure modes: an unwanted notification is noise the user can
     * switch off; a dropped one is a lead nobody knows arrived. Every default
     * is inApp:true, so opening is also what the UI already promises.
     */
    expect(isInAppEnabled(undefined, "newLeadRouted")).toBe(true);
    expect(isInAppEnabled(null, "newLeadRouted")).toBe(true);
    expect(isInAppEnabled({}, "newLeadRouted")).toBe(true);
    expect(isInAppEnabled({ newLeadRouted: "yes" }, "newLeadRouted")).toBe(true);
    expect(isInAppEnabled({ other: { inApp: false } }, "newLeadRouted")).toBe(true);
  });

  it("respects an explicit OFF, and only an explicit one", () => {
    expect(isInAppEnabled({ newLeadRouted: { inApp: false, email: false } }, "newLeadRouted")).toBe(false);
    expect(isInAppEnabled({ newLeadRouted: { inApp: true, email: false } }, "newLeadRouted")).toBe(true);
  });

  it("email is tracked but not yet acted on — no path sends one", () => {
    // Recorded rather than implied: the panel offers an email column and
    // nothing in this change sends email. isInAppEnabled is the only consumer.
    expect(NOTIFY_EVENTS.some((e) => e.defaults.email)).toBe(true);
  });
});

/* ── `wired` tells the truth, both directions ────────────────────────────── */

describe("the wired flag is honest", () => {
  const files = serverFiles();
  const sources = files.map((f) => ({ f, src: strip(read(f)) }));

  it("scans real source (floor)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("exactly one event is wired so far, and it is the lead one", () => {
    // Pinned so that wiring another is a deliberate edit here as well as there.
    expect(wiredNotifyEventKeys()).toEqual(["newLeadRouted"]);
  });

  /**
   * Files that CONSULT THE POLICY for a given event key.
   *
   * 🪤 The first version of this searched for the bare string `"mention"` and
   * flagged activities.ts and are/prospects.ts — which use it as a
   * `notifications.kind`, an entirely different enum that happens to share the
   * word. Two namespaces, one spelling. The flag claims "something dispatches
   * this event THROUGH THE POLICY", so that is exactly what gets scanned for,
   * rather than any mention of the word anywhere.
   */
  const policyConsumers = (key: string) =>
    sources
      .filter((s) => new RegExp(`isInAppEnabled\\([^)]*"${key}"`).test(s.src))
      .map((s) => s.f);

  it("every WIRED event is consulted through the policy somewhere", () => {
    for (const key of wiredNotifyEventKeys()) {
      expect(
        policyConsumers(key),
        `${key} is marked wired but nothing calls isInAppEnabled for it`,
      ).not.toEqual([]);
    }
  });

  it("no UNWIRED event is consulted through the policy", () => {
    /**
     * The other direction, and the one that keeps the flag honest. If somebody
     * starts gating `dealMoved` on the policy without flipping its flag, this
     * list would go on advertising it as unimplemented — and the next person to
     * read it would re-do the work.
     */
    const unwired = NOTIFY_EVENTS.filter((e) => !e.wired).map((e) => e.key);
    expect(unwired.length).toBeGreaterThan(0);
    for (const key of unwired) {
      const hits = policyConsumers(key);
      expect(hits, `${key} is marked unwired but ${hits.join(", ")} gates on it`).toEqual([]);
    }
  });
});

/* ── The two public submit paths actually call it ────────────────────────── */

describe("both public capture paths announce the lead", () => {
  const forms = strip(read("server/routers/forms.ts"));
  const landing = strip(read("server/routers/landingPages.ts"));

  it("forms.submit notifies, with the owner it just resolved", () => {
    expect(forms).toMatch(/await notifyLeadRouted\(\{[\s\S]{0,200}?ownerUserId,[\s\S]{0,200}?source: "webform"/);
  });

  it("landingPages.submit notifies, tagged with the page slug", () => {
    expect(landing).toMatch(/await notifyLeadRouted\(\{[\s\S]{0,300}?ownerUserId,[\s\S]{0,300}?source: `landing:\$\{page\.slug\}`/);
  });

  it("both notify AFTER the lead exists, so the deep link resolves", () => {
    for (const [name, src] of [["forms", forms], ["landingPages", landing]] as const) {
      const insert = src.indexOf("db.insert(leads)");
      const notify = src.indexOf("notifyLeadRouted({");
      expect(insert, `${name}: lead insert not found`).toBeGreaterThan(-1);
      expect(notify, `${name}: notify call not found`).toBeGreaterThan(-1);
      expect(notify, `${name}: notifies before the lead is created`).toBeGreaterThan(insert);
    }
  });
});

/* ── The notifier itself ─────────────────────────────────────────────────── */

describe("notifyLeadRouted", () => {
  const src = strip(read("server/services/leadNotifications.ts"));

  it("uses an EXISTING notifications enum value", () => {
    /**
     * `kind` is a mysqlEnum. Inventing a value fails at RUNTIME rather than at
     * compile time because of the `as never` insert cast — the class recorded
     * in d3aefe0 / a278a39. The deep link rides on relatedType/relatedId.
     */
    const KINDS = [
      "mention", "task_assigned", "task_due", "deal_won", "deal_lost", "renewal_due",
      "churn_risk", "approval_request", "workflow_fired", "system", "email_reply", "are_event",
    ];
    const used = /kind: "([a-z_]+)"/.exec(src)?.[1];
    expect(used, "no kind found — re-anchor this test").toBeTruthy();
    expect(KINDS, `"${used}" is not in the notifications enum`).toContain(used!);
    expect(src).toMatch(/relatedType: "lead"/);
    expect(src).toMatch(/relatedId: notice\.leadId/);
  });

  it("re-checks the owner rather than trusting the caller", () => {
    expect(src).toMatch(/const owner = await activeOwnerOrNull\(notice\.workspaceId, notice\.ownerUserId \?\? null\);/);
    expect(src).toMatch(/if \(!owner\) return false;/);
  });

  it("consults the workspace policy before inserting", () => {
    const gate = src.indexOf("isInAppEnabled(");
    const insert = src.indexOf("db.insert(notifications)");
    expect(gate, "the policy is not consulted at all").toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(gate);
    expect(src).toMatch(/if \(!isInAppEnabled\(settings\?\.policy, "newLeadRouted"\)\) return false;/);
  });

  it("cannot throw into a public submit handler", () => {
    // A failed notification must never turn a captured lead into an error page
    // for the person who just filled the form in.
    expect(src).toMatch(/try \{/);
    expect(src).toMatch(/catch \(e\) \{[\s\S]{0,200}?return false;/);
  });

  it("does nothing when there is no lead to point at", () => {
    expect(src).toMatch(/if \(!notice\.leadId\) return false;/);
  });
});

/* ── One definition of the defaults ──────────────────────────────────────── */

describe("the defaults are no longer written twice", () => {
  it("the server seeds from the shared definition", () => {
    const admin = strip(read("server/routers/admin.ts"));
    expect(admin).toMatch(/const DEFAULT_NOTIFY_POLICY = defaultNotifyPolicy\(\);/);
    expect(admin, "admin.ts still carries its own event literal")
      .not.toMatch(/salesReadyCrossed:\s*\{\s*inApp/);
  });

  it("the Settings tab renders from the shared definition", () => {
    const ui = read("client/src/pages/usip/Settings.tsx");
    expect(ui).toMatch(/^import \{ NOTIFY_EVENTS, type NotifyPolicy \} from "@shared\/notifyPolicy";$/m);
    expect(ui, "the client still carries its own event list")
      .not.toMatch(/\{ key: "newLeadRouted", label:/);
    expect(ui, "the client still applies a blanket default")
      .not.toMatch(/\?\? \{ inApp: true, email: false \}/);
    expect(ui).toMatch(/merged\[key\] = p\[key\] \?\? \{ \.\.\.defaults \};/);
  });
});
