# The Revenue Engine (ARE) — campaigns, the engine loop, and every dial

The Autonomous Revenue Engine is the part of Velocity that spends real sending reputation. Understand it before touching it live.

## Three things people call "sequences" (they are different)
| Name | Where | What | Copy | Sources its own people? |
|---|---|---|---|---|
| **Sequence** | Sequences `/v2/sequences` | Fixed multi-step flow; same steps to everyone enrolled | Fixed with merge tags | No — you enroll |
| **Revenue Engine campaign** | Campaigns `/are/campaigns` | Autonomous outbound: discover → enrich → write → send → work replies | Per person (model writes from a dossier) or fixed | Yes, when working count < target |
| **Campaign Sequences tab** | Inside a campaign | The per-person written steps for that campaign | — | — |
| **Broadcast** | Marketing `/campaigns` | One message to a segment (not yet sending) | One message | No |

Owners often say "sequence" meaning a Revenue Engine campaign. Clarify by page.

## Campaign anatomy
- **Targeting**: titles, industries, geographies, keywords, company size, personas; drives discovery and the ICP screen.
- **Prospect sources** (`prospectSources`): which discovery sources this campaign may use (QuickEnrich contact finder, Apollo search-only, LinkedIn search, web/news/Google-business scrapes, existing People). **An explicit empty list means NO discovery** (since 2026-09-04; before that, `[]` silently fell back to defaults and pulled strangers into a curated campaign).
- **targetProspectCount**: discovery runs only while working prospects < target.
- **Copy mode**: `per_person` (writer reads the dossier + campaign brief + brand voice + personas) or `fixed` template. **Sequence prompt**: the campaign brief in the writer's ear; put the voice and the do-not list here. A good prompt states what the company does in one plain sentence, forbids inventing programs or numbers the dossier does not show, and keeps one meaning across steps (new angle = new question, not new product).
- **Cadence**: steps with day offsets (default gap 7 days), channels email / LinkedIn; per-step A/B variants.
- **Autonomy mode**: `full` | `batch_approval` (default) | `review_release`.
- **Screen**: `minConfidence` enrichment gate (default 40), `autoApproveThreshold`, and the auto-reject floor (ICP score < 30 is skipped with a reason in Rejections; a human can restore).
- **Daily send cap**, sending pool (sender pool or per-campaign sender), suppression list, goal type.
- **Status**: `draft` → `active` → `paused` / `completed`. Only active campaigns tick. Pausing stops enrichment spend too.

## The engine loop (cron `AreEngine`, every 3 minutes)
1. **Global enrich pass** — pending people across all active campaigns, strictly serial, best-fit first: approved > pushed (score 0) > by score. Bounded per tick.
2. Per active campaign, one bounded tick:
   1. **Screen** — auto-approve / auto-reject per autonomy mode + thresholds; rows below the enrichment gate are skipped with a reason. Includes the **no-email door** (owner rule 2026-09-16): candidates discovered without an email stage as `sourcing` — outside the Prospects tab and every counter, shown only as "N finding email" — while the enrich pass hunts an address; this step admits them to `pending` the moment one lands and rejects the ones enrichment exhausted ("No verifiable email address found"). A prospect without an email is never in the queue.
   2. **Sequence** — the writer produces `generatedSequence` for approved people with none; evaluated by an LLM judge that sees the dossier (`sequenceQualityScore` /40, summed in code from the breakdown).
   3. **Enroll** — steps become `are_execution_queue` rows (one per step, due dates from the cadence); already-sent steps are kept on re-enrol.
   4. **Dispatch** — due email steps send through the pool respecting the campaign's daily cap, each mailbox's own daily/hourly caps (one shared allowance per mailbox — a step blocked by them is RE-SCHEDULED, not failed, and the Logs say "email steps held and re-scheduled") and BOTH suppression lists (the campaign's ARE list and the site-wide email_suppressions, 2026-09-20); every campaign email carries RFC 8058 List-Unsubscribe one-click headers, plus the workspace's opt-out footer when enabled; LinkedIn steps via Unipile; sender tokens (`{{senderName}}` etc.) fill at the send boundary from the chosen sender's display name; tracking injected. Campaign bounces resolve their workspace through email_log and suppress.
   5. **Complete** — people whose every step is actioned.
   6. **Counters** — funnel counters recomputed.
   7. **Discovery** — if drained and below target, scrape one source (rotating query slices).
Everything is idempotent and per-phase try/caught. Logs tab shows each phase per tick.

## People entering a campaign
- **Discovery** (above).
- **Add existing wizard** (Prospects tab → Add existing): 3 steps. *Select* (table with search, filters, pagination, select-all, or From a list) → *Verify* (duplicates against this campaign, and where each person already is in other campaigns and sequences, grouped by identity) → *Add* (batches of 100). Pushed people are enriched **serially** in a background chain, then written.
- **Campaign routing** (Autonomy Center → Campaign Routing dial: off / approval / auto, daily cap 25): every 30 min, unenrolled people are matched to the best-fit active campaign; approval mode surfaces suggestions on the hub; auto enrolls.
- **Campaign proposals** (same dial): hourly, people no active campaign fits are clustered into *proposed new campaigns* with a name, targeting, a drafted brief and the people list. Decide on the hub: create (campaign is born `draft`, people queued `pending`), redraft, or reject. Proposals need industry/country on People to cluster well.
- **AI Assistant**: `create_campaign` (draft only), `enroll_in_sequence`, `set_campaign_status`.

## Workspace limits and notices (ARE Settings — `/are/settings`)
- **Max Concurrent Campaigns** (default 5, slider 1–50) bounds how many campaigns may be **active** at once. Enforced at the three activation doors only — create-with-launch, `are.campaigns.setStatus → active`, and the proposal accept the Campaign Routing cron drives — and **never** inside the engine tick, so a running campaign is never frozen mid-sequence by someone moving the slider. Drafts are always allowed; pausing a campaign frees its slot immediately.
  - At the limit the operator sees: *"This workspace already has N active campaigns, which is its limit of M. Pause one, save this as a draft, or ask a workspace admin to raise Max Concurrent Campaigns in ARE Settings."* The same line comes back through the AI Assistant's `set_campaign_status` confirm card.
  - A **rep can hit this and cannot clear it**: `setStatus` is a workspace procedure, `settings.updateAreSettings` is admin-only. Route them to an admin rather than to the page.
  - The Auto campaign router does **not** fail at the cap — `acceptProposal` returns with no campaign and the proposal stays **pending** for a human, retried each tick. Look for `[CampaignProposals] ws N: proposal P held` in the logs.
  - Migration 0184 raised every existing workspace's cap to at least its current active count (capped at 50), so turning this on did not lock anyone out.
- **Notification Preferences** — three switches over the `are_event` notices: *Meeting booked via signal* (on by default), *Prospect auto-approved* (off by default, one digest per campaign per engine tick), *ICP profile updated or restored* (on by default; covers the unattended cron pass as well as the Regenerate/Restore buttons). They are honoured inside `areNotify`, so a new dispatch site cannot forget them; a workspace with no settings row yet fails **open** and still gets told.
- **Two `are_event` notices these switches do not cover** (say so before an operator concludes they have muted everything): engagement signals — every email open, click and LinkedIn accept — and the weekly rejection digest, which `emailTracking.ts` writes straight to `notifications` without passing through `areNotify` at all.
- **Brand Voice** is not set here. ARE outreach copy reads the one workspace Brand Voice profile (`/brand-voice`, also editable at Settings → Branding) through `buildBrandContext()`. **Apply to AI** off on that profile disables branding for every AI writer, ARE included — check it first when copy ignores the tone.

## Human gates
- `batch_approval`: the engine enriches; a human approves a batch (Prospects tab → select → Approve). Approving is the gate outbound waits behind. **Approve exactly the rows the owner named**; re-derive the set at the moment of acting — if discovery added strangers since, stop and show them.
- `review_release`: approve each person's written sequence.
- Reject = `skipped` with a reason; Restore brings a row back to `pending`/`approved`.
- Attention panel row "Engine approvals" counts these by campaign.

## Reading a campaign
- **Prospects tab**: enrichment and sequence status per row; filters by status; ICP score.
- **Sequences tab**: each person's steps with subject, body, day, variant, quality score and breakdown; regenerate one or many; edit a step.
- **Step performance**: table (sortable, filterable, groupable) of sends, opens, replies, meetings per step and variant + the funnel diagram (sends → opened/unopened → next step). Re-sent steps are merged into one node; backward links are dropped.
- **Signals**: opens, clicks, replies, bounces, unsubscribes as they arrive.
- **A/B**: variants per step with promoted winners.
- **Rejections**: auto-screened people with the reason (ICP floor, no email, gate); restore from here.
- **Logs**: engine phases per tick, counts and errors.

## Replies
Inbound mail is polled every 60 s (IMAP/Gmail/Graph). A reply to a campaign step marks the person `replied`, stops their remaining steps, and lands in Conversations classified. **SendGrid senders have no inbox**: replies go to the Reply-To address and only appear in Velocity if that mailbox is connected.

## Sender identity
One rule: `senderDisplayName` — the sending account's display name, else the owner's name. It becomes the From header and fills `{{senderName}}`. Set display names on every sender (SendGrid senders especially) or the signature is blank.

## Quality
- Judge sees the dossier and merge tags ("What the writer knew"), scores four axes, total /40 summed in code. Honest spread is roughly 21–34.
- Repair stored totals: `are.prospects.repairSequenceQualityTotals({ campaignId? })` (admin).
- Regenerate after changing the prompt: cancel → regenerate → re-enrol (sent steps are kept). Do it in pages of ~10; the per-user LLM burst limit is 30/min (background jobs exempt).

## Safety rules for anyone operating it
1. Never tick or dispatch a live campaign from a browser call; the engine cron does that. Use `enrollOnly` paths and read-only reads from the pane.
2. Confirm before bulk approvals; scope to the exact rows named.
3. Before setting a campaign active, check: sender display name, daily cap, suppression list, reply mailbox connected, timezone on booking link, prompt has the do-not list, sources list is what you intend.
4. A paused campaign spends nothing; pause is the safe direction.
5. Demo workspaces: demo mailbox disabled, demo campaign paused, future steps dated tomorrow or later.
