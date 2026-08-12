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
  defaultMemberNotifyPrefs,
  defaultNotifyPolicy,
  isEmailEnabled,
  isInAppEnabled,
  memberWantsEmail,
  memberWantsEvent,
  memberWantsInApp,
  pickKnownNotifyPrefs,
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

  it("the email column FAILS CLOSED, unlike the in-app one", () => {
    /**
     * The asymmetry is the decision. In-app fails open because a dropped
     * notification is a lead nobody knows arrived — the notification IS the
     * delivery. Email is a second channel on top of an in-app row that has
     * already been written, so silence costs nobody the information, while the
     * other error mails people who never opened the settings page.
     */
    expect(isEmailEnabled(undefined, "mention")).toBe(false);
    expect(isEmailEnabled(null, "mention")).toBe(false);
    expect(isEmailEnabled({}, "mention")).toBe(false);
    expect(isEmailEnabled({ mention: "yes" }, "mention")).toBe(false);
    expect(isEmailEnabled({ mention: { inApp: true } }, "mention")).toBe(false);
    // …and the in-app one still fails OPEN on the same inputs.
    expect(isInAppEnabled(undefined, "mention")).toBe(true);
    expect(isInAppEnabled({}, "mention")).toBe(true);
  });

  it("email requires an explicit true, not merely truthy", () => {
    expect(isEmailEnabled({ mention: { inApp: true, email: true } }, "mention")).toBe(true);
    expect(isEmailEnabled({ mention: { inApp: true, email: false } }, "mention")).toBe(false);
    expect(isEmailEnabled({ mention: { inApp: true, email: 1 } } as any, "mention")).toBe(false);
  });
});

/* ── `wired` tells the truth, both directions ────────────────────────────── */

describe("the wired flag is honest", () => {
  const files = serverFiles();
  const sources = files.map((f) => ({ f, src: strip(read(f)) }));

  it("scans real source (floor)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("ALL FIVE events are wired now — the panel makes five promises", () => {
    // Pinned as the full set: unwiring one has to be a deliberate edit here.
    expect(wiredNotifyEventKeys()).toEqual(NOTIFY_EVENTS.map((e) => e.key));
    expect(wiredNotifyEventKeys()).toEqual([
      "newLeadRouted", "salesReadyCrossed", "dealMoved", "taskOverdue", "mention",
    ]);
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
      .filter((s) =>
        // Either a dispatch site naming the event…
        new RegExp(`event: "${key}"`).test(s.src) ||
        // …or a direct policy read, which is how the single-event version of
        // this worked before notifyIfEnabled generalised the gate.
        new RegExp(`isInAppEnabled\\([^)]*"${key}"`).test(s.src),
      )
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
     * The other direction, and the one that keeps the flag honest: an event
     * marked unimplemented must not quietly acquire a dispatch site, or the
     * next person to read the list re-does the work.
     *
     * Vacuous TODAY because all five are wired, and deliberately kept — the
     * moment a sixth event is added `wired: false` this starts doing work
     * again, which is exactly when it is needed.
     */
    for (const key of NOTIFY_EVENTS.filter((e) => !e.wired).map((e) => e.key)) {
      const hits = policyConsumers(key);
      expect(hits, `${key} is marked unwired but ${hits.join(", ")} gates on it`).toEqual([]);
    }
  });

  it("each event is dispatched from the file its comment names", () => {
    /**
     * The forward check above only proves SOMETHING consults the key. This
     * pins WHERE, so moving a dispatch site without updating the list — or
     * losing one entirely while another file still mentions the key — fails.
     */
    const SITES: Record<string, string> = {
      newLeadRouted: "server/services/policyNotify.ts",
      salesReadyCrossed: "server/routers/leadScoring.ts",
      dealMoved: "server/routers/crm.ts",
      taskOverdue: "server/services/workflowEngine.ts",
      mention: "server/routers/are/prospects.ts",
    };
    expect(Object.keys(SITES).sort()).toEqual(NOTIFY_EVENTS.map((e) => e.key).sort());
    for (const [key, file] of Object.entries(SITES)) {
      const src = strip(read(file));
      expect(
        new RegExp(`event: "${key}"`).test(src),
        `${key} is not dispatched from ${file}`,
      ).toBe(true);
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

describe("the shared gate", () => {
  const src = strip(read("server/services/policyNotify.ts"));

  it("every kind reaching the insert is in the notifications enum", () => {
    /**
     * `kind` is a mysqlEnum and the insert is cast `as never`, so an invented
     * value fails at RUNTIME rather than compile time (d3aefe0, a278a39). The
     * union in policyNotify.ts is what turns that into a type error, so BOTH
     * are checked: the union matches the schema, and every literal a call site
     * passes is in it.
     */
    const KINDS = [
      "mention", "task_assigned", "task_due", "deal_won", "deal_lost", "renewal_due",
      "churn_risk", "approval_request", "workflow_fired", "system", "email_reply", "are_event",
    ];
    const declared = /export type NotificationKind =([\s\S]*?);/.exec(src)?.[1] ?? "";
    expect(declared, "the kind union was not found — re-anchor this test").not.toBe("");
    for (const k of KINDS) {
      expect(declared, `${k} is missing from NotificationKind`).toContain(`"${k}"`);
    }

    // …and every kind any dispatch site actually passes.
    for (const f of serverFiles()) {
      const fsrc = strip(read(f));
      for (const m of fsrc.matchAll(/notifyIfEnabled\(\{[\s\S]{0,400}?kind: "([a-z_]+)"/g)) {
        expect(KINDS, `${f} passes kind "${m[1]}", which is not in the enum`).toContain(m[1]!);
      }
    }
  });

  it("re-checks the recipient rather than trusting the caller", () => {
    expect(src).toMatch(/const userId = await activeOwnerOrNull\(notice\.workspaceId, notice\.userId \?\? null\);/);
    expect(src).toMatch(/if \(!userId\) return false;/);
  });

  it("consults the workspace policy before inserting, per channel", () => {
    const gate = src.indexOf("isInAppEnabled(");
    const insert = src.indexOf("db.insert(notifications)");
    expect(gate, "the policy is not consulted at all").toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(gate);
    // Each channel = workspace policy AND the member's own channel switch;
    // the insert runs only under wantInApp, the mail only under wantEmail.
    expect(src).toMatch(/const wantInApp = isInAppEnabled\(settings\?\.policy, notice\.event\)\s*&& memberWantsInApp\(member\?\.prefs, notice\.event\);/);
    expect(src).toMatch(/const wantEmail = isEmailEnabled\(settings\?\.policy, notice\.event\)\s*&& memberWantsEmail\(member\?\.prefs, notice\.event\);/);
    expect(src).toMatch(/if \(!wantInApp && !wantEmail\) return false;/);
    expect(src).toMatch(/if \(wantInApp\) \{\s*await db\.insert\(notifications\)/);
    expect(src).toMatch(/if \(wantEmail\) \{\s*void sendPolicyEmail/);
  });

  it("an extra per-event veto is ANDed, never ignored", () => {
    // salesReadyCrossed carries a second, older switch. Either being off is a
    // user saying no; neither may override the other.
    expect(src).toMatch(/if \(notice\.alsoRequire === false\) return false;/);
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

  it("every dispatch carries a deep link", () => {
    /**
     * 🔴 ADDED AFTER A MUTATION PASSED. Rewriting this block for the five-event
     * gate dropped the assertion that the lead notification carries
     * relatedType/relatedId, and blanking the link went unnoticed. The bell
     * navigates on those two fields; without them a notification is a dead end
     * that tells someone a lead arrived and gives them no way to reach it.
     *
     * Checked for EVERY call site, not just the lead one, so a new event
     * cannot be added without a destination.
     */
    /**
     * Bounded by the NEXT call rather than by a closing `})`. The first version
     * matched `[\s\S]{0,600}?\}\)` and terminated inside a template literal —
     * `${breakdown.total})` ends with `})` — so it cut the leadScoring call in
     * half and failed on correct code. Brace-matching by regex through
     * interpolated strings does not work; a call-to-call window does.
     */
    for (const f of serverFiles()) {
      const fsrc = strip(read(f));
      const parts = fsrc.split("notifyIfEnabled({");
      for (let i = 1; i < parts.length; i++) {
        const call = parts[i]!.slice(0, 800);
        expect(call, `${f}: a notifyIfEnabled call has no relatedType`).toMatch(/relatedType:/);
        expect(call, `${f}: a notifyIfEnabled call has no relatedId`).toMatch(/relatedId:/);
      }
    }
    // …and the lead one points at the lead it just created.
    expect(src).toMatch(/relatedType: "lead",\s*relatedId: notice\.leadId,/);
  });
});

/* ── Per-member overrides ────────────────────────────────────────────────── */

describe("a member's own switches", () => {
  it("only an EXPLICIT false mutes — and a legacy boolean still mutes BOTH channels", () => {
    /**
     * Absent means "follow the workspace", never "off". That is what makes the
     * old stored vocabulary harmless — a row full of `sequence_reply` keys has
     * no entry for any of the five events, so each defers to the policy exactly
     * as an untouched member does, rather than muting everything.
     */
    for (const wants of [memberWantsInApp, memberWantsEmail, memberWantsEvent]) {
      expect(wants(undefined, "mention")).toBe(true);
      expect(wants(null, "mention")).toBe(true);
      expect(wants({}, "mention")).toBe(true);
      expect(wants({ sequence_reply: false, workflow_alert: false }, "mention")).toBe(true);
      expect(wants({ mention: true }, "mention")).toBe(true);
      // The pre-channel switch: one false silences the event everywhere.
      expect(wants({ mention: false }, "mention")).toBe(false);
    }
  });

  it("per-channel prefs mute exactly the named channel", () => {
    // The whole point of the second column: in-app off, email still on…
    expect(memberWantsInApp({ mention: { inApp: false } }, "mention")).toBe(false);
    expect(memberWantsEmail({ mention: { inApp: false } }, "mention")).toBe(true);
    // …and the mirror.
    expect(memberWantsInApp({ mention: { email: false } }, "mention")).toBe(true);
    expect(memberWantsEmail({ mention: { email: false } }, "mention")).toBe(false);
    // An empty object mutes nothing; memberWantsEvent is the OR of the two.
    expect(memberWantsEvent({ mention: {} }, "mention")).toBe(true);
    expect(memberWantsEvent({ mention: { inApp: false, email: false } }, "mention")).toBe(false);
    expect(memberWantsEvent({ mention: { inApp: false } }, "mention")).toBe(true);
  });

  it("defaults every event ON, both channels", () => {
    const p = defaultMemberNotifyPrefs();
    expect(Object.keys(p).sort()).toEqual(NOTIFY_EVENTS.map((e) => e.key).sort());
    expect(Object.values(p).every((v) => v.inApp === true && v.email === true)).toBe(true);
  });

  it("the allowlist drops anything outside the five events", () => {
    /**
     * `notifPrefs` is a JSON blob on a shared row and the input is now a
     * record, so without this an arbitrary key could be written into it — the
     * hole a278a39 closed on customFields. It also cleans the stale vocabulary
     * out on the next save.
     */
    const cleaned = pickKnownNotifyPrefs({
      mention: false,
      dealMoved: true,
      sequence_reply: false,
      linkedinUrl: true,
      __proto__: true,
    } as any);
    expect(cleaned).toEqual({ dealMoved: true, mention: false });
  });

  it("the allowlist sanitises channel objects the same way", () => {
    const cleaned = pickKnownNotifyPrefs({
      mention: { inApp: false, email: true, extra: "nope" },
      dealMoved: { inApp: "false" }, // nothing boolean survives → dropped
      taskOverdue: { email: false },
    } as any);
    expect(cleaned).toEqual({
      mention: { inApp: false, email: true },
      taskOverdue: { email: false },
    });
  });

  it("ignores non-boolean values rather than coercing them", () => {
    expect(pickKnownNotifyPrefs({ mention: "false" } as any)).toEqual({});
    expect(pickKnownNotifyPrefs({ mention: 0 } as any)).toEqual({});
  });

  it("can only NARROW the workspace policy, never widen it", () => {
    /**
     * The AND that enforces it lives in policyNotify: each channel's want is
     * `workspacePolicy && memberSwitch`, so a member's `true` cannot deliver
     * an event the admin switched off. Asserted structurally because the two
     * reads are DB-backed.
     */
    const src = strip(read("server/services/policyNotify.ts"));
    expect(src).toMatch(/isInAppEnabled\(settings\?\.policy, notice\.event\)\s*&& memberWantsInApp\(member\?\.prefs, notice\.event\)/);
    expect(src).toMatch(/isEmailEnabled\(settings\?\.policy, notice\.event\)\s*&& memberWantsEmail\(member\?\.prefs, notice\.event\)/);
  });

  it("the member's prefs are read from their own membership row", () => {
    /**
     * 🪤 BOUNDED TO THE PREFS LOOKUP. The first version asserted
     * `eq(workspaceMembers.workspaceId, …)` against the WHOLE FILE — which the
     * email address lookup further down also contains, so dropping the scope
     * from THIS query left the assertion green. The b15490d weakness exactly: a
     * file-level match is not a per-statement check.
     *
     * It matters: without the workspace term, a member of two workspaces has
     * one workspace's mute applied in the other, and `.limit(1)` picks whichever
     * row the database feels like.
     */
    const src = strip(read("server/services/policyNotify.ts"));
    const at = src.indexOf(".select({ prefs: workspaceMembers.notifPrefs })");
    expect(at, "the prefs lookup was not found — re-anchor this test").toBeGreaterThan(-1);
    const end = src.indexOf("memberWantsInApp(member?.prefs", at);
    expect(end, "could not bound the prefs lookup").toBeGreaterThan(at);
    const lookup = src.slice(at, end);

    expect(lookup, "the prefs lookup is not scoped to the workspace")
      .toMatch(/eq\(workspaceMembers\.workspaceId, notice\.workspaceId\)/);
    expect(lookup).toMatch(/eq\(workspaceMembers\.userId, userId\)/);
  });

  it("the server accepts and returns the FIVE events, not the old vocabulary", () => {
    const admin = strip(read("server/routers/admin.ts"));
    // The zod value is legacy-boolean OR the strict per-channel object.
    expect(admin).toMatch(/notifPrefs: z\.record\(z\.string\(\), z\.union\(\[\s*z\.boolean\(\),\s*z\.object\(\{ inApp: z\.boolean\(\)\.optional\(\), email: z\.boolean\(\)\.optional\(\) \}\)\.strict\(\),\s*\]\)\)\.optional\(\)/);
    expect(admin).toMatch(/patch\.notifPrefs = pickKnownNotifyPrefs\(input\.notifPrefs\)/);
    // getNotifPrefs normalises whatever is stored to five events x two channels.
    expect(admin).toMatch(/inApp: memberWantsInApp\(stored, key\)/);
    expect(admin).toMatch(/email: memberWantsEmail\(stored, key\)/);
    for (const stale of ["sequence_reply", "social_response", "workflow_alert"]) {
      expect(admin, `${stale} is still in the prefs vocabulary`).not.toMatch(
        new RegExp(`${stale}: z\\.boolean`),
      );
    }
  });

  it("the page renders the shared event list, not eight of its own", () => {
    const ui = read("client/src/pages/usip/NotificationPrefs.tsx");
    expect(ui).toMatch(/^import \{ NOTIFY_EVENTS \} from "@shared\/notifyPolicy";$/m);
    expect(ui).toMatch(/const PREF_ITEMS = NOTIFY_EVENTS;/);
    for (const invented of ["newLead", "taskDue", "dealStageChange", "npsSubmitted", "teamInvite"]) {
      expect(ui, `${invented} is back in the page's own list`).not.toMatch(
        new RegExp(`key: "${invented}"`),
      );
    }
  });
});

/* ── The email column ────────────────────────────────────────────────────── */

describe("the email leg", () => {
  const src = strip(read("server/services/policyNotify.ts"));

  it("the mail DISPATCH still runs after the in-app write, when both are wanted", () => {
    /**
     * Order, not just presence — but the guarantee narrowed on 2026-08-12:
     * with per-channel prefs a member may choose email-only, so "a row always
     * precedes mail" became "the in-app write, when wanted, happens first".
     * An SMTP failure still can never cost anyone an in-app notice.
     */
    const insert = src.indexOf("db.insert(notifications)");
    const send = src.indexOf("void sendPolicyEmail(");
    expect(insert, "the in-app insert was not found").toBeGreaterThan(-1);
    expect(send, "the email dispatch was not found").toBeGreaterThan(-1);
    expect(send, "mail is dispatched before the notification is written").toBeGreaterThan(insert);
  });

  it("is gated on the policy's email flag AND the member's email switch, not the in-app pair", () => {
    expect(src).toMatch(/const wantEmail = isEmailEnabled\(settings\?\.policy, notice\.event\)\s*&& memberWantsEmail\(member\?\.prefs, notice\.event\);/);
    expect(src).toMatch(/if \(wantEmail\) \{\s*void sendPolicyEmail/);
  });

  it("cannot break the caller when SMTP fails", () => {
    // Several dispatch sites are public submit handlers; a mail round-trip must
    // not sit inside a prospect's form POST, and a bounce must not surface.
    expect(src).toMatch(/void sendPolicyEmail\(notice, userId\)\.catch\(/);
  });

  it("addresses the member through their membership row", () => {
    /**
     * `notifEmail` is a personal address that may differ from the login one.
     * Both are read via workspaceMembers joined to users, so this cannot mail
     * somebody outside the workspace even if a userId were wrong.
     */
    /**
     * 🪤 BOUNDED, for the reason the prefs lookup above had to be: once TWO
     * queries in this file scope on `workspaceMembers.workspaceId`, a
     * whole-file match proves nothing about either. Adding the member-prefs
     * read is what made this one blind, and the mutation caught it the same
     * day it was introduced.
     */
    const at = src.indexOf("notifEmail: workspaceMembers.notifEmail, loginEmail: users.email");
    expect(at, "the address lookup was not found — re-anchor this test").toBeGreaterThan(-1);
    const end = src.indexOf("const to =", at);
    expect(end, "could not bound the address lookup").toBeGreaterThan(at);
    const lookup = src.slice(at, end);

    expect(lookup, "the address lookup is not scoped to the workspace")
      .toMatch(/eq\(workspaceMembers\.workspaceId, notice\.workspaceId\)/);
    expect(lookup).toMatch(/eq\(workspaceMembers\.userId, userId\)/);
    expect(src).toMatch(/const to = \(row\?\.notifEmail \?\? row\?\.loginEmail \?\? ""\)\.trim\(\);/);
    expect(src).toMatch(/if \(!to\) return;/);
  });

  it("ESCAPES every value it interpolates into the HTML", () => {
    /**
     * 🔒 Titles and bodies carry prospect names, note text and deal names —
     * attacker-influenced strings on the public capture paths. areEngine's
     * textToHtml already had to learn this: a URL containing a double quote
     * closed the attribute and everything after it parsed as more attributes.
     */
    expect(src).toMatch(/const title = escapeHtml\(notice\.title\);/);
    expect(src).toMatch(/const body = notice\.body \? escapeHtml\(notice\.body\) : "";/);
    expect(src).toMatch(/href="\$\{escapeHtml\(link\)\}"/);
    /**
     * The raw fields must never reach the template directly.
     *
     * ⚠️ THE FOUND-CHECK IS LOAD-BEARING. `indexOf` returns -1 when the token
     * is gone and `slice(-1)` is the LAST CHARACTER of the file, against which
     * a `.not.toMatch` passes vacuously forever. Rename `html:` in the mailer
     * call — a plausible refactor — and without this line the XSS guard below
     * would go quietly green while nothing was being checked at all.
     */
    const htmlAt = src.indexOf("html:");
    expect(htmlAt, "`html:` not found in policyNotify.ts — re-anchor this test").toBeGreaterThan(-1);
    const html = src.slice(htmlAt);
    expect(html, "an unescaped value reaches the email body").not.toMatch(/\$\{notice\.(title|body)\}/);
  });

  it("says why the recipient is getting it", () => {
    // Internal mail still needs to explain itself, or the first reaction is
    // "who signed me up for this" rather than "I should turn that off".
    expect(src).toMatch(/Settings → Notifications/);
  });
});

/* ── The four events wired in this pass ──────────────────────────────────── */

describe("the four dispatch sites added here", () => {
  it("salesReadyCrossed ANDs the older per-workspace switch", () => {
    /**
     * `lead_score_config.notifyOnSalesReady` predates the Settings panel and was
     * the ONLY thing gating this notification — so an admin could turn "A lead
     * becomes Sales-Ready" off in Settings and keep receiving them. Both are
     * honoured now; neither silently wins.
     */
    const src = strip(read("server/routers/leadScoring.ts"));
    expect(src).toMatch(/event: "salesReadyCrossed"/);
    expect(src).toMatch(/alsoRequire: cfgRow\?\.notifyOnSalesReady \?\? true/);
    /**
     * The direct insert it replaced must not come back — that is what bypassed
     * both the policy and the membership check. Passing `userId:
     * lead.ownerUserId` INTO the gate is correct and is not what this forbids;
     * an earlier version of this assertion banned the field name and failed on
     * the fix itself.
     */
    expect(src, "leadScoring writes notifications directly again, bypassing the gate")
      .not.toMatch(/db\.insert\(notifications\)/);
  });

  it("dealMoved fires only on a REAL move, and not back at the mover", () => {
    /**
     * The Kanban re-issues setStage when a card is dropped in the column it
     * came from, and the person moving a deal is usually its owner — without
     * both conditions this is the notification that teaches people to ignore
     * the bell.
     */
    const src = strip(read("server/routers/crm.ts"));
    expect(src).toMatch(
      /if \(before\.stage !== input\.stage && before\.ownerUserId && before\.ownerUserId !== ctx\.user\.id\)/,
    );
    expect(src).toMatch(/event: "dealMoved"/);
  });

  it("taskOverdue rides the cron that already finds the tasks", () => {
    const src = strip(read("server/services/workflowEngine.ts"));
    expect(src).toMatch(/event: "taskOverdue"/);
    // Inside the same per-task loop as the trigger, so the two cannot drift in
    // which tasks they cover.
    const loop = src.indexOf("for (const t of due) {");
    const notify = src.indexOf(`event: "taskOverdue"`);
    const fire = src.indexOf(`fireWorkflowRules(t.workspaceId, "task_overdue"`);
    expect(loop, "the due-task loop was not found").toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(loop);
    expect(fire).toBeGreaterThan(notify);
  });

  it("mention goes through the gate per recipient, not a bulk insert", () => {
    /**
     * The member lookup feeding it joins workspaceMembers with NO deactivatedAt
     * filter, so a departed colleague still matched a name and was still
     * notified. Routing each recipient through the gate is what re-resolves
     * them; a bulk insert cannot.
     */
    const src = strip(read("server/routers/are/prospects.ts"));
    expect(src).toMatch(/for \(const uid of mentionedUserIds\) \{/);
    expect(src).toMatch(/event: "mention"/);
    expect(src, "the bulk mention insert came back")
      .not.toMatch(/db\.insert\(notifications\)\.values\(\s*mentionedUserIds\.map/);
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
