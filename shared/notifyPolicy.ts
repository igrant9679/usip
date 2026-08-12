/**
 * The workspace notification policy — one definition of the events, their
 * labels, their defaults, and WHICH OF THEM ARE ACTUALLY WIRED.
 *
 * 🔴 THE TOGGLES WERE DECORATIVE. `workspace_settings.notifyPolicy` is written
 * by Settings → Notifications and read straight back to render the same
 * switches. NO SEND PATH CONSULTED IT. Turning "New lead routed to me" off
 * changed nothing, because nothing was reading it — and turning it ON changed
 * nothing either, because for that event nothing was SENDING.
 *
 * ⚠️ AND THE TWO COPIES DISAGREED. `admin.ts` seeded
 * `salesReadyCrossed` and `mention` with `email: true`; the Settings tab
 * defaulted every unset key to `email: false`. A workspace that had never saved
 * showed one thing and stored another. Invisible only because the value was
 * inert — exactly the condition under which drift accumulates.
 *
 * `wired` is the honest part. A toggle the user can flip is a promise, the same
 * way a confirm dialog is (a172d7f), so an event that nothing dispatches says
 * so here rather than implying coverage it does not have. Same doctrine as
 * workflowEngine's trigger list: "a trigger with no site here can never fire".
 */

export interface NotifyChannel {
  inApp: boolean;
  email: boolean;
}

export interface NotifyEvent {
  key: string;
  /** Shown in Settings → Notifications. */
  label: string;
  /** Seeded for a workspace that has never saved a policy. */
  defaults: NotifyChannel;
  /**
   * Whether a dispatch site exists. FALSE means the switch is visible and
   * currently does nothing — recorded rather than hidden.
   */
  wired: boolean;
}

export const NOTIFY_EVENTS: readonly NotifyEvent[] = [
  {
    key: "newLeadRouted",
    label: "New lead routed to me",
    defaults: { inApp: true, email: false },
    // Dispatched from routers/forms.ts and routers/landingPages.ts on submit.
    wired: true,
  },
  {
    key: "salesReadyCrossed",
    label: "A lead becomes Sales-Ready",
    defaults: { inApp: true, email: true },
    // routers/leadScoring.ts, on the score crossing tierSalesReadyMin. ALSO
    // gated by the older lead_score_config.notifyOnSalesReady — see there.
    wired: true,
  },
  {
    key: "dealMoved",
    label: "A deal I own moves stage",
    defaults: { inApp: true, email: false },
    // routers/crm.ts setStage, when the stage really changed and the owner is
    // not the person who moved it.
    wired: true,
  },
  {
    key: "taskOverdue",
    label: "One of my tasks is overdue",
    defaults: { inApp: true, email: false },
    // services/workflowEngine.ts runTaskOverdueCron — the same scan that fires
    // the workflow trigger, so both have identical reach.
    wired: true,
  },
  {
    key: "mention",
    label: "Someone @mentions me",
    defaults: { inApp: true, email: true },
    // routers/are/prospects.ts, on a prospect note containing @name.
    wired: true,
  },
];

export type NotifyPolicy = Record<string, NotifyChannel>;

/** The policy a workspace gets before it has ever saved one. */
export function defaultNotifyPolicy(): NotifyPolicy {
  const out: NotifyPolicy = {};
  for (let i = 0; i < NOTIFY_EVENTS.length; i++) {
    const e = NOTIFY_EVENTS[i]!;
    out[e.key] = { inApp: e.defaults.inApp, email: e.defaults.email };
  }
  return out;
}

/**
 * Should this event raise an in-app notification for this workspace?
 *
 * Fails OPEN — an unset or malformed policy notifies. The failure modes are not
 * symmetric: a notification nobody wanted is noise the user can switch off,
 * while a silently dropped one is a lead nobody knows arrived. Every existing
 * default has `inApp: true`, so opening is also what the UI already promises.
 */
export function isInAppEnabled(policy: unknown, eventKey: string): boolean {
  const entry = (policy as NotifyPolicy | null | undefined)?.[eventKey];
  if (!entry || typeof entry !== "object") return true;
  return entry.inApp !== false;
}

/**
 * Should this event ALSO send an email?
 *
 * ⚠️ FAILS CLOSED, which is the opposite of `isInAppEnabled` — and the asymmetry
 * is the decision, not an inconsistency.
 *
 * In-app fails open because a dropped notification is a lead nobody knows
 * arrived; the notification IS the delivery. Email is a second channel on top
 * of an in-app notice that has already been written, so a missing policy costs
 * nobody the information. What it would cost is the other way round: mailing
 * people who never asked to be mailed, from a workspace that has never opened
 * the settings page. Silence is recoverable; unexpected email is not.
 */
export function isEmailEnabled(policy: unknown, eventKey: string): boolean {
  const entry = (policy as NotifyPolicy | null | undefined)?.[eventKey];
  if (!entry || typeof entry !== "object") return false;
  return entry.email === true;
}

/* ─── Per-member overrides ────────────────────────────────────────────────── */

/**
 * A member's own switches, keyed by the SAME event vocabulary.
 *
 * 🔴 THEY USED TO BE A THIRD, UNRELATED VOCABULARY, and nothing joined up.
 * `NotificationPrefs.tsx` saved `newLead, taskDue, dealStageChange, emailReply,
 * sequenceComplete, workflowFired, npsSubmitted, teamInvite`;
 * `team.updateNotifPrefs` accepted `sequence_reply, social_response,
 * workflow_alert, system`; `getNotifPrefs` defaulted to that second set. NONE
 * of the three overlapped the five events the product actually notifies on, and
 * zod strips unknown keys — so the page wrote `{}`, toasted "Preferences
 * saved", and wiped whatever had been there.
 *
 * ⚖️ AN OVERRIDE CAN ONLY NARROW, NEVER WIDEN. The workspace policy is the
 * ceiling: a member may mute an event their admin turned on, but cannot turn on
 * one the admin turned off. Otherwise a per-user setting silently overrules a
 * workspace-wide decision, and the admin panel stops meaning anything.
 *
 * ABSENT MEANS "FOLLOW THE WORKSPACE", not "off". That is what makes the old
 * stored garbage harmless: a row full of `sequence_reply` keys has no entry for
 * any of the five, so every one of them defers to the policy exactly as an
 * untouched member does.
 *
 * 🆕 PER-CHANNEL (2026-08-12, owner-approved): an entry may now be a
 * `{ inApp?, email? }` object so "in-app but no email" is expressible — the
 * second column the page never had. A LEGACY BOOLEAN STAYS MEANINGFUL: `false`
 * mutes both channels (exactly what that switch always did), `true` follows
 * the workspace on both. Absent members and absent keys behave as before.
 */
export interface MemberChannelPref {
  inApp?: boolean;
  email?: boolean;
}
export type MemberNotifyPrefs = Record<string, boolean | MemberChannelPref>;

/** Both channels on for every event — "I have never touched this page". */
export function defaultMemberNotifyPrefs(): Record<string, { inApp: boolean; email: boolean }> {
  const out: Record<string, { inApp: boolean; email: boolean }> = {};
  for (let i = 0; i < NOTIFY_EVENTS.length; i++) {
    out[NOTIFY_EVENTS[i]!.key] = { inApp: true, email: true };
  }
  return out;
}

/**
 * Does this member still want this event's IN-APP notification?
 *
 * Only an EXPLICIT `false` mutes — legacy boolean false (the old both-channel
 * switch) or `{ inApp: false }`. Anything else — absent key, absent object, a
 * stale key from the old vocabulary — defers to the workspace policy.
 */
export function memberWantsInApp(prefs: unknown, eventKey: string): boolean {
  const p = prefs as MemberNotifyPrefs | null | undefined;
  if (!p || typeof p !== "object") return true;
  const entry = p[eventKey];
  if (entry === false) return false;
  if (entry && typeof entry === "object") return entry.inApp !== false;
  return true;
}

/** Same contract for the email copy. */
export function memberWantsEmail(prefs: unknown, eventKey: string): boolean {
  const p = prefs as MemberNotifyPrefs | null | undefined;
  if (!p || typeof p !== "object") return true;
  const entry = p[eventKey];
  if (entry === false) return false;
  if (entry && typeof entry === "object") return entry.email !== false;
  return true;
}

/**
 * Does this member still want this event on ANY channel? Kept because "muted
 * entirely" is a real question (and the pre-channel tests pin the legacy
 * boolean semantics through it).
 */
export function memberWantsEvent(prefs: unknown, eventKey: string): boolean {
  return memberWantsInApp(prefs, eventKey) || memberWantsEmail(prefs, eventKey);
}

/**
 * Drop anything that is not one of the five events, and inside a channel
 * object anything that is not a boolean inApp/email.
 *
 * An allowlist rather than a passthrough, because `notifPrefs` is a JSON blob
 * on a shared row and `z.record(z.string(), …)` would otherwise let a
 * hand-made call write arbitrary keys into it — the hole `a278a39` closed on
 * `customFields`. Also cleans stale keys out on the next save.
 */
export function pickKnownNotifyPrefs(input: Record<string, unknown>): MemberNotifyPrefs {
  const out: MemberNotifyPrefs = {};
  for (let i = 0; i < NOTIFY_EVENTS.length; i++) {
    const k = NOTIFY_EVENTS[i]!.key;
    const v = input[k];
    if (typeof v === "boolean") {
      out[k] = v;
    } else if (v && typeof v === "object") {
      const entry: MemberChannelPref = {};
      const { inApp, email } = v as MemberChannelPref;
      if (typeof inApp === "boolean") entry.inApp = inApp;
      if (typeof email === "boolean") entry.email = email;
      if (Object.keys(entry).length > 0) out[k] = entry;
    }
  }
  return out;
}

/** Only the events something actually dispatches. */
export function wiredNotifyEventKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < NOTIFY_EVENTS.length; i++) {
    if (NOTIFY_EVENTS[i]!.wired) out.push(NOTIFY_EVENTS[i]!.key);
  }
  return out;
}
