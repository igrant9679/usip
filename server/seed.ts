/**
 * USIP demo seeder. Idempotent — only seeds once per workspace.
 * Called from the auth flow after the first workspace is created for a user.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  campaigns,
  contacts,
  contractAmendments,
  customers,
  dashboards,
  dashboardWidgets,
  enrollments,
  emailDrafts,
  leads,
  opportunities,
  opportunityContactRoles,
  products,
  qbrs,
  sequences,
  socialAccounts,
  socialPosts,
  supportTickets,
  tasks,
  territories,
  workflowRules,
  workspaceMembers,
  workspaces,
} from "../drizzle/schema";
import { getDb } from "./db";

const COMPANIES = [
  { name: "Avalon Foundation", industry: "Nonprofit", domain: "avalonfnd.org", region: "Northeast" },
  { name: "Meridian Health", industry: "Healthcare", domain: "meridianhealth.com", region: "Midwest" },
  { name: "Northline Capital", industry: "Finance", domain: "northlinecap.com", region: "Northeast" },
  { name: "Borealis Logistics", industry: "Logistics", domain: "borealis.io", region: "West" },
  { name: "Stonehaven Insurance", industry: "Insurance", domain: "stonehaven-ins.com", region: "South" },
  { name: "Halcyon Analytics", industry: "SaaS", domain: "halcyon.ai", region: "West" },
  { name: "Ironpeak Manufacturing", industry: "Manufacturing", domain: "ironpeak.co", region: "Midwest" },
  { name: "Civic Energy", industry: "Utilities", domain: "civicenergy.com", region: "Midwest" },
  { name: "Fallow & Fisk", industry: "Legal", domain: "fallowfisk.com", region: "Northeast" },
  { name: "Verity Education", industry: "Education", domain: "verityed.org", region: "South" },
  { name: "Larkstone Realty", industry: "Real Estate", domain: "larkstone.com", region: "South" },
  { name: "Pomelo Software", industry: "SaaS", domain: "pomelo.dev", region: "West" },
  { name: "Kestrel Biotech", industry: "Biotech", domain: "kestrelbio.com", region: "Northeast" },
  { name: "Quiver Media", industry: "Media", domain: "quiver.media", region: "West" },
  { name: "Summit Trust Bank", industry: "Finance", domain: "summittrust.com", region: "Northeast" },
  { name: "Ashburn Community Fdn", industry: "Nonprofit", domain: "ashburncf.org", region: "South" },
  { name: "Tideline Ventures", industry: "Venture Capital", domain: "tideline.vc", region: "West" },
  { name: "Cedarhill Aerospace", industry: "Aerospace", domain: "cedarhill.aero", region: "South" },
  { name: "Beacon Nonprofit Network", industry: "Nonprofit", domain: "beaconnet.org", region: "Northeast" },
  { name: "Solstice Retail Group", industry: "Retail", domain: "solsticeretail.com", region: "Midwest" },
  { name: "Harbinger Security", industry: "Cybersecurity", domain: "harbingersec.io", region: "West" },
  { name: "Thornbury Pharma", industry: "Pharma", domain: "thornburypharma.com", region: "Northeast" },
  { name: "Orchid Labs", industry: "Biotech", domain: "orchidlabs.bio", region: "Northeast" },
  { name: "Ridgemark Partners", industry: "Consulting", domain: "ridgemark.com", region: "South" },
];

const FIRST_NAMES = ["Ava", "Noah", "Liam", "Maya", "Eli", "Zara", "Owen", "Priya", "Ethan", "Nia", "Leo", "Iris", "Kai", "Sana", "Mateo", "Ana", "Ravi", "Jade", "Cyrus", "Grace", "Jonas", "Nadia", "Theo", "Amara", "Idris", "Daria", "Nico", "Yumi", "Malik", "Esme", "Finn", "Anya", "Kiran", "Lia", "Omar", "Petra", "Arjun", "Sofia", "Tess", "Rami", "June", "Asa", "Lena", "Victor", "Mei", "Rafael", "Talia"];
const LAST_NAMES = ["Okafor", "Chen", "Lindgren", "Shah", "Mercer", "Bishara", "Silva", "Ortega", "Novak", "Park", "Romano", "Bergström", "Adebayo", "Hayashi", "Kerry", "Abrams", "Knox", "Vance", "Seidl", "Dumont", "Kurtz", "Pires", "Amaya", "Trent", "Holloway", "Vogel", "Pryce", "Saldaña", "Halliwell", "Forsyth", "Rask", "Kitamura", "Velasco", "Radcliffe", "Zayid", "Halstead", "Brandt", "Elbaz", "Torres", "Ng", "Mahler", "Albright", "Sosa"];
const TITLES = ["Chief Executive Officer", "Chief Operating Officer", "Chief Financial Officer", "Chief Revenue Officer", "Chief Technology Officer", "VP of Sales", "VP of Marketing", "VP of Operations", "Director of Development", "Director of Philanthropy", "Director of Partnerships", "Director of Marketing", "Head of Growth", "Senior Manager Revenue Operations", "Major Gifts Officer", "Executive Director", "Programs Director"];

const STAGES = ["discovery", "qualified", "proposal", "negotiation", "won"] as const;
const SOURCES = ["LinkedIn", "Referral", "Inbound", "Event", "CSV import", "Cold outbound"];

export function computeHealth(input: { productUsage: number; engagement: number; supportHealth: number; npsScore: number }): number {
  const { productUsage, engagement, supportHealth, npsScore } = input;
  return Math.round(productUsage * 0.35 + engagement * 0.25 + supportHealth * 0.2 + ((npsScore + 100) / 2) * 0.2);
}

export function churnRiskFromScore(score: number): "low" | "medium" | "high" {
  if (score < 45) return "high";
  if (score < 65) return "medium";
  return "low";
}

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function daysFromNow(d: number) {
  return new Date(Date.now() + d * 86400000);
}

export async function isWorkspaceSeeded(workspaceId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  const r = await db.select({ c: sql<number>`count(*)` }).from(accounts).where(eq(accounts.workspaceId, workspaceId));
  return Number(r[0]?.c ?? 0) > 0;
}

export async function seedWorkspace(workspaceId: number, ownerUserId: number) {
  const db = await getDb();
  if (!db) return;

  if (await isWorkspaceSeeded(workspaceId)) return;

  // Territories
  const territoryIds: number[] = [];
  for (const name of ["Northeast", "Midwest", "South", "West"]) {
    const r = await db.insert(territories).values({
      workspaceId, name, ownerUserId,
      rules: { regions: [name] },
    });
    territoryIds.push(Number((r as any)[0]?.insertId ?? 0));
  }

  // Accounts (24)
  const accountIds: number[] = [];
  for (const c of COMPANIES) {
    const r = await db.insert(accounts).values({
      workspaceId,
      name: c.name,
      domain: c.domain,
      industry: c.industry,
      region: c.region,
      employeeBand: rand(["50-200", "200-500", "500-1000", "1000-5000", "5000+"]),
      revenueBand: rand(["$10M-50M", "$50M-200M", "$200M-1B", "$1B+"]),
      arr: String(randInt(0, 350) * 1000),
      ownerUserId,
    });
    accountIds.push(Number((r as any)[0]?.insertId ?? 0));
  }

  // Set 4 parent/child hierarchies (e.g., parent group with subsidiary nonprofit)
  if (accountIds.length > 6) {
    await db.update(accounts).set({ parentAccountId: accountIds[0] }).where(eq(accounts.id, accountIds[15]!));
    await db.update(accounts).set({ parentAccountId: accountIds[2] }).where(eq(accounts.id, accountIds[14]!));
    await db.update(accounts).set({ parentAccountId: accountIds[12] }).where(eq(accounts.id, accountIds[22]!));
  }

  // Contacts (3 per account)
  const contactIds: number[] = [];
  for (const accId of accountIds) {
    const n = randInt(2, 4);
    for (let i = 0; i < n; i++) {
      const fn = rand(FIRST_NAMES);
      const ln = rand(LAST_NAMES);
      const r = await db.insert(contacts).values({
        workspaceId,
        accountId: accId,
        firstName: fn,
        lastName: ln,
        title: rand(TITLES),
        email: `${fn.toLowerCase()}.${ln.toLowerCase().replace(/[^a-z]/g, "")}@example.com`,
        phone: `+1-555-${randInt(100, 999)}-${randInt(1000, 9999)}`,
        seniority: rand(["C-Level", "VP", "Director", "Manager"]),
        isPrimary: i === 0,
        ownerUserId,
      });
      contactIds.push(Number((r as any)[0]?.insertId ?? 0));
    }
  }

  // Leads (40, unconverted)
  for (let i = 0; i < 40; i++) {
    const fn = rand(FIRST_NAMES);
    const ln = rand(LAST_NAMES);
    const co = rand(COMPANIES);
    const score = randInt(10, 95);
    await db.insert(leads).values({
      workspaceId,
      firstName: fn,
      lastName: ln,
      email: `${fn.toLowerCase()}.${ln.toLowerCase().replace(/[^a-z]/g, "")}@${co.domain}`,
      phone: `+1-555-${randInt(100, 999)}-${randInt(1000, 9999)}`,
      company: co.name,
      title: rand(TITLES),
      source: rand(SOURCES),
      status: rand(["new", "new", "working", "qualified", "unqualified"] as const),
      score,
      grade: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D",
      scoreReasons: [
        score >= 60 ? "Senior title (+15)" : "Mid-level title (+5)",
        "Engaged with email (+10)",
        score >= 70 ? "Visited pricing page (+12)" : "Visited blog (+3)",
      ],
      tags: ["ICP-fit"],
      ownerUserId,
    });
  }

  // Opportunities (32 total, some won, some open)
  const oppIds: number[] = [];
  for (let i = 0; i < 32; i++) {
    const stage = rand(STAGES);
    const value = randInt(15, 380) * 1000;
    const wp = stage === "won" ? 100 : stage === "negotiation" ? randInt(60, 90) : stage === "proposal" ? randInt(40, 70) : stage === "qualified" ? randInt(25, 55) : randInt(10, 35);
    const accId = rand(accountIds);
    const accName = COMPANIES[accountIds.indexOf(accId)]?.name ?? "Account";
    const r = await db.insert(opportunities).values({
      workspaceId,
      accountId: accId,
      name: `${accName} – ${rand(["Annual subscription", "Pilot expansion", "Renewal + upsell", "Multi-year deal", "Strategic partnership"])}`,
      stage,
      value: String(value),
      winProb: wp,
      closeDate: daysFromNow(stage === "won" ? -randInt(1, 60) : randInt(5, 90)),
      daysInStage: randInt(2, 35),
      aiNote: rand(["Champion confirmed.", "Awaiting legal review.", "Procurement engaged.", "Pricing pushback expected.", "Multi-thread in progress."]),
      nextStep: rand(["Send revised quote", "Schedule exec sponsor sync", "Confirm security review", "Finalize MSA terms"]),
      ownerUserId,
    });
    oppIds.push(Number((r as any)[0]?.insertId ?? 0));
  }

  // Opportunity Contact Roles (1-2 per open opp)
  for (const oppId of oppIds.slice(0, 20)) {
    const cIds = contactIds.slice(randInt(0, contactIds.length - 4), randInt(0, contactIds.length - 4) + 2);
    for (let i = 0; i < cIds.length; i++) {
      try {
        await db.insert(opportunityContactRoles).values({
          workspaceId,
          opportunityId: oppId,
          contactId: cIds[i]!,
          role: i === 0 ? "champion" : "decision_maker",
          isPrimary: i === 0,
        });
      } catch { /* uq dup */ }
    }
  }

  // Customers (from won opps)
  const wonOpps = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "won")));
  for (const opp of wonOpps) {
    const start = daysFromNow(-randInt(60, 600));
    const end = new Date(start.getTime() + 365 * 86400000);
    const usage = randInt(30, 95);
    const eng = randInt(25, 95);
    const supp = randInt(40, 95);
    const nps = randInt(-20, 70);
    const score = computeHealth({ productUsage: usage, engagement: eng, supportHealth: supp, npsScore: nps });
    const tier = score >= 75 ? "healthy" : score >= 55 ? "watch" : score >= 35 ? "at_risk" : "critical";
    const daysToRenewal = Math.round((end.getTime() - Date.now()) / 86400000);
    const renewalStage = daysToRenewal < 0 ? "renewed" : daysToRenewal <= 30 ? "thirty" : daysToRenewal <= 60 ? "sixty" : daysToRenewal <= 90 ? "ninety" : "early";

    const r = await db.insert(customers).values({
      workspaceId,
      accountId: opp.accountId,
      arr: opp.value,
      contractStart: start,
      contractEnd: end,
      tier: rand(["enterprise", "midmarket", "smb"] as const),
      cmUserId: ownerUserId,
      healthScore: score,
      healthTier: tier,
      usageScore: usage,
      engagementScore: eng,
      supportScore: supp,
      npsScore: nps,
      npsHistory: Array.from({ length: 6 }, (_, i) => ({
        month: i,
        score: Math.max(-100, Math.min(100, nps + randInt(-15, 15))),
      })),
      expansionPotential: String(randInt(10, 80) * 1000),
      aiPlay: tier === "critical" || tier === "at_risk"
        ? "Immediate exec outreach + roadmap review"
        : tier === "watch" ? "Schedule QBR with usage deep-dive" : "Identify expansion via team-licensing pitch",
      renewalStage,
    });
    const custId = Number((r as any)[0]?.insertId ?? 0);

    // Tickets
    for (let i = 0; i < randInt(0, 3); i++) {
      await db.insert(supportTickets).values({
        workspaceId,
        customerId: custId,
        subject: rand(["SSO config issue", "Reporting export bug", "API rate limit raised", "Onboarding question"]),
        severity: rand(["low", "medium", "high"] as const),
        status: rand(["open", "resolved", "closed"] as const),
      });
    }

    // Amendments
    if (Math.random() > 0.6) {
      await db.insert(contractAmendments).values({
        workspaceId,
        customerId: custId,
        type: rand(["upgrade", "addon", "renewal"] as const),
        arrDelta: String(randInt(5, 40) * 1000),
        effectiveAt: daysFromNow(-randInt(30, 200)),
        notes: "Annual true-up",
        createdByUserId: ownerUserId,
      });
    }

    // QBR
    if (Math.random() > 0.5) {
      await db.insert(qbrs).values({
        workspaceId,
        customerId: custId,
        scheduledAt: daysFromNow(randInt(7, 60)),
        status: "scheduled",
        aiPrep: { wins: ["Adoption up 23% QoQ"], risks: ["Champion role change"], asks: ["Expand to 2nd team"] },
      });
    }
  }

  // Sequences (3)
  const seqIds: number[] = [];
  for (const seq of [
    { name: "Cold outbound — VP RevOps", steps: [{ type: "email", subject: "Quick question" }, { type: "wait", days: 3 }, { type: "email", subject: "Re: quick question" }, { type: "wait", days: 4 }, { type: "task", body: "LinkedIn connection" }] },
    { name: "Inbound nurture — pricing page visit", steps: [{ type: "email", subject: "Saw you visited pricing" }, { type: "wait", days: 2 }, { type: "email", subject: "Demo this week?" }] },
    { name: "Champion re-engagement", steps: [{ type: "email", subject: "Catching up" }, { type: "wait", days: 5 }, { type: "email", subject: "Resource share" }] },
  ]) {
    const r = await db.insert(sequences).values({
      workspaceId, name: seq.name, status: "active", steps: seq.steps, ownerUserId, enrolledCount: randInt(8, 30),
    });
    seqIds.push(Number((r as any)[0]?.insertId ?? 0));
  }

  // Enrollments
  for (const cId of contactIds.slice(0, 15)) {
    await db.insert(enrollments).values({
      workspaceId, sequenceId: rand(seqIds), contactId: cId, status: "active", currentStep: randInt(0, 2), nextActionAt: daysFromNow(randInt(0, 7)),
    });
  }

  // Email drafts (pending review)
  for (let i = 0; i < 6; i++) {
    await db.insert(emailDrafts).values({
      workspaceId,
      subject: rand(["Following up on our chat", "Quick question on your priorities", "Resource that might help", "Re: pricing discussion"]),
      body: "Hi {{firstName}},\n\nNoticed you're working on revenue ops modernization. Curious how you're handling pipeline visibility today — happy to share what we're seeing.\n\nWorth 15 minutes?\n\nBest,\n{{senderName}}",
      toContactId: rand(contactIds),
      status: "pending_review",
      aiGenerated: true,
      aiPrompt: "Write a short follow-up email to a VP of RevOps after a discovery call.",
      createdByUserId: ownerUserId,
    });
  }

  // Tasks
  for (let i = 0; i < 20; i++) {
    await db.insert(tasks).values({
      workspaceId,
      title: rand(["Call champion", "Send pricing breakdown", "Confirm security review timing", "Schedule QBR", "Draft renewal proposal"]),
      type: rand(["call", "email", "meeting", "todo"] as const),
      priority: rand(["normal", "normal", "high", "urgent"] as const),
      status: "open",
      dueAt: daysFromNow(randInt(-2, 14)),
      ownerUserId,
      relatedType: "opportunity",
      relatedId: rand(oppIds),
    });
  }

  // Workflow rules (3)
  for (const wf of [
    { name: "Auto-assign new leads to RevOps", triggerType: "record_created" as const, triggerConfig: { entity: "lead" }, conditions: [{ field: "score", op: ">=", value: 60 }], actions: [{ type: "update_field", params: { field: "ownerUserId", value: ownerUserId } }] },
    { name: "Flag stalled deals after 14d", triggerType: "schedule" as const, triggerConfig: { cron: "0 9 * * *" }, conditions: [{ field: "daysInStage", op: ">=", value: 14 }, { field: "stage", op: "in", value: ["proposal", "negotiation"] }], actions: [{ type: "create_task", params: { title: "Re-engage stalled deal", priority: "high" } }, { type: "notify", params: { kind: "system" } }] },
    { name: "Churn risk escalation", triggerType: "field_equals" as const, triggerConfig: { entity: "customer", field: "healthTier", value: "critical" }, conditions: [], actions: [{ type: "create_task", params: { title: "Churn intervention", priority: "urgent" } }] },
  ]) {
    await db.insert(workflowRules).values({
      workspaceId, ...wf, enabled: true, fireCount: randInt(3, 25), lastFiredAt: daysFromNow(-randInt(0, 5)),
    });
  }

  // Social accounts (4 connected stubs)
  const saIds: number[] = [];
  for (const p of [
    { platform: "linkedin" as const, handle: "lsi-media", displayName: "LSI Media" },
    { platform: "twitter" as const, handle: "lsimedia", displayName: "LSI Media" },
    { platform: "facebook" as const, handle: "lsimedia", displayName: "LSI Media" },
    { platform: "instagram" as const, handle: "lsi.media", displayName: "LSI Media" },
  ]) {
    const r = await db.insert(socialAccounts).values({
      workspaceId, platform: p.platform, handle: p.handle, displayName: p.displayName, connected: true, accessTokenStub: "stub_" + Math.random().toString(36).slice(2, 10), connectedAt: daysFromNow(-30),
    });
    saIds.push(Number((r as any)[0]?.insertId ?? 0));
  }

  // Social posts (mix of statuses across two weeks)
  const POSTS = [
    "How modern revenue ops teams are consolidating their tool stack — 3 patterns we see weekly.",
    "Quick reminder: pipeline hygiene > pipeline volume. A clean $400k beats a messy $1.2M.",
    "We just shipped multi-workspace support. Real one.",
    "If your CRM doesn't tell you what to do next, it's a database with extra steps.",
    "Three customer success metrics that actually predict renewal — and which ones are vanity.",
    "Unpopular take: the best growth lever for most teams isn't a new tool, it's a deleted process.",
  ];
  for (let i = 0; i < 14; i++) {
    const status = rand(["draft", "in_review", "approved", "scheduled", "scheduled", "published", "published"] as const);
    const scheduled = daysFromNow(status === "published" ? -randInt(1, 14) : randInt(0, 14));
    await db.insert(socialPosts).values({
      workspaceId,
      socialAccountId: rand(saIds),
      platform: rand(["linkedin", "twitter", "facebook", "instagram"] as const),
      body: rand(POSTS),
      status,
      scheduledFor: scheduled,
      publishedAt: status === "published" ? scheduled : null,
      impressions: status === "published" ? randInt(800, 18000) : 0,
      engagements: status === "published" ? randInt(20, 600) : 0,
      clicks: status === "published" ? randInt(5, 200) : 0,
      authorUserId: ownerUserId,
    });
  }

  // Campaigns (3)
  for (const camp of [
    { name: "Q2 Renewal Push", objective: "renewal", status: "live" as const, description: "Coordinated campaign to lift Q2 renewals across the watch tier." },
    { name: "Mid-market expansion", objective: "expansion", status: "scheduled" as const, description: "Cross-sell analytics module to top 50 mid-market accounts." },
    { name: "Spring brand refresh", objective: "awareness", status: "planning" as const, description: "Multi-channel awareness push around new brand identity." },
  ]) {
    await db.insert(campaigns).values({
      workspaceId,
      name: camp.name,
      objective: camp.objective,
      status: camp.status,
      startsAt: daysFromNow(camp.status === "live" ? -10 : 14),
      endsAt: daysFromNow(camp.status === "live" ? 30 : 45),
      budget: String(randInt(15, 80) * 1000),
      targetSegment: "Watch-tier customers, midmarket",
      description: camp.description,
      checklist: [
        { id: 1, label: "Owner assigned", done: true },
        { id: 2, label: "Budget approved", done: camp.status !== "planning" },
        { id: 3, label: "Creative reviewed", done: camp.status === "live" },
        { id: 4, label: "Tracking links generated", done: camp.status === "live" },
        { id: 5, label: "Sequences enrolled", done: camp.status === "live" },
      ],
      ownerUserId,
    });
  }

  // Products
  for (const prod of [
    { sku: "USIP-CORE-A", name: "USIP Core (Annual)", listPrice: "12000", billingCycle: "annual" as const, category: "Platform" },
    { sku: "USIP-CORE-M", name: "USIP Core (Monthly)", listPrice: "1200", billingCycle: "monthly" as const, category: "Platform" },
    { sku: "USIP-INTEL", name: "Revenue Intelligence add-on", listPrice: "6000", billingCycle: "annual" as const, category: "Add-on" },
    { sku: "USIP-SOCIAL", name: "Social Publishing module", listPrice: "4800", billingCycle: "annual" as const, category: "Add-on" },
    { sku: "USIP-CS", name: "Customer Success module", listPrice: "5400", billingCycle: "annual" as const, category: "Add-on" },
    { sku: "USIP-IMPL-PRO", name: "Implementation — Professional", listPrice: "8500", billingCycle: "one_time" as const, category: "Services" },
    { sku: "USIP-IMPL-ENT", name: "Implementation — Enterprise", listPrice: "22500", billingCycle: "one_time" as const, category: "Services" },
  ]) {
    try {
      await db.insert(products).values({ workspaceId, ...prod, active: true });
    } catch { /* uq dup */ }
  }

  // Default dashboard
  const dashRow = await db.insert(dashboards).values({
    workspaceId,
    name: "Revenue overview",
    description: "Default starter dashboard — pipeline, won, top accounts.",
    isShared: true,
    layout: [],
    ownerUserId,
  });
  const dashId = Number((dashRow as any)[0]?.insertId ?? 0);
  for (const w of [
    { type: "kpi" as const, title: "Pipeline value", config: { metric: "pipeline_value" }, position: { x: 0, y: 0, w: 3, h: 2 } },
    { type: "kpi" as const, title: "Closed won (qtr)", config: { metric: "closed_won_qtr" }, position: { x: 3, y: 0, w: 3, h: 2 } },
    { type: "kpi" as const, title: "Win rate", config: { metric: "win_rate" }, position: { x: 6, y: 0, w: 3, h: 2 } },
    { type: "kpi" as const, title: "Avg deal size", config: { metric: "avg_deal" }, position: { x: 9, y: 0, w: 3, h: 2 } },
    { type: "funnel" as const, title: "Pipeline funnel", config: { dim: "stage" }, position: { x: 0, y: 2, w: 6, h: 4 } },
    { type: "bar" as const, title: "Won by month", config: { metric: "closed_won", dim: "month" }, position: { x: 6, y: 2, w: 6, h: 4 } },
    { type: "table" as const, title: "Top accounts", config: { entity: "accounts", limit: 5 }, position: { x: 0, y: 6, w: 12, h: 4 } },
  ]) {
    await db.insert(dashboardWidgets).values({ workspaceId, dashboardId: dashId, ...w });
  }
}

export async function ensureUserHasWorkspace(userId: number, userName: string | null) {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1);
  if (existing.length > 0) return;

  const slug = `ws-${userId}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await db.insert(workspaces).values({
    name: "LSI Media",
    slug,
    ownerUserId: userId,
    plan: "trial",
  });
  const wsId = Number((r as any)[0]?.insertId ?? 0);
  await db.insert(workspaceMembers).values({
    workspaceId: wsId,
    userId,
    role: "super_admin",
    title: "Founder",
  });
  await seedWorkspace(wsId, userId);
}
