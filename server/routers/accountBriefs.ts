/**
 * Account Briefs (CRMA-010)
 * AI-generated 300-word executive narrative per account, with PDF export.
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import {
  accountBriefs,
  accounts,
  contacts,
  opportunities,
  activities,
} from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import { storagePut } from "../storage";

export const accountBriefsRouter = router({
  /** Generate (or regenerate) an AI brief for an account */
  generate: workspaceProcedure
    .input(z.object({ accountId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const wsId = ctx.workspace.id;

      // Fetch account
      const [account] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.accountId), eq(accounts.workspaceId, wsId)));
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

      // Fetch contacts (up to 5)
      const accountContacts = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.accountId, input.accountId), eq(contacts.workspaceId, wsId)))
        .limit(5);

      // Fetch open opportunities (up to 5)
      const openOpps = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.accountId, input.accountId), eq(opportunities.workspaceId, wsId)))
        .limit(5);

      // Fetch recent activities (up to 5)
      const recentActivities = await db
        .select()
        .from(activities)
        .where(and(eq(activities.workspaceId, wsId), eq(activities.relatedType, "account"), eq(activities.relatedId, input.accountId)))
        .orderBy(desc(activities.createdAt))
        .limit(5);

      // Build context for LLM
      const contactsSummary = accountContacts
        .map((c) => `${c.firstName} ${c.lastName} (${c.title ?? "Unknown title"})`)
        .join(", ");

      const oppsSummary = openOpps
        .map((o) => `${o.name}: $${Number(o.value).toLocaleString()} — ${o.stage} (${o.winProb}% win prob)`)
        .join("; ");

      const activitiesSummary = recentActivities
        .map((a) => `${a.type}: ${a.subject ?? "No subject"} (${new Date(a.createdAt).toLocaleDateString()})`)
        .join("; ");

      const prompt = `Write a concise, professional 300-word executive account brief for a B2B sales team.

Account: ${account.name}
Industry: ${account.industry ?? "Unknown"}
Size: ${account.employeeBand ?? "Unknown"}
Region: ${account.region ?? "Unknown"}
Domain: ${account.domain ?? "Unknown"}
ARR: ${account.arr ? `$${Number(account.arr).toLocaleString()}` : "Unknown"}
Notes: ${account.notes ?? "None"}

Key Contacts: ${contactsSummary || "None on file"}

Open Opportunities: ${oppsSummary || "None"}

Recent Activities: ${activitiesSummary || "None"}

Write the brief in markdown format with these sections:
## Company Overview
## Key Stakeholders
## Open Opportunities
## Recent Engagement
## Recommended Next Steps

Keep each section to 2-3 sentences. Be specific, actionable, and sales-focused.`;

      const result = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You are an expert B2B sales strategist writing executive account briefs. Be concise, specific, and actionable. Use markdown formatting.",
          },
          { role: "user", content: prompt },
        ],
      });

      const content = (result.choices?.[0]?.message?.content as string) ?? "";

      // Save to DB
      const [inserted] = await db
        .insert(accountBriefs)
        .values({
          workspaceId: wsId,
          accountId: input.accountId,
          content,
          generatedByUserId: ctx.user.id,
        })
        .$returningId();

      const briefId = (inserted as any).id;
      return { id: briefId, content };
    }),

  /** Get the latest brief for an account */
  getLatest: workspaceProcedure
    .input(z.object({ accountId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [brief] = await db
        .select()
        .from(accountBriefs)
        .where(
          and(
            eq(accountBriefs.accountId, input.accountId),
            eq(accountBriefs.workspaceId, ctx.workspace.id)
          )
        )
        .orderBy(desc(accountBriefs.generatedAt))
        .limit(1);
      return brief ?? null;
    }),

  /** List all briefs for an account */
  list: workspaceProcedure
    .input(z.object({ accountId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select()
        .from(accountBriefs)
        .where(
          and(
            eq(accountBriefs.accountId, input.accountId),
            eq(accountBriefs.workspaceId, ctx.workspace.id)
          )
        )
        .orderBy(desc(accountBriefs.generatedAt))
        .limit(10);
    }),

  /** Export brief as PDF and return URL */
  exportPdf: workspaceProcedure
    .input(z.object({ briefId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [brief] = await db
        .select()
        .from(accountBriefs)
        .where(
          and(
            eq(accountBriefs.id, input.briefId),
            eq(accountBriefs.workspaceId, ctx.workspace.id)
          )
        );
      if (!brief) throw new TRPCError({ code: "NOT_FOUND" });

      // Fetch account name
      const [account] = await db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, brief.accountId));

      const accountName = account?.name ?? "Account";

      // Generate PDF using pdfkit
      const { default: PDFDocument } = await import("pdfkit");
      const buf: Buffer = await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 56 });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // Header
        doc.fillColor("#0F1F1B").fontSize(22).font("Helvetica-Bold").text("Account Brief", { continued: false });
        doc.fontSize(14).font("Helvetica").fillColor("#14B89A").text(accountName);
        doc.fontSize(9).fillColor("#888").text(`Generated: ${new Date(brief.generatedAt).toLocaleDateString()}`);
        doc.moveDown(0.5);
        doc.strokeColor("#14B89A").lineWidth(2).moveTo(56, doc.y).lineTo(556, doc.y).stroke();
        doc.moveDown(1);

        // Parse markdown sections and render
        const lines = brief.content.split("\n");
        for (const line of lines) {
          if (line.startsWith("## ")) {
            doc.moveDown(0.5);
            doc.font("Helvetica-Bold").fontSize(12).fillColor("#0F1F1B").text(line.replace("## ", ""));
            doc.moveDown(0.2);
          } else if (line.startsWith("# ")) {
            doc.moveDown(0.5);
            doc.font("Helvetica-Bold").fontSize(14).fillColor("#0F1F1B").text(line.replace("# ", ""));
            doc.moveDown(0.2);
          } else if (line.startsWith("- ") || line.startsWith("* ")) {
            doc.font("Helvetica").fontSize(10).fillColor("#333").text(`  • ${line.slice(2)}`, { width: 500 });
          } else if (line.trim()) {
            doc.font("Helvetica").fontSize(10).fillColor("#333").text(line, { width: 500 });
            doc.moveDown(0.2);
          }
        }

        // Footer
        doc.moveDown(2);
        doc.fontSize(8).fillColor("#aaa").text("Generated by USIP — Unified Sales Intelligence Platform", { align: "center" });
        doc.end();
      });

      const safeAccountName = accountName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const key = `ws-${ctx.workspace.id}/account-briefs/${safeAccountName}-${brief.id}.pdf`;
      const put = await storagePut(key, buf, "application/pdf");

      // Save PDF URL to brief
      await db
        .update(accountBriefs)
        .set({ pdfUrl: put.url })
        .where(eq(accountBriefs.id, brief.id));

      return { url: put.url };
    }),
});
