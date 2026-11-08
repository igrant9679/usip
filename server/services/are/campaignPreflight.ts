/**
 * Before a Revenue Engine campaign is activated, what it needs and what is
 * missing (audit 2026-10-20, F15). Activation checked only the campaign cap,
 * so a campaign with no mailbox to send from, or a LinkedIn-only campaign
 * whose owner has no LinkedIn account, was switched on and failed every step.
 *
 * Five things are read: a sender for email, the owner's LinkedIn account, a
 * Reoon key, where its people come from, and the workspace's time zone (plus
 * the outbound pause, said for information). Only what would make the
 * campaign FAIL blocks activation:
 *   · email is its only channel and there is nothing to send email from
 *   · LinkedIn is its only channel and the owner has no LinkedIn account
 *     (the engine sends LinkedIn steps from the owner's own account only)
 *   · discovery is off and nobody is in the campaign — nothing to send to
 * Everything else is a warning the person reads and may go ahead past: a
 * missing Reoon key leaves found addresses unchecked, a second channel with
 * nothing behind it holds those steps, the UTC zone is asked about by the
 * first launch itself, and the pause holds every send until it is lifted.
 *
 * Read-only. Each read that fails reads as "not ready" for its own check
 * only, so one bad read never hides the others.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { prospectQueue, sendingAccounts, smtpConfigs, workspaceSettings } from "../../../drizzle/schema";
import type { getDb } from "../../db";
import { campaignChannelOn } from "@shared/areSequenceSteps";
import { campaignSources } from "@shared/areSources";
import { pickLinkedInAccount } from "./linkedinStep";
import { getReoonKey } from "../reoon";
import { isOutboundPaused } from "../outboundPause";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type PreflightKey = "sender" | "linkedin" | "reoon" | "sources" | "timezone" | "pause";

export interface PreflightCheck {
  key: PreflightKey;
  label: string;
  ok: boolean;
  /** True when this missing thing would make the campaign fail; activation is refused. */
  blocking: boolean;
  detail: string;
  /** Where to fix it. */
  href?: string;
}

export interface PreflightCampaign {
  id: number;
  ownerUserId: number | null;
  channelsEnabled: unknown;
  prospectSources: unknown;
}

export async function campaignPreflight(db: Db, workspaceId: number, c: PreflightCampaign): Promise<{ checks: PreflightCheck[]; blockers: PreflightCheck[] }> {
  const email = campaignChannelOn(c.channelsEnabled, "email");
  const linkedin = campaignChannelOn(c.channelsEnabled, "linkedin");
  const checks: PreflightCheck[] = [];

  /* A sender for email: an enabled sending account, or the workspace's
     Email-Delivery SMTP config (the pool's fallback, emailDelivery.ts). */
  if (email) {
    let senders = 0;
    let smtpReady = false;
    try {
      const [a] = await db.select({ n: sql<number>`count(*)` }).from(sendingAccounts)
        .where(and(eq(sendingAccounts.workspaceId, workspaceId), eq(sendingAccounts.enabled, true)));
      senders = Number(a?.n ?? 0);
      if (senders === 0) {
        const [cfg] = await db.select({ host: smtpConfigs.host, username: smtpConfigs.username, enabled: smtpConfigs.enabled })
          .from(smtpConfigs).where(eq(smtpConfigs.workspaceId, workspaceId)).limit(1);
        smtpReady = !!(cfg && cfg.enabled && cfg.host && cfg.username);
      }
    } catch { /* read failed: not ready */ }
    const ok = senders > 0 || smtpReady;
    checks.push({
      key: "sender", label: "Sender accounts", ok,
      blocking: !ok && !linkedin,
      detail: ok
        ? senders > 0 ? `${senders} sending account${senders === 1 ? "" : "s"} enabled.` : "No sending account, so email goes through the workspace's Email-Delivery settings."
        : linkedin
          ? "No sending account and no Email-Delivery settings: the email steps will fail; LinkedIn steps can still go."
          : "No sending account and no Email-Delivery settings, so every email step would fail. Add a mailbox first.",
      href: "/v2/settings/email-delivery",
    });
  }

  /* LinkedIn steps go from the campaign owner's own account (linkedinStep.ts, ownerOnly). */
  if (linkedin) {
    let ok = false;
    try { ok = !!(await pickLinkedInAccount(workspaceId, c.ownerUserId, { ownerOnly: true })); } catch { ok = false; }
    checks.push({
      key: "linkedin", label: "LinkedIn", ok,
      blocking: !ok && !email,
      detail: ok
        ? "The campaign owner's LinkedIn account is connected."
        : email
          ? "The campaign owner has no LinkedIn account connected, so LinkedIn steps hold with that reason; email steps still go."
          : "The campaign owner has no LinkedIn account connected, and LinkedIn is this campaign's only channel, so nothing could be sent.",
      href: "/connected-accounts",
    });
  }

  /* Reoon checks the addresses enrichment finds; without it they are unchecked. */
  {
    let key = "";
    try { key = await getReoonKey(workspaceId); } catch { key = ""; }
    checks.push({
      key: "reoon", label: "Reoon key", ok: !!key, blocking: false,
      detail: key
        ? "Addresses found during enrichment are verified before they are used."
        : "No Reoon key: addresses found during enrichment are not verified, so more of them may bounce.",
      href: "/v2/settings/integrations",
    });
  }

  /* Where its people come from: discovery, or people already in it. */
  {
    const sources = campaignSources(c.prospectSources);
    let people = 0;
    try {
      const [r] = await db.select({ n: sql<number>`count(*)` }).from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, workspaceId), eq(prospectQueue.campaignId, c.id), ne(prospectQueue.sequenceStatus, "skipped")));
      people = Number(r?.n ?? 0);
    } catch { people = 0; }
    const ok = sources.length > 0 || people > 0;
    checks.push({
      key: "sources", label: "Sources", ok,
      blocking: !ok,
      detail: sources.length > 0
        ? `Discovery searches ${sources.join(", ")}${people > 0 ? `; ${people.toLocaleString("en-US")} ${people === 1 ? "person is" : "people are"} already in it` : ""}.`
        : people > 0
          ? `Discovery is off; the ${people.toLocaleString("en-US")} ${people === 1 ? "person" : "people"} already in it go through it.`
          : "Discovery is off and nobody is in this campaign, so there is no one to send to. Tick a source, or add people.",
    });
  }

  /* The cap and the window count the workspace's own day (A31). */
  {
    let tz = "";
    try {
      const [s] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
      tz = String(s?.timezone ?? "").trim();
    } catch { tz = ""; }
    const ok = !!tz && tz !== "UTC";
    checks.push({
      key: "timezone", label: "Time zone", ok, blocking: false,
      detail: ok
        ? `The daily cap and the send window run on ${tz}.`
        : "The workspace is still on the UTC default, so the cap and the send window count UTC days and hours. The first launch asks you to confirm it.",
      href: "/v2/settings/workspace",
    });
  }

  /* The pause holds every send; it does not stop activation, and says so. */
  {
    const paused = await isOutboundPaused(workspaceId);
    checks.push({
      key: "pause", label: "Outbound", ok: !paused, blocking: false,
      detail: paused
        ? "Outbound is paused for this workspace: the campaign can be activated, and nothing is sent until the pause is lifted."
        : "Outbound is not paused.",
      href: "/v2/settings/workspace",
    });
  }

  return { checks, blockers: checks.filter((x) => x.blocking) };
}

/** The refusal activation gives, naming what is missing. */
export function preflightRefusal(blockers: PreflightCheck[]): string {
  return `This campaign can't start yet: ${blockers.map((b) => b.detail).join(" ")}`;
}
