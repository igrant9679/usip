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

/** Only the events something actually dispatches. */
export function wiredNotifyEventKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < NOTIFY_EVENTS.length; i++) {
    if (NOTIFY_EVENTS[i]!.wired) out.push(NOTIFY_EVENTS[i]!.key);
  }
  return out;
}
