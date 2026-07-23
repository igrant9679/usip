/**
 * Streaming proposal section generator.
 *
 *   POST /api/proposals/:id/section/:key/stream
 *     Headers: x-workspace-id (required)
 *     Body:    { context: { clientName, orgAbbr?, projectType?, description?, budget? } }
 *     Returns: text/event-stream — same event shape as /api/llm/stream
 *
 * Mirrors the prompt-building logic of `proposals.generateSectionContent` in
 * server/routers/proposals.ts:812. If that prompt changes, update both —
 * intentional duplication to keep the streaming path independent of the
 * tRPC router file.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { proposals, workspaceMembers, workspaces } from "../drizzle/schema";
import { getDb } from "./db";
import { sdk } from "./_core/sdk";
import { streamLLM } from "./_core/llmStream";

// Keep in sync with SECTION_LABELS in routers/proposals.ts. Local copy avoids
// importing from the tRPC router file (which would pull in the whole router).
const SECTION_LABELS: Record<string, string> = {
  executive_summary: "Executive Summary",
  firm_overview: "Firm Overview",
  our_approach: "Our Approach",
  timeline_narrative: "Timeline Narrative",
  pricing: "Pricing",
  case_studies: "Case Studies",
  references: "References",
  terms: "Terms & Conditions",
};

type Context = {
  clientName?: string;
  orgAbbr?: string;
  projectType?: string;
  description?: string;
  budget?: number;
};

function buildPrompt(sectionKey: string, ctx: Context, companyName: string): { system: string; user: string } {
  const label = SECTION_LABELS[sectionKey] ?? sectionKey;
  const system =
    `You are an expert proposal writer for ${companyName}. ` +
    "Write compelling, professional proposal content in clear, concise prose. " +
    "Use markdown formatting (headers, bullets where appropriate). " +
    "Do not include placeholder text — write real, polished content.";
  const user = `Write the "${label}" section for a proposal to ${ctx.clientName ?? "the client"}${ctx.orgAbbr ? ` (${ctx.orgAbbr})` : ""}.
${ctx.projectType ? `Project type: ${ctx.projectType}` : ""}
${ctx.description ? `Project description: ${ctx.description}` : ""}
${typeof ctx.budget === "number" ? `Budget: $${ctx.budget.toLocaleString()}` : ""}

Write 2-4 paragraphs of professional proposal content for this section. Be specific and persuasive.`;
  return { system, user };
}

export function registerProposalsStreamRoutes(app: Express) {
  app.post(
    "/api/proposals/:id/section/:key/stream",
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

      // ── Proposal access check ───────────────────────────────────────────
      const proposalId = Number(req.params.id);
      const sectionKey = String(req.params.key);
      if (!Number.isFinite(proposalId) || !SECTION_LABELS[sectionKey]) {
        res.status(400).json({ error: "Invalid proposal id or section key" });
        return;
      }

      const [proposal] = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(
          and(eq(proposals.id, proposalId), eq(proposals.workspaceId, workspaceId)),
        )
        .limit(1);
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }

      // ── Build prompt ────────────────────────────────────────────────────
      const ctx = (req.body?.context ?? {}) as Context;
      // The proposal is written on behalf of the WORKSPACE's company — never
      // a hardcoded tenant name (multi-company requirement).
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      const { system, user } = buildPrompt(sectionKey, ctx, ws?.name ?? "our company");

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
      req.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": heartbeat\n\n");
      }, 15_000);

      try {
        for await (const delta of streamLLM({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          workspaceId,
          signal: abort.signal,
        })) {
          if (res.writableEnded) break;
          send({ type: "delta", text: delta });
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
