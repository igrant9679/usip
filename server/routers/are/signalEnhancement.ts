/**
 * ARE — Signal Enhancement Agent
 *
 * Triggered when a positive engagement signal arrives (email_open, email_click,
 * linkedin_accepted). Fetches live context (recent news, LinkedIn summary) for
 * the prospect's company and asks the LLM to rewrite the top personalisation
 * hook using the freshest available context.
 *
 * The enhanced hook is stored in prospectIntelligence.enhancedHook and
 * signalEnhancedAt is stamped so the sequence engine can use it for the next
 * outreach step.
 */

import { and, eq } from "drizzle-orm";
import {
  prospectIntelligence,
  prospectQueue,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { invokeLLM } from "../../_core/llm";
import { areNotify } from "./notify";

/** Trigger signal types that warrant hook enhancement */
const ENHANCEMENT_TRIGGERS = new Set([
  "email_open",
  "email_click",
  "linkedin_accepted",
]);

/**
 * Runs the Signal Enhancement Agent for a given prospect.
 * Non-fatal — errors are caught so they never block the calling flow.
 */
export async function runSignalEnhancement(
  workspaceId: number,
  prospectQueueId: number,
  campaignId: number,
  signalType: string,
): Promise<void> {
  if (!ENHANCEMENT_TRIGGERS.has(signalType)) return;

  try {
    const db = await getDb();
    if (!db) return;

    // Fetch prospect and intelligence
    const [prospect] = await db
      .select()
      .from(prospectQueue)
      .where(and(eq(prospectQueue.id, prospectQueueId), eq(prospectQueue.workspaceId, workspaceId)))
      .limit(1);
    if (!prospect) return;

    const [intel] = await db
      .select()
      .from(prospectIntelligence)
      .where(eq(prospectIntelligence.prospectQueueId, prospectQueueId))
      .limit(1);
    if (!intel) return;

    // Don't re-enhance if already enhanced within the last 24 hours
    if (intel.signalEnhancedAt) {
      const ageMs = Date.now() - new Date(intel.signalEnhancedAt).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) return;
    }

    const intelData = intel.data as Record<string, unknown> | null ?? {};
    const existingHooks = (intelData.personalisationHooks as Array<{ hook: string; source?: string }> | null) ?? [];
    const recentNews = (intel.recentNews as Array<{ headline: string; date?: string; sentiment?: string }> | null) ?? [];
    const industryEvents = (intel.industryEvents as Array<{ eventName: string; date?: string; role?: string }> | null) ?? [];
    const triggerEvents = (intelData.triggerEvents as Array<{ type: string; description: string }> | null) ?? [];

    const companyName = prospect.companyName ?? "the company";
    const firstName = prospect.firstName ?? "there";
    const title = prospect.title ?? "";

    // Build context for the LLM
    const contextParts: string[] = [
      `Prospect: ${firstName} ${prospect.lastName ?? ""}, ${title} at ${companyName}`,
    ];
    if (recentNews.length > 0) {
      contextParts.push(
        `Recent news about ${companyName}:\n` +
          recentNews
            .slice(0, 3)
            .map((n) => `- ${n.headline}${n.date ? ` (${n.date})` : ""}`)
            .join("\n"),
      );
    }
    if (industryEvents.length > 0) {
      contextParts.push(
        `Industry events:\n` +
          industryEvents
            .slice(0, 2)
            .map((e) => `- ${e.eventName}${e.date ? ` (${e.date})` : ""}${e.role ? ` — ${e.role}` : ""}`)
            .join("\n"),
      );
    }
    if (triggerEvents.length > 0) {
      contextParts.push(
        `Trigger events:\n` +
          triggerEvents
            .slice(0, 2)
            .map((t) => `- ${t.type}: ${t.description}`)
            .join("\n"),
      );
    }
    if (existingHooks.length > 0) {
      contextParts.push(
        `Existing top hook:\n"${existingHooks[0].hook}"`,
      );
    }

    const signalLabel =
      signalType === "email_open"
        ? "opened your email"
        : signalType === "email_click"
          ? "clicked a link in your email"
          : "accepted your LinkedIn connection";

    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert B2B sales copywriter. Your task is to rewrite a personalisation hook for a follow-up outreach message, using the freshest available context about the prospect's company. The hook must:
- Be 1-2 sentences maximum
- Reference a specific, verifiable recent event (news, funding, product launch, event appearance, hiring surge, etc.)
- Avoid generic praise or vague statements
- Sound natural and conversational — not like a template
- Create a clear bridge between the event and the value proposition`,
        },
        {
          role: "user",
          content: `${contextParts.join("\n\n")}

The prospect just ${signalLabel}. This is a warm signal — rewrite the top hook to be even more timely and relevant using the latest context above. If no fresh context is available, improve the existing hook for specificity and brevity.

Return a JSON object with:
- enhancedHook: the rewritten 1-2 sentence hook
- rationale: one sentence explaining why this hook is more compelling than the original`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "enhanced_hook",
          strict: true,
          schema: {
            type: "object",
            properties: {
              enhancedHook: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["enhancedHook", "rationale"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = result.choices[0]?.message?.content;
    if (!content) return;

    const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
    const enhancedHook = parsed.enhancedHook as string;
    if (!enhancedHook) return;

    // Store the enhanced hook
    await db
      .update(prospectIntelligence)
      .set({
        enhancedHook,
        signalEnhancedAt: new Date(),
      })
      .where(eq(prospectIntelligence.prospectQueueId, prospectQueueId));

    // Fire in-app notification
    await areNotify({
      workspaceId,
      eventType: "hook_enhanced",
      title: "ARE: Outreach hook enhanced",
      body: `${firstName} ${prospect.lastName ?? ""} at ${companyName} ${signalLabel}. The AI has rewritten the personalisation hook using the latest context. Rationale: ${parsed.rationale}`,
      relatedId: campaignId,
      relatedType: "are_campaign",
    });

    console.log(`[SignalEnhancement] Enhanced hook for prospect ${prospectQueueId} (${companyName})`);
  } catch (e) {
    console.error("[SignalEnhancement] Failed for prospect", prospectQueueId, ":", e);
  }
}
