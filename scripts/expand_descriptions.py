"""
Expand all PageHeader descriptions to two lines.
Each description should be ~90-120 chars total, split naturally across two lines
by making them more detailed and informative.
"""
import os

pages_dir = "/home/ubuntu/usip/client/src/pages/usip"

# Map of file -> (current short description, expanded two-line description)
changes = {
    "AIPipelineQueue.tsx": [
        # Find current and replace with expanded
    ],
    "ARECampaigns.tsx": [
        ("description=\"Create and manage ARE campaigns that source, score, and sequence prospects.\"",
         "description=\"Create and manage autonomous outbound campaigns that source, score, and sequence prospects. The AI handles enrichment, copywriting, and send scheduling end-to-end.\""),
    ],
    "AREHub.tsx": [
        ("description=\"Command centre for your ARE engine \u2014 campaigns, ICP, and pipeline flow.\"",
         "description=\"Command centre for your Autonomous Revenue Engine \u2014 monitor campaigns, ICP health, and pipeline flow. Track every prospect from discovery through to booked meeting.\""),
    ],
    "AREIcpAgent.tsx": [
        ("description=\"Define your Ideal Customer Profile to sharpen prospect qualification.\"",
         "description=\"Define and continuously refine your Ideal Customer Profile to sharpen prospect qualification. The AI infers your ICP from won and lost deals and updates it automatically.\""),
    ],
    "ARESettings.tsx": [
        ("description=\"Configure ARE engine defaults \u2014 scoring, enrichment, and automation rules.\"",
         "description=\"Configure ARE engine defaults including scoring thresholds, enrichment providers, and automation rules. These settings apply globally to all new campaigns unless overridden.\""),
    ],
    "Accounts.tsx": [
        ("description=\"Manage company accounts, ARR rollup, and associated contacts and deals.\"",
         "description=\"Manage company accounts with full hierarchy, ARR rollup, and associated contacts and deals. Track engagement history, health scores, and renewal risk in one place.\""),
    ],
    "Audit.tsx": [
        ("description=\"All record creates, updates, and deletes with before/after values. Admin only.\"",
         "description=\"A complete audit trail of all record creates, updates, and deletes with before-and-after field values. Restricted to workspace admins for compliance and security review.\""),
    ],
    "BrandVoice.tsx": [
        ("description=\"Define brand voice guidelines so AI-generated content stays on-message.\"",
         "description=\"Define your brand voice guidelines so every piece of AI-generated content stays on-message. Set tone, vocabulary preferences, and words to avoid across all outreach and campaigns.\""),
    ],
    "Calendar.tsx": [
        ("description=\"Schedule and manage meetings, calls, and follow-ups across your pipeline.\"",
         "description=\"Schedule and manage meetings, calls, and follow-ups across your entire pipeline. Connect your Google or Outlook calendar to sync events and receive smart scheduling suggestions.\""),
    ],
    "Campaigns.tsx": [
        ("description=\"Orchestrate multi-channel campaigns across email, social, and ads.\"",
         "description=\"Orchestrate multi-channel campaigns combining email sequences, social posts, and ad placements. Set goals, assign audiences, and track performance across every channel in one view.\""),
    ],
    "ConnectedAccounts.tsx": [
        ("description=\"Connect LinkedIn, email, and social accounts for outreach and engagement.\"",
         "description=\"Connect your LinkedIn, email, and social accounts to power outreach, engagement tracking, and automated follow-ups. All connected accounts are synced in real time.\""),
    ],
    "CustomFields.tsx": [
        ("description=\"Extend CRM entities with custom fields for your sales process.\"",
         "description=\"Extend CRM entities with custom fields tailored to your unique sales process. Add text, number, date, dropdown, and multi-select fields to contacts, accounts, and deals.\""),
    ],
    "Customers.tsx": [
        ("description=\"Track health scores, renewal risk, NPS, and expansion potential.\"",
         "description=\"Track customer health scores, renewal risk, NPS trends, and expansion potential post-close. Identify at-risk accounts early and surface upsell opportunities before they go cold.\""),
    ],
    "Dashboard.tsx": [
        ("description=\"Pipeline health, activity, and team performance at a glance.\"",
         "description=\"Your unified revenue intelligence overview \u2014 pipeline health, activity metrics, and team performance at a glance. Set goals, track progress, and drill into any metric instantly.\""),
    ],
    "DashboardHome2.tsx": [
        ("description=\"Pipeline, retention, and engagement overview.\"",
         "description=\"Your unified pipeline, retention, and engagement overview across every revenue motion. Monitor open deals, customer health, and outreach activity from a single command centre.\""),
    ],
    "Dashboards.tsx": [
        ("description=\"Build custom dashboards with KPI widgets, charts, and live CRM data.\"",
         "description=\"Build custom dashboards with KPI widgets, charts, and live CRM data pulled in real time. Share dashboards with your team or embed them in QBRs and executive reports.\""),
    ],
    "DataHealth.tsx": [
        ("description=\"Monitor data quality \u2014 duplicates, missing fields, and enrichment gaps.\"",
         "description=\"Monitor data quality across your entire CRM \u2014 surface duplicates, missing fields, and enrichment gaps. Run bulk fixes and enrichment jobs to keep your data clean and actionable.\""),
    ],
    "EmailAnalytics.tsx": [
        ("description=\"Track open rates, click-through, reply rates, and deliverability.\"",
         "description=\"Track open rates, click-through rates, reply rates, and deliverability across all campaigns and sequences. Identify top-performing subject lines and sending windows with AI-powered insights.\""),
    ],
    "EmailBuilder.tsx": [
        ("description=\"Design and preview HTML email templates with drag-and-drop blocks.\"",
         "description=\"Design and preview HTML email templates using drag-and-drop content blocks. Build reusable layouts for campaigns, sequences, and one-off sends with live mobile preview.\""),
    ],
    "EmailDrafts.tsx": [
        ("description=\"Review, approve, and send AI-generated drafts before they leave your outbox.\"",
         "description=\"Review, edit, approve, and send AI-generated email drafts before they leave your outbox. All drafts are queued here for human review unless the campaign is set to full-auto mode.\""),
    ],
    "EmailSuppressions.tsx": [
        ("description=\"Manage opt-outs, bounces, and suppression lists to protect sender reputation.\"",
         "description=\"Manage opt-outs, hard bounces, and global suppression lists to protect your sender reputation. Suppressed addresses are automatically excluded from all future sequences and campaigns.\""),
    ],
    "ImportContacts.tsx": [
        ("description=\"Bulk-import contacts from CSV, enrichment providers, or integrations.\"",
         "description=\"Bulk-import contacts from a CSV file, enrichment providers, or third-party integrations. Map columns, validate data, and resolve duplicates before committing records to your CRM.\""),
    ],
    "Inbox.tsx": [
        # Dynamic description — skip
    ],
    "LeadRouting.tsx": [
        ("description=\"Configure rules to auto-assign inbound leads to the right rep or team.\"",
         "description=\"Configure routing rules that automatically assign inbound leads to the right rep or team. Base assignments on territory, industry, company size, lead score, or round-robin rotation.\""),
    ],
    "LeadScoring.tsx": [
        # Dynamic description — skip
    ],
    "Leads.tsx": [
        ("description=\"Capture, score, and route inbound leads before they enter the pipeline.\"",
         "description=\"Capture, score, and route inbound leads before they enter the CRM pipeline. Leads are automatically enriched, scored A\u2013D, and assigned to reps based on your routing rules.\""),
    ],
    "Mailbox.tsx": [
        ("description=\"Manage connected email accounts, compose messages, and track replies.\"",
         "description=\"Manage your connected email accounts, compose new messages, and track replies across all inboxes. All sent emails are automatically logged to the relevant contact and deal records.\""),
    ],
    "MyLinkedIn.tsx": [
        ("description=\"Connect LinkedIn and manage outreach, connection requests, and InMail.\"",
         "description=\"Connect your LinkedIn account and manage outreach, connection requests, and InMail from one place. Track response rates and sync LinkedIn activity back to your CRM contacts automatically.\""),
    ],
    "NotificationPrefs.tsx": [
        ("description=\"Configure which events trigger in-app and email notifications.\"",
         "description=\"Configure which events trigger in-app bell notifications and email digests for your account. Customise notification frequency, grouping, and delivery channel per event type.\""),
    ],
    "Pipeline.tsx": [
        ("description=\"Visualise and advance open opportunities across every pipeline stage.\"",
         "description=\"Visualise and advance open opportunities across every stage of your sales funnel. Drag deals between stages, set close dates, and get AI-powered next-step recommendations.\""),
    ],
    "PipelineAlerts.tsx": [
        ("description=\"Real-time alerts for stalled deals, at-risk accounts, and anomalies.\"",
         "description=\"Real-time alerts for stalled deals, at-risk accounts, and pipeline anomalies detected by AI. Configure thresholds and notification rules so your team acts before opportunities go cold.\""),
    ],
    "Products.tsx": [
        ("description=\"Manage your product catalogue \u2014 SKUs, pricing, and billing cycles.\"",
         "description=\"Manage your product catalogue including SKUs, pricing tiers, billing cycles, and line-item configuration. Products are available for selection in quotes, proposals, and opportunity records.\""),
    ],
    "PromptTemplates.tsx": [
        ("description=\"Manage AI prompt templates for the email composer, research, and ICP agent.\"",
         "description=\"Manage AI prompt templates used across the email composer, research pipeline, and ICP agent. Customise system prompts, tone instructions, and output formats for each AI-powered feature.\""),
    ],
    "Proposals.tsx": [
        ("description=\"Create, send, and track proposals with versioning and e-signature.\"",
         "description=\"Create, send, and track client proposals with full version history, e-signature support, and engagement analytics. Know exactly when a prospect opens, reads, and forwards your proposal.\""),
    ],
    "QBRs.tsx": [
        ("description=\"Prepare and record Quarterly Business Reviews with AI talking points.\"",
         "description=\"Prepare, schedule, and record Quarterly Business Reviews with AI-generated talking points and health summaries. Share QBR decks with customers and capture action items in one structured workflow.\""),
    ],
    "Quota.tsx": [
        ("description=\"Set and track revenue, deal, and activity quotas per rep.\"",
         "description=\"Set and track revenue, deal count, and activity quotas per rep and per period. Visualise attainment in real time and get early warnings when reps are trending below target.\""),
    ],
    "Quotes.tsx": [
        ("description=\"Generate and manage price quotes linked to open opportunities.\"",
         "description=\"Generate and manage price quotes linked directly to open opportunities. Add line items from your product catalogue, apply discounts, and send quotes for e-signature in one step.\""),
    ],
    "Renewals.tsx": [
        ("description=\"Manage the full renewal cycle \u2014 from early warnings to signed renewals.\"",
         "description=\"Manage the full renewal cycle from early-warning flags through negotiation to signed renewals. Automate renewal reminders, track contract status, and surface expansion opportunities at renewal time.\""),
    ],
    "ResearchPipeline.tsx": [
        ("description=\"Run the 5-stage AI pipeline: signals \u2192 fit \u2192 angles \u2192 drafts \u2192 review.\"",
         "description=\"Run the 5-stage AI research pipeline: org signals \u2192 contact fit \u2192 angle generation \u2192 draft variants \u2192 final review. Each stage is fully auditable and can be paused for human approval.\""),
    ],
    "SCIM.tsx": [
        ("description=\"Configure SCIM 2.0 to sync users and groups from your identity provider.\"",
         "description=\"Configure SCIM 2.0 provisioning to automatically sync users and groups from your identity provider. Supports Okta, Azure AD, and any SCIM-compliant IdP for zero-touch user lifecycle management.\""),
    ],
    "SegmentRules.tsx": [
        ("description=\"Define auto-enrolment rules that keep segments fresh as data changes.\"",
         "description=\"Define auto-enrolment rules that keep your audience segments fresh as CRM data changes. Rules evaluate on every record update so segments always reflect your latest criteria.\""),
    ],
    "Segments.tsx": [
        ("description=\"Build dynamic segments using CRM fields, signals, and AI scores.\"",
         "description=\"Build dynamic audience segments using CRM fields, behaviour signals, and AI-generated scores. Segments update automatically and can be used as campaign audiences or workflow triggers.\""),
    ],
    "SenderPools.tsx": [
        ("description=\"Group sending accounts into pools for load-balanced, safe delivery.\"",
         "description=\"Group sending accounts into pools for load-balanced, reputation-safe email delivery. Pools distribute send volume across accounts to protect deliverability and avoid per-account throttling.\""),
    ],
    "SendingAccounts.tsx": [
        ("description=\"Connect and manage email accounts used for outbound sending.\"",
         "description=\"Connect and manage the email accounts used for outbound sending across sequences and campaigns. Monitor deliverability health, warm-up status, and daily send limits for each account.\""),
    ],
    "Sequences.tsx": [
        ("description=\"Build multi-step email and task cadences to engage prospects at scale.\"",
         "description=\"Build multi-step email and task cadences to engage prospects at scale with personalised touchpoints. Set delays, branching conditions, and auto-stop rules to keep every sequence relevant.\""),
    ],
    "Settings.tsx": [
        ("description=\"Workspace settings \u2014 general, billing, integrations, and notifications.\"",
         "description=\"Workspace settings covering general configuration, billing, integrations, and notification preferences. Changes here apply to all members unless overridden at the individual user level.\""),
    ],
    "Snippets.tsx": [
        ("description=\"Create reusable text snippets and personalisation tokens for emails.\"",
         "description=\"Create reusable text snippets and personalisation tokens for use across email templates and sequences. Insert snippets with a slash command in the email composer for fast, consistent messaging.\""),
    ],
    "Social.tsx": [
        ("description=\"Schedule, publish, and analyse posts across LinkedIn, Twitter/X, and more.\"",
         "description=\"Schedule, publish, and analyse social posts across LinkedIn, Twitter/X, Facebook, and Instagram. Use AI to generate post copy, optimise posting times, and track engagement metrics.\""),
    ],
    "Tasks.tsx": [
        ("description=\"Create, assign, and track tasks across deals, accounts, and customers.\"",
         "description=\"Create, assign, and track tasks across every deal, account, and customer record in the CRM. Set due dates, priorities, and reminders so nothing falls through the cracks.\""),
    ],
    "Team.tsx": [
        # Check current description first
    ],
    "Territories.tsx": [
        ("description=\"Define geographic or account-based territories and assign reps.\"",
         "description=\"Define geographic or account-based territories and assign reps accordingly. Territory rules automatically route new leads and accounts to the correct owner on creation.\""),
    ],
    "UnifiedInbox.tsx": [
        ("description=\"A single inbox for all inbound replies across connected email accounts.\"",
         "description=\"A single unified inbox for all inbound replies across every connected email account. Reply, forward, and log conversations directly to CRM records without leaving the inbox.\""),
    ],
    "Workflows.tsx": [
        ("description=\"Automate repetitive actions with trigger-based rules across the CRM.\"",
         "description=\"Automate repetitive actions with trigger-based workflow rules across the entire CRM. Workflows fire on record changes, time delays, or score thresholds and can update fields, send emails, or create tasks.\""),
    ],
}

changed = []
skipped = []

for fname, replacements in changes.items():
    if not replacements:
        skipped.append(fname)
        continue
    path = os.path.join(pages_dir, fname)
    if not os.path.exists(path):
        print(f"NOT FOUND: {fname}")
        continue
    content = open(path).read()
    new_content = content
    for old, new in replacements:
        if old in new_content:
            new_content = new_content.replace(old, new, 1)
    if new_content != content:
        open(path, "w").write(new_content)
        changed.append(fname)
        print(f"UPDATED: {fname}")
    else:
        print(f"NO MATCH: {fname}")

print(f"\nTotal updated: {len(changed)}, skipped (dynamic): {len(skipped)}")
