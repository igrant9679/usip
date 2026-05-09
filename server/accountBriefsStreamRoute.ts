/**
 * Streaming AI account brief generator.
 *
 *   POST /api/accounts/:id/brief/stream
 *     Headers: x-workspace-id (required)
 *     Body: (none)
 *     Returns: text/event-stream — same shape as /api/llm/stream
 *
 * Mirrors the data-fetch + prompt-building logic of
 * `accountBriefs.generate` in server/routers/accountBriefs.ts:23.
 * Saves the completed brief to the accountBriefs table on stream end so
 * the existing tRPC.accountBriefs.getLatest query can pick it up.
 *
 * If the prompt or context-building logic changes in the tRPC router,
 * update both — intentional duplication to keep the streaming path
 * independent of the router file.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  accountBriefs,
  accounts,
  activities,
  contacts,
  opportunities,
  workspaceMembers,
} from "../drizzle/schema";
import { getDb } from "./db";
import { sdk } from "./_core/sdk";
import { streamLLM } from "./_core/llmStream";

export function registerAccountBriefsStreamRoutes(app: Express) {
  app.post(
    "/api/accounts/:id/brief/stream",
    async (req: Request, res: Response) => {
      // ── Auth ────────────────────────────────────────────────────────────
      let userId: number;
      try {
        const user = await sdk.authenticateRequest(req);
        userId = user.id;
      } catch {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // ── Workspace ───────────────────────────────────────────────────────
      const headerVal = req.headers["x-workspace-id"];
      const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      const workspaceId = headerStr ? Number(headerStr) : NaN;
      if (!Number.isFinite(workspaceId)) {
        res.status(400).json({ error: "x-workspace-id header required" });
        return;
      }

      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "Database unavailable" });
        return;
      }

      const [member] = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!member) {
        res.status(403).json({ error: "Not a member of that workspace" });
        return;
      }

      // ── Account access check ────────────────────────────────────────────
      const accountId = Number(req.params.id);
      if (!Number.isFinite(accountId)) {
        res.status(400).json({ error: "Invalid account id" });
        return;
      }

      const [account] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)))
        .limit(1);
      if (!account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      // ── Build context (mirrors accountBriefs.generate) ──────────────────
      const accountContacts = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.accountId, accountId), eq(contacts.workspaceId, workspaceId)))
        .limit(5);

      const openOpps = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.accountId, accountId), eq(opportunities.workspaceId, workspaceId)))
        .limit(5);

      const recentActivities = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, workspaceId),
            eq(activities.relatedType, "account"),
            eq(activities.relatedId, accountId),
          ),
        )
        .orderBy(desc(activities.createdAt))
        .limit(5);

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

      const systemPrompt =
        "You are an expert B2B sales strategist writing executive account briefs. Be concise, specific, and actionable. Use markdown formatting.";

      // ── SSE setup ───────────────────────────────────────────────────────
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (event: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const abort = new AbortController();
      let clientDisconnected = false;
      req.on("close", () => {
        clientDisconnected = true;
        if (!res.writableEnded) abort.abort();
      });

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": heartbeat\n\n");
      }, 15_000);

      let accumulated = "";
      try {
        for await (const delta of streamLLM({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          workspaceId,
          signal: abort.signal,
        })) {
          if (res.writableEnded) break;
          accumulated += delta;
          send({ type: "delta", text: delta });
        }

        // Persist the completed brief — but only if the client is still
        // connected. If the user aborted, leave the partial result in the
        // editor without saving (matches Stop semantics elsewhere).
        if (!clientDisconnected && accumulated.length > 0) {
          try {
            const [inserted] = await db
              .insert(accountBriefs)
              .values({
                workspaceId,
                accountId,
                content: accumulated,
                generatedByUserId: userId,
              })
              .$returningId();
            const briefId = (inserted as { id: number }).id;
            send({ type: "saved", briefId });
          } catch (saveErr) {
            console.error("[AccountBriefsStream] save failed:", saveErr);
            send({
              type: "error",
              error: "Brief generated but failed to save. Please retry.",
            });
          }
        }

        if (!res.writableEnded) send({ type: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stream failed";
        if (!res.writableEnded) send({ type: "error", error: message });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    },
  );
}
