# Automation — autopilot dials, crons, workflow rules, the attention panel

## The one convention: Off / Approve / Auto
Every autonomous feature has the same three-way dial (`workspace_settings.*Mode` = `off` | `approval` | `auto`), all on the Autonomy Center (`/v2/workflows`) and mirrored on each feature's own page. Admin-only to change.

- **Off** — nothing happens.
- **Approve** — the AI does the work and stops; it arrives as a draft task, draft email, proposed meeting or suggestion. Nothing reaches a prospect. This is a dry run on real data: the setting to learn on.
- **Auto** — it acts and tells you afterwards (Inbox + Home digest).

| Dial | Setting | Default | What Approve produces | What Auto does |
|---|---|---|---|---|
| Task Autopilot | `taskAutopilotMode` | off | `draft` tasks (next-best action per prospect, every 30 min) | open tasks |
| Meeting Autopilot | `meetingAutopilotMode` | off | `proposed` meetings with candidate times (every 45 min) | sends the invite |
| Conversation Autopilot | `conversationAutopilotMode` | off | classifies every reply + suggested reply (every 5 min) | acts per class: willing-to-meet gets your booking link; unsubscribe → suppression; referral → task |
| Deal Autopilot | `dealAutopilotMode` | off | next-step notes + win-prob on open deals (hourly) | also creates follow-up tasks |
| Social Autopilot | `socialAutopilotMode` | off | draft invite tasks (hourly) | sends LinkedIn invites within caps, opener DM on accept |
| Job-change Autopilot | `jobChangeAutopilotMode` | off | re-engagement tasks when enrichment detects a move (daily) | starts the re-engage sequence |
| Chat agent | per agent `mode` | off | chats, captures lead, qualified visitor → high-priority task | books the meeting itself |
| Chat follow-up | per agent `followUpMode` | off | drafts one follow-up to visitors who left an email and did not book (every 15 min) | **sends that email** |
| Enrichment sweep | `enrichmentSweepMode` | off | attended run only | unattended backlog email-finding every 6h (Reoon credits, daily cap, 20h gap per person) |
| Company backfill | `companyBackfillMode` | off | attended | unattended LinkedIn company backfill (~100 lookups/day) |
| Campaign routing + proposals | `campaignRoutingMode` (+ `campaignRoutingDailyCap` 25) | off | routing suggestions + campaign proposals on the hub | enrolls best-fit people into campaigns |
| Optimisation | `optimizationMode` | **approval** | proposals from outcomes (daily), attribution judges them (12h) | edits sequences within limits; auto-reverts what made outbound worse |
| Email AI auto-send | boolean | off | — | high-scoring AI drafts send themselves |

Revenue Engine campaigns use their own vocabulary: `full` | `batch_approval` | `review_release` (see `revenue-engine.md`).

**Sane starting posture:** everything that only *does work* (tasks, deals, sweeps, backfill, job-change detection, chat agent) on Auto; everything that *sends* (meetings, conversation replies, social, chat follow-up, campaigns in full mode, email auto-send) on Approve until a week of output has been read. Promote one dial at a time so you can tell which change caused what.

## Scheduled jobs (server/_core/index.ts)
| Job | Every | Purpose |
|---|---|---|
| AreEngine | 3 min | global serial enrich, then per-campaign tick (screen → sequence → enroll → dispatch → complete → counters → discovery) |
| SequenceEngine | 5 min | advance active sequence enrollments; then the AI auto-send pass |
| Inbound reply poller | 60 s | IMAP/Gmail poll for replies |
| Conversation autopilot | 5 min | classify + act on inbound replies |
| Pipeline alerts | 15 min | stale / low-prob / no-champion / slipped deals |
| Chat follow-up | 15 min | one follow-up per abandoned qualified chat |
| Task autopilot | 30 min | next-best-action tasks |
| Campaign routing | 30 min | best-fit routing (suggest or enroll) |
| Warmup | 30 min | mailbox warmup peer sends |
| OneNote / Graph calendar sync | 30 min | Microsoft 365 mirrors |
| NameVerification | 30 min | rewrite slug-derived company names with the domain's official name |
| Meeting autopilot | 45 min | propose meetings for ready prospects |
| Segment enrollment | 1 h | segment → sequence rules |
| Scheduled reports | 1 h | daily/weekly/monthly report emails |
| CampaignProposals | 1 h | propose new campaigns for unmatched people |
| Meeting reminders | 1 h | one reminder per booked meeting 1–24h out |
| Deal autopilot | 1 h | next step + win-prob |
| Social autopilot | 1 h | LinkedIn invites or draft tasks |
| Enrichment sweep / company backfill / image mirror / logo backfill / brand reconcile | 6 h | data-quality backfills (auto-mode workspaces only where a dial exists) |
| Attribution | 12 h | judge applied optimisations; auto-revert regressions |
| Optimisation, ICP inference, person-link backfill, normalized backfill, verification snapshot, nightly AI batch (midnight), LinkedIn job-change check (~01:00) | 24 h | daily learning and hygiene |
| Boot only | — | demo ARE seed, tours seed, help-content re-seed (+20 s) |

Archived workspaces are excluded from every job. Jobs are `guardOverlap`-ed so a slow run never doubles up.

## Workflow rules (`/workflows`, table `workflow_rules`)
Deterministic if-this-then-that, separate from the AI dials.
- **Triggers**: `record_created` (lead), `stage_changed` (opportunity), `signal_received` (job change), `deal_stuck` (scheduled check against a threshold), `task_overdue`, `field_equals`, `schedule` (cron).
- **Conditions**: field comparisons (value, stage, score, days in stage…).
- **Actions**: webhook, Slack, Teams, create task, notify (in-app), update field.
- **Test fire** runs the real code path with sample context; every run is in the rule's history.
The Autonomy Center also lists **AI-suggested rules** derived from what it sees; adopt the ones that describe something you actually do.

## The attention panel (`attention.summary`)
The one "what needs me" aggregator; Home renders it and the AI Assistant's `whats_waiting` reads it. Fields:
`totalNeedingYou`, `aiDrafts{count,items}`, `proposedMeetings{count,items}`, `unhandledReplies{count,items}`, `areApprovals{count,byCampaign}`, `draftTasks{count}`, `pausedCampaigns[]`, `sequenceDrafts{count}`, `socialReplies{count}`, `optimizationRecs{count}`, `chatFollowUps{count}`, `routingSuggestions{count,byCampaign}`, `campaignProposals{count}`, `digest24h{emailsSent,prospectsDiscovered,repliesReceived,meetingsBooked}`.
Any new human queue in the product must join this aggregator or it will be missed.

## Budgets and caps
- **Monthly AI budget** (Settings → Billing and credits): tokens, 0 = unlimited; usage card shows spend.
- **Per-user LLM burst**: 30 calls/min for interactive users (background jobs exempt) — fan-out from a browser silently fails; go serial or use the crons.
- **Reoon** verification credits and **QuickEnrich** lookups: monthly cycles, no rollover; sweep daily cap tunes spend.
- **LinkedIn** ~100 lookups/day per connected account; invite caps on LinkedIn Limits.
- **Apollo**: search-only, zero credit; company domain is free.
- **Daily send cap** per campaign and per sending account; sender pools spread load.
