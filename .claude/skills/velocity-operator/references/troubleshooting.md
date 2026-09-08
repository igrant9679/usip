# Troubleshooting — symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing sends | No enabled sending account, campaign paused/draft, daily cap hit, all people `pending`/`approved` but no sequence, Email Drafts not approved | Sending Accounts enabled + limit; campaign `active`; approve the batch; empty Email Drafts / AI Pipeline; check campaign Logs |
| Emails arrive with blank signature / no sender name | Sender has no display name; `{{senderName}}` fills from `senderDisplayName` at the send boundary | Set display name on every sender (SendGrid senders too) |
| Replies not in Velocity | SendGrid has no inbox; Reply-To mailbox not connected; poller mailbox disconnected | Connect the Reply-To mailbox under Settings → Mailboxes; check Connected Accounts |
| Booking link offers night-time slots | Timezone defaults to UTC | Meetings → booking link → timezone |
| Strangers appeared in a curated campaign | Discovery ran because working < target and sources defaulted | Set `prospectSources` explicitly to existing-only or `[]`; reject the strangers; lower target |
| People stuck `pending` forever | Below enrichment gate; enrichment failed; burst limit; campaign paused | Rejections tab shows gate skips; raise/lower `minConfidence`; run `enrichBatch`; resume campaign |
| Pushed people never enriched | Push chain was parallel and hit the burst limit (fixed: now serial) | Trigger `enrichBatch`; check Logs |
| Sequence quality scores all 7–8 or all identical | Judge blind to dossier (fixed) or totals averaged (fixed) | Run `repairSequenceQualityTotals`; regenerate |
| Written emails invent programs or numbers | Prompt lets the brief override the dossier | Add do-not lines to the campaign sequence prompt; regenerate unsent steps |
| Step performance funnel blank / NaN | A re-sent step created a backward link (fixed by merging same-step sends) | Reload; if persists, check `are.metrics.stepFunnel` output |
| Campaign proposals say "Model draft unavailable" | Burst limit during tiebreak; deterministic fallback | Press Redraft on the proposal; run proposals from the cron, not a browser fan-out |
| Proposals cluster badly | People lack industry/country | Enrich companies; backfill industry; then regenerate proposals |
| Attention panel shows thousands of "replies" | A query lost `genuineReplyScope()` | Bug: report it; the badge must scope to genuine replies |
| Dial snaps back when a rep changes it | Setters are admin-only | Ask an admin |
| Help article edits vanish after a deploy | Seeded slugs are overwritten at boot | Create a new slug for custom content |
| Import puts the wrong column in email | Header mapping must be exact; two columns cannot claim one field | Fix headers; re-map |
| Contact names contain credentials (PMP, MBA) | LinkedIn suffixes | Name stripper runs on import/enrich; fix legacy rows via Data Health |
| Company shows as wrong brand | Enrichment guessed from a mailbox domain or slug | Pin the brand/domain on the company; pins beat every provider |
| LinkedIn actions fail | Unipile disconnected or caps reached | Connected Accounts; LinkedIn Limits |
| AI features fail mid-day | Monthly AI budget exhausted or provider key missing | Billing and credits; Settings → Integrations → AI credentials |
| "FORBIDDEN" from the API | Role too low or wrong workspace header | `x-workspace-id`; role |
| `No procedure found on path admin.*` | Router mounted as `team` / `dangerZone` / `settings` / `usage` | Use the right mount |
| Demo workspace sent an email | Should be impossible: demo mailbox disabled, campaign paused | Verify both; never enable the demo mailbox |
| Campaign "active" that should be paused | Someone resumed it; carried-state assumption | Re-query `are.campaigns.get`; pause; check Audit Log |

## Bug classes worth knowing (so you recognise them)
- **Dead wiring**: a finished feature nobody calls, or a name mismatch at a seam. Verify both directions (caller and consumer).
- **Inert settings**: a toggle that saves and reads back but nothing consults. Trace the read path.
- **Placeholder fields**: `<UNKNOWN>`-style values stored as truth; blocks enrichment and hides rows from repair.
- **Session-less owner**: background paths acting as a departed member. Offboarding must reassign everything.
- **Identity source**: a mailbox domain is not an employer; do not derive company from correlated attributes.
- **Failure masking**: an integration returning `[]` on error looks like "not found" and gets cached.
- **Carried state**: "still paused" in a note is not a check. Re-query.
