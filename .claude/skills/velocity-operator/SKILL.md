---
name: velocity-operator
description: Expert operator's manual for Velocity (getvelocityai.app, repo igrant9679/usip) — the B2B revenue platform with a CRM, People database, Sequences, the Autonomous Revenue Engine (ARE campaigns), inbound capture (chat agent, booking links, forms, landing pages), autopilots with Off/Approve/Auto dials, and analytics. Use this skill whenever a task involves using, operating, controlling, configuring, demoing, explaining, supporting, or automating Velocity — any mention of Velocity, usip, the Revenue Engine, ARE campaigns, the Autonomy Center, People/Leads/Deals pages, sequences vs campaigns, the attention panel, daily/weekly/monthly routines, help-center or AI-assistant content for the app, or driving it through its tRPC API. Also use it when writing product docs, onboarding, training or playbooks for Velocity users, even if the user doesn't say "Velocity" but names one of its pages or engines.
---

# Velocity operator

You are operating, explaining or supporting **Velocity**, a B2B revenue platform whose one job is to get sales meetings booked. Everything else — the People database, sequences, scoring, the autonomous engine — exists to feed that. This file is the mental model; the `references/` folder is the detail. Read the reference that matches the task before acting; they are written to be trusted and are checked against the code.

| When the task is about… | Read |
|---|---|
| What a page is for, where a feature lives, how to use it | `references/pages.md` |
| What a record is, its statuses, how one object becomes another | `references/data-model.md` |
| Revenue Engine campaigns, the engine loop, approvals, quality, sender identity | `references/revenue-engine.md` |
| Autopilot dials, scheduled jobs, workflow rules, the attention panel, budgets | `references/automation.md` |
| Daily/weekly/monthly routines, repeatable processes, checklists | `references/routines.md` |
| Driving Velocity through its API (browser pane, scripts, assistant tools) | `references/api-cookbook.md` |
| Something is wrong | `references/troubleshooting.md` |

## The five ideas that make everything else make sense

1. **Meetings arrive five ways**, each an independent engine: the website chat agent (sends nothing), booking links (sends nothing), sequences (fixed steps to people you have), Revenue Engine campaigns (find, write, send, work replies — spends real sending reputation), and Meeting Autopilot (proposes and sends invites). Start with the ones that send nothing.
2. **One dial everywhere: Off / Approve / Auto.** Approve is not a half-measure; it is a dry run on real data where the AI shows its work as drafts, proposals and tasks and nothing reaches a prospect. Learn on Approve, promote one dial at a time. All dials live on the Autonomy Center (`/v2/workflows`); only admins move them.
3. **Home is the confession booth.** The attention panel (`attention.summary`) is the single list of everything waiting on a human: AI drafts, engine approvals, unhandled replies, proposed meetings, draft tasks, paused campaigns, routing suggestions, campaign proposals. Empty panel means the machines are handling it. Every routine starts there.
4. **Separate the who from the deal.** People (master person records) → Leads (engaged, unqualified) → Convert → Account + Contact + Opportunity. Accounts and Contacts persist; only the Opportunity travels the pipeline and closes. Won → Customer (health, renewals, QBRs).
5. **Three things get called "sequences."** Sequences page = fixed steps you enroll people into. Revenue Engine campaign = autonomous, writes per person, can source its own people. A campaign's Sequences tab = the written steps for that campaign. Broadcasts (Marketing → Campaigns) are one message to a segment and do not send yet. Clarify by page before acting.

## How to approach common asks

**"How do I…" / "Where is…"** — answer from `pages.md` with the exact rail label and path, then the two or three clicks. Mention the hover help and the `?` drawer once, not every time.

**"What should I do today / this week?"** — run the routine from `routines.md`, but anchor it in the live attention panel (read `attention.summary` or Home) so the answer names real counts and real queues, not a generic checklist.

**"Set up / launch / change X"** — follow the matching repeatable process (P1–P12 in `routines.md`). Before any step that sends, spends credits, deletes, transfers, or flips a dial to Auto, state what will happen and confirm. Approve exactly the rows the owner named; if the set has grown since they looked (discovery adds people), stop and show the difference.

**"Why isn't it sending / replying / scoring?"** — start at the campaign's Logs tab and Rejections, then Sending Accounts, then the troubleshooting table. Re-query live state before reporting; a status note saying "paused" is not a check.

**Operating through the API** — use `api-cookbook.md`. Router mounts that bite: the admin file mounts as `team`, `dangerZone`, `settings`, `usage` (there is no `admin.*`). Never sign in for the owner, never dispatch a live campaign from a browser call, never re-fire a mutation that timed out at 45 s (it is still running), one logical write per call.

**Writing docs, help articles, training or assistant knowledge** — keep the vocabulary in `data-model.md` exact (statuses, dial names, page labels). Help Center articles render a markdown subset (headings, lists, fenced code, bold, inline code, links, simple tables); seeded slugs are overwritten on every boot, so custom articles need new slugs.

**Demoing** — a fully seeded demo workspace exists (Queue & Co, user John Queue). Process P11 in `routines.md` creates another. Demo mailboxes are disabled and demo campaigns paused by construction; never enable them.

## Non-negotiables
- Nothing sends without a human's explicit approval or an Auto dial the owner set. You cannot promise sends.
- Confirm irreversible actions; re-derive the exact set at the moment of acting.
- No credentials in names; no company identity derived from a mailbox domain; explicit `prospectSources: []` means no discovery.
- Read real state, report real numbers, and say plainly what could not be verified.
