/**
 * ProspectSourceRegistry — resolves adapters by slug, filters them by the
 * workspace's credentials, capability match, budget and circuit state, and
 * returns them in the workspace's checking order.
 *
 * ADDING A VENDOR = one adapter file + one line in SOURCE_FACTORIES. The
 * `Record<ProspectSourceSlug, …>` type makes a vocabulary entry without a
 * factory a compile error (the areSources rule, applied here too).
 *
 * Priority: the workspace's existing `areSourceOrder` / `areScraperSources`
 * (the ONE order+mask resolver, @shared/areSources.resolveSourceOrder) is
 * the tenant's waterfall order for the vendors it names; vendors it does
 * not name (stubs) fall in after, ranked by rankSourcesForQuery (free
 * preview first, then native support of the lead filter).
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  PROSPECT_SOURCE_SLUGS,
  matchCapabilities,
  rankSourcesForQuery,
  type CapabilityMatch,
  type ProspectSourceSlug,
  type SearchCriteria,
  type SourceCapabilities,
} from "@shared/prospectSources";
import { ARE_SOURCE_IDS, resolveSourceOrder, type AreSourceId } from "@shared/areSources";
import type { BudgetSnapshot, ProspectSource, SourceCredentials } from "./types";
import { credentialView, loadCredentials, type CredentialRowView } from "./credentials";
import { circuitState, type CircuitState } from "./circuit";
import { remainingUnits } from "./ledger";
import { createWarmySenderSource } from "./adapters/warmysender";
import { createQuickEnrichSource } from "./adapters/quickenrich";
import { createApolloSource } from "./adapters/apollo";
import { createHunterSource, createLemlistSource } from "./adapters/stubs";

const SOURCE_FACTORIES: Record<ProspectSourceSlug, () => ProspectSource> = {
  warmysender: createWarmySenderSource,
  quickenrich: createQuickEnrichSource,
  apollo: createApolloSource,
  hunter: createHunterSource,
  lemlist: createLemlistSource,
};

const instances = new Map<ProspectSourceSlug, ProspectSource>();

export function getSource(slug: ProspectSourceSlug): ProspectSource {
  let s = instances.get(slug);
  if (!s) { s = SOURCE_FACTORIES[slug](); instances.set(slug, s); }
  return s;
}

export function listSources(): ProspectSource[] {
  return PROSPECT_SOURCE_SLUGS.map((s) => getSource(s));
}

/** Test seam — swap an adapter (e.g. a fake WarmySender) for one run. */
export function _overrideSource(slug: ProspectSourceSlug, s: ProspectSource | null): void {
  if (s) instances.set(slug, s); else instances.delete(slug);
}

export interface SourceStatus {
  slug: ProspectSourceSlug;
  displayName: string;
  docsUrl: string;
  capabilities: SourceCapabilities;
  acquisition: "on_demand" | "none";
  implemented: boolean;
  /** Workspace-wide enable mask (Settings → Revenue Engine → sources). */
  enabled: boolean;
  /** Position in the workspace's checking order (0-based), null when unordered. */
  order: number | null;
  credential: Omit<CredentialRowView, "config"> & { config: Record<string, unknown> };
  circuit: CircuitState;
  budget: BudgetSnapshot[];
  /** Ledger-derived headroom for the leads bucket: null = uncapped/untracked. */
  leadsRemaining: number | null;
  match: CapabilityMatch | null;
}

function isImplemented(s: ProspectSource): boolean {
  return s.slug !== "hunter" && s.slug !== "lemlist";
}

async function workspaceOrder(workspaceId: number): Promise<{ order: AreSourceId[]; mask: Record<string, unknown> }> {
  const db = await getDb();
  let row: { order: unknown; mask: unknown } | undefined;
  if (db) {
    [row] = await db
      .select({ order: workspaceSettings.areSourceOrder, mask: workspaceSettings.areScraperSources })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
  }
  const mask = (row?.mask && typeof row.mask === "object" ? row.mask : {}) as Record<string, unknown>;
  // Order ignoring the mask (so a disabled source still reports its slot).
  const order = resolveSourceOrder(row?.order, {}, ARE_SOURCE_IDS);
  return { order, mask };
}

/**
 * Everything the UI needs per source: manifest, credential status, circuit,
 * live budget and — given criteria — the capability verdict.
 */
export async function describeSources(workspaceId: number, criteria?: SearchCriteria | null): Promise<SourceStatus[]> {
  const { order, mask } = await workspaceOrder(workspaceId);
  const out: SourceStatus[] = [];
  const sources = listSources();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const cred = await credentialView(workspaceId, s);
    const creds = cred.configured ? await loadCredentials(workspaceId, s) : null;
    const caps = s.capabilities(creds);
    const circuit = await circuitState(workspaceId, s.slug, s.credentialMode);
    let budget: BudgetSnapshot[] = [];
    let leadsRemaining: number | null = null;
    if (creds) {
      try { budget = await s.remainingBudget(creds); } catch { budget = []; }
      const periods = s.budgetPeriods({ now: new Date(), credentials: creds });
      if (periods.length > 0) {
        leadsRemaining = (await remainingUnits(workspaceId, s.slug, "leads", periods)).total;
      } else {
        const lead = budget.find((b) => b.bucket === "leads");
        leadsRemaining = lead ? lead.remaining : null;
      }
    }
    const idx = order.indexOf(s.slug as AreSourceId);
    out.push({
      slug: s.slug, displayName: s.displayName, docsUrl: s.docsUrl, capabilities: caps,
      acquisition: s.acquisition, implemented: isImplemented(s),
      enabled: mask[s.slug] !== false,
      order: idx === -1 ? null : idx,
      credential: cred, circuit, budget, leadsRemaining,
      match: criteria ? matchCapabilities(caps, criteria) : null,
    });
  }
  return out;
}

export interface EligibleSource {
  source: ProspectSource;
  credentials: SourceCredentials;
  capabilities: SourceCapabilities;
  match: CapabilityMatch;
  /** null = uncapped / unknown; 0 never appears here (0 is skipped). */
  leadsRemaining: number | null;
}

export interface SkippedSource {
  slug: ProspectSourceSlug;
  reason: "no_credentials" | "credential_invalid" | "disabled" | "cannot_honour" | "budget_exhausted" | "circuit_open" | "not_implemented" | "not_selected";
  detail: string;
}

/**
 * The waterfall input: eligible sources in checking order, plus why each
 * other source was left out (surfaced in run logs and the source strip).
 * `only` restricts to a campaign's selected sources (its prospectSources).
 */
export async function eligibleFor(
  workspaceId: number,
  criteria: SearchCriteria,
  opts?: { only?: string[] | null; requireFull?: boolean },
): Promise<{ eligible: EligibleSource[]; skipped: SkippedSource[] }> {
  const { order, mask } = await workspaceOrder(workspaceId);
  const eligible: EligibleSource[] = [];
  const skipped: SkippedSource[] = [];
  const sources = listSources();
  const only = opts?.only ? new Set(opts.only) : null;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!isImplemented(s)) { skipped.push({ slug: s.slug, reason: "not_implemented", detail: "registered, not implemented" }); continue; }
    if (only && !only.has(s.slug)) { skipped.push({ slug: s.slug, reason: "not_selected", detail: "not selected for this campaign" }); continue; }
    if (mask[s.slug] === false) { skipped.push({ slug: s.slug, reason: "disabled", detail: "disabled in workspace Settings" }); continue; }
    const creds = await loadCredentials(workspaceId, s);
    if (!creds) { skipped.push({ slug: s.slug, reason: "no_credentials", detail: "no API key for this workspace" }); continue; }
    if (s.credentialMode === "table") {
      const view = await credentialView(workspaceId, s);
      if (view.status === "invalid") { skipped.push({ slug: s.slug, reason: "credential_invalid", detail: view.validationError ?? "key failed validation" }); continue; }
    }
    const caps = s.capabilities(creds);
    const match = matchCapabilities(caps, criteria);
    if (match.verdict === "cannot" || (opts?.requireFull && match.verdict !== "full")) {
      skipped.push({ slug: s.slug, reason: "cannot_honour", detail: match.missing.length ? `cannot filter on ${match.missing.join(", ")}` : "no usable filters" });
      continue;
    }
    const circuit = await circuitState(workspaceId, s.slug, s.credentialMode);
    if (circuit.open) { skipped.push({ slug: s.slug, reason: "circuit_open", detail: `paused after ${circuit.failures} consecutive failures until ${circuit.openUntil?.toISOString() ?? "later"}` }); continue; }
    let leadsRemaining: number | null = null;
    const periods = s.budgetPeriods({ now: new Date(), credentials: creds });
    if (periods.length > 0) {
      leadsRemaining = (await remainingUnits(workspaceId, s.slug, "leads", periods)).total;
    } else {
      try {
        const lead = (await s.remainingBudget(creds)).find((b) => b.bucket === "leads");
        leadsRemaining = lead ? lead.remaining : null;
      } catch { leadsRemaining = null; }
    }
    if (leadsRemaining != null && leadsRemaining <= 0) { skipped.push({ slug: s.slug, reason: "budget_exhausted", detail: "allowance used up for this period" }); continue; }
    eligible.push({ source: s, credentials: creds, capabilities: caps, match, leadsRemaining });
  }
  // Workspace order first (explicit tenant priority), then query-aware rank
  // for anything the workspace never ordered.
  const pos = new Map<string, number>();
  for (let i = 0; i < order.length; i++) pos.set(order[i], i);
  const ordered = eligible.filter((e) => pos.has(e.source.slug)).sort((a, b) => (pos.get(a.source.slug) ?? 0) - (pos.get(b.source.slug) ?? 0));
  const rest = rankSourcesForQuery(eligible.filter((e) => !pos.has(e.source.slug)).map((e) => ({ slug: e.source.slug, capabilities: e.capabilities, e })), criteria).map((x) => x.e);
  return { eligible: ordered.concat(rest), skipped };
}
