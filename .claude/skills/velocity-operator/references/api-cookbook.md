# Operating Velocity programmatically — the tRPC cookbook

Use this when you are controlling Velocity through its API rather than the UI: from the in-app browser pane, a script with a session cookie, or the AI Assistant's tools.

## Transport
- Base: `https://getvelocityai.app/api/trpc/<router>.<procedure>` (or the workspace's own host).
- Envelope: superjson. Queries are GET with `?input=<urlencoded JSON of {"json": <input>}>`; mutations are POST with body `{"json": <input>}`. Read the reply at `result.data.json`; errors at `error.json.message`.
- Header `x-workspace-id: <id>` selects the workspace; the session cookie authenticates.
- In the in-app Browser pane you are already signed in: `fetch('/api/trpc/...')` works. A pane call is cut at 45 s but the server keeps running the mutation — never re-fire a long mutation; poll instead. The pane closes between turns; navigate first.

```js
const h = { 'content-type': 'application/json', 'x-workspace-id': '4' };
const get = async (p, i) => (await (await fetch('/api/trpc/' + p + (i !== undefined ? '?input=' + encodeURIComponent(JSON.stringify({ json: i })) : ''), { headers: h })).json()).result?.data?.json;
const post = async (p, i) => (await (await fetch('/api/trpc/' + p, { method: 'POST', headers: h, body: JSON.stringify({ json: i }) })).json());
```

## Router mount names that bite
`server/routers.ts` is the map. The file `server/routers/admin.ts` mounts as **`settings`, `team`, `usage`, `dangerZone`** — there is no `admin.*`. Others: `workspace`, `attention`, `are.campaigns` / `are.prospects` / `are.execution` / `are.metrics` / `are.icp`, `prospects` (People), `contacts`, `accounts`, `leads`, `opportunities`, `deals`, `tasks`, `meetings`, `conversations`, `emailActivity` (Emails page), `sequences`, `recordLists`, `segments`, `personas`, `brandVoice`, `scoring`, `reports`, `notifications`, `proposals`, `quotes`, `forms`, `landingPages`, `chatAgents`, `websiteVisitors`, `bookingLinks`, `voiceAgents`, `sendingAccounts`, `senderPools`, `helpCenter`, `assistant`, `unipile`, `optimization`, `workflows`, `audit`.

## Reads you will use constantly
| Need | Call |
|---|---|
| Who am I | `auth.me` |
| What needs a human | `attention.summary` |
| Campaigns | `are.campaigns.list {}` · `are.campaigns.get {id}` |
| Campaign people | `are.prospects.list {campaignId, limit, status?}` · `are.prospects.getIntelligence {id}` · `are.prospects.listSequences {campaignId}` |
| Steps / dispatch | `are.execution.getQueue {campaignId}` · `getStepStates` · `getMessage {id}` · `getSignalLog` · `getSuppressionList` |
| Performance | `are.metrics.stepFunnel {campaignId}` · `abVariants` · `sourceYield` · `replyMix` |
| Proposals / routing | `are.campaigns.listProposals` · `getRoutingSettings` |
| People | `prospects.list {limit, search?, filters}` · `prospects.get {id}` |
| CRM | `accounts.list`, `contacts.list`, `leads.list`, `opportunities.list`, `tasks.list`, `meetings.list` / `meetings.stats`, `conversations.list` / `stats` |
| Inbound | `websiteVisitors.stats`, `forms.list`, `landingPages.list`, `chatAgents.list` / `sessions` |
| Config | `segments.list`, `personas.list`, `are.icp.getCurrent`, `recordLists.list`, `reports.list`, `sendingAccounts.list`, `scoring.listModels`, `bookingLinks.mine` / `getPublic {slug}` |
| Team | `team.list` (members with memberId, role, hasPassword, invitePending) |
| Sample data | `dangerZone.sampleDataStatus` |
| Help | `helpCenter.listArticles`, `getArticle {slug}`, `searchArticles {q}`, `askAI` |

## Writes (each one is a human-visible change — confirm before anything irreversible)
| Action | Call | Notes |
|---|---|---|
| Campaign status | `are.campaigns.setStatus {id, status}` | pause is the safe direction |
| Update campaign | `are.campaigns.update {id, ...}` | sources, prompt, cap, targeting |
| Routing dial | `are.campaigns.setRoutingSettings {mode, dailyCap}` | admin |
| Proposals | `generateProposals`, `decideProposal {id, decision}`, `redraftProposal {id}` | |
| Approve / reject / restore people | `are.prospects.approve {ids}`, `skip {ids, reason}`, `edit`, `cancelSequence`, `pauseSequence`, `resumeSequence` | approve exactly the named rows |
| Enrich / write | `are.prospects.enrich {id}`, `enrichBatch {campaignId, limit}`, `generateSequence {id}` | serial; burst limit 30/min per user |
| Add existing | `are.prospects.pushExistingPreview`, `pushExisting {campaignId, prospectIds}` | batches of 100 |
| Quality repair | `are.prospects.repairSequenceQualityTotals {campaignId?}` | admin |
| Dispatch controls | `are.execution.pause/resume {campaignId}`, `reviveSkippedSteps`, `addSuppression {email}` | never dispatch from a browser call |
| Sequences | `sequences.create/update/enroll` | |
| Lists | `recordLists.create`, `addMembers`, `removeMember` | |
| Tasks / meetings | `tasks.create`, `meetings.create`, `meetings.setAutopilotSettings` | |
| Autonomy dials | `tasks/meetings/conversations/deals.setAutopilotSettings {mode}`, `unipile.setSocialAutopilotSettings`, `chatAgents.setAutopilotSettings` / `setFollowUpSettings`, `prospects.setSweepSettings` / `setBackfillSettings`, `optimization.setSettings` | admin |
| Workspace | `workspace.create {name, seedDemoData}` (super_admin) | creator becomes super_admin member |
| Team | `team.invite {email, name, role, title, sendEmail, returnLink}`, `team.setMemberPassword {memberId, password}`, `team.markInviteAccepted {memberId}` | |
| Ownership / danger | `dangerZone.transferOwnership {newOwnerUserId}`, `removeSampleData`, `exportWorkspace`, `archive` | irreversible: confirm |
| Demo seed | `dangerZone.seedDemoExtras {ownerUserId?, ownerName?, ownerEmail?}` | idempotent; never sends |
| Help content | `helpCenter.createArticle/updateArticle/upsertCategory` | seeded slugs are overwritten at boot — use new slugs for custom articles |

## Safety rules for API operation
1. **Confirm irreversible actions** (bulk approve, reject, delete, transfer, archive, dial to auto, status active). Re-derive the exact rows at the moment of acting; if the set grew since the owner looked, stop and show the difference.
2. **Never sign in or enter credentials** on the owner's behalf; the owner signs in to the pane themselves.
3. **Never tick or dispatch live campaigns from a browser call.** Use read-only reads, `enrollOnly`, pause. The crons dispatch.
4. **Long mutations keep running after a 45-s pane timeout.** Poll state; do not re-fire.
5. **Bundled mass writes in one script are blocked by the safety classifier**; do one logical write per call and show results between.
6. **Verify carried state before reporting**: re-query campaign status, dial values and counts; a sentence in a status doc is not a check.
7. **Explicit `prospectSources: []` means no discovery**; leaving sources undefined uses defaults.
8. Per-user LLM burst is 30/min: fan-out enrich/generate calls serially or trigger the batch procedures.
9. Restore ws context (`x-workspace-id`) per call; workspace ids differ per environment (production: 2 = LSI, 4 = CommunityForce, 5 = Queue & Co demo).

## Ops
- Health: `GET /api/health` → `{commit, ...}`; deploys are verified by polling for the expected commit.
- Boot re-seeds help content, tours and the demo ARE campaign (guarded by name).
- Logs: campaign Logs tab (`are_engine_logs`), Audit Log page, `usage` router for LLM spend.
