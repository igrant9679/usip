/**
 * ARE demo seeder.
 *
 * The Autonomous Revenue Engine has no background populate loop — a fresh
 * campaign leaves every ARECampaignDetail tab empty (prospects, scraper,
 * A/B, signals, rejections) and all Overview counters at 0. server/seed.ts
 * seeds regular CRM data but nothing ARE. This creates ONE realistic demo
 * campaign per workspace with data in every tab so the hub demos fully.
 *
 * Idempotent: guarded on a campaign named DEMO_NAME existing for the
 * workspace (mirrors the seedTours pattern). Per-workspace try/catch so a
 * failure can never block server startup. Wired in _core/index.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  workspaces,
  areCampaigns,
  prospectQueue,
  prospectIntelligence,
  areAbVariants,
  areSignalLog,
  areScrapeJobs,
} from "../drizzle/schema";

const DEMO_NAME = "[Demo] Autonomous Outbound — SaaS RevOps VPs";

type SeedProspect = {
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  companyDomain: string;
  industry: string;
  geography: string;
  companySize: string;
  icpMatchScore: number;
  sourceType:
    | "linkedin_people"
    | "google_business"
    | "web_scrape"
    | "apollo"
    | "ai_research"
    | "news_event";
  enrichmentStatus: "pending" | "enriching" | "complete" | "failed";
  sequenceStatus:
    | "pending"
    | "approved"
    | "enrolled"
    | "skipped"
    | "completed"
    | "replied";
  rejectionReason?: string;
};

const PROSPECTS: SeedProspect[] = [
  // Enrolled / in-flight (enriched + sequence running)
  { firstName: "Dana", lastName: "Whitfield", title: "VP Revenue Operations", companyName: "Northwind Analytics", companyDomain: "northwind.io", industry: "SaaS", geography: "Austin, TX", companySize: "201-500", icpMatchScore: 92, sourceType: "linkedin_people", enrichmentStatus: "complete", sequenceStatus: "enrolled" },
  { firstName: "Marcus", lastName: "Cole", title: "Head of RevOps", companyName: "Pinecrest Labs", companyDomain: "pinecrest.dev", industry: "SaaS", geography: "Denver, CO", companySize: "51-200", icpMatchScore: 88, sourceType: "linkedin_people", enrichmentStatus: "complete", sequenceStatus: "enrolled" },
  { firstName: "Priya", lastName: "Nair", title: "Director, Sales Operations", companyName: "Atlas Fintech", companyDomain: "atlasfintech.com", industry: "Fintech", geography: "New York, NY", companySize: "501-1000", icpMatchScore: 90, sourceType: "apollo", enrichmentStatus: "complete", sequenceStatus: "enrolled" },
  { firstName: "Tom", lastName: "Becker", title: "VP Sales", companyName: "Cloudgrove", companyDomain: "cloudgrove.ai", industry: "SaaS", geography: "Seattle, WA", companySize: "201-500", icpMatchScore: 84, sourceType: "google_business", enrichmentStatus: "complete", sequenceStatus: "enrolled" },
  // Replied (the win states the Signals tab references)
  { firstName: "Elena", lastName: "Vasquez", title: "Chief Revenue Officer", companyName: "Brightline SaaS", companyDomain: "brightline.co", industry: "SaaS", geography: "Boston, MA", companySize: "201-500", icpMatchScore: 95, sourceType: "linkedin_people", enrichmentStatus: "complete", sequenceStatus: "replied" },
  { firstName: "Sanjay", lastName: "Iyer", title: "VP RevOps & Strategy", companyName: "Quill Data", companyDomain: "quilldata.com", industry: "Data/Analytics", geography: "Chicago, IL", companySize: "51-200", icpMatchScore: 89, sourceType: "ai_research", enrichmentStatus: "complete", sequenceStatus: "replied" },
  // Awaiting enrichment / queued
  { firstName: "Hannah", lastName: "Liu", title: "Sales Operations Manager", companyName: "Vertex Loop", companyDomain: "vertexloop.com", industry: "SaaS", geography: "Remote", companySize: "11-50", icpMatchScore: 71, sourceType: "web_scrape", enrichmentStatus: "pending", sequenceStatus: "pending" },
  { firstName: "Greg", lastName: "Mason", title: "RevOps Lead", companyName: "Harbor Stack", companyDomain: "harborstack.io", industry: "SaaS", geography: "Portland, OR", companySize: "51-200", icpMatchScore: 76, sourceType: "google_business", enrichmentStatus: "pending", sequenceStatus: "pending" },
  { firstName: "Aisha", lastName: "Rahman", title: "Director of Revenue Ops", companyName: "Lumen Forge", companyDomain: "lumenforge.com", industry: "Fintech", geography: "Miami, FL", companySize: "201-500", icpMatchScore: 81, sourceType: "apollo", enrichmentStatus: "enriching", sequenceStatus: "pending" },
  // Rejected (sequenceStatus = "skipped" — drives the Rejections tab)
  { firstName: "Brad", lastName: "Tucker", title: "Office Manager", companyName: "Tucker Plumbing Co", companyDomain: "tuckerplumbing.com", industry: "Home Services", geography: "Phoenix, AZ", companySize: "1-10", icpMatchScore: 18, sourceType: "google_business", enrichmentStatus: "complete", sequenceStatus: "skipped", rejectionReason: "Out of ICP — non-software SMB, no RevOps function" },
  { firstName: "Lia", lastName: "Fontaine", title: "Student", companyName: "State University", companyDomain: "stateu.edu", industry: "Education", geography: "Columbus, OH", companySize: "1000+", icpMatchScore: 9, sourceType: "web_scrape", enrichmentStatus: "complete", sequenceStatus: "skipped", rejectionReason: "Not a buyer — individual/student, not a target persona" },
  { firstName: "Owen", lastName: "Pruitt", title: "VP Sales", companyName: "Competitor Corp", companyDomain: "competitorcorp.com", industry: "SaaS", geography: "San Jose, CA", companySize: "501-1000", icpMatchScore: 64, sourceType: "linkedin_people", enrichmentStatus: "complete", sequenceStatus: "skipped", rejectionReason: "Suppressed — known competitor domain" },
];

// Per-(complete) prospect intelligence dossier payloads, keyed by email idx.
const INTEL_HOOKS = [
  [{ hook: "Posted last week about consolidating their RevOps tool stack" }, { hook: "Hiring 3 SDRs — scaling outbound now" }],
  [{ hook: "Series B closed in Q1 — budget unlocked for revenue tooling" }, { hook: "Shared a podcast on pipeline visibility pain" }],
  [{ hook: "Migrating off a legacy CRM (mentioned in a webinar)" }, { hook: "New CRO started 60 days ago — re-evaluating stack" }],
  [{ hook: "Job posting for 'RevOps Analyst' lists the exact gap we solve" }],
  [{ hook: "Replied positively to a cold touch — asked for a one-pager" }, { hook: "Champion-shaped: owns the number AND the tooling" }],
  [{ hook: "Quoted in a trade article about forecast accuracy problems" }],
];
const INTEL_PAINS = [
  [{ signal: "Manual pipeline hygiene", evidence: "LinkedIn post complaining about stale opps", strength: 4 }, { signal: "No single source of truth", evidence: "Uses 3 disconnected tools", strength: 3 }],
  [{ signal: "Forecast accuracy", evidence: "Webinar Q&A", strength: 5 }],
  [{ signal: "Legacy CRM friction", evidence: "Migration thread", strength: 4 }],
  [{ signal: "Under-staffed RevOps", evidence: "Open req", strength: 3 }],
  [{ signal: "Outbound not converting", evidence: "Cold reply context", strength: 4 }],
  [{ signal: "Bad data → bad forecast", evidence: "Trade article quote", strength: 4 }],
];

export async function seedAreDemoForAllWorkspaces(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);

  for (const ws of allWorkspaces) {
    try {
      // Idempotency guard — skip if the demo campaign already exists.
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areCampaigns)
        .where(
          and(
            eq(areCampaigns.workspaceId, ws.id),
            eq(areCampaigns.name, DEMO_NAME),
          ),
        );
      if (Number(n) > 0) continue;

      // ── Campaign (Overview counters + Settings tab) ──
      const [camp] = await db
        .insert(areCampaigns)
        .values({
          workspaceId: ws.id,
          name: DEMO_NAME,
          description:
            "Seeded demo: discovers SaaS RevOps VPs, enriches with trigger/pain signals, runs a 7-step A/B sequence, and books meetings autonomously.",
          status: "active",
          autonomyMode: "batch_approval",
          goalType: "meeting_booked",
          targetProspectCount: 100,
          dailySendCap: 50,
          autoApproveThreshold: 85,
          signalToOpportunityEnabled: true,
          prospectsDiscovered: 48,
          prospectsEnriched: 36,
          prospectsApproved: 22,
          prospectsEnrolled: 18,
          prospectsContacted: 16,
          prospectsReplied: 5,
          meetingsBooked: 2,
          opportunitiesCreated: 1,
          startedAt: new Date(Date.now() - 9 * 86_400_000),
        } as never)
        .$returningId();
      const campaignId = (camp as { id: number }).id;

      // ── Prospects tab ──
      await db.insert(prospectQueue).values(
        PROSPECTS.map((p, i) => ({
          workspaceId: ws.id,
          campaignId,
          sourceType: p.sourceType,
          sourceId: `demo-${i}`,
          firstName: p.firstName,
          lastName: p.lastName,
          email: `${p.firstName.toLowerCase()}.${p.lastName.toLowerCase()}@${p.companyDomain}`,
          linkedinUrl: `https://linkedin.com/in/${p.firstName.toLowerCase()}-${p.lastName.toLowerCase()}`,
          title: p.title,
          companyName: p.companyName,
          companyDomain: p.companyDomain,
          companySize: p.companySize,
          industry: p.industry,
          geography: p.geography,
          icpMatchScore: p.icpMatchScore,
          icpMatchBreakdown: {
            industry: p.icpMatchScore >= 70 ? 25 : 4,
            title: p.icpMatchScore >= 70 ? 25 : 3,
            companySize: p.icpMatchScore >= 70 ? 22 : 6,
            geography: p.icpMatchScore >= 70 ? 20 : 5,
          },
          enrichmentStatus: p.enrichmentStatus,
          sequenceStatus: p.sequenceStatus,
          enrichedAt: p.enrichmentStatus === "complete" ? new Date(Date.now() - 6 * 86_400_000) : null,
          rejectionReason: p.rejectionReason ?? null,
          rejectedAt: p.sequenceStatus === "skipped" ? new Date(Date.now() - 4 * 86_400_000) : null,
        })) as never,
      );

      // Re-read to get generated ids (FK targets for intel + signals).
      const seeded = await db
        .select({
          id: prospectQueue.id,
          enrichmentStatus: prospectQueue.enrichmentStatus,
          sequenceStatus: prospectQueue.sequenceStatus,
        })
        .from(prospectQueue)
        .where(
          and(
            eq(prospectQueue.workspaceId, ws.id),
            eq(prospectQueue.campaignId, campaignId),
          ),
        )
        .orderBy(prospectQueue.id);

      // ── Prospect intelligence (dossier sheet) for the complete ones ──
      const completeIds = seeded.filter((s) => s.enrichmentStatus === "complete").map((s) => s.id);
      if (completeIds.length > 0) {
        await db.insert(prospectIntelligence).values(
          completeIds.slice(0, 6).map((pid, i) => ({
            prospectQueueId: pid,
            workspaceId: ws.id,
            recommendedChannel: "email" as const,
            enrichmentConfidence: 70 + (i % 5) * 5,
            personalisationHooks: INTEL_HOOKS[i % INTEL_HOOKS.length],
            painSignals: INTEL_PAINS[i % INTEL_PAINS.length],
            triggerEvents: [{ event: "Hiring surge in RevOps", date: "recent", source: "job board" }],
            techStack: ["Salesforce", "Outreach", "Looker"],
            recentNews: [{ title: "Closed a new funding round", url: "https://example.com/news" }],
            companyOneLiner: "Mid-market SaaS scaling its revenue engine.",
            recommendedTiming: "Tue–Thu, 9–11am local",
            sequenceQualityScore: 78 + (i % 4) * 4,
            generatedSequence: [
              { step: 1, channel: "email", subject: "Quick idea on pipeline visibility", waitDays: 0 },
              { step: 2, channel: "email", subject: "Re: pipeline visibility", waitDays: 3 },
              { step: 3, channel: "linkedin", subject: "Connection + context", waitDays: 2 },
            ],
          })) as never,
        );
      }

      // ── A/B Variants tab (2 steps × A/B, nonzero so reply-rate shows) ──
      await db.insert(areAbVariants).values([
        { workspaceId: ws.id, campaignId, stepIndex: 0, variantKey: "A", hookType: "personalisation", subjectLine: "Quick idea for {{company}}'s RevOps", bodyPreview: "Noticed you're consolidating your stack — most teams we work with…", sentCount: 120, openCount: 71, replyCount: 9, meetingCount: 2, isWinner: true, promotedAt: new Date(Date.now() - 2 * 86_400_000) },
        { workspaceId: ws.id, campaignId, stepIndex: 0, variantKey: "B", hookType: "trigger_event", subjectLine: "Congrats on the raise — one thought", bodyPreview: "Saw the funding news. Teams at your stage usually hit pipeline visibility…", sentCount: 118, openCount: 63, replyCount: 5, meetingCount: 1, isWinner: false },
        { workspaceId: ws.id, campaignId, stepIndex: 1, variantKey: "A", hookType: "relationship_path", subjectLine: "Re: {{company}} RevOps", bodyPreview: "Following up — we both know a few folks at…", sentCount: 96, openCount: 44, replyCount: 6, meetingCount: 1, isWinner: true, promotedAt: new Date(Date.now() - 1 * 86_400_000) },
        { workspaceId: ws.id, campaignId, stepIndex: 1, variantKey: "B", hookType: "personalisation", subjectLine: "Worth 15 minutes?", bodyPreview: "Circling back with a specific number we can move…", sentCount: 95, openCount: 38, replyCount: 3, meetingCount: 0, isWinner: false },
      ] as never);

      // ── Signals tab ──
      const sigTargets = seeded.slice(0, 8);
      const signalDefs: Array<{
        signalType: string;
        sentiment: "positive" | "neutral" | "negative" | "objection";
        sentimentReason: string;
        actionTaken: string;
        ageDays: number;
      }> = [
        { signalType: "email_open", sentiment: "neutral", sentimentReason: "Opened the first touch twice", actionTaken: "Logged engagement", ageDays: 7 },
        { signalType: "email_click", sentiment: "positive", sentimentReason: "Clicked the case-study link", actionTaken: "Advanced to step 2", ageDays: 6 },
        { signalType: "email_reply", sentiment: "positive", sentimentReason: "Asked for a one-pager and pricing", actionTaken: "Paused sequence, alerted owner", ageDays: 5 },
        { signalType: "linkedin_accepted", sentiment: "positive", sentimentReason: "Accepted the connection request", actionTaken: "Queued LinkedIn follow-up", ageDays: 4 },
        { signalType: "meeting_booked", sentiment: "positive", sentimentReason: "Booked a 30-min intro via the calendar link", actionTaken: "Created task + notified owner", ageDays: 3 },
        { signalType: "email_bounce", sentiment: "negative", sentimentReason: "Hard bounce — mailbox does not exist", actionTaken: "Suppressed + flagged for re-find", ageDays: 6 },
        { signalType: "email_reply", sentiment: "objection", sentimentReason: "“Not the right time, revisit next quarter”", actionTaken: "Snoozed 90 days", ageDays: 2 },
        { signalType: "opportunity_created", sentiment: "positive", sentimentReason: "Reply → qualified → opportunity", actionTaken: "Opportunity created in pipeline", ageDays: 1 },
      ];
      if (sigTargets.length > 0) {
        await db.insert(areSignalLog).values(
          signalDefs.map((s, i) => ({
            workspaceId: ws.id,
            campaignId,
            prospectQueueId: sigTargets[i % sigTargets.length].id,
            signalType: s.signalType,
            sentiment: s.sentiment,
            sentimentReason: s.sentimentReason,
            actionTaken: s.actionTaken,
            rawPayload: { demo: true },
            processedAt: new Date(Date.now() - s.ageDays * 86_400_000),
          })) as never,
        );
      }

      // ── Scraper tab (recent jobs panel) ──
      await db.insert(areScrapeJobs).values([
        { workspaceId: ws.id, campaignId, sourceType: "linkedin_people", query: "VP Revenue Operations SaaS United States", status: "complete", resultCount: 27, scrapedAt: new Date(Date.now() - 8 * 86_400_000) },
        { workspaceId: ws.id, campaignId, sourceType: "google_business", query: "B2B SaaS companies 50-500 employees", status: "complete", resultCount: 14, scrapedAt: new Date(Date.now() - 6 * 86_400_000) },
        { workspaceId: ws.id, campaignId, sourceType: "news", query: "Series B SaaS funding 2026 revenue operations", status: "complete", resultCount: 7, scrapedAt: new Date(Date.now() - 3 * 86_400_000) },
      ] as never);

      console.log(`[SeedAreDemo] seeded demo ARE campaign for workspace ${ws.id}`);
    } catch (e) {
      console.error(`[SeedAreDemo] workspace ${ws.id} failed:`, e);
    }
  }
}
