/**
 * Nightly AI Pipeline Batch Processor (Feature 45)
 *
 * Runs at midnight for each workspace that has nightlyPipelineEnabled=true.
 * Finds leads with score >= nightlyScoreThreshold that haven't had a pipeline
 * job in the last 7 days, and triggers the 5-stage research-to-email pipeline
 * for up to 50 leads per workspace per night.
 */
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { aiPipelineJobs, leads, workspaceSettings, workspaces } from "../drizzle/schema";
import { getDb } from "./db";
import { runPipelineForContact } from "./routers/aiPipeline";

const MAX_PER_WORKSPACE = 50;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function runNightlyBatch(): Promise<{ workspacesProcessed: number; totalTriggered: number; totalSkipped: number }> {
  const db = await getDb();
  if (!db) return { workspacesProcessed: 0, totalTriggered: 0, totalSkipped: 0 };

  console.log("[NightlyBatch] Starting nightly AI pipeline batch...");

  // Get all workspaces with nightly pipeline enabled
  const enabledSettings = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.nightlyPipelineEnabled, true));

  if (enabledSettings.length === 0) {
    console.log("[NightlyBatch] No workspaces have nightly pipeline enabled.");
    return { workspacesProcessed: 0, totalTriggered: 0, totalSkipped: 0 };
  }

  let totalTriggered = 0;
  let totalSkipped = 0;
  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  for (const setting of enabledSettings) {
    const workspaceId = setting.workspaceId;
    const scoreThreshold = setting.nightlyScoreThreshold ?? 60;

    try {
      // Find leads above score threshold in this workspace
      const eligibleLeads = await db
        .select({ id: leads.id, email: leads.email, score: leads.score })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, workspaceId),
            gte(leads.score, scoreThreshold),
            // Only leads with an email address
            sql`${leads.email} IS NOT NULL AND ${leads.email} != ''`,
          )
        )
        .limit(MAX_PER_WORKSPACE * 3); // fetch more, filter by recent jobs below

      if (eligibleLeads.length === 0) {
        console.log(`[NightlyBatch] Workspace ${workspaceId}: no eligible leads above score ${scoreThreshold}`);
        continue;
      }

      // Find leads that already have a recent pipeline job (within 7 days)
      const eligibleLeadIds = eligibleLeads.map((l) => l.id);
      const recentJobs = await db
        .select({ leadId: aiPipelineJobs.leadId })
        .from(aiPipelineJobs)
        .where(
          and(
            eq(aiPipelineJobs.workspaceId, workspaceId),
            sql`${aiPipelineJobs.leadId} IN (${sql.join(eligibleLeadIds.map((id) => sql`${id}`), sql`, `)})`,
            gte(aiPipelineJobs.createdAt, sevenDaysAgo),
          )
        );

      const recentLeadIds = new Set(recentJobs.map((j) => j.leadId).filter(Boolean) as number[]);

      // Filter out leads with recent jobs
      const toProcess = eligibleLeads
        .filter((l) => !recentLeadIds.has(l.id))
        .slice(0, MAX_PER_WORKSPACE);

      console.log(`[NightlyBatch] Workspace ${workspaceId}: ${toProcess.length} leads to process (${eligibleLeads.length - toProcess.length} skipped — recent job or over cap)`);

      for (const lead of toProcess) {
        try {
          // Create a pipeline job record and trigger async (fire-and-forget per lead)
          const [jobRow] = await db.insert(aiPipelineJobs).values({
            workspaceId,
            leadId: lead.id,
            status: "queued",
            triggeredByUserId: 0, // 0 = system-triggered
          }).$returningId();

          // Run pipeline asynchronously (don't await — nightly batch is fire-and-forget)
          runPipelineForContact(workspaceId, jobRow.id, null, lead.id, 0)
            .catch((e: unknown) => console.error(`[NightlyBatch] Pipeline failed for lead ${lead.id}:`, e));

          totalTriggered++;
        } catch (err) {
          console.error(`[NightlyBatch] Failed to queue lead ${lead.id}:`, err);
          totalSkipped++;
        }
      }

      totalSkipped += eligibleLeads.length - toProcess.length;
    } catch (err) {
      console.error(`[NightlyBatch] Error processing workspace ${workspaceId}:`, err);
    }
  }

  console.log(`[NightlyBatch] Done. Workspaces: ${enabledSettings.length}, Triggered: ${totalTriggered}, Skipped: ${totalSkipped}`);
  return { workspacesProcessed: enabledSettings.length, totalTriggered, totalSkipped };
}
