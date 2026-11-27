/**
 * membership — signing up for a workspace (owner, 2026-11-26: "enable sign-up
 * via the website, with new subscriber/membership creation handled on the
 * front end … I want to be able to sign up for a new workspace from the
 * front-end website and from within the app itself (both places)").
 *
 * Two doors, one result (a workspace on a membership plan, with its owner):
 *
 *   1. THE WEBSITE. The membership site (meyousocial.com: WordPress and
 *      MemberPress) takes the sign-up and the payment, then tells Velocity
 *      over the signed API in server/membershipApi.ts. Velocity never sees a
 *      card and the site never sees a Velocity password.
 *   2. THE APP. Someone who registers here and has no workspace creates one
 *      for themselves, on the Trial plan, when the platform owner has opened
 *      that (SELF_SERVE_SIGNUP). Paid plans are bought on the website.
 *
 * This file is the ONE definition both sides of the wire agree on: the header
 * names, what is signed, what a request may carry, and every sentence a
 * person reads. Pure, so a test can hold all of it. docs/membership-api.md is
 * the same contract written for whoever builds the website side.
 */
import { MEMBERSHIP_PLANS, PLAN_LABEL, PLAN_MONTHLY_LIMIT, isMembershipPlan, type MembershipPlan } from "./prospectAllowance";

/** The env var holding the secret the website signs with. The API is closed while it is unset. */
export const MEMBERSHIP_SECRET_ENV = "MEMBERSHIP_API_SECRET";
/** A secret shorter than this is refused, so a placeholder never becomes the lock. */
export const MEMBERSHIP_SECRET_MIN_LENGTH = 32;
/** Seconds since 1970 (UTC), as the sender's clock had it. */
export const MEMBERSHIP_TIMESTAMP_HEADER = "x-velocity-timestamp";
/** "sha256=" followed by the hex HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export const MEMBERSHIP_SIGNATURE_HEADER = "x-velocity-signature";
/** How far the sender's clock may be from ours, either way. */
export const MEMBERSHIP_MAX_SKEW_SECONDS = 300;

/** What is signed: the timestamp, a dot, then the body exactly as it was sent. */
export function membershipSigningPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Where a link came from: the membership site, or the app's own Trial sign-up. */
export const MEMBERSHIP_SOURCES = ["meyousocial", "app"] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];
/** The source the signed API writes. The app's own sign-up can never be reached through it. */
export const SITE_SOURCE: MembershipSource = "meyousocial";

/** A membership is paid up ("active") or over ("ended"). */
export const MEMBERSHIP_STATUSES = ["active", "ended"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export function isMembershipStatus(v: unknown): v is MembershipStatus {
  return typeof v === "string" && (MEMBERSHIP_STATUSES as readonly string[]).includes(v);
}

export const EXTERNAL_ID_MAX = 120;
export const WORKSPACE_NAME_MAX = 120;
/** Days a new member's activation link works. It can be issued again at any time. */
export const ACTIVATION_LINK_DAYS = 30;

export type ProvisionInput = {
  /** The site's own id for this membership (one per workspace): a subscription id, not a person. */
  externalId: string;
  email: string;
  name: string | null;
  workspaceName: string | null;
  plan: MembershipPlan;
};

export type UpdateInput = {
  externalId: string;
  plan: MembershipPlan | null;
  status: MembershipStatus | null;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Letters, digits and the few marks an id from another system carries. No spaces, nothing that needs escaping. */
const EXTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]*$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A number id from the site (MemberPress ids are numbers) is taken as its digits. */
export function parseExternalId(v: unknown): Parsed<string> {
  const s = typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : str(v);
  if (!s) return { ok: false, error: "externalId is required: the site's own id for this membership." };
  if (s.length > EXTERNAL_ID_MAX) return { ok: false, error: `externalId is longer than ${EXTERNAL_ID_MAX} characters.` };
  if (!EXTERNAL_ID_RE.test(s)) return { ok: false, error: "externalId may hold letters, digits, dots, dashes, underscores and colons only." };
  return { ok: true, value: s };
}

const PLAN_LIST = MEMBERSHIP_PLANS.join(", ");

export function parseProvision(body: unknown): Parsed<ProvisionInput> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = parseExternalId(b.externalId);
  if (!id.ok) return id;
  const email = str(b.email)?.toLowerCase() ?? null;
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return { ok: false, error: "email is required and must be an email address." };
  if (!isMembershipPlan(b.plan)) return { ok: false, error: `plan must be one of: ${PLAN_LIST}.` };
  const name = str(b.name)?.slice(0, 200) ?? null;
  const workspaceName = str(b.workspaceName);
  if (workspaceName && workspaceName.length > WORKSPACE_NAME_MAX) return { ok: false, error: `workspaceName is longer than ${WORKSPACE_NAME_MAX} characters.` };
  if (workspaceName && workspaceName.length < 2) return { ok: false, error: "workspaceName must be at least 2 characters." };
  return { ok: true, value: { externalId: id.value, email, name, workspaceName, plan: b.plan } };
}

export function parseUpdate(body: unknown): Parsed<UpdateInput> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = parseExternalId(b.externalId);
  if (!id.ok) return id;
  const hasPlan = b.plan !== undefined && b.plan !== null;
  const hasStatus = b.status !== undefined && b.status !== null;
  if (hasPlan && !isMembershipPlan(b.plan)) return { ok: false, error: `plan must be one of: ${PLAN_LIST}.` };
  if (hasStatus && !isMembershipStatus(b.status)) return { ok: false, error: `status must be one of: ${MEMBERSHIP_STATUSES.join(", ")}.` };
  if (!hasPlan && !hasStatus) return { ok: false, error: "Send plan, status, or both: there is nothing to change." };
  return {
    ok: true,
    value: { externalId: id.value, plan: hasPlan ? (b.plan as MembershipPlan) : null, status: hasStatus ? (b.status as MembershipStatus) : null },
  };
}

/** What a new workspace is called when the site sends no name: the person's first name, or their address. */
export function defaultWorkspaceName(name: string | null, email: string): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  if (first) return `${first}'s Workspace`.slice(0, WORKSPACE_NAME_MAX);
  const local = email.split("@")[0] || "My";
  return `${local}'s Workspace`.slice(0, WORKSPACE_NAME_MAX);
}

/** The public plan list (GET /api/membership/plans): what each plan includes, for a pricing page. */
export type PublicPlan = { id: MembershipPlan; label: string; prospectRecordsPerMonth: number };
export function publicPlans(): PublicPlan[] {
  return MEMBERSHIP_PLANS.map((id) => ({ id, label: PLAN_LABEL[id], prospectRecordsPerMonth: PLAN_MONTHLY_LIMIT[id] }));
}

/** How the app's own sign-up is set: closed, or open on the Trial plan. */
export type SelfServeMode = "off" | "trial";
/** SELF_SERVE_SIGNUP=trial opens it. Anything else, or nothing, leaves it closed. */
export function selfServeMode(env: Record<string, string | undefined>): SelfServeMode {
  return (env.SELF_SERVE_SIGNUP ?? "").trim().toLowerCase() === "trial" ? "trial" : "off";
}
/** The plan a workspace made in the app starts on. */
export const SELF_SERVE_PLAN: MembershipPlan = "trial";

/** Where plans are bought (MEMBERSHIP_SITE_URL), when it is a real https address. Null otherwise. */
export function membershipSiteUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env.MEMBERSHIP_SITE_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Why the app will not make this person a workspace, or null when it will. */
export type SelfServeBlock = "closed" | "has_workspace" | "email_unconfirmed";
export function selfServeBlock(a: { mode: SelfServeMode; hasWorkspace: boolean; emailConfirmed: boolean }): SelfServeBlock | null {
  if (a.hasWorkspace) return "has_workspace";
  if (a.mode === "off") return "closed";
  if (!a.emailConfirmed) return "email_unconfirmed";
  return null;
}

export const SELF_SERVE_BLOCK_MESSAGE: Record<SelfServeBlock, string> = {
  closed: "Workspaces are set up by your administrator: ask them to invite you, or open the activation link they sent you.",
  has_workspace: "You already have a workspace. Ask the platform owner if you need another.",
  email_unconfirmed: "Confirm your email address first: open the link we sent you, then come back and create your workspace.",
};

/** Said when a member tries to restore a workspace whose membership is over. */
export const MEMBERSHIP_ENDED_RESTORE_MESSAGE =
  "This workspace's membership has ended, so it cannot be restored here. Renew the membership and it is restored for you. Nothing has been deleted.";

/** The Trial line on the create-your-workspace form. */
export function trialOfferLine(): string {
  return `You start on the ${PLAN_LABEL[SELF_SERVE_PLAN]} plan, which includes ${PLAN_MONTHLY_LIMIT[SELF_SERVE_PLAN].toLocaleString("en-US")} prospect records a month.`;
}
