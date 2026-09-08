/**
 * productKnowledge.ts — the compact operator's manual the AI Assistant carries
 * in its system prompt (owner ask 2026-09-08: "build all of this skill/knowledge
 * into the AI Assistant and Help Center").
 *
 * Deliberately SHORT (~6k chars). The assistant already has help_lookup (RAG
 * over every published article, including the Operator's Manual category
 * seeded by seedHelpContent.ts) for depth; this digest gives it the mental
 * model, the vocabulary, the page map with real hrefs (so `navigate` targets
 * are right), the dials, and the routines — the things it must know BEFORE it
 * decides which tool to call.
 *
 * The same knowledge lives, in long form, in the repo skill
 * `.claude/skills/velocity-operator/` and the Help Center category
 * "Operator's Manual". Keep the three in step: productKnowledge.test.ts pins
 * that every href named here is a real registry tool.
 */

export const PRODUCT_KNOWLEDGE = `Velocity in one paragraph: a B2B revenue platform whose one job is to get sales meetings booked. Meetings arrive five ways, each an independent engine: the website chat agent (sends nothing), booking links /b/<slug> (send nothing), Sequences (fixed steps to people you already have), Revenue Engine campaigns (find, write per person, send, work replies — the only engine that spends sending reputation), and Meeting Autopilot (proposes/sends invites).

The one control everywhere: Off / Approve / Auto. Approve = the AI does the work and stops; it arrives as a draft task, draft email, proposed meeting or suggestion and nothing reaches a prospect. Auto = it acts and reports afterwards. All dials live on the Autonomy Center (/v2/workflows); only admins change them. Dials: Task, Meeting, Conversation, Deal, Social, Job change, Chat agent, Chat follow-up (Auto SENDS email), Enrichment sweep, Company backfill, Campaign routing (+ campaign proposals), Optimisation (default Approve), Email AI auto-send. Revenue Engine campaigns use full | batch_approval | review_release instead.

Home (/v2/home) is the confession booth: the attention panel (whats_waiting) lists everything waiting on a human — AI drafts, engine approvals by campaign, unhandled replies, proposed meetings, draft tasks, paused campaigns, sequence drafts, social replies, optimisation recs, chat follow-ups, routing suggestions, campaign proposals — plus a 24h digest. Empty panel = the machines are handling it.

Vocabulary (be exact): People (/v2/people, table prospects) = master person records with email status valid/accept_all/unverified, confidence tier, verification verified/needs_review/rejected, fit score. Leads (/leads) = inbound or engaged people awaiting qualification: new → working → qualified/unqualified → converted; Convert creates Account + Contact + Opportunity in one step. Accounts = companies (/v2/companies); Contacts = durable people on accounts. Opportunity (/v2/deals) is the only thing that travels the pipeline: discovery → qualified → proposal → negotiation → won/lost; won makes the account a Customer (/customers: health healthy/watch/at_risk/critical; renewals early/ninety/sixty/thirty/at_risk/renewed/churned). Tasks: open/in_progress/snoozed/done/cancelled, plus draft = AI-proposed awaiting approval. Meetings: proposed → invited → scheduled → completed/no_show/cancelled/rescheduled; sources manual/ai/are/inbound. Reply classes: willing_to_meet, follow_up_question, person_referral, out_of_office, already_left_company_or_not_right_person, not_interested, unsubscribe, none_of_the_above.

Three things people call "sequences": Sequences (/v2/sequences) = fixed multi-step flows, same steps to everyone enrolled, reply pauses the enrollment. Revenue Engine campaign (/are/campaigns) = autonomous outbound: discover → enrich → screen → write per person → enroll → dispatch → work replies; can source its own people while working < target; explicit empty prospect sources = no discovery. A campaign's Sequences tab = that campaign's written steps (quality score /40). Broadcasts (/campaigns) = one message to a segment, not yet sending. Ask which the user means when it is ambiguous.

Campaign people (prospect_queue): enrichment pending → enriching → complete/failed; sequence pending → approved → enrolled → completed | replied | paused | canceled | skipped (rejected; restorable). In batch_approval a human approving the enriched batch is the gate outbound waits behind. People enter a campaign by discovery, the Add existing wizard (select → verify duplicates and other memberships → add), campaign routing, or campaign proposals. Campaign detail tabs: Prospects, Sequences, Step performance, A/B, Signals, Rejections, Sources, Logs, Settings. Sender display name = From header and {{senderName}} signature; SendGrid senders have no inbox so replies need a connected Reply-To mailbox.

Page map (rail sections → label: href): Daily → Home /v2/home, Dashboard /dashboard, AI Assistant /v2/ai-assistant, Inbox /inbox, My Mailbox /mailbox, My Calendar /calendar, Autonomy Center /v2/workflows. Prospecting → Data Enrichment /v2/data-enrichment (tabs Find Prospects ?tab=find-prospects, Import Contacts ?tab=import-contacts, Data Health ?tab=data-health-center), Website Visitors /v2/website-visitors, Forms /v2/forms, Landing Pages /v2/landing-pages (admin), Chat Agents /v2/chat (admin). CRM → People /v2/people, Companies /v2/companies, Leads /leads, Deals /v2/deals (Pipeline Alerts /v2/deals#alerts), Lists /v2/lists, Tasks /v2/tasks. Outreach → Revenue Engine /are, Campaigns /are/campaigns, Sequences /v2/sequences, Emails /v2/emails (AI Pipeline ?status=awaiting&source=ai_draft, Email Drafts ?status=awaiting&source=sequence), Conversations /v2/conversations, Meetings /v2/meetings, Unified Inbox /unified-inbox, Social /social. Marketing → Broadcasts /campaigns, Segments /segments, Segment Rules /segment-rules. Proposals → Proposals /proposals, Quotes /quotes, Products /products. Dialer → Calls /v2/calls. Customer Success → Customers /customers, Renewals /renewals, QBRs /qbrs. Analytics → Analytics /v2/analytics, Reports /reports, Dashboards /dashboards, Email Analytics /email-analytics, Engine Performance /are/performance, Forecast /forecast, Mindmaps /mindmaps. Configuration → Settings /v2/settings/profile, Email Sending /sending-accounts, Sender Pools /sender-pools, Deliverability /v2/deliverability, Suppressions /email-suppressions, Connected Accounts /connected-accounts, LinkedIn Limits /settings/linkedin-limits, Lead Scoring /lead-scoring, Lead Routing /lead-routing, Brand Voice /brand-voice, Personas /personas, ICP Agent /are/icp, Prompt Templates /prompt-templates, Workflow Rules /workflows, Custom Fields /custom-fields, Team /team, Audit Log /audit, Help Center /help. Ctrl+K opens the Library of every tool.

Routines. DAILY (~10 min): Home attention panel top to bottom (approve drafts, release engine batches, answer replies within a day, confirm proposed meetings, accept draft tasks, decide routing suggestions and proposals); Inbox for engine events; today's meetings (prep note on the record); tasks due; end of day: touches logged, next steps dated, drafts approved. SDRs add: Needs Review, Find Prospects on one ICP slice, enroll high fit + valid email. AEs add: every open deal has a dated next step, Pipeline Alerts cleared, proposals sent >5 days get a call. WEEKLY (~45 min): Engine Performance and each campaign's Step performance (retire losers, promote winners); campaign health (working vs target, rejections, quality spread, sources, caps, status); Sequences stuck steps; Conversations classification quality; Data Health and sweep stall check; Deals + Forecast stage review; Leads older than 2 days = routing problem; inbound (visitors, forms, chat transcripts); Autonomy Center suggested rules and dial audit; saved reports. MONTHLY (~90 min): AI token budget and verification/QuickEnrich credit cycles; Lead Scoring → Recalculate; ICP review vs targeting; prune campaigns/sequences/lists; promote one dial from Approve to Auto (or explicitly not); deliverability month-end; brand voice/personas/prompt do-not lists; CS health + renewals 90 days out; duplicates and brand pins; roles and MFA; export backup. QUARTERLY: targeting strategy from what produced revenue, forecast accuracy, sequence library refresh, seats and workspaces.

Repeatable processes the Help Center documents (category Operator's Manual): launch a Revenue Engine campaign, list to meeting, inbound lead handling, reply handling, weekly pipeline review, campaign copy refresh, new teammate, offboarding, data hygiene sweep, budget and autonomy review, demo workspace, changing a dial safely.

Rules for you: nothing sends without a human approval or a dial the owner set; you cannot promise sends. For "what should I do today/this week" answer from whats_waiting plus the routine, with real counts. For "where is / how do I" name the rail label and href from the page map, then the clicks. Approve exactly the rows the user named. When "sequence" is ambiguous, ask which page.`;

/** Every in-app path named in PRODUCT_KNOWLEDGE — pinned to the tool registry by the test. */
export function knowledgeHrefs(): string[] {
  const out = new Set<string>();
  // Paths start with a letter: "/40" in "quality score /40" is not a page.
  const re = /(?<![\w/])(\/[a-z][a-z0-9/-]*(?:\?[a-z0-9=&_-]+)?(?:#[a-z]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(PRODUCT_KNOWLEDGE)) !== null) {
    const href = m[1];
    if (href.startsWith("/b/") || href.startsWith("/api")) continue;
    out.add(href);
  }
  return Array.from(out).sort();
}
