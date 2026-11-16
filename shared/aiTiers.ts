/**
 * AI model tiers (owner 2026-11-16).
 *
 * Until now a workspace had ONE model for everything: its default provider's
 * model, the built-in cheap one unless an admin typed another. That is the
 * right price for sorting a reply and the wrong tool for writing to a
 * prospect, and there was no way to say so.
 *
 * Three tiers, each a provider and a model the workspace's admin picks:
 *
 *   fast      high volume, low stakes: scores, sorting, short suggestions
 *   standard  ordinary work: chat, help answers, research on a record
 *   deep      what a prospect reads, and who a campaign goes after
 *
 * Every AI call names its TASK (the kind of work it is). A task has a default
 * tier here, in code, and a workspace may move any task to another tier.
 *
 * NOTHING CHANGES UNTIL A TIER IS SET. A tier with no model resolves to the
 * workspace's default provider and model, exactly as before this existed, so
 * a workspace that never opens the setting behaves as it always has.
 *
 * Pure and shared: the server routes with it, the settings screen renders it.
 */

export const AI_TIERS = ["fast", "standard", "deep"] as const;
export type AiTier = (typeof AI_TIERS)[number];

export const AI_TIER_LABEL: Record<AiTier, string> = { fast: "Fast", standard: "Standard", deep: "Deep" };

export const AI_TIER_HINT: Record<AiTier, string> = {
  fast: "The cheapest model you trust for sorting, scoring and short suggestions.",
  standard: "Everyday work: Elsie's chat, help answers, research on a record.",
  deep: "Your strongest model: what a prospect reads, and who a campaign targets.",
};

export const AI_PROVIDER_IDS = ["anthropic", "openai", "gemini"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type AiTaskInfo = { label: string; detail: string; defaultTier: AiTier };

/**
 * The kinds of work the app asks a model to do. Each invokeLLM / streamLLM
 * call names one (server/aiTiers.test.ts fails a call that names none).
 * The order here is the order the settings screen lists them in.
 */
export const AI_TASKS = {
  outreach: {
    label: "Emails and messages to prospects",
    detail: "Sequence and campaign emails, reply drafts, LinkedIn notes, subject lines, follow-ups.",
    defaultTier: "deep",
  },
  targeting: {
    label: "Campaign targeting and ICP",
    detail: "Who a campaign goes after, the ideal-customer profile, proposed campaigns.",
    defaultTier: "deep",
  },
  documents: {
    label: "Proposals and briefs",
    detail: "Proposal sections, account briefs, QBR prep, deal intelligence.",
    defaultTier: "standard",
  },
  enrichment: {
    label: "Research on a person or company",
    detail: "The enrichment agent, web and news lookups, buying signals.",
    defaultTier: "standard",
  },
  elsie: {
    label: "Elsie's chat",
    detail: "Her answers and the actions she proposes. A turn that looks things up moves up one tier for its answer.",
    defaultTier: "standard",
  },
  help: {
    label: "Help Center answers",
    detail: "Ask AI in the Help Center, and article drafts.",
    defaultTier: "standard",
  },
  chat_agent: {
    label: "Website chat agent",
    detail: "What the chat agent on your site says to a visitor.",
    defaultTier: "standard",
  },
  replies: {
    label: "Reading replies",
    detail: "Classifying a reply (interested, not now, out of office, unsubscribe, referral) and its sentiment.",
    defaultTier: "fast",
  },
  scoring: {
    label: "Scoring and sorting",
    detail: "Fit, churn and quality scores, inbox triage, routing a prospect to a campaign.",
    defaultTier: "fast",
  },
  suggestions: {
    label: "Suggestions and summaries for the team",
    detail: "Next-best actions, the task and deal autopilots, meeting and knowledge summaries.",
    defaultTier: "fast",
  },
  general: {
    label: "Everything else",
    detail: "Any AI call that fits none of the above.",
    defaultTier: "standard",
  },
} as const satisfies Record<string, AiTaskInfo>;

export type AiTask = keyof typeof AI_TASKS;
export const AI_TASK_IDS = Object.keys(AI_TASKS) as AiTask[];

export type TierModel = { provider: AiProviderId; model: string };
/** What an admin has set. A tier that is absent is "not set". */
export type TierModels = Partial<Record<AiTier, TierModel>>;
/** A workspace's own choices of tier per task; a task that is absent uses its default. */
export type TaskTiers = Partial<Record<AiTask, AiTier>>;

export function isAiTier(v: unknown): v is AiTier {
  return typeof v === "string" && (AI_TIERS as readonly string[]).includes(v);
}
export function isAiTask(v: unknown): v is AiTask {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(AI_TASKS, v);
}
export function isAiProviderId(v: unknown): v is AiProviderId {
  return typeof v === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(v);
}

/** Whatever is stored, read back as only the well-formed parts of it. */
export function cleanTierModels(raw: unknown): TierModels {
  const out: TierModels = {};
  if (!raw || typeof raw !== "object") return out;
  for (const tier of AI_TIERS) {
    const v = (raw as Record<string, unknown>)[tier] as { provider?: unknown; model?: unknown } | undefined;
    const model = typeof v?.model === "string" ? v.model.trim() : "";
    if (v && isAiProviderId(v.provider) && model) out[tier] = { provider: v.provider, model: model.slice(0, 128) };
  }
  return out;
}

export function cleanTaskTiers(raw: unknown): TaskTiers {
  const out: TaskTiers = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [task, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (isAiTask(task) && isAiTier(tier)) out[task] = tier;
  }
  return out;
}

/** The tier a task runs on in a workspace: its own choice, else the default in code. */
export function tierForTask(task: AiTask, taskTiers: TaskTiers): AiTier {
  return taskTiers[task] ?? AI_TASKS[task].defaultTier;
}

export type TierPick = {
  task: AiTask;
  /** The tier the call ended up on, after any step up. */
  tier: AiTier;
  /** The tier the task is assigned to. */
  baseTier: AiTier;
  /** The model to use, or null: this tier is not set (or its provider has no key), so use the workspace default. */
  use: TierModel | null;
};

/**
 * Which model a call runs on.
 *
 * `stepUp` moves the call up that many tiers, for a turn that turned out to
 * be harder than its task's tier (Elsie after she has looked things up; a
 * reply that failed its format check). A step only ever lands on a tier that
 * IS set and usable: stepping from a set tier onto an unset one would fall
 * back to the workspace default, which may well be the cheaper model, and
 * "harder, so cheaper" is the opposite of the point. With nothing set above,
 * the call stays where it is.
 */
export function pickTierModel(args: {
  task: AiTask | undefined;
  stepUp?: number;
  tiers: TierModels;
  taskTiers: TaskTiers;
  /** Whether this workspace can call that provider at all (a key of its own, a lent one, or the server's). */
  hasKey: (provider: AiProviderId) => boolean;
}): TierPick {
  const task: AiTask = args.task ?? "general";
  const baseTier = tierForTask(task, args.taskTiers);
  const usable = (tier: AiTier): TierModel | null => {
    const m = args.tiers[tier];
    return m && args.hasKey(m.provider) ? m : null;
  };
  let tier = baseTier;
  let steps = Math.max(0, Math.floor(args.stepUp ?? 0));
  for (let i = AI_TIERS.indexOf(baseTier) + 1; i < AI_TIERS.length && steps > 0; i++) {
    if (usable(AI_TIERS[i])) {
      tier = AI_TIERS[i];
      steps--;
    }
  }
  return { task, tier, baseTier, use: usable(tier) };
}

/** True when a step up from this pick would land on a different model. */
export function canStepUp(pick: TierPick, args: { tiers: TierModels; taskTiers: TaskTiers; hasKey: (p: AiProviderId) => boolean }): boolean {
  const next = pickTierModel({ task: pick.task, stepUp: AI_TIERS.indexOf(pick.tier) - AI_TIERS.indexOf(pick.baseTier) + 1, ...args });
  if (next.tier === pick.tier || !next.use) return false;
  return !pick.use || next.use.provider !== pick.use.provider || next.use.model !== pick.use.model;
}
