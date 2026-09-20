import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, notInArray, sql, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  accounts,
  contacts,
  customers,
  InsertUser,
  leads,
  opportunities,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { PERMISSION_KEYS, defaultGranted } from "@shared/permissions";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/* ─── Workspace ────────────────────────────────────────────────────────── */

export async function getUserWorkspaces(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      plan: workspaces.plan,
      logoUrl: workspaces.logoUrl,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    /**
     * Deactivated memberships are NOT memberships — the same rule as
     * resolveWorkspace (3366f4b), which this list was missed by.
     *
     * It matters twice: this is the workspace SWITCHER, so a leaver kept seeing
     * the workspace they were removed from; and workspace.switch uses this very
     * list as its authorization check ("Not a member of that workspace"), so it
     * was authorising against a stale answer.
     *
     * SAFE because seed.ts's ensureUserHasWorkspace guards on ANY membership
     * row rather than an active one. workspace.list auto-bootstraps a seeded
     * demo workspace when this comes back empty — so if that guard were ever
     * narrowed to active-only, deactivating someone would hand them a brand new
     * workspace. Pinned in deactivationRevokesAccess.test.ts.
     */
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deactivatedAt)));
}

export async function getWorkspaceMembers(workspaceId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: users.id,
      openId: users.openId,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      role: workspaceMembers.role,
      title: workspaceMembers.title,
      quota: workspaceMembers.quota,
      memberId: workspaceMembers.id,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}

/* ─── Aggregate dashboard counts ──────────────────────────────────────── */

/**
 * `stageKeys` is passed in rather than resolved here: this module is imported
 * by _core/stageSemantics.ts's consumers and importing that module back would
 * close a db.ts → stageSemantics → db.ts cycle at module init. The one caller
 * (routers/workspace.ts) already holds a db handle and resolves the index.
 */
export async function getWorkspaceCounts(workspaceId: number, stageKeys: { closed: string[]; won: string[] }) {
  const db = await getDb();
  if (!db) return null;
  const [accCount] = await db.select({ c: sql<number>`count(*)` }).from(accounts).where(eq(accounts.workspaceId, workspaceId));
  const [conCount] = await db.select({ c: sql<number>`count(*)` }).from(contacts).where(eq(contacts.workspaceId, workspaceId));
  const [leadCount] = await db.select({ c: sql<number>`count(*)` }).from(leads).where(eq(leads.workspaceId, workspaceId));
  const [oppCount] = await db.select({ c: sql<number>`count(*)` }).from(opportunities).where(eq(opportunities.workspaceId, workspaceId));
  const [openTasks] = await db.select({ c: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open")));
  const [pipeline] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), notInArray(opportunities.stage, stageKeys.closed)));
  const [won] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), inArray(opportunities.stage, stageKeys.won)));
  const [custCount] = await db.select({ c: sql<number>`count(*)` }).from(customers).where(eq(customers.workspaceId, workspaceId));
  return {
    accounts: Number(accCount?.c ?? 0),
    contacts: Number(conCount?.c ?? 0),
    leads: Number(leadCount?.c ?? 0),
    opportunities: Number(oppCount?.c ?? 0),
    openTasks: Number(openTasks?.c ?? 0),
    pipelineValue: Number(pipeline?.s ?? 0),
    closedWon: Number(won?.s ?? 0),
    customers: Number(custCount?.c ?? 0),
  };
}

export async function listRecentOpportunities(workspaceId: number, limit = 8) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(opportunities)
    .where(eq(opportunities.workspaceId, workspaceId))
    .orderBy(desc(opportunities.updatedAt))
    .limit(limit);
}

/* ─── Permission enforcement ───────────────────────────────────────────── */

export type PermissionCtx = { workspace: { id: number }; user: { id: number }; member: { role: string } };

/**
 * Resolves one feature permission for a workspace member.
 *
 * Resolution order:
 *   1. If a row exists in `member_permissions` for (workspaceId, userId, feature),
 *      its `granted` value wins — in BOTH directions. An explicit deny refuses
 *      an admin; an explicit grant hands a rep something their role would not.
 *   2. Otherwise the role default from `@shared/permissions`:
 *      - super_admin / admin → everything
 *      - manager / rep → everything except RESTRICTED_BY_DEFAULT
 *        (export_data, manage_api_keys — access_billing left that list on
 *        2026-09-20 when the key was first enforced; see shared/permissions.ts)
 *
 * WHERE THE SIX KEYS ARE ENFORCED, so the next person does not have to grep:
 *   export_data         admin.ts dangerZone.exportData; reports.ts exportCsv,
 *                       sendNow, setSchedule(freq !== "none"); are/prospects.ts
 *                       exportRejections
 *   manage_sequences    sequences.ts create/update/delete/fork/updateMeta/
 *                       updateSteps/saveCanvas/setStatus(non-pause)/
 *                       setVisibility/assign, and every sequenceAb mutation
 *                       (create/update/delete/promoteWinner/setMinSends —
 *                       that router edits the subject and body a step SENDS)
 *   manage_integrations integrations.ts save/disconnect/test
 *   manage_api_keys     aiCredentials, apollo, prospectSources, quickenrich, reoon
 *   access_billing      admin.ts usage.currentMonth
 *   view_all_leads      NOT ENFORCED — it is data scoping, not a gate, and is
 *                       deliberately deferred (see permissionEnforcement.test.ts,
 *                       which holds that exemption as a reviewed line of code).
 *
 * FAIL-OPEN when there is no database: a non-DB env (tests, a boot with
 * DATABASE_URL unset) must not have every gated feature refuse. Pinned by
 * permissionEnforcement.test.ts so a later "tighten this" does not close it.
 */
async function resolvePermission(
  ctx: PermissionCtx,
  feature: string,
): Promise<{ granted: boolean; source: "row" | "default" | "no-db" }> {
  const db = await getDb();
  if (!db) return { granted: true, source: "no-db" };

  // Import memberPermissions lazily to avoid circular deps
  const { memberPermissions } = await import("../drizzle/schema");

  const [row] = await db
    .select({ granted: memberPermissions.granted })
    .from(memberPermissions)
    .where(
      and(
        eq(memberPermissions.workspaceId, ctx.workspace.id),
        eq(memberPermissions.userId, ctx.user.id),
        eq(memberPermissions.feature, feature),
      ),
    )
    .limit(1);

  if (row !== undefined) return { granted: !!row.granted, source: "row" };

  // No override row — apply role-based defaults
  const role = ctx.member.role as string;
  const isElevated = role === "super_admin" || role === "admin";

  return { granted: defaultGranted(feature, isElevated), source: "default" };
}

/**
 * Throws FORBIDDEN if the permission is denied.
 *
 * The two refusal messages are deliberately different: "you" for an override
 * somebody set on this member, "your role" for a default nobody has touched.
 * They send the admin who gets the screenshot to different places, so folding
 * them into one string is a silent loss.
 */
export async function checkPermission(ctx: PermissionCtx, feature: string): Promise<void> {
  const res = await resolvePermission(ctx, feature);
  if (res.granted) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: res.source === "row"
      ? `You do not have permission to use: ${feature}`
      : `Your role (${ctx.member.role}) does not have permission to use: ${feature}`,
  });
}

/** The non-throwing form, for branching rather than refusing. */
export async function hasPermission(ctx: PermissionCtx, feature: string): Promise<boolean> {
  return (await resolvePermission(ctx, feature)).granted;
}

/**
 * Every key resolved at once, for the client.
 *
 * ONE select rather than six round trips, because this is fetched on page load
 * to decide what to render. Keys with no row fall back to the role default, so
 * the answer is the EFFECTIVE permission — which is the whole point: the Team
 * page used to render the raw rows and showed every unset toggle as off,
 * including the three the server grants.
 */
export async function resolvePermissionMap(ctx: PermissionCtx): Promise<Record<string, boolean>> {
  const role = ctx.member.role as string;
  const isElevated = role === "super_admin" || role === "admin";
  const out: Record<string, boolean> = {};
  for (const k of PERMISSION_KEYS) out[k] = defaultGranted(k, isElevated);

  const db = await getDb();
  // NOT the same fail-open as resolvePermission, which grants everything with
  // no database — the comment here used to claim it was. This returns the ROLE
  // DEFAULTS, so with no DB a rep resolves export_data:false while
  // checkPermission would have let the same call through. The disagreement is
  // only ever in the STRICTER direction, which is the harmless one: this map
  // decides what the client renders and the gates are the boundary, and a
  // non-DB env has no rows to export anyway.
  if (!db) return out;

  const { memberPermissions } = await import("../drizzle/schema");
  const rows = await db
    .select({ feature: memberPermissions.feature, granted: memberPermissions.granted })
    .from(memberPermissions)
    .where(
      and(
        eq(memberPermissions.workspaceId, ctx.workspace.id),
        eq(memberPermissions.userId, ctx.user.id),
      ),
    );
  // Rows for keys that are no longer in PERMISSION_KEYS are skipped rather than
  // surfaced: setPermissions accepted free-form strings until 2026-09-20, so a
  // typo could be stored, and nothing has ever deleted one.
  for (const r of rows) {
    if (out[r.feature] === undefined) continue;
    out[r.feature] = !!r.granted;
  }
  return out;
}
