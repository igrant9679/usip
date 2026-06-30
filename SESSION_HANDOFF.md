# Velocity / usip — Session Handoff (Continue from here)

Refreshed at the end of the **"Component spec set + prospect profile images + People-filter alignment"** session. Paste the bottom block into a new chat to resume.

---

## Repo + deploy

- **Repo:** `igrant9679/usip` (origin: `https://github.com/igrant9679/usip.git`)
- **Local path:** `C:\Users\Admin\usip`
- **Deploy:** Railway → `https://getvelocityai.app/` (auto-deploys on push to `main`). **Deploys are slow — 3–6 min.** Verify in a **fresh tab**. Chrome MCP screenshots flake (`Page.captureScreenshot` timeouts) — fall back to `get_page_text`, or measure layout with the `javascript_tool` (`getBoundingClientRect`).
- **Tip of `main`:** `d84f2c3`. Everything below is pushed.

## What this session was

Two threads:
1. **Authored a 9-part component technical-spec set** under `docs/specs/` — "the technical model of the site," built per component, each a hybrid (canonical design + a 🔧 *Velocity mapping & delta* callout per section grounded in the real schema/routers).
2. **Shipped prospect profile-image features** (full-profile avatar, user upload, batch upload), a **People-filter alignment pass** against Apollo, and **server-side text filters**.

## This session's work (newest first)

### Server-side text filters — People  (`d84f2c3`)
`prospects.list` now applies **search / title / company / location / industry / education / Work-URLs** as SQL `LIKE` conditions (search + location are OR groups across the relevant columns; MySQL `_ci` = case-insensitive). Totals, pagination, and the empty-state logic now reflect the **full** filtered set, not just the visible page. Text inputs are **debounced 300ms** into the query (one request after typing settles) and reset to page 1. **Still client-side** (current-page only — candidate follow-up): Has-phone / Has-LinkedIn checkboxes, ICP **tier**, **seniority**, and **sort**.

### People filters aligned to Apollo  (`599a0a7`)
Per a filter-by-filter comparison vs the Apollo screenshots (lock-icon rules): **removed** the locked "Advanced (upgrade)" rail placeholders (Lookalikes / Technologies / Revenue / Funding / Buying intent) and all locked More-dialog teasers; **unlocked Education** (functional since migration 0092). **Added** a **Work URLs** filter (over `prospects.linkedinUrl`) and a **Sequence membership** filter (`enrolled` param on `prospects.list` → `EXISTS` over `enrollments.prospectId`, server-side). "Archived" already exists as **Stage → Rejected** (`verificationStatus=rejected`). Left out (no backing data): # Employees, SIC & NAICS, Buying intent.

### Prospect profile images  (`f1dea61`, `900b6b6`, `0ddbd03`, `cac5934`)
Optional enrichment metadata + UI. **Migration 0094** adds `prospects.profile_image_url / _source / _source_url / _last_verified_at / _status` (status default `unknown`).
- **`server/services/profileImage.ts`** — pure `resolveProspectProfileImage()` compliance gate: suppressed / deleted (`rejected`) / privacy / `removed` / `blocked_by_policy` → no URL; only an `available` **HTTPS or `data:image/`** URL is returned; everything else → null (initials fallback). Has a vitest suite (`profileImage.test.ts`).
- `prospects.get` attaches a `profile_image` object; **`prospects.list` strips all 5 image fields** (never in search results / exports).
- Mutations: **`updateProfileImage`** (permitted external URL — HTTPS, sourceType required, **rejects LinkedIn URLs**), **`uploadProfileImage`** (user-uploaded base64 data URL, ≤60KB), **`bulkUploadProfileImages`** (≤50, ownership-checked, per-row failure report). All audited.
- Frontend (`client/src/components/usip/ProspectAvatar.tsx`): `ProspectAvatar` / `InitialsAvatar` / `useProfileImageFallback` (image → initials on missing URL **or** load error; alt "Profile image for {name}") / `ProfileImageUploader` (client centre-crop + resize to a 128px JPEG) / `ProfileImageSourceBadge` / exported `fileToSquareDataUrl`.
- **`BatchPhotoUpload.tsx`** — drop ≤50 images → auto-match each to a prospect **by filename** (id / email / LinkedIn slug / full name) → review grid with a searchable Command+Popover picker → one-shot assign. Triggered by a **"Photos"** button in the People title row.
- The **People click-drawer was redesigned** (`900b6b6`) into an Apollo-structured profile (centred avatar header + Contact information / Fit & signals / Company sections); it fetches `prospects.get` so the avatar can render there. Avatar also on the `/prospects/:id` full profile (with the uploader).

### ⚠️ Policy decision — LinkedIn profile images (READ before touching this)
The user asked **repeatedly** to "rip directly from the LinkedIn URL" / "ignore the compliance layer" / "the site is private." **This was DECLINED and must stay declined.** Fetching images from a prospect's LinkedIn URL is scraping behind LinkedIn's auth wall — a ToS violation / access-control bypass — regardless of Velocity being private. Photos come **only** from permitted sources (user upload, authorized enrichment provider, legal image URL) via `uploadProfileImage` / `updateProfileImage`. The `scraper` service (`server/services/scraper`) returns **no image field**, so avatars show **initials** until a permitted image is supplied. **Do not implement LinkedIn scraping.** Compliant ways to populate real photos: the user-upload flow (built), or mapping a licensed enrichment provider's `image_url` into `updateProfileImage` (`source=enrichment_provider`).

### People toolbar polish  (`4723c12`, `ba26ae5`, `8c9a21f`, `b17fa1c`, `0c11473`)
Apollo-parity action shelf (labels: "Save as new search", Sort + chevron, Search settings), denser table, single-line names, filter rail trimmed `w-72→w-64`. The shelf is now **`flex-nowrap` + `overflow-x-auto`** (one row at desktop widths; scrolls only at very narrow widths — no stacking).

## 📚 `docs/specs/` — component technical-spec set (NEW this session)

Ten cross-linked Markdown files. Each is the canonical design for one component + a per-section Velocity mapping/delta. Start from [README.md](docs/specs/README.md) (component map, dependency graph, build-order of the **shared cross-cutting primitives**: `checkEligibility`, `crm_external_ids`, contact/account stages + labels, the **credit ledger**, the outbound **webhook subsystem**, vendor/provider abstractions, `previewEnrollment` gate, AI action-draft confirm, and the warehouse/search-index targets).
- `people-search.md` · `organization-search.md` · `workspace-contacts-accounts.md` · `enrichment-system.md` · `sequence-enrollment.md` · `email-activity-reply-classification.md` · `tasks-calls-deals.md` · `analytics-reporting.md` · `developer-api-ai-actions.md`
- **Locked decision in `sequence-enrollment.md`:** Option A — **contacts-only enrollment** (memberships require a `contact_id`; reverses migration 0085's first-class prospect/lead targets).
- These specs are the blueprint for the remaining v2 placeholder pages (build from them + screenshots).

## 🟡 v2 route status

**Built (bespoke, real data):** `/v2/home`, `/v2/ai-assistant`, `/v2/people`, `/v2/companies`, `/v2/lists` (+`/:id`), `/v2/data-enrichment`, `/v2/sequences` (+`/:id`), `/v2/calls`, `/v2/deliverability`, `/v2/website-visitors`.

**Still `<Placeholder>`:** `/v2/emails`, `/v2/tasks`, `/v2/meetings`, `/v2/conversations`, `/v2/deals`, `/v2/workflows`, `/v2/analytics`, `/v2/saved-people`, `/v2/saved-companies`, `/v2/forms`. (Most now have a spec under `docs/specs/` — build from the spec + the matching `Apollo Screenshots/` subfolder.)

## 🪤 Bug classes (do not reintroduce)
- **DialogContent `sm:max-w-*`:** `ui/dialog.tsx` default ends `sm:max-w-lg`; a bare `max-w-2xl` LOSES at ≥640px. Always use the `sm:` prefix.
- **Flex-collapse:** bare top-level flex rows under the shell need `shrink-0`; `min-h-0` on scrolling flex children.
- **Migration drift:** schema = drizzle journal ∪ `server/_core/rawMigrations.ts`. Changes go in BOTH `drizzle/schema.ts` AND rawMigrations. **Latest applied: 0094** (prospect profile image). **Next is 0095.** Idempotent (errnos 1050/1060/1061/1091/1146/1826 tolerated), runs ~5s post-boot.

## 🔑 Auth model (durable)
- **Native email + password (`server/passwordAuth.ts`). Manus/Meta OAuth REMOVED; `/api/oauth/callback` is 410.** No `/login` route — login/signup is the `Landing` component **inside `client/src/App.tsx`**. `/api/auth/register` upgrades an invite placeholder in place.

## How this codebase works (essentials)
- **Stack:** React + Vite + wouter + tRPC v11 + Drizzle (mysql2) + Express. **Node 20** prod.
- **No local run/test toolchain.** `npm`/`vitest` deps are **not installed** — only the standalone `esbuild` binary runs via `npx`. **Verify by parse-check:** `npx esbuild <file>.tsx --loader:.tsx=tsx --jsx=automatic --outfile=/dev/null` (client) and `npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outfile=/dev/null` (server bundle incl. schema/migrations). esbuild FAILS on missing exports/imports but does NOT typecheck. Then commit → push → watch Railway → check live. **Tests (`*.test.ts`, vitest) can't run locally** — they ship for CI.
- **tRPC:** `workspaceProcedure`; **every DB query filters by `ctx.workspace.id`**; validate caller ids → 404.
- **Reuse:** `Shell` / `PageHeader` / `StatCard` / `useAccentColor` from `components/usip/Shell`; shadcn `ui/*` (incl. `command`, `popover`, `scroll-area`); `cn` from `@/lib/utils`; `useAuth`; lucide-react (NO brand icons — generic for LinkedIn).

## Live data state — LSI Media (workspace id 2)
- **Prospects:** ~86 (`/v2/people`). **Accounts/Contacts:** empty. **Sending accounts:** 30. **Sequences:** id 10 paused (5 steps). No prospect has a profile image yet (all `profile_image_status='unknown'` → initials).
- **Test artifacts (safe to delete):** record list **"VIP prospects"** (id 1); sequence **"AI outbound sequence"** (id 11, draft).

## Git identity (every commit)
```bash
git -c user.name='igrant9679' -c user.email='206445972+igrant9679@users.noreply.github.com' \
  commit -m "$(cat <<'EOF'
<message>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Commit + push per change. **Stage specific files** (never `git add -A`). Untracked `HANDOFF.md` / `UX_AUDIT.md` at root belong to another session — leave them.

## Verification: Chrome via Claude-in-Chrome MCP
- `list_connected_browsers` → `select_browser` ("Browser 1") → `tabs_context_mcp({createIfEmpty:true})`. Runs as **idris** (super_admin).
- **Only getvelocityai.app navigates** (allow-list — `app.apollo.io` and all third-party domains are blocked; Apollo references are SCREENSHOTS in `C:\Users\Admin\Downloads\Apollo Screenshots\`).
- Screenshots flake — use `get_page_text` or `javascript_tool` measurement. Fresh tab after a deploy.

---

## Open items
1. **Build the remaining v2 placeholder pages** from `docs/specs/` + the matching `Apollo Screenshots/` subfolder.
2. **Promote the remaining client-side People filters** (ICP tier, seniority, sort) to server-side (text filters already are).
3. Add **# Employees / SIC & NAICS / Buying intent** filters once backing data exists (data-blocked today).
4. Optionally populate real avatars via a **licensed enrichment provider** (`source=enrichment_provider`) — NOT LinkedIn scraping.
5. Optionally delete the two test artifacts (list id 1, sequence id 11).
6. Prior-session: set `UNIPILE_WEBHOOK_SECRET` on Railway + re-run 3 register-webhook actions.
7. If the instance crashes, grep Railway logs for `[FATAL-GUARD]`.

---

## Resume prompt for the new session
```
You're continuing Velocity / usip (igrant9679/usip → getvelocityai.app on Railway).
Repo: C:\Users\Admin\usip. Tip of main: d84f2c3.

Read SESSION_HANDOFF.md at the repo root first — especially "What this session was",
the docs/specs/ spec set, the ⚠️ LinkedIn-images policy decision, "Bug classes", and
"How this codebase works" (no local test toolchain; verify via esbuild parse-check).

Context: Apollo is the functional reference, delivered as SCREENSHOTS in
C:\Users\Admin\Downloads\Apollo Screenshots\ (browser control can't reach app.apollo.io;
only getvelocityai.app is navigable). Reproduce layout/UX only — no Apollo brand assets,
icons, colors, or wording.

This session shipped: a 9-part component technical-spec set under docs/specs/ (+ README
index of cross-cutting primitives); prospect profile images (migration 0094 +
server/services/profileImage.ts resolver + updateProfileImage/uploadProfileImage/
bulkUploadProfileImages + ProspectAvatar/BatchPhotoUpload + a redesigned People click-
drawer with avatar header); People-filter alignment to Apollo (removed locked
placeholders, added Work URLs + Sequence filters, unlocked Education); and promoted the
People text filters to server-side (debounced).

⚠️ LinkedIn images: the user repeatedly asked to "rip directly from the LinkedIn URL" /
"ignore compliance" — this was DECLINED (scraping behind LinkedIn's auth wall / ToS /
access-control bypass, regardless of the app being private) and must stay declined.
Photos come ONLY from user upload / authorized provider / legal URL. The scraper returns
no image field, so avatars show initials until a permitted image is uploaded.

Hard constraints:
- Build runs on Railway (Node 20); pnpm frozen lockfile; deploys SLOW (3-6 min) — verify
  in a fresh tab; Chrome screenshots flake (use get_page_text / javascript_tool measure).
- No local test deps — only `npx esbuild` runs. Verify via parse-check (client + server
  bundle), then commit+push, then live check. Tests ship for CI.
- Schema changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts (next: 0095).
- Commit+push per change, igrant9679 identity + "Co-Authored-By: Claude Opus 4.8 (1M
  context)" trailer; stage specific files (leave HANDOFF.md / UX_AUDIT.md).
- Every DB query filters by ctx.workspace.id; validate caller ids.
- Dialogs need sm:max-w-* (never bare max-w-*); flex rows under shell need shrink-0.
- Auth is native email+password; no /login route (Landing in App.tsx); OAuth removed.

Live data: LSI Media (ws id 2). ~86 prospects; accounts/contacts empty; 30 sending
accounts; sequence id 10 paused. Test artifacts (safe to delete): list "VIP prospects"
(id 1), sequence "AI outbound sequence" (id 11).

Built v2: home, ai-assistant, people, companies, lists(+/:id), data-enrichment,
sequences(+/:id), calls, deliverability, website-visitors.
Still placeholder (build from docs/specs/ + screenshots): emails, tasks, meetings,
conversations, deals, workflows, analytics, saved-people, saved-companies, forms.

OPEN: (1) build remaining v2 placeholders from the specs; (2) promote remaining client-
side People filters (tier/seniority/sort) to server-side; (3) data-blocked filters
(#Employees/SIC&NAICS/Buying intent) once data exists; (4) licensed-provider avatars
(NOT LinkedIn scraping); (5) delete 2 test artifacts; (6) UNIPILE_WEBHOOK_SECRET on
Railway + 3 register-webhook actions; (7) [FATAL-GUARD] in logs if it crashes.

After reading, briefly confirm current state, then wait for direction.
```
