/**
 * Demo seed EXTRAS — everything the base seeder (seed.ts) and the ARE demo
 * seeder (seedAreDemo.ts) leave empty, so a demo workspace has realistic
 * data on EVERY page (owner ask 2026-09-07: a "John Queue" demo account,
 * "fully seed each section/page").
 *
 * Builds ON the base seed: it reads the accounts, contacts, leads and
 * opportunities that seed.ts wrote and hangs the rest off them, so People,
 * Meetings, Conversations, Emails, Calls, inbound capture, Segments,
 * Personas, ICP, Brand Voice, Lists, Reports, the Inbox, Proposals, Quotes,
 * Fit scores and the demo campaign's sent steps all tell one consistent
 * story about one company.
 *
 * Idempotent: guarded by an audit row (entityType "demo_extras"). Never
 * sends anything: the demo mailbox is DISABLED and the demo campaign is
 * left PAUSED, so the dispatcher cannot pick up the scheduled steps.
 */
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, activities, areCampaigns, areExecutionQueue, audienceSegments, auditLog, bookingLinks,
  brandVoiceProfiles, chatAgentKnowledge, chatAgents, chatSessions, contacts, emailLog, emailReplies,
  formSubmissions, forms, icpProfiles, landingPageSubmissions, landingPages, leads, meetings,
  notifications, opportunities, personaCategories, personas, proposalMilestones, proposalSections,
  proposals, prospectIntelligence, prospectQueue, prospects, quoteLineItems, quotes, recordListMembers,
  recordLists, savedReports, scoreModels, scoreResults, sendingAccounts, voiceAgents, voiceCalls,
  websiteVisits,
} from "../drizzle/schema";
import { DEFAULT_VARIANT_KEY } from "@shared/variantKeys";
import { appUrl } from "./appUrl";
import { getDb } from "./db";

const DEMO_CAMPAIGN_NAME = "[Demo] Autonomous Outbound — SaaS RevOps VPs";

function rand<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function daysAgo(d: number, hour = 10) { const t = new Date(); t.setUTCDate(t.getUTCDate() - d); t.setUTCHours(hour, randInt(0, 59), 0, 0); return t; }
function daysFromNow(d: number, hour = 14) { return daysAgo(-d, hour); }
function token(len = 32) { return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len); }
function insertId(r: unknown): number { return Number((r as any)?.[0]?.insertId ?? 0); }

const FIRST = ["Harper", "Miles", "Sienna", "Jonah", "Elise", "Caleb", "Nora", "Desmond", "Ivy", "Rowan", "Celia", "Marcus", "Talia", "Grant", "Lucia", "Andre", "Bianca", "Felix", "Renee", "Oscar", "Dahlia", "Simon", "Maren", "Julian", "Wren", "Tobias", "Alina", "Ezra", "Paloma", "Reid", "Imani", "Silas", "Leah", "Hugo", "Margot", "Elliot", "Zoe", "Nolan", "Adele", "Bruno"];
const LAST = ["Whitaker", "Okafor", "Lindqvist", "Marchetti", "Delacroix", "Hoffman", "Nakamura", "Petrov", "Alvarez", "Brennan", "Kowalski", "Sato", "Fitzgerald", "Haddad", "Moreau", "Osei", "Reinholt", "Castellano", "Duarte", "Kimura", "Vance", "Oyelaran", "Bergström", "Quintero", "Sullivan", "Ibrahim", "Larsen", "Mendes", "Thorne", "Abernathy"];
const TITLES = ["VP Revenue Operations", "Director of Sales", "Head of Marketing", "Chief Revenue Officer", "Sales Operations Manager", "VP Customer Success", "Director, Demand Generation", "Growth Lead", "Enterprise Account Executive", "Head of Partnerships", "Chief Operating Officer", "Director of Finance"];
const CITIES: Array<[string, string]> = [["Austin", "Texas"], ["Denver", "Colorado"], ["Boston", "Massachusetts"], ["Seattle", "Washington"], ["Chicago", "Illinois"], ["Atlanta", "Georgia"], ["Raleigh", "North Carolina"], ["Portland", "Oregon"], ["Minneapolis", "Minnesota"], ["Nashville", "Tennessee"]];

export async function isDemoExtrasSeeded(workspaceId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  const [r] = await db.select({ c: sql<number>`count(*)` }).from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.entityType, "demo_extras"), eq(auditLog.action, "create")));
  return Number(r?.c ?? 0) > 0;
}

export interface DemoExtrasResult { seeded: boolean; counts: Record<string, number>; note?: string }

export async function seedDemoExtras(workspaceId: number, ownerUserId: number, opts: { ownerName?: string; ownerEmail?: string } = {}): Promise<DemoExtrasResult> {
  const db = await getDb();
  const counts: Record<string, number> = {};
  if (!db) return { seeded: false, counts, note: "DB unavailable" };
  if (await isDemoExtrasSeeded(workspaceId)) return { seeded: false, counts, note: "already seeded" };

  const ownerName = opts.ownerName ?? "John Queue";
  const ownerEmail = opts.ownerEmail ?? "john.queue@queueandco.com";
  const ws = eq(accounts.workspaceId, workspaceId);

  // ── What the base seed left us ──────────────────────────────────────────
  const accts = await db.select().from(accounts).where(ws).orderBy(accounts.id);
  const conts = await db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId)).orderBy(contacts.id);
  const lds = await db.select().from(leads).where(eq(leads.workspaceId, workspaceId)).orderBy(leads.id);
  const opps = await db.select().from(opportunities).where(eq(opportunities.workspaceId, workspaceId)).orderBy(opportunities.id);
  if (accts.length === 0) return { seeded: false, counts, note: "base seed not present — create the workspace with sample data first" };
  const acctById = new Map(accts.map((a) => [a.id, a]));

  // ── Demo mailbox (DISABLED — nothing can send from it) ─────────────────
  const mailboxId = insertId(await db.insert(sendingAccounts).values({
    workspaceId, name: `${ownerName} (demo mailbox)`, provider: "generic_smtp", fromEmail: ownerEmail, fromName: ownerName,
    smtpHost: "smtp.example.com", smtpPort: 587, smtpUsername: ownerEmail, dailySendLimit: 50, connectionStatus: "untested", enabled: false, isDefault: true,
  } as never));
  counts.sendingAccounts = 1;

  // ── People (prospects): mirror every contact + 40 more at the same companies
  const prospectIds: number[] = [];
  const prospectRows: Array<{ id: number; firstName: string; lastName: string; email: string | null; company: string | null; title: string | null }> = [];
  const mkProspect = async (p: { firstName: string; lastName: string; title: string | null; email: string | null; acct: typeof accts[number]; linkedContactId?: number | null; verified?: boolean }) => {
    const [city, state] = rand(CITIES);
    const score = randInt(35, 96);
    const id = insertId(await db.insert(prospects).values({
      workspaceId, firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email,
      seniority: /chief|vp|head/i.test(p.title ?? "") ? "VP" : /director/i.test(p.title ?? "") ? "Director" : "Manager",
      functionalArea: /market|demand|growth/i.test(p.title ?? "") ? "Marketing" : /finance/i.test(p.title ?? "") ? "Finance" : /success/i.test(p.title ?? "") ? "Customer Success" : "Sales",
      linkedinUrl: `https://www.linkedin.com/in/${p.firstName.toLowerCase()}-${p.lastName.toLowerCase().replace(/[^a-z]/g, "")}-${randInt(100, 999)}`,
      phone: `+1-555-${randInt(200, 899)}-${randInt(1000, 9999)}`, city, state, country: "United States",
      company: p.acct.name, companyDomain: p.acct.domain, industry: p.acct.industry, accountId: p.acct.id,
      emailStatus: p.email ? rand(["valid", "valid", "valid", "accept_all", "unverified"]) : null,
      emailVerifiedAt: p.email ? daysAgo(randInt(2, 40)) : null,
      linkedContactId: p.linkedContactId ?? null,
      confidenceScore: score, confidenceTier: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
      verificationStatus: p.verified === false ? "needs_review" : "verified",
      companyMatchStatus: "linked", lastEnrichedAt: daysAgo(randInt(1, 30)),
    } as never));
    prospectIds.push(id);
    prospectRows.push({ id, firstName: p.firstName, lastName: p.lastName, email: p.email, company: p.acct.name, title: p.title });
    return id;
  };
  for (const c of conts) {
    const acct = c.accountId ? acctById.get(c.accountId) : undefined;
    if (!acct) continue;
    const pid = await mkProspect({ firstName: c.firstName, lastName: c.lastName, title: c.title, email: c.email, acct, linkedContactId: c.id });
    await db.update(contacts).set({ personProspectId: pid } as never).where(and(eq(contacts.id, c.id), eq(contacts.workspaceId, workspaceId)));
  }
  for (let i = 0; i < 40; i++) {
    const acct = rand(accts); const fn = rand(FIRST); const ln = rand(LAST);
    const hasEmail = i % 6 !== 5;
    await mkProspect({ firstName: fn, lastName: ln, title: rand(TITLES), email: hasEmail ? `${fn.toLowerCase()}.${ln.toLowerCase().replace(/[^a-z]/g, "")}@${acct.domain ?? "example.com"}` : null, acct, verified: i % 9 !== 8 });
  }
  counts.prospects = prospectIds.length;

  // ── Fit scoring: one primary person model + a result per prospect ──────
  const modelId = insertId(await db.insert(scoreModels).values({
    workspaceId, name: "Ideal buyer fit", description: "Title seniority, industry match, company size and engagement signals.",
    objectType: "person", modelType: "auto", isPrimary: true, status: "active", impactMode: "label", createdByUserId: ownerUserId,
  } as never));
  for (const p of prospectRows) {
    const raw = randInt(30, 97);
    await db.insert(scoreResults).values({
      workspaceId, scoreModelId: modelId, objectType: "person", objectId: p.id, rawScore: raw, maxPossibleScore: 100,
      normalizedScore: raw.toFixed(2), rating: raw >= 80 ? "excellent" : raw >= 60 ? "good" : raw >= 35 ? "fair" : "not_a_fit", isDisqualified: false,
    } as never);
  }
  counts.scoreResults = prospectRows.length;

  // ── Lists ───────────────────────────────────────────────────────────────
  const lists = [
    { name: "Q4 outreach — RevOps leaders", entityType: "people", description: "VP and Director RevOps at target accounts.", pick: prospectRows.filter((p) => /rev|sales op/i.test(p.title ?? "")).slice(0, 12).map((p) => ({ t: "prospect", id: p.id })) },
    { name: "Conference follow-ups (SaaStr)", entityType: "people", description: "People met at the booth; follow up within two weeks.", pick: prospectRows.slice(5, 15).map((p) => ({ t: "prospect", id: p.id })) },
    { name: "Expansion targets", entityType: "companies", description: "Accounts with a live deal and an ARR band above $50M.", pick: accts.slice(0, 8).map((a) => ({ t: "account", id: a.id })) },
  ];
  for (const l of lists) {
    const lid = insertId(await db.insert(recordLists).values({ workspaceId, name: l.name, entityType: l.entityType, description: l.description, createdByUserId: ownerUserId } as never));
    for (const m of l.pick) await db.insert(recordListMembers).values({ workspaceId, listId: lid, recordType: m.t, recordId: m.id, addedByUserId: ownerUserId } as never);
  }
  counts.recordLists = lists.length;

  // ── Segments, personas, ICP, brand voice ───────────────────────────────
  for (const s of [
    { name: "VP+ at SaaS accounts", description: "Senior revenue leaders in software companies.", rules: [{ field: "seniority", op: "in", value: ["C-Level", "VP"] }, { field: "industry", op: "eq", value: "SaaS" }], contactCount: 23 },
    { name: "Warm — opened in last 14 days", description: "Anyone who opened an email in the last two weeks.", rules: [{ field: "lastOpenedAt", op: "within_days", value: 14 }], contactCount: 41 },
    { name: "Northeast midmarket", description: "Contacts at Northeast accounts in the $50M–$200M band.", rules: [{ field: "account.region", op: "eq", value: "Northeast" }, { field: "account.revenueBand", op: "eq", value: "$50M-200M" }], contactCount: 17 },
  ]) {
    await db.insert(audienceSegments).values({ workspaceId, name: s.name, description: s.description, matchType: "all", rules: s.rules, contactCount: s.contactCount, lastEvaluatedAt: daysAgo(1), createdByUserId: ownerUserId } as never);
  }
  counts.segments = 3;
  const catRev = insertId(await db.insert(personaCategories).values({ workspaceId, name: "Revenue leaders", sortOrder: 0 } as never));
  const catOps = insertId(await db.insert(personaCategories).values({ workspaceId, name: "Operators", sortOrder: 1 } as never));
  for (const p of [
    { name: "The RevOps Architect", categoryId: catRev, description: "Owns the tech stack and the forecast. Buys for data hygiene and pipeline visibility.", targetTitles: ["VP Revenue Operations", "Head of RevOps", "Director, Sales Operations"], targetIndustries: ["SaaS", "Fintech"], targetGeographies: ["United States", "Canada"], employeeMin: 100, employeeMax: 2000, keywords: ["forecast accuracy", "CRM hygiene", "attribution"] },
    { name: "The Growth CRO", categoryId: catRev, description: "Accountable for net new ARR. Buys for pipeline creation speed.", targetTitles: ["Chief Revenue Officer", "VP Sales"], targetIndustries: ["SaaS", "Data/Analytics"], targetGeographies: ["United States"], employeeMin: 200, employeeMax: 5000, keywords: ["pipeline", "outbound", "quota attainment"] },
    { name: "The Demand Gen Lead", categoryId: catOps, description: "Runs campaigns and hand-offs. Buys for routing speed and follow-up automation.", targetTitles: ["Director, Demand Generation", "Head of Marketing", "Growth Lead"], targetIndustries: ["SaaS"], targetGeographies: ["United States", "United Kingdom"], employeeMin: 50, employeeMax: 1000, keywords: ["lead routing", "speed to lead", "MQL"] },
    { name: "The Nonprofit Development Director", categoryId: catOps, description: "Manages donor and grant programs; buys for intake and reporting.", targetTitles: ["Development Director", "Grants Manager", "Executive Director"], targetIndustries: ["Nonprofit", "Education"], targetGeographies: ["United States"], employeeMin: 10, employeeMax: 500, keywords: ["grants", "board reporting", "intake"] },
  ]) {
    await db.insert(personas).values({ workspaceId, ...p, isPreset: false, createdByUserId: ownerUserId } as never);
  }
  counts.personas = 4;
  await db.insert(icpProfiles).values({
    workspaceId, version: 3, generatedAt: daysAgo(6),
    targetIndustries: ["SaaS", "Fintech", "Data/Analytics", "Nonprofit"], targetCompanySizeMin: 100, targetCompanySizeMax: 2500,
    targetRevenueMin: "10000000.00", targetRevenueMax: "500000000.00",
    targetTitles: ["VP Revenue Operations", "Chief Revenue Officer", "Director of Sales", "Head of Marketing"],
    targetGeographies: ["United States", "Canada", "United Kingdom"], targetTechStack: ["Salesforce", "HubSpot", "Outreach", "Gong"],
    antiPatterns: ["Agencies under 20 people", "Companies with no sales team", "Government procurement-only buyers"],
    avgDealValue: "42500.00", avgSalesCycleDays: 47,
    topConversionSignals: ["Replied within 48h", "Attended a demo", "Hired a RevOps leader in the last 90 days"],
    confidenceScore: 82, sampleWonDeals: 9,
    aiRationale: "Nine of the last eleven won deals were midmarket SaaS or fintech companies with a dedicated RevOps function and a Salesforce or HubSpot CRM. Losses cluster in sub-50-person companies without a sales team.",
    isActive: true,
  } as never);
  counts.icpProfiles = 1;
  await db.insert(brandVoiceProfiles).values({
    workspaceId, tone: "conversational",
    vocabulary: ["pipeline", "hand-off", "signal", "follow-through", "one place"], avoidWords: ["synergy", "leverage", "streamline", "seamless", "robust", "unlock"],
    fromName: ownerName, fromEmail: ownerEmail, applyToAI: true,
  } as never);
  counts.brandVoice = 1;

  // ── Booking link for the owner ─────────────────────────────────────────
  await db.insert(bookingLinks).values({ workspaceId, userId: ownerUserId, slug: "john-queue", title: `30 minutes with ${ownerName}`, description: "Pick a time that suits you.", durationMin: 30, active: true, bookingCount: 14, timezone: "America/New_York" } as never);
  counts.bookingLinks = 1;

  // ── Meetings ───────────────────────────────────────────────────────────
  const meetingSpecs: Array<{ status: string; daysOffset: number; source: string; title: (c: string) => string; disposition?: string; ai?: string }> = [
    { status: "scheduled", daysOffset: 1, source: "manual", title: (c) => `Discovery call: ${c}` },
    { status: "scheduled", daysOffset: 2, source: "are", title: (c) => `Intro: ${c} × Queue & Co` },
    { status: "scheduled", daysOffset: 4, source: "inbound", title: (c) => `Demo for ${c}` },
    { status: "scheduled", daysOffset: 7, source: "manual", title: (c) => `Pricing review: ${c}` },
    { status: "proposed", daysOffset: 3, source: "ai", title: (c) => `Follow-up with ${c}`, ai: "Replied 'happy to chat next week' to step 2; proposing three slots Tue–Thu." },
    { status: "proposed", daysOffset: 5, source: "ai", title: (c) => `Discovery: ${c}`, ai: "Opened the last three emails and clicked the booking link without booking." },
    { status: "completed", daysOffset: -2, source: "manual", title: (c) => `Discovery call: ${c}`, disposition: "qualified" },
    { status: "completed", daysOffset: -6, source: "are", title: (c) => `Demo: ${c}`, disposition: "proposal_sent" },
    { status: "completed", daysOffset: -12, source: "inbound", title: (c) => `Intro call: ${c}`, disposition: "not_now" },
    { status: "cancelled", daysOffset: -1, source: "manual", title: (c) => `Check-in: ${c}` },
    { status: "no_show", daysOffset: -4, source: "ai", title: (c) => `Discovery: ${c}` },
  ];
  for (let i = 0; i < meetingSpecs.length; i++) {
    const m = meetingSpecs[i]; const c = conts[(i * 3) % conts.length]; const a = c.accountId ? acctById.get(c.accountId) : undefined;
    await db.insert(meetings).values({
      workspaceId, ownerUserId, relatedType: "contact", relatedId: c.id, contactName: `${c.firstName} ${c.lastName}`, contactEmail: c.email, company: a?.name ?? null,
      title: m.title(a?.name ?? `${c.firstName} ${c.lastName}`), status: m.status, source: m.source,
      proposedTimes: m.status === "proposed" ? [daysFromNow(m.daysOffset, 15).toISOString(), daysFromNow(m.daysOffset + 1, 16).toISOString(), daysFromNow(m.daysOffset + 2, 10).toISOString()] : null,
      scheduledAt: m.status === "proposed" ? null : daysFromNow(m.daysOffset, 15), durationMin: 30,
      meetingUrl: m.status === "scheduled" || m.status === "completed" ? `https://meet.google.com/${token(3)}-${token(4)}-${token(3)}` : null,
      aiReasoning: m.ai ?? null, aiConfidence: m.ai ? randInt(70, 92) : null, inviteSent: m.status !== "proposed", disposition: m.disposition ?? null,
    } as never);
  }
  counts.meetings = meetingSpecs.length;

  // ── Demo campaign: sequences + sent steps (Step performance, Sankey, dispatch table)
  const [camp] = await db.select().from(areCampaigns).where(and(eq(areCampaigns.workspaceId, workspaceId), eq(areCampaigns.name, DEMO_CAMPAIGN_NAME))).limit(1);
  let campaignId: number | null = null;
  const sentLog: Array<{ to: string; subject: string; at: Date; execId: number; pqId: number }> = [];
  if (camp) {
    campaignId = camp.id;
    // Paused: the dispatcher must never pick up the scheduled steps below.
    await db.update(areCampaigns).set({ status: "paused" } as never).where(and(eq(areCampaigns.id, camp.id), eq(areCampaigns.workspaceId, workspaceId)));
    const rows = await db.select().from(prospectQueue).where(and(eq(prospectQueue.campaignId, camp.id), eq(prospectQueue.workspaceId, workspaceId)));
    const STEP_SUBJECTS = ["pipeline visibility at {{company}}", "one thing about hand-offs", "how {{company}} forecasts", "a 15-minute look", "the RevOps stack question", "before I close this out", "last note from me"];
    const STEP_BODIES = [
      "{{firstName}}, most RevOps teams I talk to can name the deal that slipped last quarter but not the moment it slipped. Does {{company}} see that moment today, or only the result?",
      "Quick follow-up. The hand-off from marketing to sales is where we see the most pipeline quietly die. Is that a clean edge at {{company}}, or a place where things fall between teams?",
      "Curious how {{company}} builds the forecast: a spreadsheet on Fridays, or something that updates as reps work? No pitch, genuinely interested in the answer.",
      "If it'd be useful, I can walk you through how two similar teams tightened their forecast in a quarter. [grab 15 minutes]({{bookingLink}})",
      "One more angle: which system is the source of truth for a deal's stage at {{company}}? When it's two, the forecast is an argument.",
      "I'll stop here soon. If any of this landed, a reply with one word is enough and I'll send the right thing.",
      "Closing the loop on my side. If timing changes at {{company}}, you know where to find me.",
    ];
    let execCount = 0;
    for (const p of rows) {
      const active = p.sequenceStatus === "enrolled" || p.sequenceStatus === "replied" || p.sequenceStatus === "completed";
      if (!active) continue;
      const steps = STEP_SUBJECTS.map((subject, i) => ({ stepIndex: i, day: i * 7, channel: "email", subject, body: STEP_BODIES[i], variantKey: DEFAULT_VARIANT_KEY }));
      await db.update(prospectIntelligence).set({ generatedSequence: steps, sequenceQualityScore: randInt(27, 36), sequenceQualityBreakdown: { specificity: 8, clarity: 8, brevity: 9, cta: 7 } } as never)
        .where(and(eq(prospectIntelligence.prospectQueueId, p.id), eq(prospectIntelligence.workspaceId, workspaceId)));
      const sentSteps = p.sequenceStatus === "replied" ? 2 : p.sequenceStatus === "completed" ? 7 : randInt(1, 3);
      const firstSend = daysAgo(7 * sentSteps + randInt(0, 3));
      for (let i = 0; i < steps.length; i++) {
        const when = new Date(firstSend.getTime() + i * 7 * 86400000);
        const sent = i < sentSteps;
        const opened = sent && Math.random() < 0.55;
        const body = STEP_BODIES[i].replace(/\{\{firstName\}\}/g, p.firstName ?? "there").replace(/\{\{company\}\}/g, p.companyName ?? "your company").replace(/\{\{bookingLink\}\}/g, appUrl("/b/john-queue"));
        const subject = STEP_SUBJECTS[i].replace(/\{\{company\}\}/g, p.companyName ?? "your company");
        const execId = insertId(await db.insert(areExecutionQueue).values({
          workspaceId, campaignId: camp.id, prospectQueueId: p.id, stepIndex: i, channel: "email",
          scheduledAt: sent ? when : new Date(Math.max(when.getTime(), Date.now() + 86400000)), executedAt: sent ? when : null,
          status: sent ? "sent" : "scheduled", messageContent: { subject, body, variantKey: DEFAULT_VARIANT_KEY },
          trackingToken: sent ? token(32) : null, openedAt: opened ? new Date(when.getTime() + randInt(1, 30) * 3600000) : null, openCount: opened ? randInt(1, 4) : 0,
          sendingAccountId: sent ? mailboxId : null, fromEmail: sent ? ownerEmail : null,
        } as never));
        execCount++;
        if (sent && p.email) sentLog.push({ to: p.email, subject, at: when, execId, pqId: p.id });
      }
    }
    counts.executionRows = execCount;
  }

  // ── Emails page: the log of what went out ─────────────────────────────
  let logCount = 0;
  for (const s of sentLog) {
    await db.insert(emailLog).values({ workspaceId, source: "campaign", sourceLabel: DEMO_CAMPAIGN_NAME, executionQueueId: s.execId, campaignId, prospectQueueId: s.pqId, sendingAccountId: mailboxId, userId: ownerUserId, fromEmail: ownerEmail, fromName: ownerName, toEmail: s.to, subject: s.subject, bodyPreview: "…", status: "sent", sentAt: s.at, messageId: `<${token(20)}@queueandco.com>` } as never);
    logCount++;
  }
  const seqSubjects = ["Saw you visited pricing", "Demo this week?", "Catching up", "Resource share: the forecast checklist", "Quick intro from Queue & Co"];
  for (let i = 0; i < 18; i++) {
    const c = conts[(i * 5) % conts.length];
    if (!c.email) continue;
    await db.insert(emailLog).values({ workspaceId, source: i % 4 === 3 ? "crm" : "sequence", sourceLabel: i % 4 === 3 ? null : "Inbound follow-up", contactId: c.id, sendingAccountId: mailboxId, userId: ownerUserId, fromEmail: ownerEmail, fromName: ownerName, toEmail: c.email, subject: rand(seqSubjects), bodyPreview: "Hi " + c.firstName + ", following up on …", status: "sent", sentAt: daysAgo(randInt(0, 28), randInt(8, 17)), messageId: `<${token(20)}@queueandco.com>` } as never);
    logCount++;
  }
  counts.emailLog = logCount;

  // ── Conversations: replies that came back ─────────────────────────────
  const replySpecs = [
    { cls: "willing_to_meet", sentiment: "positive", subject: "Re: a 15-minute look", body: "Sure, happy to take a look. Thursday afternoon works if you have a slot.", handled: false },
    { cls: "follow_up_question", sentiment: "neutral", subject: "Re: how {{company}} forecasts", body: "Does this connect to HubSpot, or would we be moving data around by hand?", handled: false },
    { cls: "willing_to_meet", sentiment: "positive", subject: "Re: pipeline visibility", body: "Yes, let's talk. Send me some times for next week.", handled: false },
    { cls: "person_referral", sentiment: "neutral", subject: "Re: one thing about hand-offs", body: "I'm not the right person for this. Try Dana in RevOps, she owns the stack.", handled: true },
    { cls: "out_of_office", sentiment: "neutral", subject: "Automatic reply: pipeline visibility", body: "I'm out of the office until the 18th with limited access to email.", handled: true },
    { cls: "not_interested", sentiment: "negative", subject: "Re: the RevOps stack question", body: "We're locked into our current tools for the year. Please don't follow up.", handled: true },
    { cls: "follow_up_question", sentiment: "neutral", subject: "Re: Demo this week?", body: "What does pricing look like for a team of eight?", handled: false },
    { cls: "willing_to_meet", sentiment: "positive", subject: "Re: Saw you visited pricing", body: "Good timing, we're evaluating options this month. Can you do a demo Friday?", handled: true },
    { cls: "already_left_company_or_not_right_person", sentiment: "neutral", subject: "Re: before I close this out", body: "I left the company in August. You'll want to reach the new VP Sales.", handled: true },
    { cls: "unsubscribe", sentiment: "negative", subject: "Re: last note from me", body: "Please remove me from this list.", handled: true },
    { cls: "follow_up_question", sentiment: "neutral", subject: "Re: Catching up", body: "Can you send the forecast checklist you mentioned? The link didn't open for me.", handled: false },
    { cls: "willing_to_meet", sentiment: "positive", subject: "Re: Intro from Queue & Co", body: "Let's do it. I'll bring our head of sales ops as well.", handled: true },
  ];
  for (let i = 0; i < replySpecs.length; i++) {
    const r = replySpecs[i]; const c = conts[(i * 7 + 2) % conts.length]; const a = c.accountId ? acctById.get(c.accountId) : undefined;
    const at = daysAgo(randInt(0, 12), randInt(8, 18));
    await db.insert(emailReplies).values({
      workspaceId, sendingAccountId: mailboxId, userId: ownerUserId, fromEmail: c.email ?? `${c.firstName.toLowerCase()}@${a?.domain ?? "example.com"}`, fromName: `${c.firstName} ${c.lastName}`,
      subject: r.subject.replace("{{company}}", a?.name ?? "your team"), bodyText: r.body, contactId: c.id, accountId: a?.id ?? null, campaignId,
      receivedAt: at, readAt: r.handled ? at : null, replyClass: r.cls, sentiment: r.sentiment, classConfidence: randInt(72, 96),
      classReasoning: `Classified as ${r.cls.replace(/_/g, " ")} from the reply text.`, classifiedAt: at,
      suggestedReply: r.cls === "willing_to_meet" ? "Great — here are three times that work on my side: …" : r.cls === "follow_up_question" ? "Good question. Short answer: …" : null,
      handledAt: r.handled ? new Date(at.getTime() + 3600000) : null, handledBy: r.handled ? "user" : null, messageId: `<${token(20)}@mail.example.com>`,
    } as never);
  }
  counts.emailReplies = replySpecs.length;

  // ── Calls ──────────────────────────────────────────────────────────────
  const agentId = insertId(await db.insert(voiceAgents).values({ workspaceId, ownerUserId, name: "Queue & Co callback line", purpose: "callback_receptionist", voice: "eve", instructions: "Greet the caller, confirm who they are, and offer to book a 30-minute call with John.", phoneNumber: "+1 (555) 014-2200", status: "active" } as never));
  const outcomes = ["Booked a discovery call for Thursday.", "Left a voicemail; will retry in two days.", "Spoke with the assistant; sent the deck by email.", "Not interested this quarter, revisit in Q1.", "Wrong number on file; updated the record.", "Asked for pricing; forwarded to John."];
  for (let i = 0; i < 12; i++) {
    const l = lds[(i * 3) % lds.length]; const status = rand(["completed", "completed", "completed", "no_answer", "failed"]); const started = daysAgo(randInt(0, 20), randInt(9, 17)); const dur = status === "completed" ? randInt(90, 720) : 0;
    await db.insert(voiceCalls).values({ workspaceId, agentId, direction: i % 3 === 0 ? "inbound" : "outbound", toNumber: l.phone, fromNumber: "+15550142200", status, outcome: status === "completed" ? rand(outcomes) : null, relatedType: "lead", relatedId: l.id, userId: ownerUserId, durationSec: dur, startedAt: started, endedAt: new Date(started.getTime() + dur * 1000) } as never);
  }
  counts.voiceCalls = 12;

  // ── Inbound capture: visits, forms, landing page, chat agent ──────────
  const PATHS = ["/", "/pricing", "/product", "/customers", "/blog/forecast-accuracy", "/demo", "/pricing", "/integrations/hubspot"];
  for (let i = 0; i < 40; i++) {
    const c = i % 3 === 0 ? conts[(i * 2) % conts.length] : null; const path = rand(PATHS);
    await db.insert(websiteVisits).values({ workspaceId, visitorId: `v-${token(10)}`, path, referrer: rand(["https://www.google.com/", "https://www.linkedin.com/", null, "https://news.ycombinator.com/"]), contactId: c?.id ?? null, intent: path === "/pricing" || path === "/demo" ? "high" : path === "/product" ? "medium" : "low", userAgent: "Mozilla/5.0", createdAt: daysAgo(randInt(0, 14), randInt(7, 22)) } as never);
  }
  counts.websiteVisits = 40;
  const formFields = [{ key: "name", label: "Name", type: "text", required: true }, { key: "email", label: "Work email", type: "email", required: true }, { key: "company", label: "Company", type: "text", required: false }, { key: "teamSize", label: "Sales team size", type: "select", options: ["1-5", "6-20", "21-50", "50+"] }];
  const formIds: number[] = [];
  for (const f of [{ title: "Request a demo", description: "Tell us about your team and we'll set up a walkthrough.", submitCount: 23 }, { title: "Download: the forecast checklist", description: "A one-page checklist for a forecast the board can trust.", submitCount: 61 }]) {
    formIds.push(insertId(await db.insert(forms).values({ workspaceId, publicId: token(24), title: f.title, description: f.description, fields: formFields, status: "active", autoCreateLead: true, autoRoute: true, submitCount: f.submitCount, createdByUserId: ownerUserId } as never)));
  }
  for (let i = 0; i < 8; i++) {
    const fn = rand(FIRST); const ln = rand(LAST); const a = rand(accts);
    await db.insert(formSubmissions).values({ workspaceId, formId: formIds[i % 2], data: { name: `${fn} ${ln}`, email: `${fn.toLowerCase()}@${a.domain}`, company: a.name, teamSize: rand(["6-20", "21-50", "50+"]) }, name: `${fn} ${ln}`, email: `${fn.toLowerCase()}@${a.domain}`, company: a.name, routedToUserId: ownerUserId, createdAt: daysAgo(randInt(0, 20)) } as never);
  }
  counts.forms = 2; counts.formSubmissions = 8;
  const pageId = insertId(await db.insert(landingPages).values({
    workspaceId, slug: "forecast-checklist", name: "Forecast checklist campaign page", status: "published", headline: "A forecast your board can trust", subheadline: "The one-page checklist RevOps teams use to find the deals that will slip before they do.", themeColor: "#14B89A",
    sections: [{ type: "text", heading: "Why forecasts miss", body: "Most misses are visible three weeks early in the activity data. Nobody is looking there." }, { type: "bullets", heading: "What's inside", items: ["The five signals that predict a slip", "A weekly 20-minute review", "A hand-off checklist for marketing → sales"] }],
    seoDescription: "Download the forecast checklist.", formHeading: "Get the checklist", ctaButtonLabel: "Send it to me", formFields: formFields.slice(0, 3), autoCreateLead: true, autoRoute: true, showBookingCta: true, viewCount: 412, submitCount: 23, createdByUserId: ownerUserId,
  } as never));
  for (let i = 0; i < 5; i++) { const fn = rand(FIRST); const ln = rand(LAST); const a = rand(accts); await db.insert(landingPageSubmissions).values({ workspaceId, pageId, data: { name: `${fn} ${ln}`, email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${a.domain}`, company: a.name }, name: `${fn} ${ln}`, email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${a.domain}`, company: a.name, routedToUserId: ownerUserId, createdAt: daysAgo(randInt(0, 15)) } as never); }
  counts.landingPages = 1;
  const chatId = insertId(await db.insert(chatAgents).values({
    workspaceId, slug: "website-assistant", name: "Website assistant", status: "published", mode: "approval", displayName: "Quinn", greeting: "Hi, I'm Quinn. What brings you to Queue & Co today?",
    persona: "Friendly, concise, never pushy. Qualify with two questions, then offer a meeting with John.", themeColor: "#14B89A", showOnHostedPages: true, followUpMode: "approval", followUpDelayMin: 45,
    qualifyingQuestions: [{ q: "How big is your sales team?", weight: 30 }, { q: "Which CRM do you use?", weight: 30 }, { q: "When are you looking to make a change?", weight: 40 }], qualifyThreshold: 60, bookingUserId: ownerUserId,
    autoCreateLead: true, autoRoute: true, sessionCount: 18, leadCount: 6, meetingCount: 2, createdByUserId: ownerUserId,
  } as never));
  const KNOWLEDGE: Array<[string, string]> = [["What Queue & Co does", "Queue & Co gives revenue teams one place to see pipeline, hand-offs and forecast signals, with AI that writes and sends outreach under human control."], ["Pricing", "Team plans start at $49 per seat per month, billed annually. Enterprise pricing is quoted per team."], ["Integrations", "Native integrations with Salesforce, HubSpot, Gmail, Outlook and LinkedIn. Data syncs both ways every five minutes."]];
  for (let i = 0; i < KNOWLEDGE.length; i++) {
    const k = KNOWLEDGE[i];
    await db.insert(chatAgentKnowledge).values({ workspaceId, agentId: chatId, title: k[0], body: k[1], enabled: true, sortOrder: i } as never);
  }
  const chatSpecs = [
    { name: "Priya Raman", company: "Atlas Fintech", status: "booked", qualified: true, score: 84, intent: "Evaluating RevOps tools this quarter", msgs: ["Hi, do you integrate with HubSpot?", "We do, both ways. How big is your sales team?", "About 25 reps.", "Great. Would a 30-minute walkthrough with John help? Here are some times."] },
    { name: "Owen Lark", company: "Cloudgrove", status: "qualified", qualified: true, score: 71, intent: "Forecast accuracy", msgs: ["Our forecast is always off. Can this help?", "Usually, yes. Which CRM are you on?", "Salesforce.", "Then the slip signals work out of the box. Want to see them on your data?"] },
    { name: null, company: null, status: "closed", qualified: false, score: 20, intent: "Job seeker", msgs: ["Are you hiring?", "This chat is for product questions. Careers are at /careers."] },
    { name: "Dana Whitfield", company: "Northwind Analytics", status: "active", qualified: false, score: 45, intent: "Pricing", msgs: ["What does it cost for eight people?", "Team plans start at $49 per seat per month. Would you like a quote?"] },
    { name: "Marcus Cole", company: "Pinecrest Labs", status: "booked", qualified: true, score: 88, intent: "Demo request", msgs: ["Can I get a demo this week?", "Yes. John has Thursday at 2pm or Friday at 10am. Which works?", "Thursday.", "Booked. You'll get an invite shortly."] },
    { name: null, company: null, status: "closed", qualified: false, score: 10, intent: "Support", msgs: ["I can't log in.", "Sorry about that. Support is at help@queueandco.com and they answer within the hour."] },
  ];
  for (const s of chatSpecs) {
    const at = daysAgo(randInt(0, 10), randInt(9, 20));
    await db.insert(chatSessions).values({ workspaceId, agentId: chatId, token: token(40), visitorName: s.name, visitorEmail: s.name ? `${s.name.toLowerCase().replace(/ /g, ".")}@example.com` : null, visitorCompany: s.company, messages: s.msgs.map((m, i) => ({ role: i % 2 === 0 ? "visitor" : "assistant", text: m, at: new Date(at.getTime() + i * 60000).toISOString() })), messageCount: s.msgs.length, status: s.status, qualified: s.qualified, score: s.score, intent: s.intent, aiSummary: `${s.name ?? "Anonymous visitor"}: ${s.intent}.`, pageUrl: "https://queueandco.com/pricing", pageTitle: "Pricing — Queue & Co", createdAt: at } as never);
  }
  counts.chatAgents = 1; counts.chatSessions = chatSpecs.length;

  // ── Activity timeline on contacts and deals ────────────────────────────
  const notes = ["Great first call; they're comparing us with two others.", "Champion is the RevOps lead; economic buyer is the CRO.", "Sent the forecast checklist after the demo.", "They asked for a security questionnaire.", "Budget confirmed for Q4.", "Pushed to next quarter; keep warm."];
  for (let i = 0; i < 30; i++) {
    const type = rand(["call", "email", "meeting", "note", "note", "email"]); const useOpp = i % 3 === 0 && opps.length > 0;
    const c = conts[(i * 2) % conts.length]; const o = useOpp ? opps[i % opps.length] : null;
    await db.insert(activities).values({
      workspaceId, type, relatedType: useOpp ? "opportunity" : "contact", relatedId: useOpp ? o!.id : c.id,
      subject: type === "call" ? "Call with " + c.firstName : type === "email" ? rand(seqSubjects) : type === "meeting" ? "Discovery call" : "Note",
      body: type === "note" ? rand(notes) : type === "call" ? rand(outcomes) : null,
      callDisposition: type === "call" ? rand(["connected", "voicemail", "no_answer", "callback_requested"]) : null, callDurationSec: type === "call" ? randInt(60, 900) : null,
      occurredAt: daysAgo(randInt(0, 30), randInt(8, 18)), actorUserId: ownerUserId,
    } as never);
  }
  counts.activities = 30;

  // ── Proposals and quotes on real deals ─────────────────────────────────
  const dealOpps = opps.filter((o) => ["proposal", "negotiation", "qualified"].includes(String(o.stage))).slice(0, 2);
  for (let i = 0; i < dealOpps.length; i++) {
    const o = dealOpps[i];
    const a = acctById.get(o.accountId); const c = conts.find((x) => x.accountId === o.accountId);
    const pid = insertId(await db.insert(proposals).values({
      workspaceId, createdBy: ownerUserId, title: `${a?.name ?? "Client"} — Revenue Operations Platform`, clientName: a?.name ?? "Client", clientEmail: c?.email ?? null, clientWebsite: a?.domain ? `https://${a.domain}` : null,
      contactId: c?.id ?? null, accountId: o.accountId, projectType: "Platform subscription", budget: String(o.value), description: `Annual subscription for ${a?.name ?? "the client"}'s revenue team, with onboarding and integration to their CRM.`,
      requirements: ["CRM integration", "SSO", "Quarterly business reviews"], status: i === 0 ? "sent" : "under_review", shareToken: token(48), sentAt: daysAgo(3 + i * 4), expiresAt: daysFromNow(27), linkedOpportunityId: o.id,
    } as never));
    const SECTIONS: Array<[string, string]> = [["overview", "Queue & Co gives your revenue team one place to see pipeline, hand-offs and forecast signals."], ["scope", "Platform subscription for up to 25 seats, CRM integration, onboarding for two teams, and a named success manager."], ["pricing", `Annual subscription: $${Number(o.value).toLocaleString()} including onboarding.`], ["timeline", "Kick-off within one week of signature; teams live in 30 days."]];
    for (const sec of SECTIONS) {
      await db.insert(proposalSections).values({ proposalId: pid, sectionKey: sec[0], content: sec[1] } as never);
    }
    const MILESTONES: Array<[string, number]> = [["Kick-off", 7], ["CRM integration live", 21], ["Teams onboarded", 30], ["First QBR", 90]];
    for (let j = 0; j < MILESTONES.length; j++) {
      const m = MILESTONES[j];
      await db.insert(proposalMilestones).values({ proposalId: pid, name: m[0], milestoneDate: daysFromNow(m[1]), owner: j === 2 ? "both" : "lsi_media", sortOrder: j } as never);
    }
    const seats = 25 - i * 10; const unit = 588; const subtotal = seats * unit; const onboarding = 4500;
    const qid = insertId(await db.insert(quotes).values({ workspaceId, opportunityId: o.id, quoteNumber: `Q-2026-${String(1041 + i).padStart(4, "0")}`, status: i === 0 ? "sent" : "draft", expiresAt: daysFromNow(30), subtotal: String(subtotal + onboarding), discountTotal: "0", taxTotal: "0", total: String(subtotal + onboarding), notes: "Annual billing. Seats can be added mid-term at the same rate.", terms: "Net 30. Auto-renews annually unless cancelled 30 days before term end.", sentAt: i === 0 ? daysAgo(3) : null, createdByUserId: ownerUserId } as never));
    await db.insert(quoteLineItems).values({ workspaceId, quoteId: qid, name: "Team plan seat (annual)", description: "Per user, billed annually", quantity: seats, unitPrice: String(unit), discountPct: "0", lineTotal: String(subtotal) } as never);
    await db.insert(quoteLineItems).values({ workspaceId, quoteId: qid, name: "Onboarding & CRM integration", description: "One-time", quantity: 1, unitPrice: String(onboarding), discountPct: "0", lineTotal: String(onboarding) } as never);
  }
  counts.proposals = dealOpps.length; counts.quotes = dealOpps.length;

  // ── Saved reports ──────────────────────────────────────────────────────
  for (const r of [
    { name: "Open pipeline by stage", object: "opportunities", config: { columns: ["name", "stage", "value", "closeDate", "owner"], filters: [{ field: "stage", op: "not_in", value: ["won", "lost"] }], groupBy: "stage", sort: { field: "value", dir: "desc" } }, scheduleFreq: "weekly" },
    { name: "Leads created this month", object: "leads", config: { columns: ["firstName", "lastName", "company", "source", "score", "status"], filters: [{ field: "createdAt", op: "this_month" }], sort: { field: "score", dir: "desc" } }, scheduleFreq: "none" },
    { name: "Calls and meetings last 30 days", object: "activities", config: { columns: ["type", "subject", "relatedType", "occurredAt", "actor"], filters: [{ field: "type", op: "in", value: ["call", "meeting"] }, { field: "occurredAt", op: "last_days", value: 30 }] }, scheduleFreq: "monthly" },
  ]) {
    await db.insert(savedReports).values({ workspaceId, ownerUserId, name: r.name, object: r.object, config: r.config, scheduleFreq: r.scheduleFreq, scheduleRecipients: r.scheduleFreq === "none" ? null : ownerEmail } as never);
  }
  counts.savedReports = 3;

  // ── Inbox notifications for the owner ─────────────────────────────────
  const wonOpp = opps.find((o) => String(o.stage) === "won");
  const NOTIFS: Array<{ kind: string; title: string; body: string | null; relatedType: string | null; relatedId?: number | null }> = [
    { kind: "email_reply", title: "Priya Raman replied: willing to meet", body: "\"Sure, happy to take a look. Thursday afternoon works if you have a slot.\"", relatedType: "conversation" },
    { kind: "approval_request", title: "12 AI-written emails are waiting for approval", body: "The demo campaign wrote step 1 for twelve people.", relatedType: "campaign" },
    { kind: "deal_won", title: wonOpp ? `Deal won: ${wonOpp.name}` : "Deal won", body: "Closed at " + (wonOpp ? `$${Number(wonOpp.value).toLocaleString()}` : "$48,000") + ".", relatedType: "opportunity", relatedId: wonOpp?.id ?? null },
    { kind: "task_due", title: "Task due today: send the security questionnaire", body: null, relatedType: "task" },
    { kind: "are_event", title: "Demo campaign: 3 opens and 1 reply in the last hour", body: null, relatedType: "campaign" },
    { kind: "renewal_due", title: "Renewal in 45 days: Meridian Health", body: "ARR $84,000. Health score 71.", relatedType: "customer" },
    { kind: "mention", title: "Sam mentioned you on Northline Capital", body: "\"@John can you take the pricing call on Tuesday?\"", relatedType: "account" },
    { kind: "system", title: "Welcome to Queue & Co on Velocity", body: "Your workspace is seeded with sample data. Explore, then replace it with your own.", relatedType: null },
  ];
  for (let i = 0; i < NOTIFS.length; i++) {
    const x = NOTIFS[i];
    await db.insert(notifications).values({ workspaceId, userId: ownerUserId, kind: x.kind, title: x.title, body: x.body, relatedType: x.relatedType, relatedId: x.relatedId ?? null, readAt: i >= 5 ? daysAgo(1) : null, createdAt: daysAgo(i === 0 ? 0 : randInt(0, 6), randInt(8, 18)) } as never);
  }
  counts.notifications = 8;

  // ── Marker ─────────────────────────────────────────────────────────────
  await db.insert(auditLog).values({ workspaceId, actorUserId: ownerUserId, action: "create", entityType: "demo_extras", entityId: workspaceId, after: counts } as never);
  return { seeded: true, counts };
}
