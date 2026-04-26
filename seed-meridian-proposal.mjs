/**
 * Seed script: Meridian Health 2026 Digital Marketing Strategy proposal
 * Run: node seed-meridian-proposal.mjs
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

try {
  // ── 1. Insert the proposal ────────────────────────────────────────────────
  const [propResult] = await conn.execute(
    `INSERT INTO proposals
      (workspaceId, createdBy, title, clientName, clientEmail, clientWebsite,
       orgAbbr, contactId, accountId, projectType, budget, status,
       description, shareToken, sentAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
    [
      1,                                          // workspaceId
      1,                                          // createdBy (Idris Grant)
      "Meridian Health 2026 Digital Marketing Strategy",
      "Meridian Health",
      "rafael.radcliffe@example.com",
      "https://meridianhealth.com",
      "MH",
      4,                                          // contactId (Rafael Radcliffe)
      2,                                          // accountId (Meridian Health)
      "Integrated Campaign",
      "85000.00",
      "sent",
      "A comprehensive integrated digital marketing strategy for Meridian Health's 2026 fiscal year, covering patient acquisition, brand awareness, and community engagement across digital channels.",
      "mh-2026-dms-" + Math.random().toString(36).slice(2, 10),
    ],
  );

  const proposalId = propResult.insertId;
  console.log(`✅ Proposal inserted with id=${proposalId}`);

  // ── 2. Insert proposal sections ───────────────────────────────────────────
  const sections = [
    {
      sectionKey: "executive_summary",
      content: `## Executive Summary

Meridian Health is at a pivotal moment in its growth trajectory. With three new clinic locations opening in Q2 2026 and an expanding telehealth division, the organization needs a cohesive digital marketing strategy that drives patient acquisition, reinforces brand trust, and establishes Meridian as the region's leading integrated health system.

LSI Media proposes a 12-month Integrated Campaign valued at **$85,000** that combines paid media, SEO, content marketing, social media management, and community engagement to deliver measurable outcomes across all patient touchpoints.

**Key Outcomes Targeted:**
- 35% increase in new patient appointments via digital channels
- 50% growth in organic search visibility for priority service lines
- 25% improvement in patient satisfaction scores related to digital communications
- 2.5× return on ad spend across paid media channels`,
    },
    {
      sectionKey: "problem_statement",
      content: `## Problem Statement

Meridian Health currently faces three interconnected challenges in its digital presence:

**1. Fragmented Digital Identity**
With multiple clinic locations and service lines operating semi-independently, Meridian's digital presence lacks cohesion. Patients searching for specific services encounter inconsistent messaging, outdated landing pages, and a disjointed brand experience across channels.

**2. Underperforming Patient Acquisition Funnel**
Current paid media campaigns are generating clicks but not converting at acceptable rates. The average cost-per-acquisition (CPA) for new patient appointments is 40% above industry benchmarks, driven by poor landing page alignment and untargeted audience segmentation.

**3. Limited Organic Visibility**
Meridian ranks outside the top 10 for 78% of its priority service-line keywords. Competitors have invested heavily in content and technical SEO, creating a gap that requires a structured, sustained effort to close.`,
    },
    {
      sectionKey: "proposed_solution",
      content: `## Proposed Solution

LSI Media will deliver a fully integrated campaign structured across four strategic pillars:

### Pillar 1 — Brand Foundation & Digital Infrastructure
We will audit and rebuild Meridian's digital infrastructure, including a full technical SEO overhaul, landing page redesign for the top 8 service lines, and a unified brand voice guide. This ensures all downstream marketing efforts operate from a solid foundation.

### Pillar 2 — Paid Media & Patient Acquisition
A precision-targeted paid media program across Google Search, Google Display, Meta, and YouTube will be deployed. Campaigns will be segmented by service line, geography, and patient persona, with continuous A/B testing and weekly optimization cycles.

### Pillar 3 — Content & SEO Authority
A 52-week editorial calendar will produce 4 long-form articles per month targeting high-intent, low-competition keywords. Content will be amplified through email newsletters, social distribution, and strategic PR placements in regional health publications.

### Pillar 4 — Community & Social Engagement
LSI Media will manage Meridian's social media presence across Facebook, Instagram, and LinkedIn, publishing 5 posts per week per platform. Monthly community campaigns (health awareness days, patient success stories, physician spotlights) will build authentic engagement and referral traffic.`,
    },
    {
      sectionKey: "scope_of_work",
      content: `## Scope of Work

| Deliverable | Frequency | Channel |
|---|---|---|
| Paid Media Management | Ongoing | Google, Meta, YouTube |
| Technical SEO Audit & Remediation | One-time (Month 1) | Website |
| Landing Page Redesign (8 pages) | One-time (Months 1–2) | Website |
| Long-form Content Articles | 4/month | Blog + SEO |
| Social Media Management | 5 posts/week/platform | Facebook, Instagram, LinkedIn |
| Email Newsletter | 2/month | Email (CRM) |
| Monthly Performance Report | Monthly | All Channels |
| Quarterly Strategy Review | Quarterly | All Channels |
| Brand Voice Guide | One-time (Month 1) | All Channels |
| PR Placement Outreach | 2 placements/quarter | Regional Health Media |

**Out of Scope:** Website development beyond landing page redesigns, video production (beyond repurposing existing assets), in-person event coordination, and print advertising.`,
    },
    {
      sectionKey: "pricing",
      content: `## Investment Summary

| Service | Monthly | Annual |
|---|---|---|
| Paid Media Management (15% of ad spend) | $2,500 | $30,000 |
| SEO & Content Program | $2,000 | $24,000 |
| Social Media Management | $1,500 | $18,000 |
| Email Marketing | $500 | $6,000 |
| Strategy & Reporting | $583 | $7,000 |
| **Total Retainer** | **$7,083** | **$85,000** |

**One-Time Setup Fees (included in Year 1 total):**
- Technical SEO Audit & Remediation: $4,000
- Landing Page Redesign (8 pages): $8,000
- Brand Voice Guide: $2,000

**Ad Spend Budget (client-managed, not included):** Recommended $15,000–$20,000/month

*Payment terms: Net 30, invoiced monthly. A 50% deposit is required to begin work.*`,
    },
    {
      sectionKey: "why_us",
      content: `## Why LSI Media

**Proven Healthcare Marketing Expertise**
LSI Media has delivered digital marketing programs for 14 healthcare organizations in the past three years, including regional hospital systems, specialty practices, and telehealth providers. Our healthcare team understands HIPAA-compliant marketing, patient journey mapping, and the nuanced trust dynamics of health-related content.

**Data-Driven, Transparent Reporting**
Every campaign is tracked against agreed KPIs. Clients receive real-time dashboard access, weekly performance snapshots, and monthly executive reports with clear attribution modeling.

**Integrated Team, Single Point of Contact**
You will have a dedicated account lead (Senior Strategist), a paid media specialist, an SEO/content manager, and a social media manager — all coordinated through a single point of contact to eliminate communication overhead.

**References Available**
We are happy to connect you with current clients in the healthcare sector who can speak to our work quality, responsiveness, and results.`,
    },
  ];

  for (const s of sections) {
    await conn.execute(
      `INSERT INTO proposal_sections (proposalId, sectionKey, content, updatedAt)
       VALUES (?, ?, ?, NOW())`,
      [proposalId, s.sectionKey, s.content],
    );
    console.log(`  ✅ Section '${s.sectionKey}' inserted`);
  }

  // ── 3. Insert milestones ──────────────────────────────────────────────────
  const milestones = [
    {
      name: "Kickoff & Discovery",
      milestoneDate: "2026-05-05 09:00:00",
      description: "Stakeholder alignment session, brand audit, access provisioning, and campaign brief finalization.",
      owner: "both",
      sortOrder: 1,
    },
    {
      name: "Foundation Deliverables Complete",
      milestoneDate: "2026-05-30 09:00:00",
      description: "Technical SEO audit report delivered, brand voice guide approved, landing page wireframes signed off.",
      owner: "lsi_media",
      sortOrder: 2,
    },
    {
      name: "Paid Media & Landing Pages Live",
      milestoneDate: "2026-06-20 09:00:00",
      description: "All 8 redesigned landing pages published, paid media campaigns activated across Google and Meta.",
      owner: "lsi_media",
      sortOrder: 3,
    },
    {
      name: "Q2 Performance Review",
      milestoneDate: "2026-07-15 09:00:00",
      description: "90-day performance review: paid media CPA analysis, organic ranking progress, social engagement benchmarks, and strategy adjustments.",
      owner: "both",
      sortOrder: 4,
    },
    {
      name: "Mid-Year Optimization Sprint",
      milestoneDate: "2026-09-01 09:00:00",
      description: "Campaign restructure based on H1 learnings: audience refinement, content calendar refresh, and Q4 planning.",
      owner: "lsi_media",
      sortOrder: 5,
    },
    {
      name: "Annual Review & 2027 Planning",
      milestoneDate: "2026-12-10 09:00:00",
      description: "Full-year performance report, ROI analysis, and proposal for 2027 engagement scope.",
      owner: "both",
      sortOrder: 6,
    },
  ];

  for (const m of milestones) {
    await conn.execute(
      `INSERT INTO proposal_milestones
        (proposalId, name, milestoneDate, description, owner, sortOrder)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [proposalId, m.name, m.milestoneDate, m.description, m.owner, m.sortOrder],
    );
    console.log(`  ✅ Milestone '${m.name}' inserted`);
  }

  // ── 4. Insert feedback ────────────────────────────────────────────────────
  const feedbackEntries = [
    {
      authorName: "Rafael Radcliffe",
      authorEmail: "rafael.radcliffe@example.com",
      message: "The executive summary and proposed solution sections are very well structured. We appreciate the four-pillar approach — it maps closely to our internal priorities. One question: can the paid media budget recommendation be adjusted to start at $10K/month in Q1 while we validate the channel mix, then scale to $20K in Q2? Also, we'd like to see a breakdown of how the content articles will be distributed across service lines.",
    },
    {
      authorName: "Dr. Priya Nair",
      authorEmail: "p.nair@meridianhealth.com",
      message: "From a clinical leadership perspective, I want to ensure the content strategy emphasizes patient education and evidence-based messaging rather than purely promotional content. The 'Why LSI Media' section is reassuring — the HIPAA compliance mention is important to our legal team. Overall this looks promising. Please include a sample content brief in the next version.",
    },
  ];

  for (const fb of feedbackEntries) {
    await conn.execute(
      `INSERT INTO proposal_feedback (proposalId, authorName, authorEmail, message, createdAt)
       VALUES (?, ?, ?, ?, NOW())`,
      [proposalId, fb.authorName, fb.authorEmail, fb.message],
    );
    console.log(`  ✅ Feedback from '${fb.authorName}' inserted`);
  }

  console.log(`\n🎉 Meridian Health proposal seeded successfully! Proposal ID: ${proposalId}`);
} finally {
  await conn.end();
}
