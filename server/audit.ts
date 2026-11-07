import { auditLog } from "../drizzle/schema";
import { getDb } from "./db";
import { noteAuditRecorded } from "./_core/requestContext";

type AuditAction = "create" | "update" | "delete" | "login" | "logout" | "scim";

export async function recordAudit(args: {
  workspaceId: number;
  actorUserId: number | null;
  action: AuditAction;
  entityType: string;
  entityId?: number | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) {
  // This request has its own entry: workspaceProcedure adds no automatic one
  // (audit 2026-10-20, G49; _core/autoAudit.ts).
  noteAuditRecorded();
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(auditLog).values({
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId ?? null,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId ?? null,
      before: (args.before as any) ?? null,
      after: (args.after as any) ?? null,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    });
  } catch (e) {
    console.warn("[audit] failed", e);
  }
}
