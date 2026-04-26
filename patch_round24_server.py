#!/usr/bin/env python3
"""
Patch prospects.ts to add:
1. Import users + workspaceMembers + notifications from schema
2. exportRejections procedure
3. reEvaluate procedure
4. getWorkspaceMembers procedure
5. Update addNote to parse @mentions and fire notifications
"""

import re

path = "/home/ubuntu/usip/server/routers/are/prospects.ts"
with open(path, "r") as f:
    content = f.read()

# ── 1. Extend schema imports ──────────────────────────────────────────────────
old_imports = """import {
  areAbVariants,
  areCampaigns,
  icpProfiles,
  prospectIntelligence,
  prospectNotes,
  prospectQueue,
} from "../../../drizzle/schema";"""

new_imports = """import {
  areAbVariants,
  areCampaigns,
  icpProfiles,
  notifications,
  prospectIntelligence,
  prospectNotes,
  prospectQueue,
  users,
  workspaceMembers,
} from "../../../drizzle/schema";
import { inArray } from "drizzle-orm";"""

content = content.replace(old_imports, new_imports, 1)

# ── 2. Fix duplicate inArray if already imported ──────────────────────────────
# Make sure inArray is in the drizzle-orm import line instead of a separate import
if 'import { and, desc, eq, sql } from "drizzle-orm";' in content:
    content = content.replace(
        'import { and, desc, eq, sql } from "drizzle-orm";\nimport { inArray } from "drizzle-orm";',
        'import { and, desc, eq, inArray, sql } from "drizzle-orm";',
        1
    )
    # Remove the standalone inArray import if it ended up separate
    content = content.replace('\nimport { inArray } from "drizzle-orm";', '', 1)

# ── 3. Update addNote to parse @mentions ──────────────────────────────────────
old_addNote = """  addNote: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      body: z.string().min(1).max(4000),
      category: z.enum(["general", "qualification", "objection", "follow_up", "intel"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [note] = await db.insert(prospectNotes).values({
        workspaceId: ctx.workspace.id,
        prospectQueueId: input.prospectId,
        userId: ctx.user.id,
        body: input.body,
        category: input.category ?? "general",
      }).$returningId();
      return { id: note.id };
    }),"""

new_addNote = """  addNote: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      body: z.string().min(1).max(4000),
      category: z.enum(["general", "qualification", "objection", "follow_up", "intel"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [note] = await db.insert(prospectNotes).values({
        workspaceId: ctx.workspace.id,
        prospectQueueId: input.prospectId,
        userId: ctx.user.id,
        body: input.body,
        category: input.category ?? "general",
      }).$returningId();
      // Parse @mentions and fire in-app notifications
      const mentionRegex = /@([a-zA-Z0-9_.\- ]+)/g;
      const mentionedNames: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = mentionRegex.exec(input.body)) !== null) {
        mentionedNames.push(m[1].trim().toLowerCase());
      }
      if (mentionedNames.length > 0) {
        // Find workspace members whose name matches any mention
        const members = await db
          .select({ userId: users.id, name: users.name })
          .from(workspaceMembers)
          .innerJoin(users, eq(workspaceMembers.userId, users.id))
          .where(eq(workspaceMembers.workspaceId, ctx.workspace.id));
        const mentionedUserIds = members
          .filter((mem) =>
            mentionedNames.some((mn) =>
              mem.name?.toLowerCase().includes(mn) || mn.includes(mem.name?.toLowerCase() ?? "")
            )
          )
          .map((mem) => mem.userId);
        if (mentionedUserIds.length > 0) {
          await db.insert(notifications).values(
            mentionedUserIds.map((uid) => ({
              workspaceId: ctx.workspace.id,
              userId: uid,
              kind: "mention" as const,
              title: `${ctx.user.name ?? "Someone"} mentioned you in a prospect note`,
              body: input.body.slice(0, 240),
              relatedType: "prospect_note",
              relatedId: note.id,
            }))
          );
        }
      }
      return { id: note.id };
    }),"""

content = content.replace(old_addNote, new_addNote, 1)

# ── 4. Add exportRejections, reEvaluate, getWorkspaceMembers before closing }); ──
new_procedures = """
  exportRejections: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { csv: "" };
      const rejected = await db.select({
        id: prospectQueue.id,
        firstName: prospectQueue.firstName,
        lastName: prospectQueue.lastName,
        contactTitle: prospectQueue.contactTitle,
        companyName: prospectQueue.companyName,
        industry: prospectQueue.industry,
        geography: prospectQueue.geography,
        companySize: prospectQueue.companySize,
        email: prospectQueue.email,
        linkedinUrl: prospectQueue.linkedinUrl,
        icpMatchScore: prospectQueue.icpMatchScore,
        rejectionReason: prospectQueue.rejectionReason,
        rejectedAt: prospectQueue.rejectedAt,
        sourceType: prospectQueue.sourceType,
      })
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.campaignId, input.campaignId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "skipped"),
        ))
        .orderBy(desc(prospectQueue.rejectedAt));
      const escape = (v: unknown) => {
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const headers = [
        "ID","First Name","Last Name","Title","Company","Industry","Geography",
        "Company Size","Email","LinkedIn URL","ICP Match Score","Rejection Reason","Rejected At","Source",
      ];
      const rows = rejected.map((r) => [
        r.id, r.firstName, r.lastName, r.contactTitle, r.companyName, r.industry,
        r.geography, r.companySize, r.email, r.linkedinUrl, r.icpMatchScore,
        r.rejectionReason, r.rejectedAt ? new Date(r.rejectedAt).toISOString() : "", r.sourceType,
      ].map(escape).join(","));
      return { csv: [headers.join(","), ...rows].join("\\n"), count: rejected.length };
    }),

  reEvaluate: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [prospect] = await db
        .select()
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.id, input.prospectId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
        ))
        .limit(1);
      if (!prospect) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
      // Get latest active ICP
      const [icp] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
        .limit(1);
      if (!icp) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active ICP profile" });
      const match = await scoreIcpMatch(prospect, icp);
      const autoApproveThreshold = 70; // fallback default
      const newStatus = match.score >= autoApproveThreshold ? "pending" : "skipped";
      await db.update(prospectQueue).set({
        icpMatchScore: match.score,
        icpMatchBreakdown: JSON.stringify(match.breakdown),
        sequenceStatus: newStatus,
        rejectedAt: newStatus === "pending" ? null : prospect.rejectedAt,
        rejectionReason: newStatus === "pending" ? null : prospect.rejectionReason,
      }).where(eq(prospectQueue.id, input.prospectId));
      return { newScore: match.score, newStatus, breakdown: match.breakdown };
    }),

  getWorkspaceMembers: workspaceProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select({
          userId: users.id,
          name: users.name,
          avatarUrl: users.avatarUrl,
          title: workspaceMembers.title,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(
          eq(workspaceMembers.workspaceId, ctx.workspace.id),
        ))
        .orderBy(users.name);
    }),
"""

# Insert before the closing });
content = content.rstrip()
if content.endswith("});"):
    content = content[:-3] + new_procedures + "});"
else:
    print("WARNING: Could not find closing }); — appending anyway")
    content = content + new_procedures + "\n});"

with open(path, "w") as f:
    f.write(content)

print("Done patching prospects.ts")
