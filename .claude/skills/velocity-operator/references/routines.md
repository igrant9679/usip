# Operating routines and repeatable processes

The pattern under everything: the machines act, the attention panel confesses, a human reads the confession. Daily for sends, weekly for trends, monthly for budgets and trust, quarterly for strategy. Times are for one person running one workspace; scale with team size.

Contents: Daily (by role) · Weekly · Monthly · Quarterly · Repeatable processes (P1–P12) · Definition of done checklists.

---

## Daily

### Everyone — the 10-minute loop (Home first)
1. **Home → attention panel**, top to bottom. Each row is a queue; empty the queue, not the row.
   - AI drafts (Emails → AI Pipeline): approve, edit, discard. Read at least two in full every day; you are training your own trust.
   - Engine approvals (campaign → Prospects): release the batch if the campaign runs batch-approval. Nothing sends until you do.
   - Unhandled replies (Conversations): answer within one business day. A human reply beats any sequence step; handling one stops the sequence for that person.
   - Proposed meetings (Meetings): confirm or decline candidate times.
   - Draft tasks (Tasks): accept or dismiss next-best actions.
   - Routing suggestions and campaign proposals (Revenue Engine hub): decide, do not let them pile up; the engine keeps proposing.
2. **Inbox** (`/inbox`): read the engine events; anything red (bounce spike, failed send, credential expired) gets fixed before noon.
3. **Today's meetings** (Meetings / My Calendar): open each meeting record for the AI prep note; after the meeting set the disposition and log the activity.
4. **Tasks due today**: work them or reschedule with a reason. Overdue tasks fire workflow triggers and clutter the panel.

### SDR / prospector — add the morning block (45 min)
1. Needs Review (People → verification = needs review): fix emails, verify, archive junk. 15 min.
2. Find Prospects against today's ICP slice (one title × one industry × one geo); send results to a named list. 15 min.
3. Enroll: high fit + valid email → the right sequence or campaign (People → Add to ▾). Use the Add existing wizard for campaigns so duplicates and other memberships are visible before you commit. 10 min.
4. Social: work the Social queue (accepts, replies), within LinkedIn Limits. 5 min.

### AE / closer — add the pipeline block (30 min)
1. Deals board: every open deal has a next step dated in the future and an owner; move stages honestly.
2. Pipeline Alerts strip: clear every alert by acting or by acknowledging with a note.
3. Proposals and Quotes: anything `sent` for more than 5 days without an open gets a call task.
4. Log every touch (call, meeting, note) on the record; it feeds Deal Autopilot and the forecast.

### Customer success — 15 min
1. Customers: anyone `at_risk` or `critical` gets a touch today.
2. Renewals: anything at `thirty` or `at_risk` has an owner and a dated plan.
3. QBRs due this month: review the AI prep draft, schedule the meeting.

### Admin — 5 min
1. Deliverability: bounce and spam rates, warmup progress, any sender in `error`.
2. Sending Accounts: daily limits not saturated by one campaign; sender display names set.
3. Audit Log: skim for surprises (deletes, role changes, dial flips).

### End of day — 5 min (everyone)
- Every touch logged; every active deal and hot contact has a dated next step.
- Stages honest; win/loss reasons captured on closed deals.
- AI Pipeline and Email Drafts empty so overnight sends fire.
- Inbox zero on approval requests.

---

## Weekly (30–60 min, same day each week)

1. **Engine Performance** (`/are/performance`) and each active campaign's **Step performance**: which steps and variants get opens and replies; kill or rewrite losers; promote winners (A/B tab). Retiring a whole angle is a human call; the optimisation dial only tunes within limits.
2. **Campaign health** (`/are/campaigns`): per campaign — working count vs target, enrichment backlog, sequence quality spread (open two low-twenties sequences and read them), rejections for false negatives (restore real fits), sources still what you intend, daily cap sane, status as expected (nothing "active" that should be paused).
3. **Sequences** (`/v2/sequences`): enrollment counts, stuck steps, drafts sitting in Email Drafts.
4. **Conversations**: classification quality — mark anything misclassified; if "needs classify" grows, the classifier is starved or the mailbox is disconnected.
5. **Data health** (Data Enrichment → Data Health + sweep and backfill cards): what the sweeps found, credits spent, how many people still lack email or company. You are checking for a stall, not doing the work.
6. **Pipeline review** (Deals + Forecast): stage-by-stage; slipped close dates; deals with no activity in 14 days; forecast vs quota. Update win probabilities honestly.
7. **Leads**: anything `new` older than 2 days is a routing problem (Lead Routing) or a capacity problem.
8. **Inbound**: Website Visitors high-intent list, Forms submissions, Chat sessions transcripts (read three; promote the agent's dial if you approved everything unchanged), Landing page views vs submits.
9. **Autonomy Center**: AI-suggested workflow rules — adopt or dismiss; every dial still where you meant it.
10. **Reports**: run the saved weekly reports (open pipeline by stage; leads created; calls and meetings); schedule them to email if the same people read them every week.
11. **Team** (managers): per rep — replies handled, meetings held, tasks overdue; reassign load.

---

## Monthly (60–90 min, calendar it)

1. **Budgets** (Settings → Billing and credits): AI token usage vs monthly budget; verification and QuickEnrich credit cycles (no rollover: if a cycle ended with credits unspent raise the sweep cap, if it ran dry early lower it); LinkedIn lookup usage.
2. **Recalculate lead scoring** (Lead Scoring → Recalculate); confirm the primary model is still right. A month of enrichment changed the fields it reads.
3. **ICP review** (ICP Agent): read the current version vs last month; if won deals moved the profile, adjust campaign targeting; consider a campaign proposal run.
4. **Prune**: complete or archive finished campaigns; archive sequences nobody enrolls into; delete lists that served their purpose; clear Needs Review to zero once.
5. **Autonomy review**: any dial that spent a clean month on Approve with everything approved unchanged is a candidate for Auto. Promote one per month.
6. **Deliverability month-end**: domain health, warmup graduations, suppression list growth, unsubscribes by campaign; retire any sender with rising bounces.
7. **Brand voice and personas**: re-read; update avoid-words from what replies complained about; add personas for new segments that converted.
8. **Prompt templates and campaign prompts**: fold the month's learnings (do-not lines) into the prompts; regenerate unsent steps if the change is material.
9. **Customer success**: health tiers reviewed; renewals 90 days out have plans; QBRs scheduled for next month.
10. **Data hygiene**: duplicates in Data Health; company brand pins/merges; departed contacts (job-change signals) re-routed.
11. **Team and access**: roles right-sized; departed members deactivated and reassigned (Offboarding); MFA on for admins.
12. **Backup/export** (Danger zone → Export) if compliance wants an offline copy; audit-log skim for the month.

## Quarterly (half a day)
- Targeting strategy: which ICP slices produced meetings and revenue; rewrite campaign targeting; retire angles; write next quarter's campaign plan (P1 for each).
- Sequence library refresh; A/B winners baked into fixed sequences.
- Forecast accuracy: compare last quarter's forecast to actuals; adjust stage win probabilities.
- Onboard/offboard, seat count, workspace structure (multiple workspaces if brands or regions diverge).
- Demo workspace refresh if you demo the product (P11).

---

## Repeatable processes

### P1 — Launch a Revenue Engine campaign
1. Define the audience in one sentence (who, why now). Check the ICP profile agrees; add a persona if missing.
2. Campaigns → New: name; goal; targeting; **sources** (explicit list — `[]` = no discovery; for a curated campaign choose "existing people only"); target count; copy mode `per_person`; write the sequence prompt: one plain sentence of what you do, the voice, the do-not list (no invented programs/numbers, one meaning across steps, no credentials in names); cadence (5–7 steps, 5–7 day gaps); channels; daily cap (start 20–30); autonomy `batch_approval`.
3. Sender: choose the pool or sender; confirm **display names** set; reply mailbox connected (SendGrid: Reply-To to a connected mailbox); booking link timezone set.
4. Seed people: Add existing wizard from a list (verify step shows duplicates and memberships) or let discovery run.
5. Set status `active`. Watch Logs for the first tick; watch Prospects for enrichment; open the first three written sequences and read them; fix the prompt and regenerate before approving.
6. Approve the first batch of ~10 (exactly those rows). Watch Step performance and Signals for 48 hours (bounces, opens).
7. Then approve larger batches; raise the daily cap when bounce rate is low and replies arrive.
8. Weekly: routine item 1–2. Definition of done: replies handled within a day, quality spread read, no strangers in the queue.

### P2 — From a list to a meeting (sequence path)
1. Build the list: Find Prospects or People filters → Add to list.
2. Enrich fully; verify emails; clear Needs Review for the list.
3. Recalculate fit; keep `good`/`excellent` with `valid` email.
4. Enroll into a sequence (People → Add to ▾ → Sequence) or a campaign (wizard). Drafts appear in Email Drafts if the sequence requires review.
5. Replies → Conversations → handle; willing-to-meet → send booking link or propose times (Meetings).
6. Meeting held → disposition → convert lead → opportunity.

### P3 — Inbound lead handling (forms, landing pages, chat, booking)
1. Capture creates a lead (auto-create) and routes it (Lead Routing). Verify routing weekly.
2. Rep works the lead within the SLA (same day): call task auto-created for high-intent; log the call.
3. Qualify → Convert (Account + Contact + Opportunity) or unqualify with a reason.
4. Chat-qualified visitors: in Approve mode a high-priority task; in Auto a booked meeting — check the transcript before the meeting.

### P4 — Reply handling
1. Conversations, newest first; read classification and suggested reply.
2. Willing to meet → propose times / booking link (Meeting Autopilot can do it); question → answer in your voice, log; referral → create the referred person (People) and a task; OOO → snooze; left company → job-change flow, mark contact departed; not interested → mark, respect it; unsubscribe → suppression (automatic in Auto).
3. Handling marks the reply handled and stops the sequence for that person.

### P5 — Weekly pipeline and forecast review
1. Deals board by stage; sort by days in stage; every deal: next step dated, champion named, close date realistic.
2. Pipeline Alerts cleared; Deal Autopilot suggestions accepted or dismissed.
3. Forecast page: commit vs best case; adjust win probabilities; note slips with reasons.
4. Proposals/Quotes: follow-ups on anything sent > 5 days.

### P6 — Campaign copy refresh
1. Read two low-scoring and two high-scoring sequences (Sequences tab).
2. Edit the campaign's sequence prompt (voice + do-not list).
3. Cancel → regenerate → re-enrol in pages of 10 (sent steps kept); run `repairSequenceQualityTotals` if totals look uniform.
4. Approve the regenerated batch; compare Step performance week over week.

### P7 — New teammate
1. Team → Invite (email, name, role, title). Roles: super_admin / admin / manager / rep.
2. They connect a mailbox (and LinkedIn if they prospect); set the sender display name; set their booking link timezone.
3. Assign lists/territories (Lead Routing); add to sender pools if campaigns send as them.
4. Point them at Home, the Help Center's Getting Started, and Elsie's "Your First 15 Minutes" tour.

### P8 — Offboarding
1. Team → deactivate; reassign owned leads, deals, tasks, meetings, booking links.
2. Remove their sender from pools; disconnect their mailbox; revoke LinkedIn.
3. Check nothing still acts as them: campaigns sending from their account, chat booking user, report recipients.

### P9 — Data hygiene sweep
1. Data Health: merge duplicates; fix import mapping issues.
2. Needs Review to zero.
3. Companies: pin correct brand/domain where enrichment guessed; merge duplicates.
4. Recalculate scores; refresh segments.

### P10 — Monthly budget and autonomy review
As in Monthly items 1 and 5; record the decision in the workspace notes so next month's reviewer knows why.

### P11 — Create a demo workspace
1. As super_admin: workspace.create with sample data (Settings → Workspaces, or the API).
2. Invite the demo user (role super_admin), set a password, mark the invite accepted, transfer ownership if the demo persona should own it.
3. Run the demo extras seed (admin procedure `dangerZone.seedDemoExtras` with the demo user's id) — fills People, Meetings, Conversations, Emails, Calls, inbound capture, Lists, Segments, Personas, ICP, Brand voice, booking link, campaign sent steps, Proposals, Quotes, Reports, Inbox. Demo mailbox is disabled and the demo campaign paused by design.
4. Verify by opening every rail page as the demo user. Never enable the demo mailbox.

### P12 — Change an autonomy dial safely
1. Read a week of that feature's Approve output first.
2. Flip one dial; note the date in Inbox/notes.
3. Watch Home's digest and the feature's page for three days; revert if the quality drops.

---

## Definition-of-done checklists

**Campaign active**: sender display names ✓ · reply mailbox ✓ · sources intended ✓ · prompt has voice + do-not ✓ · cap set ✓ · first three sequences read ✓ · first batch approved by name ✓.

**Day closed**: attention panel empty ✓ · replies answered ✓ · touches logged ✓ · next steps dated ✓ · drafts approved ✓.

**Week closed**: performance read ✓ · losers retired ✓ · pipeline honest ✓ · leads routed ✓ · data not stalled ✓ · dials verified ✓.

**Month closed**: budgets set ✓ · scores recalculated ✓ · ICP reviewed ✓ · pruned ✓ · one dial promoted (or explicitly not) ✓ · deliverability reviewed ✓ · prompts updated ✓ · access right-sized ✓.
