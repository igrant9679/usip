/**
 * seedTours.ts — Seeds demo guided tours for all workspaces that don't yet have any.
 * Idempotent: skips any workspace that already has at least one tour.
 * Called once on server startup (with a short delay to let DB settle).
 */
import { eq, sql } from "drizzle-orm";
import { tours, tourSteps, workspaces } from "../drizzle/schema";
import { getDb } from "./db";

type TourSeed = {
  name: string;
  description: string;
  type: "onboarding" | "feature" | "whats_new" | "custom";
  estimatedMinutes: number;
  pageKey: string;
  steps: {
    title: string;
    bodyMarkdown: string;
    targetDataTourId?: string;
    targetSelector?: string;
    visualTreatment: "spotlight" | "pulse" | "arrow" | "coach";
    advanceCondition: "next_button" | "element_clicked";
  }[];
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
        targetSelector: "nav",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "The Navigation Sidebar",
        bodyMarkdown: "The left sidebar is organised into **6 groups**:\n\n- **Overview** — Dashboard, Inbox, Calendar\n- **Revenue Engine** — ARE Hub, ICP Agent, Campaigns\n- **Acquire** — Leads, Prospects, Contacts\n- **Engage** — Sequences, Email Drafts, AI Queue\n- **Close** — Pipeline, Quotes, Proposals\n- **Retain** — Customers, Renewals, QBRs",
        targetSelector: "nav",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Your Dashboard",
        bodyMarkdown: "The **Dashboard** is your command centre. It shows live KPIs, pipeline health, recent activity, and AI-generated insights. You can customise widgets and add your own charts.",
        targetSelector: "[data-tour-id='dashboard-kpi']",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "The ? Help Button",
        bodyMarkdown: "The **?** button in the bottom-right corner is always available. Click it to search articles, ask the AI assistant, or start any guided tour — including this one.",
        targetSelector: "[aria-label='Open Help Center']",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "You're ready! 🎉",
        bodyMarkdown: "That's the orientation complete. Head to the **Acquire** section to start adding leads and contacts, or explore the **ARE Hub** to set up your automated revenue engine. Good luck!",
        targetSelector: "nav",
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
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Create a New Lead",
        bodyMarkdown: "Click **New lead** to open the creation form. You'll enter the lead's name, company, email, phone, source, and initial score.",
        targetDataTourId: "leads-new-button",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Lead Score",
        bodyMarkdown: "The **score** (0–100) determines priority. Leads above your AI pipeline threshold are automatically drafted personalised outreach emails overnight. You can also trigger scoring manually.",
        targetSelector: "th",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "AI Suggested Next Action",
        bodyMarkdown: "Once a lead has been analysed, the **AI Suggested Action** column shows a one-line recommendation — e.g. \"Send personalised intro email referencing their recent funding round.\" Click the ⚡ icon to generate one.",
        targetSelector: "table",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Promoting a Lead",
        bodyMarkdown: "When a lead is qualified, open the row menu (⋮) and choose **Promote to Contact**. This moves the lead into your Contacts table and creates an Account record if one doesn't exist.",
        targetSelector: "table",
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
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Create a New Sequence",
        bodyMarkdown: "Click **New sequence** to open the sequence builder. Give it a name, choose a goal (e.g. Book a meeting), and set the sending account.",
        targetDataTourId: "sequences-new-button",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
      {
        title: "Adding Steps",
        bodyMarkdown: "Inside the sequence, click **+ Add Step** to add an email step. Choose a delay (e.g. Day 1, Day 3, Day 7), write your subject and body using the rich text editor, and insert personalisation tokens like `{{firstName}}` and `{{companyName}}`.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Enrolling Contacts",
        bodyMarkdown: "To enrol contacts, go to **Contacts**, select the rows you want, and click **Add to Sequence** in the bulk toolbar. You can also enrol from a Segment using the Auto-Enroll rules.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Monitoring Performance",
        bodyMarkdown: "The sequence detail page shows **open rate, click rate, reply rate, and unsubscribe rate** per step. Use this to identify which step is underperforming and A/B test subject lines.",
        targetSelector: "main",
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
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Deal Cards",
        bodyMarkdown: "Each card shows the **deal name, account, value, close date, and win probability**. If the AI has analysed the deal, you'll also see a violet banner with a stage recommendation.",
        targetSelector: ".kanban-column",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "AI Stage Suggestions",
        bodyMarkdown: "When the AI recommends advancing a deal to the next stage (based on email activity, meetings, and notes), a **🧠 AI suggests: [Stage]** banner appears on the card. Click **→ Accept** to submit a stage change request.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Forecast View",
        bodyMarkdown: "Switch to **Forecast View** (top-right toggle) to see a table of all deals with their weighted pipeline value. The **AI Forecast Commentary** panel generates a natural-language summary of pipeline health and risks.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Manager Approvals",
        bodyMarkdown: "If your workspace has approval workflows enabled, stage changes require manager sign-off. Managers see pending approvals in **Pipeline Alerts** and can approve or reject with a note.",
        targetSelector: "main",
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
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "The Enriched Column",
        bodyMarkdown: "The **Enriched** column shows an amber **Enrich** button for contacts that haven't been enriched yet, and a green **Enriched** badge for those that have. Click **Enrich** on any row to start.",
        targetSelector: "table",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Diff-and-Approve Modal",
        bodyMarkdown: "Before any data is written, a **before/after comparison** modal appears. Each field shows the current value and the proposed enriched value. Tick the fields you want to apply and click **Apply Selected**.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Bulk Enrich",
        bodyMarkdown: "Select multiple contacts using the checkboxes, then click **Enrich (N)** in the bulk toolbar to queue them all for enrichment. The background worker processes them automatically.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Setting Up Clodura",
        bodyMarkdown: "To activate enrichment, go to **Settings → Integrations → Clodura.ai** and enter your API key. You can also enable **auto-enrich on contact create** so new contacts are enriched automatically.",
        targetSelector: "main",
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
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "ICP Agent",
        bodyMarkdown: "The **ICP Agent** defines your Ideal Customer Profile — industry, company size, revenue band, tech stack, buying signals. The ARE uses this to score every prospect and prioritise outreach.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Campaigns",
        bodyMarkdown: "**ARE Campaigns** are automated outbound campaigns. Each campaign has a target segment, a sequence, a sending account, and a daily send cap. The ARE executes steps automatically based on prospect behaviour.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Signal Enhancement",
        bodyMarkdown: "The ARE monitors **buying signals** — job postings, funding rounds, tech stack changes, leadership changes — and surfaces them as context for personalised outreach. Each signal increases the prospect's priority score.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "ARE Settings",
        bodyMarkdown: "In **ARE Settings**, configure your daily prospect cap, signal sources, enrichment providers, and auto-approve thresholds. You can also set a confidence minimum below which the ARE will queue drafts for human review.",
        targetSelector: "main",
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
        bodyMarkdown: "The **Renewals** board shows all customers with upcoming contract renewals, organised by renewal date. Each card shows ARR, health score, NPS, and days until renewal.",
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Churn Risk Badges",
        bodyMarkdown: "Each customer card has a **churn risk badge** — Low (green), Medium (amber), High (orange), or Critical (red). These are calculated by the AI based on health score, support tickets, NPS, and activity recency.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Scoring a Customer",
        bodyMarkdown: "Click **Score Risk** on any customer card to run the AI analysis. The badge updates immediately with a colour-coded label and a one-line rationale explaining the score.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Taking Action",
        bodyMarkdown: "For **High** or **Critical** risk customers, the recommended action is to schedule a QBR or executive check-in. Click **Schedule QBR** on the card to create a QBR record and assign it to a CSM.",
        targetSelector: "main",
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
        targetSelector: "main",
        visualTreatment: "coach",
        advanceCondition: "next_button",
      },
      {
        title: "Reviewing a Draft",
        bodyMarkdown: "Click **Review** on any draft to open the full email. You can edit the subject line and body, adjust the tone, or regenerate the entire draft with a different prompt. Click **Approve** when satisfied.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Bulk Approve & Send",
        bodyMarkdown: "Select multiple drafts using the checkboxes and click **Approve Selected** to approve them all at once. Then click **Send Bulk Approved** to dispatch all approved drafts via your configured SMTP account.",
        targetSelector: "main",
        visualTreatment: "spotlight",
        advanceCondition: "next_button",
      },
      {
        title: "Auto-Send Toggle",
        bodyMarkdown: "The **Auto-send approved** toggle (top-right of the queue) enables fully automated sending. When on, all drafts that meet your score and confidence thresholds are sent automatically without manual approval. Use with care!",
        targetSelector: "main",
        visualTreatment: "pulse",
        advanceCondition: "next_button",
      },
    ],
  },
];

export async function seedToursForAllWorkspaces(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Get all workspaces
  const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);

  for (const ws of allWorkspaces) {
    // Check if this workspace already has tours
    const existing = await db
      .select({ c: sql<number>`count(*)` })
      .from(tours)
      .where(eq(tours.workspaceId, ws.id));
    const count = Number(existing[0]?.c ?? 0);
    if (count > 0) continue; // already seeded

    // Insert each tour and its steps
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
          visualTreatment: step.visualTreatment,
          advanceCondition: step.advanceCondition,
          skipAllowed: true,
          backAllowed: i > 0,
        });
      }
    }

    console.log(`[SeedTours] Seeded ${DEMO_TOURS.length} tours for workspace ${ws.id}`);
  }
}
