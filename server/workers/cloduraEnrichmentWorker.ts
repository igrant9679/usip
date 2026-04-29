/**
 * Clodura Enrichment Background Worker
 *
 * Runs every 2 minutes (registered in _core/index.ts).
 * Picks up pending enrichment jobs from clodura_enrichment_jobs,
 * calls the Clodura enrichContact API, applies non-conflicting field
 * updates to the contacts table, writes history rows, and marks the
 * job as completed or failed.
 *
 * Also handles:
 *  - Daily budget cap enforcement per workspace
 *  - Scheduled re-enrichment: contacts with enrichmentStatus="scheduled"
 *    that haven't been enriched in the last 90 days
 *  - Cache purge: removes raw_response from jobs older than 30 days
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  contacts,
  cloduraEnrichmentJobs,
  cloduraEnrichmentSettings,
  contactEnrichmentHistory,
  workspaceIntegrations,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { enrichContact, CloduraError } from "../services/clodura/client";
import { checkRateLimit } from "../services/clodura/rateLimiter";

const BATCH_SIZE = 10; // max jobs per worker tick
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/* ─── Helper: get Clodura API key for workspace ─────────────────────────── */
async function getApiKey(workspaceId: number): Promise<string | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [row] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, "clodura"),
      ),
    )
    .limit(1);
  return (row?.config as any)?.apiKey ?? undefined;
}

/* ─── Field map (mirrors clodura.ts) ────────────────────────────────────── */
const FIELD_MAP: Array<{
  contactKey: string;
  getter: (r: any) => string | null;
}> = [
  { contactKey: "title", getter: (r) => r.personTitle ?? null },
  { contactKey: "seniority", getter: (r) => r.seniority?.[0] ?? null },
  { contactKey: "functionalArea", getter: (r) => r.functional?.[0] ?? null },
  { contactKey: "city", getter: (r) => r.personCity ?? null },
  { contactKey: "state", getter: (r) => r.personState ?? null },
  { contactKey: "country", getter: (r) => r.personCountry ?? null },
  { contactKey: "linkedinUrl", getter: (r) => r.linkedinUrl ?? null },
  { contactKey: "company", getter: (r) => r.organisation?.organisationName ?? null },
  { contactKey: "companyDomain", getter: (r) => r.organisation?.domain ?? null },
  { contactKey: "industry", getter: (r) => r.organisation?.industry ?? null },
  { contactKey: "companyEmployeeSize", getter: (r) => r.organisation?.organisationEmployeeSize ?? null },
  { contactKey: "companyRevenue", getter: (r) => r.organisation?.revenue ?? null },
  { contactKey: "companyFoundedYear", getter: (r) => r.organisation?.foundedYear ? String(r.organisation.foundedYear) : null },
  { contactKey: "companyPhone", getter: (r) => r.organisation?.boardlineNumbers ?? null },
  { contactKey: "companyCity", getter: (r) => r.organisation?.organisationCity ?? null },
  { contactKey: "companyState", getter: (r) => r.organisation?.organisationState ?? null },
  { contactKey: "companyCountry", getter: (r) => r.organisation?.organisationCountry ?? null },
];

/* ─── Main worker tick ──────────────────────────────────────────────────── */
export async function runCloduraEnrichmentWorker(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Pick up pending jobs (oldest first, up to BATCH_SIZE)
  const pendingJobs = await db
    .select()
    .from(cloduraEnrichmentJobs)
    .where(eq(cloduraEnrichmentJobs.status, "pending"))
    .orderBy(cloduraEnrichmentJobs.requestedAt)
    .limit(BATCH_SIZE);

  if (pendingJobs.length === 0) {
    // Check for scheduled re-enrichment
    await scheduleReEnrichment();
    return;
  }

  console.log(`[CloduraWorker] Processing ${pendingJobs.length} enrichment job(s)...`);

  for (const job of pendingJobs) {
    try {
      // Mark as running
      await db
        .update(cloduraEnrichmentJobs)
        .set({ status: "running" })
        .where(eq(cloduraEnrichmentJobs.id, job.id));

      // Get API key
      const apiKey = await getApiKey(job.workspaceId);
      if (!apiKey) {
        await db
          .update(cloduraEnrichmentJobs)
          .set({ status: "failed", error: "No Clodura API key configured for this workspace.", completedAt: new Date() })
          .where(eq(cloduraEnrichmentJobs.id, job.id));
        continue;
      }

      // Check rate limit
      const allowed = await checkRateLimit(job.workspaceId);
      if (!allowed) {
        // Put back to pending — will retry next tick
        await db
          .update(cloduraEnrichmentJobs)
          .set({ status: "pending" })
          .where(eq(cloduraEnrichmentJobs.id, job.id));
        console.log(`[CloduraWorker] Rate limit hit for workspace ${job.workspaceId}, deferring job ${job.id}`);
        break; // stop processing this workspace's jobs for this tick
      }

      // Check daily budget
      const [settings] = await db
        .select()
        .from(cloduraEnrichmentSettings)
        .where(eq(cloduraEnrichmentSettings.workspaceId, job.workspaceId))
        .limit(1);
      const dailyCap = settings?.dailyBudgetCap ?? 1500;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const [{ used }] = await db
        .select({ used: sql<number>`coalesce(sum(credits_consumed), 0)` })
        .from(cloduraEnrichmentJobs)
        .where(
          and(
            eq(cloduraEnrichmentJobs.workspaceId, job.workspaceId),
            sql`${cloduraEnrichmentJobs.requestedAt} >= ${today}`,
            eq(cloduraEnrichmentJobs.status, "completed"),
          ),
        );
      if (Number(used) >= dailyCap) {
        await db
          .update(cloduraEnrichmentJobs)
          .set({ status: "failed", error: `Daily budget cap of ${dailyCap} credits reached. Resets tomorrow.`, completedAt: new Date() })
          .where(eq(cloduraEnrichmentJobs.id, job.id));
        console.log(`[CloduraWorker] Daily budget cap reached for workspace ${job.workspaceId}`);
        break;
      }

      // Fetch contact
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, job.contactId))
        .limit(1);
      if (!contact) {
        await db
          .update(cloduraEnrichmentJobs)
          .set({ status: "failed", error: "Contact not found.", completedAt: new Date() })
          .where(eq(cloduraEnrichmentJobs.id, job.id));
        continue;
      }

      // Call Clodura enrichContact API
      const identifierSet = job.identifierSet as Record<string, string>;
      const raw = await enrichContact(apiKey, identifierSet);

      if (!raw || !raw.personId) {
        // No match
        await db
          .update(cloduraEnrichmentJobs)
          .set({ status: "no_match", completedAt: new Date(), creditsConsumed: 0 })
          .where(eq(cloduraEnrichmentJobs.id, job.id));
        await db
          .update(contacts)
          .set({ enrichmentStatus: "no_match" } as any)
          .where(eq(contacts.id, job.contactId));
        continue;
      }

      // Build field updates (fill_empty mode: only update blank fields)
      const manuallyEdited: string[] = (contact as any).manuallyEditedFields ?? [];
      const mode = (job as any).trigger === "bulk" ? "fill_empty" : "fill_empty"; // default fill_empty
      const updates: Record<string, unknown> = {};
      const historyRows: Array<{ fieldName: string; oldValue: string | null; newValue: string | null }> = [];

      for (const f of FIELD_MAP) {
        const proposed = f.getter(raw);
        if (!proposed) continue;
        if (manuallyEdited.includes(f.contactKey)) continue;
        const current = String((contact as any)[f.contactKey] ?? "");
        if (mode === "fill_empty" && current) continue; // don't overwrite existing values
        if (proposed === current) continue;
        updates[f.contactKey] = proposed;
        historyRows.push({ fieldName: f.contactKey, oldValue: current || null, newValue: proposed });
      }

      if (Object.keys(updates).length > 0) {
        updates.enrichedAt = new Date();
        updates.enrichmentStatus = "enriched";
        await db.update(contacts).set(updates as any).where(eq(contacts.id, job.contactId));

        // Write history rows
        for (const h of historyRows) {
          await db.insert(contactEnrichmentHistory).values({
            workspaceId: job.workspaceId,
            contactId: job.contactId,
            enrichmentJobId: job.id,
            fieldName: h.fieldName,
            oldValue: h.oldValue,
            newValue: h.newValue,
            appliedAt: new Date(),
          });
        }
      } else {
        // No updates needed — still mark enriched
        await db
          .update(contacts)
          .set({ enrichedAt: new Date(), enrichmentStatus: "enriched" } as any)
          .where(eq(contacts.id, job.contactId));
      }

      // Mark job completed
      await db
        .update(cloduraEnrichmentJobs)
        .set({
          status: "completed",
          creditsConsumed: 1,
          rawResponse: raw,
          completedAt: new Date(),
        })
        .where(eq(cloduraEnrichmentJobs.id, job.id));

      console.log(`[CloduraWorker] Job ${job.id} completed — contact ${job.contactId}, ${Object.keys(updates).length} fields updated`);
    } catch (err: any) {
      const isClodura = err instanceof CloduraError;
      const errorMsg = isClodura
        ? `Clodura API error ${err.statusCode}: ${err.message}`
        : String(err?.message ?? err);

      await db
        .update(cloduraEnrichmentJobs)
        .set({ status: "failed", error: errorMsg, completedAt: new Date() })
        .where(eq(cloduraEnrichmentJobs.id, job.id));

      console.error(`[CloduraWorker] Job ${job.id} failed:`, errorMsg);
    }
  }
}

/* ─── Scheduled re-enrichment ───────────────────────────────────────────── */
async function scheduleReEnrichment(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Find all workspaces with auto re-enrichment enabled
  const enabledSettings = await db
    .select()
    .from(cloduraEnrichmentSettings)
    .where(eq(cloduraEnrichmentSettings.autoReEnrichEnabled, true));

  if (enabledSettings.length === 0) return;

  const ninetyDaysAgo = new Date(Date.now() - NINETY_DAYS_MS);

  for (const setting of enabledSettings) {
    const apiKey = await getApiKey(setting.workspaceId);
    if (!apiKey) continue;

    // Find contacts enriched more than 90 days ago (or never enriched but have identifiers)
    const staleContacts = await db
      .select({ id: contacts.id, linkedinUrl: contacts.linkedinUrl, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, setting.workspaceId),
          or(
            lt(contacts.enrichedAt as any, ninetyDaysAgo),
            isNull(contacts.enrichedAt as any),
          ),
        ),
      )
      .limit(50); // max 50 per workspace per tick

    for (const c of staleContacts) {
      // Build identifier set
      let identifierSet: Record<string, string> | null = null;
      if (c.linkedinUrl) {
        identifierSet = { linkedinUrl: c.linkedinUrl };
      } else if (c.email && c.firstName && c.lastName) {
        identifierSet = { email: c.email, firstName: c.firstName, lastName: c.lastName };
      } else if (c.email) {
        identifierSet = { email: c.email };
      }
      if (!identifierSet) continue;

      // Check if there's already a pending job for this contact
      const [existing] = await db
        .select({ id: cloduraEnrichmentJobs.id })
        .from(cloduraEnrichmentJobs)
        .where(
          and(
            eq(cloduraEnrichmentJobs.contactId, c.id),
            eq(cloduraEnrichmentJobs.status, "pending"),
          ),
        )
        .limit(1);
      if (existing) continue;

      await db.insert(cloduraEnrichmentJobs).values({
        workspaceId: setting.workspaceId,
        contactId: c.id,
        trigger: "scheduled",
        identifierSet,
        confidence: c.linkedinUrl ? "highest" : c.email && c.firstName && c.lastName ? "highest" : "medium",
        status: "pending",
        requestedAt: new Date(),
      });
    }
  }
}

/* ─── Cache purge: remove raw_response from old jobs ───────────────────── */
export async function purgeCloduraCaches(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

  const result = await db
    .update(cloduraEnrichmentJobs)
    .set({ rawResponse: null, rawResponsePurgedAt: new Date() })
    .where(
      and(
        lt(cloduraEnrichmentJobs.completedAt as any, thirtyDaysAgo),
        sql`${cloduraEnrichmentJobs.rawResponse} IS NOT NULL`,
        isNull(cloduraEnrichmentJobs.rawResponsePurgedAt),
      ),
    );

  console.log(`[CloduraWorker] Cache purge complete.`);
}
