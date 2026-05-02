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
import { and, eq, isNull, sql } from "drizzle-orm";
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

const DEMO_TOURS: TourSeed[] = [
  // ── 1. Welcome to Velocity ──────────────────────────────────────────────────
  {
    name: "Welcome to Velocity",
    description: "A 5-minute orientation to the platform — learn where everything lives and how the revenue engine works.",
    type: "onboarding",
    estimatedMinutes: 5,
    pageKey: "/dashboard",
    steps: [
      {
        title: "Welcome to Velocity 👋",
        bodyMarkdown: "Velocity is your **Unified Revenue Intelligence Platform**. Everything from lead capture to renewal management lives here. This tour takes ~5 minutes and covers the key areas you'll use every day.",
        targetDataTourId: "sidebar-nav",
        routeTo: "/dashboard",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "The Navigation Sidebar",
        bodyMarkdown: "The left sidebar is organised into **6 groups**:\n\n- **Overview** — Dashboard, Inbox, Calendar\n- **Revenue Engine** — ARE Hub, ICP Agent, Campaigns\n- **Acquire** — Leads, Prospects, Contacts\n- **Engage** — Sequences, Email Drafts, AI Queue\n- **Close** — Pipeline, Quotes, Proposals\n- **Retain** — Customers, Renewals, QBRs",
        targetDataTourId: "sidebar-nav",
        routeTo: "/dashboard",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Your Dashboard KPIs",
        bodyMarkdown: "The **Dashboard** is your command centre. The top row shows live KPIs — Pipeline Value, Closed-Won deals, Active Leads, Customers, and Stale Proposals. Each card is clickable and shows week-over-week delta.",
        targetDataTourId: "dashboard-kpi-grid",
        routeTo: "/dashboard",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Revenue Chart",
        bodyMarkdown: "The **Revenue chart** tracks your closed-won value over time. Use the period selector (top-right of the chart) to switch between weekly, monthly, and quarterly views.",
        targetDataTourId: "dashboard-revenue-chart",
        routeTo: "/dashboard",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "You're ready! 🎉",
        bodyMarkdown: "That's the orientation complete. Head to the **Acquire** section to start adding leads and contacts, or explore the **ARE Hub** to set up your automated revenue engine. Good luck!",
        targetDataTourId: "sidebar-nav",
        routeTo: "/dashboard",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
    ],
  },

  // ── 2. Adding Your First Lead ───────────────────────────────────────────────
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

  // ── 3. Building a Sequence ──────────────────────────────────────────────────
  {
    name: "Building an Email Sequence",
    description: "Create a multi-step outreach sequence with personalised email templates and automated delays.",
    type: "onboarding",
    estimatedMinutes: 4,
    pageKey: "/sequences",
    steps: [
      {
        title: "What Are Sequences?",
        bodyMarkdown: "**Sequences** are automated multi-step outreach campaigns. Each step can be an email, a task reminder, or a LinkedIn action. Steps fire automatically based on delays you configure.",
        targetDataTourId: "sequences-new-button",
        routeTo: "/sequences",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Create a New Sequence",
        bodyMarkdown: "Click **New sequence** to open the sequence builder. Give it a name, choose a goal (e.g. Book a meeting), and set the sending account.",
        targetDataTourId: "sequences-new-button",
        routeTo: "/sequences",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Adding Steps",
        bodyMarkdown: "Inside the sequence, click **+ Add Step** to add an email step. Choose a delay (e.g. Day 1, Day 3, Day 7), write your subject and body using the rich text editor, and insert personalisation tokens like `{{firstName}}` and `{{companyName}}`.",
        targetDataTourId: "sequences-new-button",
        routeTo: "/sequences",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Enrolling Contacts",
        bodyMarkdown: "To enrol contacts, go to **Contacts**, select the rows you want, and click **Add to Sequence** in the bulk toolbar. You can also enrol from a Segment using the Auto-Enroll rules.",
        targetDataTourId: "contacts-new-button",
        routeTo: "/contacts",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Monitoring Performance",
        bodyMarkdown: "The sequence detail page shows **open rate, click rate, reply rate, and unsubscribe rate** per step. Use this to identify which step is underperforming and A/B test subject lines.",
        targetDataTourId: "sequences-new-button",
        routeTo: "/sequences",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
    ],
  },

  // ── 4. Managing the Pipeline ────────────────────────────────────────────────
  {
    name: "Managing Your Pipeline",
    description: "Navigate the Kanban board, update deal stages, and use AI stage suggestions.",
    type: "onboarding",
    estimatedMinutes: 4,
    pageKey: "/pipeline",
    steps: [
      {
        title: "The Pipeline Board",
        bodyMarkdown: "The **Pipeline** is a Kanban board showing all open opportunities organised by stage: Discovery → Qualified → Proposal → Negotiation → Won/Lost. Drag cards between columns to advance deals.",
        targetDataTourId: "pipeline-board",
        routeTo: "/pipeline",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Deal Cards",
        bodyMarkdown: "Each card shows the **deal name, account, value, close date, and win probability**. If the AI has analysed the deal, you'll also see a violet banner with a stage recommendation.",
        targetDataTourId: "pipeline-board",
        routeTo: "/pipeline",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Create a New Opportunity",
        bodyMarkdown: "Click **New opportunity** to add a deal to the board. Set the account, stage, value, close date, and win probability. The AI will analyse it overnight and suggest a next step.",
        targetDataTourId: "pipeline-new-button",
        routeTo: "/pipeline",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Forecast View",
        bodyMarkdown: "Switch to **Forecast View** using the Board / Forecast toggle to see a table of all deals with their weighted pipeline value. The **AI Forecast Commentary** panel generates a natural-language summary of pipeline health and risks.",
        targetDataTourId: "pipeline-view-toggle",
        routeTo: "/pipeline",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Manager Approvals",
        bodyMarkdown: "If your workspace has approval workflows enabled, stage changes require manager sign-off. Managers see pending approvals in **Pipeline Alerts** and can approve or reject with a note.",
        targetDataTourId: "pipeline-board",
        routeTo: "/pipeline",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
    ],
  },

  // ── 5. Enriching Contacts with Clodura ─────────────────────────────────────
  {
    name: "Enriching Contacts with Clodura",
    description: "Use the Clodura.ai integration to enrich contact data with verified emails, phone numbers, and firmographic details.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "/contacts",
    steps: [
      {
        title: "Contact Enrichment",
        bodyMarkdown: "**Enrichment** fills in missing data on your contacts — verified email, direct phone, LinkedIn URL, seniority, functional area, company revenue, and more — using the Clodura.ai database.",
        targetDataTourId: "contacts-new-button",
        routeTo: "/contacts",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "The Enriched Column",
        bodyMarkdown: "The **Enriched** column shows an amber **Enrich** button for contacts that haven't been enriched yet, and a green **Enriched** badge for those that have. Click **Enrich** on any row to start.",
        targetDataTourId: "contacts-new-button",
        routeTo: "/contacts",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Diff-and-Approve Modal",
        bodyMarkdown: "Before any data is written, a **before/after comparison** modal appears. Each field shows the current value and the proposed enriched value. Tick the fields you want to apply and click **Apply Selected**.",
        targetDataTourId: "contacts-new-button",
        routeTo: "/contacts",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Bulk Enrich",
        bodyMarkdown: "Select multiple contacts using the checkboxes, then click **Enrich (N)** in the bulk toolbar to queue them all for enrichment. The background worker processes them automatically.",
        targetDataTourId: "contacts-new-button",
        routeTo: "/contacts",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Setting Up Clodura",
        bodyMarkdown: "To activate enrichment, go to **Settings → Integrations → Clodura.ai** and enter your API key. You can also enable **auto-enrich on contact create** so new contacts are enriched automatically.",
        targetDataTourId: "contacts-new-button",
        routeTo: "/contacts",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
    ],
  },

  // ── 6. The ARE Hub ──────────────────────────────────────────────────────────
  {
    name: "Automated Revenue Engine (ARE)",
    description: "Learn how the ARE Hub automates prospect research, ICP scoring, and outreach campaign execution.",
    type: "feature",
    estimatedMinutes: 5,
    pageKey: "/are-hub",
    steps: [
      {
        title: "What is the ARE Hub?",
        bodyMarkdown: "The **Automated Revenue Engine** is Velocity's AI-powered outbound engine. It researches prospects, scores them against your ICP, generates personalised outreach, and executes campaigns — all automatically.",
        targetDataTourId: "are-funnel-metrics",
        routeTo: "/are-hub",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Pipeline Funnel Metrics",
        bodyMarkdown: "The **Pipeline Funnel** shows how many prospects have been discovered, enriched, approved, contacted, replied, and converted to meetings. This is your ARE's live performance dashboard.",
        targetDataTourId: "are-funnel-metrics",
        routeTo: "/are-hub",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "AI Agents",
        bodyMarkdown: "The **AI Agents** section shows the four autonomous agents: ICP Agent, Enrich Agent, Sequence Agent, and Signal Feedback Agent. Click any agent card to configure or inspect it.",
        targetDataTourId: "are-agents-section",
        routeTo: "/are-hub",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Active Campaigns",
        bodyMarkdown: "**ARE Campaigns** are automated outbound campaigns. Each campaign has a target segment, a sequence, a sending account, and a daily send cap. The ARE executes steps automatically based on prospect behaviour.",
        targetDataTourId: "are-active-campaigns",
        routeTo: "/are-hub",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Live Signal Feed",
        bodyMarkdown: "The **Signal Feed** shows real-time buying signals — job postings, funding rounds, tech stack changes, leadership changes — as they are detected. Each signal increases the prospect's priority score.",
        targetDataTourId: "are-signal-feed",
        routeTo: "/are-hub",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
    ],
  },

  // ── 7. Renewals & Churn Risk ────────────────────────────────────────────────
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

  // ── 8. AI Draft Queue & Auto-Send ──────────────────────────────────────────
  {
    name: "AI Draft Queue & Auto-Send",
    description: "Review AI-generated email drafts, approve them individually or in bulk, and configure auto-send for trusted campaigns.",
    type: "whats_new",
    estimatedMinutes: 3,
    pageKey: "/ai-pipeline",
    steps: [
      {
        title: "The AI Draft Queue",
        bodyMarkdown: "The **AI Draft Queue** shows all email drafts generated by the nightly AI pipeline. Each draft is personalised to the lead using their company context, recent signals, and your brand voice.",
        targetDataTourId: "ai-queue-stats",
        routeTo: "/ai-pipeline",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Draft Review Queue",
        bodyMarkdown: "The right panel shows all **pending drafts**. Click any draft card to expand it and read the full email. You can edit the subject line and body, adjust the tone, or regenerate the entire draft.",
        targetDataTourId: "ai-queue-draft-list",
        routeTo: "/ai-pipeline",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Bulk Approve",
        bodyMarkdown: "Click **Approve All** to approve every pending draft at once. This is useful after reviewing a batch — all approved drafts are queued for sending via your configured SMTP account.",
        targetDataTourId: "ai-queue-approve-all",
        routeTo: "/ai-pipeline",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Auto-Send Toggle",
        bodyMarkdown: "The **Auto-send approved** toggle (top-right of the queue) enables fully automated sending. When on, all drafts that meet your score and confidence thresholds are sent automatically without manual approval. Use with care!",
        targetDataTourId: "ai-queue-draft-list",
        routeTo: "/ai-pipeline",
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
  // The rawMigrations runner may have marked this as applied before the column
  // was actually created (e.g. due to a lock timeout or tracking-table race).
  // ADD COLUMN IF NOT EXISTS is idempotent so this is always safe to run.
  try {
    await db.execute(sql`SELECT routeTo FROM tour_steps LIMIT 0`);
    // column exists — nothing to do
  } catch {
    try {
      await db.execute(
        sql`ALTER TABLE \`tour_steps\` ADD COLUMN IF NOT EXISTS \`routeTo\` varchar(200) NULL`,
      );
      console.log("[SeedTours] Applied routeTo column (self-heal)");
    } catch (alterErr) {
      console.error("[SeedTours] Could not add routeTo column:", (alterErr as Error)?.message);
    }
  }

  // Get all workspaces
  const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);

  for (const ws of allWorkspaces) {
    // Check if this workspace already has tours
    const existing = await db
      .select({ c: sql<number>`count(*)` })
      .from(tours)
      .where(eq(tours.workspaceId, ws.id));
    const count = Number(existing[0]?.c ?? 0);

    if (count === 0) {
      // ── Fresh seed: workspace has no tours yet ──────────────────────────────
      for (const tourSeed of DEMO_TOURS) {
        const r = await db.insert(tours).values({
          workspaceId: ws.id,
          name: tourSeed.name,
          description: tourSeed.description,
          type: tourSeed.type,
          estimatedMinutes: tourSeed.estimatedMinutes,
          pageKey: tourSeed.pageKey,
          status: "published",
        });
        const tourId = Number((r as any)[0]?.insertId ?? 0);
        if (!tourId) continue;

        for (let i = 0; i < tourSeed.steps.length; i++) {
          const step = tourSeed.steps[i]!;
          await db.insert(tourSteps).values({
            tourId,
            sortOrder: i,
            title: step.title,
            bodyMarkdown: step.bodyMarkdown,
            targetDataTourId: step.targetDataTourId ?? null,
            targetSelector: step.targetSelector ?? null,
            routeTo: step.routeTo,
            visualTreatment: step.visualTreatment,
            advanceCondition: step.advanceCondition,
            skipAllowed: true,
            backAllowed: i > 0,
          });
        }
      }
      console.log(`[SeedTours] Seeded ${DEMO_TOURS.length} tours for workspace ${ws.id}`);
    } else {
      // ── Option B re-seed: patch existing steps that have stale selectors ──────
      // Uses raw SQL so it works whether or not migration 0054 has added routeTo.
      // Detects stale steps by checking targetDataTourId against the seed values.
      const existingTours = await db
        .select({ id: tours.id, name: tours.name })
        .from(tours)
        .where(eq(tours.workspaceId, ws.id));

      // Check if routeTo column exists yet
      let routeToExists = false;
      try {
        await db.execute(sql`SELECT routeTo FROM tour_steps LIMIT 0`);
        routeToExists = true;
      } catch {
        // column not yet added by migration 0054
      }

      let patchedCount = 0;
      for (const existingTour of existingTours) {
        // Find the matching seed by name
        const seed = DEMO_TOURS.find((s) => s.name === existingTour.name);
        if (!seed) continue;

        // Get all steps for this tour via raw SQL (avoids column-not-found errors)
        const [rawSteps] = await db.execute(
          sql`SELECT id, sortOrder, targetDataTourId FROM tour_steps WHERE tourId = ${existingTour.id} ORDER BY sortOrder`,
        ) as unknown as [Array<{id: number; sortOrder: number; targetDataTourId: string | null}>, unknown];

        for (const rawStep of rawSteps ?? []) {
          const seedStep = seed.steps[rawStep.sortOrder];
          if (!seedStep) continue;
          // Always patch: all existing steps were seeded before routeTo existed
          // and have wrong targetSelector values that need to be corrected.

          if (routeToExists) {
            await db.execute(
              sql`UPDATE tour_steps SET targetDataTourId = ${seedStep.targetDataTourId ?? null}, targetSelector = ${seedStep.targetSelector ?? null}, routeTo = ${seedStep.routeTo} WHERE id = ${rawStep.id}`,
            );
          } else {
            await db.execute(
              sql`UPDATE tour_steps SET targetDataTourId = ${seedStep.targetDataTourId ?? null}, targetSelector = ${seedStep.targetSelector ?? null} WHERE id = ${rawStep.id}`,
            );
          }
          patchedCount++;
        }
      }
      if (patchedCount > 0) {
        console.log(`[SeedTours] Patched ${patchedCount} stale steps for workspace ${ws.id} (routeToExists=${routeToExists})`);
      }
    }
  }
}
