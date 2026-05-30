# Velocity / usip — Session Handoff (Continue from here)

Refreshed at end of the build+audit session. Paste the bottom block into a new chat to resume.

---

## Repo + deploy

- **Repo:** `igrant9679/usip` (origin: `https://github.com/igrant9679/usip.git`)
- **Local path:** `C:\Users\Admin\usip`
- **Deploy:** Railway → `https://getvelocityai.app/` (auto-deploys on push to `main`)
- **Tip of `main`:** `819e11d` (emoji category icons). HELP_CONTENT_PLAN.md is now **implemented + verified live** (5 commits `172a082`→`819e11d`; see "Help content session" below).
- **Workspace under test:** **LSI Media** · **Test user:** Idris Grant (super_admin)

### Live data state of LSI Media (so empty lists don't surprise you)
- **Accounts / Contacts / Leads: empty** (the user bulk-deleted them; we then purged the resulting orphaned Customers/QBRs/Renewals). So `/accounts`, `/contacts`, `/leads`, `/customers`, `/renewals`, `/qbrs` legitimately show empty states.
- **Prospects:** ~13 (12 CSV-imported + 1 from a discovery test). **Pipeline:** 65 opportunities (all `pipelineId: null`). **ARE:** 5 campaigns. **1 bridged LinkedIn account** (Idris Grant, Unipile) — but its search currently returns 0 (likely a stale Unipile session; reconnect at `/connected-accounts` if testing LinkedIn).
- **Pipelines:** exactly 1 "Default" (the duplicate was cleaned up). **Email suppressions:** 0 (all 4 were false-positives we removed).

---

## How this codebase works (essentials — unchanged)

- **Stack:** React + Vite + wouter + tRPC v11 + Drizzle ORM (mysql2) + Express. Server bundle is esbuild; **esbuild does NOT typecheck** — but it DOES fail the build on missing exports / syntax errors / unresolved imports. TS type errors only surface at runtime.
- **No local Node toolchain.** Don't run `npm install` / `npm run build` / `tsc`. Verify by: static review → commit → push → watch Railway → check live site.
- **Production schema** = drizzle journal `0000–0047` ∪ **`server/_core/rawMigrations.ts`** (`0048+`, embedded SQL strings, idempotent). Tolerated errnos: `1050, 1060, 1061, 1091, 1146, 1826`. Migrations run ~5s after boot via `runRawMigrations()`, tracked by name in `__manus_migrations__`. **Latest applied: 0087.**
- **tRPC pattern:** `workspaceProcedure.input(z.object({...})).query/mutation(async ({ ctx, input }) => ...)`. `ctx.workspace.id` + `ctx.user.id` always present. **Every DB query is filtered by `workspaceId`.** A *workspace* is the tenant/company (LSI Media); *users/team members* are logins that belong to it via `workspace_members` (roles: super_admin/admin/manager/rep).
- **Engine cron** (`server/_core/index.ts`): `runAreEngine()` ~3 min (ARE tick: discover→enrich→sequence), `runPipelineAlertsCron()` ~15 min, `processEnrollments()` (sequenceEngine, sends sequence emails).
- **LLM:** `invokeLLM` (Anthropic/OpenAI/Gemini; workspace BYOK keys override env). **Email send:** `sendWorkspaceEmail(wsId, {...})`.

## Git identity (use exactly this on every commit)

```bash
git -c user.name='igrant9679' -c user.email='206445972+igrant9679@users.noreply.github.com' \
  commit -m "$(cat <<'EOF'
<message>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Commit + push to `origin/main` **per change** — incremental, not mega-commits. Stage specific files. (CRLF warnings on commit are benign.)

---

## Verification: Personal Chrome (Windows) via Claude-in-Chrome MCP

Always `list_connected_browsers` first and **ask which browser** (never auto-select).
- **Personal Chrome** — deviceId `0dbd9a79-7134-4dda-a574-5296bdf3309e` (default; current tab id `252174659`)
- **Browser 2** — deviceId `34bca05b-0d66-4134-bd2a-07d5424455ba`

Quirks: tools need `tabId` (use `tabs_context_mcp({createIfEmpty:true})`); `computer.action` is `left_click` not `click`; `browser_batch` items are `{name,input}`; `railway.com` is **not** a permitted domain for browser actions; **screenshots intermittently time out (CDP "renderer unresponsive")** — just retry the screenshot. Login URL `https://getvelocityai.app/` — user logs in; never ask for passwords. Driving tRPC directly via `javascript_tool` fetch (`/api/trpc/<proc>?batch=1...`) is a fast way to verify server behavior.

---

## ✅ DONE — `HELP_CONTENT_PLAN.md` implemented + verified live

The SDR Help enhancement is shipped and confirmed on LSI Media (Personal Chrome):
- **`server/seedHelpContent.ts`** — idempotent `seedHelpContent(db, wsId)` + `seedHelpForAllWorkspaces()`.
  Categories deduped by **name** (no slug column on `help_categories`), articles by slug, tours by name
  (steps delete+reinsert each run). Articles linked to their tour via `associatedTourId`. Wired into
  `seedWorkspace()` (new ws) **and** an `index.ts` boot backfill at 20s (existing ws).
- **Seeded + verified live:** 6 categories (emoji icons), **21 articles** published, 10 SDR tours
  (+ 2 kept legacy = 12; a pre-existing **"Enriching Contacts with Clodura"** tour also survives → 13 total).
  Ask AI answers the Needs-Review question citing `needs-review-queue` (PR-2) at confidence 95.
- **Decisions made this session:** tours = *merge/dedupe* — the 10 SDR tours supersede 5 legacy demo tours
  (Welcome / Sequence / Pipeline / ARE / AI Draft Queue), which `seedHelpContent` **retires** per workspace;
  `seedTours.ts` was trimmed to the 2 non-overlapping keepers (Adding Your First Lead, Renewals & Churn Risk)
  and refactored to idempotent **upsert-by-name** (the old "seed only if 0 tours" gate broke once
  seedHelpContent creates tours first). Commit trailer switched to **Opus 4.8**.

### Open follow-ups (optional, not blockers)
- **Article count is 21, not 20** — the plan's own list (GS3+PR5+CRM4+SEQ4+ARE2+PLAY3) totals 21; the "20"
  label was an off-by-one in the plan. All 21 specced articles are seeded; nothing missing/duplicated.
- **"Enriching Contacts with Clodura" tour** pre-existed (not one of the original 7 demo tours, not in the
  retire list) so it remains. Confirm with the user whether to keep or retire it.
- Optional polish from the plan: add `data-tour-id` selectors on Find Prospects / Prospects / Enroll dialog /
  Unified Inbox so those coach tours can spotlight instead of page-level callouts.

---

## This session's work (35 commits — themes)

**Picked up the prior open item first:** `d71663b` fixed the Enroll dialog Prospects tab (it
filtered by `verificationStatus` which excluded CSV-imported NULL-status prospects). Verified live.

**Discovery / scraping overhaul (ARE) — the big functional work:**
- `2a1b056` **Bounce-detection fix (important):** inbound `detectBounce` (unipileWebhook.ts) was
  treating any `noreply@` sender as a bounce and scraping a random body email to suppress — it had
  silently suppressed the user's own login email + a newsletter. Now requires a real RFC-3464
  `Final-Recipient` DSN. Also cleaned the 4 bogus suppression rows.
- `597dcf9` **Stopped fabrication:** `scrapeLinkedIn` + `scrapeIndustryEvents` were asking the LLM
  to *invent* prospects (fake names/URLs/emails); Google/News/Web fell back to "use your knowledge".
  All disabled/guarded; `4b620b2`+`22849c8` rewired the manual LinkedIn buttons AND Discovery-v2
  person-mode to the real Unipile people search (`searchLinkedInProfiles`). **Lesson:** `4b620b2`
  removed `scrapeLinkedIn` but left two dangling imports → esbuild build FAILED; always grep
  repo-wide for references before deleting an export.
- `e5eca26`..`5cf8c9e` slice cap 30→120 + stride-sample; deterministic ICP-fit scoring + validation
  at discovery (`scoreIcpMatch`); per-campaign `minConfidence` enrichment gate (**migration 0086**);
  Google SERP pagination + LinkedIn limit 15→25; name+company fuzzy dedup. `f2cc950` parallel Reoon.

**Full UX audit (`UX_AUDIT.md`) + every fix shipped:**
- P0 data-loss bugs: ARESettings dropped 4 fields (**migration 0087** adds the columns + `db65ae2`
  returns them from getAreSettings); Territories invalid-JSON `{}` submit; OpportunityDetail
  win/loss reason clobber; UnifiedInbox malformed PageHeader (buttons didn't render); SequenceCanvas
  30s→2.5s autosave + unmount flush; MyLinkedIn page padding.
- Destructive-action guards via new **`ConfirmButton`** across SCIM/CustomFields/Products/Campaigns/
  Social/Quotes/EmailDrafts + `onError` toasts (`9726c23`,`ccf2492`,`454ec51`,`17f60f3`).
- Features: **minConfidence slider** on ARE campaign Settings + **ICP-fit "Fit" column** on /prospects (`7e0d2ef`).
- **Stage-vocab unification** (`f851b26`): PipelineAlerts used `closed_won` etc. that didn't match the
  kanban → deals vanished. Dialog now reads canonical `crmPipelines` stages; `moveDealStage` validates.
- Theme rollouts (full coverage): **TableSkeleton + QueryError** primitives on all list/board pages;
  **SubNav** strip replacing header arrow-links on all ~12 offender pages; **Pipeline keyboard
  operability** (focusable cards + ◀/▶ move buttons).
- `b02c12d` Find Prospects result rows fully clickable (was: only the name; chevron did nothing).

**New shared primitives to REUSE (don't re-invent):**
- `client/src/components/usip/Common.tsx` → `ConfirmButton` (AlertDialog-backed destructive guard).
- `client/src/components/usip/Shell.tsx` → `TableSkeleton`, `QueryError` (loading/error states),
  `SubNav` (secondary tab strip under PageHeader, highlights active route).

## Migrations added this session
| # | Name | Purpose |
|---|---|---|
| 0086 | `are_campaign_min_confidence.sql` | `are_campaigns.minConfidence` int (enrichment fit gate; null→default 40) |
| 0087 | `are_settings_persisted_fields.sql` | `workspace_settings.areBrandVoice/areScraperSources/areIcpRegenSchedule/areSequenceQualityThreshold` |

---

## Where things live (key paths)

- **Routers** (`server/routers/`): `crm.ts` (accounts/contacts/leads/opportunities + crmPipelines +
  `cascadeDeleteAccountDependents`), `sequences.ts` (bulkEnroll, EnrollDialog backing), `prospects.ts`
  (workspace prospect library), `discovery.ts` (Discovery v2 → `services/discovery/index.ts` →
  consolidate.ts), `are/scraper.ts` + `are/campaigns.ts`, `pipelineAlerts.ts`, `helpCenter.ts`
  (articles + `askAI`), `tours.ts`, `admin.ts` (`getAreSettings`/`updateAreSettings`). Mounted in `server/routers.ts`.
- **Engine** (`server/`): `areEngine.ts` (`runDiscovery` + `scoreIcpMatch` + `nameOrgDedupKey` +
  `discoverViaLinkedIn`), `sequenceEngine.ts`, `inboundReplyPoller.ts`, `unipileWebhook.ts`
  (`detectBounce`), `services/scraper/index.ts` (`lookupContactInfo` + Reoon), `services/reoon.ts`,
  `services/linkedinLookup.ts` (`searchLinkedInProfiles`), `_core/rawMigrations.ts`, `seed.ts`,
  `seedTours.ts`.
- **Schema** `drizzle/schema.ts` (~3500 lines). Help/tour tables: `help_categories` (3431),
  `help_articles` (3445), `tours` (3522), `tour_steps` (3543).
- **Client pages** `client/src/pages/usip/*.tsx`; routes in `client/src/App.tsx` (75 routes);
  sidebar in `Shell.tsx`. `data-tour-id` selectors exist on Dashboard/Pipeline/ARE/AI-queue/etc.
  (full list in HELP_CONTENT_PLAN.md) — none on Find Prospects/Prospects/Unified Inbox (use coach steps).

---

## Known gotchas / things to avoid

1. **esbuild fails on missing exports.** Removing an exported symbol breaks the *server* build (vite
   client build still succeeds, so the app keeps serving the OLD bundle). Grep repo-wide before deleting.
2. **Flexbox `min-h-0` trap** — ScrollArea `flex-1` inside `flex flex-col` needs `min-h-0` on parents.
3. **`<Shell>` remounts per navigation** — persist scroll-like state via sessionStorage.
4. **Parent snapshot trap** — dialogs needing live data run their own `trpc.X.get` gated on open+id.
5. **Send engine reads `sequences.steps` JSON**, not the canvas tables (`stepsToCanvas` syncs on save).
6. **`prospects` (library) ≠ `prospect_queue` (ARE funnel)** — two tables. Enrollments target `prospects`.
7. **Drizzle mysql `.update()` returns `[ResultSetHeader, FieldPacket[]]`** — not an object.
8. **`getAreSettings` returns a curated object** — adding a `workspace_settings` column means also
   adding it to BOTH `updateAreSettings` input AND the `getAreSettings` return (we missed this once).
9. **Verifying a deploy is "green":** a new *client* change being live (new bundle) proves the full
   build (incl. server esbuild) succeeded — Railway builds both in one step and won't deploy a partial.
10. **`invokeLLM` `outputSchema` shape** = `{ name, schema, strict? }` (schema is the raw JSON-Schema
    object), NOT a bare `{type:"object",...}`. Passing a bare schema throws **"outputSchema requires both
    name and schema" → HTTP 500**. (`helpCenter.askAI` + `generateArticleDraft` had this bug; fixed `a4145fc`.)
11. **`help_categories.icon` renders as a literal string** in `HelpCenter.tsx` (`{cat.icon}`, fallback "📁") —
    it is an **emoji**, not a lucide component name. Storing "Rocket"/"Search" shows the raw word.

---

## Common workflow when continuing
1. **Plan first** when non-trivial; user approves before code lands.
2. **Schema** → `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (idempotent).
3. **New tRPC proc** → router under `server/routers/`, mount in `server/routers.ts`.
4. **New page** → `client/src/pages/usip/*.tsx` + route in `App.tsx` + sidebar in `Shell.tsx`.
5. **Reuse** ConfirmButton / TableSkeleton / QueryError / SubNav. Commit + push per change. Watch Railway. Verify in Chrome.

---

## Reference docs at repo root
- **`HELP_CONTENT_PLAN.md`** — the next task's full spec (articles, tours, seed approach, resume prompt).
- **`UX_AUDIT.md`** — the full UX audit; P0/P1 all shipped, but it lists remaining P2/P3 polish + flagged
  items worth confirming (e.g. Mailbox `dangerouslySetInnerHTML` XSS sanitization; Help/Tour/Mindmap/
  import pages hardcode light-mode colors that break in dark mode).

---

## Resume prompt for the new session
```
You're continuing Velocity / usip (igrant9679/usip → getvelocityai.app on Railway).
Repo: C:\Users\Admin\usip. Tip of main: 23caa0d.

Read SESSION_HANDOFF.md and HELP_CONTENT_PLAN.md at the repo root first.

Task: implement HELP_CONTENT_PLAN.md — seed 6 help categories, 20 help articles, and 10 guided
tours for the SDR team (Prospecting + CRM), plus the Ask AI enhancements. Build an idempotent
server/seedHelpContent.ts called from seedWorkspace() and a one-time boot backfill for existing
workspaces. Full article bodies + tour step copy are in the plan — use them verbatim. The
help_categories/help_articles/tours/tour_steps tables already exist (verify columns vs the plan;
no new migration needed for them). Tours with no data-tour-id use coach steps + routeTo.

Hard constraints (from SESSION_HANDOFF.md):
- No local Node toolchain — static review only. esbuild fails on missing exports; grep before deleting.
- Schema changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts (idempotent).
- Commit + push per change with the igrant9679 identity + the Opus co-author trailer.
- Plan first when non-trivial; user approves before large code lands.
- Reuse ConfirmButton / TableSkeleton / QueryError / SubNav primitives.
- Always ask which Chrome browser (Personal Chrome / Browser 2) before driving it.

After reading both docs, briefly confirm the plan + the current state, then wait for direction.
```
