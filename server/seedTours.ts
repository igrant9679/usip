/**
 * seedTours.ts — Seeds demo guided tours for all workspaces.
 *
 * Seeding strategy (Option B — idempotent re-seed):
 *  - For workspaces with NO tours: inserts all DEMO_TOURS fresh.
 *  - For workspaces that already have tours: updates any step whose routeTo IS NULL
 *    (i.e. the old broken steps that were seeded before routeTo existed).
 *    Steps that an admin has already edited (routeTo is set) are left untouched.
 *
 * Called once on server startup (with a short delay to let DB settle).
 */
import { and, eq, sql } from "drizzle-orm";
import { tours, tourSteps, workspaces } from "../drizzle/schema";
import { getDb } from "./db";

type StepSeed = {
  title: string;
  bodyMarkdown: string;
  targetDataTourId?: string;
  targetSelector?: string;
  /** Route the TourEngine navigates to before spotlighting this step's target. */
  routeTo: string;
  visualTreatment: "spotlight" | "pulse" | "arrow" | "coach";
  advanceCondition: "next_button" | "element_clicked";
};

type TourSeed = {
  name: string;
  description: string;
  type: "onboarding" | "feature" | "whats_new" | "custom";
  estimatedMinutes: number;
  pageKey: string;
  steps: StepSeed[];
};

// NOTE: The generic "Welcome / Sequence / Pipeline / ARE / AI Draft Queue" demo
// tours were retired here — they are superseded by the 10 SDR tours seeded in
// seedHelpContent.ts (which also deletes the old rows from existing workspaces).
// Only the two non-overlapping legacy tours remain below.
const DEMO_TOURS: TourSeed[] = [
  // ── Adding Your First Lead ──────────────────────────────────────────────────
  {
    name: "Adding Your First Lead",
    description: "Learn how to capture a new lead, set a score, and assign it to a rep.",
    type: "onboarding",
    estimatedMinutes: 3,
    pageKey: "/leads",
    steps: [
      {
        title: "The Leads Page",
        bodyMarkdown: "**Leads** are inbound prospects who haven't yet been qualified as contacts. This table shows all leads across your workspace with score, status, source, and owner.",
        targetDataTourId: "leads-new-button",
        routeTo: "/leads",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Create a New Lead",
        bodyMarkdown: "Click **New lead** to open the creation form. You'll enter the lead's name, company, email, phone, source, and initial score.",
        targetDataTourId: "leads-new-button",
        routeTo: "/leads",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Lead Score",
        bodyMarkdown: "The **score** (0–100) determines priority. Leads above your AI pipeline threshold are automatically drafted personalised outreach emails overnight. You can also trigger scoring manually.",
        targetDataTourId: "leads-new-button",
        routeTo: "/leads",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "AI Suggested Next Action",
        bodyMarkdown: "Once a lead has been analysed, the **AI Suggested Action** column shows a one-line recommendation — e.g. \"Send personalised intro email referencing their recent funding round.\" Click the ⚡ icon to generate one.",
        targetDataTourId: "leads-new-button",
        routeTo: "/leads",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Promoting a Lead",
        bodyMarkdown: "When a lead is qualified, open the row menu (⋮) and choose **Promote to Contact**. This moves the lead into your Contacts table and creates an Account record if one doesn't exist.",
        targetDataTourId: "leads-new-button",
        routeTo: "/leads",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
    ],
  },

  // ── Renewals & Churn Risk ───────────────────────────────────────────────────
  {
    name: "Renewals & Churn Risk AI",
    description: "Use AI churn-risk scoring to prioritise renewal conversations and reduce customer attrition.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "/renewals",
    steps: [
      {
        title: "The Renewals Board",
        bodyMarkdown: "The **Renewals** board shows all customers with upcoming contract renewals, organised by renewal stage. Each card shows ARR, health score, and days until renewal.",
        targetDataTourId: "renewals-board",
        routeTo: "/renewals",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Churn Risk Badges",
        bodyMarkdown: "Each customer card has a **churn risk badge** — Low (green), Medium (amber), High (orange), or Critical (red). These are calculated by the AI based on health score, support tickets, NPS, and activity recency.",
        targetDataTourId: "renewals-board",
        routeTo: "/renewals",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Scoring a Customer",
        bodyMarkdown: "Click **Score churn risk** on any customer card to run the AI analysis. The badge updates immediately with a colour-coded label and a one-line rationale explaining the score.",
        targetDataTourId: "renewals-score-churn",
        routeTo: "/renewals",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Taking Action",
        bodyMarkdown: "For **High** or **Critical** risk customers, the recommended action is to schedule a QBR or executive check-in. Click **Schedule QBR** on the card to create a QBR record and assign it to a CSM.",
        targetDataTourId: "renewals-board",
        routeTo: "/renewals",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
    ],
  },

];

export async function seedToursForAllWorkspaces(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // ── Self-healing: ensure routeTo column exists (migration 0054) ─────────────
  // Uses a SELECT probe to check existence first, then plain ADD COLUMN
  // (without IF NOT EXISTS — not supported on MySQL < 8.0.3).
  try {
    await db.execute(sql`SELECT routeTo FROM tour_steps LIMIT 0`);
    // column exists — nothing to do
  } catch {
    try {
      // Plain ADD COLUMN — safe because we only reach here when the column
      // genuinely doesn't exist (the SELECT above would have succeeded otherwise).
      await db.execute(
        sql`ALTER TABLE \`tour_steps\` ADD COLUMN \`routeTo\` varchar(200) NULL`,
      );
      console.log("[SeedTours] Applied routeTo column (self-heal)");
    } catch (alterErr) {
      console.error("[SeedTours] Could not add routeTo column:", (alterErr as Error)?.message);
    }
  }

  // Get all workspaces
  const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);

  // Does the routeTo column exist yet? (The self-heal above usually ensures it,
  // but guard anyway so an insert can't fail on a fresh schema.)
  let routeToExists = false;
  try {
    await db.execute(sql`SELECT routeTo FROM tour_steps LIMIT 0`);
    routeToExists = true;
  } catch {
    // column not yet added by migration 0054
  }

  // Idempotent per-tour upsert keyed by (workspaceId, name). The two legacy tours
  // must exist for every workspace regardless of how many other tours (e.g. the
  // SDR tours seeded by seedHelpContent.ts) are already present — so we no longer
  // gate on "workspace has zero tours". Steps are delete+reinserted for a clean
  // re-seed (user_tour_progress tracks tourId + step index, not step IDs).
  for (const ws of allWorkspaces) {
    for (const tourSeed of DEMO_TOURS) {
      const [existingTour] = await db
        .select({ id: tours.id })
        .from(tours)
        .where(and(eq(tours.workspaceId, ws.id), eq(tours.name, tourSeed.name)))
        .limit(1);

      let tourId: number;
      if (existingTour) {
        tourId = existingTour.id;
        await db
          .update(tours)
          .set({
            description: tourSeed.description,
            type: tourSeed.type,
            estimatedMinutes: tourSeed.estimatedMinutes,
            pageKey: tourSeed.pageKey,
            status: "published",
          })
          .where(eq(tours.id, tourId));
        await db.delete(tourSteps).where(eq(tourSteps.tourId, tourId));
      } else {
        const r = await db.insert(tours).values({
          workspaceId: ws.id,
          name: tourSeed.name,
          description: tourSeed.description,
          type: tourSeed.type,
          estimatedMinutes: tourSeed.estimatedMinutes,
          pageKey: tourSeed.pageKey,
          status: "published",
        });
        tourId = Number((r as any)[0]?.insertId ?? 0);
      }
      if (!tourId) continue;

      for (let i = 0; i < tourSeed.steps.length; i++) {
        const step = tourSeed.steps[i]!;
        const values: Record<string, unknown> = {
          tourId,
          sortOrder: i,
          title: step.title,
          bodyMarkdown: step.bodyMarkdown,
          targetDataTourId: step.targetDataTourId ?? null,
          targetSelector: step.targetSelector ?? null,
          visualTreatment: step.visualTreatment,
          advanceCondition: step.advanceCondition,
          skipAllowed: true,
          backAllowed: i > 0,
        };
        if (routeToExists) values.routeTo = step.routeTo;
        await db.insert(tourSteps).values(values as any);
      }
    }
  }
  console.log(`[SeedTours] Ensured ${DEMO_TOURS.length} legacy tour(s) across ${allWorkspaces.length} workspace(s)`);
}
