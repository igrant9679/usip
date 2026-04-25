import { TRPCError } from "@trpc/server";
import { and, eq, sql, desc } from "drizzle-orm";
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
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
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

export async function getWorkspaceCounts(workspaceId: number) {
  const db = await getDb();
  if (!db) return null;
  const [accCount] = await db.select({ c: sql<number>`count(*)` }).from(accounts).where(eq(accounts.workspaceId, workspaceId));
  const [conCount] = await db.select({ c: sql<number>`count(*)` }).from(contacts).where(eq(contacts.workspaceId, workspaceId));
  const [leadCount] = await db.select({ c: sql<number>`count(*)` }).from(leads).where(eq(leads.workspaceId, workspaceId));
  const [oppCount] = await db.select({ c: sql<number>`count(*)` }).from(opportunities).where(eq(opportunities.workspaceId, workspaceId));
  const [openTasks] = await db.select({ c: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open")));
  const [pipeline] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), sql`${opportunities.stage} NOT IN ('won','lost')`));
  const [won] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "won")));
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

/**
 * Checks whether a workspace member has a specific feature permission.
 *
 * Resolution order:
 *   1. If a row exists in `member_permissions` for (workspaceId, userId, feature),
 *      return its `granted` value.
 *   2. Otherwise fall back to a role-based default:
 *      - super_admin / admin → all features granted by default
 *      - manager / rep → export_data, access_billing, manage_api_keys denied by default
 *
 * Throws FORBIDDEN if the permission is denied.
 */
export async function checkPermission(
  ctx: { workspace: { id: number }; user: { id: number }; member: { role: string } },
  feature: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return; // fail-open if DB unavailable (avoids blocking non-DB envs)

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

  if (row !== undefined) {
    if (!row.granted) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `You do not have permission to use: ${feature}`,
      });
    }
    return; // explicitly granted
  }

  // No override row — apply role-based defaults
  const restrictedByDefault = ["export_data", "access_billing", "manage_api_keys"];
  const role = ctx.member.role as string;
  const isElevated = role === "super_admin" || role === "admin";

  if (!isElevated && restrictedByDefault.includes(feature)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Your role (${role}) does not have permission to use: ${feature}`,
    });
  }
}
